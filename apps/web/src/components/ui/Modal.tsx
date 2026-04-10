import React, { useEffect } from 'react';
import './ui.css';

export function Modal({
  open,
  onClose,
  children,
}: React.PropsWithChildren<{ open: boolean; onClose: () => void }>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="hna-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="hna-modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
