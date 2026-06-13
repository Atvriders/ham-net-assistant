import React from 'react';
import './ui.css';

export interface CardProps {
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Instrument-module card. Sharp hairline border, four tiny amber corner
 * brackets pinned to the corners, surface tone, generous padding. No drop
 * shadow — elevation is communicated by border and corner brackets.
 *
 * @example
 *   <Card>
 *     <h2>Net status</h2>
 *     ...
 *   </Card>
 */
export function Card({
  children,
  className = '',
  style,
}: React.PropsWithChildren<CardProps>) {
  return (
    <div className="hna-card-frame" style={style}>
      <div className={`hna-card ${className}`.trim()}>{children}</div>
      <span className="hna-card-corner-bl" aria-hidden="true" />
      <span className="hna-card-corner-br" aria-hidden="true" />
    </div>
  );
}
