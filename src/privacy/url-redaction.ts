import { DEFAULT_SETTINGS } from "../shared/constants";

/**
 * Redacts sensitive query parameters from a URL while keeping non-sensitive parameters.
 */
export function redactSensitiveUrl(
  urlStr: string,
  sensitiveParams: string[] = DEFAULT_SETTINGS.sensitiveUrlParams,
): string {
  try {
    const parsed = new URL(urlStr);
    const params = new URLSearchParams(parsed.search);
    const sensitiveSet = new Set(sensitiveParams.map((p) => p.toLowerCase()));

    for (const [key] of Array.from(params.entries())) {
      if (sensitiveSet.has(key.toLowerCase()) || isLikelySensitiveKey(key)) {
        params.set(key, "[REDACTED]");
      }
    }

    parsed.search = params.toString() ? `?${params.toString()}` : "";
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

function isDynamicIdSegment(seg: string): boolean {
  if (!seg) return false;
  // Pure numeric IDs (e.g. /customers/1042)
  if (/^\d+$/.test(seg)) return true;
  // Standard UUIDs
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
  )
    return true;
  // 24-char MongoDB ObjectIds or long hex hashes
  if (/^[0-9a-f]{24,64}$/i.test(seg)) return true;
  return false;
}

/**
 * Normalizes an endpoint for clean API source grouping:
 * - strips query parameters (page, offset, limit, cursor, etc.)
 * - normalizes numeric/UUID/hex path IDs into `:id` so detail calls group cleanly
 * - appends `#OperationName` for GraphQL / RPC endpoints so distinct queries stay separate
 */
export function normalizeEndpoint(
  urlStr: string,
  operationName?: string,
): string {
  try {
    const parsed = new URL(urlStr);
    const normalizedSegments = parsed.pathname
      .split("/")
      .map((seg) => (isDynamicIdSegment(seg) ? ":id" : seg));

    let pathname = normalizedSegments.join("/");
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    const base = `${parsed.origin}${pathname}`;
    if (operationName && operationName.trim().length > 0) {
      return `${base}#${operationName.trim()}`;
    }
    return base;
  } catch {
    const withoutQuery = urlStr.split("?")[0].split("#")[0];
    return operationName
      ? `${withoutQuery}#${operationName.trim()}`
      : withoutQuery;
  }
}

/**
 * Extracts a GraphQL or RPC operation name from URL query params or request POST payload.
 * Never reads headers or cookies.
 */
export function extractOperationName(
  urlStr: string,
  requestPostData?: string,
): string | undefined {
  try {
    const parsed = new URL(urlStr);
    const queryOp =
      parsed.searchParams.get("operationName") ||
      parsed.searchParams.get("operation") ||
      parsed.searchParams.get("op");
    if (queryOp && queryOp.trim()) {
      return queryOp.trim();
    }
  } catch {
    // Ignore invalid URL
  }

  if (requestPostData) {
    const trimmed = requestPostData.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const body = JSON.parse(trimmed);
        const item = Array.isArray(body) ? body[0] : body;
        if (item && typeof item === "object") {
          if (
            typeof item.operationName === "string" &&
            item.operationName.trim()
          ) {
            return item.operationName.trim();
          }
          // Fallback: parse `query GetCustomers(...)` from GraphQL query string
          if (typeof item.query === "string") {
            const match = item.query.match(
              /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/,
            );
            if (match?.[1]) {
              return match[1];
            }
          }
        }
      } catch {
        // Ignore non-JSON postData
      }
    }
  }

  return undefined;
}

function isLikelySensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("auth")
  );
}
