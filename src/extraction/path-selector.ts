import { COMMON_ARRAY_PATHS } from '../shared/constants';

/**
 * Extracts items from a JSON data object given a dot-separated path.
 * Path "root" means the top-level element itself must be an array.
 */
export function extractItemsByPath(data: unknown, path: string): unknown[] {
  if (!data) return [];

  if (path === 'root') {
    return Array.isArray(data) ? data : [];
  }

  const segments = path.split('.').filter(Boolean);
  let current: any = data;

  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in current) {
      current = current[segment];
    } else {
      return [];
    }
  }

  return Array.isArray(current) ? current : [];
}

export interface DetectedPath {
  path: string;
  count: number;
  sampleItem: unknown;
}

/**
 * Automatically inspects a parsed JSON structure and suggests candidate paths that lead to arrays of objects.
 */
export function findCandidatePaths(data: unknown, maxDepth = 4): DetectedPath[] {
  const candidates: DetectedPath[] = [];

  if (!data || typeof data !== 'object') {
    return candidates;
  }

  // 1. Check root
  if (Array.isArray(data)) {
    candidates.push({
      path: 'root',
      count: data.length,
      sampleItem: data[0] ?? null,
    });
    return candidates;
  }

  // 2. Check prioritized common paths first
  const seenPaths = new Set<string>();
  for (const commonPath of COMMON_ARRAY_PATHS) {
    if (commonPath === 'root') continue;
    const items = extractItemsByPath(data, commonPath);
    if (items.length > 0 && typeof items[0] === 'object') {
      candidates.push({
        path: commonPath,
        count: items.length,
        sampleItem: items[0],
      });
      seenPaths.add(commonPath);
    }
  }

  // 3. Recursive search for other arrays of objects
  function search(obj: any, currentPath: string, depth: number) {
    if (depth > maxDepth || !obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return;
    }

    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const nextPath = currentPath ? `${currentPath}.${key}` : key;

      if (Array.isArray(val)) {
        if (!seenPaths.has(nextPath) && val.length > 0) {
          candidates.push({
            path: nextPath,
            count: val.length,
            sampleItem: val[0],
          });
          seenPaths.add(nextPath);
        }
      } else if (val && typeof val === 'object') {
        search(val, nextPath, depth + 1);
      }
    }
  }

  search(data, '', 1);

  // Sort candidates by count descending
  candidates.sort((a, b) => b.count - a.count);

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
  return 'root';
}
