import React from 'react';
import { CaptureStatus } from '../../shared/types';
import { CircleDot, Pause, Square, AlertTriangle, Unlink, Loader2 } from 'lucide-react';

interface Props {
  status: CaptureStatus;
}

export const StatusBadge: React.FC<Props> = ({ status }) => {
  switch (status) {
    case 'recording':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200 shadow-sm animate-pulse">
          <CircleDot className="w-3.5 h-3.5 text-emerald-600" />
          Recording
        </span>
      );
    case 'paused':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
          <Pause className="w-3.5 h-3.5 text-amber-600" />
          Paused
        </span>
      );
    case 'starting':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
          <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" />
          Connecting
        </span>
      );
    case 'stopped':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
          <Square className="w-3.5 h-3.5 text-slate-500" />
          Stopped
        </span>
      );
    case 'detached':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-800 border border-orange-200">
          <Unlink className="w-3.5 h-3.5 text-orange-600" />
          Detached
        </span>
      );
    case 'error':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200">
          <AlertTriangle className="w-3.5 h-3.5 text-red-600" />
          Error
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200">
          <CircleDot className="w-3.5 h-3.5 text-slate-400" />
          Idle
        </span>
      );
  }
};
