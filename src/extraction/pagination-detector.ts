import {
  DetectedPagination,
  PaginationStrategy,
  SourcePaginationState,
} from "../shared/types";

const PAGE_PARAM_KEYS = [
  "page",
  "p",
  "pageNumber",
  "page_number",
  "pageNum",
  "page_num",
  "currentPage",
  "current_page",
];
const OFFSET_PARAM_KEYS = [
  "offset",
  "skip",
  "start",
  "startIndex",
  "start_index",
  "from",
];
const LIMIT_PARAM_KEYS = [
  "limit",
  "per_page",
  "perPage",
  "pageSize",
  "page_size",
  "size",
  "take",
  "count",
  "length",
];
const CURSOR_PARAM_KEYS = [
  "cursor",
  "after",
  "next_cursor",
  "nextCursor",
  "pageToken",
  "page_token",
  "continuation",
];

function findNumericProp(
  obj: Record<string, any>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    if (key in obj) {
      const v = obj[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
      if (typeof v === "string" && /^\d+$/.test(v.trim()))
        return parseInt(v.trim(), 10);
    }
  }
  return undefined;
}

function findStringProp(
  obj: Record<string, any>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (
      key in obj &&
      typeof obj[key] === "string" &&
      obj[key].trim().length > 0
    ) {
      return obj[key].trim();
    }
  }
  return undefined;
}

function findBoolProp(
  obj: Record<string, any>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    if (key in obj && typeof obj[key] === "boolean") {
      return obj[key];
    }
  }
  return undefined;
}

/**
 * Inspects request URL, optional POST body, and parsed JSON response envelope
 * to detect pagination strategy, current page, total pages/records, and next page URL.
 */
export function detectPaginationFromResponse(params: {
  url: string;
  parsedBody: unknown;
  requestBody?: string;
  extractedCount?: number;
}): DetectedPagination {
  const { url, parsedBody, requestBody, extractedCount = 0 } = params;

  let currentPage: number | undefined;
  let pageSize: number | undefined;
  let totalPages: number | undefined;
  let totalRecords: number | undefined;
  let hasNextPage: boolean | undefined;
  let nextCursor: string | null | undefined;
  let nextUrl: string | null | undefined;
  let pageParamName: string | undefined;
  let limitParamName: string | undefined;
  let offsetValue: number | undefined;
  let offsetParamName: string | undefined;
  let strategy: PaginationStrategy = "none";

  // 1. Inspect URL query parameters
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
    for (const key of PAGE_PARAM_KEYS) {
      const val = parsedUrl.searchParams.get(key);
      if (val && /^\d+$/.test(val)) {
        currentPage = parseInt(val, 10);
        pageParamName = key;
        strategy = "page";
        break;
      }
    }
    for (const key of LIMIT_PARAM_KEYS) {
      const val = parsedUrl.searchParams.get(key);
      if (val && /^\d+$/.test(val)) {
        pageSize = parseInt(val, 10);
        limitParamName = key;
        break;
      }
    }
    for (const key of OFFSET_PARAM_KEYS) {
      const val = parsedUrl.searchParams.get(key);
      if (val && /^\d+$/.test(val)) {
        offsetValue = parseInt(val, 10);
        offsetParamName = key;
        if (strategy === "none") strategy = "offset";
        break;
      }
    }
    for (const key of CURSOR_PARAM_KEYS) {
      const val = parsedUrl.searchParams.get(key);
      if (val) {
        if (strategy === "none") strategy = "cursor";
        break;
      }
    }
  } catch {
    // Ignore malformed URL
  }

  // 2. Inspect POST body JSON if present (for POST /search or GraphQL variables)
  if (requestBody) {
    try {
      const reqJson = JSON.parse(requestBody);
      const reqTargets = [
        reqJson,
        reqJson?.variables,
        reqJson?.pagination,
        reqJson?.page,
      ].filter((x) => x && typeof x === "object" && !Array.isArray(x));
      for (const target of reqTargets) {
        if (currentPage === undefined) {
          currentPage = findNumericProp(target, PAGE_PARAM_KEYS);
          if (currentPage !== undefined && strategy === "none")
            strategy = "page";
        }
        if (pageSize === undefined) {
          pageSize = findNumericProp(target, [...LIMIT_PARAM_KEYS, "first"]);
        }
        if (offsetValue === undefined) {
          offsetValue = findNumericProp(target, OFFSET_PARAM_KEYS);
          if (offsetValue !== undefined && strategy === "none")
            strategy = "offset";
        }
      }
    } catch {
      // Non-JSON request body
    }
  }

  // 3. Inspect JSON response envelope containers
  if (
    parsedBody &&
    typeof parsedBody === "object" &&
    !Array.isArray(parsedBody)
  ) {
    const root = parsedBody as Record<string, any>;
    const envelopeCandidates: Record<string, any>[] = [
      root,
      root.data,
      root.meta,
      root.pagination,
      root.paging,
      root.pageInfo,
      root.page_info,
      root.data?.meta,
      root.data?.pagination,
      root.data?.pageInfo,
      // Also check nested GraphQL connection objects (e.g. data.medicines.pageInfo)
      ...(root.data &&
      typeof root.data === "object" &&
      !Array.isArray(root.data)
        ? Object.values(root.data)
            .filter((v: any) => v && typeof v === "object" && !Array.isArray(v))
            .flatMap((v: any) => [v, v.pageInfo, v.meta, v.pagination])
        : []),
    ].filter((c): c is Record<string, any> =>
      Boolean(c && typeof c === "object" && !Array.isArray(c)),
    );

    for (const env of envelopeCandidates) {
      if (currentPage === undefined) {
        const p = findNumericProp(env, [
          "page",
          "currentPage",
          "current_page",
          "pageNumber",
          "page_number",
        ]);
        if (p !== undefined && p >= 0) {
          currentPage = p;
          if (strategy === "none") strategy = "page";
        }
      }

      if (pageSize === undefined) {
        pageSize = findNumericProp(env, [
          "limit",
          "perPage",
          "per_page",
          "pageSize",
          "page_size",
          "size",
        ]);
      }

      if (totalPages === undefined) {
        totalPages = findNumericProp(env, [
          "totalPages",
          "total_pages",
          "lastPage",
          "last_page",
          "pageCount",
          "page_count",
          "pages",
        ]);
      }

      if (totalRecords === undefined) {
        totalRecords = findNumericProp(env, [
          "totalItems",
          "total_items",
          "totalCount",
          "total_count",
          "totalRecords",
          "total_records",
          "recordsTotal",
          "total",
          "count",
          "nbHits",
        ]);
      }

      if (hasNextPage === undefined) {
        hasNextPage = findBoolProp(env, [
          "hasNextPage",
          "has_next_page",
          "hasMore",
          "has_more",
        ]);
      }

      if (nextCursor === undefined) {
        if ("nextCursor" in env && env.nextCursor === null) nextCursor = null;
        else if ("next_cursor" in env && env.next_cursor === null)
          nextCursor = null;
        else {
          const nc = findStringProp(env, [
            "nextCursor",
            "next_cursor",
            "endCursor",
            "end_cursor",
            "nextPageToken",
          ]);
          if (nc) nextCursor = nc;
        }
      }

      if (nextUrl === undefined) {
        const directNext =
          typeof env.next === "string"
            ? env.next
            : typeof env["@odata.nextLink"] === "string"
              ? env["@odata.nextLink"]
              : typeof env.links?.next === "string"
                ? env.links.next
                : typeof env._links?.next?.href === "string"
                  ? env._links.next.href
                  : undefined;
        if (directNext) {
          try {
            nextUrl = parsedUrl
              ? new URL(directNext, parsedUrl.origin).toString()
              : directNext;
          } catch {
            nextUrl = directNext;
          }
        } else if ("next" in env && env.next === null) {
          nextUrl = null;
        }
      }
    }
  }

  // Infer effective pageSize if missing
  const effectivePageSize =
    pageSize || (extractedCount > 0 ? extractedCount : undefined);

  // Convert offset + limit into 1-based page number for clear progress display
  if (
    offsetValue !== undefined &&
    effectivePageSize &&
    effectivePageSize > 0 &&
    currentPage === undefined
  ) {
    currentPage = Math.floor(offsetValue / effectivePageSize) + 1;
  }

  // Infer totalPages from totalRecords & effectivePageSize
  if (
    totalPages === undefined &&
    totalRecords !== undefined &&
    effectivePageSize &&
    effectivePageSize > 0
  ) {
    if (
      totalRecords > effectivePageSize ||
      currentPage !== undefined ||
      nextCursor !== undefined ||
      nextUrl !== undefined
    ) {
      totalPages = Math.max(1, Math.ceil(totalRecords / effectivePageSize));
    }
  }

  // Finalize strategy
  if (nextUrl) {
    if (strategy === "none") strategy = "next_url";
  } else if (nextCursor !== undefined) {
    strategy = "cursor";
  } else if (
    totalPages !== undefined &&
    totalPages > 1 &&
    strategy === "none"
  ) {
    strategy = "page";
  }

  // If GET response body indicates page-based pagination without ?page= in URL, default to "page"
  if (strategy === "page" && !pageParamName && !requestBody) {
    pageParamName = "page";
  }
  if (strategy === "page" && currentPage === undefined) {
    currentPage = 1;
  }

  // Infer hasNextPage
  if (hasNextPage === undefined) {
    if (nextUrl) {
      hasNextPage = true;
    } else if (nextUrl === null && strategy === "next_url") {
      hasNextPage = false;
    } else if (typeof nextCursor === "string" && nextCursor.length > 0) {
      hasNextPage = true;
    } else if (nextCursor === null && strategy === "cursor") {
      hasNextPage = false;
    } else if (currentPage !== undefined && totalPages !== undefined) {
      hasNextPage = currentPage < totalPages;
    } else if (
      offsetValue !== undefined &&
      effectivePageSize &&
      totalRecords !== undefined
    ) {
      hasNextPage = offsetValue + extractedCount < totalRecords;
    }
  }

  // Synthesize nextUrl for standard GET query-param pagination when not explicitly returned
  if (!nextUrl && hasNextPage && parsedUrl) {
    if (pageParamName && currentPage !== undefined) {
      const nextParsed = new URL(parsedUrl.toString());
      nextParsed.searchParams.set(pageParamName, String(currentPage + 1));
      nextUrl = nextParsed.toString();
    } else if (
      offsetParamName &&
      offsetValue !== undefined &&
      effectivePageSize
    ) {
      const nextParsed = new URL(parsedUrl.toString());
      nextParsed.searchParams.set(
        offsetParamName,
        String(offsetValue + effectivePageSize),
      );
      nextUrl = nextParsed.toString();
    }
  }

  return {
    strategy,
    currentPage,
    pageSize: effectivePageSize,
    totalPages,
    totalRecords,
    hasNextPage,
    nextCursor,
    nextUrl,
    pageParamName,
    limitParamName,
  };
}

/**
 * Merges newly observed pagination metadata into an EndpointSource's cumulative pagination state.
 */
export function mergePaginationState(
  existing: SourcePaginationState | undefined,
  detected: DetectedPagination,
  requestUrl: string,
): SourcePaginationState | undefined {
  if (
    detected.strategy === "none" &&
    detected.totalRecords === undefined &&
    detected.totalPages === undefined &&
    !existing
  ) {
    return undefined;
  }

  const prevPages = existing?.observedPages || [];
  const nextPagesSet = new Set<number>(prevPages);
  if (detected.currentPage !== undefined && detected.currentPage > 0) {
    nextPagesSet.add(detected.currentPage);
  }
  const observedPages = Array.from(nextPagesSet).sort((a, b) => a - b);

  // Preserve valid URL without redacted tokens for in-tab next-page generation if query-based
  const isCleanUrl =
    !requestUrl.includes("[REDACTED]") &&
    !requestUrl.includes("%5BREDACTED%5D");

  return {
    strategy:
      detected.strategy !== "none"
        ? detected.strategy
        : existing?.strategy || "none",
    currentPage: detected.currentPage ?? existing?.currentPage,
    pageSize: detected.pageSize ?? existing?.pageSize,
    totalPages: detected.totalPages ?? existing?.totalPages,
    totalRecords: detected.totalRecords ?? existing?.totalRecords,
    hasNextPage: detected.hasNextPage ?? existing?.hasNextPage,
    nextCursor:
      detected.nextCursor !== undefined
        ? detected.nextCursor
        : existing?.nextCursor,
    nextUrl:
      detected.nextUrl !== undefined ? detected.nextUrl : existing?.nextUrl,
    pageParamName: detected.pageParamName ?? existing?.pageParamName,
    limitParamName: detected.limitParamName ?? existing?.limitParamName,
    observedPages,
    sampleRequestUrl: isCleanUrl ? requestUrl : existing?.sampleRequestUrl,
  };
}

/**
 * Computes any missing page numbers (e.g., observed [1, 2, 4] of totalPages 5 -> missing [3, 5]).
 */
export function getMissingPages(pagination?: SourcePaginationState): number[] {
  if (!pagination || !pagination.totalPages || pagination.totalPages <= 1)
    return [];
  const cap = Math.min(pagination.totalPages, 200);
  const seen = new Set(pagination.observedPages);
  const missing: number[] = [];
  for (let p = 1; p <= cap; p++) {
    if (!seen.has(p)) {
      missing.push(p);
    }
  }
  return missing;
}

/**
 * Generates candidate URLs to fetch missing/remaining pages for GET query-parameter APIs.
 */
export function buildPageUrlsForSource(
  pagination: SourcePaginationState,
  maxPagesToGenerate = 20,
): string[] {
  const urls: string[] = [];
  if (!pagination.sampleRequestUrl) {
    if (pagination.nextUrl) return [pagination.nextUrl];
    return [];
  }

  try {
    const baseUrl = new URL(pagination.sampleRequestUrl);
    const paramName =
      pagination.pageParamName ||
      (pagination.strategy === "page" ? "page" : undefined);

    if (paramName) {
      const missing = getMissingPages(pagination);
      if (missing.length > 0) {
        for (const p of missing.slice(0, maxPagesToGenerate)) {
          const u = new URL(baseUrl.toString());
          u.searchParams.set(paramName, String(p));
          urls.push(u.toString());
        }
        return urls;
      }

      // If totalPages is known and all pages were already seen, re-fetch 1..totalPages
      if (pagination.totalPages && pagination.totalPages > 1) {
        const cap = Math.min(pagination.totalPages, maxPagesToGenerate);
        for (let p = 1; p <= cap; p++) {
          const u = new URL(baseUrl.toString());
          u.searchParams.set(paramName, String(p));
          urls.push(u.toString());
        }
        return urls;
      }

      // If totalPages is unknown, step forward from highest observed page
      const maxSeen =
        pagination.observedPages.length > 0
          ? Math.max(...pagination.observedPages)
          : 1;
      for (let i = 1; i <= maxPagesToGenerate; i++) {
        const u = new URL(baseUrl.toString());
        u.searchParams.set(paramName, String(maxSeen + i));
        urls.push(u.toString());
      }
      return urls;
    }

    if (pagination.nextUrl) {
      urls.push(pagination.nextUrl);
    }
  } catch {
    if (pagination.nextUrl) urls.push(pagination.nextUrl);
  }

  return urls;
}
