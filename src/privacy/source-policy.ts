import { DEFAULT_SETTINGS } from '../shared/constants';

export interface EligibilityCheckResult {
  isEligible: boolean;
  reason?: string;
}

/**
 * Validates whether a network response is eligible for JSON capture based on session scope,
 * URL filters, and content types.
 */
export function checkResponseEligibility(params: {
  url: string;
  allowedHostnames: string[];
  mimeType: string;
  resourceType: string;
  sensitiveKeywords?: string[];
}): EligibilityCheckResult {
  const { url, allowedHostnames, mimeType, resourceType, sensitiveKeywords = DEFAULT_SETTINGS.sensitiveEndpointKeywords } = params;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { isEligible: false, reason: 'Invalid URL' };
  }

  // 1. Check protocol
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { isEligible: false, reason: `Ignored protocol: ${parsed.protocol}` };
  }

  // 2. Check allowed hostnames
  if (allowedHostnames.length > 0) {
    const isAllowedHost = allowedHostnames.some((host) => {
      return parsed.hostname === host || parsed.hostname.endsWith(`.${host}`);
    });
    if (!isAllowedHost) {
      return { isEligible: false, reason: `Hostname ${parsed.hostname} not in session scope` };
    }
  }

  // 3. Sensitive endpoint check
  const lowerPath = parsed.pathname.toLowerCase();
  for (const keyword of sensitiveKeywords) {
    if (lowerPath.includes(keyword.toLowerCase())) {
      return { isEligible: false, reason: `Excluded sensitive endpoint matching keyword: ${keyword}` };
    }
  }

  // 4. Resource type filter: primarily XHR and Fetch
  const normalizedResourceType = resourceType.toLowerCase();
  const eligibleResourceTypes = ['xhr', 'fetch', 'other'];
  if (!eligibleResourceTypes.includes(normalizedResourceType)) {
    return { isEligible: false, reason: `Resource type not eligible: ${resourceType}` };
  }

  // 5. MIME type filter
  const normalizedMime = mimeType.toLowerCase();
  const isJsonMime =
    normalizedMime.includes('application/json') ||
    normalizedMime.includes('application/problem+json') ||
    normalizedMime.includes('application/ld+json') ||
    normalizedMime.includes('text/json') ||
    (normalizedMime.includes('text/plain') && (normalizedResourceType === 'xhr' || normalizedResourceType === 'fetch'));

  if (!isJsonMime) {
    return { isEligible: false, reason: `MIME type not JSON: ${mimeType}` };
  }

  return { isEligible: true };
}
