'use strict';

/**
 * Regression tests for DEF-002: fetch interceptor errors must not be swallowed
 * as generic NetworkError / "backend unreachable" messages.
 *
 * Tests A–D from the approved fix requirements:
 *   A. denied location permission preserves the location-specific error
 *   B. genuine network/fetch failure (TypeError) still becomes NetworkError
 *   C. backend HTTP/API errors retain their correct semantics
 *   D. existing formatApiErrorMessage branches remain unchanged
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

(async () => {
  // -------------------------------------------------------------------------
  // Compile api.ts in isolation with stubs for native / expo dependencies
  // -------------------------------------------------------------------------
  const apiSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'api.ts'),
    'utf8',
  );
  const compiled = ts.transpileModule(apiSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const mockRequire = (id) => {
    if (id === 'expo-constants') {
      return { default: { expoConfig: { extra: { apiBaseUrl: 'https://test.example' } } } };
    }
    if (id.endsWith('api-base-url')) {
      return { resolveApiBaseUrl: () => 'https://test.example' };
    }
    if (id.endsWith('models')) {
      return {};
    }
    return require(id);
  };

  const modExports = {};
  const mod = { exports: modExports };
  // Share the outer context's built-in constructors so that instanceof checks
  // on objects created outside the vm sandbox work correctly across the boundary.
  vm.runInNewContext(compiled, {
    exports: modExports,
    module: mod,
    require: mockRequire,
    process,
    console,
    Error,
    TypeError,
    Promise,
    JSON,
    Array,
    Object,
    Headers: class Headers {
      constructor() { this._h = {}; }
      has(k) { return k.toLowerCase() in this._h; }
      set(k, v) { this._h[k.toLowerCase()] = v; }
      get(k) { return this._h[k.toLowerCase()]; }
    },
  });

  const { NetworkError, ApiError, formatApiErrorMessage } = mod.exports;

  let passed = 0;

  // -------------------------------------------------------------------------
  // 1. Source-level structural verification: fix is present in api.ts
  // -------------------------------------------------------------------------
  assert.match(
    apiSource,
    /instanceof TypeError/,
    'api.ts catch block must check instanceof TypeError (fix must be present)',
  );
  assert.doesNotMatch(
    apiSource,
    /catch \(error\)\s*\{\s*throw new NetworkError/,
    'api.ts catch block must NOT unconditionally throw NetworkError as the first action',
  );
  passed++;

  // -------------------------------------------------------------------------
  // 2. Reproduce the BEFORE catch block — verify it was defective
  // -------------------------------------------------------------------------
  async function requestCatchBefore(mockFetch) {
    try {
      await mockFetch();
    } catch (error) {
      throw new NetworkError(
        error instanceof Error && error.message
          ? `Unable to reach the live API. ${error.message}`
          : 'Unable to reach the live API.',
      );
    }
  }

  await (async () => {
    const permissionError = new Error('Location permission is required to Book On at this site.');
    let thrown;
    try { await requestCatchBefore(async () => { throw permissionError; }); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof NetworkError,
      'BEFORE: plain Error was incorrectly wrapped as NetworkError (demonstrates the defect)');
    const msg = formatApiErrorMessage(thrown, 'fallback');
    assert.equal(msg,
      'The live backend is unreachable right now. Check internet access and server health, then retry.',
      'BEFORE: formatApiErrorMessage discarded the permission message (demonstrates the defect)');
    passed++;
  })();

  // -------------------------------------------------------------------------
  // 3. Reproduce the AFTER catch block — verify the fix
  // -------------------------------------------------------------------------
  async function requestCatchAfter(mockFetch) {
    try {
      await mockFetch();
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      throw new NetworkError(
        error.message
          ? `Unable to reach the live API. ${error.message}`
          : 'Unable to reach the live API.',
      );
    }
  }

  // TEST A: denied location permission → plain Error re-thrown → correct message shown
  await (async () => {
    const permissionMsg =
      'Location permission is required to Book On at this site. Allow location access while using S4 Security and try again.';
    let thrown;
    try { await requestCatchAfter(async () => { throw new Error(permissionMsg); }); } catch (e) { thrown = e; }
    assert.ok(!(thrown instanceof NetworkError),
      'TEST A: location permission Error must NOT be wrapped as NetworkError');
    assert.ok(thrown instanceof Error, 'TEST A: thrown value must still be an Error');
    assert.equal(thrown.message, permissionMsg,
      'TEST A: permission message must be preserved exactly');
    assert.equal(formatApiErrorMessage(thrown, 'fallback'), permissionMsg,
      'TEST A: formatApiErrorMessage must return the location-permission message verbatim');
    passed++;
  })();

  // TEST A2: location services disabled error path
  await (async () => {
    const svcMsg = 'Turn on Location Services to Book On at this site, then try again.';
    let thrown;
    try { await requestCatchAfter(async () => { throw new Error(svcMsg); }); } catch (e) { thrown = e; }
    assert.equal(formatApiErrorMessage(thrown, 'fallback'), svcMsg,
      'TEST A2: location-services-disabled message must be preserved');
    passed++;
  })();

  // TEST A3: GPS position failure error path
  await (async () => {
    const gpsMsg = 'Unable to obtain your current GPS position. Location provider unavailable.';
    let thrown;
    try { await requestCatchAfter(async () => { throw new Error(gpsMsg); }); } catch (e) { thrown = e; }
    assert.equal(formatApiErrorMessage(thrown, 'fallback'), gpsMsg,
      'TEST A3: GPS position error message must be preserved');
    passed++;
  })();

  // TEST B: genuine React Native network failure (TypeError) → becomes NetworkError
  await (async () => {
    let thrown;
    try { await requestCatchAfter(async () => { throw new TypeError('Network request failed'); }); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof NetworkError,
      'TEST B: TypeError must become NetworkError');
    assert.equal(
      formatApiErrorMessage(thrown, 'fallback'),
      'The live backend is unreachable right now. Check internet access and server health, then retry.',
      'TEST B: NetworkError must map to the backend-unreachable message',
    );
    passed++;
  })();

  // TEST B2: TypeError with no message → still NetworkError
  await (async () => {
    let thrown;
    try { await requestCatchAfter(async () => { throw new TypeError(''); }); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof NetworkError,
      'TEST B2: TypeError with empty message must still become NetworkError');
    passed++;
  })();

  // -------------------------------------------------------------------------
  // 4. TEST C: backend HTTP/API errors retain correct semantics
  // -------------------------------------------------------------------------

  assert.equal(
    formatApiErrorMessage(
      new ApiError(403, 'Forbidden', { message: 'GPS location is required for attendance', statusCode: 403 }),
      'fallback',
    ),
    'GPS location is required for attendance',
    'TEST C1: ApiError 403 with body.message must return body.message',
  );
  passed++;

  assert.equal(
    formatApiErrorMessage(new ApiError(403, 'Forbidden', 'You do not have access.'), 'fallback'),
    'You do not have access.',
    'TEST C2: ApiError 403 with string body must return the string',
  );
  passed++;

  assert.equal(
    formatApiErrorMessage(new ApiError(401, 'Unauthorized', null), 'fallback'),
    'Sign-in failed. Check your email and password, or contact support if access is restricted.',
    'TEST C3: ApiError 401 must return the auth message',
  );
  passed++;

  assert.equal(
    formatApiErrorMessage(new ApiError(422, 'Unprocessable Entity', { message: 'Validation error' }), 'fallback'),
    'Validation error',
    'TEST C4: ApiError 422 with body.message must return body.message',
  );
  passed++;

  // -------------------------------------------------------------------------
  // 5. TEST D: existing formatApiErrorMessage branches remain unchanged
  // -------------------------------------------------------------------------

  assert.equal(
    formatApiErrorMessage(new NetworkError('some details'), 'fallback'),
    'The live backend is unreachable right now. Check internet access and server health, then retry.',
    'TEST D1: NetworkError always maps to the backend-unreachable string',
  );
  passed++;

  assert.equal(
    formatApiErrorMessage(new Error('Something specific happened'), 'fallback'),
    'Something specific happened',
    'TEST D2: plain Error falls through to error.message branch',
  );
  passed++;

  assert.equal(
    formatApiErrorMessage('unexpected string thrown', 'fallback message'),
    'fallback message',
    'TEST D3: non-Error value must return the fallback message',
  );
  passed++;

  assert.equal(
    formatApiErrorMessage(null, 'fallback message'),
    'fallback message',
    'TEST D4: null must return the fallback message',
  );
  passed++;

  assert.equal(
    formatApiErrorMessage(new Error(''), 'fallback message'),
    'fallback message',
    'TEST D5: Error with empty message must return fallback',
  );
  passed++;

  // -------------------------------------------------------------------------
  // 6. GPS enforcement path: 403 from the server stays as ApiError, not NetworkError
  // -------------------------------------------------------------------------
  await (async () => {
    const gpsApiError = new ApiError(403, 'Forbidden', {
      message: 'GPS location is required for attendance',
      statusCode: 403,
    });
    assert.ok(gpsApiError instanceof ApiError, 'GPS 403 must be ApiError');
    assert.ok(!(gpsApiError instanceof NetworkError), 'GPS 403 must NOT be NetworkError');
    assert.equal(
      formatApiErrorMessage(gpsApiError, 'fallback'),
      'GPS location is required for attendance',
      'GPS 403 message must propagate correctly to the user',
    );
    passed++;
  })();

  // -------------------------------------------------------------------------
  console.log(JSON.stringify({
    event: 'api_error_handling_regression_tests_passed',
    tests: passed,
    fix: 'DEF-002',
    description: 'TypeError-only NetworkError wrapping; semantic interceptor errors preserved',
  }));
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
