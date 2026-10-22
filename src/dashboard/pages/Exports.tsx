import React, { useState, useMemo } from 'react';
import { EndpointSource, ExtractedRecord, RawResponse, CaptureSession } from '../../shared/types';
import { Download, FileSpreadsheet, FileJson, Eye, Check } from 'lucide-react';
import { generateFlattenedCsv, generateRawRecordCsv } from '../../export/csv';
import { generateJsonExport } from '../../export/json';
import { generateJsonlExport } from '../../export/jsonl';
import { generateExportFilename } from '../../export/filenames';

interface Props {
  session: CaptureSession | null;
  sources: EndpointSource[];
  records: ExtractedRecord[];
  rawResponses: RawResponse[];
}

export const Exports: React.FC<Props> = ({ session, sources, records, rawResponses }) => {
  const [format, setFormat] = useState<'csv_flattened' | 'csv_raw' | 'jsonl' | 'json_bundle'>('csv_flattened');
  const [selectedSourceId, setSelectedSourceId] = useState<string>('all');
  const [includeBom, setIncludeBom] = useState(true);
  const [defendFormulaInjection, setDefendFormulaInjection] = useState(true);
  const [nullAsBlank, setNullAsBlank] = useState(true);
  const [downloading, setDownloading] = useState(false);

  // Filter records by source
  const targetRecords = useMemo(() => {
    if (selectedSourceId === 'all') return records;
    return records.filter((r) => r.sourceId === selectedSourceId);
  }, [records, selectedSourceId]);

  // Compute filename
  const filename = useMemo(() => {
    const site = session?.allowedHostnames[0] || 'catalog';
    const sourceName = selectedSourceId === 'all' ? 'dataset' : 'endpoint';
    const ext = format.startsWith('csv') ? 'csv' : format === 'jsonl' ? 'jsonl' : 'json';
    return generateExportFilename({ site, source: sourceName, extension: ext });
  }, [session, selectedSourceId, format]);

  // Generate exported text
  const exportPayload = useMemo(() => {
    switch (format) {
      case 'csv_flattened': {
        const items = targetRecords.map((r) => r.rawRecord);
        return generateFlattenedCsv(items, {
          includeBom,
          defendFormulaInjection,
          nullValueRepresentation: nullAsBlank ? '' : 'null',
        });
      }
      case 'csv_raw': {
        const items = targetRecords.map((r) => ({
          id: r.id,
          capturedAt: r.extractedAt,
          source: r.sourceId,
          rawRecord: r.rawRecord,
        }));
        return generateRawRecordCsv(items, {
          includeBom,
          defendFormulaInjection,
        });
      }
      case 'jsonl': {
        const items = targetRecords.map((r) => r.rawRecord);
        return generateJsonlExport(items);
      }
      case 'json_bundle': {
        return generateJsonExport({
          session,
          exportedAt: new Date().toISOString(),
          sources,
          recordsCount: targetRecords.length,
          rawResponsesCount: rawResponses.length,
          records: targetRecords,
          rawResponses: rawResponses.slice(0, 50),
        });
      }
    }
  }, [format, targetRecords, includeBom, defendFormulaInjection, nullAsBlank, session, sources]);

  const handleDownload = () => {
    setDownloading(true);
    try {
      const mime = format.startsWith('csv')
        ? 'text/csv;charset=utf-8'
        : format === 'jsonl'
        ? 'application/x-ndjson;charset=utf-8'
        : 'application/json;charset=utf-8';

      const blob = new Blob([exportPayload], { type: mime });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download error:', err);
    } finally {
      setTimeout(() => setDownloading(false), 800);
    }
  };

  const previewLines = useMemo(() => {
    const lines = exportPayload.split(/\r?\n/).slice(0, 8);
    return lines.join('\n');
  }, [exportPayload]);

  return (
    <div className="space-y-6">
      {/* Exports Header */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6">
        <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <Download className="w-5 h-5 text-indigo-600" />
          Export Accumulated Dataset
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Download records directly to your device in your preferred analysis format. All transformations happen locally.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Export Configuration Controls */}
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 space-y-5 lg:col-span-1">
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
              1. Choose Export Format
            </label>
            <div className="space-y-2">
              {[
                {
                  id: 'csv_flattened',
                  label: 'Flattened CSV (Spreadsheets)',
                  desc: 'Dot-notation nested columns, serialized arrays',
                  icon: <FileSpreadsheet className="w-4 h-4 text-emerald-600" />,
                },
                {
                  id: 'csv_raw',
                  label: 'Raw CSV (Metadata + JSON)',
                  desc: 'Includes raw JSON in single column',
                  icon: <FileSpreadsheet className="w-4 h-4 text-slate-600" />,
                },
                {
                  id: 'jsonl',
                  label: 'JSON Lines (JSONL)',
                  desc: 'One JSON record per line, ideal for big data ETL',
                  icon: <FileJson className="w-4 h-4 text-blue-600" />,
                },
                {
                  id: 'json_bundle',
                  label: 'Full Session JSON Bundle',
                  desc: 'Session metadata, raw responses, and records',
                  icon: <FileJson className="w-4 h-4 text-indigo-600" />,
                },
              ].map((opt) => (
                <div
                  key={opt.id}
                  onClick={() => setFormat(opt.id as any)}
                  className={`p-3 rounded-lg border cursor-pointer transition ${
                    format === opt.id
                      ? 'border-indigo-600 bg-indigo-50/40 shadow-xs'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 font-medium text-xs text-slate-900 mb-0.5">
                    {opt.icon}
                    {opt.label}
                  </div>
                  <p className="text-[11px] text-slate-500">{opt.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
              2. Source Scope
            </label>
            <select
              value={selectedSourceId}
              onChange={(e) => setSelectedSourceId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 focus:ring-1 focus:ring-indigo-500"
            >
              <option value="all">All Sources ({records.length} records)</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.httpMethod} {s.normalizedEndpoint.split('/').slice(-2).join('/')}
                </option>
              ))}
            </select>
          </div>

          {format.startsWith('csv') && (
            <div className="pt-3 border-t border-slate-100 space-y-3">
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider">
                CSV Security & Encoding
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={defendFormulaInjection}
                  onChange={(e) => setDefendFormulaInjection(e.target.checked)}
                  className="rounded text-indigo-600 mt-0.5"
                />
                <div>
                  <span className="font-semibold block">Formula Injection Defense</span>
                  <span className="text-[11px] text-slate-500">
                    Prefixes =, +, -, @ to prevent spreadsheet formula execution
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={includeBom}
                  onChange={(e) => setIncludeBom(e.target.checked)}
                  className="rounded text-indigo-600 mt-0.5"
                />
                <div>
                  <span className="font-semibold block">UTF-8 BOM Header</span>
                  <span className="text-[11px] text-slate-500">
                    Ensures Excel correctly displays Unicode characters
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={nullAsBlank}
                  onChange={(e) => setNullAsBlank(e.target.checked)}
                  className="rounded text-indigo-600 mt-0.5"
                />
                <div>
                  <span className="font-semibold block">Blank Empty Cells</span>
                  <span className="text-[11px] text-slate-500">
                    Leave null/empty cells blank instead of printing "null"
                  </span>
                </div>
              </label>
            </div>
          )}

          <div className="pt-4 border-t border-slate-100">
            <button
              onClick={handleDownload}
              disabled={downloading || targetRecords.length === 0}
              className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm flex items-center justify-center gap-2 transition"
            >
              {downloading ? <Check className="w-4 h-4 text-emerald-300" /> : <Download className="w-4 h-4" />}
              {downloading ? 'Downloaded!' : `Download File (${targetRecords.length} records)`}
            </button>
          </div>
        </div>

        {/* Live Export Preview */}
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 lg:col-span-2 flex flex-col">
          <div className="flex items-center justify-between pb-4 border-b border-slate-100 mb-4">
            <div>
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <Eye className="w-4 h-4 text-indigo-600" /> Export Preview
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Target file: <code className="font-mono text-indigo-700 font-bold">{filename}</code>
              </p>
            </div>
            <span className="px-2.5 py-1 bg-slate-100 text-slate-700 text-xs font-medium rounded-full">
              {targetRecords.length} records queued
            </span>
          </div>

          <div className="flex-1 bg-slate-950 p-4 rounded-lg overflow-auto font-mono text-xs text-slate-300 max-h-[450px]">
            {targetRecords.length === 0 ? (
              <div className="text-slate-500 text-center py-12">
                No records to preview. Capture traffic from target website.
              </div>
            ) : (
              <pre className="whitespace-pre-wrap">{previewLines}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
