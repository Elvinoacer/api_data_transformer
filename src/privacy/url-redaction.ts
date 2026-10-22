import { DEFAULT_SETTINGS } from '../shared/constants';

/**
 * Redacts sensitive query parameters from a URL while keeping non-sensitive parameters.
 */
export function redactSensitiveUrl(
  urlStr: string,
  sensitiveParams: string[] = DEFAULT_SETTINGS.sensitiveUrlParams
): string {
  try {
    const parsed = new URL(urlStr);
    const params = new URLSearchParams(parsed.search);
    const sensitiveSet = new Set(sensitiveParams.map((p) => p.toLowerCase()));

    for (const [key] of Array.from(params.entries())) {
      if (sensitiveSet.has(key.toLowerCase()) || isLikelySensitiveKey(key)) {
        params.set(key, '[REDACTED]');
      }
    }

    parsed.search = params.toString() ? `?${params.toString()}` : '';
    return parsed.toString();
  } catch {
    // If invalid URL, return as-is or sanitized
    return urlStr;
  }
}

/**
 * Normalizes an endpoint for grouping purposes:
 * - strips pagination query params (page, offset, limit, cursor, etc.)
 * - normalizes host + pathname
 */
export function normalizeEndpoint(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    // Keep origin + pathname
    let pathname = parsed.pathname;
    // Remove trailing slash if longer than 1 character
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    return `${parsed.origin}${pathname}`;
  } catch {
    // Fallback if relative or abnormal
    const withoutQuery = urlStr.split('?')[0].split('#')[0];
    return withoutQuery;
  }
}

function isLikelySensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.includes('apikey') ||
    lower.includes('api_key') ||
    lower.includes('auth')
  );
}
