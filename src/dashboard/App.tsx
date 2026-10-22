import React, { useState, useEffect, useCallback } from 'react';
import { Header, DashboardTab } from './components/Header';
import { Overview } from './pages/Overview';
import { Sources } from './pages/Sources';
import { Responses } from './pages/Responses';
import { Records } from './pages/Records';
import { Schemas } from './pages/Schemas';
import { Exports } from './pages/Exports';
import { Settings } from './pages/Settings';
import { TabPickerModal } from './components/TabPickerModal';
import {
  calculateSessionMetrics,
  errorRepo,
  rawResponseRepo,
  recordRepo,
  schemaRepo,
  sessionRepo,
  sourceRepo,
} from '../data/repositories';
import {
  CaptureError,
  CaptureSession,
  CaptureStatus,
  EndpointSchema,
  EndpointSource,
  ExtractedRecord,
  RawResponse,
  SessionMetrics,
} from '../shared/types';
import { sendExtensionMessage } from '../messaging/protocol';

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<DashboardTab>('overview');
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [sources, setSources] = useState<EndpointSource[]>([]);
  const [responses, setResponses] = useState<RawResponse[]>([]);
  const [records, setRecords] = useState<ExtractedRecord[]>([]);
  const [schemas, setSchemas] = useState<EndpointSchema[]>([]);
  const [errors, setErrors] = useState<CaptureError[]>([]);
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isReprocessing, setIsReprocessing] = useState(false);

  // Load all session data from IndexedDB
  const refreshData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      // 1. Check active session
      let currentSession = await sessionRepo.getActiveSession();
      if (!currentSession) {
        const all = await sessionRepo.getAllSessions();
        currentSession = all[0] || null;
      }

      setSession(currentSession || null);
      setStatus(currentSession?.status || 'idle');

      if (currentSession) {
        const [
          fetchedSources,
          fetchedResponses,
          fetchedRecords,
          fetchedSchemas,
          fetchedErrors,
          calculatedMetrics,
        ] = await Promise.all([
          sourceRepo.getSourcesBySession(currentSession.id),
          rawResponseRepo.getBySession(currentSession.id, 100),
          recordRepo.getAllRecordsBySession(currentSession.id),
          schemaRepo.getSchemasBySession(currentSession.id),
          errorRepo.getErrorsBySession(currentSession.id, 20),
          calculateSessionMetrics(currentSession.id),
        ]);

        setSources(fetchedSources);
        setResponses(fetchedResponses);
        setRecords(fetchedRecords);
        setSchemas(fetchedSchemas);
        setErrors(fetchedErrors);
        setMetrics(calculatedMetrics);
      } else {
        setSources([]);
        setResponses([]);
        setRecords([]);
        setSchemas([]);
        setErrors([]);
        setMetrics({
          responsesObserved: 0,
          responsesSaved: 0,
          captureErrors: 0,
          parsedRecords: 0,
          uniqueRecords: 0,
          endpointGroups: 0,
          bytesStored: 0,
        });
      }
    } catch (err) {
      console.error('Error refreshing dashboard data:', err);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refreshData();

    // Auto-refresh poll every 2 seconds when recording or paused
    const interval = setInterval(() => {
      refreshData();
    }, 2000);

    return () => clearInterval(interval);
  }, [refreshData]);

  const handleStartCapture = async (
    tabId: number,
    originalUrl: string,
    allowedHostnames: string[]
  ) => {
    try {
      setStatus('starting');
      const res = await sendExtensionMessage<any, CaptureSession>('START_CAPTURE', {
        tabId,
        originalUrl,
        allowedHostnames,
      });

      if (res.success && res.data) {
        setSession(res.data);
        setStatus('recording');
        await refreshData();
      } else {
        alert(res.error || 'Failed to start capture session');
        setStatus('idle');
      }
    } catch (err: any) {
      alert(err.message || 'Error initiating capture');
      setStatus('idle');
    }
  };

  const handlePause = async () => {
    if (!session) return;
    await sendExtensionMessage('PAUSE_CAPTURE', { sessionId: session.id });
    setStatus('paused');
    await refreshData();
  };

  const handleResume = async () => {
    if (!session) return;
    await sendExtensionMessage('RESUME_CAPTURE', { sessionId: session.id });
    setStatus('recording');
    await refreshData();
  };

  const handleStop = async () => {
    if (!session) return;
    await sendExtensionMessage('STOP_CAPTURE', { sessionId: session.id });
    setStatus('stopped');
    await refreshData();
  };

  const handleReprocess = async () => {
    if (!session) return;
    setIsReprocessing(true);
    try {
      await sendExtensionMessage('REPROCESS_SESSION', { sessionId: session.id });
      await refreshData();
    } finally {
      setIsReprocessing(false);
    }
  };

  const handleOpenSidepanel = async () => {
    await sendExtensionMessage('OPEN_SIDEPANEL');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Header
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        session={session}
        status={status}
        onStart={() => setIsTabPickerOpen(true)}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onRefresh={refreshData}
        onOpenSidepanel={handleOpenSidepanel}
        isRefreshing={isRefreshing}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-6">
        {currentTab === 'overview' && (
          <Overview
            session={session}
            metrics={metrics}
            errors={errors}
            onStartClick={() => setIsTabPickerOpen(true)}
            onNavigateTab={setCurrentTab}
          />
        )}

        {currentTab === 'sources' && (
          <Sources
            sources={sources}
            sessionId={session?.id}
            onRefreshSources={refreshData}
            onReprocess={handleReprocess}
            isReprocessing={isReprocessing}
          />
        )}

        {currentTab === 'responses' && <Responses responses={responses} />}

        {currentTab === 'records' && <Records records={records} sources={sources} />}

        {currentTab === 'schemas' && <Schemas schemas={schemas} sources={sources} />}

        {currentTab === 'exports' && (
          <Exports
            session={session}
            sources={sources}
            records={records}
            rawResponses={responses}
          />
        )}

        {currentTab === 'settings' && (
          <Settings session={session} onSessionCleared={refreshData} />
        )}
      </main>

      {/* Tab Picker Modal */}
      <TabPickerModal
        isOpen={isTabPickerOpen}
        onClose={() => setIsTabPickerOpen(false)}
        onSelectTab={handleStartCapture}
      />
    </div>
  );
};
