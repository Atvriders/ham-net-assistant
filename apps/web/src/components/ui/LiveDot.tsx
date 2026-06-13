import React from 'react';
import './ui.css';

export interface LiveDotProps {
  /** Optional override label; defaults to "Live". */
  label?: string;
  /** Optional `title` attribute (tooltip). */
  title?: string;
}

/**
 * Breathing-pulse live indicator — a small red dot that pulses every 1500ms.
 *
 * Color is never the only signal: an `aria-label` of "Live" (or a custom label)
 * accompanies the visual. Respects `prefers-reduced-motion` (animation
 * disabled, dot still visible).
 *
 * @example
 *   <LiveDot /> {/* on-air indicator next to a session name *\/}
 */
export function LiveDot({ label = 'Live', title }: LiveDotProps) {
  return (
    <span
      role="img"
      aria-label={label}
      title={title ?? label}
      className="hna-livedot"
    />
  );
}
