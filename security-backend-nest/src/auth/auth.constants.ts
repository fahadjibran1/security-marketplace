/**
 * Identifies the mobile app so only it receives a renewable refresh token.
 *
 * Deliberately a header rather than a body field: the global ValidationPipe runs with
 * forbidNonWhitelisted, so an unknown body property would make an older deployment reject the
 * login outright with 400. A header is ignored by any backend that does not know it, which lets
 * a new app build and an old backend coexist during rollout — the app simply gets today's
 * response and behaves as it did before.
 */
export const MOBILE_CLIENT_HEADER = 'x-s4-client';
