/**
 * Sanitizes cell values to defend against Spreadsheet Formula Injection (CSV Injection).
 * Excel, LibreOffice, and Google Sheets evaluate formulas starting with =, +, -, @, or tab/return.
 * Prepends an inert character (') if the text could be interpreted as a formula.
 */
export function sanitizeForFormulaInjection(value: string): string {
  if (!value || typeof value !== "string") {
    return value;
  }

  // Strip leading whitespace to test prefix
  const trimmed = value.trimStart();
  if (trimmed.length === 0) return value;

  const firstChar = trimmed[0];
  const dangerousChars = ["=", "+", "-", "@", "\t", "\r"];

  if (dangerousChars.includes(firstChar)) {
    // Prefix with single quote to force spreadsheet to treat as plain string
    return `'${value}`;
  }

  return value;
}
