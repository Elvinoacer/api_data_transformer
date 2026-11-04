import { slugifyLabel } from "../extraction/label-inference";

/**
 * Generates clean, sanitized export filenames.
 * Supports clear API dataset labels first (e.g. `medicines_2026-11-03.csv`, `customers_localhost_2026-11-03.csv`)
 * as well as legacy `collector_<site>_<source>_<timestamp>.<ext>` calls.
 */
export function generateExportFilename(params: {
  label?: string;
  site?: string;
  source?: string;
  extension: "csv" | "json" | "jsonl";
  includeTime?: boolean;
  date?: Date;
}): string {
  const {
    label,
    site = "site",
    source = "data",
    extension,
    includeTime = true,
    date = new Date(),
  } = params;

  const sanitizePart = (str: string) =>
    str
      .toLowerCase()
      .replace(/https?:\/\//, "")
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_")
      .slice(0, 40) || "data";

  const pad = (n: number) => String(n).padStart(2, "0");
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());

  const dateStamp = includeTime
    ? `${YYYY}-${MM}-${DD}_${hh}-${mm}-${ss}`
    : `${YYYY}-${MM}-${DD}`;

  // When a semantic API label is provided (e.g. "Medicines", "Customers"), lead with the clear label!
  if (label && label.trim().length > 0) {
    const cleanLabel = slugifyLabel(label);
    const cleanSite =
      site && site !== "localhost" && site !== "127.0.0.1" && site !== "site"
        ? `_${sanitizePart(site)}`
        : "";
    return `${cleanLabel}${cleanSite}_${dateStamp}.${extension}`;
  }

  const cleanSite = sanitizePart(site);
  const cleanSource = sanitizePart(source);

  return `collector_${cleanSite}_${cleanSource}_${dateStamp}.${extension}`;
}
