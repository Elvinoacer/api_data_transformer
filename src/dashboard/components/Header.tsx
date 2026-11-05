import React, { useEffect, useState } from "react";
import { StatusBadge } from "./StatusBadge";
import {
  AutoPaginateState,
  CaptureSession,
  CaptureStatus,
  SessionMetrics,
} from "../../shared/types";
import {
  Play,
  Pause,
  Square,
  RefreshCw,
  Layers,
  Database,
  ArrowUpDown,
  Download,
  Settings,
  PanelRight,
  Radio,
  FileCode2,
  FastForward,
  ExternalLink,
  Loader2,
  Eraser,
} from "lucide-react";

export type DashboardTab =
  | "overview"
  | "sources"
  | "responses"
  | "records"
  | "schemas"
  | "exports"
  | "settings";

interface Props {
  currentTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  session: CaptureSession | null;
  allSessions: CaptureSession[];
  onSelectSession: (sessionId: string) => void;
  status: CaptureStatus;
  metrics: SessionMetrics;
  autoPaginateState?: AutoPaginateState;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onClearTabData?: () => void;
  onOpenAutoPaginate: () => void;
  onFocusTargetTab: () => void;
  onRefresh: () => void;
  onOpenSidepanel: (windowId?: number) => void;
  isManualRefreshing: boolean;
}

export const Header: React.FC<Props> = ({
  currentTab,
  onTabChange,
  session,
  allSessions,
  onSelectSession,
  status,
  metrics,
  autoPaginateState,
  onStart,
  onPause,
  onResume,
  onStop,
  onClearTabData,
  onOpenAutoPaginate,
  onFocusTargetTab,
  onRefresh,
  onOpenSidepanel,
  isManualRefreshing,
}) => {
  const [currentWindowId, setCurrentWindowId] = useState<number | undefined>(
    undefined,
  );

  useEffect(() => {
    (async () => {
      try {
        if (typeof chrome !== "undefined" && chrome.windows?.getCurrent) {
          const win = await chrome.windows.getCurrent();
          if (win?.id) setCurrentWindowId(win.id);
        }
      } catch {
        // Standalone preview mode
      }
    })();
  }, []);

  const isAutoPaginating =
    autoPaginateState?.status === "running" ||
    autoPaginateState?.status === "stopping";

  const navItems: {
    id: DashboardTab;
    label: string;
    count?: number;
    icon: React.ReactNode;
  }[] = [
    {
      id: "overview",
      label: "Overview",
      icon: <Radio className="w-4 h-4" aria-hidden="true" />,
    },
    {
      id: "sources",
      label: "API Datasets",
      count: metrics.endpointGroups,
      icon: <Layers className="w-4 h-4" aria-hidden="true" />,
    },
    {
      id: "records",
      label: "Extracted Data",
      count: metrics.uniqueRecords,
      icon: <Database className="w-4 h-4" aria-hidden="true" />,
    },
    {
      id: "responses",
      label: "Raw Traffic",
      count: metrics.responsesSaved,
      icon: <FileCode2 className="w-4 h-4" aria-hidden="true" />,
    },
    {
      id: "schemas",
      label: "Schemas",
      icon: <ArrowUpDown className="w-4 h-4" aria-hidden="true" />,
    },
    {
      id: "exports",
      label: "Labeled Exports",
      icon: <Download className="w-4 h-4" aria-hidden="true" />,
    },
    {
      id: "settings",
      label: "Settings & Privacy",
      icon: <Settings className="w-4 h-4" aria-hidden="true" />,
    },
  ];

  return (
    <header className="bg-white/95 backdrop-blur-md border-b border-stone-200/90 sticky top-0 z-40 shadow-card">
      <a href="#main-content" className="skip-link visually-hidden">
        Skip to main content
      </a>

      {/* Top Command Bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        {/* Left: Brand Identity + Session Switcher + Target Host */}
        <div className="flex items-center gap-3.5 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-xl bg-obsidian-900 border border-obsidian-800 flex items-center justify-center shadow-sm"
              aria-hidden="true"
            >
              <span className="relative flex h-3.5 w-3.5">
                <span className="inline-flex rounded-full h-3.5 w-3.5 bg-brand-400 ring-4 ring-brand-400/25"></span>
              </span>
            </div>
            <div>
              <h1 className="font-extrabold text-obsidian-900 tracking-tight text-sm sm:text-base leading-tight">
                API Data Collector
              </h1>
              <span className="text-[11px] text-stone-500 font-medium block">
                Live Multi-Page Extractor & CSV Studio
              </span>
            </div>
          </div>

          <div
            className="h-6 w-px bg-stone-200 hidden sm:block"
            aria-hidden="true"
          />

          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={status} />

            {allSessions.length > 1 && session && (
              <div>
                <label
                  htmlFor="header-session-switcher"
                  className="visually-hidden"
                >
                  Switch capture session
                </label>
                <select
                  id="header-session-switcher"
                  value={session.id}
                  onChange={(e) => onSelectSession(e.target.value)}
                  disabled={status === "recording" || status === "paused"}
                  className="px-2.5 py-1 bg-stone-50 border border-stone-200 rounded-lg text-xs font-semibold text-obsidian-900 max-w-[190px] truncate disabled:opacity-70"
                >
                  {allSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} (
                      {new Date(s.startedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      )
                    </option>
                  ))}
                </select>
              </div>
            )}

            {session?.targetTabId &&
              (status === "recording" || status === "paused") && (
                <button
                  type="button"
                  onClick={onFocusTargetTab}
                  className="inline-flex items-center gap-1.5 text-xs bg-brand-50 hover:bg-brand-100 text-brand-900 border border-brand-300 px-2.5 py-1 rounded-lg font-mono font-semibold transition"
                >
                  <span className="truncate max-w-[160px]">
                    {session.allowedHostnames[0] || "Target Tab"}
                  </span>
                  <ExternalLink
                    className="w-3 h-3 text-brand-700 flex-shrink-0"
                    aria-hidden="true"
                  />
                </button>
              )}
          </div>
        </div>

        {/* Right: Primary Capture & Pagination Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {(status === "recording" || isAutoPaginating) && (
            <button
              type="button"
              onClick={onOpenAutoPaginate}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition ${
                isAutoPaginating
                  ? "bg-obsidian-900 text-brand-300 border-obsidian-800 shadow-sm"
                  : "bg-brand-50 hover:bg-brand-100 text-brand-900 border-brand-300"
              }`}
            >
              {isAutoPaginating ? (
                <Loader2
                  className="w-3.5 h-3.5 animate-spin text-brand-400"
                  aria-hidden="true"
                />
              ) : (
                <FastForward
                  className="w-3.5 h-3.5 text-brand-700"
                  aria-hidden="true"
                />
              )}
              {isAutoPaginating
                ? `Fetching Page ${autoPaginateState?.pagesAttempted}/${autoPaginateState?.maxPages}`
                : "Fetch Pages"}
            </button>
          )}

          {status === "recording" ? (
            <button
              type="button"
              onClick={onPause}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-950 border border-amber-300 text-xs font-bold rounded-xl transition"
            >
              <Pause className="w-3.5 h-3.5" aria-hidden="true" /> Pause
            </button>
          ) : status === "paused" ? (
            <button
              type="button"
              onClick={onResume}
              className="btn-lime inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-brand-400 hover:bg-brand-300 text-obsidian-950 border border-brand-500 text-xs font-bold rounded-xl shadow-lime-glow transition"
            >
              <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />{" "}
              Resume
            </button>
          ) : (
            <button
              type="button"
              onClick={onStart}
              className="btn-lime inline-flex items-center gap-1.5 px-4 py-1.5 bg-brand-400 hover:bg-brand-300 text-obsidian-950 border border-brand-500 text-xs font-bold rounded-xl shadow-lime-glow transition"
            >
              <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />{" "}
              New Capture
            </button>
          )}

          {(status === "recording" || status === "paused") && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 text-xs font-bold rounded-xl transition"
            >
              <Square className="w-3.5 h-3.5 fill-current" aria-hidden="true" />{" "}
              Stop
            </button>
          )}

          {session &&
            (metrics.responsesObserved > 0 ||
              metrics.uniqueRecords > 0 ||
              metrics.endpointGroups > 0 ||
              metrics.captureErrors > 0) &&
            onClearTabData && (
              <button
                type="button"
                onClick={onClearTabData}
                title="Clear all fetched & extracted data for this tab"
                aria-label="Clear all captured data for active tab"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-stone-700 hover:text-amber-900 bg-white hover:bg-amber-50 rounded-xl border border-stone-200 hover:border-amber-300 text-xs font-semibold shadow-xs transition"
              >
                <Eraser
                  className="w-3.5 h-3.5 text-amber-600"
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">Clear Tab Data</span>
              </button>
            )}

          <button
            type="button"
            onClick={onRefresh}
            disabled={isManualRefreshing}
            aria-label="Sync dataset from local storage"
            className="p-2 text-stone-600 hover:text-obsidian-900 rounded-xl hover:bg-stone-100 border border-stone-200 transition"
          >
            <RefreshCw
              className={`w-4 h-4 ${isManualRefreshing ? "animate-spin text-brand-700" : ""}`}
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            onClick={() => onOpenSidepanel(currentWindowId)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-stone-700 hover:text-obsidian-900 rounded-xl hover:bg-stone-100 border border-stone-200 text-xs font-semibold transition"
          >
            <PanelRight className="w-4 h-4 text-brand-700" aria-hidden="true" />
            <span className="hidden xl:inline">Side Panel</span>
          </button>
        </div>
      </div>

      {/* Primary Workspace Navigation */}
      <nav
        aria-label="Primary"
        className="max-w-7xl mx-auto px-4 sm:px-6 border-t border-stone-100 flex gap-1 overflow-x-auto"
      >
        {navItems.map((item) => {
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onTabChange(item.id)}
              className={`inline-flex items-center gap-2 py-2.5 px-3.5 text-xs border-b-2 transition whitespace-nowrap ${
                isActive
                  ? "border-brand-600 text-obsidian-900 font-bold bg-brand-50/40"
                  : "border-transparent text-stone-600 hover:text-obsidian-900 hover:border-stone-300 font-medium"
              }`}
            >
              <span className={isActive ? "text-brand-700" : "text-stone-400"}>
                {item.icon}
              </span>
              <span>{item.label}</span>
              {item.count !== undefined && item.count > 0 && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold tabular-nums ${
                    isActive
                      ? "bg-brand-300 text-obsidian-950"
                      : "bg-stone-100 text-stone-700"
                  }`}
                >
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </header>
  );
};
