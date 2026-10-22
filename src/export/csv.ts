import { collectUniqueColumns, flattenObject } from '../extraction/flatten';
import { sanitizeForFormulaInjection } from './sanitize';

export interface CsvExportOptions {
  includeBom?: boolean;
  defendFormulaInjection?: boolean;
  nullValueRepresentation?: '' | 'null';
  columns?: string[];
}

/**
 * Encodes a single cell value into an RFC 4180 compliant CSV string.
 */
export function formatCsvCell(
  val: unknown,
  options: CsvExportOptions = {}
): string {
  const {
    defendFormulaInjection = true,
    nullValueRepresentation = '',
  } = options;

  if (val === null || val === undefined) {
    return nullValueRepresentation;
  }

  let str = typeof val === 'object' ? JSON.stringify(val) : String(val);

  if (defendFormulaInjection) {
    str = sanitizeForFormulaInjection(str);
  }

  // RFC 4180: If contains comma, quote, newline, or carriage return, enclose in quotes and double quotes
  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    const escaped = str.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  return str;
}

/**
 * Converts an array of objects into flattened CSV format.
 */
export function generateFlattenedCsv(
  items: unknown[],
  options: CsvExportOptions = {}
): string {
  if (!items || items.length === 0) {
    return options.includeBom ? '\uFEFF' : '';
  }

  // Flatten every item
  const flattenedRecords = items.map((item) =>
    typeof item === 'object' && item !== null ? flattenObject(item) : { value: item }
  );

  // Compute column list
  const columns = options.columns && options.columns.length > 0
    ? options.columns
    : collectUniqueColumns(flattenedRecords);

  const lines: string[] = [];

  // Header line
  lines.push(columns.map((c) => formatCsvCell(c, { ...options, defendFormulaInjection: false })).join(','));

  // Data lines
  for (const record of flattenedRecords) {
    const row = columns.map((col) => {
      const val = (record as any)[col];
      return formatCsvCell(val, options);
    });
    lines.push(row.join(','));
  }

  const csvContent = lines.join('\r\n');
  return options.includeBom ? `\uFEFF${csvContent}` : csvContent;
}

/**
 * Converts raw responses or records into a CSV with metadata + raw JSON column.
 */
export function generateRawRecordCsv(
  records: { id: string; capturedAt?: string; source?: string; rawRecord: unknown }[],
  options: CsvExportOptions = {}
): string {
  const headers = ['id', 'capturedAt', 'source', 'raw_json'];
  const lines: string[] = [];

  lines.push(headers.map((h) => formatCsvCell(h, { ...options, defendFormulaInjection: false })).join(','));

  for (const r of records) {
    const row = [
      formatCsvCell(r.id, options),
      formatCsvCell(r.capturedAt || '', options),
      formatCsvCell(r.source || '', options),
      formatCsvCell(JSON.stringify(r.rawRecord), options),
    ];
    lines.push(row.join(','));
  }

  const csvContent = lines.join('\r\n');
  return options.includeBom ? `\uFEFF${csvContent}` : csvContent;
}
