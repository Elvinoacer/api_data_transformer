import React, { useState, useMemo, useId } from "react";
import { ExtractedRecord, EndpointSource } from "../../shared/types";
import {
  Database,
  Search,
  Eye,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Download,
  Tag,
  Eraser,
} from "lucide-react";
import {
  collectUniqueColumns,
  flattenObject,
  formatColumnHeader,
} from "../../extraction/flatten";
import { JsonViewerModal } from "../components/JsonViewerModal";

interface Props {
  records: ExtractedRecord[];
  sources: EndpointSource[];
  initialSourceFilter?: string;
  onExportFiltered: (sourceId: string) => void;
  onClearTabData?: () => void;
}

export const Records: React.FC<Props> = ({
  records,
  sources,
  initialSourceFilter = "all",
  onExportFiltered,
  onClearTabData,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSourceId, setSelectedSourceId] =
    useState<string>(initialSourceFilter);
  const [readableMode, setReadableMode] = useState<boolean>(true);
  const [showColumnPicker, setShowColumnPicker] = useState<boolean>(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [inspectRecord, setInspectRecord] = useState<ExtractedRecord | null>(
    null,
  );
  const tableCaptionId = useId();

  React.useEffect(() => {
    setSelectedSourceId(initialSourceFilter);
    setPage(1);
  }, [initialSourceFilter]);

  const sourceMap = useMemo(
    () => new Map(sources.map((s) => [s.id, s])),
    [sources],
  );

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of records) {
      counts.set(r.sourceId, (counts.get(r.sourceId) || 0) + 1);
    }
    return counts;
  }, [records]);

  const filteredRecords = useMemo(() => {
    return records.filter((rec) => {
      if (selectedSourceId !== "all" && rec.sourceId !== selectedSourceId) {
        return false;
      }
      if (!searchTerm.trim()) return true;

      const lower = searchTerm.toLowerCase();
      if (rec.identityKey.toLowerCase().includes(lower)) return true;

      const srcLabel = sourceMap.get(rec.sourceId)?.label || "";
      if (srcLabel.toLowerCase().includes(lower)) return true;

      if (rec.normalizedFields) {
        for (const val of Object.values(rec.normalizedFields)) {
          if (
            String(val ?? "")
              .toLowerCase()
              .includes(lower)
          )
            return true;
        }
      }
      return false;
    });
  }, [records, selectedSourceId, searchTerm, sourceMap]);

  // Compute all discovered columns across filtered dataset
  const allColumns = useMemo(() => {
    const sample = filteredRecords
      .slice(0, 150)
      .map((r) =>
        typeof r.rawRecord === "object" && r.rawRecord !== null
          ? flattenObject(
              r.rawRecord,
              "",
              {},
              { arrayFormat: readableMode ? "readable" : "json" },
            )
          : r.normalizedFields || {},
      );
    return collectUniqueColumns(sample);
  }, [filteredRecords, readableMode]);

  const visibleColumns = useMemo(() => {
    const active = allColumns.filter((c) => !hiddenColumns.has(c));
    return active.slice(0, 12);
  }, [allColumns, hiddenColumns]);

  const toggleColumn = (col: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const totalPages = Math.ceil(filteredRecords.length / pageSize) || 1;
  const paginatedRecords = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [filteredRecords, page, pageSize]);

  const renderCellValue = (val: unknown) => {
    if (val === undefined || val === null || val === "") {
      return <span className="text-stone-300">—</span>;
    }
    if (typeof val === "boolean") {
      return (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${
            val
              ? "bg-brand-100 text-brand-900 border border-brand-300"
              : "bg-stone-100 text-stone-600 border border-stone-200"
          }`}
        >
          {val ? "True" : "False"}
        </span>
      );
    }
    if (typeof val === "number") {
      return (
        <span className="font-mono font-semibold text-obsidian-900 tabular-nums">
          {val}
        </span>
      );
    }
    return <span>{String(val)}</span>;
  };

  return (
    <div className="space-y-5">
      {/* Header & Search */}
      <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-extrabold text-obsidian-900 flex items-center gap-2">
              <Database className="w-5 h-5 text-brand-700" aria-hidden="true" />
              Extracted & Deduplicated Data ({filteredRecords.length})
            </h2>
            <p className="text-xs text-stone-600 mt-1">
              Clean, normalized rows consolidated across all visited API pages.
              Switch between labeled datasets below.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Readable Formatting Toggle */}
            <button
              type="button"
              aria-pressed={readableMode}
              onClick={() => setReadableMode(!readableMode)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition ${
                readableMode
                  ? "bg-brand-50 text-brand-950 border-brand-300"
                  : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"
              }`}
            >
              {readableMode ? "Clean Labels: On" : "Raw Dot-Paths"}
            </button>

            {/* Column Picker Toggle */}
            {allColumns.length > 0 && (
              <button
                type="button"
                aria-expanded={showColumnPicker}
                onClick={() => setShowColumnPicker(!showColumnPicker)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-stone-50 border border-stone-200 rounded-xl text-xs font-semibold text-obsidian-900 transition"
              >
                <SlidersHorizontal
                  className="w-3.5 h-3.5 text-brand-700"
                  aria-hidden="true"
                />
                Columns ({visibleColumns.length}/{allColumns.length})
              </button>
            )}

            {/* Quick Export Current Dataset */}
            <button
              type="button"
              disabled={filteredRecords.length === 0}
              onClick={() => onExportFiltered(selectedSourceId)}
              className="btn-lime inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-brand-400 hover:bg-brand-300 disabled:opacity-50 text-obsidian-950 border border-brand-500 rounded-xl text-xs font-bold shadow-lime-glow transition"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              Export View
            </button>

            {records.length > 0 && onClearTabData && (
              <button
                type="button"
                onClick={onClearTabData}
                title="Clear all extracted records and captured data for this tab"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-amber-50 text-stone-700 hover:text-amber-900 border border-stone-200 hover:border-amber-300 rounded-xl text-xs font-semibold shadow-xs transition"
              >
                <Eraser className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />
                Clear Tab Data
              </button>
            )}
          </div>
        </div>

        {/* Labeled Dataset Filter Pills + Search */}
        <div className="pt-3 border-t border-stone-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              aria-pressed={selectedSourceId === "all"}
              onClick={() => {
                setSelectedSourceId("all");
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition border ${
                selectedSourceId === "all"
                  ? "bg-obsidian-900 text-brand-300 border-obsidian-900"
                  : "bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100"
              }`}
            >
              All Datasets ({records.length})
            </button>
            {sources.map((src) => {
              const cnt = sourceCounts.get(src.id) || 0;
              const active = selectedSourceId === src.id;
              return (
                <button
                  key={src.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setSelectedSourceId(src.id);
                    setPage(1);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition border ${
                    active
                      ? "bg-obsidian-900 text-brand-300 border-obsidian-900"
                      : "bg-stone-50 text-obsidian-900 border-stone-200 hover:border-brand-400"
                  }`}
                >
                  <Tag
                    className={`w-3 h-3 ${active ? "text-brand-400" : "text-brand-700"}`}
                    aria-hidden="true"
                  />
                  {src.label}
                  <span className="opacity-75 font-mono text-[11px] tabular-nums">
                    ({cnt})
                  </span>
                </button>
              );
            })}
          </div>

          <div className="relative w-full md:w-64">
            <Search
              className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <label htmlFor="records-search-input" className="visually-hidden">
              Search extracted records
            </label>
            <input
              id="records-search-input"
              type="text"
              placeholder="Search values, IDs, labels..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(1);
              }}
              className="w-full pl-9 pr-4 py-1.5 bg-stone-50 border border-stone-300 rounded-xl text-xs focus:bg-white text-obsidian-900"
            />
          </div>
        </div>

        {/* Optional Column Checklist Drawer */}
        {showColumnPicker && allColumns.length > 0 && (
          <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-obsidian-900">
                Visible Table Columns
              </span>
              <button
                type="button"
                onClick={() => setHiddenColumns(new Set())}
                className="text-brand-800 hover:underline font-semibold"
              >
                Show All
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {allColumns.map((col) => {
                const checked = !hiddenColumns.has(col);
                return (
                  <label
                    key={col}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-stone-200 rounded-lg text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleColumn(col)}
                    />
                    <span className="font-mono text-[11px] text-obsidian-900">
                      {col}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Accessible Responsive Data Table */}
      <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 overflow-hidden">
        {filteredRecords.length === 0 ? (
          <div className="p-12 text-center text-stone-500 text-xs">
            {records.length === 0
              ? "No extracted records yet. Browse your target website tab to materialize API entities."
              : "No records match your current search or dataset filter."}
          </div>
        ) : (
          <>
            <div
              tabIndex={0}
              role="region"
              aria-labelledby={tableCaptionId}
              className="table-wrapper max-h-[62vh]"
            >
              <table className="w-full text-left text-xs text-obsidian-900">
                <caption id={tableCaptionId} className="visually-hidden">
                  Extracted API records table ({filteredRecords.length} items)
                </caption>
                <thead className="bg-stone-100/95 backdrop-blur-xs text-[11px] font-bold uppercase text-stone-600 border-b border-stone-200">
                  <tr>
                    <th
                      scope="col"
                      className="px-4 py-3 bg-stone-100 whitespace-nowrap"
                    >
                      Identity Key
                    </th>
                    {selectedSourceId === "all" && (
                      <th scope="col" className="px-4 py-3 whitespace-nowrap">
                        Dataset
                      </th>
                    )}
                    {visibleColumns
                      .filter((c) => c !== "id")
                      .map((col) => (
                        <th
                          key={col}
                          scope="col"
                          className="px-4 py-3 truncate max-w-[180px] whitespace-nowrap"
                          title={col}
                        >
                          {formatColumnHeader(
                            col,
                            readableMode ? "readable" : "dot",
                          )}
                        </th>
                      ))}
                    <th scope="col" className="px-4 py-3 whitespace-nowrap">
                      Rev
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right whitespace-nowrap"
                    >
                      Inspect
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {paginatedRecords.map((rec) => {
                    const rowData =
                      typeof rec.rawRecord === "object" &&
                      rec.rawRecord !== null
                        ? flattenObject(
                            rec.rawRecord,
                            "",
                            {},
                            {
                              arrayFormat: readableMode ? "readable" : "json",
                            },
                          )
                        : rec.normalizedFields || {};
                    const srcLabel =
                      sourceMap.get(rec.sourceId)?.label || "API";

                    return (
                      <tr
                        key={rec.id}
                        className="hover:bg-brand-50/35 transition"
                      >
                        <th
                          scope="row"
                          className="px-4 py-3 font-mono font-bold text-brand-900 bg-white whitespace-nowrap border-r border-stone-100"
                        >
                          {rec.identityKey}
                        </th>
                        {selectedSourceId === "all" && (
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-brand-100 text-brand-950 border border-brand-300">
                              {srcLabel}
                            </span>
                          </td>
                        )}
                        {visibleColumns
                          .filter((c) => c !== "id")
                          .map((col) => {
                            const val = rowData[col];
                            return (
                              <td
                                key={col}
                                className="px-4 py-3 max-w-[220px] truncate text-stone-800"
                                title={
                                  val !== undefined && val !== null
                                    ? String(val)
                                    : ""
                                }
                              >
                                {renderCellValue(val)}
                              </td>
                            );
                          })}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-stone-100 text-stone-700 tabular-nums">
                            v{rec.version}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setInspectRecord(rec)}
                            aria-label={`Inspect JSON for ${rec.identityKey}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1 bg-stone-100 hover:bg-brand-100 text-obsidian-900 text-xs font-semibold rounded-lg transition"
                          >
                            <Eye
                              className="w-3.5 h-3.5 text-brand-700"
                              aria-hidden="true"
                            />{" "}
                            JSON
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Footer */}
            <div className="px-6 py-3.5 border-t border-stone-200 bg-stone-50/70 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-stone-600">
              <span className="tabular-nums">
                Showing{" "}
                <strong>
                  {Math.min((page - 1) * pageSize + 1, filteredRecords.length)}
                </strong>
                –
                <strong>
                  {Math.min(page * pageSize, filteredRecords.length)}
                </strong>{" "}
                of <strong>{filteredRecords.length}</strong> unique records
              </span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous table page"
                  className="p-1.5 bg-white border border-stone-300 rounded-lg text-obsidian-900 hover:bg-stone-100 disabled:opacity-40"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <span className="font-bold text-obsidian-900 tabular-nums px-2">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next table page"
                  className="p-1.5 bg-white border border-stone-300 rounded-lg text-obsidian-900 hover:bg-stone-100 disabled:opacity-40"
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
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
          title={`${
            sourceMap.get(inspectRecord.sourceId)?.label || "Entity"
          } — Key: ${inspectRecord.identityKey} (v${inspectRecord.version})`}
          data={{
            datasetLabel:
              sourceMap.get(inspectRecord.sourceId)?.label || "API Dataset",
            provenance: {
              recordId: inspectRecord.id,
              sourceId: inspectRecord.sourceId,
              identityKey: inspectRecord.identityKey,
              extractedAt: inspectRecord.extractedAt,
              latestResponseId: inspectRecord.latestResponseId,
              version: inspectRecord.version,
            },
            rawRecord: inspectRecord.rawRecord,
            flattenedFields: inspectRecord.normalizedFields,
          }}
        />
      )}
    </div>
  );
};
