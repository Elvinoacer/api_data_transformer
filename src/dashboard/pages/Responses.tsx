import React, { useState, useId, useMemo } from 'react';
import { EndpointSource, RawResponse } from '../../shared/types';
import {
  FileCode2,
  Search,
  Eye,
  CheckCircle2,
  AlertOctagon,
  Ban,
  Clock,
} from 'lucide-react';
import { JsonViewerModal } from '../components/JsonViewerModal';

interface Props {
  responses: RawResponse[];
  sources: EndpointSource[];
}

export const Responses: React.FC<Props> = ({ responses, sources }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedResponse, setSelectedResponse] = useState<RawResponse | null>(null);
  const captionId = useId();

  const labelByEndpoint = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) {
      map.set(`${s.httpMethod}_${s.normalizedEndpoint}`, s.label);
    }
    return map;
  }, [sources]);

  const filtered = responses.filter((r) => {
    if (!searchTerm.trim()) return true;
    const lower = searchTerm.toLowerCase();
    const label = labelByEndpoint.get(`${r.httpMethod}_${r.normalizedEndpoint}`) || '';
    return (
      r.url.toLowerCase().includes(lower) ||
      r.normalizedEndpoint.toLowerCase().includes(lower) ||
      r.httpMethod.toLowerCase().includes(lower) ||
      label.toLowerCase().includes(lower)
    );
  });

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const getStatusBadge = (status: RawResponse['parseStatus']) => {
    switch (status) {
      case 'parsed':
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-900 bg-brand-50 border border-brand-300 px-2 py-0.5 rounded-full">
            <CheckCircle2 className="w-3 h-3 text-brand-700" aria-hidden="true" /> Parsed
          </span>
        );
      case 'invalid_json':
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-800 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">
            <AlertOctagon className="w-3 h-3 text-rose-600" aria-hidden="true" /> Invalid JSON
          </span>
        );
      case 'excluded':
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-stone-600 bg-stone-100 border border-stone-200 px-2 py-0.5 rounded-full">
            <Ban className="w-3 h-3 text-stone-500" aria-hidden="true" /> Excluded
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
            <Clock className="w-3 h-3 text-amber-600" aria-hidden="true" /> Pending
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Search */}
      <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-obsidian-900 flex items-center gap-2">
            <FileCode2 className="w-5 h-5 text-brand-700" aria-hidden="true" />
            Captured Raw API Responses ({responses.length})
          </h2>
          <p className="text-xs text-stone-600 mt-1">
            Append-only history of every observed JSON payload, including sensitive parameter redaction and detected page numbers.
          </p>
        </div>

        <div className="relative w-full md:w-72">
          <Search
            className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <label htmlFor="responses-search" className="visually-hidden">
            Search raw responses
          </label>
          <input
            id="responses-search"
            type="text"
            placeholder="Filter by dataset label or URL..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs focus:bg-white text-obsidian-900"
          />
        </div>
      </div>

      {/* Responses Table */}
      <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-12 text-center text-stone-500 text-xs">
            {responses.length === 0
              ? 'No raw responses captured yet. Navigate the target website tab to observe API traffic.'
              : 'No responses match your search query.'}
          </div>
        ) : (
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={captionId}
            className="table-wrapper max-h-[65vh]"
          >
            <table className="w-full text-left text-xs text-obsidian-900">
              <caption id={captionId} className="visually-hidden">
                Captured raw HTTP JSON responses
              </caption>
              <thead className="bg-stone-100/95 text-[11px] font-bold uppercase text-stone-600 border-b border-stone-200">
                <tr>
                  <th scope="col" className="px-5 py-3">Time</th>
                  <th scope="col" className="px-5 py-3">Dataset</th>
                  <th scope="col" className="px-5 py-3">Method & Status</th>
                  <th scope="col" className="px-5 py-3">Redacted URL</th>
                  <th scope="col" className="px-5 py-3">Items & Page</th>
                  <th scope="col" className="px-5 py-3">Size</th>
                  <th scope="col" className="px-5 py-3">Status</th>
                  <th scope="col" className="px-5 py-3 text-right">Payload</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {filtered.map((resp) => {
                  const datasetLabel =
                    labelByEndpoint.get(`${resp.httpMethod}_${resp.normalizedEndpoint}`) || 'API';
                  const pag = resp.paginationMeta;
                  return (
                    <tr key={resp.id} className="hover:bg-brand-50/35 transition">
                      <td className="px-5 py-3 font-mono text-stone-500 whitespace-nowrap tabular-nums">
                        {new Date(resp.capturedAt).toLocaleTimeString()}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-brand-100 text-brand-950 border border-brand-300">
                          {datasetLabel}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-mono whitespace-nowrap">
                        <span className="px-1.5 py-0.5 rounded font-bold bg-obsidian-900 text-brand-300 text-[10px] mr-1.5">
                          {resp.httpMethod}
                        </span>
                        <span
                          className={`font-bold tabular-nums ${
                            resp.httpStatus >= 200 && resp.httpStatus < 300
                              ? 'text-brand-800'
                              : 'text-amber-700'
                          }`}
                        >
                          {resp.httpStatus}
                        </span>
                      </td>
                      <td
                        className="px-5 py-3 max-w-sm truncate text-stone-800 font-mono text-[11px]"
                        title={resp.url}
                      >
                        {resp.url}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap text-[11px] tabular-nums">
                        {resp.extractedCount !== undefined ? (
                          <span className="font-semibold text-obsidian-900">
                            {resp.extractedCount} items
                          </span>
                        ) : (
                          <span className="text-stone-400">—</span>
                        )}
                        {pag?.currentPage && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-stone-100 text-stone-700 font-mono text-[10px]">
                            p.{pag.currentPage}
                            {pag.totalPages ? `/${pag.totalPages}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 font-mono text-stone-600 whitespace-nowrap tabular-nums">
                        {formatBytes(resp.responseBytes)}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {getStatusBadge(resp.parseStatus)}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setSelectedResponse(resp)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-stone-100 hover:bg-brand-100 text-obsidian-900 text-xs font-semibold rounded-lg transition"
                        >
                          <Eye className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" /> Inspect
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedResponse && (
        <JsonViewerModal
          isOpen={Boolean(selectedResponse)}
          onClose={() => setSelectedResponse(null)}
          title={`${selectedResponse.httpMethod} ${selectedResponse.url} (${formatBytes(
            selectedResponse.responseBytes
          )})`}
          data={selectedResponse.responseBody}
        />
      )}
    </div>
  );
};
