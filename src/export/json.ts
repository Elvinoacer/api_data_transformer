/**
 * Exports data as formatted JSON.
 */
export function generateJsonExport(data: unknown, pretty = true): string {
  return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}
