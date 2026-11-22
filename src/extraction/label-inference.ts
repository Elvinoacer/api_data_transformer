const GENERIC_URL_SEGMENTS = new Set([
  "api",
  "apis",
  "rest",
  "graphql",
  "gql",
  "rpc",
  "trpc",
  "odata",
  "public",
  "private",
  "internal",
  "external",
  "web",
  "mobile",
  "app",
  "bff",
  "gateway",
  "proxy",
  "service",
  "services",
  "data",
  "json",
  "list",
  "index",
  "search",
  "query",
  "filter",
  "cursor",
  "paginate",
  "paginated",
  "page",
  "all",
  "active",
  "by-id",
  "details",
  "detail",
  "info",
  "get",
  "fetch",
  "load",
  "read",
  ":id",
  ":uuid",
]);

const GENERIC_PATH_KEYS = new Set([
  "root",
  "single_object",
  "data",
  "results",
  "result",
  "items",
  "records",
  "rows",
  "list",
  "entries",
  "content",
  "value",
  "values",
  "nodes",
  "node",
  "edges",
  "documents",
  "hits",
  "response",
  "payload",
  "body",
]);

/**
 * Converts camelCase, PascalCase, snake_case, or kebab-case identifiers into clean Title Case words.
 * Example: "patient_medicines" -> "Patient Medicines", "GetCustomersQuery" -> "Get Customers Query"
 */
export function humanizeIdentifier(raw: string): string {
  if (!raw) return "";
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return spaced
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (
        word.length <= 3 &&
        word === word.toUpperCase() &&
        /^[A-Z]+$/.test(word)
      ) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Converts any label into a clean filesystem-safe slug for exported files.
 * Example: "Medicines (Active)" -> "medicines_active"
 */
export function slugifyLabel(label: string): string {
  const cleaned = label
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return cleaned.slice(0, 48) || "dataset";
}

function isDynamicOrVersionSegment(seg: string): boolean {
  const lower = seg.toLowerCase();
  if (/^v\d+(\.\d+)?$/.test(lower)) return true; // v1, v2, v1.2
  if (/^\d+$/.test(lower)) return true; // numeric ID
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      lower,
    )
  )
    return true; // UUID
  if (/^[0-9a-f]{24}$/i.test(lower)) return true; // Mongo ObjectId
  if (lower.startsWith(":")) return true; // :id
  return false;
}

const BANDAGO_OP_LABELS: Record<string, string> = {
  M_ProductGet: "BandaGo Products",
  M_ProductForProductListPage: "BandaGo Products",
  M_StorageOnHandGet: "BandaGo Inventory Batches",
  M_StorageOnHandForInventoryList: "BandaGo Inventory Batches",
  M_Product_CategoryGet: "BandaGo Product Categories",
  M_ProductPriceGet: "BandaGo Product Prices",
  C_LocationGet: "BandaGo Locations",
  AD_MenuGet: "BandaGo Navigation Menu",
  BH_HIE_OrgGet: "BandaGo HIE Organizations",
  BH_IDSR_CaseGet: "BandaGo IDSR Cases",
};

function cleanOperationName(opName: string): string {
  const raw = opName.trim();
  const isCountOnly = /:count$/i.test(raw);
  const base = raw.replace(/:count$/i, "").trim();

  if (BANDAGO_OP_LABELS[base]) {
    return isCountOnly
      ? `${BANDAGO_OP_LABELS[base]} (Count)`
      : BANDAGO_OP_LABELS[base];
  }

  // Handle iDempiere/BandaGo operation/field naming like M_ProductGet, BH_VisitGet
  if (/^(?:M|C|AD|BH)_[A-Za-z0-9_]+Get$/.test(base)) {
    const stripped = base
      .replace(/^(?:M|C|AD|BH)_/, "")
      .replace(/Get$/, "");
    const label = humanizeIdentifier(stripped);
    if (label) {
      return isCountOnly ? `BandaGo ${label} (Count)` : `BandaGo ${label}`;
    }
  }

  let cleaned = base;
  // Strip common GraphQL verb prefixes and suffixes
  cleaned = cleaned.replace(
    /^(get|list|fetch|load|search|find|query|read)(?=[A-Z_])/i,
    "",
  );
  cleaned = cleaned.replace(
    /(Query|Mutation|List|Data|Payload|Response|Connection)$/i,
    "",
  );
  cleaned = cleaned.replace(/^_+|_+$/g, "");
  const formatted = humanizeIdentifier(cleaned || base);
  return isCountOnly && formatted ? `${formatted} (Count)` : formatted;
}

/**
 * Automatically infers a clean, semantic dataset label (e.g. "Customers", "Medicines", "Orders")
 * from an API endpoint's GraphQL operationName, URL path, or JSON record extraction path.
 */
export function inferDatasetLabel(params: {
  url: string;
  operationName?: string;
  recordPath?: string;
}): string {
  const { url, operationName, recordPath } = params;

  // 1. GraphQL / RPC operationName is usually the most specific semantic label
  if (operationName && operationName.trim().length > 0) {
    const fromOp = cleanOperationName(operationName);
    if (fromOp) return fromOp;
  }

  // 2. Check URL path segments from right to left for a meaningful resource noun
  try {
    const cleanUrl = url.split("#")[0];
    const parsed = new URL(cleanUrl, "http://localhost");
    const segments = parsed.pathname
      .split("/")
      .map((s) =>
        decodeURIComponent(s)
          .replace(/\.json$/i, "")
          .trim(),
      )
      .filter(Boolean);

    const meaningful = segments.filter(
      (seg) =>
        !GENERIC_URL_SEGMENTS.has(seg.toLowerCase()) &&
        !isDynamicOrVersionSegment(seg),
    );

    if (meaningful.length > 0) {
      // Pick the right-most resource noun (e.g. /pharmacy/customers -> "Customers", /customers/:id/orders -> "Orders")
      const chosen = meaningful[meaningful.length - 1];
      const humanized = humanizeIdentifier(chosen);
      if (humanized) return humanized;
    }

    // Check query param hints for RPC-style endpoints (e.g. ?action=get_medicines or ?entity=customers)
    for (const key of [
      "resource",
      "entity",
      "collection",
      "table",
      "type",
      "action",
      "endpoint",
    ]) {
      const val = parsed.searchParams.get(key);
      if (val && !isDynamicOrVersionSegment(val)) {
        const cleaned = cleanOperationName(val);
        if (cleaned) return cleaned;
      }
    }
  } catch {
    // Ignore URL parse error and fall through
  }

  // 3. Check recordPath for domain-specific collection keys (e.g. "data.medicines" -> "Medicines")
  if (recordPath) {
    const cleanedPath = recordPath
      .replace(/^values\((.*)\)$/, "$1")
      .replace(/\[\]/g, "");
    const parts = cleanedPath
      .split(".")
      .map((p) => p.trim())
      .filter((p) => p && !GENERIC_PATH_KEYS.has(p.toLowerCase()));
    if (parts.length > 0) {
      const humanized = humanizeIdentifier(parts[parts.length - 1]);
      if (humanized) return humanized;
    }
  }

  // 4. Fallback to last URL path segment or host
  try {
    const parsed = new URL(url.split("#")[0], "http://localhost");
    const lastSeg = parsed.pathname.split("/").filter(Boolean).pop();
    if (lastSeg && !isDynamicOrVersionSegment(lastSeg)) {
      return humanizeIdentifier(lastSeg);
    }
    return `${humanizeIdentifier(parsed.hostname.split(".")[0] || "API")} Dataset`;
  } catch {
    return "API Dataset";
  }
}
