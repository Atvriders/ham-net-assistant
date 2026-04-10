import React from 'react';

export function ScriptEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      className="hna-input"
      style={{ minHeight: 300, width: '100%', fontFamily: 'ui-monospace, Menlo, monospace' }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="# Net script&#10;Welcome to the club net..."
    />
  );
}
