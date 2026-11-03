import { describe, it, expect } from 'vitest';
import {
  checkResponseEligibility,
  parseApiJsonBody,
} from '../../src/privacy/source-policy';
import {
  extractOperationName,
  normalizeEndpoint,
} from '../../src/privacy/url-redaction';
import {
  extractItemsByPath,
  inferBestIdentityKey,
  inferBestRecordPath,
} from '../../src/extraction/path-selector';
import { generateFlattenedCsv } from '../../src/export/csv';

describe('improved API reading & eligibility policy', () => {
  it('captures sibling api.* subdomains and external XHR/Fetch APIs in all_tab_apis mode while blocking analytics noise', () => {
    const externalApi = checkResponseEligibility({
      url: 'https://api-gateway.backend-cloud.io/v1/medicines',
      mimeType: 'application/vnd.api+json',
      resourceType: 'Fetch',
      allowedHostnames: ['app.pharmacy.com'],
      scopeMode: 'all_tab_apis',
    });
    expect(externalApi.isEligible).toBe(true);

    const analyticsNoise = checkResponseEligibility({
      url: 'https://www.google-analytics.com/g/collect',
      mimeType: 'application/json',
      resourceType: 'Fetch',
      allowedHostnames: ['app.pharmacy.com'],
      scopeMode: 'all_tab_apis',
    });
    expect(analyticsNoise.isEligible).toBe(false);
  });

  it('does NOT falsely block /api/authors while still blocking sensitive /auth segments', () => {
    const authorsApi = checkResponseEligibility({
      url: 'https://catalog.example.com/api/authors?page=1',
      mimeType: 'application/json',
      resourceType: 'XHR',
      allowedHostnames: ['catalog.example.com'],
      scopeMode: 'same_domain',
    });
    expect(authorsApi.isEligible).toBe(true);

    const authLogin = checkResponseEligibility({
      url: 'https://catalog.example.com/api/auth/session',
      mimeType: 'application/json',
      resourceType: 'XHR',
      allowedHostnames: ['catalog.example.com'],
      scopeMode: 'same_domain',
    });
    expect(authLogin.isEligible).toBe(false);
  });

  it('strips XSSI prefixes and UTF-8 BOM when parsing JSON API bodies', () => {
    const xssiBody = ")]}',\n{\"customers\":[{\"id\":\"c1\",\"name\":\"Clinic A\"}]}";
    const parsed = parseApiJsonBody(xssiBody);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.data as any).customers[0].name).toBe('Clinic A');
    }
  });

  it('normalizes dynamic REST IDs and GraphQL operation names cleanly', () => {
    expect(normalizeEndpoint('https://api.example.com/api/customers/98412/orders')).toBe(
      'https://api.example.com/api/customers/:id/orders'
    );
    const opName = extractOperationName(
      'https://api.example.com/graphql',
      JSON.stringify({ operationName: 'GetMedicines', variables: { page: 1 } })
    );
    expect(opName).toBe('GetMedicines');
    expect(normalizeEndpoint('https://api.example.com/graphql', opName)).toBe(
      'https://api.example.com/graphql#GetMedicines'
    );
  });
});

describe('smart entity extraction & readable CSV formatting', () => {
  it('ranks primary business records above facets/filter metadata arrays', () => {
    const payload = {
      facets: [
        { key: 'antibiotic', count: 50 },
        { key: 'analgesic', count: 50 },
      ],
      customers: [
        { id: 'cust-1', fullName: 'Clinic One', email: 'one@clinic.org', city: 'Nairobi' },
        { id: 'cust-2', fullName: 'Clinic Two', email: 'two@clinic.org', city: 'Kampala' },
      ],
    };

    expect(inferBestRecordPath(payload)).toBe('customers');
    const items = extractItemsByPath(payload, 'customers');
    expect(inferBestIdentityKey(items)).toBe('id');
  });

  it('extracts GraphQL Relay edges[].node, dictionary maps values(...), and single objects', () => {
    const relayPayload = {
      data: {
        medicines: {
          edges: [
            { cursor: 'c1', node: { medicineId: 'm-1', title: 'Amoxicillin' } },
            { cursor: 'c2', node: { medicineId: 'm-2', title: 'Paracetamol' } },
          ],
        },
      },
    };
    const relayPath = inferBestRecordPath(relayPayload);
    expect(relayPath).toBe('data.medicines.edges[].node');
    expect(extractItemsByPath(relayPayload, relayPath)).toEqual([
      { medicineId: 'm-1', title: 'Amoxicillin' },
      { medicineId: 'm-2', title: 'Paracetamol' },
    ]);

    const mapPayload = {
      entities: {
        'med-101': { sku: 'med-101', name: 'Ibuprofen', price: 12.5 },
        'med-102': { sku: 'med-102', name: 'Cetirizine', price: 8.0 },
      },
    };
    const mapPath = inferBestRecordPath(mapPayload);
    expect(mapPath).toBe('values(entities)');
    expect(extractItemsByPath(mapPayload, mapPath)).toHaveLength(2);
    expect(inferBestIdentityKey(extractItemsByPath(mapPayload, mapPath))).toBe('sku');

    const singlePayload = {
      id: 'cust-99',
      fullName: 'Metro Hospital',
      tier: 'Platinum',
      city: 'Kigali',
    };
    const singlePath = inferBestRecordPath(singlePayload);
    expect(singlePath).toBe('single_object');
    expect(extractItemsByPath(singlePayload, singlePath)).toEqual([singlePayload]);
  });

  it('formats readable CSV headers and comma-joined primitive arrays when requested', () => {
    const rows = [
      {
        id: 'med-1',
        medicineName: 'Paracetamol',
        strength: { value: 500, unit: 'mg' },
        tags: ['analgesic', 'oral'],
      },
    ];
    const csv = generateFlattenedCsv(rows, {
      includeBom: false,
      headerStyle: 'readable',
      arrayFormat: 'readable',
    });
    const [header, row] = csv.split('\r\n');
    expect(header).toContain('ID');
    expect(header).toContain('Medicine Name');
    expect(header).toContain('Strength Value');
    expect(row).toContain('"analgesic, oral"');
  });
});
