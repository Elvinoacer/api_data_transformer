import React from 'react';
import { StatusBadge } from './StatusBadge';
import { CaptureSession, CaptureStatus } from '../../shared/types';
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
} from 'lucide-react';

export type DashboardTab =
  | 'overview'
  | 'sources'
  | 'responses'
  | 'records'
  | 'schemas'
  | 'exports'
  | 'settings';

interface Props {
  currentTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  session: CaptureSession | null;
  status: CaptureStatus;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onOpenSidepanel: () => void;
  isRefreshing: boolean;
}

export const Header: React.FC<Props> = ({
  currentTab,
  onTabChange,
  session,
  status,
  onStart,
  onPause,
  onResume,
  onStop,
  onRefresh,
  onOpenSidepanel,
  isRefreshing,
}) => {
  const navItems: { id: DashboardTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <Radio className="w-4 h-4" /> },
    { id: 'sources', label: 'Sources', icon: <Layers className="w-4 h-4" /> },
    { id: 'responses', label: 'Raw Responses', icon: <FileCode2 className="w-4 h-4" /> },
    { id: 'records', label: 'Consolidated Records', icon: <Database className="w-4 h-4" /> },
    { id: 'schemas', label: 'Schemas', icon: <ArrowUpDown className="w-4 h-4" /> },
    { id: 'exports', label: 'Exports', icon: <Download className="w-4 h-4" /> },
    { id: 'settings', label: 'Settings & Privacy', icon: <Settings className="w-4 h-4" /> },
  ];

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-40 shadow-xs">
      {/* Top Banner Toolbar */}
      <div className="max-w-7xl mx-auto px-6 py-3 flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Brand & Target Tab */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-lg shadow-sm">
              LN
            </div>
            <div>
              <span className="font-bold text-slate-900 tracking-tight text-base block leading-tight">
                Live Network Data Collector
              </span>
              <span className="text-xs text-slate-500 font-medium">Manifest V3 DevTools Protocol</span>
            </div>
          </div>

          <div className="h-6 w-px bg-slate-200 hidden sm:block"></div>

          {/* Active Target Tab Display */}
          <div className="hidden sm:flex items-center gap-2">
            <StatusBadge status={status} />
            {session ? (
              <div className="text-xs text-slate-600">
                <span className="font-semibold text-slate-800">Target:</span>{' '}
                <span className="font-mono bg-slate-100 px-2 py-0.5 rounded text-indigo-700 font-medium">
                  {session.allowedHostnames[0] || 'Selected Tab'}
                </span>
              </div>
            ) : (
              <span className="text-xs text-slate-400">No active target</span>
            )}
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {status === 'recording' ? (
            <button
              onClick={onPause}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold rounded-lg shadow-sm transition"
            >
              <Pause className="w-3.5 h-3.5" /> Pause
            </button>
          ) : status === 'paused' ? (
            <button
              onClick={onResume}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
            >
              <Play className="w-3.5 h-3.5" /> Resume
            </button>
          ) : (
            <button
              onClick={onStart}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
            >
              <Play className="w-3.5 h-3.5" /> Start Capture
            </button>
          )}

          {(status === 'recording' || status === 'paused') && (
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
            >
              <Square className="w-3.5 h-3.5" /> Stop
            </button>
          )}

          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            title="Refresh saved metrics and database cache"
            className="p-1.5 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 border border-slate-200 transition"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-indigo-600' : ''}`} />
          </button>

          <button
            onClick={onOpenSidepanel}
            title="Open Side Panel"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 border border-slate-200 text-xs font-medium transition"
          >
            <PanelRight className="w-4 h-4" />
            <span className="hidden lg:inline">Side Panel</span>
          </button>
        </div>
      </div>

      {/* Navigation Tabs Bar */}
      <div className="max-w-7xl mx-auto px-6 border-t border-slate-100 flex gap-1 overflow-x-auto">
        {navItems.map((item) => {
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`inline-flex items-center gap-2 py-3 px-3 text-xs font-medium border-b-2 transition whitespace-nowrap ${
                isActive
                  ? 'border-indigo-600 text-indigo-600 font-semibold'
                  : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>
    </header>
  );
};
