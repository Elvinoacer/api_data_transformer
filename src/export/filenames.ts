/**
 * Generates clean, sanitized export filenames adhering to:
 * collector_<site>_<source>_<YYYY-MM-DD_HH-mm-ss>.<ext>
 */
export function generateExportFilename(params: {
  site?: string;
  source?: string;
  extension: 'csv' | 'json' | 'jsonl';
  date?: Date;
}): string {
  const { site = 'site', source = 'data', extension, date = new Date() } = params;

  const sanitizePart = (str: string) =>
    str
      .toLowerCase()
      .replace(/https?:\/\//, '')
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 30);

  const pad = (n: number) => String(n).padStart(2, '0');
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());

  const timestamp = `${YYYY}-${MM}-${DD}_${hh}-${mm}-${ss}`;
  const cleanSite = sanitizePart(site);
  const cleanSource = sanitizePart(source);

  return `collector_${cleanSite}_${cleanSource}_${timestamp}.${extension}`;
}
