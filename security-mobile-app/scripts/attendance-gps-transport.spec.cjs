/**
 * UAT-ATT-04: the Guard GPS evidence client, EXECUTED.
 *
 * The architecture is reactive by design and that is the point: the app never asks for location
 * up front. It sends Book On, and only if the server answers "this site requires GPS" does it acquire a
 * single foreground fix and retry once. No polling, no watchPosition, no background permission, and
 * nothing at all collected when the site's policy has GPS off.
 *
 * That whole path was previously untested, so nothing stopped it becoming eager, becoming a retry loop,
 * or reacting to the wrong 403. These checks run the real transport and the real acquisition logic with
 * only `fetch` and the expo-location boundary replaced — the decisions themselves are the production
 * code. The runner's real GPS is never read.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

let passed = 0;
const test = async (id, fn) => { await fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Loads a source module with the expo-location boundary stubbed. The shared loader cannot be used here:
 * these modules import a native package on purpose, and the whole point is to control that seam.
 */
function loadWithLocationStub(rel, locationStub, extraModules = {}) {
  const cache = new Map();
  const loadFrom = (absolute) => {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod = { exports: {} };
    cache.set(absolute, mod);
    const localRequire = (request) => {
      if (request === 'expo-location') return locationStub;
      if (extraModules[request]) return extraModules[request];
      if (request.startsWith('.')) {
        const base = path.resolve(path.dirname(absolute), request);
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadFrom(candidate);
        }
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', output)(mod, mod.exports, localRequire);
    return mod.exports;
  };
  return loadFrom(path.join(ROOT, rel));
}

/** An expo-location double. Records every call so eagerness and repetition are observable. */
function makeLocationStub(behaviour = {}) {
  const calls = { getPermissions: 0, requestPermissions: 0, servicesEnabled: 0, getPosition: 0 };
  return {
    calls,
    stub: {
      Accuracy: { High: 6 },
      getForegroundPermissionsAsync: async () => {
        calls.getPermissions += 1;
        return { status: behaviour.existingPermission ?? 'undetermined' };
      },
      requestForegroundPermissionsAsync: async () => {
        calls.requestPermissions += 1;
        return { status: behaviour.requestedPermission ?? 'granted' };
      },
      hasServicesEnabledAsync: async () => {
        calls.servicesEnabled += 1;
        return behaviour.servicesEnabled ?? true;
      },
      getCurrentPositionAsync: async () => {
        calls.getPosition += 1;
        if (behaviour.positionError) throw behaviour.positionError;
        return { coords: behaviour.coords ?? { latitude: 51.5, longitude: -0.12, accuracy: 8 } };
      },
      // Present so an accidental switch to continuous tracking would be visible rather than silent.
      watchPositionAsync: async () => { throw new Error('watchPositionAsync must never be used'); },
      requestBackgroundPermissionsAsync: async () => { throw new Error('background location must never be requested'); },
    },
  };
}

const GPS_403_BODY = JSON.stringify({
  message: 'GPS location is required for attendance at this site',
  statusCode: 403,
});

/** A fetch double that returns a queued response per call and records what it was asked to send. */
function makeFetch(responses) {
  const requests = [];
  const impl = async (input, init) => {
    // Tolerates a non-JSON body: the production transport handles that case, so the double must too.
    let body = null;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }
    requests.push({ url: String(input), init, body });
    const next = responses[Math.min(requests.length - 1, responses.length - 1)];
    return {
      status: next.status,
      clone: () => ({ text: async () => next.body ?? '' }),
      text: async () => next.body ?? '',
      __label: next.label,
    };
  };
  return { impl, requests };
}

/** Installs the transport over a controlled fetch, runs the scenario, then always restores globals. */
async function withTransport(locationBehaviour, responses, run) {
  const { stub, calls } = makeLocationStub(locationBehaviour);
  const transport = loadWithLocationStub('src/services/attendanceTransport.ts', stub);
  const { impl, requests } = makeFetch(responses);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  const uninstall = transport.installAttendanceLocationTransport();
  try {
    const result = await run(globalThis.fetch);
    return { result, requests, calls };
  } finally {
    uninstall();
    transport.uninstallAttendanceLocationTransport();
    globalThis.fetch = originalFetch;
  }
}

const checkIn = (fetchFn, body = { shiftId: 12 }) =>
  fetchFn('https://api.example.invalid/attendance/check-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// ═══════════════════ GPS-CLIENT-01..03 the happy paths ═══════════════════

async function main() {
  await test('GPS-CLIENT-01-A-SUCCESSFUL-BOOK-ON-NEVER-TOUCHES-LOCATION', async () => {
    const { requests, calls } = await withTransport({}, [{ status: 201, label: 'ok' }], (f) => checkIn(f));
    assert.equal(requests.length, 1, 'exactly one request — no retry');
    assert.deepEqual(requests[0].body, { shiftId: 12 }, 'and no coordinates were added');
    assert.equal(calls.getPermissions, 0, 'location permission is never even inspected');
    assert.equal(calls.getPosition, 0, 'and no position is acquired');
  });

  await test('GPS-CLIENT-02-THE-GPS-403-TRIGGERS-ONE-FIX-AND-ONE-RETRY', async () => {
    const { requests, calls } = await withTransport(
      { existingPermission: 'granted', coords: { latitude: 51.5009, longitude: -0.1201, accuracy: 12 } },
      [{ status: 403, body: GPS_403_BODY, label: 'needs-gps' }, { status: 201, label: 'ok' }],
      (f) => checkIn(f),
    );
    assert.equal(requests.length, 2, 'exactly one retry');
    assert.equal(calls.getPosition, 1, 'exactly one foreground fix');
    assert.equal(calls.requestPermissions, 0, 'permission already granted, so no prompt');

    const retry = requests[1].body;
    assert.equal(retry.shiftId, 12, 'the original shiftId is preserved');
    assert.equal(retry.latitude, 51.5009);
    assert.equal(retry.longitude, -0.1201);
    assert.equal(retry.gpsAccuracyMeters, 12);
    assert.equal(requests[1].url, requests[0].url, 'to the same endpoint');
    assert.equal(requests[1].init.method, 'POST', 'with the method preserved');
    assert.deepEqual(requests[1].init.headers, requests[0].init.headers, 'and the headers preserved');
  });

  await test('GPS-CLIENT-03-THE-RETRY-RESPONSE-IS-WHAT-BOOK-ON-RECEIVES', async () => {
    const { result } = await withTransport(
      { existingPermission: 'granted' },
      [{ status: 403, body: GPS_403_BODY, label: 'needs-gps' }, { status: 201, label: 'created' }],
      (f) => checkIn(f),
    );
    assert.equal(result.status, 201, 'the caller sees the successful retry, not the 403');
    assert.equal(result.__label, 'created');
  });

  await test('GPS-CLIENT-02B-AN-UNGRANTED-PERMISSION-IS-REQUESTED-ONCE', async () => {
    const { requests, calls } = await withTransport(
      { existingPermission: 'undetermined', requestedPermission: 'granted' },
      [{ status: 403, body: GPS_403_BODY }, { status: 201 }],
      (f) => checkIn(f),
    );
    assert.equal(calls.requestPermissions, 1, 'prompted exactly once');
    assert.equal(calls.getPosition, 1);
    assert.equal(requests.length, 2);
  });

  // ═══════════════════ GPS-CLIENT-04..06 acquisition failures ═══════════════════

  const expectNoSecondRequest = async (id, behaviour, messagePattern) => {
    await test(id, async () => {
      let thrown = null;
      const { requests, calls } = await withTransport(
        behaviour,
        [{ status: 403, body: GPS_403_BODY }, { status: 201 }],
        async (f) => { try { await checkIn(f); } catch (error) { thrown = error; } return null; },
      );
      assert.ok(thrown, 'the failure surfaces to the caller');
      assert.match(thrown.message, messagePattern);
      // The critical safety property: no retry with missing or invented coordinates.
      assert.equal(requests.length, 1, 'no second API call was made');
      assert.equal(calls.requestPermissions <= 1, true, 'and no prompt loop');
    });
  };

  await expectNoSecondRequest(
    'GPS-CLIENT-04-DENIED-PERMISSION-DOES-NOT-RETRY-AND-EXPLAINS-WHAT-TO-DO',
    { existingPermission: 'denied', requestedPermission: 'denied' },
    /Location permission is required to Book On at this site\. Allow location access while using S4 and try again\./,
  );

  await expectNoSecondRequest(
    'GPS-CLIENT-05-DISABLED-LOCATION-SERVICES-EXPLAINS-WHAT-TO-DO',
    { existingPermission: 'granted', servicesEnabled: false },
    /Turn on Location Services to Book On at this site, then try again\./,
  );

  await expectNoSecondRequest(
    'GPS-CLIENT-06-A-FAILED-OR-TIMED-OUT-FIX-EXPLAINS-WHAT-TO-DO',
    { existingPermission: 'granted', positionError: new Error('Location request timed out') },
    /Unable to obtain your current GPS position/,
  );

  await test('GPS-CLIENT-06B-THE-FAILURE-MESSAGES-ARE-SAFE-AND-ACTIONABLE', async () => {
    // No stack traces, no internal names, no raw transport detail — and each says what to do next.
    const location = loadWithLocationStub('src/services/attendanceLocation.ts', makeLocationStub({
      existingPermission: 'denied', requestedPermission: 'denied',
    }).stub);
    const denied = await location.getAttendanceLocationEvidence({ required: true }).catch((e) => e);
    for (const message of [denied.message]) {
      assert.doesNotMatch(message, /Error:|at \w+ \(|undefined|null|expo-location|fetch|403/, 'no internals leak');
      assert.ok(message.length > 20 && /try again|Allow/.test(message), 'and it is actionable');
    }
  });

  // ═══════════════════ GPS-CLIENT-07..09 responses that must NOT trigger GPS ═══════════════════

  const expectNoGpsReaction = async (id, response) => {
    await test(id, async () => {
      const { requests, calls } = await withTransport(
        { existingPermission: 'granted' },
        [response, { status: 201 }],
        (f) => checkIn(f),
      );
      assert.equal(requests.length, 1, 'no retry');
      assert.equal(calls.getPosition, 0, 'and no location acquired');
      assert.equal(calls.getPermissions, 0, 'not even a permission check');
    });
  };

  await expectNoGpsReaction('GPS-CLIENT-07-OUTSIDE-GEOFENCE-403-IS-NOT-RETRIED', {
    status: 403,
    body: JSON.stringify({ message: 'Guard is outside the permitted site geofence', statusCode: 403 }),
  });

  await expectNoGpsReaction('GPS-CLIENT-08-NFC-REQUIRED-403-IS-NOT-MISTAKEN-FOR-GPS', {
    status: 403,
    body: JSON.stringify({ message: 'A valid site NFC tag is required for check-in', statusCode: 403 }),
  });

  await expectNoGpsReaction('GPS-CLIENT-09-A-GENERIC-403-IS-NOT-RETRIED', {
    status: 403,
    body: JSON.stringify({ message: 'This shift is not assigned to the current guard', statusCode: 403 }),
  });

  await expectNoGpsReaction('GPS-CLIENT-09B-THE-SITE-MISCONFIGURATION-422-IS-NOT-RETRIED', {
    // The new server distinction. Acquiring a position cannot fix a site with no coordinates, so the
    // client must not send the Guard round a pointless loop.
    status: 422,
    body: JSON.stringify({
      message: 'GPS verification is not configured correctly for this site. Contact Control.',
      statusCode: 422,
    }),
  });

  await expectNoGpsReaction('GPS-CLIENT-09C-A-STALE-SHIFT-400-IS-NOT-RETRIED', {
    status: 400,
    body: JSON.stringify({ message: 'This shift is too old to Book On. Contact Control.', statusCode: 400 }),
  });

  // ═══════════════════ GPS-CLIENT-10..12 loop safety and scope ═══════════════════

  await test('GPS-CLIENT-10-AT-MOST-ONE-RETRY-EVEN-IF-THE-SECOND-403-REPEATS', async () => {
    // If the server answers "GPS required" a second time, the transport must stop, not spiral.
    const { requests, calls } = await withTransport(
      { existingPermission: 'granted' },
      [{ status: 403, body: GPS_403_BODY }, { status: 403, body: GPS_403_BODY }],
      (f) => checkIn(f),
    );
    assert.equal(requests.length, 2, 'exactly two requests: the original and one retry');
    assert.equal(calls.getPosition, 1, 'and exactly one position acquisition');
  });

  await test('GPS-CLIENT-11-COORDINATES-ALREADY-PRESENT-ARE-NOT-REACQUIRED', async () => {
    for (const body of [
      { shiftId: 12, latitude: 51.5, longitude: -0.12 },
      { shiftId: 12, latitude: 51.5 },
      { shiftId: 12, longitude: -0.12 },
    ]) {
      const { requests, calls } = await withTransport(
        { existingPermission: 'granted' },
        [{ status: 403, body: GPS_403_BODY }, { status: 201 }],
        (f) => checkIn(f, body),
      );
      assert.equal(requests.length, 1, `already-supplied coordinates must not retry: ${JSON.stringify(body)}`);
      assert.equal(calls.getPosition, 0);
    }
  });

  await test('GPS-CLIENT-12-NON-ATTENDANCE-REQUESTS-ARE-UNTOUCHED', async () => {
    for (const [url, method] of [
      ['https://api.example.invalid/attendance/check-out', 'POST'],
      ['https://api.example.invalid/shifts/my', 'GET'],
      ['https://api.example.invalid/compliance/statuses', 'GET'],
      ['https://api.example.invalid/attendance/check-in', 'GET'],
    ]) {
      const { requests, calls } = await withTransport(
        { existingPermission: 'granted' },
        [{ status: 403, body: GPS_403_BODY }, { status: 201 }],
        (f) => f(url, { method, body: JSON.stringify({ shiftId: 12 }) }),
      );
      assert.equal(requests.length, 1, `${method} ${url} must pass straight through`);
      assert.equal(calls.getPosition, 0, 'and never acquire location');
    }
  });

  await test('GPS-CLIENT-13-A-NON-JSON-BODY-CANNOT-CRASH-THE-TRANSPORT', async () => {
    const { requests } = await withTransport(
      { existingPermission: 'granted' },
      [{ status: 403, body: GPS_403_BODY }, { status: 201 }],
      (f) => f('https://api.example.invalid/attendance/check-in', { method: 'POST', body: 'not json' }),
    );
    assert.equal(requests.length, 1, 'an unparseable body is returned as-is rather than retried');
  });

  // ═══════════════════ location acquisition, in isolation ═══════════════════

  await test('GPS-LOC-01-AN-EXISTING-GRANT-IS-NOT-RE-PROMPTED', async () => {
    const { stub, calls } = makeLocationStub({ existingPermission: 'granted' });
    const location = loadWithLocationStub('src/services/attendanceLocation.ts', stub);
    const evidence = await location.getAttendanceLocationEvidence({ required: true });
    assert.deepEqual(evidence, { latitude: 51.5, longitude: -0.12, gpsAccuracyMeters: 8 });
    assert.equal(calls.getPermissions, 1);
    assert.equal(calls.requestPermissions, 0, 'no prompt when already granted');
    assert.equal(calls.getPosition, 1, 'exactly one fix');
  });

  await test('GPS-LOC-02-HIGH-ACCURACY-IS-REQUESTED-AND-VALUES-FORWARDED', async () => {
    const { stub } = makeLocationStub({
      existingPermission: 'granted',
      coords: { latitude: -33.8688, longitude: 151.2093, accuracy: 4.5 },
    });
    const location = loadWithLocationStub('src/services/attendanceLocation.ts', stub);
    const evidence = await location.getAttendanceLocationEvidence({ required: true });
    assert.equal(evidence.latitude, -33.8688, 'southern/eastern coordinates pass through unchanged');
    assert.equal(evidence.longitude, 151.2093);
    assert.equal(evidence.gpsAccuracyMeters, 4.5, 'a fractional accuracy is preserved');
    const source = read('src/services/attendanceLocation.ts');
    assert.match(source, /accuracy: Location\.Accuracy\.High/, 'a high-accuracy fix is requested');
  });

  await test('GPS-LOC-03-NON-FINITE-OR-ABSENT-ACCURACY-IS-OMITTED-NOT-INVENTED', async () => {
    for (const accuracy of [null, undefined, NaN, Infinity, 'about 10']) {
      const { stub } = makeLocationStub({
        existingPermission: 'granted',
        coords: { latitude: 51.5, longitude: -0.12, accuracy },
      });
      const location = loadWithLocationStub('src/services/attendanceLocation.ts', stub);
      const evidence = await location.getAttendanceLocationEvidence({ required: true });
      assert.deepEqual(
        Object.keys(evidence).sort(),
        ['latitude', 'longitude'],
        `accuracy ${String(accuracy)} must be omitted, not sent as a bogus number`,
      );
    }
    // A negative reading is clamped to zero rather than rejected by the server's DTO.
    const { stub } = makeLocationStub({
      existingPermission: 'granted',
      coords: { latitude: 51.5, longitude: -0.12, accuracy: -5 },
    });
    const location = loadWithLocationStub('src/services/attendanceLocation.ts', stub);
    assert.equal((await location.getAttendanceLocationEvidence({ required: true })).gpsAccuracyMeters, 0);
  });

  await test('GPS-LOC-04-WHEN-NOT-REQUIRED-FAILURES-DEGRADE-SILENTLY', async () => {
    // The optional mode exists so a future opportunistic caller cannot break Book On. It must return
    // empty evidence rather than throw, and must not prompt.
    for (const behaviour of [
      { existingPermission: 'denied', requestedPermission: 'denied' },
      { existingPermission: 'granted', servicesEnabled: false },
      { existingPermission: 'granted', positionError: new Error('no fix') },
    ]) {
      const { stub, calls } = makeLocationStub(behaviour);
      const location = loadWithLocationStub('src/services/attendanceLocation.ts', stub);
      assert.deepEqual(await location.getAttendanceLocationEvidence({ required: false }), {});
      assert.equal(calls.requestPermissions, 0, 'an optional caller never prompts');
    }
  });

  await test('GPS-LOC-05-NO-BACKGROUND-PERMISSION-AND-NO-CONTINUOUS-TRACKING', async () => {
    // The stub throws if either is used, and the source must not reference them at all.
    const source = read('src/services/attendanceLocation.ts');
    for (const forbidden of [
      /requestBackgroundPermissionsAsync/,
      /watchPositionAsync/,
      /startLocationUpdatesAsync/,
      /BackgroundFetch/,
      /setInterval/,
    ]) {
      assert.doesNotMatch(source, forbidden, `location must not use ${forbidden}`);
    }
    const transport = read('src/services/attendanceTransport.ts');
    assert.doesNotMatch(transport, /setInterval|watchPosition/, 'the transport polls nothing');
    // Foreground only.
    assert.match(source, /getForegroundPermissionsAsync/);
    assert.match(source, /requestForegroundPermissionsAsync/);
  });

  // ═══════════════════ web compatibility, as far as static evidence allows ═══════════════════

  await test('GPS-WEB-01-THE-SAME-PATH-RUNS-ON-WEB-WITH-NO-NATIVE-ONLY-BRANCH', async () => {
    const location = read('src/services/attendanceLocation.ts');
    const transport = read('src/services/attendanceTransport.ts');
    // expo-location stays the only abstraction — no direct navigator.geolocation, no Platform branch.
    assert.match(location, /import \* as Location from 'expo-location'/);
    for (const source of [location, transport]) {
      assert.doesNotMatch(source, /Platform\.OS|navigator\.geolocation|react-native-/, 'no platform-specific branch');
      assert.doesNotMatch(source, /NativeModules|requireNativeModule/, 'no native-only API');
    }
    // The transport works on whatever global fetch exists, which is how it functions in a browser.
    assert.match(transport, /typeof globalThis\.fetch !== 'function'/, 'it degrades safely with no fetch');
    // expo-location ships a real web implementation in this project.
    const webShim = path.join(ROOT, 'node_modules/expo-location/build/ExpoLocation.web.js');
    assert.ok(fs.existsSync(webShim), 'expo-location has a web build');
    assert.match(fs.readFileSync(webShim, 'utf8'), /navigator\.geolocation/, 'which uses browser geolocation');
  });

  await test('GPS-SITE-01-GPS-CANNOT-BE-ENABLED-WITHOUT-SITE-COORDINATES', async () => {
    // The Company-side guard that stops the misconfigured state being created in the first place. It is
    // asserted from source rather than executed because validateGpsForm is module-local to a React Native
    // component; the authoritative protection is the server's own refusal, certified as GPS-08.
    const sites = read('src/components/company/CompanySitesWorkspace.tsx');
    assert.match(
      sites,
      /if \(form\.requireGpsCheckIn && \(latStr === '' \|\| lonStr === ''\)\) \{\s*return 'Set the site latitude and longitude before requiring GPS verification\.';/,
      'enabling GPS without coordinates is refused in the form',
    );
    // And the surrounding bounds match the server DTO, so the form cannot submit a value the API rejects.
    assert.match(sites, /lat < -90 \|\| lat > 90/, 'latitude bounds mirror the DTO');
    assert.match(sites, /lon < -180 \|\| lon > 180/, 'longitude bounds mirror the DTO');
    assert.match(sites, /radius < 25 \|\| radius > 5000/, 'radius bounds mirror the DTO');
    assert.match(sites, /validateGpsForm\(/, 'and the guard is actually called');
  });

  await test('GPS-WEB-02-THE-TRANSPORT-IS-INSTALLED-ONCE-AT-STARTUP-AND-IS-REMOVABLE', async () => {
    const app = read('App.tsx');
    assert.match(app, /installAttendanceLocationTransport/, 'installed for every platform, web included');
    assert.match(app, /useEffect\(\(\) => installAttendanceLocationTransport\(\), \[\]\)/, 'once, on mount');
    // Idempotent install, and a working uninstall — otherwise a remount would stack patches.
    const { stub, calls } = makeLocationStub({ existingPermission: 'granted' });
    const transport = loadWithLocationStub('src/services/attendanceTransport.ts', stub);
    const originalFetch = globalThis.fetch;
    try {
      let served = 0;
      globalThis.fetch = async () => {
        served += 1;
        return { status: 403, clone: () => ({ text: async () => GPS_403_BODY }), text: async () => GPS_403_BODY };
      };

      const uninstall = transport.installAttendanceLocationTransport();
      const afterFirst = globalThis.fetch;
      transport.installAttendanceLocationTransport();
      assert.equal(globalThis.fetch, afterFirst, 'a second install does not stack another wrapper');

      // Behaviour, not reference identity: install binds the original fetch, so the restored function is
      // an equivalent bound copy rather than the same object. What matters is that interception stops.
      served = 0;
      await checkIn(globalThis.fetch);
      assert.equal(served, 2, 'while installed, a GPS 403 is retried once');
      const acquiredWhileInstalled = calls.getPosition;
      assert.equal(acquiredWhileInstalled, 1);

      uninstall();
      served = 0;
      await checkIn(globalThis.fetch);
      assert.equal(served, 1, 'after uninstall the same 403 is no longer retried');
      assert.equal(calls.getPosition, acquiredWhileInstalled, 'and no further location is acquired');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

main()
  .then(() => console.log(`\n${passed} attendance GPS transport checks passed`))
  .catch((error) => { console.error(error); process.exit(1); });
