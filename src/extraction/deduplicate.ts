import { COMMON_ID_KEYS } from '../shared/constants';
import { ConsolidationPolicy, ExtractedRecord } from '../shared/types';
import { flattenObject } from './flatten';

/**
 * Extracts a stable identity value from an item based on configured field name or auto-detected ID keys.
 */
export function extractIdentityKey(
  item: unknown,
  configuredKey?: string
): { identityKey: string; keySource: string } {
  if (!item || typeof item !== 'object') {
    const fallback = generateStableContentHash(item);
    return { identityKey: fallback, keySource: '__hash__' };
  }

  const obj = item as Record<string, unknown>;

  // 1. Configured key takes precedence
  if (configuredKey && configuredKey !== '__hash__') {
    const val = getNestedValue(obj, configuredKey);
    if (val !== undefined && val !== null && val !== '') {
      return { identityKey: String(val), keySource: configuredKey };
    }
  }

  // 2. Check common ID fields
  for (const candidate of COMMON_ID_KEYS) {
    if (candidate in obj && obj[candidate] !== undefined && obj[candidate] !== null && obj[candidate] !== '') {
      return { identityKey: String(obj[candidate]), keySource: candidate };
    }
  }

  // 3. Fallback to canonical content hash
  const hash = generateStableContentHash(item);
  return { identityKey: hash, keySource: '__hash__' };
}

/**
 * Generates a stable deterministic content hash for arbitrary JSON structures.
 */
export function generateStableContentHash(data: unknown): string {
  const canonical = canonicalJsonStringify(data);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministically sorts object keys recursively before stringifying.
 */
function canonicalJsonStringify(data: unknown): string {
  if (data === null || typeof data !== 'object') {
    return JSON.stringify(data);
  }

  if (Array.isArray(data)) {
    return `[${data.map(canonicalJsonStringify).join(',')}]`;
  }

  const keys = Object.keys(data as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify((data as any)[k])}`
  );
  return `{${entries.join(',')}}`;
}

function getNestedValue(obj: any, path: string): unknown {
  const parts = path.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr && typeof curr === 'object' && part in curr) {
      curr = curr[part];
    } else {
      return undefined;
    }
  }
  return curr;
}

/**
 * Consolidates incoming items against existing records according to the specified policy.
 */
export function consolidateRecords(params: {
  sessionId: string;
  sourceId: string;
  responseId: string;
  rawItems: unknown[];
  existingRecords: ExtractedRecord[];
  identityKeyField?: string;
  policy: ConsolidationPolicy;
}): {
  toInsert: ExtractedRecord[];
  toUpdate: ExtractedRecord[];
  uniqueCount: number;
} {
  const {
    sessionId,
    sourceId,
    responseId,
    rawItems,
    existingRecords,
    identityKeyField,
    policy,
  } = params;

  // Map existing records by identityKey
  const recordMap = new Map<string, ExtractedRecord>();
  for (const rec of existingRecords) {
    recordMap.set(rec.identityKey, rec);
  }

  const toInsert: ExtractedRecord[] = [];
  const toUpdate: ExtractedRecord[] = [];
  const now = new Date().toISOString();

  for (const item of rawItems) {
    const { identityKey } = extractIdentityKey(item, identityKeyField);
    const existing = recordMap.get(identityKey);
    const normalizedFields = typeof item === 'object' && item !== null ? flattenObject(item) : {};

    if (!existing) {
      // New record
      const newRec: ExtractedRecord = {
        id: `${sessionId}_${sourceId}_${identityKey}`,
        sessionId,
        sourceId,
        identityKey,
        extractedAt: now,
        latestResponseId: responseId,
        rawRecord: item,
        normalizedFields,
        version: 1,
      };
      recordMap.set(identityKey, newRec);
      toInsert.push(newRec);
    } else {
      // Existing record duplicate
      if (policy === 'keep_latest') {
        existing.latestResponseId = responseId;
        existing.rawRecord = item;
        existing.normalizedFields = normalizedFields;
        existing.extractedAt = now;
        existing.version += 1;
        toUpdate.push(existing);
      } else if (policy === 'keep_all') {
        // Create an additional entry with unique ID
        const subId = `${sessionId}_${sourceId}_${identityKey}_v${existing.version + 1}`;
        const newRec: ExtractedRecord = {
          id: subId,
          sessionId,
          sourceId,
          identityKey,
          extractedAt: now,
          latestResponseId: responseId,
          rawRecord: item,
          normalizedFields,
          version: existing.version + 1,
        };
        toInsert.push(newRec);
      }
      // 'keep_first' simply ignores subsequent duplicates
    }
  }

  return {
    toInsert,
    toUpdate,
    uniqueCount: recordMap.size,
  };
}
