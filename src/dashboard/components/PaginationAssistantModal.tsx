import React, { useState, useEffect } from "react";
import { ModalDialog } from "./ModalDialog";
import {
  AutoPaginateConfig,
  AutoPaginateMode,
  AutoPaginateState,
  CaptureStatus,
  EndpointSource,
} from "../../shared/types";
import { getMissingPages } from "../../extraction/pagination-detector";
import {
  MousePointerClick,
  Link2,
  ArrowDownCircle,
  Play,
  Square,
  Loader2,
  CheckCircle2,
  Sparkles,
} from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  sessionId?: string;
  status: CaptureStatus;
  sources: EndpointSource[];
  initialSourceId?: string;
  autoPaginateState?: AutoPaginateState;
  onStartAutoPaginate: (config: AutoPaginateConfig) => Promise<void>;
  onStopAutoPaginate: () => Promise<void>;
}

export const PaginationAssistantModal: React.FC<Props> = ({
  isOpen,
  onClose,
  sessionId,
  status,
  sources,
  initialSourceId,
  autoPaginateState,
  onStartAutoPaginate,
  onStopAutoPaginate,
}) => {
  const [selectedSourceId, setSelectedSourceId] = useState<string>(
    initialSourceId || sources[0]?.id || "",
  );
  const [mode, setMode] = useState<AutoPaginateMode>("dom_click");
  const [delaySeconds, setDelaySeconds] = useState<number>(1.8);
  const [maxPages, setMaxPages] = useState<number>(15);
  const [customSelector, setCustomSelector] = useState<string>("");

  useEffect(() => {
    if (initialSourceId && sources.some((s) => s.id === initialSourceId)) {
      setSelectedSourceId(initialSourceId);
    } else if (
      sources.length > 0 &&
      !sources.some((s) => s.id === selectedSourceId)
    ) {
      setSelectedSourceId(sources[0].id);
    } else if (sources.length === 0 && selectedSourceId !== "") {
      setSelectedSourceId("");
    }
  }, [initialSourceId, sources, selectedSourceId]);

  const selectedSource =
    sources.find((s) => s.id === selectedSourceId) || sources[0];
  const pag = selectedSource?.pagination;
  const missingPages = getMissingPages(pag);
  const isRunning =
    autoPaginateState?.status === "running" ||
    autoPaginateState?.status === "stopping";
  const canUseApiFetch = Boolean(
    pag &&
    (pag.pageParamName || pag.nextUrl || pag.strategy === "page") &&
    selectedSource?.httpMethod === "GET",
  );

  // Recommend remaining pages count automatically when known
  useEffect(() => {
    if (missingPages.length > 0) {
      setMaxPages(Math.min(Math.max(missingPages.length, 5), 100));
    } else if (pag?.totalPages && pag.totalPages > 1) {
      setMaxPages(Math.min(pag.totalPages, 100));
    }
  }, [selectedSourceId]);

  const handleStart = async () => {
    if (!sessionId) return;
    await onStartAutoPaginate({
      sessionId,
      sourceId: selectedSource?.id || selectedSourceId || undefined,
      mode,
      delayMs: Math.round(delaySeconds * 1000),
      maxPages,
      customSelector: customSelector.trim() || undefined,
    });
  };

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Multi-Page API Fetch Assistant"
      subtitle="Automatically step through remaining API pages in your target tab while preserving authentication and deduplicating records."
      maxWidthClass="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-xl transition"
          >
            Close
          </button>

          {isRunning ? (
            <button
              type="button"
              onClick={onStopAutoPaginate}
              className="inline-flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl shadow-sm transition"
            >
              <Square className="w-3.5 h-3.5" aria-hidden="true" />
              Stop Auto-Pagination
            </button>
          ) : (
            <button
              type="button"
              disabled={status !== "recording" || !sessionId}
              onClick={handleStart}
              className="btn-lime inline-flex items-center gap-2 px-5 py-2 bg-brand-400 hover:bg-brand-300 text-obsidian-950 border border-brand-500 text-xs font-bold rounded-xl shadow-lime-glow transition disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
              Fetch Remaining Pages
            </button>
          )}
        </>
      }
    >
      <div className="p-6 space-y-5">
        {status !== "recording" && (
          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 font-medium">
            Capture must be actively <strong>Recording</strong> to fetch
            additional pages. Resume or start capture first.
          </div>
        )}

        {/* Live Progress Banner when running or recently completed */}
        {autoPaginateState && autoPaginateState.status !== "idle" && (
          <div
            className={`p-4 rounded-xl border ${
              isRunning
                ? "bg-obsidian-900 text-white border-obsidian-800"
                : "bg-brand-50 border-brand-300 text-obsidian-900"
            }`}
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="flex items-center gap-2 text-xs font-bold">
                {isRunning ? (
                  <Loader2
                    className="w-4 h-4 text-brand-400 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <CheckCircle2
                    className="w-4 h-4 text-brand-700"
                    aria-hidden="true"
                  />
                )}
                <span>{autoPaginateState.message}</span>
              </div>
              <span
                className={`text-xs font-mono font-bold tabular-nums px-2 py-0.5 rounded-md ${
                  isRunning
                    ? "bg-brand-400 text-obsidian-950"
                    : "bg-brand-200 text-brand-950"
                }`}
              >
                +
                {Math.max(
                  0,
                  autoPaginateState.currentUniqueRecords -
                    autoPaginateState.initialUniqueRecords,
                )}{" "}
                unique
              </span>
            </div>
            {autoPaginateState.maxPages > 0 && (
              <progress
                value={autoPaginateState.pagesAttempted}
                max={autoPaginateState.maxPages}
                className="w-full h-2 rounded-full overflow-hidden"
              />
            )}
          </div>
        )}

        {/* Target API Source Selector */}
        {sources.length > 0 && (
          <div>
            <label
              htmlFor="paginate-source-select"
              className="block text-xs font-bold text-obsidian-900 mb-1.5"
            >
              1. Target API Dataset
            </label>
            <select
              id="paginate-source-select"
              value={selectedSourceId}
              onChange={(e) => setSelectedSourceId(e.target.value)}
              className="w-full px-3.5 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-semibold text-obsidian-900"
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.httpMethod} {s.normalizedEndpoint} (
                  {s.pagination?.totalPages
                    ? `${s.pagination.observedPages.length}/${s.pagination.totalPages} pages observed`
                    : `${s.observedCount} responses`}
                  )
                </option>
              ))}
            </select>

            {pag &&
              (pag.totalPages ||
                pag.totalRecords ||
                pag.observedPages.length > 0) && (
                <div className="mt-2.5 p-3 rounded-xl bg-brand-50/70 border border-brand-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 text-brand-950">
                    <Sparkles
                      className="w-4 h-4 text-brand-700"
                      aria-hidden="true"
                    />
                    <span>
                      Observed pages:{" "}
                      <strong className="font-mono">
                        {pag.observedPages.length > 0
                          ? pag.observedPages.join(", ")
                          : "1"}
                      </strong>
                      {pag.totalPages ? ` of ${pag.totalPages}` : ""}
                      {pag.totalRecords
                        ? ` (${pag.totalRecords} total items reported by API)`
                        : ""}
                    </span>
                  </div>
                  {missingPages.length > 0 && (
                    <span className="font-mono text-[11px] font-bold bg-white border border-brand-300 text-brand-900 px-2 py-0.5 rounded-md">
                      Missing: {missingPages.slice(0, 8).join(", ")}
                      {missingPages.length > 8 ? "…" : ""}
                    </span>
                  )}
                </div>
              )}
          </div>
        )}

        {/* Strategy Selection */}
        <div>
          <span className="block text-xs font-bold text-obsidian-900 mb-2">
            2. How Should Pages Be Fetched?
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {[
              {
                id: "dom_click" as AutoPaginateMode,
                title: "Auto-Click Next",
                desc: "Clicks the website’s Next / Load More button page by page. Works with cursors, POST & SPAs.",
                icon: (
                  <MousePointerClick className="w-4 h-4" aria-hidden="true" />
                ),
                disabled: false,
              },
              {
                id: "api_fetch" as AutoPaginateMode,
                title: "Direct API Pages",
                desc: canUseApiFetch
                  ? "Requests remaining ?page= / next URLs directly inside the tab."
                  : "Available when a GET endpoint uses ?page=, ?offset=, or next links.",
                icon: <Link2 className="w-4 h-4" aria-hidden="true" />,
                disabled: !canUseApiFetch,
              },
              {
                id: "scroll" as AutoPaginateMode,
                title: "Infinite Scroll",
                desc: "Scrolls downward smoothly to trigger lazy-loaded feed responses.",
                icon: (
                  <ArrowDownCircle className="w-4 h-4" aria-hidden="true" />
                ),
                disabled: false,
              },
            ].map((opt) => {
              const active = mode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={opt.disabled}
                  onClick={() => setMode(opt.id)}
                  aria-pressed={active}
                  className={`text-left p-3.5 rounded-xl border transition flex flex-col justify-between ${
                    opt.disabled
                      ? "opacity-45 cursor-not-allowed border-stone-200 bg-stone-50"
                      : active
                        ? "border-brand-600 bg-brand-50/80 ring-1 ring-brand-600"
                        : "border-stone-200 hover:border-stone-300 bg-white"
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2 font-bold text-xs text-obsidian-900 mb-1">
                      <span
                        className={active ? "text-brand-700" : "text-stone-500"}
                      >
                        {opt.icon}
                      </span>
                      {opt.title}
                    </div>
                    <p className="text-[11px] text-stone-600 leading-relaxed">
                      {opt.desc}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Pacing & Safety Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <div>
            <label
              htmlFor="paginate-delay-input"
              className="block text-xs font-bold text-obsidian-900 mb-1"
            >
              Polite Delay Between Pages ({delaySeconds.toFixed(1)}s)
            </label>
            <input
              id="paginate-delay-input"
              type="range"
              min="0.8"
              max="5.0"
              step="0.2"
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-[10px] text-stone-500 font-mono">
              <span>0.8s (Fast)</span>
              <span>2.0s (Safe)</span>
              <span>5.0s (Gentle)</span>
            </div>
          </div>

          <div>
            <label
              htmlFor="paginate-max-pages"
              className="block text-xs font-bold text-obsidian-900 mb-1"
            >
              Max Pages to Fetch (Safety Cap)
            </label>
            <input
              id="paginate-max-pages"
              type="number"
              min={1}
              max={200}
              value={maxPages}
              onChange={(e) =>
                setMaxPages(Math.max(1, parseInt(e.target.value || "10", 10)))
              }
              className="w-full px-3 py-1.5 bg-stone-50 border border-stone-300 rounded-xl text-xs font-mono font-semibold text-obsidian-900"
            />
          </div>
        </div>

        {mode === "dom_click" && (
          <div>
            <label
              htmlFor="paginate-custom-selector"
              className="block text-xs font-bold text-obsidian-900 mb-1"
            >
              Optional Custom "Next" Button CSS Selector
            </label>
            <input
              id="paginate-custom-selector"
              type="text"
              placeholder='Auto-detected (or enter e.g. button.pagination-next, [aria-label="Next"])'
              value={customSelector}
              onChange={(e) => setCustomSelector(e.target.value)}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-mono text-obsidian-900"
            />
          </div>
        )}
      </div>
    </ModalDialog>
  );
};
