import React from 'react';
import './ui.css';

export function Card({
  children,
  className = '',
}: React.PropsWithChildren<{ className?: string }>) {
  return <div className={`hna-card ${className}`}>{children}</div>;
}
