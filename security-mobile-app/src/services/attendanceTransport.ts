import { getAttendanceLocationEvidence } from './attendanceLocation';

let installed = false;
let restoreFetch: (() => void) | null = null;

function isAttendanceCheckIn(input: RequestInfo | URL, init?: RequestInit) {
  const method = (init?.method || 'GET').toUpperCase();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return method === 'POST' && url.includes('/attendance/check-in');
}

async function responseRequiresGps(response: Response) {
  if (response.status !== 403) return false;

  try {
    const body = await response.clone().text();
    return body.toLowerCase().includes('gps location is required for attendance');
  } catch {
    return false;
  }
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function installAttendanceLocationTransport() {
  if (installed || typeof globalThis.fetch !== 'function') {
    return () => undefined;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const firstResponse = await originalFetch(input, init);

    if (!isAttendanceCheckIn(input, init) || !(await responseRequiresGps(firstResponse))) {
      return firstResponse;
    }

    const originalBody = parseJsonBody(init?.body);
    if (!originalBody || originalBody.latitude !== undefined || originalBody.longitude !== undefined) {
      return firstResponse;
    }

    const locationEvidence = await getAttendanceLocationEvidence({
      required: true,
      promptIfNeeded: true,
    });

    return originalFetch(input, {
      ...init,
      body: JSON.stringify({
        ...originalBody,
        ...locationEvidence,
      }),
    });
  }) as typeof globalThis.fetch;

  installed = true;
  restoreFetch = () => {
    globalThis.fetch = originalFetch as typeof globalThis.fetch;
    installed = false;
    restoreFetch = null;
  };

  return restoreFetch;
}

export function uninstallAttendanceLocationTransport() {
  restoreFetch?.();
}
