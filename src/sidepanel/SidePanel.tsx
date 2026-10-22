import React, { useState, useEffect, useCallback } from 'react';
import { StatusBadge } from '../dashboard/components/StatusBadge';
import { TabPickerModal } from '../dashboard/components/TabPickerModal';
import {
  calculateSessionMetrics,
  rawResponseRepo,
  sessionRepo,
  sourceRepo,
} from '../data/repositories';
import {
  CaptureSession,
  CaptureStatus,
  EndpointSource,
  RawResponse,
  SessionMetrics,
} from '../shared/types';
import { sendExtensionMessage } from '../messaging/protocol';
import {
  Play,
  Pause,
  Square,
  ExternalLink,
  Layers,
  Database,
  Activity,
  Globe,
} from 'lucide-react';

export const SidePanel: React.FC = () => {
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [sources, setSources] = useState<EndpointSource[]>([]);
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

  const refresh = useCallback(async () => {
    try {
      let currentSession = await sessionRepo.getActiveSession();
      if (!currentSession) {
        const all = await sessionRepo.getAllSessions();
        currentSession = all[0] || null;
      }

      setSession(currentSession || null);
      setStatus(currentSession?.status || 'idle');

      if (currentSession) {
        const [fetchedSources, fetchedResponses, calculatedMetrics] = await Promise.all([
          sourceRepo.getSourcesBySession(currentSession.id),
          rawResponseRepo.getBySession(currentSession.id, 5),
          calculateSessionMetrics(currentSession.id),
        ]);

        setSources(fetchedSources);
        setRecentResponses(fetchedResponses);
        setMetrics(calculatedMetrics);
      }
    } catch (err) {
      console.error('Error refreshing side panel:', err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleStart = async (
    tabId: number,
    originalUrl: string,
    allowedHostnames: string[]
  ) => {
    await sendExtensionMessage('START_CAPTURE', {
      tabId,
      originalUrl,
      allowedHostnames,
    });
    await refresh();
  };

  const handlePause = async () => {
    if (!session) return;
    await sendExtensionMessage('PAUSE_CAPTURE', { sessionId: session.id });
    await refresh();
  };

  const handleResume = async () => {
    if (!session) return;
    await sendExtensionMessage('RESUME_CAPTURE', { sessionId: session.id });
    await refresh();
  };

  const handleStop = async () => {
    if (!session) return;
    await sendExtensionMessage('STOP_CAPTURE', { sessionId: session.id });
    await refresh();
  };

  const handleOpenDashboard = async () => {
    await sendExtensionMessage('OPEN_DASHBOARD');
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 flex flex-col text-slate-800">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-200 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-indigo-600 text-white flex items-center justify-center font-bold text-xs">
            LN
          </div>
          <span className="font-bold text-sm text-slate-900">Live Collector</span>
        </div>
        <button
          onClick={handleOpenDashboard}
          title="Open Full Dashboard in Tab"
          className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 rounded text-xs font-semibold text-slate-700 transition"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Dashboard
        </button>
      </div>

      {/* Target Tab Status */}
      <div className="bg-white rounded-lg p-3 border border-slate-200 mb-4 shadow-xs">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase text-slate-400">Target Tab</span>
          <StatusBadge status={status} />
        </div>
        {session ? (
          <div className="flex items-center gap-2 text-xs">
            <Globe className="w-4 h-4 text-indigo-500 flex-shrink-0" />
            <span className="font-mono font-medium truncate text-slate-800">
              {session.allowedHostnames[0] || 'Active tab'}
            </span>
          </div>
        ) : (
          <p className="text-xs text-slate-400">No active recording session</p>
        )}
      </div>

      {/* Controls */}
      <div className="flex gap-2 mb-4">
        {status === 'recording' ? (
          <button
            onClick={handlePause}
            className="flex-1 py-2 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 shadow-xs transition"
          >
            <Pause className="w-3.5 h-3.5" /> Pause
          </button>
        ) : status === 'paused' ? (
          <button
            onClick={handleResume}
            className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 shadow-xs transition"
          >
            <Play className="w-3.5 h-3.5" /> Resume
          </button>
        ) : (
          <button
            onClick={() => setIsTabPickerOpen(true)}
            className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 shadow-xs transition"
          >
            <Play className="w-3.5 h-3.5" /> Start Capture
          </button>
        )}

        {(status === 'recording' || status === 'paused') && (
          <button
            onClick={handleStop}
            className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 shadow-xs transition"
          >
            <Square className="w-3.5 h-3.5" /> Stop
          </button>
        )}
      </div>

      {/* Live Counters */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-white p-3 rounded-lg border border-slate-200">
          <div className="flex items-center gap-1.5 text-slate-400 text-[10px] font-semibold uppercase mb-1">
            <Activity className="w-3.5 h-3.5 text-indigo-500" /> Responses
          </div>
          <div className="text-xl font-bold text-slate-900">{metrics.responsesSaved}</div>
          <div className="text-[10px] text-slate-400">{metrics.responsesObserved} seen</div>
        </div>

        <div className="bg-white p-3 rounded-lg border border-slate-200">
          <div className="flex items-center gap-1.5 text-slate-400 text-[10px] font-semibold uppercase mb-1">
            <Database className="w-3.5 h-3.5 text-emerald-500" /> Unique Records
          </div>
          <div className="text-xl font-bold text-slate-900">{metrics.uniqueRecords}</div>
          <div className="text-[10px] text-slate-400">{metrics.endpointGroups} endpoints</div>
        </div>
      </div>

      {/* Sources pills */}
      {sources.length > 0 && (
        <div className="mb-4 bg-white p-2.5 rounded-lg border border-slate-200">
          <span className="text-[10px] font-semibold uppercase text-slate-400 block mb-1.5">
            Active Sources ({sources.length})
          </span>
          <div className="flex flex-wrap gap-1">
            {sources.map((s) => (
              <span key={s.id} className="text-[10px] bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded font-mono font-medium">
                {s.httpMethod} {s.normalizedEndpoint.split('/').pop()}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recent Activity */}
      <div className="bg-white rounded-lg p-3 border border-slate-200 flex-1 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase text-slate-400 flex items-center gap-1">
            <Layers className="w-3.5 h-3.5" /> Recent Responses
          </span>
          <span className="text-[10px] text-slate-400">{recentResponses.length}</span>
        </div>

        <div className="space-y-2 flex-1 overflow-y-auto">
          {recentResponses.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400">
              No responses observed yet.
            </div>
          ) : (
            recentResponses.map((r) => (
              <div
                key={r.id}
                className="p-2 bg-slate-50 border border-slate-100 rounded text-xs space-y-0.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-[10px] text-slate-700">
                    {r.httpMethod} {r.httpStatus}
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {new Date(r.capturedAt).toLocaleTimeString()}
                  </span>
                </div>
                <p className="truncate text-slate-600 font-mono text-[11px]" title={r.url}>
                  {r.url.split('/').slice(-2).join('/')}
                </p>
              </div>
            ))
          )}
        </div>
      </div>

      <TabPickerModal
        isOpen={isTabPickerOpen}
        onClose={() => setIsTabPickerOpen(false)}
        onSelectTab={handleStart}
      />
    </div>
  );
};
