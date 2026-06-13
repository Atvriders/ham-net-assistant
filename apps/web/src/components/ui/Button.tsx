import React from 'react';
import './ui.css';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/**
 * Calibrated-instrument console button.
 *
 * Visual: rectangular, 2px border, uppercase JetBrains-Mono label with wide
 * tracking; the `primary` variant carries a 6px ascender stripe on the left
 * edge that nods at instrument-panel switches. Hover sweeps a thin underline
 * beneath the label.
 *
 * Accessibility: focus-visible ring is inherited globally. The accessible
 * name comes from `children`; pass `aria-label` when the button is icon-only.
 *
 * @example
 *   <Button variant="primary" onClick={save}>Save</Button>
 *   <Button variant="ghost" size="sm">Cancel</Button>
 */
export function Button({
  variant = 'primary',
  size,
  className = '',
  ...rest
}: ButtonProps) {
  const cls = [
    'hna-btn',
    variant !== 'primary' ? variant : '',
    size === 'sm' ? 'size-sm' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <button className={cls} {...rest} />;
}
