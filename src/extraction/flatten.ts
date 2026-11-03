export interface FlattenOptions {
  arrayFormat?: 'json' | 'readable';
}

function serializeArray(arr: unknown[], format: 'json' | 'readable'): string {
  if (format === 'readable') {
    if (arr.length === 0) return '';
    const allPrimitives = arr.every(
      (item) => item === null || item === undefined || typeof item !== 'object'
    );
    if (allPrimitives) {
      return arr
        .filter((item) => item !== null && item !== undefined && item !== '')
        .map(String)
        .join(', ');
    }
    // Array of objects: try extracting concise label/name/id summary if simple, else JSON
    const canSummarize = arr.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        ('name' in (item as any) || 'title' in (item as any) || 'label' in (item as any))
    );
    if (canSummarize) {
      return arr
        .map((item: any) => String(item.name ?? item.title ?? item.label))
        .join(', ');
    }
  }
  return JSON.stringify(arr);
}

/**
 * Flattens a nested object into dot-notated key-value pairs.
 * Nested objects become `parent.child`.
 * Arrays are serialized to JSON strings by default, or comma-separated lists when `arrayFormat: 'readable'`.
 * Null and primitive types are preserved.
 */
export function flattenObject(
  obj: unknown,
  prefix = '',
  result: Record<string, unknown> = {},
  options: FlattenOptions = {}
): Record<string, unknown> {
  const arrayFormat = options.arrayFormat || 'json';

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
    if (prefix) {
      result[prefix] = serializeArray(obj, arrayFormat);
    }
    return result;
  }

  // Record / Plain object
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0 && prefix) {
    result[prefix] = arrayFormat === 'readable' ? '' : '{}';
    return result;
  }

  for (const [key, value] of entries) {
    // Skip internal GraphQL metadata noise only if empty; keep real fields
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      if (Object.keys(value).length > 0) {
        flattenObject(value, newKey, result, options);
      } else {
        result[newKey] = arrayFormat === 'readable' ? '' : '{}';
      }
    } else if (Array.isArray(value)) {
      result[newKey] = serializeArray(value, arrayFormat);
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

/**
 * Converts a dot-path column key into a clean human-readable column header.
 * Example: "strength.value" -> "Strength Value", "inStock" -> "In Stock"
 */
export function formatColumnHeader(col: string, style: 'dot' | 'readable' = 'dot'): string {
  if (style === 'dot') return col;
  return col
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length <= 2 && w.toUpperCase() === 'ID' ? 'ID' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Extracts a complete, sorted list of all unique column keys present across multiple flattened records.
 */
export function collectUniqueColumns(records: Record<string, unknown>[]): string[] {
  const columnSet = new Set<string>();

  // Prioritize common ID and primary label columns first
  const preferredOrder = [
    '_dataset',
    'id',
    '_id',
    'uuid',
    'customerId',
    'customer_id',
    'medicineId',
    'medicine_id',
    'productId',
    'orderId',
    'sku',
    'code',
    'name',
    'fullName',
    'title',
    'email',
    'category',
    'status',
    'price',
  ];

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
