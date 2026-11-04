import React, { useState, useMemo, useEffect } from "react";
import {
  EndpointSource,
  ExtractedRecord,
  RawResponse,
  CaptureSession,
} from "../../shared/types";
import {
  Download,
  FileSpreadsheet,
  FileJson,
  Eye,
  Check,
  Copy,
  Tag,
  FolderDown,
  SlidersHorizontal,
  Edit2,
} from "lucide-react";
import { generateFlattenedCsv, generateRawRecordCsv } from "../../export/csv";
import { generateJsonExport } from "../../export/json";
import { generateJsonlExport } from "../../export/jsonl";
import { generateExportFilename } from "../../export/filenames";
import {
  collectUniqueColumns,
  flattenObject,
  formatColumnHeader,
} from "../../extraction/flatten";
import { activityRepo, sourceRepo } from "../../data/repositories";
import { useToast } from "../components/ToastProvider";

interface Props {
  session: CaptureSession | null;
  sources: EndpointSource[];
  records: ExtractedRecord[];
  rawResponses: RawResponse[];
  initialSourceId?: string;
  onRefreshSources?: () => Promise<void>;
}

type ExportFormat = "csv_flattened" | "csv_raw" | "jsonl" | "json_bundle";

export const Exports: React.FC<Props> = ({
  session,
  sources,
  records,
  rawResponses,
  initialSourceId,
  onRefreshSources,
}) => {
  const { notify } = useToast();

  const [format, setFormat] = useState<ExportFormat>("csv_flattened");
  const [selectedSourceId, setSelectedSourceId] = useState<string>(
    initialSourceId || (sources.length === 1 ? sources[0].id : "all"),
  );
  const [exportLabel, setExportLabel] = useState<string>("");
  const [includeTimeInFilename, setIncludeTimeInFilename] =
    useState<boolean>(false);
  const [headerStyle, setHeaderStyle] = useState<"readable" | "dot">(
    "readable",
  );
  const [arrayFormat, setArrayFormat] = useState<"readable" | "json">(
    "readable",
  );
  const [includeBom, setIncludeBom] = useState(true);
  const [defendFormulaInjection, setDefendFormulaInjection] = useState(true);
  const [nullAsBlank, setNullAsBlank] = useState(true);
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  const [excludedColumns, setExcludedColumns] = useState<Set<string>>(
    new Set(),
  );
  const [downloading, setDownloading] = useState(false);
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (initialSourceId) {
      setSelectedSourceId(initialSourceId);
    }
  }, [initialSourceId]);

  const sourceMap = useMemo(() => {
    const map = new Map<string, EndpointSource>();
    for (const s of sources) {
      map.set(s.id, s);
    }
    return map;
  }, [sources]);

  // Count records per API dataset
  const recordCountsBySource = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of records) {
      counts.set(r.sourceId, (counts.get(r.sourceId) || 0) + 1);
    }
    return counts;
  }, [records]);

  const activeSource =
    selectedSourceId !== "all" ? sourceMap.get(selectedSourceId) || null : null;

  // Sync default semantic label whenever selected dataset changes
  useEffect(() => {
    if (activeSource) {
      setExportLabel(activeSource.label);
    } else if (sources.length === 1) {
      setExportLabel(sources[0].label);
    } else {
      const cleanSessionLabel =
        session?.label?.replace(/\s+capture$/i, "") || "all_datasets";
      setExportLabel(cleanSessionLabel);
    }
    setExcludedColumns(new Set());
  }, [
    selectedSourceId,
    activeSource?.id,
    activeSource?.label,
    sources.length,
    session?.label,
  ]);

  // Filter records by selected API dataset
  const targetRecords = useMemo(() => {
    if (selectedSourceId === "all") return records;
    return records.filter((r) => r.sourceId === selectedSourceId);
  }, [records, selectedSourceId]);

  // Discover available flattened columns for the column selector
  const availableColumns = useMemo(() => {
    if (targetRecords.length === 0) return [];
    const sample = targetRecords.slice(0, 200).map((r) => {
      const base =
        typeof r.rawRecord === "object" && r.rawRecord !== null
          ? (r.rawRecord as Record<string, unknown>)
          : { value: r.rawRecord };
      if (selectedSourceId === "all" && sources.length > 1) {
        const srcLabel = sourceMap.get(r.sourceId)?.label || "Dataset";
        return flattenObject(
          { dataset: srcLabel, ...base },
          "",
          {},
          { arrayFormat },
        );
      }
      return flattenObject(base, "", {}, { arrayFormat });
    });
    return collectUniqueColumns(sample);
  }, [targetRecords, selectedSourceId, sources.length, sourceMap, arrayFormat]);

  const activeColumns = useMemo(
    () => availableColumns.filter((c) => !excludedColumns.has(c)),
    [availableColumns, excludedColumns],
  );

  // Compute clean labeled filename
  const ext = format.startsWith("csv")
    ? "csv"
    : format === "jsonl"
      ? "jsonl"
      : "json";

  const filename = useMemo(() => {
    const site = session?.allowedHostnames[0] || "site";
    const effectiveLabel =
      exportLabel.trim() ||
      activeSource?.label ||
      (selectedSourceId === "all" ? "all_datasets" : "dataset");

    return generateExportFilename({
      label: effectiveLabel,
      site,
      extension: ext,
      includeTime: includeTimeInFilename,
    });
  }, [
    session?.allowedHostnames,
    exportLabel,
    activeSource?.label,
    selectedSourceId,
    ext,
    includeTimeInFilename,
  ]);

  // Build export payload for single / combined view
  const exportPayload = useMemo(() => {
    switch (format) {
      case "csv_flattened": {
        const items = targetRecords.map((r) => {
          const rawObj =
            typeof r.rawRecord === "object" && r.rawRecord !== null
              ? (r.rawRecord as Record<string, unknown>)
              : { value: r.rawRecord };
          if (selectedSourceId === "all" && sources.length > 1) {
            return {
              dataset: sourceMap.get(r.sourceId)?.label || "Dataset",
              ...rawObj,
            };
          }
          return rawObj;
        });
        return generateFlattenedCsv(items, {
          includeBom,
          defendFormulaInjection,
          nullValueRepresentation: nullAsBlank ? "" : "null",
          arrayFormat,
          headerStyle,
          columns: activeColumns.length > 0 ? activeColumns : undefined,
        });
      }
      case "csv_raw": {
        const items = targetRecords.map((r) => {
          const src = sourceMap.get(r.sourceId);
          return {
            id: r.id,
            label: src?.label || exportLabel || "Dataset",
            capturedAt: r.extractedAt,
            source: src
              ? `${src.httpMethod} ${src.normalizedEndpoint}`
              : r.sourceId,
            rawRecord: r.rawRecord,
          };
        });
        return generateRawRecordCsv(items, {
          includeBom,
          defendFormulaInjection,
        });
      }
      case "jsonl": {
        const items = targetRecords.map((r) => {
          if (
            selectedSourceId === "all" &&
            sources.length > 1 &&
            typeof r.rawRecord === "object" &&
            r.rawRecord !== null
          ) {
            return {
              _dataset: sourceMap.get(r.sourceId)?.label || "Dataset",
              ...(r.rawRecord as Record<string, unknown>),
            };
          }
          return r.rawRecord;
        });
        return generateJsonlExport(items);
      }
      case "json_bundle": {
        return generateJsonExport({
          datasetLabel:
            exportLabel.trim() || activeSource?.label || "All Datasets",
          session,
          exportedAt: new Date().toISOString(),
          sources: activeSource ? [activeSource] : sources,
          recordsCount: targetRecords.length,
          rawResponsesCount: rawResponses.length,
          records: targetRecords.map((r) => ({
            ...r,
            datasetLabel: sourceMap.get(r.sourceId)?.label || "Dataset",
          })),
          rawResponses: rawResponses.slice(0, 50),
        });
      }
    }
  }, [
    format,
    targetRecords,
    selectedSourceId,
    sources,
    sourceMap,
    includeBom,
    defendFormulaInjection,
    nullAsBlank,
    arrayFormat,
    headerStyle,
    activeColumns,
    exportLabel,
    activeSource,
    session,
    rawResponses,
  ]);

  const triggerBrowserDownload = (
    content: string,
    downloadName: string,
    mimeType: string,
  ) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getMimeType = () =>
    format.startsWith("csv")
      ? "text/csv;charset=utf-8"
      : format === "jsonl"
        ? "application/x-ndjson;charset=utf-8"
        : "application/json;charset=utf-8";

  const handlePersistSourceLabelIfChanged = async () => {
    if (
      activeSource &&
      exportLabel.trim() &&
      exportLabel.trim() !== activeSource.label
    ) {
      await sourceRepo.updateSource(activeSource.id, {
        label: exportLabel.trim(),
        customLabel: true,
      });
      if (onRefreshSources) {
        await onRefreshSources();
      }
    }
  };

  const handleDownload = async () => {
    if (targetRecords.length === 0) return;
    setDownloading(true);
    try {
      await handlePersistSourceLabelIfChanged();
      triggerBrowserDownload(exportPayload, filename, getMimeType());

      if (session) {
        await activityRepo.logEvent({
          sessionId: session.id,
          actor: "user",
          category: "export",
          message: `Exported "${exportLabel || filename}" (${targetRecords.length} records)`,
          detail: filename,
        });
      }

      notify({
        title: `Exported ${filename}`,
        description: `${targetRecords.length} records saved locally with clean "${exportLabel.trim() || "Dataset"}" labeling.`,
        variant: "success",
        actor: "user",
      });
    } catch (err: any) {
      notify({
        title: "Export failed",
        description: err?.message || "Unable to generate download file.",
        variant: "error",
        actor: "user",
      });
    } finally {
      setTimeout(() => setDownloading(false), 700);
    }
  };

  // Batch export: downloads one cleanly labeled file per API dataset (e.g. customers.csv, medicines.csv, orders.csv)
  const sourcesWithData = useMemo(
    () =>
      sources.filter(
        (s) => s.included && (recordCountsBySource.get(s.id) || 0) > 0,
      ),
    [sources, recordCountsBySource],
  );

  const handleBatchExportEachApi = async () => {
    if (sourcesWithData.length === 0) return;
    setBatchDownloading(true);
    try {
      const site = session?.allowedHostnames[0] || "site";
      const mime = getMimeType();

      for (let i = 0; i < sourcesWithData.length; i++) {
        const src = sourcesWithData[i];
        const srcRecords = records.filter((r) => r.sourceId === src.id);
        const srcFilename = generateExportFilename({
          label: src.label,
          site,
          extension: ext,
          includeTime: includeTimeInFilename,
        });

        let payload = "";
        if (format === "csv_flattened") {
          payload = generateFlattenedCsv(
            srcRecords.map((r) => r.rawRecord),
            {
              includeBom,
              defendFormulaInjection,
              nullValueRepresentation: nullAsBlank ? "" : "null",
              arrayFormat,
              headerStyle,
            },
          );
        } else if (format === "csv_raw") {
          payload = generateRawRecordCsv(
            srcRecords.map((r) => ({
              id: r.id,
              label: src.label,
              capturedAt: r.extractedAt,
              source: `${src.httpMethod} ${src.normalizedEndpoint}`,
              rawRecord: r.rawRecord,
            })),
            { includeBom, defendFormulaInjection },
          );
        } else if (format === "jsonl") {
          payload = generateJsonlExport(srcRecords.map((r) => r.rawRecord));
        } else {
          payload = generateJsonExport({
            datasetLabel: src.label,
            endpoint: `${src.httpMethod} ${src.normalizedEndpoint}`,
            exportedAt: new Date().toISOString(),
            recordsCount: srcRecords.length,
            records: srcRecords.map((r) => r.rawRecord),
          });
        }

        triggerBrowserDownload(payload, srcFilename, mime);
        if (i < sourcesWithData.length - 1) {
          await new Promise((res) => setTimeout(res, 180));
        }
      }

      if (session) {
        await activityRepo.logEvent({
          sessionId: session.id,
          actor: "user",
          category: "export",
          message: `Batch-exported ${sourcesWithData.length} labeled API datasets (${sourcesWithData.map((s) => s.label).join(", ")})`,
        });
      }

      notify({
        title: `Exported ${sourcesWithData.length} Labeled Files`,
        description: `Downloaded separate files for: ${sourcesWithData.map((s) => s.label).join(", ")}.`,
        variant: "success",
        actor: "user",
      });
    } catch (err: any) {
      notify({
        title: "Batch export error",
        description: err?.message || "Could not complete multi-dataset export.",
        variant: "error",
        actor: "user",
      });
    } finally {
      setBatchDownloading(false);
    }
  };

  const handleCopyPreview = async () => {
    if (!exportPayload || targetRecords.length === 0) return;
    try {
      const cleanText = exportPayload.replace(/^\uFEFF/, "");
      await navigator.clipboard.writeText(cleanText);
      setCopied(true);
      notify({
        title: "Copied to clipboard",
        description: `${targetRecords.length} formatted rows copied and ready to paste into Sheets or Excel.`,
        variant: "info",
        actor: "user",
      });
      setTimeout(() => setCopied(false), 1800);
    } catch {
      notify({
        title: "Clipboard unavailable",
        description: "Please use the Download button instead.",
        variant: "warning",
        actor: "user",
      });
    }
  };

  const toggleColumn = (col: string) => {
    setExcludedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        next.delete(col);
      } else {
        // Keep at least 1 column active
        if (availableColumns.length - next.size > 1) {
          next.add(col);
        }
      }
      return next;
    });
  };

  const previewLines = useMemo(() => {
    const clean = exportPayload.replace(/^\uFEFF/, "");
    const lines = clean.split(/\r?\n/).slice(0, 14);
    return lines.join("\n");
  }, [exportPayload]);

  return (
    <div className="space-y-6">
      {/* Exports Header + Batch Export Banner */}
      <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-stone-900 flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-brand-100 border border-brand-300 text-brand-800 flex items-center justify-center">
              <Download className="w-4 h-4" aria-hidden="true" />
            </span>
            Export Labeled API Datasets
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Export clean, human-labeled files named directly after your API
            datasets (e.g.{" "}
            <code className="font-mono text-brand-800 bg-brand-50 px-1.5 py-0.5 rounded">
              customers
            </code>
            ,{" "}
            <code className="font-mono text-brand-800 bg-brand-50 px-1.5 py-0.5 rounded">
              medicines
            </code>
            ,{" "}
            <code className="font-mono text-brand-800 bg-brand-50 px-1.5 py-0.5 rounded">
              orders
            </code>
            ).
          </p>
        </div>

        {sourcesWithData.length > 1 && (
          <button
            type="button"
            onClick={handleBatchExportEachApi}
            disabled={batchDownloading}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-obsidian-900 hover:bg-obsidian-800 text-brand-300 border border-obsidian-700 text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-50"
          >
            <FolderDown className="w-4 h-4 text-brand-400" aria-hidden="true" />
            {batchDownloading
              ? "Exporting Datasets..."
              : `Export All ${sourcesWithData.length} APIs as Separate Labeled Files`}
          </button>
        )}
      </div>

      {/* Step 1: Visual API Dataset Picker Cards */}
      {sources.length > 0 && (
        <section
          aria-label="Choose API Dataset to Export"
          className="bg-white rounded-2xl shadow-xs border border-stone-200 p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-600 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
              1. Select API Dataset to Export
            </h3>
            <span className="text-[11px] text-stone-500">
              Click any discovered API dataset below to export with its semantic
              label
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {sources.map((src) => {
              const count = recordCountsBySource.get(src.id) || 0;
              const isSelected = selectedSourceId === src.id;
              return (
                <button
                  key={src.id}
                  type="button"
                  onClick={() => setSelectedSourceId(src.id)}
                  className={`text-left p-3.5 rounded-xl border transition flex flex-col justify-between gap-2 ${
                    isSelected
                      ? "border-brand-600 bg-brand-50/70 ring-1 ring-brand-500 shadow-xs"
                      : "border-stone-200 bg-stone-50/40 hover:border-stone-300 hover:bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-bold text-sm text-stone-900 truncate">
                      {src.label}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-bold flex-shrink-0 ${
                        isSelected
                          ? "bg-obsidian-900 text-brand-300"
                          : "bg-stone-200/80 text-stone-700"
                      }`}
                    >
                      {count} rows
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-stone-500 truncate">
                    {src.httpMethod}{" "}
                    {src.normalizedEndpoint.replace(/^https?:\/\/[^/]+/, "")}
                  </div>
                </button>
              );
            })}

            {sources.length > 1 && (
              <button
                type="button"
                onClick={() => setSelectedSourceId("all")}
                className={`text-left p-3.5 rounded-xl border transition flex flex-col justify-between gap-2 ${
                  selectedSourceId === "all"
                    ? "border-brand-600 bg-brand-50/70 ring-1 ring-brand-500 shadow-xs"
                    : "border-stone-200 bg-stone-50/40 hover:border-stone-300 hover:bg-white"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-bold text-sm text-stone-900">
                    All Combined
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                      selectedSourceId === "all"
                        ? "bg-obsidian-900 text-brand-300"
                        : "bg-stone-200/80 text-stone-700"
                    }`}
                  >
                    {records.length} rows
                  </span>
                </div>
                <div className="text-[11px] text-stone-500 truncate">
                  Includes a <code className="font-mono">dataset</code> label
                  column
                </div>
              </button>
            )}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Export Label, Format & Readability Options */}
        <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-6 space-y-5 lg:col-span-1">
          {/* Custom Export Label Input */}
          <div>
            <label
              htmlFor="export-dataset-label"
              className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5"
            >
              2. Dataset Label & File Name
            </label>
            <div className="relative">
              <Edit2
                className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              />
              <input
                id="export-dataset-label"
                type="text"
                value={exportLabel}
                onChange={(e) => setExportLabel(e.target.value)}
                placeholder="e.g. Customers, Medicines, Orders..."
                className="w-full pl-8 pr-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-semibold text-stone-900 focus:bg-white focus:outline-none focus:border-brand-600"
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-stone-500">
              <span className="truncate">
                File:{" "}
                <code className="font-mono font-bold text-brand-900">
                  {filename}
                </code>
              </span>
            </div>
            <label className="mt-2 flex items-center gap-2 cursor-pointer text-xs text-stone-600">
              <input
                type="checkbox"
                checked={includeTimeInFilename}
                onChange={(e) => setIncludeTimeInFilename(e.target.checked)}
                className="rounded"
              />
              <span>Include HH-MM-SS timestamp in filename</span>
            </label>
          </div>

          {/* Export Format */}
          <div className="pt-4 border-t border-stone-100">
            <span className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-2">
              3. Choose Export Format
            </span>
            <div
              className="space-y-2"
              role="radiogroup"
              aria-label="Export file format"
            >
              {[
                {
                  id: "csv_flattened",
                  label: "Clean Spreadsheet CSV",
                  desc: "Flattened columns, human-readable headers & arrays",
                  icon: (
                    <FileSpreadsheet
                      className="w-4 h-4 text-brand-700"
                      aria-hidden="true"
                    />
                  ),
                },
                {
                  id: "csv_raw",
                  label: "Raw Audit CSV (Label + JSON)",
                  desc: "Dataset label, timestamp, endpoint, and raw JSON cell",
                  icon: (
                    <FileSpreadsheet
                      className="w-4 h-4 text-stone-600"
                      aria-hidden="true"
                    />
                  ),
                },
                {
                  id: "jsonl",
                  label: "JSON Lines (.jsonl)",
                  desc: "One JSON object per line for Python, BigQuery & ETL",
                  icon: (
                    <FileJson
                      className="w-4 h-4 text-sky-700"
                      aria-hidden="true"
                    />
                  ),
                },
                {
                  id: "json_bundle",
                  label: "Labeled JSON Bundle (.json)",
                  desc: "Dataset metadata, records, and captured sample payloads",
                  icon: (
                    <FileJson
                      className="w-4 h-4 text-teal-700"
                      aria-hidden="true"
                    />
                  ),
                },
              ].map((opt) => {
                const selected = format === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setFormat(opt.id as ExportFormat)}
                    className={`w-full text-left p-3 rounded-xl border transition ${
                      selected
                        ? "border-brand-600 bg-brand-50/60 ring-1 ring-brand-500 shadow-xs"
                        : "border-stone-200 hover:border-stone-300 bg-white"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold text-xs text-stone-900 mb-0.5">
                      {opt.icon}
                      {opt.label}
                    </div>
                    <p className="text-[11px] text-stone-500">{opt.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* CSV Readability & Security Options */}
          {format === "csv_flattened" && (
            <div className="pt-4 border-t border-stone-100 space-y-3">
              <span className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                Spreadsheet Clarity
              </span>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    htmlFor="csv-header-style"
                    className="block text-[11px] font-semibold text-stone-600 mb-1"
                  >
                    Column Headers
                  </label>
                  <select
                    id="csv-header-style"
                    value={headerStyle}
                    onChange={(e) =>
                      setHeaderStyle(e.target.value as "readable" | "dot")
                    }
                    className="w-full px-2.5 py-1.5 bg-stone-50 border border-stone-300 rounded-lg text-xs font-medium text-stone-800"
                  >
                    <option value="readable">Clean Labels</option>
                    <option value="dot">Dot Paths (a.b)</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="csv-array-format"
                    className="block text-[11px] font-semibold text-stone-600 mb-1"
                  >
                    List / Array Cells
                  </label>
                  <select
                    id="csv-array-format"
                    value={arrayFormat}
                    onChange={(e) =>
                      setArrayFormat(e.target.value as "readable" | "json")
                    }
                    className="w-full px-2.5 py-1.5 bg-stone-50 border border-stone-300 rounded-lg text-xs font-medium text-stone-800"
                  >
                    <option value="readable">Readable (a, b)</option>
                    <option value="json">
                      JSON ([&quot;a&quot;,&quot;b&quot;])
                    </option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {format.startsWith("csv") && (
            <div className="pt-4 border-t border-stone-100 space-y-2.5">
              <span className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
                CSV Safety & Compatibility
              </span>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs text-stone-700">
                <input
                  type="checkbox"
                  checked={defendFormulaInjection}
                  onChange={(e) => setDefendFormulaInjection(e.target.checked)}
                  className="rounded mt-0.5"
                />
                <div>
                  <span className="font-semibold block text-stone-800">
                    Formula Injection Defense
                  </span>
                  <span className="text-[11px] text-stone-500">
                    Escapes leading =, +, -, @ characters for Excel/Sheets
                    safety
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs text-stone-700">
                <input
                  type="checkbox"
                  checked={includeBom}
                  onChange={(e) => setIncludeBom(e.target.checked)}
                  className="rounded mt-0.5"
                />
                <div>
                  <span className="font-semibold block text-stone-800">
                    UTF-8 BOM Header
                  </span>
                  <span className="text-[11px] text-stone-500">
                    Preserves accents and international characters in Excel
                  </span>
                </div>
              </label>

              {format === "csv_flattened" && (
                <label className="flex items-start gap-2.5 cursor-pointer text-xs text-stone-700">
                  <input
                    type="checkbox"
                    checked={nullAsBlank}
                    onChange={(e) => setNullAsBlank(e.target.checked)}
                    className="rounded mt-0.5"
                  />
                  <div>
                    <span className="font-semibold block text-stone-800">
                      Blank Empty Cells
                    </span>
                    <span className="text-[11px] text-stone-500">
                      Outputs empty cells instead of literal &quot;null&quot;
                    </span>
                  </div>
                </label>
              )}
            </div>
          )}

          {/* Primary Download Action */}
          <div className="pt-4 border-t border-stone-100 space-y-2">
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading || targetRecords.length === 0}
              className="w-full py-3 px-4 bg-brand-400 hover:bg-brand-300 disabled:opacity-50 text-brand-950 text-xs font-extrabold rounded-xl shadow-xs flex items-center justify-center gap-2 transition"
            >
              {downloading ? (
                <Check className="w-4 h-4 text-brand-950" aria-hidden="true" />
              ) : (
                <Download
                  className="w-4 h-4 text-brand-950"
                  aria-hidden="true"
                />
              )}
              {downloading
                ? "Saved to Downloads!"
                : `Download "${exportLabel.trim() || "Dataset"}" (${targetRecords.length} rows)`}
            </button>
          </div>
        </div>

        {/* Right Column: Column Selector + Live File Preview */}
        <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-6 lg:col-span-2 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-stone-100">
            <div>
              <h3 className="font-bold text-stone-900 text-sm flex items-center gap-2">
                <Eye className="w-4 h-4 text-brand-700" aria-hidden="true" />
                Live Export Preview
              </h3>
              <p className="text-xs text-stone-500 mt-0.5">
                Target filename:{" "}
                <code className="font-mono text-brand-900 bg-brand-50 border border-brand-200 px-1.5 py-0.5 rounded font-bold">
                  {filename}
                </code>
              </p>
            </div>

            <div className="flex items-center gap-2">
              {format === "csv_flattened" && availableColumns.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowColumnSelector((v) => !v)}
                  aria-expanded={showColumnSelector}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                    showColumnSelector
                      ? "bg-obsidian-900 text-brand-300 border-obsidian-800"
                      : "bg-stone-50 hover:bg-stone-100 text-stone-700 border-stone-200"
                  }`}
                >
                  <SlidersHorizontal
                    className="w-3.5 h-3.5"
                    aria-hidden="true"
                  />
                  Columns ({activeColumns.length}/{availableColumns.length})
                </button>
              )}

              <button
                type="button"
                onClick={handleCopyPreview}
                disabled={targetRecords.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-stone-50 hover:bg-stone-100 disabled:opacity-50 text-stone-700 border border-stone-200 rounded-xl text-xs font-semibold transition"
              >
                {copied ? (
                  <Check
                    className="w-3.5 h-3.5 text-brand-700"
                    aria-hidden="true"
                  />
                ) : (
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy All"}
              </button>
            </div>
          </div>

          {/* Interactive Column Picker */}
          {showColumnSelector &&
            format === "csv_flattened" &&
            availableColumns.length > 0 && (
              <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-stone-700">
                    Choose Exported Columns ({activeColumns.length} selected)
                  </span>
                  <button
                    type="button"
                    onClick={() => setExcludedColumns(new Set())}
                    className="text-[11px] font-semibold text-brand-800 hover:underline"
                  >
                    Select All Columns
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                  {availableColumns.map((col) => {
                    const included = !excludedColumns.has(col);
                    return (
                      <label
                        key={col}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs cursor-pointer transition ${
                          included
                            ? "bg-white border-brand-400 text-stone-900 font-medium"
                            : "bg-stone-100 border-stone-200 text-stone-400 line-through"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => toggleColumn(col)}
                          className="rounded"
                        />
                        <span>{formatColumnHeader(col, headerStyle)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

          {/* Obsidian Code Preview */}
          <div className="flex-1 bg-obsidian-950 p-4 rounded-xl border border-obsidian-800 overflow-auto font-mono text-xs text-stone-200 max-h-[480px]">
            {targetRecords.length === 0 ? (
              <div className="text-stone-400 text-center py-14 space-y-1">
                <p className="font-sans font-semibold text-stone-300">
                  No extracted records in this dataset yet
                </p>
                <p className="font-sans text-xs text-stone-400">
                  Start capture or run Multi-Page Fetch to populate records for
                  export.
                </p>
              </div>
            ) : (
              <pre className="whitespace-pre overflow-x-auto leading-relaxed">
                {previewLines}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
