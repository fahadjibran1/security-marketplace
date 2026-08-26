export const LOCAL_WEB_API_BASE_URL = 'http://localhost:3000';
export const LIVE_API_BASE_URL = 'https://security-marketplace-api.onrender.com';

type ApiBaseUrlOptions = {
  environmentUrl?: string;
  configuredUrl?: string;
  webHostname?: string;
};

export function resolveApiBaseUrl({
  environmentUrl,
  configuredUrl,
  webHostname,
}: ApiBaseUrlOptions): string {
  const explicitEnvironmentUrl = environmentUrl?.trim();
  if (explicitEnvironmentUrl) {
    return explicitEnvironmentUrl;
  }

  const hostname = webHostname?.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return LOCAL_WEB_API_BASE_URL;
  }

  return configuredUrl?.trim() || LIVE_API_BASE_URL;
}
