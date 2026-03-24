import { Modal } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  message: string;
  confirmLabel?: string;
  confirmColor?: 'critical' | 'primary';
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Confirm',
  message,
  confirmLabel = 'Confirm',
  confirmColor = 'critical',
  loading = false,
}: ConfirmDialogProps) {
  const colorClasses = confirmColor === 'critical'
    ? 'bg-critical/10 border-critical/30 text-critical hover:bg-critical/20'
    : 'bg-white text-black border-white hover:bg-neutral-200';

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-neutral-400 mb-6">{message}</p>
      <div className="flex gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className={`px-3 py-1.5 border rounded text-xs font-medium transition-colors disabled:opacity-50 ${colorClasses}`}
        >
          {loading ? 'Working...' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
