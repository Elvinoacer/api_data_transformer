import React, { useState } from 'react';
import { CaptureSession } from '../../shared/types';
import { sessionRepo } from '../../data/repositories';
import { Settings as SettingsIcon, Shield, Trash2, Database, AlertTriangle, Check } from 'lucide-react';
import { DEFAULT_SETTINGS } from '../../shared/constants';

interface Props {
  session: CaptureSession | null;
  onSessionCleared: () => void;
}

export const Settings: React.FC<Props> = ({ session, onSessionCleared }) => {
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  const handleClearRecords = async () => {
    if (!session) return;
    if (!confirm('Are you sure you want to clear consolidated records? Raw response history will be preserved.')) {
      return;
    }
    setClearing(true);
    try {
      await sessionRepo.clearSessionRecords(session.id);
      setSuccessMsg('Consolidated records cleared. You can reprocess from raw responses anytime.');
      onSessionCleared();
      setTimeout(() => setSuccessMsg(''), 4000);
    } finally {
      setClearing(false);
    }
  };

  const handleDeleteSession = async () => {
    if (!session) return;
    if (!confirm('Are you sure you want to delete this session and ALL its raw responses, records, and schemas? This cannot be undone.')) {
      return;
    }
    setDeleting(true);
    try {
      await sessionRepo.deleteSession(session.id);
      setSuccessMsg('Session and local storage data completely deleted.');
      onSessionCleared();
      setTimeout(() => setSuccessMsg(''), 4000);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Settings Header */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6">
        <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-indigo-600" />
          Settings & Privacy Controls
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Configure security exclusions, URL parameter redaction, and manage local storage retention.
        </p>
      </div>

      {successMsg && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-semibold text-emerald-800 flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-600" />
          {successMsg}
        </div>
      )}

      {/* Privacy by Design Card */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 space-y-4">
        <div className="flex items-center gap-2 text-indigo-700">
          <Shield className="w-5 h-5" />
          <h3 className="font-bold text-slate-900 text-sm">Privacy & Security Guarantees</h3>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          The Live Network Data Collector is strictly <strong>local-first</strong>. All captured network response bodies, materialized records, and schemas are stored directly on your machine in browser IndexedDB.
        </p>
        <ul className="text-xs text-slate-600 space-y-2 list-disc pl-5">
          <li><strong>Zero credential harvesting:</strong> Cookies, passwords, and HTTP Authorization request headers are never read or stored.</li>
          <li><strong>Automatic URL redaction:</strong> Sensitive query parameters such as <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600">token</code>, <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600">api_key</code>, and <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600">password</code> are automatically redacted before persistence.</li>
          <li><strong>Endpoint exclusions:</strong> Traffic to sensitive endpoints such as <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600">/login</code>, <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600">/auth</code>, and <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600">/credentials</code> is excluded by default.</li>
        </ul>
      </div>

      {/* Configuration Defaults */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 space-y-4">
        <h3 className="font-bold text-slate-900 text-sm">Active Exclusion & Redaction Rules</h3>
        <div className="space-y-3 text-xs">
          <div>
            <span className="font-semibold text-slate-700 block mb-1">
              Redacted Query Parameters:
            </span>
            <div className="flex flex-wrap gap-1">
              {DEFAULT_SETTINGS.sensitiveUrlParams.map((p) => (
                <span key={p} className="bg-slate-100 px-2 py-0.5 rounded font-mono text-slate-700 text-[11px]">
                  {p}
                </span>
              ))}
            </div>
          </div>

          <div>
            <span className="font-semibold text-slate-700 block mb-1">
              Excluded Endpoint Keywords:
            </span>
            <div className="flex flex-wrap gap-1">
              {DEFAULT_SETTINGS.sensitiveEndpointKeywords.map((k) => (
                <span key={k} className="bg-rose-50 border border-rose-100 text-rose-700 px-2 py-0.5 rounded font-mono text-[11px]">
                  {k}
                </span>
              ))}
            </div>
          </div>

          <div>
            <span className="font-semibold text-slate-700 block mb-1">
              Maximum Response Body Limit:
            </span>
            <span className="font-mono text-slate-800">
              {(DEFAULT_SETTINGS.maxResponseBodyBytes / (1024 * 1024)).toFixed(0)} MB
            </span>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-white rounded-xl shadow-xs border border-rose-200 p-6 space-y-4">
        <div className="flex items-center gap-2 text-rose-700">
          <AlertTriangle className="w-5 h-5" />
          <h3 className="font-bold text-slate-900 text-sm">Storage Management & Data Retention</h3>
        </div>

        <div className="pt-2 flex flex-col sm:flex-row gap-4">
          <button
            onClick={handleClearRecords}
            disabled={clearing || !session}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-semibold rounded-lg border border-amber-200 transition disabled:opacity-50"
          >
            <Database className="w-4 h-4 text-amber-600" />
            {clearing ? 'Clearing...' : 'Clear Consolidated Records'}
          </button>

          <button
            onClick={handleDeleteSession}
            disabled={deleting || !session}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg shadow-xs transition disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? 'Deleting...' : 'Delete Entire Session & Wipe Storage'}
          </button>
        </div>
      </div>
    </div>
  );
};
