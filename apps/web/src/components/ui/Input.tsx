import React from 'react';
import './ui.css';

/**
 * Underline-style instrument input. Transparent background, 2px bottom hairline
 * that turns amber on focus; placeholder is monospace at 60% opacity.
 *
 * Accessibility:
 *   - Always pair with a `<label htmlFor={id}>` (or wrap inside a `<label>`).
 *     The `id` prop is forwarded so form-label association just works.
 *   - The global `:focus-visible` ring is inherited.
 *
 * @example
 *   <label htmlFor="callsign">Callsign</label>
 *   <Input id="callsign" value={cs} onChange={(e) => setCs(e.target.value)} />
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`hna-input ${className}`.trim()} {...rest} />;
  },
);
