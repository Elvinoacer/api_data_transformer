import React, { useState } from 'react';
import { RawResponse } from '../../shared/types';
import { FileCode2, Search, Eye, CheckCircle2, AlertOctagon, Ban, Clock } from 'lucide-react';
import { JsonViewerModal } from '../components/JsonViewerModal';

interface Props {
  responses: RawResponse[];
}

export const Responses: React.FC<Props> = ({ responses }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedResponse, setSelectedResponse] = useState<RawResponse | null>(null);

  const filtered = responses.filter(
    (r) =>
      r.url.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.normalizedEndpoint.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.httpMethod.toLowerCase().includes(searchTerm.toLowerCase())
  );

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
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Parsed
          </span>
        );
      case 'invalid_json':
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">
            <AlertOctagon className="w-3 h-3 text-rose-600" /> Invalid JSON
          </span>
        );
      case 'excluded':
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-full">
            <Ban className="w-3 h-3 text-slate-500" /> Excluded
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
            <Clock className="w-3 h-3 text-amber-600" /> Pending
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Responses Header & Search */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <FileCode2 className="w-5 h-5 text-indigo-600" />
            Captured Raw API Responses ({responses.length})
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Every eligible HTTP response body is preserved append-only before schema inference to guarantee complete auditability.
          </p>
        </div>

        <div className="relative w-full md:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by URL or endpoint..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:bg-white"
          />
        </div>
      </div>

      {/* Responses Table */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            {responses.length === 0
              ? 'No raw responses captured yet. Navigate the target site to capture traffic.'
              : 'No responses match your search query.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3">Timestamp</th>
                  <th className="px-6 py-3">Method</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Captured URL</th>
                  <th className="px-6 py-3">Payload Size</th>
                  <th className="px-6 py-3">Parse Status</th>
                  <th className="px-6 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {filtered.map((resp) => (
                  <tr key={resp.id} className="hover:bg-slate-50/80 transition">
                    <td className="px-6 py-3 text-slate-500 whitespace-nowrap">
                      {new Date(resp.capturedAt).toLocaleTimeString()}
                    </td>
                    <td className="px-6 py-3">
                      <span className="px-1.5 py-0.5 rounded font-bold bg-slate-100 text-slate-800 text-[10px]">
                        {resp.httpMethod}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <span
                        className={`font-bold ${
                          resp.httpStatus >= 200 && resp.httpStatus < 300
                            ? 'text-emerald-600'
                            : 'text-amber-600'
                        }`}
                      >
                        {resp.httpStatus}
                      </span>
                    </td>
                    <td className="px-6 py-3 max-w-md truncate text-slate-800 font-sans font-medium" title={resp.url}>
                      {resp.url}
                    </td>
                    <td className="px-6 py-3 text-slate-600 whitespace-nowrap">
                      {formatBytes(resp.responseBytes)}
                    </td>
                    <td className="px-6 py-3 font-sans whitespace-nowrap">
                      {getStatusBadge(resp.parseStatus)}
                    </td>
                    <td className="px-6 py-3 text-right font-sans whitespace-nowrap">
                      <button
                        onClick={() => setSelectedResponse(resp)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded transition"
                      >
                        <Eye className="w-3.5 h-3.5 text-indigo-600" /> Inspect JSON
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* JSON Viewer Modal */}
      {selectedResponse && (
        <JsonViewerModal
          isOpen={Boolean(selectedResponse)}
          onClose={() => setSelectedResponse(null)}
          title={`Raw Response: ${selectedResponse.url} (${formatBytes(selectedResponse.responseBytes)})`}
          data={selectedResponse.responseBody}
        />
      )}
    </div>
  );
};
