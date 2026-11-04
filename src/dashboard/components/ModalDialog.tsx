import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

interface ModalDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  allowBackdropDismiss?: boolean;
  maxWidthClass?: string;
  headerActions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export const ModalDialog: React.FC<ModalDialogProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  allowBackdropDismiss = true,
  maxWidthClass = "max-w-2xl",
  headerActions,
  footer,
  children,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open && typeof dialog.showModal === "function") {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  // Sync native `close` event (Esc key, back gesture, or light dismiss) and reset returnValue
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = "";
      onClose();
    };

    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  // Fallback for browsers without native `<dialog closedby="any">` support (< Chrome 134)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !allowBackdropDismiss) return;
    if (
      typeof HTMLDialogElement !== "undefined" &&
      "closedBy" in HTMLDialogElement.prototype
    ) {
      return;
    }

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = e.target === dialog && isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && e.target === dialog && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, [allowBackdropDismiss]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={subtitle ? subtitleId : undefined}
      {...({ closedby: allowBackdropDismiss ? "any" : "closerequest" } as any)}
      className={`w-full ${maxWidthClass} rounded-2xl shadow-elevated border border-stone-200 bg-white text-obsidian-900 overflow-hidden m-auto`}
    >
      {isOpen && (
        <div className="flex flex-col max-h-[88vh] w-full">
          {/* Header */}
          <div className="px-6 py-4 border-b border-stone-200/80 flex items-start justify-between gap-4 bg-stone-50/70">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="font-bold text-obsidian-900 text-base leading-snug"
              >
                {title}
              </h2>
              {subtitle && (
                <p
                  id={subtitleId}
                  className="text-xs text-stone-600 mt-0.5 leading-relaxed"
                >
                  {subtitle}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {headerActions}
              <button
                type="button"
                onClick={() => dialogRef.current?.close()}
                aria-label="Close dialog"
                className="p-1.5 text-stone-500 hover:text-obsidian-900 rounded-lg hover:bg-stone-200/60 transition"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">{children}</div>

          {/* Optional Footer */}
          {footer && (
            <div className="px-6 py-3.5 border-t border-stone-200/80 bg-stone-50/70 flex items-center justify-end gap-2.5">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
};
