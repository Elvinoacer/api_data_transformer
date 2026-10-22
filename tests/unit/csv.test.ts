import { describe, it, expect } from 'vitest';
import { generateFlattenedCsv, formatCsvCell, generateRawRecordCsv } from '../../src/export/csv';

describe('formatCsvCell and CSV export', () => {
  it('escapes cells containing commas, quotes, and newlines per RFC 4180', () => {
    expect(formatCsvCell('Hello, World')).toBe('"Hello, World"');
    expect(formatCsvCell('Quote "test"')).toBe('"Quote ""test"""');
    expect(formatCsvCell('Line1\nLine2')).toBe('"Line1\nLine2"');
  });

  it('defends against formula injection by prefixing dangerous characters with a single quote', () => {
    expect(formatCsvCell('=SUM(A1:A10)', { defendFormulaInjection: true })).toBe('\'=SUM(A1:A10)');
    expect(formatCsvCell('+12345', { defendFormulaInjection: true })).toBe('\'+12345');
    expect(formatCsvCell('-54321', { defendFormulaInjection: true })).toBe('\'-54321');
    expect(formatCsvCell('@cmd', { defendFormulaInjection: true })).toBe('\'@cmd');
  });

  it('generates flattened CSV with header and data rows', () => {
    const items = [
      {
        id: 'med-1',
        name: 'Aspirin',
        strength: { value: 300, unit: 'mg' },
      },
      {
        id: 'med-2',
        name: 'Ibuprofen, 400mg',
        strength: { value: 400, unit: 'mg' },
      },
    ];

    const csv = generateFlattenedCsv(items, { includeBom: false });
    const lines = csv.split('\r\n');

    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('name');
    expect(lines[0]).toContain('strength.value');
    expect(lines[2]).toContain('"Ibuprofen, 400mg"');
  });

  it('prepends UTF-8 BOM when includeBom is true', () => {
    const csv = generateFlattenedCsv([{ id: '1' }], { includeBom: true });
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  it('generates raw record CSV with metadata and raw_json column', () => {
    const records = [
      {
        id: 'rec_1',
        capturedAt: '2026-10-22T10:00:00Z',
        source: 'api/medications',
        rawRecord: { name: 'Amoxicillin' },
      },
    ];

    const csv = generateRawRecordCsv(records, { includeBom: false });
    expect(csv).toContain('id,capturedAt,source,raw_json');
    expect(csv).toContain('rec_1');
    expect(csv).toContain('"{""name"":""Amoxicillin""}"');
  });
});
