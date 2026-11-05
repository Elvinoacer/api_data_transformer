import React, { useState, useEffect, useCallback, useMemo } from "react";
import { StatusBadge } from "../dashboard/components/StatusBadge";
import { TabPickerModal } from "../dashboard/components/TabPickerModal";
import { ConfirmDialog } from "../dashboard/components/ConfirmDialog";
import { ToastProvider, useToast } from "../dashboard/components/ToastProvider";
import {
  activityRepo,
  calculateSessionMetrics,
  rawResponseRepo,
  recordRepo,
  sessionRepo,
  sourceRepo,
} from "../data/repositories";
import {
  AutoPaginateMode,
  AutoPaginateState,
  CaptureSession,
  CaptureStatus,
  EndpointSource,
  ExtractedRecord,
  RawResponse,
  ScopeMode,
  SessionMetrics,
} from "../shared/types";
import {
  CaptureStateResponse,
  ClearTabDataPayload,
  ClearTabDataResult,
  sendExtensionMessage,
} from "../messaging/protocol";
import { generateFlattenedCsv } from "../export/csv";
import { generateExportFilename } from "../export/filenames";
import {
  Play,
  Pause,
  Square,
  ExternalLink,
  Layers,
  Database,
  Activity,
  Globe,
  FastForward,
  Download,
  Tag,
  Loader2,
  Eraser,
} from "lucide-react";

const SidePanelWorkspace: React.FC = () => {
  const { notify } = useToast();

  const [session, setSession] = useState<CaptureSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [autoPaginate, setAutoPaginate] = useState<
    AutoPaginateState | undefined
  >(undefined);
  const [sources, setSources] = useState<EndpointSource[]>([]);
  const [records, setRecords] = useState<ExtractedRecord[]>([]);
  const [recentResponses, setRecentResponses] = useState<RawResponse[]>([]);
  const [metrics, setMetrics] = useState<SessionMetrics>({
    responsesObserved: 0,
    responsesSaved: 0,
    captureErrors: 0,
    parsedRecords: 0,
    uniqueRecords: 0,
    endpointGroups: 0,
    bytesStored: 0,
  });
  const [isTabPickerOpen, setIsTabPickerOpen] = useState(false);
  const [walkMode, setWalkMode] = useState<AutoPaginateMode>("dom_click");
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [activeDb, allSessions, stateRes] = await Promise.all([
        sessionRepo.getActiveSession(),
        sessionRepo.getAllSessions(),
        sendExtensionMessage<undefined, CaptureStateResponse>(
          "GET_CAPTURE_STATE",
        ),
      ]);

      const currentSession = activeDb || allSessions[0] || null;
      setSession(currentSession);
      setStatus(currentSession?.status || "idle");

      if (stateRes.success && stateRes.data?.autoPaginate) {
        setAutoPaginate(stateRes.data.autoPaginate);
      }

      if (currentSession) {
        const [
          fetchedSources,
          fetchedRecords,
          fetchedResponses,
          calculatedMetrics,
        ] = await Promise.all([
          sourceRepo.getSourcesBySession(currentSession.id),
          recordRepo.getAllRecordsBySession(currentSession.id),
          rawResponseRepo.getBySession(currentSession.id, 6),
          calculateSessionMetrics(currentSession.id),
        ]);

        setSources(fetchedSources);
        setRecords(fetchedRecords);
        setRecentResponses(fetchedResponses);
        setMetrics(calculatedMetrics);
      } else {
        setSources([]);
        setRecords([]);
        setRecentResponses([]);
      }
    } catch (err) {
      console.error("Error refreshing side panel:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, [refresh]);

  const countsBySource = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of records) {
      map.set(r.sourceId, (map.get(r.sourceId) || 0) + 1);
    }
    return map;
  }, [records]);

  const handleStart = async (
    tabId: number,
    originalUrl: string,
    allowedHostnames: string[],
    scopeMode: ScopeMode,
    sessionLabel?: string,
  ) => {
    const res = await sendExtensionMessage("START_CAPTURE", {
      tabId,
      originalUrl,
      allowedHostnames,
      scopeMode,
      label: sessionLabel,
    });
    if (!res.success) {
      notify({
        title: "Capture Failed",
        description: res.error || "Could not attach debugger to tab.",
        variant: "error",
        actor: "system",
      });
    } else {
      notify({
        title: "Capture Active",
        description: `Recording JSON APIs on ${allowedHostnames[0] || "tab"}.`,
        variant: "success",
        actor: "user",
      });
    }
    await refresh();
  };

  const handlePause = async () => {
    if (!session) return;
    await sendExtensionMessage("PAUSE_CAPTURE", { sessionId: session.id });
    await refresh();
  };

  const handleResume = async () => {
    if (!session) return;
    await sendExtensionMessage("RESUME_CAPTURE", { sessionId: session.id });
    await refresh();
  };

  const handleStop = async () => {
    if (!session) return;
    await sendExtensionMessage("STOP_CAPTURE", { sessionId: session.id });
    await refresh();
    notify({
      title: "Session Stopped",
      description: `${metrics.uniqueRecords} unique records ready for CSV export.`,
      variant: "success",
      actor: "user",
    });
  };

  const handleOpenDashboard = async () => {
    await sendExtensionMessage("OPEN_DASHBOARD");
  };

  const handleQuickPaginate = async (sourceId?: string) => {
    if (!session) return;
    const targetSource = sources.find((s) => s.id === sourceId) || sources[0];
    const effectiveMode: AutoPaginateMode =
      walkMode === "api_fetch" &&
      (!targetSource?.pagination ||
        (targetSource.pagination.strategy === "none" &&
          !targetSource.pagination.nextUrl))
        ? "dom_click"
        : walkMode;

    const res = await sendExtensionMessage<any, AutoPaginateState>(
      "START_AUTO_PAGINATE",
      {
        sessionId: session.id,
        sourceId: targetSource?.id,
        mode: effectiveMode,
        delayMs: 1800,
        maxPages: 15,
      },
    );

    if (res.success && res.data) {
      setAutoPaginate(res.data);
      notify({
        title: "Fetching Pages...",
        description: `Walking pages via ${effectiveMode === "api_fetch" ? "Direct API Fetch" : effectiveMode === "scroll" ? "Infinite Scroll" : "Next Page Button"}.`,
        variant: "info",
        actor: "user",
      });
    } else {
      notify({
        title: "Could Not Start Pagination",
        description: res.error || "Ensure capture is actively recording.",
        variant: "warning",
        actor: "system",
      });
    }
  };

  const handleStopPaginate = async () => {
    await sendExtensionMessage("STOP_AUTO_PAGINATE");
    await refresh();
  };

  const handleClearTabData = async () => {
    if (!session) return;
    setIsClearing(true);
    try {
      const res = await sendExtensionMessage<
        ClearTabDataPayload,
        ClearTabDataResult
      >("CLEAR_TAB_DATA", { sessionId: session.id });
      if (!res.success) {
        await sessionRepo.clearSessionData(session.id);
      }
      await refresh();
      const countText =
        res.data &&
        (res.data.clearedResponses > 0 || res.data.clearedRecords > 0)
          ? `Purged ${res.data.clearedResponses} response(s) and ${res.data.clearedRecords} record(s).`
          : `Wiped all captured responses, records, and schemas.`;
      notify({
        title: "Tab Data Cleared",
        description: `${countText} Session "${session.label}" remains active.`,
        variant: "info",
        actor: "user",
      });
      setIsClearConfirmOpen(false);
    } catch (err: any) {
      notify({
        title: "Could Not Clear Data",
        description: err?.message || "Failed to clear tab data",
        variant: "error",
        actor: "system",
      });
    } finally {
      setIsClearing(false);
    }
  };

  const handleQuickExportSource = async (src: EndpointSource) => {
    const srcRecords = records.filter((r) => r.sourceId === src.id);
    if (srcRecords.length === 0) return;

    const csv = generateFlattenedCsv(
      srcRecords.map((r) => r.rawRecord),
      {
        includeBom: true,
        defendFormulaInjection: true,
        nullValueRepresentation: "",
        arrayFormat: "readable",
        headerStyle: "readable",
      },
    );

    const filename = generateExportFilename({
      label: src.label,
      site: session?.allowedHostnames[0] || "site",
      extension: "csv",
      includeTime: false,
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (session) {
      await activityRepo.logEvent({
        sessionId: session.id,
        actor: "user",
        category: "export",
        message: `Exported "${src.label}" (${srcRecords.length} rows) from Side Panel`,
      });
    }

    notify({
      title: `Saved ${filename}`,
      description: `${srcRecords.length} "${src.label}" rows exported.`,
      variant: "success",
      actor: "user",
    });
  };

  const isWalking =
    autoPaginate?.status === "running" || autoPaginate?.status === "stopping";

  return (
    <div className="min-h-screen bg-canvas p-3.5 flex flex-col text-stone-800 gap-3.5">
      <a href="#sidepanel-main" className="skip-link visually-hidden">
        Skip to collector controls
      </a>

      {/* Top Obsidian + Lime Brand Header */}
      <header className="flex items-center justify-between bg-obsidian-900 text-white px-3.5 py-2.5 rounded-2xl shadow-xs border border-obsidian-800">
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-lg bg-obsidian-800 border border-obsidian-700 flex items-center justify-center"
            aria-hidden="true"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-brand-400 ring-4 ring-brand-400/25" />
          </div>
          <div>
            <span className="font-extrabold text-xs tracking-tight text-white block leading-tight">
              API Data Collector
            </span>
            <span className="text-[10px] text-brand-300 font-medium block">
              Live Side Companion
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleOpenDashboard}
          title="Open Full Studio Dashboard in Tab"
          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-obsidian-800 hover:bg-obsidian-700 border border-obsidian-700 rounded-xl text-[11px] font-semibold text-brand-300 transition"
        >
          <ExternalLink className="w-3 h-3" aria-hidden="true" /> Studio
        </button>
      </header>

      <main
        id="sidepanel-main"
        tabIndex={-1}
        className="flex flex-col gap-3.5 flex-1 focus:outline-none"
      >
        {/* Target Tab & Capture Controls */}
        <section className="bg-white rounded-2xl p-3.5 border border-stone-200 shadow-xs space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-stone-400">
              Target Session
            </span>
            <StatusBadge status={status} />
          </div>

          {session ? (
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <Globe
                  className="w-4 h-4 text-brand-700 flex-shrink-0"
                  aria-hidden="true"
                />
                <span className="font-semibold truncate text-stone-900">
                  {session.label || session.allowedHostnames[0] || "Active tab"}
                </span>
              </div>
              {status === "recording" && (
                <button
                  type="button"
                  onClick={() => sendExtensionMessage("FOCUS_TARGET_TAB")}
                  className="text-[10px] font-semibold text-brand-800 hover:underline flex-shrink-0"
                >
                  Focus tab
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-stone-500">
              Select a browser tab to start capturing APIs automatically.
            </p>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 pt-0.5">
            {status === "recording" ? (
              <button
                type="button"
                onClick={handlePause}
                className="flex-1 py-2 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 transition"
              >
                <Pause className="w-3.5 h-3.5" aria-hidden="true" /> Pause
              </button>
            ) : status === "paused" ? (
              <button
                type="button"
                onClick={handleResume}
                className="flex-1 py-2 bg-brand-400 hover:bg-brand-300 text-brand-950 text-xs font-extrabold rounded-xl flex items-center justify-center gap-1.5 shadow-xs transition"
              >
                <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />{" "}
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsTabPickerOpen(true)}
                className="flex-1 py-2.5 bg-brand-400 hover:bg-brand-300 text-brand-950 text-xs font-extrabold rounded-xl flex items-center justify-center gap-1.5 shadow-xs transition"
              >
                <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />{" "}
                Start Capture
              </button>
            )}

            {(status === "recording" || status === "paused") && (
              <button
                type="button"
                onClick={handleStop}
                className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 shadow-xs transition"
              >
                <Square className="w-3 h-3 fill-current" aria-hidden="true" />{" "}
                Stop
              </button>
            )}
          </div>

          {session &&
            (metrics.responsesObserved > 0 ||
              metrics.uniqueRecords > 0 ||
              metrics.endpointGroups > 0 ||
              metrics.captureErrors > 0 ||
              records.length > 0 ||
              sources.length > 0 ||
              recentResponses.length > 0) && (
              <button
                type="button"
                onClick={() => setIsClearConfirmOpen(true)}
                title="Clear all fetched/extracted data for this tab"
                className="w-full py-1.5 px-3 bg-stone-50 hover:bg-amber-50 text-stone-700 hover:text-amber-900 border border-stone-200 hover:border-amber-300 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition"
              >
                <Eraser
                  className="w-3.5 h-3.5 text-amber-600"
                  aria-hidden="true"
                />
                Clear Tab Data
              </button>
            )}
        </section>

        {/* Quick Multi-Page Fetch Assistant Bar */}
        {status === "recording" && (
          <section className="bg-obsidian-900 text-white rounded-2xl p-3.5 border border-obsidian-800 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold text-brand-300 flex items-center gap-1.5">
                <FastForward
                  className="w-3.5 h-3.5 text-brand-400"
                  aria-hidden="true"
                />
                Multi-Page Fetch Helper
              </span>
              {!isWalking && (
                <select
                  aria-label="Pagination walk strategy"
                  value={walkMode}
                  onChange={(e) =>
                    setWalkMode(e.target.value as AutoPaginateMode)
                  }
                  className="bg-obsidian-800 border border-obsidian-700 text-[10px] font-semibold text-stone-200 rounded-lg px-2 py-1"
                >
                  <option value="dom_click">Click Next</option>
                  <option value="api_fetch">Direct API</option>
                  <option value="scroll">Scroll Load</option>
                </select>
              )}
            </div>

            {isWalking ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] text-stone-300">
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2
                      className="w-3.5 h-3.5 text-brand-400 animate-spin"
                      aria-hidden="true"
                    />
                    Page {autoPaginate?.pagesAttempted}/{autoPaginate?.maxPages}{" "}
                    (+
                    {Math.max(
                      0,
                      (autoPaginate?.currentUniqueRecords || 0) -
                        (autoPaginate?.initialUniqueRecords || 0),
                    )}{" "}
                    rows)
                  </span>
                  <button
                    type="button"
                    onClick={handleStopPaginate}
                    className="px-2 py-0.5 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold rounded-md"
                  >
                    Stop
                  </button>
                </div>
                {autoPaginate?.message && (
                  <p className="text-[10px] text-stone-400 truncate">
                    {autoPaginate.message}
                  </p>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleQuickPaginate()}
                className="w-full py-2 bg-brand-400 hover:bg-brand-300 text-brand-950 text-xs font-extrabold rounded-xl transition flex items-center justify-center gap-1.5"
              >
                <FastForward className="w-3.5 h-3.5" aria-hidden="true" />
                Auto-Fetch Remaining Pages
              </button>
            )}
          </section>
        )}

        {/* Live Counters */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-white p-3 rounded-2xl border border-stone-200 shadow-xs">
            <div className="flex items-center gap-1.5 text-stone-500 text-[10px] font-bold uppercase mb-1">
              <Activity
                className="w-3.5 h-3.5 text-brand-700"
                aria-hidden="true"
              />{" "}
              API Calls
            </div>
            <div className="text-xl font-extrabold text-stone-900">
              {metrics.responsesSaved}
            </div>
            <div className="text-[10px] text-stone-400">
              {metrics.responsesObserved} observed
            </div>
          </div>

          <div className="bg-white p-3 rounded-2xl border border-stone-200 shadow-xs">
            <div className="flex items-center gap-1.5 text-stone-500 text-[10px] font-bold uppercase mb-1">
              <Database
                className="w-3.5 h-3.5 text-brand-700"
                aria-hidden="true"
              />{" "}
              Unique Rows
            </div>
            <div className="text-xl font-extrabold text-stone-900">
              {metrics.uniqueRecords}
            </div>
            <div className="text-[10px] text-stone-400">
              {metrics.endpointGroups} labeled APIs
            </div>
          </div>
        </div>

        {/* Discovered Labeled API Datasets with Instant CSV Download */}
        {sources.length > 0 && (
          <section className="bg-white p-3 rounded-2xl border border-stone-200 shadow-xs space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-stone-500 flex items-center gap-1">
                <Tag className="w-3 h-3 text-brand-700" aria-hidden="true" />
                Labeled API Datasets ({sources.length})
              </span>
            </div>

            <div className="space-y-2 max-h-56 overflow-y-auto pr-0.5">
              {sources.map((s) => {
                const count = countsBySource.get(s.id) || 0;
                const pag = s.pagination;
                const observedCount = pag?.observedPages.length || 0;
                const totalPages = pag?.totalPages;

                return (
                  <div
                    key={s.id}
                    className="p-2.5 rounded-xl bg-stone-50 border border-stone-200 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-bold text-xs text-stone-900 block truncate">
                          {s.label}
                        </span>
                        <span className="text-[10px] font-mono text-stone-500 block truncate">
                          {s.httpMethod}{" "}
                          {s.normalizedEndpoint.replace(
                            /^https?:\/\/[^/]+/,
                            "",
                          )}
                        </span>
                      </div>

                      <button
                        type="button"
                        disabled={count === 0}
                        onClick={() => handleQuickExportSource(s)}
                        title={`Export ${s.label} CSV`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-brand-100 hover:bg-brand-200 disabled:opacity-40 text-brand-950 border border-brand-300 rounded-lg text-[10px] font-bold transition flex-shrink-0"
                      >
                        <Download className="w-3 h-3" aria-hidden="true" />
                        CSV ({count})
                      </button>
                    </div>

                    {pag && pag.strategy !== "none" && (
                      <div className="flex items-center justify-between text-[10px] text-stone-600 pt-0.5">
                        <span>
                          Pages captured:{" "}
                          <strong className="text-stone-900">
                            {observedCount}
                            {totalPages ? ` / ${totalPages}` : ""}
                          </strong>
                        </span>
                        {status === "recording" && !isWalking && (
                          <button
                            type="button"
                            onClick={() => handleQuickPaginate(s.id)}
                            className="font-bold text-brand-800 hover:underline"
                          >
                            + Fetch pages
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Recent Live Traffic */}
        <section className="bg-white rounded-2xl p-3 border border-stone-200 shadow-xs flex-1 flex flex-col min-h-[140px]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-stone-500 flex items-center gap-1">
              <Layers
                className="w-3.5 h-3.5 text-brand-700"
                aria-hidden="true"
              />{" "}
              Recent API Traffic
            </span>
            <div className="flex items-center gap-2">
              {recentResponses.length > 0 && (
                <button
                  type="button"
                  onClick={() => setIsClearConfirmOpen(true)}
                  title="Clear all captured data from this tab"
                  className="text-[10px] font-semibold text-stone-400 hover:text-amber-700 transition"
                >
                  Clear
                </button>
              )}
              <span className="text-[10px] text-stone-400 font-mono">
                {recentResponses.length}
              </span>
            </div>
          </div>

          <div className="space-y-1.5 flex-1 overflow-y-auto">
            {recentResponses.length === 0 ? (
              <div className="text-center py-6 text-xs text-stone-400">
                Browse or paginate the target tab to capture live JSON
                responses.
              </div>
            ) : (
              recentResponses.map((r) => (
                <div
                  key={r.id}
                  className="p-2 bg-stone-50 border border-stone-100 rounded-xl text-xs space-y-0.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-[10px] text-brand-900 bg-brand-100 px-1.5 py-0.5 rounded">
                      {r.httpMethod} {r.httpStatus}
                    </span>
                    <span className="text-[10px] text-stone-400 font-mono">
                      {r.extractedCount ? `+${r.extractedCount} rows · ` : ""}
                      {new Date(r.capturedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <p
                    className="truncate text-stone-600 font-mono text-[11px]"
                    title={r.url}
                  >
                    {r.url.replace(/^https?:\/\/[^/]+/, "")}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      <TabPickerModal
        isOpen={isTabPickerOpen}
        onClose={() => setIsTabPickerOpen(false)}
        onSelectTab={handleStart}
      />

      <ConfirmDialog
        isOpen={isClearConfirmOpen}
        title="Clear All Tab Data?"
        description={`This will permanently wipe all captured raw responses, extracted records, and schemas for "${session?.label || "this tab"}". The session remains connected so you can capture fresh data immediately.`}
        confirmLabel="Clear All Tab Data"
        cancelLabel="Keep Data"
        variant="warning"
        isBusy={isClearing}
        onCancel={() => setIsClearConfirmOpen(false)}
        onConfirm={handleClearTabData}
      />
    </div>
  );
};

export const SidePanel: React.FC = () => (
  <ToastProvider>
    <SidePanelWorkspace />
  </ToastProvider>
);
