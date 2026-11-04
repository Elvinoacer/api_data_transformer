import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  Info,
  X,
  Cpu,
  User,
} from "lucide-react";

export type ToastVariant = "success" | "info" | "warning" | "error";

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  actor?: "user" | "system";
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  notify: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue>({
  notify: () => {},
});

export const useToast = () => useContext(ToastContext);

const ToastCard: React.FC<{
  item: ToastItem;
  index: number;
  onDismiss: (id: string) => void;
}> = ({ item, index, onDismiss }) => {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = popoverRef.current as any;
    if (el && typeof el.showPopover === "function") {
      try {
        el.showPopover();
      } catch {
        // Fallback when already open or unsupported
      }
    }
    const timer = setTimeout(
      () => {
        onDismiss(item.id);
      },
      item.durationMs ?? (item.variant === "error" ? 6000 : 4000),
    );

    return () => clearTimeout(timer);
  }, [item.id, item.durationMs, item.variant, onDismiss]);

  const icon =
    item.variant === "success" ? (
      <CheckCircle2
        className="w-4 h-4 text-brand-700 flex-shrink-0"
        aria-hidden="true"
      />
    ) : item.variant === "warning" ? (
      <AlertTriangle
        className="w-4 h-4 text-amber-600 flex-shrink-0"
        aria-hidden="true"
      />
    ) : item.variant === "error" ? (
      <AlertOctagon
        className="w-4 h-4 text-rose-600 flex-shrink-0"
        aria-hidden="true"
      />
    ) : (
      <Info
        className="w-4 h-4 text-brand-700 flex-shrink-0"
        aria-hidden="true"
      />
    );

  const borderStyle =
    item.variant === "error"
      ? "border-rose-300 bg-white"
      : item.variant === "warning"
        ? "border-amber-300 bg-white"
        : item.variant === "success"
          ? "border-brand-300 bg-white"
          : "border-stone-200 bg-white";

  return (
    <div
      ref={popoverRef}
      {...({ popover: "manual" } as any)}
      style={{ bottom: `${1.25 + index * 4.5}rem` }}
      className="toast-popover fixed right-5 z-50 w-80 sm:w-96 pointer-events-auto transition-all duration-200"
    >
      <div
        className={`rounded-xl border shadow-elevated px-4 py-3 flex items-start gap-3 ${borderStyle}`}
      >
        <div className="mt-0.5">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {item.actor && (
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                  item.actor === "system"
                    ? "bg-obsidian-900 text-brand-300"
                    : "bg-brand-100 text-brand-900"
                }`}
              >
                {item.actor === "system" ? (
                  <Cpu className="w-2.5 h-2.5" aria-hidden="true" />
                ) : (
                  <User className="w-2.5 h-2.5" aria-hidden="true" />
                )}
                {item.actor}
              </span>
            )}
            <p className="text-xs font-bold text-obsidian-900 truncate">
              {item.title}
            </p>
          </div>
          {item.description && (
            <p className="text-[11px] text-stone-600 mt-0.5 leading-snug break-words">
              {item.description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          aria-label={`Dismiss notification: ${item.title}`}
          className="p-1 text-stone-400 hover:text-obsidian-900 rounded-md hover:bg-stone-100 transition flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [politeAnnouncement, setPoliteAnnouncement] = useState("");
  const [assertiveAnnouncement, setAssertiveAnnouncement] = useState("");

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback((input: ToastInput) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const variant = input.variant || "info";
    const item: ToastItem = { ...input, id, variant };

    setToasts((prev) => [item, ...prev].slice(0, 4));

    const spoken = input.description
      ? `${input.title}. ${input.description}`
      : input.title;
    if (variant === "error") {
      setAssertiveAnnouncement(spoken);
    } else {
      setPoliteAnnouncement(spoken);
    }
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}

      {/* Centralized accessible live regions (1 polite, 1 assertive) */}
      <div aria-live="polite" aria-atomic="true" className="visually-hidden">
        {politeAnnouncement}
      </div>
      <div role="alert" aria-atomic="true" className="visually-hidden">
        {assertiveAnnouncement}
      </div>

      {/* Top-layer manual popovers */}
      {toasts.map((t, idx) => (
        <ToastCard key={t.id} item={t} index={idx} onDismiss={dismiss} />
      ))}
    </ToastContext.Provider>
  );
};
