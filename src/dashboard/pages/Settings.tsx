import React, { useState, useEffect } from 'react';
import { CaptureSession, GlobalSettings, ScopeMode } from '../../shared/types';
import { activityRepo, sessionRepo, settingsRepo } from '../../data/repositories';
import {
  Settings as SettingsIcon,
  Shield,
  Trash2,
  Database,
  AlertTriangle,
  Plus,
  X,
  RotateCcw,
} from 'lucide-react';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';

interface Props {
  session: CaptureSession | null;
  onSessionCleared: () => Promise<void> | void;
}

export const Settings: React.FC<Props> = ({ session, onSessionCleared }) => {
  const { notify } = useToast();
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  const [newParam, setNewParam] = useState('');
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'clear_records' | 'delete_session' | null>(
    null
  );

  useEffect(() => {
    settingsRepo.getSettings().then(setSettings);
  }, []);

  const handleUpdateSettings = async (updates: Partial<GlobalSettings>, label: string) => {
    const updated = await settingsRepo.saveSettings(updates);
    setSettings(updated);
    if (session) {
      await activityRepo.logEvent({
        sessionId: session.id,
        actor: 'user',
        category: 'config',
        message: `Updated setting: ${label}`,
      });
    }
    notify({
      title: 'Preference saved',
      description: label,
      variant: 'success',
      actor: 'user',
    });
  };

  const handleAddParam = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = newParam.trim().toLowerCase();
    if (!cleaned) return;
    if (settings.sensitiveUrlParams.includes(cleaned)) {
      setNewParam('');
      return;
    }
    const next = [...settings.sensitiveUrlParams, cleaned];
    setNewParam('');
    await handleUpdateSettings(
      { sensitiveUrlParams: next },
      `Added "${cleaned}" to redacted URL parameters`
    );
  };

  const handleRemoveParam = async (param: string) => {
    const next = settings.sensitiveUrlParams.filter((p) => p !== param);
    await handleUpdateSettings(
      { sensitiveUrlParams: next },
      `Removed "${param}" from redacted URL parameters`
    );
  };

  const handleResetDefaults = async () => {
    const reset = await settingsRepo.saveSettings(DEFAULT_SETTINGS);
    setSettings(reset);
    notify({
      title: 'Defaults restored',
      description: 'Privacy & capture defaults have been reset.',
      variant: 'info',
      actor: 'user',
    });
  };

  const executeConfirmedAction = async () => {
    if (!session || !confirmAction) return;

    if (confirmAction === 'clear_records') {
      setClearing(true);
      try {
        await sessionRepo.clearSessionRecords(session.id);
        await activityRepo.logEvent({
          sessionId: session.id,
          actor: 'user',
          category: 'session',
          message: 'Cleared consolidated records (raw responses preserved)',
        });
        notify({
          title: 'Consolidated records cleared',
          description: 'Raw responses remain intact and can be reprocessed anytime.',
          variant: 'info',
          actor: 'user',
        });
        await onSessionCleared();
      } finally {
        setClearing(false);
        setConfirmAction(null);
      }
    } else if (confirmAction === 'delete_session') {
      setDeleting(true);
      try {
        await sessionRepo.deleteSession(session.id);
        notify({
          title: 'Session permanently deleted',
          description: `Removed "${session.label}" and all local IndexedDB records.`,
          variant: 'warning',
          actor: 'user',
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
            Capture Preferences & Privacy Controls
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Configure API scope defaults, URL redaction rules, response size limits, and local storage retention.
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
                  `Default API scope set to ${e.target.value}`
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
              <option value="selected_hosts">
                Strict Hostname Match Only
              </option>
            </select>
            <p className="text-[11px] text-stone-500 mt-1">
              Controls which XHR/Fetch API calls initiated by your target tab are captured by default.
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
                  `Max payload size set to ${(bytes / (1024 * 1024)).toFixed(0)} MB`
                );
              }}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-medium text-stone-800 focus:outline-none focus:border-brand-600"
            >
              <option value={2 * 1024 * 1024}>2 MB per response</option>
              <option value={5 * 1024 * 1024}>5 MB per response</option>
              <option value={10 * 1024 * 1024}>10 MB per response (Default)</option>
              <option value={25 * 1024 * 1024}>25 MB per response (Large catalogs)</option>
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
                  `CSV formula injection defense ${e.target.checked ? 'enabled' : 'disabled'}`
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
              checked={settings.defaultExportEncoding === 'utf-8-bom'}
              onChange={(e) =>
                handleUpdateSettings(
                  {
                    defaultExportEncoding: e.target.checked ? 'utf-8-bom' : 'utf-8',
                  },
                  `Default CSV encoding set to ${e.target.checked ? 'UTF-8 with BOM' : 'UTF-8'}`
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
          All network inspection, entity extraction, and exports execute <strong>100% locally</strong> in your browser IndexedDB. Request cookies and <code className="bg-stone-100 px-1.5 py-0.5 rounded font-mono text-stone-800">Authorization</code> headers are never persisted.
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
                className="flex-1 px-3 py-1.5 bg-stone-50 border border-stone-300 rounded-xl text-xs font-mono focus:bg-white focus:outline-none focus:border-brand-600"
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
              Matched strictly on URL path segments so <code className="font-mono">/auth/token</code> is blocked while legitimate APIs like <code className="font-mono">/api/authors</code> are captured cleanly.
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
      <div className="bg-white rounded-2xl shadow-xs border border-rose-200 p-6 space-y-4">
        <div className="flex items-center gap-2 text-rose-700">
          <AlertTriangle className="w-5 h-5" aria-hidden="true" />
          <h3 className="font-bold text-stone-900 text-sm">
            Session Storage & Data Retention
          </h3>
        </div>

        <p className="text-xs text-stone-600">
          {session
            ? `Manage stored data for active session "${session.label}".`
            : 'No session is currently selected.'}
        </p>

        <div className="pt-1 flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={() => setConfirmAction('clear_records')}
            disabled={clearing || !session}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-bold rounded-xl border border-amber-300 transition disabled:opacity-50"
          >
            <Database className="w-4 h-4 text-amber-700" aria-hidden="true" />
            {clearing ? 'Clearing...' : 'Clear Consolidated Records'}
          </button>

          <button
            type="button"
            onClick={() => setConfirmAction('delete_session')}
            disabled={deleting || !session}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl shadow-xs transition disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
            {deleting ? 'Deleting...' : 'Delete Session & Wipe Storage'}
          </button>
        </div>
      </div>

      {/* Non-blocking Accessible Confirmation Modal */}
      <ConfirmDialog
        isOpen={confirmAction !== null}
        title={
          confirmAction === 'delete_session'
            ? 'Delete Capture Session?'
            : 'Clear Consolidated Records?'
        }
        description={
          confirmAction === 'delete_session'
            ? `This permanently deletes "${session?.label || 'this session'}" along with all captured raw responses, extracted records, and inferred schemas from browser storage.`
            : 'This clears materialized records for the current session while keeping raw API responses intact so you can re-extract them later.'
        }
        confirmLabel={
          confirmAction === 'delete_session'
            ? 'Delete Permanently'
            : 'Clear Records'
        }
        variant={confirmAction === 'delete_session' ? 'danger' : 'warning'}
        isBusy={clearing || deleting}
        onCancel={() => setConfirmAction(null)}
        onConfirm={executeConfirmedAction}
      />
    </div>
  );
};
