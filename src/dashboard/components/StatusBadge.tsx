import React from "react";
import { CaptureStatus } from "../../shared/types";
import {
  Pause,
  Square,
  AlertTriangle,
  Unlink,
  Loader2,
  Circle,
} from "lucide-react";

interface Props {
  status: CaptureStatus;
}

export const StatusBadge: React.FC<Props> = ({ status }) => {
  switch (status) {
    case "recording":
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-obsidian-900 text-brand-300 border border-obsidian-800 shadow-sm">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-80"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-400"></span>
          </span>
          Recording
        </span>
      );
    case "paused":
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
          <Pause className="w-3 h-3 text-amber-700" aria-hidden="true" />
          Paused
        </span>
      );
    case "starting":
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-brand-100 text-brand-900 border border-brand-300">
          <Loader2
            className="w-3 h-3 text-brand-700 animate-spin"
            aria-hidden="true"
          />
          Attaching
        </span>
      );
    case "stopped":
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-stone-100 text-stone-700 border border-stone-300">
          <Square className="w-3 h-3 text-stone-500" aria-hidden="true" />
          Stopped
        </span>
      );
    case "detached":
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-orange-100 text-orange-900 border border-orange-300">
          <Unlink className="w-3 h-3 text-orange-700" aria-hidden="true" />
          Detached
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-900 border border-rose-300">
          <AlertTriangle className="w-3 h-3 text-rose-700" aria-hidden="true" />
          Error
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-stone-100 text-stone-600 border border-stone-200">
          <Circle className="w-2.5 h-2.5 text-stone-400" aria-hidden="true" />
          Ready
        </span>
      );
  }
};
