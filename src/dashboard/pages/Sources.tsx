import React, { useState } from 'react';
import { EndpointSource, ConsolidationPolicy } from '../../shared/types';
import { sourceRepo } from '../../data/repositories';
import { Layers, RefreshCw, Check, X, Edit2 } from 'lucide-react';

interface Props {
  sources: EndpointSource[];
  sessionId?: string;
  onRefreshSources: () => void;
  onReprocess: () => void;
  isReprocessing: boolean;
}

export const Sources: React.FC<Props> = ({
  sources,
  onRefreshSources,
  onReprocess,
  isReprocessing,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRecordPath, setEditRecordPath] = useState('');
  const [editIdentityKey, setEditIdentityKey] = useState('');
  const [editPolicy, setEditPolicy] = useState<ConsolidationPolicy>('keep_latest');

  const startEdit = (source: EndpointSource) => {
    setEditingId(source.id);
    setEditRecordPath(source.recordPath);
    setEditIdentityKey(source.identityKeyField);
    setEditPolicy(source.consolidationPolicy);
  };

  const saveEdit = async (sourceId: string) => {
    await sourceRepo.updateSource(sourceId, {
      recordPath: editRecordPath,
      identityKeyField: editIdentityKey,
      consolidationPolicy: editPolicy,
    });
    setEditingId(null);
    onRefreshSources();
  };

  const toggleInclude = async (source: EndpointSource) => {
    await sourceRepo.updateSource(source.id, {
      included: !source.included,
    });
    onRefreshSources();
  };

  return (
    <div className="space-y-6">
      {/* Sources Header Toolbar */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Layers className="w-5 h-5 text-indigo-600" />
            Observed API Endpoint Groups ({sources.length})
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Endpoints are normalized by path (page and cursor query parameters are stripped). Configure collection paths and deduplication rules per source.
          </p>
        </div>

        <button
          onClick={onReprocess}
          disabled={isReprocessing || sources.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold rounded-lg border border-indigo-200 transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isReprocessing ? 'animate-spin' : ''}`} />
          {isReprocessing ? 'Reprocessing...' : 'Reprocess Stored Responses'}
        </button>
      </div>

      {/* Sources List */}
      {sources.length === 0 ? (
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-12 text-center text-slate-400">
          <Layers className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <h3 className="font-semibold text-slate-700 mb-1">No API Endpoints Captured Yet</h3>
          <p className="text-xs max-w-md mx-auto">
            Interact with the target website tab to trigger API requests. Permitted JSON endpoints will appear here automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sources.map((source) => {
            const isEditing = editingId === source.id;

            return (
              <div
                key={source.id}
                className={`bg-white rounded-xl shadow-xs border transition p-6 ${
                  source.included ? 'border-slate-200' : 'border-slate-200 bg-slate-50/60 opacity-75'
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-slate-100 text-slate-800">
                        {source.httpMethod}
                      </span>
                      <h3 className="text-sm font-mono font-bold text-slate-900 break-all">
                        {source.normalizedEndpoint}
                      </h3>
                    </div>
                    <p className="text-xs text-slate-500">
                      Observed: <strong>{source.observedCount}</strong> response(s) • Last seen: {new Date(source.lastObservedAt).toLocaleTimeString()}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggleInclude(source)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition border ${
                        source.included
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                          : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200'
                      }`}
                    >
                      {source.included ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <X className="w-3.5 h-3.5" />}
                      {source.included ? 'Included in Dataset' : 'Excluded'}
                    </button>

                    {!isEditing && (
                      <button
                        onClick={() => startEdit(source)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-lg transition"
                      >
                        <Edit2 className="w-3.5 h-3.5" /> Configure
                      </button>
                    )}
                  </div>
                </div>

                {/* Configuration Area */}
                {isEditing ? (
                  <div className="pt-4 grid grid-cols-1 md:grid-cols-3 gap-4 bg-slate-50 p-4 rounded-lg mt-4 border border-slate-200">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Record Array JSON Path
                      </label>
                      <input
                        type="text"
                        value={editRecordPath}
                        onChange={(e) => setEditRecordPath(e.target.value)}
                        placeholder="e.g. data.items, results, root"
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-md text-xs font-mono focus:ring-1 focus:ring-indigo-500"
                      />
                      <div className="mt-1 flex flex-wrap gap-1">
                        {['root', 'data', 'results', 'data.items', 'items'].map((path) => (
                          <button
                            key={path}
                            type="button"
                            onClick={() => setEditRecordPath(path)}
                            className="text-[10px] bg-slate-200 hover:bg-slate-300 px-1.5 py-0.5 rounded font-mono text-slate-700"
                          >
                            {path}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Unique Identity Key
                      </label>
                      <input
                        type="text"
                        value={editIdentityKey}
                        onChange={(e) => setEditIdentityKey(e.target.value)}
                        placeholder="e.g. id, sku, uuid, __hash__"
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-md text-xs font-mono focus:ring-1 focus:ring-indigo-500"
                      />
                      <div className="mt-1 flex flex-wrap gap-1">
                        {['id', '_id', 'uuid', 'sku', '__hash__'].map((k) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => setEditIdentityKey(k)}
                            className="text-[10px] bg-slate-200 hover:bg-slate-300 px-1.5 py-0.5 rounded font-mono text-slate-700"
                          >
                            {k}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Consolidation Policy
                      </label>
                      <select
                        value={editPolicy}
                        onChange={(e) => setEditPolicy(e.target.value as ConsolidationPolicy)}
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-md text-xs focus:ring-1 focus:ring-indigo-500"
                      >
                        <option value="keep_latest">Keep Latest (Update with newer data)</option>
                        <option value="keep_first">Keep First (Ignore duplicates)</option>
                        <option value="keep_all">Keep All Versions</option>
                      </select>
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1 bg-white border border-slate-200 hover:bg-slate-50 text-xs text-slate-600 rounded"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => saveEdit(source.id)}
                          className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-xs font-semibold text-white rounded"
                        >
                          Save Settings
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="pt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-slate-600">
                    <div>
                      <span className="text-slate-400 block mb-0.5">Extraction Path:</span>
                      <code className="bg-slate-100 px-2 py-0.5 rounded text-indigo-700 font-bold font-mono">
                        {source.recordPath}
                      </code>
                    </div>
                    <div>
                      <span className="text-slate-400 block mb-0.5">Identity Key:</span>
                      <code className="bg-slate-100 px-2 py-0.5 rounded text-slate-800 font-bold font-mono">
                        {source.identityKeyField}
                      </code>
                    </div>
                    <div>
                      <span className="text-slate-400 block mb-0.5">Policy:</span>
                      <span className="font-semibold capitalize text-slate-800">
                        {source.consolidationPolicy.replace('_', ' ')}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
