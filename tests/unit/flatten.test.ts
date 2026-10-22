import { describe, it, expect } from 'vitest';
import { flattenObject, collectUniqueColumns } from '../../src/extraction/flatten';

describe('flattenObject', () => {
  it('flattens nested objects into dot paths and serializes arrays as JSON strings', () => {
    const input = {
      id: 'med-123',
      name: 'Paracetamol',
      strength: { value: 500, unit: 'mg' },
      categories: ['analgesic', 'antipyretic'],
    };

    const output = flattenObject(input);

    expect(output).toEqual({
      id: 'med-123',
      name: 'Paracetamol',
      'strength.value': 500,
      'strength.unit': 'mg',
      categories: '["analgesic","antipyretic"]',
    });
  });

  it('handles null, numbers, booleans, and empty objects', () => {
    const input = {
      active: true,
      count: 0,
      description: null,
      emptyObj: {},
    };

    const output = flattenObject(input);

    expect(output).toEqual({
      active: true,
      count: 0,
      description: null,
      emptyObj: '{}',
    });
  });

  it('collects unique columns across records in deterministic prioritized order', () => {
    const records = [
      { id: '1', name: 'A', 'strength.value': 100 },
      { id: '2', title: 'B', 'strength.unit': 'mg', category: 'General' },
    ];

    const columns = collectUniqueColumns(records);

    expect(columns).toContain('id');
    expect(columns).toContain('name');
    expect(columns).toContain('title');
    expect(columns).toContain('strength.value');
    expect(columns).toContain('strength.unit');
    expect(columns).toContain('category');
    expect(columns[0]).toBe('id');
  });
});
