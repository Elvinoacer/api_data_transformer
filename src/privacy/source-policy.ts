import {
  DEFAULT_SETTINGS,
  THIRD_PARTY_NOISE_DOMAINS,
} from "../shared/constants";
import { ScopeMode } from "../shared/types";

export interface EligibilityCheckResult {
  isEligible: boolean;
  reason?: string;
}

const STATIC_ASSET_EXT_REGEX =
  /\.(js|mjs|cjs|css|scss|less|png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|wasm|map)$/i;

/**
 * Extracts registrable base domain (e.g. "app.pharmacy.com" -> "pharmacy.com",
 * "api.shop.co.uk" -> "shop.co.uk") so API subdomains match seamlessly.
 */
export function getRootDomain(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "[::1]" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(lower)
  ) {
    return lower;
  }
  const parts = lower.split(".").filter(Boolean);
  if (parts.length <= 2) return lower;

  const twoPartTlds = new Set([
    "co.uk",
    "org.uk",
    "ac.uk",
    "com.au",
    "co.jp",
    "co.ke",
    "co.tz",
    "co.za",
    "com.br",
    "co.in",
  ]);
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${lastTwo}`;
  }
  return lastTwo;
}

function isLocalhostEquivalent(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]"
  );
}

function pathMatchesSensitiveKeyword(
  pathname: string,
  keyword: string,
): boolean {
  const cleanKeyword = keyword.toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!cleanKeyword) return false;
  const segments = pathname.toLowerCase().split("/").filter(Boolean);

  // Match exact segment or hyphen/underscore delimited auth action (avoids blocking `/api/authors` via `/auth`)
  return segments.some(
    (seg) =>
      seg === cleanKeyword ||
      seg.startsWith(`${cleanKeyword}-`) ||
      seg.startsWith(`${cleanKeyword}_`) ||
      seg.endsWith(`-${cleanKeyword}`) ||
      seg.endsWith(`_${cleanKeyword}`),
  );
}

/**
 * Validates whether a network response is eligible for JSON capture based on session scope,
 * URL filters, and content types.
 */
export function checkResponseEligibility(params: {
  url: string;
  allowedHostnames: string[];
  scopeMode?: ScopeMode;
  mimeType: string;
  resourceType: string;
  sensitiveKeywords?: string[];
}): EligibilityCheckResult {
  const {
    url,
    allowedHostnames,
    scopeMode = "selected_hosts",
    mimeType,
    resourceType,
    sensitiveKeywords = DEFAULT_SETTINGS.sensitiveEndpointKeywords,
  } = params;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { isEligible: false, reason: "Invalid URL" };
  }

  // 1. Check protocol
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      isEligible: false,
      reason: `Ignored protocol: ${parsed.protocol}`,
    };
  }

  // 2. Skip static file extensions
  if (STATIC_ASSET_EXT_REGEX.test(parsed.pathname)) {
    return { isEligible: false, reason: "Static asset URL" };
  }

  // 3. Exclude third-party analytics / telemetry noise when using broad tab scope
  const reqHost = parsed.hostname.toLowerCase();
  if (
    THIRD_PARTY_NOISE_DOMAINS.some(
      (noise) => reqHost === noise || reqHost.endsWith(`.${noise}`),
    )
  ) {
    return { isEligible: false, reason: `Excluded telemetry host: ${reqHost}` };
  }

  // 4. Check hostname scope according to session scopeMode
  if (scopeMode !== "all_tab_apis" && allowedHostnames.length > 0) {
    const isAllowedHost = allowedHostnames.some((host) => {
      const target = host.toLowerCase();
      if (reqHost === target || reqHost.endsWith(`.${target}`)) return true;
      if (isLocalhostEquivalent(reqHost) && isLocalhostEquivalent(target))
        return true;
      if (scopeMode === "same_domain") {
        return getRootDomain(reqHost) === getRootDomain(target);
      }
      // Even in selected_hosts, allow sibling `api.<root>` subdomain automatically
      const root = getRootDomain(target);
      if (root.includes(".") && getRootDomain(reqHost) === root) {
        return true;
      }
      return false;
    });

    if (!isAllowedHost) {
      return {
        isEligible: false,
        reason: `Hostname ${parsed.hostname} not in session scope`,
      };
    }
  }

  // 5. Sensitive endpoint check (segment-aware so `/api/authors` is NOT blocked by `/auth`)
  for (const keyword of sensitiveKeywords) {
    if (pathMatchesSensitiveKeyword(parsed.pathname, keyword)) {
      return {
        isEligible: false,
        reason: `Excluded sensitive endpoint matching keyword: ${keyword}`,
      };
    }
  }

  // 6. Resource type filter: primarily XHR, Fetch, Other (and Document if direct JSON API tab)
  const normalizedResourceType = resourceType.toLowerCase();
  const eligibleResourceTypes = ["xhr", "fetch", "other", "document"];
  if (!eligibleResourceTypes.includes(normalizedResourceType)) {
    return {
      isEligible: false,
      reason: `Resource type not eligible: ${resourceType}`,
    };
  }

  // 7. MIME type filter (supports standard JSON, vendor +json like vnd.api+json / hal+json, and XHR/Fetch text/plain or missing MIME)
  const normalizedMime = mimeType.toLowerCase().trim();
  const hasJsonMime =
    normalizedMime.includes("json") || // covers application/json, text/json, application/vnd.api+json, application/ld+json, etc.
    normalizedMime.includes("javascript");

  const isFetchWithPermissiveMime =
    (normalizedResourceType === "xhr" || normalizedResourceType === "fetch") &&
    (normalizedMime === "" ||
      normalizedMime.includes("text/plain") ||
      normalizedMime.includes("application/octet-stream"));

  // Only allow 'document' resourceType if the MIME type is explicitly JSON
  if (
    normalizedResourceType === "document" &&
    !normalizedMime.includes("json")
  ) {
    return { isEligible: false, reason: `Document is not JSON: ${mimeType}` };
  }

  if (!hasJsonMime && !isFetchWithPermissiveMime) {
    return { isEligible: false, reason: `MIME type not JSON: ${mimeType}` };
  }

  return { isEligible: true };
}

/**
 * Parses JSON response bodies cleanly, stripping UTF-8 BOM and XSSI prefixes like `)]}',\n`.
 */
export function parseApiJsonBody(
  rawBody: string,
): { ok: true; data: unknown } | { ok: false; error: string } {
  if (!rawBody || !rawBody.trim()) {
    return { ok: false, error: "Empty response body" };
  }

  let cleaned = rawBody.replace(/^\uFEFF/, "").trim();
  // Strip common Angular / Google / Spring XSSI protection prefixes: )]}', or while(1); or for(;;);
  cleaned = cleaned.replace(
    /^(?:\)\]\}'[^\n]*\n|while\s*\(\s*1\s*\)\s*;?|for\s*\(\s*;\s*;\s*\)\s*;?)\s*/,
    "",
  );

  try {
    return { ok: true, data: JSON.parse(cleaned) };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Invalid JSON syntax" };
  }
}
