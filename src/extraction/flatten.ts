/**
 * Flattens a nested object into dot-notated key-value pairs.
 * Nested objects become `parent.child`.
 * Arrays are serialized to JSON strings unless configured otherwise.
 * Null and primitive types are preserved.
 */
export function flattenObject(
  obj: unknown,
  prefix = '',
  result: Record<string, unknown> = {}
): Record<string, unknown> {
  if (obj === null || obj === undefined) {
    if (prefix) {
      result[prefix] = obj;
    }
    return result;
  }

  if (typeof obj !== 'object') {
    if (prefix) {
      result[prefix] = obj;
    }
    return result;
  }

  if (Array.isArray(obj)) {
    // Array: serialize to JSON string
    if (prefix) {
      result[prefix] = JSON.stringify(obj);
    }
    return result;
  }

  // Record / Plain object
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0 && prefix) {
    result[prefix] = '{}';
    return result;
  }

  for (const [key, value] of entries) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      if (Object.keys(value).length > 0) {
        flattenObject(value, newKey, result);
      } else {
        result[newKey] = '{}';
      }
    } else if (Array.isArray(value)) {
      result[newKey] = JSON.stringify(value);
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

/**
 * Extracts a complete, sorted list of all unique column keys present across multiple flattened records.
 */
export function collectUniqueColumns(records: Record<string, unknown>[]): string[] {
  const columnSet = new Set<string>();

  // Prioritize common ID columns first
  const preferredOrder = ['id', '_id', 'uuid', 'productId', 'sku', 'name', 'title'];

  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      columnSet.add(key);
    }
  }

  const allColumns = Array.from(columnSet);

  allColumns.sort((a, b) => {
    const aPref = preferredOrder.indexOf(a);
    const bPref = preferredOrder.indexOf(b);

    if (aPref !== -1 && bPref !== -1) return aPref - bPref;
    if (aPref !== -1) return -1;
    if (bPref !== -1) return 1;

    // Put dot-paths after top-level properties
    const aDots = (a.match(/\./g) || []).length;
    const bDots = (b.match(/\./g) || []).length;
    if (aDots !== bDots) return aDots - bDots;

    return a.localeCompare(b);
  });

  return allColumns;
}
