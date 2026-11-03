import React, { useState } from 'react';
import {
  ActivityEvent,
  CaptureError,
  CaptureSession,
  EndpointSource,
  ExtractedRecord,
  SessionMetrics,
} from '../../shared/types';
import { getMissingPages } from '../../extraction/pagination-detector';
import {
  Activity,
  FileCheck2,
  AlertTriangle,
  Database,
  Layers,
  HardDrive,
  Clock,
  Globe,
  Sparkles,
  Edit2,
  Check,
  X,
  FastForward,
  Download,
  ArrowRight,
  Cpu,
  User,
} from 'lucide-react';
import { DashboardTab } from '../components/Header';

interface Props {
  session: CaptureSession | null;
  sources: EndpointSource[];
  records: ExtractedRecord[];
  metrics: SessionMetrics;
  errors: CaptureError[];
  activities: ActivityEvent[];
  onStartClick: () => void;
  onRenameSession: (newLabel: string) => Promise<void>;
  onNavigateTab: (tab: DashboardTab, sourceId?: string) => void;
  onOpenAutoPaginate: (sourceId?: string) => void;
  onQuickExportSource: (source: EndpointSource) => void;
}

export const Overview: React.FC<Props> = ({
  session,
  sources,
  records,
  metrics,
  errors,
  activities,
  onStartClick,
  onRenameSession,
  onNavigateTab,
  onOpenAutoPaginate,
  onQuickExportSource,
}) => {
  const [isEditingSessionLabel, setIsEditingSessionLabel] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const handleSaveSessionLabel = async () => {
    if (draftLabel.trim()) {
      await onRenameSession(draftLabel.trim());
    }
    setIsEditingSessionLabel(false);
  };

  // Count unique records per source
  const recordCountBySource = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of records) {
      counts.set(r.sourceId, (counts.get(r.sourceId) || 0) + 1);
    }
    return counts;
  }, [records]);

  const metricCards: {
    label: string;
    value: string | number;
    icon: React.ReactNode;
    sub: string;
    targetTab?: DashboardTab;
  }[] = [
    {
      label: 'Unique Entities',
      value: metrics.uniqueRecords,
      icon: <Database className="w-5 h-5 text-brand-700" aria-hidden="true" />,
      sub: `${metrics.parsedRecords} total items parsed`,
      targetTab: 'records',
    },
    {
      label: 'API Datasets',
      value: metrics.endpointGroups,
      icon: <Layers className="w-5 h-5 text-brand-700" aria-hidden="true" />,
      sub: 'Auto-labeled endpoint groups',
      targetTab: 'sources',
    },
    {
      label: 'Responses Saved',
      value: metrics.responsesSaved,
      icon: <FileCheck2 className="w-5 h-5 text-brand-700" aria-hidden="true" />,
      sub: `${metrics.responsesObserved} network events observed`,
      targetTab: 'responses',
    },
    {
      label: 'Local Storage',
      value: formatBytes(metrics.bytesStored),
      icon: <HardDrive className="w-5 h-5 text-stone-600" aria-hidden="true" />,
      sub: 'IndexedDB zero-cloud store',
      targetTab: 'settings',
    },
    {
      label: 'Capture Health',
      value: metrics.captureErrors === 0 ? 'Healthy' : `${metrics.captureErrors} issue(s)`,
      icon:
        metrics.captureErrors === 0 ? (
          <Activity className="w-5 h-5 text-brand-700" aria-hidden="true" />
        ) : (
          <AlertTriangle className="w-5 h-5 text-amber-600" aria-hidden="true" />
        ),
      sub:
        metrics.captureErrors === 0
          ? 'All JSON payloads decoded cleanly'
          : 'Review event log below',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Executive Session Hero Banner */}
      <div className="card-surface bg-obsidian-900 text-white rounded-2xl shadow-elevated border border-obsidian-800 p-6 sm:p-7 relative overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div className="space-y-2.5 max-w-2xl">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-[11px] font-bold uppercase tracking-wider text-obsidian-950 bg-brand-400 px-2.5 py-0.5 rounded-md">
                {session ? `Session • ${session.status}` : 'Workspace Ready'}
              </span>
              {session?.scopeMode && (
                <span className="text-[11px] font-mono text-brand-200 bg-obsidian-800 border border-stone-700 px-2 py-0.5 rounded-md">
                  {session.scopeMode === 'all_tab_apis'
                    ? 'Scope: All Tab APIs'
                    : session.scopeMode === 'same_domain'
                    ? 'Scope: Root Domain + Subdomains'
                    : 'Scope: Strict Host'}
                </span>
              )}
            </div>

            {session && isEditingSessionLabel ? (
              <div className="flex items-center gap-2 max-w-md">
                <label htmlFor="edit-session-label-input" className="visually-hidden">
                  Session label
                </label>
                <input
                  id="edit-session-label-input"
                  type="text"
                  autoFocus
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveSessionLabel();
                    if (e.key === 'Escape') setIsEditingSessionLabel(false);
                  }}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-obsidian-800 border border-brand-400 text-white text-sm font-bold focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveSessionLabel}
                  aria-label="Save session label"
                  className="p-1.5 rounded-lg bg-brand-400 text-obsidian-950 hover:bg-brand-300"
                >
                  <Check className="w-4 h-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditingSessionLabel(false)}
                  aria-label="Cancel editing session label"
                  className="p-1.5 rounded-lg bg-obsidian-800 text-stone-300 hover:text-white"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2.5">
                <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight text-white">
                  {session ? session.label : 'Capture & Label Live Website APIs'}
                </h2>
                {session && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftLabel(session.label);
                      setIsEditingSessionLabel(true);
                    }}
                    aria-label="Rename session"
                    className="p-1.5 text-stone-400 hover:text-brand-300 rounded-lg hover:bg-obsidian-800 transition"
                  >
                    <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4 text-xs text-stone-300">
              <div className="flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />
                <span>
                  Target:{' '}
                  <strong className="text-white font-mono">
                    {session?.allowedHostnames.join(', ') || 'No tab attached yet'}
                  </strong>
                </span>
              </div>
              {session?.startedAt && (
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />
                  <span className="tabular-nums">
                    Started {new Date(session.startedAt).toLocaleTimeString()}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {!session ||
            session.status === 'idle' ||
            session.status === 'stopped' ||
            session.status === 'detached' ||
            session.status === 'error' ? (
              <button
                type="button"
                onClick={onStartClick}
                className="btn-lime inline-flex items-center gap-2 px-5 py-2.5 bg-brand-400 hover:bg-brand-300 text-obsidian-950 text-xs sm:text-sm font-extrabold rounded-xl shadow-lime-glow transition"
              >
                <Sparkles className="w-4 h-4" aria-hidden="true" />
                Select Tab & Start Capture
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onOpenAutoPaginate()}
                  className="btn-lime inline-flex items-center gap-2 px-4 py-2.5 bg-brand-400 hover:bg-brand-300 text-obsidian-950 text-xs font-extrabold rounded-xl shadow-lime-glow transition"
                >
                  <FastForward className="w-4 h-4" aria-hidden="true" />
                  Auto-Fetch Pages
                </button>
                <button
                  type="button"
                  onClick={() => onNavigateTab('exports')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-obsidian-800 hover:bg-stone-800 text-white border border-stone-700 text-xs font-bold rounded-xl transition"
                >
                  <Download className="w-4 h-4 text-brand-400" aria-hidden="true" />
                  Export Labeled CSV
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Key Metrics Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        {metricCards.map((card) => (
          <div
            key={card.label}
            onClick={() => card.targetTab && onNavigateTab(card.targetTab)}
            className={`card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 p-4 flex flex-col justify-between transition ${
              card.targetTab ? 'cursor-pointer hover:border-brand-400 hover:shadow-md' : ''
            }`}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[11px] font-bold text-stone-500 uppercase tracking-wider">
                {card.label}
              </span>
              <div className="p-2 bg-brand-50 rounded-xl border border-brand-200/70">
                {card.icon}
              </div>
            </div>
            <div>
              <p className="text-2xl font-extrabold text-obsidian-900 tracking-tight tabular-nums">
                {card.value}
              </p>
              <p className="text-[11px] text-stone-500 mt-0.5">{card.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Labeled API Datasets & Multi-Page Progress */}
      <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="font-bold text-obsidian-900 text-base flex items-center gap-2">
              <Layers className="w-4 h-4 text-brand-700" aria-hidden="true" />
              Discovered API Datasets & Pagination Coverage
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Each API is automatically labeled by resource name (e.g., Customers, Medicines) and tracked across pages.
            </p>
          </div>
          {sources.length > 0 && (
            <button
              type="button"
              onClick={() => onNavigateTab('sources')}
              className="inline-flex items-center gap-1 text-xs font-bold text-brand-800 hover:text-brand-950 transition"
            >
              Configure all datasets <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        {sources.length === 0 ? (
          <div className="py-10 px-4 text-center rounded-xl bg-stone-50/80 border border-dashed border-stone-300">
            <p className="text-sm font-bold text-obsidian-900 mb-1">
              No API Datasets Observed Yet
            </p>
            <p className="text-xs text-stone-600 max-w-lg mx-auto">
              Attach to a website tab and browse, search, or click through pages. Every JSON API endpoint will appear here with a clean dataset label and pagination tracker.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sources.map((src) => {
              const count = recordCountBySource.get(src.id) || 0;
              const pag = src.pagination;
              const missing = getMissingPages(pag);
              const totalExpected = pag?.totalRecords;
              const progressPct =
                totalExpected && totalExpected > 0
                  ? Math.min(100, Math.round((count / totalExpected) * 100))
                  : pag?.totalPages && pag.totalPages > 0
                  ? Math.min(100, Math.round((pag.observedPages.length / pag.totalPages) * 100))
                  : null;

              return (
                <div
                  key={src.id}
                  className="p-4 rounded-xl border border-stone-200 hover:border-brand-400 bg-stone-50/40 flex flex-col justify-between gap-3 transition"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-extrabold bg-brand-100 text-brand-950 border border-brand-300">
                            {src.label}
                          </span>
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-stone-200/80 text-obsidian-900">
                            {src.httpMethod}
                          </span>
                        </div>
                        <p
                          className="text-[11px] font-mono text-stone-500 mt-1.5 truncate max-w-sm"
                          title={src.normalizedEndpoint}
                        >
                          {src.normalizedEndpoint}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="text-lg font-extrabold text-obsidian-900 tabular-nums">
                          {count}
                        </span>
                        <span className="text-[11px] text-stone-500 block">
                          {totalExpected ? `of ${totalExpected} items` : 'unique rows'}
                        </span>
                      </div>
                    </div>

                    {pag && (pag.totalPages || pag.observedPages.length > 0 || pag.hasNextPage) && (
                      <div className="mt-3 pt-2.5 border-t border-stone-200/70 space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] text-stone-600">
                          <span>
                            {pag.totalPages
                              ? `Pages captured: ${pag.observedPages.length} of ${pag.totalPages}`
                              : pag.hasNextPage
                              ? 'More pages available via cursor/next link'
                              : `${src.observedCount} response(s) captured`}
                          </span>
                          {progressPct !== null && (
                            <span className="font-mono font-bold text-brand-800 tabular-nums">
                              {progressPct}%
                            </span>
                          )}
                        </div>
                        {progressPct !== null && (
                          <progress
                            value={progressPct}
                            max={100}
                            className="w-full h-1.5 rounded-full overflow-hidden"
                          />
                        )}
                        {missing.length > 0 && (
                          <p className="text-[11px] text-amber-800 font-medium">
                            Remaining pages: {missing.slice(0, 6).join(', ')}
                            {missing.length > 6 ? ` (+${missing.length - 6} more)` : ''}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-stone-200/60">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onNavigateTab('records', src.id)}
                        className="px-2.5 py-1 rounded-lg bg-white hover:bg-stone-100 border border-stone-200 text-[11px] font-bold text-obsidian-900 transition"
                      >
                        View Data
                      </button>
                      {(missing.length > 0 || pag?.hasNextPage) &&
                        session?.status === 'recording' && (
                          <button
                            type="button"
                            onClick={() => onOpenAutoPaginate(src.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-100 hover:bg-brand-200 border border-brand-300 text-[11px] font-bold text-brand-950 transition"
                          >
                            <FastForward className="w-3 h-3" aria-hidden="true" />
                            Fetch Pages
                          </button>
                        )}
                    </div>

                    <button
                      type="button"
                      disabled={count === 0}
                      onClick={() => onQuickExportSource(src)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-obsidian-900 hover:bg-obsidian-800 disabled:opacity-40 text-brand-300 text-[11px] font-bold transition"
                    >
                      <Download className="w-3 h-3" aria-hidden="true" />
                      Export {src.label} CSV
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* System & User Action Log + Workflow Guide */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Live System & User Activity Stream */}
        <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-obsidian-900 text-base flex items-center gap-2">
              <Activity className="w-4 h-4 text-brand-700" aria-hidden="true" />
              System & User Action Log
            </h3>
            <span className="text-xs text-stone-500 tabular-nums">
              {activities.length + errors.length} events
            </span>
          </div>

          <div className="flex-1 overflow-y-auto max-h-64 space-y-2 pr-1">
            {errors.map((err) => (
              <div
                key={err.id}
                className="p-3 bg-rose-50/70 border border-rose-200 rounded-xl text-xs space-y-1"
              >
                <div className="flex items-center justify-between text-rose-900 font-bold">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-600" aria-hidden="true" />
                    System Warning ({err.kind.replace('_', ' ')})
                  </span>
                  <span className="text-[10px] text-rose-700 font-mono tabular-nums">
                    {new Date(err.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-stone-700">{err.message}</p>
                {err.url && (
                  <p className="text-[11px] font-mono text-stone-500 truncate">{err.url}</p>
                )}
              </div>
            ))}

            {activities.length === 0 && errors.length === 0 ? (
              <div className="py-10 text-center text-xs text-stone-500">
                System and user actions will appear here in real time as APIs are captured, paginated, and exported.
              </div>
            ) : (
              activities.map((ev) => (
                <div
                  key={ev.id}
                  className="p-2.5 bg-stone-50/80 border border-stone-200/80 rounded-xl text-xs flex items-start justify-between gap-3"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span
                      className={`mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase flex-shrink-0 ${
                        ev.actor === 'system'
                          ? 'bg-obsidian-900 text-brand-300'
                          : 'bg-brand-100 text-brand-950 border border-brand-300'
                      }`}
                    >
                      {ev.actor === 'system' ? (
                        <Cpu className="w-2.5 h-2.5" aria-hidden="true" />
                      ) : (
                        <User className="w-2.5 h-2.5" aria-hidden="true" />
                      )}
                      {ev.actor}
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold text-obsidian-900 leading-snug">{ev.message}</p>
                      {ev.detail && (
                        <p className="text-[11px] text-stone-500 font-mono truncate mt-0.5">
                          {ev.detail}
                        </p>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-stone-400 tabular-nums whitespace-nowrap">
                    {new Date(ev.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Best-Practice Workflow Card */}
        <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 p-6 space-y-4">
          <h3 className="font-bold text-obsidian-900 text-base">
            How Smart Multi-Page Extraction Works
          </h3>
          <p className="text-xs text-stone-600 leading-relaxed">
            Your browser tab keeps full control of authentication and sessions while this workspace automatically reads JSON APIs, detects pagination, and labels each dataset cleanly.
          </p>
          <ol className="space-y-3 pt-1">
            {[
              {
                step: '1',
                title: 'Attach to Any Website Tab',
                desc: 'Captures REST, GraphQL (by operationName), JSON:API, cursor feeds, and cross-subdomain api.* backends automatically.',
              },
              {
                step: '2',
                title: 'Collect All Pages Effortlessly',
                desc: 'Browse manually or launch Auto-Fetch Pages to click Next, scroll feeds, or walk ?page=2..N with polite pacing.',
              },
              {
                step: '3',
                title: 'Export Clean Labeled Datasets',
                desc: 'Rename datasets (e.g., Customers, Medicines, Orders), pick readable columns, and export separate labeled CSVs in one click.',
              },
            ].map((item) => (
              <li key={item.step} className="flex gap-3 text-xs text-stone-700">
                <span className="w-6 h-6 rounded-lg bg-brand-200 text-obsidian-950 font-extrabold flex items-center justify-center flex-shrink-0">
                  {item.step}
                </span>
                <div>
                  <strong className="text-obsidian-900 block mb-0.5">{item.title}</strong>
                  <span className="text-stone-600 leading-relaxed">{item.desc}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
};
