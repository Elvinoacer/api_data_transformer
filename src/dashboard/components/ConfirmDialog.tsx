import React from 'react';
import { ModalDialog } from './ModalDialog';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning';
  isBusy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  variant = 'danger',
  isBusy = false,
  onConfirm,
  onCancel,
}) => {
  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      allowBackdropDismiss={false}
      maxWidthClass="max-w-md"
      footer={
        <>
          {/* Put autofocus on the safe Cancel action per accessible dialog best practices */}
          <button
            type="button"
            autoFocus
            disabled={isBusy}
            onClick={onCancel}
            className="px-4 py-2 text-xs font-semibold text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-xl transition disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={onConfirm}
            className={`px-4 py-2 text-xs font-semibold rounded-xl shadow-sm transition disabled:opacity-50 ${
              variant === 'danger'
                ? 'bg-rose-600 hover:bg-rose-700 text-white'
                : 'bg-amber-600 hover:bg-amber-700 text-white'
            }`}
          >
            {isBusy ? 'Working...' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="p-6 flex items-start gap-3.5">
        <div
          className={`p-2.5 rounded-xl flex-shrink-0 ${
            variant === 'danger'
              ? 'bg-rose-50 text-rose-600 border border-rose-200'
              : 'bg-amber-50 text-amber-700 border border-amber-200'
          }`}
        >
          <AlertTriangle className="w-5 h-5" aria-hidden="true" />
        </div>
        <p className="text-xs text-stone-700 leading-relaxed pt-0.5">{description}</p>
      </div>
    </ModalDialog>
  );
};
