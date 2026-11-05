import React, { useState, useEffect, useCallback, useRef } from "react";
import { Header, DashboardTab } from "./components/Header";
import { Overview } from "./pages/Overview";
import { Sources } from "./pages/Sources";
import { Responses } from "./pages/Responses";
import { Records } from "./pages/Records";
import { Schemas } from "./pages/Schemas";
import { Exports } from "./pages/Exports";
import { Settings } from "./pages/Settings";
import { TabPickerModal } from "./components/TabPickerModal";
import { PaginationAssistantModal } from "./components/PaginationAssistantModal";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ToastProvider, useToast } from "./components/ToastProvider";
import {
  activityRepo,
  calculateSessionMetrics,
  errorRepo,
  rawResponseRepo,
  recordRepo,
  schemaRepo,
  sessionRepo,
  sourceRepo,
} from "../data/repositories";
import {
  ActivityEvent,
  AutoPaginateConfig,
  AutoPaginateState,
  CaptureError,
  CaptureSession,
  CaptureStatus,
  EndpointSchema,
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

const EMPTY_METRICS: SessionMetrics = {
  responsesObserved: 0,
  responsesSaved: 0,
  captureErrors: 0,
  parsedRecords: 0,
  uniqueRecords: 0,
  endpointGroups: 0,
  bytesStored: 0,
};

const DashboardWorkspace: React.FC = () => {
  const { notify } = useToast();

  const [currentTab, setCurrentTab] = useState<DashboardTab>("overview");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [allSessions, setAllSessions] = useState<CaptureSession[]>([]);
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [autoPaginateState, setAutoPaginateState] = useState<
    AutoPaginateState | undefined
  >(undefined);

  const [sources, setSources] = useState<EndpointSource[]>([]);
  const [responses, setResponses] = useState<RawResponse[]>([]);
  const [records, setRecords] = useState<ExtractedRecord[]>([]);
  const [schemas, setSchemas] = useState<EndpointSchema[]>([]);
  const [errors, setErrors] = useState<CaptureError[]>([]);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [metrics, setMetrics] = useState<SessionMetrics>(EMPTY_METRICS);

  const [isTabPickerOpen, setIsTabPickerOpen] = useState(false);
  const [isAutoPaginateOpen, setIsAutoPaginateOpen] = useState(false);
  const [autoPaginateSourceId, setAutoPaginateSourceId] = useState<
    string | undefined
  >(undefined);
  const [recordsSourceFilter, setRecordsSourceFilter] = useState<string>("all");
  const [exportsSourceFilter, setExportsSourceFilter] = useState<
    string | undefined
  >(undefined);

  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [isClearTabDataConfirmOpen, setIsClearTabDataConfirmOpen] =
    useState(false);
  const [isClearingTabData, setIsClearingTabData] = useState(false);

  // Refs for detecting live system transitions without spamming initial load
  const initializedSessionRef = useRef<string | null>(null);
  const knownSourceIdsRef = useRef<Set<string>>(new Set());
  const prevStatusRef = useRef<CaptureStatus>("idle");
  const prevAutoStatusRef = useRef<string>("idle");

  const refreshData = useCallback(
    async (options?: { silent?: boolean; forceSessionId?: string | null }) => {
      const silent = options?.silent ?? true;
      if (!silent) {
        setIsManualRefreshing(true);
      }

      try {
        const [sessionsList, activeDbSession, bgStateRes] = await Promise.all([
          sessionRepo.getAllSessions(),
          sessionRepo.getActiveSession(),
          sendExtensionMessage<undefined, CaptureStateResponse>(
            "GET_CAPTURE_STATE",
          ),
        ]);

        setAllSessions(sessionsList);

        if (bgStateRes.success && bgStateRes.data?.autoPaginate) {
          const nextAuto = bgStateRes.data.autoPaginate;
          setAutoPaginateState(nextAuto);

          // Announce system auto-pagination completion
          if (
            (prevAutoStatusRef.current === "running" ||
              prevAutoStatusRef.current === "stopping") &&
            nextAuto.status === "completed"
          ) {
            const gained = Math.max(
              0,
              nextAuto.currentUniqueRecords - nextAuto.initialUniqueRecords,
            );
            notify({
              title: "Multi-Page Fetch Completed",
              description:
                nextAuto.message ||
                `Fetched ${nextAuto.pagesAttempted} pages (${gained} new records).`,
              variant: "success",
              actor: "system",
            });
          } else if (
            prevAutoStatusRef.current === "running" &&
            nextAuto.status === "error"
          ) {
            notify({
              title: "Multi-Page Fetch Stopped",
              description:
                nextAuto.message || "Could not advance further pages.",
              variant: "warning",
              actor: "system",
            });
          }
          prevAutoStatusRef.current = nextAuto.status;
        }

        const targetId =
          options?.forceSessionId !== undefined
            ? options.forceSessionId
            : selectedSessionId;

        let currentSession: CaptureSession | null = null;
        if (targetId) {
          currentSession =
            sessionsList.find((s) => s.id === targetId) ||
            activeDbSession ||
            sessionsList[0] ||
            null;
        } else {
          currentSession = activeDbSession || sessionsList[0] || null;
        }

        const nextStatus: CaptureStatus = currentSession?.status || "idle";

        // System notification if debugger detached unexpectedly
        if (
          prevStatusRef.current === "recording" &&
          nextStatus === "detached"
        ) {
          notify({
            title: "Target Tab Disconnected",
            description:
              currentSession?.errorReason ||
              "Chrome debugger detached from the target tab. All captured records are safely saved.",
            variant: "warning",
            actor: "system",
          });
        }
        prevStatusRef.current = nextStatus;

        setSession(currentSession);
        setStatus(nextStatus);

        if (currentSession) {
          const [
            fetchedSources,
            fetchedResponses,
            fetchedRecords,
            fetchedSchemas,
            fetchedErrors,
            fetchedActivities,
            calculatedMetrics,
          ] = await Promise.all([
            sourceRepo.getSourcesBySession(currentSession.id),
            rawResponseRepo.getBySession(currentSession.id, 150),
            recordRepo.getAllRecordsBySession(currentSession.id),
            schemaRepo.getSchemasBySession(currentSession.id),
            errorRepo.getErrorsBySession(currentSession.id, 25),
            activityRepo.getEventsBySession(currentSession.id, 35),
            calculateSessionMetrics(currentSession.id),
          ]);

          // Detect newly discovered API datasets during live capture
          if (fetchedSources.length === 0) {
            knownSourceIdsRef.current.clear();
          }
          if (initializedSessionRef.current !== currentSession.id) {
            initializedSessionRef.current = currentSession.id;
            knownSourceIdsRef.current = new Set(
              fetchedSources.map((s) => s.id),
            );
          } else if (nextStatus === "recording") {
            for (const src of fetchedSources) {
              if (!knownSourceIdsRef.current.has(src.id)) {
                knownSourceIdsRef.current.add(src.id);
                notify({
                  title: `Discovered "${src.label}" API`,
                  description: `${src.httpMethod} ${src.normalizedEndpoint.replace(/^https?:\/\/[^/]+/, "")}`,
                  variant: "info",
                  actor: "system",
                  durationMs: 3600,
                });
              }
            }
          }

          setSources(fetchedSources);
          setResponses(fetchedResponses);
          setRecords(fetchedRecords);
          setSchemas(fetchedSchemas);
          setErrors(fetchedErrors);
          setActivities(fetchedActivities);
          setMetrics(calculatedMetrics);
        } else {
          initializedSessionRef.current = null;
          knownSourceIdsRef.current.clear();
          setSources([]);
          setResponses([]);
          setRecords([]);
          setSchemas([]);
          setErrors([]);
          setActivities([]);
          setMetrics(EMPTY_METRICS);
        }
      } catch (err) {
        console.error("Error refreshing dashboard data:", err);
      } finally {
        if (!silent) {
          setTimeout(() => setIsManualRefreshing(false), 350);
        }
      }
    },
    [selectedSessionId, notify],
  );

  useEffect(() => {
    refreshData({ silent: true });

    const interval = setInterval(() => {
      refreshData({ silent: true });
    }, 1800);

    return () => clearInterval(interval);
  }, [refreshData]);

  const handleManualRefresh = async () => {
    await refreshData({ silent: false });
  };

  const handleSelectSession = async (sessionId: string) => {
    setSelectedSessionId(sessionId);
    await refreshData({ silent: false, forceSessionId: sessionId });
  };

  const handleStartCapture = async (
    tabId: number,
    originalUrl: string,
    allowedHostnames: string[],
    scopeMode: ScopeMode,
    sessionLabel?: string,
  ) => {
    try {
      setStatus("starting");
      const res = await sendExtensionMessage<any, CaptureSession>(
        "START_CAPTURE",
        {
          tabId,
          originalUrl,
          allowedHostnames,
          scopeMode,
          label: sessionLabel,
        },
      );

      if (res.success && res.data) {
        setSelectedSessionId(res.data.id);
        setSession(res.data);
        setStatus("recording");
        prevStatusRef.current = "recording";
        await refreshData({ silent: true, forceSessionId: res.data.id });

        notify({
          title: "Live API Capture Active",
          description: `Listening to JSON API responses on ${allowedHostnames[0] || "selected tab"}.`,
          variant: "success",
          actor: "user",
        });
      } else {
        setStatus(session?.status || "idle");
        notify({
          title: "Could Not Attach to Tab",
          description:
            res.error ||
            "Ensure the tab is a normal http/https webpage and DevTools is not blocking debugger attachment.",
          variant: "error",
          actor: "system",
        });
      }
    } catch (err: any) {
      setStatus(session?.status || "idle");
      notify({
        title: "Capture Initialization Failed",
        description:
          err?.message ||
          "Unexpected error communicating with background worker.",
        variant: "error",
        actor: "system",
      });
    }
  };

  const handlePause = async () => {
    if (!session) return;
    await sendExtensionMessage("PAUSE_CAPTURE", { sessionId: session.id });
    setStatus("paused");
    prevStatusRef.current = "paused";
    await refreshData({ silent: true });
    notify({
      title: "Capture Paused",
      description:
        "Incoming network responses are temporarily ignored until you resume.",
      variant: "info",
      actor: "user",
    });
  };

  const handleResume = async () => {
    if (!session) return;
    await sendExtensionMessage("RESUME_CAPTURE", { sessionId: session.id });
    setStatus("recording");
    prevStatusRef.current = "recording";
    await refreshData({ silent: true });
    notify({
      title: "Capture Resumed",
      description: "Listening for new API responses and pages.",
      variant: "success",
      actor: "user",
    });
  };

  const handleStop = async () => {
    if (!session) return;
    await sendExtensionMessage("STOP_CAPTURE", { sessionId: session.id });
    setStatus("stopped");
    prevStatusRef.current = "stopped";
    await refreshData({ silent: true });
    notify({
      title: "Capture Session Completed",
      description: `${metrics.uniqueRecords} unique records across ${metrics.endpointGroups} API datasets are ready to export.`,
      variant: "success",
      actor: "user",
    });
  };

  const handleRenameSession = async (newLabel: string) => {
    if (!session || !newLabel.trim()) return;
    await sessionRepo.renameSession(session.id, newLabel.trim());
    await activityRepo.logEvent({
      sessionId: session.id,
      actor: "user",
      category: "session",
      message: `Renamed session to "${newLabel.trim()}"`,
    });
    await refreshData({ silent: true });
    notify({
      title: "Session Renamed",
      description: `Updated session label to "${newLabel.trim()}".`,
      variant: "success",
      actor: "user",
    });
  };

  const handleReprocess = async () => {
    if (!session) return;
    setIsReprocessing(true);
    try {
      const res = await sendExtensionMessage("REPROCESS_SESSION", {
        sessionId: session.id,
      });
      await refreshData({ silent: true });
      if (res.success) {
        notify({
          title: "Datasets Re-Extracted",
          description:
            "Rebuilt consolidated records and schemas from saved raw responses.",
          variant: "success",
          actor: "user",
        });
      }
    } finally {
      setIsReprocessing(false);
    }
  };

  const handleConfirmClearTabData = async () => {
    if (!session) return;
    setIsClearingTabData(true);
    try {
      const res = await sendExtensionMessage<
        ClearTabDataPayload,
        ClearTabDataResult
      >("CLEAR_TAB_DATA", { sessionId: session.id });
      if (!res.success) {
        await sessionRepo.clearSessionData(session.id);
      }
      setRecordsSourceFilter("all");
      setExportsSourceFilter(undefined);
      setAutoPaginateSourceId(undefined);
      await refreshData({ silent: false, forceSessionId: session.id });
      const countText =
        res.data &&
        (res.data.clearedResponses > 0 || res.data.clearedRecords > 0)
          ? `Purged ${res.data.clearedResponses} response(s), ${res.data.clearedRecords} record(s), and ${res.data.clearedSources} dataset(s).`
          : `Purged all raw traffic, records, and schemas for "${session.label}".`;
      notify({
        title: "Tab Data Cleared",
        description: `${countText} Session remains active.`,
        variant: "info",
        actor: "user",
      });
      setIsClearTabDataConfirmOpen(false);
    } catch (err: any) {
      notify({
        title: "Could Not Clear Tab Data",
        description: err?.message || "Error clearing tab data",
        variant: "error",
        actor: "system",
      });
    } finally {
      setIsClearingTabData(false);
    }
  };

  const handleFocusTargetTab = async () => {
    const res = await sendExtensionMessage("FOCUS_TARGET_TAB");
    if (!res.success) {
      notify({
        title: "Target Tab Not Open",
        description: res.error || "The captured tab may have been closed.",
        variant: "warning",
        actor: "system",
      });
    }
  };

  const handleOpenSidepanel = async (windowId?: number) => {
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.sidePanel?.open &&
        typeof windowId === "number"
      ) {
        await chrome.sidePanel.open({ windowId });
        return;
      }
      const res = await sendExtensionMessage("OPEN_SIDEPANEL", { windowId });
      if (!res.success) {
        notify({
          title: "Side Panel Notice",
          description:
            res.error ||
            "Click the extension icon in Chrome toolbar to toggle Side Panel.",
          variant: "info",
          actor: "system",
        });
      }
    } catch (err: any) {
      notify({
        title: "Could Not Open Side Panel",
        description: err?.message || "Open the Side Panel from Chrome toolbar.",
        variant: "warning",
        actor: "system",
      });
    }
  };

  const handleOpenAutoPaginate = (sourceId?: string) => {
    setAutoPaginateSourceId(sourceId);
    setIsAutoPaginateOpen(true);
  };

  const handleStartAutoPaginate = async (config: AutoPaginateConfig) => {
    const res = await sendExtensionMessage<
      AutoPaginateConfig,
      AutoPaginateState
    >("START_AUTO_PAGINATE", config);
    if (res.success && res.data) {
      setAutoPaginateState(res.data);
      prevAutoStatusRef.current = res.data.status;
      notify({
        title: "Multi-Page Fetch Started",
        description: `Walking up to ${config.maxPages} pages automatically.`,
        variant: "info",
        actor: "user",
      });
    } else {
      notify({
        title: "Cannot Start Multi-Page Fetch",
        description:
          res.error ||
          "Ensure capture is actively recording on the target tab.",
        variant: "error",
        actor: "system",
      });
    }
  };

  const handleStopAutoPaginate = async () => {
    const res = await sendExtensionMessage<undefined, AutoPaginateState>(
      "STOP_AUTO_PAGINATE",
    );
    if (res.success && res.data) {
      setAutoPaginateState(res.data);
    }
    notify({
      title: "Stopping Multi-Page Fetch",
      description: "Halting after the in-flight page request finishes.",
      variant: "info",
      actor: "user",
    });
  };

  const handleNavigateTab = (tab: DashboardTab, sourceId?: string) => {
    if (tab === "records") {
      setRecordsSourceFilter(sourceId || "all");
    } else if (tab === "exports") {
      setExportsSourceFilter(sourceId);
    }
    setCurrentTab(tab);
  };

  const handleQuickExportSource = async (source: EndpointSource) => {
    const sourceRecords = records.filter((r) => r.sourceId === source.id);
    if (sourceRecords.length === 0) {
      notify({
        title: `No records in "${source.label}" yet`,
        description: "Capture or paginate this API first to export records.",
        variant: "warning",
        actor: "user",
      });
      return;
    }

    const csv = generateFlattenedCsv(
      sourceRecords.map((r) => r.rawRecord),
      {
        includeBom: true,
        defendFormulaInjection: true,
        nullValueRepresentation: "",
        arrayFormat: "readable",
        headerStyle: "readable",
      },
    );

    const fname = generateExportFilename({
      label: source.label,
      site: session?.allowedHostnames[0] || "site",
      extension: "csv",
      includeTime: false,
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (session) {
      await activityRepo.logEvent({
        sessionId: session.id,
        actor: "user",
        category: "export",
        message: `Quick-exported "${source.label}" (${sourceRecords.length} rows) as ${fname}`,
      });
    }

    notify({
      title: `Downloaded ${fname}`,
      description: `Exported ${sourceRecords.length} "${source.label}" records to CSV.`,
      variant: "success",
      actor: "user",
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-stone-900">
      <Header
        currentTab={currentTab}
        onTabChange={(t) => handleNavigateTab(t)}
        session={session}
        allSessions={allSessions}
        onSelectSession={handleSelectSession}
        status={status}
        metrics={metrics}
        autoPaginateState={autoPaginateState}
        onStart={() => setIsTabPickerOpen(true)}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onClearTabData={() => setIsClearTabDataConfirmOpen(true)}
        onOpenAutoPaginate={() => handleOpenAutoPaginate()}
        onFocusTargetTab={handleFocusTargetTab}
        onRefresh={handleManualRefresh}
        onOpenSidepanel={handleOpenSidepanel}
        isManualRefreshing={isManualRefreshing}
      />

      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 focus:outline-none"
      >
        {currentTab === "overview" && (
          <Overview
            session={session}
            sources={sources}
            records={records}
            metrics={metrics}
            errors={errors}
            activities={activities}
            onStartClick={() => setIsTabPickerOpen(true)}
            onRenameSession={handleRenameSession}
            onNavigateTab={handleNavigateTab}
            onOpenAutoPaginate={handleOpenAutoPaginate}
            onQuickExportSource={handleQuickExportSource}
            onClearTabData={() => setIsClearTabDataConfirmOpen(true)}
          />
        )}

        {currentTab === "sources" && (
          <Sources
            sources={sources}
            rawResponses={responses}
            sessionId={session?.id}
            canAutoPaginate={status === "recording" || status === "paused"}
            onRefreshSources={() => refreshData({ silent: true })}
            onReprocess={handleReprocess}
            onOpenAutoPaginate={(srcId) => handleOpenAutoPaginate(srcId)}
            onViewSourceRecords={(srcId) => handleNavigateTab("records", srcId)}
            isReprocessing={isReprocessing}
          />
        )}

        {currentTab === "responses" && (
          <Responses
            responses={responses}
            sources={sources}
            onClearTabData={() => setIsClearTabDataConfirmOpen(true)}
          />
        )}

        {currentTab === "records" && (
          <Records
            records={records}
            sources={sources}
            initialSourceFilter={recordsSourceFilter}
            onExportFiltered={(srcId) =>
              handleNavigateTab("exports", srcId === "all" ? undefined : srcId)
            }
            onClearTabData={() => setIsClearTabDataConfirmOpen(true)}
          />
        )}

        {currentTab === "schemas" && (
          <Schemas schemas={schemas} sources={sources} />
        )}

        {currentTab === "exports" && (
          <Exports
            session={session}
            sources={sources}
            records={records}
            rawResponses={responses}
            initialSourceId={exportsSourceFilter}
            onRefreshSources={() => refreshData({ silent: true })}
          />
        )}

        {currentTab === "settings" && (
          <Settings
            session={session}
            onSessionCleared={async () => {
              setSelectedSessionId(null);
              await refreshData({ silent: false, forceSessionId: null });
            }}
            onDataCleared={async () => {
              if (session) {
                setRecordsSourceFilter("all");
                setExportsSourceFilter(undefined);
                setAutoPaginateSourceId(undefined);
                await refreshData({
                  silent: false,
                  forceSessionId: session.id,
                });
              }
            }}
          />
        )}
      </main>

      {/* Tab Picker Modal */}
      <TabPickerModal
        isOpen={isTabPickerOpen}
        onClose={() => setIsTabPickerOpen(false)}
        onSelectTab={handleStartCapture}
      />

      {/* Multi-Page API Fetch Assistant Modal */}
      <PaginationAssistantModal
        isOpen={isAutoPaginateOpen}
        onClose={() => setIsAutoPaginateOpen(false)}
        sessionId={session?.id}
        status={status}
        sources={sources}
        initialSourceId={autoPaginateSourceId}
        autoPaginateState={autoPaginateState}
        onStartAutoPaginate={handleStartAutoPaginate}
        onStopAutoPaginate={handleStopAutoPaginate}
      />

      {/* Clear Tab Data Confirmation Modal */}
      <ConfirmDialog
        isOpen={isClearTabDataConfirmOpen}
        title="Clear All Tab Data?"
        description={`This will permanently wipe all captured raw responses, extracted records, inferred schemas, endpoint sources, and sync queue items for "${session?.label || "this tab"}". The session remains connected so you can capture fresh data immediately.`}
        confirmLabel="Clear All Tab Data"
        cancelLabel="Keep Data"
        variant="warning"
        isBusy={isClearingTabData}
        onCancel={() => setIsClearTabDataConfirmOpen(false)}
        onConfirm={handleConfirmClearTabData}
      />
    </div>
  );
};

export const App: React.FC = () => (
  <ToastProvider>
    <DashboardWorkspace />
  </ToastProvider>
);
