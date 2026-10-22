import React from 'react';
import { CaptureError, CaptureSession, SessionMetrics } from '../../shared/types';
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
} from 'lucide-react';

interface Props {
  session: CaptureSession | null;
  metrics: SessionMetrics;
  errors: CaptureError[];
  onStartClick: () => void;
  onNavigateTab: (tab: any) => void;
}

export const Overview: React.FC<Props> = ({
  session,
  metrics,
  errors,
  onStartClick,
  onNavigateTab,
}) => {
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const metricCards = [
    {
      label: 'Responses Observed',
      value: metrics.responsesObserved,
      icon: <Activity className="w-5 h-5 text-indigo-500" />,
      sub: 'Eligible API responses seen',
    },
    {
      label: 'Responses Saved',
      value: metrics.responsesSaved,
      icon: <FileCheck2 className="w-5 h-5 text-emerald-500" />,
      sub: 'Raw bodies stored in IndexedDB',
    },
    {
      label: 'Unique Records',
      value: metrics.uniqueRecords,
      icon: <Database className="w-5 h-5 text-blue-500" />,
      sub: 'Consolidated entity count',
    },
    {
      label: 'Endpoint Groups',
      value: metrics.endpointGroups,
      icon: <Layers className="w-5 h-5 text-purple-500" />,
      sub: 'Normalized API paths',
    },
    {
      label: 'Storage Used',
      value: formatBytes(metrics.bytesStored),
      icon: <HardDrive className="w-5 h-5 text-amber-500" />,
      sub: 'Approximate local usage',
    },
    {
      label: 'Capture Errors',
      value: metrics.captureErrors,
      icon: <AlertTriangle className="w-5 h-5 text-rose-500" />,
      sub: 'Failed body / parse events',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Session Hero Banner */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-md">
                Active Session
              </span>
              <span className="text-xs text-slate-400">
                {session ? `ID: ${session.id}` : 'No active session'}
              </span>
            </div>
            <h2 className="text-xl font-bold text-slate-900">
              {session ? session.label : 'Ready to capture API responses'}
            </h2>
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
              <div className="flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-slate-400" />
                <span>
                  Host scope:{' '}
                  <strong className="text-slate-700">
                    {session?.allowedHostnames.join(', ') || 'None selected'}
                  </strong>
                </span>
              </div>
              {session?.startedAt && (
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                  <span>
                    Started: {new Date(session.startedAt).toLocaleTimeString()}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {!session || session.status === 'idle' || session.status === 'stopped' ? (
              <button
                onClick={onStartClick}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg shadow-sm transition"
              >
                <Sparkles className="w-4 h-4" />
                Start Capturing a Tab
              </button>
            ) : (
              <button
                onClick={() => onNavigateTab('records')}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-sm font-semibold rounded-lg transition"
              >
                <Database className="w-4 h-4 text-indigo-600" />
                View Consolidated Records
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {metricCards.map((card, idx) => (
          <div
            key={idx}
            className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 flex items-start justify-between"
          >
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                {card.label}
              </p>
              <h3 className="text-2xl font-bold text-slate-900 tracking-tight mb-1">
                {card.value}
              </h3>
              <p className="text-xs text-slate-400">{card.sub}</p>
            </div>
            <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-100">
              {card.icon}
            </div>
          </div>
        ))}
      </div>

      {/* Two-Tab Workflow Explanation & Recent Errors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Workflow Guide */}
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 space-y-4">
          <h3 className="font-bold text-slate-900 text-base">Two-Tab Browsing Workflow</h3>
          <p className="text-sm text-slate-600">
            You operate the target website normally in its tab (authenticate, paginate, search, filter). The collector observes permitted JSON responses without replaying requests or saving passwords.
          </p>
          <div className="space-y-3 pt-2">
            <div className="flex gap-3 text-xs text-slate-600">
              <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center flex-shrink-0">
                1
              </span>
              <span>
                <strong>Attach:</strong> Pick an open browser tab or open a new target tab.
              </span>
            </div>
            <div className="flex gap-3 text-xs text-slate-600">
              <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center flex-shrink-0">
                2
              </span>
              <span>
                <strong>Browse:</strong> Navigate pages 1, 2, 3 on the target site. Network responses accumulate automatically.
              </span>
            </div>
            <div className="flex gap-3 text-xs text-slate-600">
              <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center flex-shrink-0">
                3
              </span>
              <span>
                <strong>Deduplicate & Export:</strong> Inspect schemas, review unique rows, and export clean CSV or JSONL.
              </span>
            </div>
          </div>
        </div>

        {/* Recent Error / Event Log */}
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Recent Event & Error Log
            </h3>
            <span className="text-xs text-slate-400">{errors.length} events logged</span>
          </div>

          <div className="flex-1 overflow-y-auto max-h-60 space-y-2.5">
            {errors.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                No capture errors or warnings reported. System operating normally.
              </div>
            ) : (
              errors.slice(0, 10).map((err) => (
                <div
                  key={err.id}
                  className="p-3 bg-rose-50/60 border border-rose-200 rounded-lg text-xs space-y-1"
                >
                  <div className="flex items-center justify-between text-rose-800 font-semibold">
                    <span className="capitalize">{err.kind.replace('_', ' ')}</span>
                    <span className="text-[10px] text-rose-500 font-mono">
                      {new Date(err.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-slate-700">{err.message}</p>
                  {err.url && (
                    <p className="text-[11px] font-mono text-slate-500 truncate">{err.url}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
