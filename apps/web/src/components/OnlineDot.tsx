import React from 'react';
import './ui/ui.css';

/**
 * Presence indicator next to a member's name.
 *
 *   - Online: small filled dot in `--color-success`, breathing pulse.
 *   - Offline: a small hollow circle outlined with `--color-border-strong`.
 *
 * Accessibility: always carries an `aria-label` of "Online" / "Offline" so
 * color is not the only signal. Respects `prefers-reduced-motion`.
 */
export function OnlineDot({ online, title }: { online: boolean; title?: string }) {
  return (
    <span
      role="img"
      aria-label={online ? 'Online' : 'Offline'}
      title={title ?? (online ? 'Online' : 'Offline')}
      className={`hna-onlinedot ${online ? 'hna-onlinedot--on' : 'hna-onlinedot--off'}`}
    />
  );
}
