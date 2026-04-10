import React from 'react';
import './ui.css';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`hna-input ${className}`} {...rest} />;
  },
);
