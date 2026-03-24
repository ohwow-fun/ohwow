import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from '@phosphor-icons/react';

interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

// Use a custom event target to avoid module-level variable reassignment
const toastBus = new EventTarget();

export function toast(type: ToastItem['type'], message: string) {
  toastBus.dispatchEvent(new CustomEvent('toast', { detail: { type, message } }));
}

const TYPE_STYLES = {
  success: 'border-success/30 bg-success/10 text-success',
  error: 'border-critical/30 bg-critical/10 text-critical',
  info: 'border-white/10 bg-white/5 text-neutral-200',
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { type, message } = (e as CustomEvent).detail;
      const id = crypto.randomUUID();
      setToasts(prev => [...prev.slice(-4), { id, type, message }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 5000);
    };
    toastBus.addEventListener('toast', handler);
    return () => toastBus.removeEventListener('toast', handler);
  }, []);

  const dismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className={`flex items-center gap-2 px-4 py-3 rounded-lg border text-sm ${TYPE_STYLES[t.type]}`}
          >
            <span className="flex-1">{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="opacity-60 hover:opacity-100">
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
