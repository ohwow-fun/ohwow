import { CircleNotch } from '@phosphor-icons/react';
import { Modal } from '../../../components/Modal';

interface Props {
  open: boolean;
  modelTag: string;
  modelLabel: string;
  isActive: boolean;
  isOrchestrator: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteModelModal({ open, modelTag, modelLabel, isActive, isOrchestrator, loading, onConfirm, onClose }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="Delete model">
      <p className="text-sm mb-3">
        Remove <strong>{modelLabel}</strong> <span className="text-neutral-400 font-mono text-xs">({modelTag})</span> from your machine?
      </p>
      {isActive && (
        <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 mb-3">
          <p className="text-xs text-warning">
            This is your active model. Deleting it will clear the active model setting. You&apos;ll need to select a different model afterward.
          </p>
        </div>
      )}
      {isOrchestrator && (
        <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3 mb-3">
          <p className="text-xs text-purple-400">
            This is your orchestrator model. Deleting it will reset the orchestrator to auto mode.
          </p>
        </div>
      )}
      <p className="text-xs text-neutral-400 mb-4">
        The model files will be removed from disk. You can reinstall it from the catalog later.
      </p>
      <div className="flex gap-2 justify-end">
        <button
          onClick={onClose}
          disabled={loading}
          className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium bg-critical/10 border border-critical/30 text-critical rounded-lg hover:bg-critical/20 transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {loading && <CircleNotch size={12} className="animate-spin" />}
          {loading ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}
