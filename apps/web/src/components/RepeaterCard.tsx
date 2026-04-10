import React from 'react';
import type { Repeater } from '@hna/shared';
import { Card } from './ui/Card.js';
import { formatFrequency, formatOffset, formatTone } from '../lib/format.js';

export function RepeaterCard({
  r,
  onEdit,
  onDelete,
}: {
  r: Repeater;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>{r.name}</h3>
      <div>
        {formatFrequency(r.frequency)} · {formatOffset(r.offsetKhz)} · tone {formatTone(r.toneHz)}
      </div>
      <div>Mode: {r.mode}</div>
      {r.coverage && <p>{r.coverage}</p>}
      {(onEdit || onDelete) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {onEdit && <button onClick={onEdit}>Edit</button>}
          {onDelete && <button onClick={onDelete}>Delete</button>}
        </div>
      )}
    </Card>
  );
}
