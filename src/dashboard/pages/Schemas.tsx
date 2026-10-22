import React, { useState } from 'react';
import { EndpointSchema, EndpointSource } from '../../shared/types';
import { ArrowUpDown, AlertCircle, CheckCircle2, Layers } from 'lucide-react';

interface Props {
  schemas: EndpointSchema[];
  sources: EndpointSource[];
}

export const Schemas: React.FC<Props> = ({ schemas, sources }) => {
  const [selectedSourceId, setSelectedSourceId] = useState<string>(
    schemas[0]?.sourceId || sources[0]?.id || ''
  );

  const activeSchema = schemas.find((s) => s.sourceId === selectedSourceId) || schemas[0];
  const activeSource = sources.find((s) => s.id === (activeSchema?.sourceId || selectedSourceId));

  const fields = activeSchema ? Object.values(activeSchema.fields) : [];

  return (
    <div className="space-y-6">
      {/* Schemas Header & Selector */}
      <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ArrowUpDown className="w-5 h-5 text-indigo-600" />
            Schema Inference & Field Discovery
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Track observed field paths, data types, nullability, and schema drift across pagination responses.
          </p>
        </div>

        {sources.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-600">Source:</label>
            <select
              value={selectedSourceId}
              onChange={(e) => setSelectedSourceId(e.target.value)}
              className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 focus:ring-1 focus:ring-indigo-500"
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.httpMethod} {s.normalizedEndpoint.split('/').slice(-2).join('/')}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {!activeSchema ? (
        <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-12 text-center text-slate-400 text-xs">
          <Layers className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          No schemas discovered yet. Observe API responses to analyze JSON fields.
        </div>
      ) : (
        <div className="space-y-6">
          {/* Schema Metadata Card */}
          <div className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-slate-400 block mb-0.5">Endpoint:</span>
              <span className="font-mono font-semibold text-slate-800 break-all">
                {activeSource?.normalizedEndpoint || activeSchema.sourceId}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block mb-0.5">Extraction Path:</span>
              <code className="bg-indigo-50 text-indigo-700 font-bold px-2 py-0.5 rounded font-mono">
                {activeSchema.inferredRecordPath}
              </code>
            </div>
            <div>
              <span className="text-slate-400 block mb-0.5">Records Analyzed:</span>
              <span className="font-semibold text-slate-800">{activeSchema.detectedCount}</span>
            </div>
            <div>
              <span className="text-slate-400 block mb-0.5">Total Discovered Fields:</span>
              <span className="font-semibold text-slate-800">{fields.length}</span>
            </div>
          </div>

          {/* Fields Table */}
          <div className="bg-white rounded-xl shadow-xs border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-700">
                <thead className="bg-slate-50 text-[11px] font-semibold uppercase text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3">Field Dot Path</th>
                    <th className="px-6 py-3">Detected Types</th>
                    <th className="px-6 py-3">Optionality</th>
                    <th className="px-6 py-3">Type Conflict</th>
                    <th className="px-6 py-3">Sample Values</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fields.map((field) => (
                    <tr key={field.path} className="hover:bg-slate-50/80 transition">
                      <td className="px-6 py-3 font-mono font-semibold text-slate-900">
                        {field.path}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex flex-wrap gap-1">
                          {field.types.map((t) => (
                            <span
                              key={t}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                t === 'string'
                                  ? 'bg-blue-50 text-blue-700'
                                  : t === 'number'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : t === 'boolean'
                                  ? 'bg-purple-50 text-purple-700'
                                  : t === 'array'
                                  ? 'bg-amber-50 text-amber-700'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        {field.optional ? (
                          <span className="text-amber-600 font-semibold text-[11px]">
                            Optional (nullable/absent)
                          </span>
                        ) : (
                          <span className="text-emerald-600 font-semibold text-[11px]">
                            Required (in all items)
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        {field.hasConflict ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-600">
                            <AlertCircle className="w-3.5 h-3.5" /> Conflict
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Consistent
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3 font-mono text-[11px] text-slate-500 max-w-xs truncate">
                        {field.sampleValues.map((v) => JSON.stringify(v)).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
