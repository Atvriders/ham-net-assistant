import React from 'react';
import './ui.css';

export interface SectionDividerProps {
  children: string;
}

/**
 * Horizontal rule with a centered uppercase mono label, like
 *   ——— SECTION ———
 *
 * Purely presentational. The label is mirrored to assistive tech via the
 * default text content (no extra aria needed).
 */
export function SectionDivider({ children }: SectionDividerProps) {
  return (
    <div className="hna-section-divider" role="separator" aria-label={children}>
      <span>{children}</span>
    </div>
  );
}
