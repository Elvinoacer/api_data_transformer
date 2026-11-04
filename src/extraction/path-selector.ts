import {
  COMMON_ARRAY_PATHS,
  COMMON_ID_KEYS,
  METADATA_NOISE_ARRAY_KEYS,
} from "../shared/constants";

const ENTITY_HINT_KEYS = new Set([
  "id",
  "_id",
  "uuid",
  "sku",
  "code",
  "name",
  "title",
  "email",
  "price",
  "status",
  "category",
  "createdat",
  "created_at",
  "customer",
  "medicine",
  "product",
]);

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val && typeof val === "object" && !Array.isArray(val));
}

function isObjectDictionary(
  val: unknown,
): val is Record<string, Record<string, unknown>> {
  if (!isPlainObject(val)) return false;
  const entries = Object.entries(val);
  if (entries.length < 2) return false;
  // Exclude common envelope wrappers like { data: {...}, meta: {...} }
  const envelopeKeys = new Set([
    "data",
    "meta",
    "pagination",
    "links",
    "_links",
    "pageInfo",
    "errors",
    "status",
  ]);
  if (entries.every(([k]) => envelopeKeys.has(k))) return false;

  // All values must be non-empty plain objects sharing at least 1 key
  const rawValues = entries.map(([, v]) => v);
  if (
    !rawValues.every(
      (v): v is Record<string, unknown> =>
        isPlainObject(v) && Object.keys(v).length >= 2,
    )
  ) {
    return false;
  }

  const firstKeys = new Set(Object.keys(rawValues[0]));
  let sharedCount = 0;
  for (let i = 1; i < Math.min(rawValues.length, 5); i++) {
    if (Object.keys(rawValues[i]).some((k) => firstKeys.has(k))) {
      sharedCount++;
    }
  }
  return sharedCount > 0;
}

function looksLikeSingleEntity(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length < 2) return false;
  // Must not primarily be an API wrapper with an array inside
  const hasEntityIdOrName = keys.some(
    (k) => ENTITY_HINT_KEYS.has(k.toLowerCase()) || /id$/i.test(k),
  );
  const primitiveOrSimpleCount = keys.filter((k) => {
    const v = obj[k];
    return (
      v === null ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v as object).length <= 5
    );
  }).length;
  return hasEntityIdOrName && primitiveOrSimpleCount >= 2;
}

function resolveDotSegments(data: unknown, rawPath: string): unknown {
  if (!rawPath || rawPath === "root" || rawPath === "single_object") {
    return data;
  }
  const segments = rawPath.split(".").filter(Boolean);
  let current: any = data;

  for (const segment of segments) {
    if (segment.endsWith("[]")) {
      const arrayKey = segment.slice(0, -2);
      const arr = arrayKey ? current?.[arrayKey] : current;
      if (!Array.isArray(arr)) return undefined;
      current = arr;
    } else if (Array.isArray(current)) {
      // Unwrap property across array elements (e.g. edges[].node)
      current = current
        .map((el) => (el && typeof el === "object" ? el[segment] : undefined))
        .filter((el) => el !== undefined && el !== null);
    } else if (current && typeof current === "object" && segment in current) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Extracts items from a JSON data object given a path expression:
 * - "root": top-level array
 * - "single_object": wraps a single root entity object into a 1-element array
 * - "single:<dot.path>": wraps a single nested entity object (e.g. "single:data.customer")
 * - "values(<dot.path>)" or "values(root)": extracts dictionary values with `_key` preserved if needed
 * - "<dot.path>" or "<dot.path>[].node": extracts nested array or GraphQL Relay node array
 */
export function extractItemsByPath(data: unknown, path: string): unknown[] {
  if (!data) return [];

  if (path === "root") {
    return Array.isArray(data) ? data : [];
  }

  if (path === "single_object") {
    return isPlainObject(data) ? [data] : [];
  }

  if (path.startsWith("single:")) {
    const innerPath = path.slice("single:".length);
    const target = resolveDotSegments(data, innerPath);
    return isPlainObject(target) ? [target] : [];
  }

  const valuesMatch = path.match(/^values\((.+)\)$/);
  if (valuesMatch) {
    const innerPath = valuesMatch[1];
    const target =
      innerPath === "root" ? data : resolveDotSegments(data, innerPath);
    if (isPlainObject(target)) {
      return Object.entries(target)
        .filter(([, val]) => isPlainObject(val))
        .map(([dictKey, val]) => {
          const obj = val as Record<string, unknown>;
          if ("id" in obj || "_id" in obj) return obj;
          return { _key: dictKey, ...obj };
        });
    }
    return [];
  }

  const resolved = resolveDotSegments(data, path);
  return Array.isArray(resolved) ? resolved : [];
}

export interface DetectedPath {
  path: string;
  count: number;
  sampleItem: unknown;
  score?: number;
}

function scoreCandidate(path: string, items: unknown[]): number {
  if (items.length === 0) return 0;

  let score = Math.min(items.length, 100) * 1.5;
  const leaf =
    path
      .replace(/^values\((.*)\)$/, "$1")
      .replace(/^single:/, "")
      .replace(/\[\]\.node$/, "")
      .split(".")
      .pop()
      ?.toLowerCase() || "";

  // Boost known primary data paths
  if (COMMON_ARRAY_PATHS.includes(path)) {
    score += 35;
  }
  if (
    [
      "items",
      "results",
      "records",
      "rows",
      "nodes",
      "data",
      "customers",
      "medicines",
      "medications",
      "products",
      "orders",
      "users",
    ].includes(leaf)
  ) {
    score += 30;
  }

  // Penalize UI/metadata noise arrays (facets, breadcrumbs, errors, columns, etc.)
  if (METADATA_NOISE_ARRAY_KEYS.has(leaf)) {
    score -= 80;
  }

  const first = items[0];
  if (isPlainObject(first)) {
    const keys = Object.keys(first);
    // Richer entity objects score higher than 1-key tag objects
    score += Math.min(keys.length, 15) * 4;
    if (keys.some((k) => COMMON_ID_KEYS.includes(k) || /id$/i.test(k))) {
      score += 25;
    }
    if (
      keys.some((k) =>
        ["name", "title", "email", "price", "sku", "status"].includes(
          k.toLowerCase(),
        ),
      )
    ) {
      score += 15;
    }
  } else {
    // Array of primitives (e.g. ["tag1", "tag2"]) is rarely the primary entity list
    score -= 60;
  }

  if (path === "single_object" || path.startsWith("single:")) {
    score -= 20; // Prefer real collections when present
  }

  return score;
}

/**
 * Automatically inspects a parsed JSON structure and suggests candidate paths
 * that lead to collections of entity objects (including Relay edges, dictionaries, and single objects).
 */
export function findCandidatePaths(
  data: unknown,
  maxDepth = 6,
): DetectedPath[] {
  const candidates: DetectedPath[] = [];

  if (!data || typeof data !== "object") {
    return candidates;
  }

  // 1. Check root array
  if (Array.isArray(data)) {
    candidates.push({
      path: "root",
      count: data.length,
      sampleItem: data[0] ?? null,
      score: scoreCandidate("root", data),
    });
    return candidates;
  }

  const seenPaths = new Set<string>();

  const registerCandidate = (path: string, items: unknown[]) => {
    if (seenPaths.has(path) || items.length === 0) return;
    seenPaths.add(path);
    candidates.push({
      path,
      count: items.length,
      sampleItem: items[0] ?? null,
      score: scoreCandidate(path, items),
    });
  };

  // 2. Check prioritized common paths first
  for (const commonPath of COMMON_ARRAY_PATHS) {
    if (commonPath === "root") continue;
    const items = extractItemsByPath(data, commonPath);
    if (items.length > 0 && typeof items[0] === "object" && items[0] !== null) {
      registerCandidate(commonPath, items);
    }
  }

  // 3. Recursive search for nested arrays, GraphQL edges[].node, and object dictionaries
  function search(obj: any, currentPath: string, depth: number) {
    if (
      depth > maxDepth ||
      !obj ||
      typeof obj !== "object" ||
      Array.isArray(obj)
    ) {
      return;
    }

    // Check if obj itself is a dictionary of homogeneous entity objects
    if (isObjectDictionary(obj)) {
      const dictPath = `values(${currentPath || "root"})`;
      const items = extractItemsByPath(data, dictPath);
      registerCandidate(dictPath, items);
    }

    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const nextPath = currentPath ? `${currentPath}.${key}` : key;

      if (Array.isArray(val)) {
        if (val.length > 0) {
          // Check GraphQL Relay pattern: edges: [{ node: { ... } }]
          if (
            key === "edges" &&
            isPlainObject(val[0]) &&
            isPlainObject((val[0] as any).node)
          ) {
            const relayPath = `${nextPath}[].node`;
            const relayItems = extractItemsByPath(data, relayPath);
            registerCandidate(relayPath, relayItems);
          }
          registerCandidate(nextPath, val);
        }
      } else if (val && typeof val === "object") {
        search(val, nextPath, depth + 1);
      }
    }
  }

  search(data, "", 1);

  // 4. If no arrays or dictionaries were found, check if response is a single entity object
  if (candidates.length === 0 && isPlainObject(data)) {
    if (isPlainObject(data.data) && looksLikeSingleEntity(data.data)) {
      registerCandidate("single:data", [data.data]);
    } else if (looksLikeSingleEntity(data)) {
      registerCandidate("single_object", [data]);
    }
  }

  // Sort candidates by smart entity score descending, then count descending
  candidates.sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || b.count - a.count,
  );

  return candidates;
}

/**
 * Automatically chooses the best default path for extracting records from parsed JSON.
 */
export function inferBestRecordPath(data: unknown): string {
  const candidates = findCandidatePaths(data);
  if (candidates.length > 0) {
    return candidates[0].path;
  }
  return "root";
}

/**
 * Inspects extracted items to determine the most reliable unique identity key field.
 */
export function inferBestIdentityKey(items: unknown[]): string {
  const objectItems = items.filter(isPlainObject);
  if (objectItems.length === 0) return "id";

  const sample = objectItems.slice(0, 50);

  // 1. Check prioritized common ID keys that exist with non-empty scalar values
  for (const key of COMMON_ID_KEYS) {
    const values = sample
      .map((item) => item[key])
      .filter(
        (v) =>
          v !== undefined && v !== null && v !== "" && typeof v !== "object",
      );
    if (values.length === sample.length) {
      const uniqueRatio = new Set(values.map(String)).size / values.length;
      if (uniqueRatio >= 0.8 || values.length === 1) {
        return key;
      }
    }
  }

  // 2. Check any field ending with Id / _id
  const firstKeys = Object.keys(sample[0]);
  for (const key of firstKeys) {
    if (/(Id|_id|Key|_key|Code|_code)$/i.test(key)) {
      const values = sample
        .map((item) => item[key])
        .filter(
          (v) =>
            v !== undefined && v !== null && v !== "" && typeof v !== "object",
        );
      if (values.length === sample.length) {
        const uniqueRatio = new Set(values.map(String)).size / values.length;
        if (uniqueRatio >= 0.8 || values.length === 1) {
          return key;
        }
      }
    }
  }

  return "__hash__";
}
