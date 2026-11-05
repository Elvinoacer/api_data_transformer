import React, { useState, useEffect, useCallback } from "react";
import { CaptureSession, GlobalSettings, ScopeMode } from "../../shared/types";
import {
  activityRepo,
  sessionRepo,
  settingsRepo,
} from "../../data/repositories";
import {
  Settings as SettingsIcon,
  Shield,
  Trash2,
  Database,
  AlertTriangle,
  Plus,
  X,
  RotateCcw,
  RefreshCw,
  Send,
  CheckCircle2,
  Eye,
  EyeOff,
  Radio,
  Sparkles,
  Eraser,
} from "lucide-react";
import { DEFAULT_SETTINGS } from "../../shared/constants";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { SphereSyncClient, SyncConfig } from "../../sync/sphere-client";
import {
  ClearAllDataPayload,
  ClearTabDataPayload,
  ClearTabDataResult,
  sendExtensionMessage,
} from "../../messaging/protocol";

interface Props {
  session: CaptureSession | null;
  onSessionCleared: () => Promise<void> | void;
  onDataCleared?: () => Promise<void> | void;
}

export const Settings: React.FC<Props> = ({
  session,
  onSessionCleared,
  onDataCleared,
}) => {
  const { notify } = useToast();
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  const [newParam, setNewParam] = useState("");
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    | "clear_tab_data"
    | "clear_records"
    | "delete_session"
    | "clear_sync_queue"
    | "clear_all_captured"
    | "clear_all_global"
    | null
  >(null);

  // Sphere Pharmacy Sync State
  const [sphereConfig, setSphereConfig] = useState<SyncConfig>({
    endpointUrl: "",
    apiKey: "",
    enabled: false,
    pharmacyId: "DEFAULT_STORE",
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [queueStats, setQueueStats] = useState({
    pending: 0,
    syncing: 0,
    failed: 0,
    total: 0,
  });
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [flushingQueue, setFlushingQueue] = useState(false);
  const [pollingBandaGo, setPollingBandaGo] = useState(false);

  const refreshQueueStats = useCallback(async () => {
    try {
      const stats = await SphereSyncClient.getQueueStats();
      setQueueStats(stats);
    } catch {
      // Ignore background error
    }
  }, []);

  useEffect(() => {
    settingsRepo.getSettings().then(setSettings);
    SphereSyncClient.getConfig().then(setSphereConfig);
    refreshQueueStats();

    const interval = setInterval(refreshQueueStats, 5000);
    return () => clearInterval(interval);
  }, [refreshQueueStats]);

  const handleUpdateSettings = async (
    updates: Partial<GlobalSettings>,
    label: string,
  ) => {
    const updated = await settingsRepo.saveSettings(updates);
    setSettings(updated);
    if (session) {
      await activityRepo.logEvent({
        sessionId: session.id,
        actor: "user",
        category: "config",
        message: `Updated setting: ${label}`,
      });
    }
    notify({
      title: "Preference saved",
      description: label,
      variant: "success",
      actor: "user",
    });
  };

  const ensureOriginPermission = async (
    endpointUrl: string,
  ): Promise<boolean> => {
    if (!endpointUrl) return true;
    try {
      if (typeof chrome !== "undefined" && chrome.permissions?.request) {
        const parsed = new URL(endpointUrl);
        const originPattern = `${parsed.origin}/*`;
        const hasPerm = await chrome.permissions.contains({
          origins: [originPattern],
        });
        if (!hasPerm) {
          return await chrome.permissions.request({
            origins: [originPattern],
          });
        }
      }
    } catch {
      // Ignore if not a valid URL or not in extension environment
    }
    return true;
  };

  const handleUpdateSphereConfig = async (
    updates: Partial<SyncConfig>,
    label: string,
  ) => {
    if (updates.endpointUrl) {
      await ensureOriginPermission(updates.endpointUrl);
    }
    const updated = await SphereSyncClient.saveConfig(updates);
    setSphereConfig(updated);
    notify({
      title: "Sphere Sync Config Saved",
      description: label,
      variant: "success",
      actor: "user",
    });
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setTestResult(null);
    try {
      await ensureOriginPermission(sphereConfig.endpointUrl);
      const res = await SphereSyncClient.testConnection(sphereConfig);
      if (res.ok) {
        setTestResult({
          ok: true,
          message: "Connected successfully to Sphere Pharmacy API!",
        });
        notify({
          title: "Connection Successful",
          description: "Sphere Pharmacy endpoint accepted handshake.",
          variant: "success",
          actor: "system",
        });
      } else {
        setTestResult({ ok: false, message: res.error || "Connection failed" });
        notify({
          title: "Connection Failed",
          description: res.error || "Check URL and API key.",
          variant: "error",
          actor: "system",
        });
      }
    } finally {
      setTestingConnection(false);
    }
  };

  const handleFlushQueueNow = async () => {
    setFlushingQueue(true);
    try {
      const result = await SphereSyncClient.flushQueue();
      await refreshQueueStats();
      if (result.synced > 0) {
        notify({
          title: "Queue Dispatched",
          description: `Dispatched ${result.synced} items to Sphere Pharmacy.`,
          variant: "success",
          actor: "system",
        });
      } else if (result.error) {
        notify({
          title: "Sync Failed",
          description: result.error,
          variant: "error",
          actor: "system",
        });
      } else {
        notify({
          title: "Queue Empty",
          description: "No pending items to sync.",
          variant: "info",
          actor: "system",
        });
      }
    } finally {
      setFlushingQueue(false);
    }
  };

  const handleRetryFailedItems = async () => {
    const count = await SphereSyncClient.retryFailed();
    await refreshQueueStats();
    notify({
      title: "Failed Items Queued",
      description: `Reset ${count} items back to pending status.`,
      variant: "info",
      actor: "user",
    });
  };

  const handlePollBandaGoNow = async () => {
    setPollingBandaGo(true);
    try {
      const res = await sendExtensionMessage<
        unknown,
        { success: boolean; count: number; message: string }
      >("BANDAGO_TRIGGER_POLL");
      await refreshQueueStats();

      if (res.success && res.data) {
        notify({
          title: "BandaGo Poller Finished",
          description: res.data.message,
          variant: res.data.success ? "success" : "warning",
          actor: "system",
        });
      } else {
        notify({
          title: "Poller Trigger Failed",
          description: res.error || "Could not query BandaGo tab",
          variant: "error",
          actor: "system",
        });
      }
    } finally {
      setPollingBandaGo(false);
    }
  };

  const handleAddParam = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = newParam.trim().toLowerCase();
    if (!cleaned) return;
    if (settings.sensitiveUrlParams.includes(cleaned)) {
      setNewParam("");
      return;
    }
    const next = [...settings.sensitiveUrlParams, cleaned];
    setNewParam("");
    await handleUpdateSettings(
      { sensitiveUrlParams: next },
      `Added "${cleaned}" to redacted URL parameters`,
    );
  };

  const handleRemoveParam = async (param: string) => {
    const next = settings.sensitiveUrlParams.filter((p) => p !== param);
    await handleUpdateSettings(
      { sensitiveUrlParams: next },
      `Removed "${param}" from redacted URL parameters`,
    );
  };

  const handleResetDefaults = async () => {
    const reset = await settingsRepo.saveSettings(DEFAULT_SETTINGS);
    setSettings(reset);
    notify({
      title: "Defaults restored",
      description: "Privacy & capture defaults have been reset.",
      variant: "info",
      actor: "user",
    });
  };

  const executeConfirmedAction = async () => {
    if (confirmAction === "clear_sync_queue") {
      await SphereSyncClient.clearQueue();
      await refreshQueueStats();
      notify({
        title: "Sync Queue Cleared",
        description:
          "All pending, syncing, and failed queue items were deleted.",
        variant: "info",
        actor: "user",
      });
      setConfirmAction(null);
      return;
    }

    if (confirmAction === "clear_all_captured") {
      setClearing(true);
      try {
        const res = await sendExtensionMessage<ClearAllDataPayload>(
          "CLEAR_ALL_DATA",
          {
            clearSessions: false,
            clearSyncQueue: true,
          },
        );
        if (!res.success) {
          await sessionRepo.clearAllCapturedData({
            clearSessions: false,
            clearSyncQueue: true,
          });
        }
        notify({
          title: "All Captured Data Reset",
          description:
            "Purged all raw traffic, extracted records, schemas, and queues across all tabs. Sessions remain active.",
          variant: "warning",
          actor: "user",
        });
        if (onDataCleared) {
          await onDataCleared();
        } else {
          await onSessionCleared();
        }
      } finally {
        setClearing(false);
        setConfirmAction(null);
      }
      return;
    }

    if (confirmAction === "clear_all_global") {
      setDeleting(true);
      try {
        const res = await sendExtensionMessage<ClearAllDataPayload>(
          "CLEAR_ALL_DATA",
          {
            clearSessions: true,
            clearSyncQueue: true,
          },
        );
        if (!res.success) {
          await sessionRepo.clearAllCapturedData({
            clearSessions: true,
            clearSyncQueue: true,
          });
        }
        notify({
          title: "All Extension Storage Cleared",
          description:
            "Permanently wiped all sessions, raw responses, extracted records, schemas, and queues.",
          variant: "warning",
          actor: "user",
        });
        await onSessionCleared();
      } finally {
        setDeleting(false);
        setConfirmAction(null);
      }
      return;
    }

    if (!session || !confirmAction) return;

    if (confirmAction === "clear_tab_data") {
      setClearing(true);
      try {
        const res = await sendExtensionMessage<
          ClearTabDataPayload,
          ClearTabDataResult
        >("CLEAR_TAB_DATA", {
          sessionId: session.id,
        });
        if (!res.success) {
          await sessionRepo.clearSessionData(session.id);
        }
        const countText =
          res.data &&
          (res.data.clearedResponses > 0 || res.data.clearedRecords > 0)
            ? `Purged ${res.data.clearedResponses} response(s), ${res.data.clearedRecords} record(s), and ${res.data.clearedSources} dataset(s).`
            : `Purged all raw traffic, records, and schemas for "${session.label}".`;
        notify({
          title: "Tab Data Cleared",
          description: `${countText} Session remains active.`,
          variant: "success",
          actor: "user",
        });
        if (onDataCleared) {
          await onDataCleared();
        } else {
          await onSessionCleared();
        }
      } finally {
        setClearing(false);
        setConfirmAction(null);
      }
      return;
    }

    if (confirmAction === "clear_records") {
      setClearing(true);
      try {
        await sessionRepo.clearSessionRecords(session.id);
        await activityRepo.logEvent({
          sessionId: session.id,
          actor: "user",
          category: "session",
          message: "Cleared consolidated records (raw responses preserved)",
        });
        notify({
          title: "Consolidated records cleared",
          description:
            "Raw responses remain intact and can be reprocessed anytime.",
          variant: "info",
          actor: "user",
        });
        if (onDataCleared) {
          await onDataCleared();
        } else {
          await onSessionCleared();
        }
      } finally {
        setClearing(false);
        setConfirmAction(null);
      }
    } else if (confirmAction === "delete_session") {
      setDeleting(true);
      try {
        await sessionRepo.deleteSession(session.id);
        notify({
          title: "Session permanently deleted",
          description: `Removed "${session.label}" and all local IndexedDB records.`,
          variant: "warning",
          actor: "user",
        });
        await onSessionCleared();
      } finally {
        setDeleting(false);
        setConfirmAction(null);
      }
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Settings Header */}
      <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-stone-900 flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-brand-100 border border-brand-300 text-brand-800 flex items-center justify-center">
              <SettingsIcon className="w-4 h-4" aria-hidden="true" />
            </span>
            Capture Preferences & Integration Controls
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Configure live BandaGo POS synchronization to Sphere Pharmacy, URL
            redaction rules, and local storage retention.
          </p>
        </div>

        <button
          type="button"
          onClick={handleResetDefaults}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold rounded-xl transition"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          Reset Defaults
        </button>
      </div>

      {/* Sphere Pharmacy & BandaGo POS Live Synchronization */}
      <div className="bg-white rounded-2xl shadow-xs border border-emerald-200 p-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-emerald-100 border border-emerald-300 text-emerald-800 flex items-center justify-center">
              <Radio className="w-4 h-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="font-bold text-stone-900 text-sm flex items-center gap-2">
                Sphere Pharmacy Live Sync (BandaGo Bridge)
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                  <Sparkles className="w-2.5 h-2.5" /> Blueprint v1.0
                </span>
              </h3>
              <p className="text-xs text-stone-500 mt-0.5">
                Automatically pushes intercepted BandaGo POS inventory updates,
                counter dispenses, and stock changes directly to Sphere
                Pharmacy.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-stone-700">
            <span>Auto Sync</span>
            <input
              type="checkbox"
              checked={sphereConfig.enabled}
              onChange={(e) =>
                handleUpdateSphereConfig(
                  { enabled: e.target.checked },
                  `Auto Sync ${e.target.checked ? "enabled" : "disabled"}`,
                )
              }
              className="w-4 h-4 text-emerald-600 rounded focus:ring-emerald-500"
            />
          </label>
        </div>

        {/* Configuration Inputs */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="md:col-span-2">
            <label
              htmlFor="sphere-endpoint"
              className="block font-bold text-stone-700 mb-1"
            >
              Sphere Ingestion Endpoint URL
            </label>
            <input
              id="sphere-endpoint"
              type="url"
              value={sphereConfig.endpointUrl}
              onChange={(e) =>
                setSphereConfig((prev) => ({
                  ...prev,
                  endpointUrl: e.target.value,
                }))
              }
              onBlur={() =>
                handleUpdateSphereConfig(
                  { endpointUrl: sphereConfig.endpointUrl },
                  "Updated Sphere ingestion endpoint URL",
                )
              }
              placeholder="https://your-pharmacy-store.com/api/integrations/bandago/sync"
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono text-xs focus:bg-white focus:outline-none focus:border-emerald-600"
            />
            <p className="text-[11px] text-stone-500 mt-1">
              The Next.js API route receiving normalized POS medication catalogs
              and stock deltas. Supports custom domains, Vercel previews, or
              local self-hosted instances.
            </p>
          </div>

          <div>
            <label
              htmlFor="sphere-api-key"
              className="block font-bold text-stone-700 mb-1"
            >
              Sync API Key (Bearer Token)
            </label>
            <div className="relative">
              <input
                id="sphere-api-key"
                type={showApiKey ? "text" : "password"}
                value={sphereConfig.apiKey}
                onChange={(e) =>
                  setSphereConfig((prev) => ({
                    ...prev,
                    apiKey: e.target.value,
                  }))
                }
                onBlur={() =>
                  handleUpdateSphereConfig(
                    { apiKey: sphereConfig.apiKey },
                    "Updated Sphere API Key",
                  )
                }
                placeholder="Enter BANDAGO_SYNC_API_KEY"
                className="w-full px-3 py-2 pr-9 bg-stone-50 border border-stone-300 rounded-xl font-mono text-xs focus:bg-white focus:outline-none focus:border-emerald-600"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2.5 top-2.5 text-stone-400 hover:text-stone-700"
                aria-label={showApiKey ? "Hide API key" : "Show API key"}
              >
                {showApiKey ? (
                  <EyeOff className="w-3.5 h-3.5" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
            <p className="text-[11px] text-stone-500 mt-1">
              Must match the BANDAGO_SYNC_API_KEY environment variable
              configured on Sphere Pharmacy.
            </p>
          </div>

          <div>
            <label
              htmlFor="sphere-pharmacy-id"
              className="block font-bold text-stone-700 mb-1"
            >
              Pharmacy Store Identifier
            </label>
            <input
              id="sphere-pharmacy-id"
              type="text"
              value={sphereConfig.pharmacyId || ""}
              onChange={(e) =>
                setSphereConfig((prev) => ({
                  ...prev,
                  pharmacyId: e.target.value,
                }))
              }
              onBlur={() =>
                handleUpdateSphereConfig(
                  { pharmacyId: sphereConfig.pharmacyId },
                  "Updated Pharmacy Store Identifier",
                )
              }
              placeholder="e.g. DEFAULT_STORE or STORE-001"
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl font-mono text-xs focus:bg-white focus:outline-none focus:border-emerald-600"
            />
            <p className="text-[11px] text-stone-500 mt-1">
              Identifies the dispensing location when operating multiple
              pharmacy counters.
            </p>
          </div>
        </div>

        {/* Action Bar & Test Connection */}
        <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={
                testingConnection ||
                !sphereConfig.endpointUrl ||
                !sphereConfig.apiKey
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-xl shadow-xs transition disabled:opacity-50"
            >
              {testingConnection ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              {testingConnection ? "Testing..." : "Test Handshake"}
            </button>

            <button
              type="button"
              onClick={handleFlushQueueNow}
              disabled={flushingQueue || queueStats.pending === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold rounded-xl border border-stone-300 transition disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5 text-stone-600" />
              {flushingQueue
                ? "Syncing..."
                : `Flush Pending (${queueStats.pending})`}
            </button>

            <button
              type="button"
              onClick={handlePollBandaGoNow}
              disabled={pollingBandaGo}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold rounded-xl border border-stone-300 transition disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-stone-600 ${pollingBandaGo ? "animate-spin" : ""}`}
              />
              {pollingBandaGo ? "Polling Tab..." : "Poll Active BandaGo Tab"}
            </button>
          </div>

          {testResult && (
            <div
              className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${
                testResult.ok
                  ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                  : "bg-rose-50 text-rose-800 border-rose-300"
              }`}
            >
              {testResult.message}
            </div>
          )}
        </div>

        {/* Live Queue Monitor */}
        <div className="bg-stone-50 rounded-xl p-3.5 border border-stone-200 space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-stone-800">
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-stone-500" />
              Outbound Offline Sync Ledger (IndexedDB)
            </span>
            <div className="flex items-center gap-2">
              {queueStats.failed > 0 && (
                <button
                  type="button"
                  onClick={handleRetryFailedItems}
                  className="text-xs text-rose-700 hover:underline font-bold"
                >
                  Retry {queueStats.failed} Failed
                </button>
              )}
              {queueStats.total > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmAction("clear_sync_queue")}
                  className="text-xs text-stone-500 hover:text-stone-700"
                >
                  Clear Queue
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            <div className="bg-white p-2 rounded-lg border border-stone-200">
              <span className="block text-[11px] text-stone-500">Pending</span>
              <span className="text-base font-bold text-stone-900">
                {queueStats.pending}
              </span>
            </div>
            <div className="bg-white p-2 rounded-lg border border-stone-200">
              <span className="block text-[11px] text-stone-500">Syncing</span>
              <span className="text-base font-bold text-amber-600">
                {queueStats.syncing}
              </span>
            </div>
            <div className="bg-white p-2 rounded-lg border border-stone-200">
              <span className="block text-[11px] text-stone-500">Failed</span>
              <span className="text-base font-bold text-rose-600">
                {queueStats.failed}
              </span>
            </div>
            <div className="bg-white p-2 rounded-lg border border-stone-200">
              <span className="block text-[11px] text-stone-500">
                Total in Queue
              </span>
              <span className="text-base font-bold text-stone-700">
                {queueStats.total}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Default Capture & Export Preferences */}
      <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-6 space-y-5">
        <h3 className="font-bold text-stone-900 text-sm">
          Default API Reading & Export Behavior
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
          <div>
            <label
              htmlFor="default-scope-select"
              className="block font-bold text-stone-700 mb-1.5"
            >
              Default API Scope Mode
            </label>
            <select
              id="default-scope-select"
              value={settings.defaultScopeMode}
              onChange={(e) =>
                handleUpdateSettings(
                  { defaultScopeMode: e.target.value as ScopeMode },
                  `Default API scope set to ${e.target.value}`,
                )
              }
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-medium text-stone-800 focus:outline-none focus:border-brand-600"
            >
              <option value="all_tab_apis">
                All Tab APIs (Recommended — includes api.* & external backends)
              </option>
              <option value="same_domain">
                Same Root Domain & Subdomains Only
              </option>
              <option value="selected_hosts">Strict Hostname Match Only</option>
            </select>
            <p className="text-[11px] text-stone-500 mt-1">
              Controls which XHR/Fetch API calls initiated by your target tab
              are captured by default.
            </p>
          </div>

          <div>
            <label
              htmlFor="max-body-bytes-select"
              className="block font-bold text-stone-700 mb-1.5"
            >
              Maximum JSON Payload Size
            </label>
            <select
              id="max-body-bytes-select"
              value={settings.maxResponseBodyBytes}
              onChange={(e) => {
                const bytes = Number(e.target.value);
                handleUpdateSettings(
                  { maxResponseBodyBytes: bytes },
                  `Max payload size set to ${(bytes / (1024 * 1024)).toFixed(0)} MB`,
                );
              }}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-medium text-stone-800 focus:outline-none focus:border-brand-600"
            >
              <option value={2 * 1024 * 1024}>2 MB per response</option>
              <option value={5 * 1024 * 1024}>5 MB per response</option>
              <option value={10 * 1024 * 1024}>
                10 MB per response (Default)
              </option>
              <option value={25 * 1024 * 1024}>
                25 MB per response (Large catalogs)
              </option>
            </select>
            <p className="text-[11px] text-stone-500 mt-1">
              Protects browser memory from oversized binary or dump payloads.
            </p>
          </div>
        </div>

        <div className="pt-3 border-t border-stone-100 flex flex-col sm:flex-row gap-6">
          <label className="flex items-start gap-2.5 cursor-pointer text-xs text-stone-700">
            <input
              type="checkbox"
              checked={settings.formulaInjectionDefense}
              onChange={(e) =>
                handleUpdateSettings(
                  { formulaInjectionDefense: e.target.checked },
                  `CSV formula injection defense ${e.target.checked ? "enabled" : "disabled"}`,
                )
              }
              className="rounded mt-0.5"
            />
            <div>
              <span className="font-semibold block text-stone-900">
                CSV Formula Injection Defense
              </span>
              <span className="text-[11px] text-stone-500">
                Neutralizes untrusted cells starting with =, +, -, or @
              </span>
            </div>
          </label>

          <label className="flex items-start gap-2.5 cursor-pointer text-xs text-stone-700">
            <input
              type="checkbox"
              checked={settings.defaultExportEncoding === "utf-8-bom"}
              onChange={(e) =>
                handleUpdateSettings(
                  {
                    defaultExportEncoding: e.target.checked
                      ? "utf-8-bom"
                      : "utf-8",
                  },
                  `Default CSV encoding set to ${e.target.checked ? "UTF-8 with BOM" : "UTF-8"}`,
                )
              }
              className="rounded mt-0.5"
            />
            <div>
              <span className="font-semibold block text-stone-900">
                UTF-8 BOM by Default
              </span>
              <span className="text-[11px] text-stone-500">
                Recommended for Microsoft Excel international character support
              </span>
            </div>
          </label>
        </div>
      </div>

      {/* Privacy by Design & Redaction Controls */}
      <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-6 space-y-4">
        <div className="flex items-center gap-2 text-brand-800">
          <Shield className="w-5 h-5 text-brand-700" aria-hidden="true" />
          <h3 className="font-bold text-stone-900 text-sm">
            Local-First Privacy & Smart Security Exclusions
          </h3>
        </div>

        <p className="text-xs text-stone-600 leading-relaxed">
          All network inspection, entity extraction, and exports execute{" "}
          <strong>100% locally</strong> in your browser IndexedDB. Request
          cookies and{" "}
          <code className="bg-stone-100 px-1.5 py-0.5 rounded font-mono text-stone-800">
            Authorization
          </code>{" "}
          headers are never persisted.
        </p>

        <div className="space-y-4 pt-2 text-xs">
          <div>
            <span className="font-bold text-stone-700 block mb-2">
              Redacted URL Query Parameters
            </span>
            <div className="flex flex-wrap gap-1.5 mb-2.5">
              {settings.sensitiveUrlParams.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1 bg-brand-50 border border-brand-200 px-2.5 py-1 rounded-lg font-mono text-brand-900 text-[11px]"
                >
                  {p}
                  <button
                    type="button"
                    onClick={() => handleRemoveParam(p)}
                    aria-label={`Remove ${p} parameter redaction`}
                    className="text-stone-400 hover:text-rose-600 transition"
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>

            <form onSubmit={handleAddParam} className="flex gap-2 max-w-sm">
              <input
                type="text"
                value={newParam}
                onChange={(e) => setNewParam(e.target.value)}
                placeholder="Add query param to redact (e.g. session_key)"
                aria-label="Query parameter name to redact"
                className="flex-1 px-3 py-1.5 bg-stone-50 border border-stone-300 rounded-xl font-mono focus:bg-white focus:outline-none focus:border-brand-600"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-obsidian-900 hover:bg-obsidian-800 text-brand-300 text-xs font-semibold rounded-xl transition"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Add
              </button>
            </form>
          </div>

          <div className="pt-2 border-t border-stone-100">
            <span className="font-bold text-stone-700 block mb-1.5">
              Segment-Aware Sensitive Endpoint Exclusions
            </span>
            <p className="text-[11px] text-stone-500 mb-2">
              Matched strictly on URL path segments so{" "}
              <code className="font-mono">/auth/token</code> is blocked while
              legitimate APIs like{" "}
              <code className="font-mono">/api/authors</code> are captured
              cleanly.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {settings.sensitiveEndpointKeywords.map((k) => (
                <span
                  key={k}
                  className="bg-rose-50 border border-rose-200 text-rose-800 px-2.5 py-0.5 rounded-lg font-mono text-[11px]"
                >
                  {k}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-white rounded-2xl shadow-xs border border-rose-200 p-6 space-y-5">
        <div className="flex items-center gap-2 text-rose-700">
          <AlertTriangle className="w-5 h-5" aria-hidden="true" />
          <h3 className="font-bold text-stone-900 text-sm">
            Session Storage & Data Retention
          </h3>
        </div>

        <p className="text-xs text-stone-600">
          {session
            ? `Manage stored data for active session "${session.label}".`
            : "No session is currently selected."}
        </p>

        <div className="space-y-3 pt-1">
          {/* Action 1: Clear All Tab Data (Recommended / Complete purge) */}
          <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="font-bold text-xs text-amber-950 block">
                Clear All Tab Data (Keep Session Active)
              </span>
              <span className="text-[11px] text-amber-900/80 block mt-0.5">
                Purges all raw traffic, extracted records, inferred schemas, and
                outbound sync items for this tab. Session stays connected.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setConfirmAction("clear_tab_data")}
              disabled={clearing || !session}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-50 whitespace-nowrap flex-shrink-0"
            >
              <Eraser className="w-4 h-4" aria-hidden="true" />
              {clearing ? "Clearing..." : "Clear Tab Data"}
            </button>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => setConfirmAction("clear_records")}
              disabled={clearing || !session}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-stone-50 hover:bg-stone-100 text-stone-800 text-xs font-bold rounded-xl border border-stone-300 transition disabled:opacity-50 flex-1"
            >
              <Database className="w-4 h-4 text-stone-600" aria-hidden="true" />
              {clearing
                ? "Clearing..."
                : "Clear Records Only (Keep Raw Traffic)"}
            </button>

            <button
              type="button"
              onClick={() => setConfirmAction("delete_session")}
              disabled={deleting || !session}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-bold rounded-xl border border-rose-300 transition disabled:opacity-50 flex-1"
            >
              <Trash2 className="w-4 h-4 text-rose-600" aria-hidden="true" />
              {deleting ? "Deleting..." : "Delete Session & Wipe Storage"}
            </button>
          </div>

          {/* Action 4: Reset All Captured Data across all sessions (Keep Sessions) */}
          <div className="pt-2 border-t border-stone-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="font-semibold text-xs text-stone-800 block">
                Reset All Captured Data (Keep Sessions Active)
              </span>
              <span className="text-[11px] text-stone-500 block">
                Purges all raw traffic, records, schemas, and sync queues across
                all sessions while retaining session configurations.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setConfirmAction("clear_all_captured")}
              disabled={clearing || deleting}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-obsidian-950 text-xs font-semibold rounded-xl shadow-xs transition disabled:opacity-50 whitespace-nowrap flex-shrink-0"
            >
              <Eraser
                className="w-3.5 h-3.5 text-obsidian-900"
                aria-hidden="true"
              />
              Reset All Captured Data
            </button>
          </div>

          {/* Action 5: Reset All Extension Data (Global Wipe) */}
          <div className="pt-2 border-t border-stone-200/80 flex items-center justify-between gap-3">
            <div>
              <span className="font-semibold text-xs text-stone-700 block">
                Reset All Extension Storage (Global Wipe)
              </span>
              <span className="text-[11px] text-stone-500 block">
                Permanently wipes all sessions, responses, records, and sync
                queues across the entire extension.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setConfirmAction("clear_all_global")}
              disabled={deleting}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-xl shadow-xs transition disabled:opacity-50 whitespace-nowrap flex-shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              Global Wipe
            </button>
          </div>
        </div>
      </div>

      {/* Non-blocking Accessible Confirmation Modal */}
      <ConfirmDialog
        isOpen={confirmAction !== null}
        title={
          confirmAction === "delete_session"
            ? "Delete Capture Session?"
            : confirmAction === "clear_all_global"
              ? "Wipe All Extension Storage?"
              : confirmAction === "clear_all_captured"
                ? "Reset All Captured Data?"
                : confirmAction === "clear_tab_data"
                  ? "Clear All Tab Data?"
                  : confirmAction === "clear_sync_queue"
                    ? "Clear Sync Queue?"
                    : "Clear Consolidated Records?"
        }
        description={
          confirmAction === "delete_session"
            ? `This permanently deletes "${session?.label || "this session"}" along with all captured raw responses, extracted records, and inferred schemas from browser storage.`
            : confirmAction === "clear_all_global"
              ? "This permanently wipes ALL captured sessions, raw network traffic, extracted records, inferred schemas, and sync queues across the entire extension."
              : confirmAction === "clear_all_captured"
                ? "This permanently wipes all captured raw network traffic, extracted records, inferred schemas, and outbound sync queues across ALL tabs and sessions. Capture sessions will remain connected and active."
                : confirmAction === "clear_tab_data"
                  ? `This permanently purges all captured raw responses, extracted records, endpoint schemas, and sync queue items for "${session?.label || "this tab"}". The session will remain connected and active.`
                  : confirmAction === "clear_sync_queue"
                    ? "This removes all pending, syncing, and failed medication updates from the local sync queue."
                    : "This clears materialized records for the current session while keeping raw API responses intact so you can re-extract them later."
        }
        confirmLabel={
          confirmAction === "delete_session"
            ? "Delete Permanently"
            : confirmAction === "clear_all_global"
              ? "Wipe Everything Permanently"
              : confirmAction === "clear_all_captured"
                ? "Reset All Captured Data"
                : confirmAction === "clear_tab_data"
                  ? "Clear Tab Data"
                  : confirmAction === "clear_sync_queue"
                    ? "Clear Sync Queue"
                    : "Clear Records"
        }
        variant={
          confirmAction === "delete_session" ||
          confirmAction === "clear_all_global"
            ? "danger"
            : "warning"
        }
        isBusy={clearing || deleting}
        onCancel={() => setConfirmAction(null)}
        onConfirm={executeConfirmedAction}
      />
    </div>
  );
};
