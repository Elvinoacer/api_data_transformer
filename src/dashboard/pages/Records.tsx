import React, { useState, useMemo } from 'react';
import { ExtractedRecord, EndpointSource } from '../../shared/types';
import { Database, Search, Eye, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { collectUniqueColumns } from '../../extraction/flatten';
import { JsonViewerModal } from '../components/JsonViewerModal';

interface Props {
  records: ExtractedRecord[];
  sources: EndpointSource[];
}

export const Records: React.FC<Props> = ({ records, sources }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState<string>('all');
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [inspectRecord, setInspectRecord] = useState<ExtractedRecord | null>(null);

  // Filter records
  const filteredRecords = useMemo(() => {
    return records.filter((rec) => {
      if (selectedSourceId !== 'all' && rec.sourceId !== selectedSourceId) {
        return false;
      }
      if (!searchTerm) return true;

      const lower = searchTerm.toLowerCase();
      if (rec.identityKey.toLowerCase().includes(lower)) return true;

      if (rec.normalizedFields) {
        for (const val of Object.values(rec.normalizedFields)) {
          if (String(val).toLowerCase().includes(lower)) return true;
        }
      }
      return false;
    });
  }, [records, selectedSourceId, searchTerm]);

  // Compute available columns across records
  const columns = useMemo(() => {
    const sample = filteredRecords.slice(0, 100).map((r) => r.normalizedFields || {});
    return collectUniqueColumns(sample).slice(0, 8); // Top 8 columns for clean table layout
  }, [filteredRecords]);

  // Pagination
  const totalPages = Math.ceil(filteredRecords.length / pageSize) || 1;
  const paginatedRecords = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [filteredRecords, page, pageSize]);

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Database className="w-5 h-5 text-indigo-600" />
            Consolidated Entity Records ({records.length})
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Materialized dataset deduplicated according to each source's identity rule and consolidation policy.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Source Filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-slate-400" />
            <select
              value={selectedSourceId}
              onChange={(e) => {
                setSelectedSourceId(e.target.value);
                setPage(1);
              }}
              className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 focus:ring-1 focus:ring-indigo-500"
            >
              <option value="all">All Sources ({sources.length})</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.httpMethod} {s.normalizedEndpoint.split('/').slice(-2).join('/')}
                </option>
              ))}
            </select>
          </div>

          {/* Search Box */}
          <div className="relative w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search records..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(1);
              }}
              className="w-full pl-9 pr-4 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:bg-white"
            />
          </div>
        </div>
      </div>

      {/* Table & Pagination */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 overflow-hidden">
        {filteredRecords.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            {records.length === 0
              ? 'No records extracted yet. Permitted API items will be materialized here.'
              : 'No records match your filters.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-700">
                <thead className="bg-slate-50 text-[11px] font-semibold uppercase text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3">Identity Key</th>
                    {columns.map((col) => (
                      <th key={col} className="px-6 py-3 truncate max-w-[150px]">
                        {col}
                      </th>
                    ))}
                    <th className="px-6 py-3">Version</th>
                    <th className="px-6 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedRecords.map((rec) => (
                    <tr key={rec.id} className="hover:bg-slate-50/80 transition">
                      <td className="px-6 py-3 font-mono font-bold text-indigo-700 whitespace-nowrap">
                        {rec.identityKey}
                      </td>
                      {columns.map((col) => {
                        const val = rec.normalizedFields?.[col];
                        return (
                          <td key={col} className="px-6 py-3 max-w-[180px] truncate text-slate-800" title={String(val ?? '')}>
                            {val !== undefined && val !== null ? String(val) : <span className="text-slate-300">—</span>}
                          </td>
                        );
                      })}
                      <td className="px-6 py-3 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                          v{rec.version}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => setInspectRecord(rec)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded transition"
                        >
                          <Eye className="w-3.5 h-3.5 text-indigo-600" /> Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Toolbar */}
            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50/60 flex items-center justify-between text-xs text-slate-600">
              <span>
                Showing {Math.min((page - 1) * pageSize + 1, filteredRecords.length)} to{' '}
                {Math.min(page * pageSize, filteredRecords.length)} of {filteredRecords.length} records
              </span>

              <div className="flex items-center gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="p-1.5 bg-white border border-slate-200 rounded text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="font-semibold text-slate-800">
                  Page {page} of {totalPages}
                </span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="p-1.5 bg-white border border-slate-200 rounded text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Inspect Record Modal */}
      {inspectRecord && (
        <JsonViewerModal
          isOpen={Boolean(inspectRecord)}
          onClose={() => setInspectRecord(null)}
          title={`Entity Provenance: Key ${inspectRecord.identityKey} (Version ${inspectRecord.version})`}
          data={{
            provenance: {
              recordId: inspectRecord.id,
              sourceId: inspectRecord.sourceId,
              identityKey: inspectRecord.identityKey,
              extractedAt: inspectRecord.extractedAt,
              latestResponseId: inspectRecord.latestResponseId,
              version: inspectRecord.version,
            },
            rawRecord: inspectRecord.rawRecord,
            normalizedFields: inspectRecord.normalizedFields,
          }}
        />
      )}
    </div>
  );
};
