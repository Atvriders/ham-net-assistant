import React, { useEffect } from 'react';
import './ui.css';

export function Modal({
  open,
  onClose,
  size = 'default',
  children,
}: React.PropsWithChildren<{
  open: boolean;
  onClose: () => void;
  /** 'default' caps at ~560px (login/confirm dialogs); 'wide' stretches near full-screen for editors. */
  size?: 'default' | 'wide';
}>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const cls = size === 'wide' ? 'hna-modal hna-modal--wide' : 'hna-modal';
  return (
    <div className="hna-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className={cls} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
