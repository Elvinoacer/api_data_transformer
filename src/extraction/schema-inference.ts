import { EndpointSchema, SchemaField } from '../shared/types';
import { flattenObject } from './flatten';

/**
 * Analyzes an array of objects to infer their schema structure, field types, optionality, and potential type conflicts.
 */
export function inferSchemaFromRecords(params: {
  sourceId: string;
  sessionId: string;
  inferredRecordPath: string;
  records: unknown[];
  existingSchema?: EndpointSchema;
}): EndpointSchema {
  const { sourceId, sessionId, inferredRecordPath, records, existingSchema } = params;

  const fields: Record<string, SchemaField> = existingSchema
    ? JSON.parse(JSON.stringify(existingSchema.fields))
    : {};

  const totalRecordCount = (existingSchema?.detectedCount ?? 0) + records.length;
  const presentFieldCounts: Record<string, number> = {};

  for (const item of records) {
    if (!item || typeof item !== 'object') continue;

    const flattened = flattenObject(item);

    for (const [path, val] of Object.entries(flattened)) {
      presentFieldCounts[path] = (presentFieldCounts[path] || 0) + 1;
      const detectedType = detectValueType(val);

      if (!fields[path]) {
        fields[path] = {
          path,
          types: [detectedType],
          optional: false,
          sampleValues: val !== null && val !== undefined ? [val] : [],
          hasConflict: false,
        };
      } else {
        const field = fields[path];
        if (!field.types.includes(detectedType)) {
          field.types.push(detectedType);
        }

        // Keep up to 3 diverse sample values
        if (
          val !== null &&
          val !== undefined &&
          field.sampleValues.length < 3 &&
          !field.sampleValues.some((s) => JSON.stringify(s) === JSON.stringify(val))
        ) {
          field.sampleValues.push(val);
        }
      }
    }
  }

  // Update optionality and conflict status
  for (const [path, field] of Object.entries(fields)) {
    // If not present in all records observed, mark optional
    const count = presentFieldCounts[path] || 0;
    if (count < records.length) {
      field.optional = true;
    }

    // A conflict is when multiple non-null distinct primitive types exist (e.g. number and string)
    const nonNullTypes = field.types.filter((t) => t !== 'null');
    field.hasConflict = nonNullTypes.length > 1;
  }

  return {
    sourceId,
    sessionId,
    fields,
    inferredRecordPath,
    detectedCount: totalRecordCount,
    updatedAt: new Date().toISOString(),
  };
}

function detectValueType(
  val: unknown
): 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' {
  if (val === null || val === undefined) return 'null';
  if (Array.isArray(val)) return 'array';
  const type = typeof val;
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  return 'object';
}
