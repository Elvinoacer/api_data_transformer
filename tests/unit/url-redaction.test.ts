import { describe, it, expect } from 'vitest';
import { redactSensitiveUrl, normalizeEndpoint } from '../../src/privacy/url-redaction';

describe('url redaction and normalization', () => {
  it('redacts sensitive query parameters like token, password, apiKey', () => {
    const url = 'https://api.example.com/v1/items?page=2&access_token=secret123&api_key=key999';
    const redacted = redactSensitiveUrl(url);

    expect(redacted).toContain('page=2');
    expect(redacted).toContain('access_token=%5BREDACTED%5D');
    expect(redacted).toContain('api_key=%5BREDACTED%5D');
    expect(redacted).not.toContain('secret123');
    expect(redacted).not.toContain('key999');
  });

  it('normalizes endpoint by stripping query strings and trailing slashes for clean grouping', () => {
    const url1 = 'https://pharmacy.example.com/api/medications?page=1&limit=50';
    const url2 = 'https://pharmacy.example.com/api/medications?page=2&limit=50';
    const url3 = 'https://pharmacy.example.com/api/medications/';

    expect(normalizeEndpoint(url1)).toBe('https://pharmacy.example.com/api/medications');
    expect(normalizeEndpoint(url2)).toBe('https://pharmacy.example.com/api/medications');
    expect(normalizeEndpoint(url3)).toBe('https://pharmacy.example.com/api/medications');
  });
});
