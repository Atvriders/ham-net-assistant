import React from 'react';

/**
 * Small status dot shown next to a member's name. Green when the member is
 * online (recent presence heartbeat), a muted hollow dot otherwise.
 */
export function OnlineDot({ online, title }: { online: boolean; title?: string }) {
  return (
    <span
      aria-label={online ? 'Online' : 'Offline'}
      title={title ?? (online ? 'Online' : 'Offline')}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        background: online ? 'var(--color-success)' : 'transparent',
        border: online ? 'none' : '1px solid var(--color-border)',
        boxShadow: online ? '0 0 4px var(--color-success)' : 'none',
      }}
    />
  );
}
