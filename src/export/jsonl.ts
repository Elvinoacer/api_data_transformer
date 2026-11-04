/**
 * Exports an array of items as JSON Lines (one JSON string per line).
 */
export function generateJsonlExport(items: unknown[]): string {
  if (!items || items.length === 0) return "";
  return items.map((item) => JSON.stringify(item)).join("\n");
}
