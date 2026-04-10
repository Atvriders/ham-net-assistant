import React from 'react';
import './ui.css';

type Variant = 'primary' | 'secondary' | 'danger';

export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`hna-btn ${variant === 'primary' ? '' : variant} ${className}`}
      {...rest}
    />
  );
}
