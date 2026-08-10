import { getAttendanceLocationEvidence } from './attendanceLocation';

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

let installed = false;
let restoreFetch: (() => void) | null = null;

function getRequestUrl(input: FetchInput) {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  return input.url;
}

function isAttendanceCheckIn(input: FetchInput, init?: FetchInit) {
  const method = (init?.method || 'GET').toUpperCase();
  return method === 'POST' && getRequestUrl(input).includes('/attendance/check-in');
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

function parseJsonBody(body: unknown): Record<string, unknown> | null {
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

  const originalFetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;

  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
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
    globalThis.fetch = originalFetch;
    installed = false;
    restoreFetch = null;
  };

  return restoreFetch;
}

export function uninstallAttendanceLocationTransport() {
  restoreFetch?.();
}
