import React from 'react';
import { formatFrequency, repeaterDisplayName } from '../lib/format.js';
import './ui/ui.css';

interface RepeaterRef {
  name: string;
  frequency: number;
}

export interface RepeaterFactsProps {
  repeater: { name: string; frequency: number };
  links?: Array<{ id: string; repeater: { name: string; frequency: number } }> | null;
  /** Compact single-line rendering for the narrow status strip. */
  compact?: boolean;
}

/**
 * The "·" is decoration, never meaning — screen readers get the name and the
 * frequency as adjacent text, which is how an operator would say it on the air.
 */
function Sep() {
  return (
    <span aria-hidden="true" style={{ opacity: 0.7 }}>
      ·
    </span>
  );
}

/** "W0QQQ · 145.410 MHz" — the deduped name plus the canonical frequency. */
function repeaterLabel(r: RepeaterRef): string {
  return `${repeaterDisplayName(r.name, r.frequency)} · ${formatFrequency(r.frequency)}`;
}

function RepeaterLine({ repeater, testId }: { repeater: RepeaterRef; testId?: string }) {
  return (
    <span
      data-testid={testId}
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}
    >
      <strong>{repeaterDisplayName(repeater.name, repeater.frequency)}</strong>
      <Sep />
      <strong className="hna-mono">{formatFrequency(repeater.frequency)}</strong>
    </span>
  );
}

/**
 * The repeater half of the run-net status strip.
 *
 * Two operational facts live here. First, the primary machine's name is passed
 * through {@link repeaterDisplayName}, because clubs name repeaters after their
 * frequency and the strip was printing it twice ("W0QQQ 145.41 · 145.410 MHz").
 * Second, the LINKED machines are shown at all: net control has to say on the
 * air which systems are tied together before taking check-ins, so a linked
 * net whose links are invisible in the console is a net run wrong — this is
 * load-bearing information, not decoration.
 *
 * `compact` is for the sticky strip on a phone, where the whole row is one
 * line: the links collapse to "+N LINKED" with the full list in the tooltip
 * and in the group's accessible name, so nothing is lost, only folded.
 *
 * All visual styling is inline: the run-net layout (ui.css) is owned elsewhere
 * and this component must drop into either a strip or a card without waiting
 * for a stylesheet rule to exist.
 */
export function RepeaterFacts({
  repeater,
  links,
  compact = false,
}: RepeaterFactsProps): React.JSX.Element {
  const linked = links ?? [];
  const linkedLabels = linked.map((l) => repeaterLabel(l.repeater));

  return (
    <span
      className="hna-repeater-facts"
      data-testid="repeater-facts"
      data-compact={compact ? 'true' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: compact ? 8 : 10,
        flexWrap: compact ? 'nowrap' : 'wrap',
        minWidth: 0,
      }}
    >
      <RepeaterLine repeater={repeater} testId="repeater-primary" />

      {linked.length > 0 &&
        (compact ? (
          <span
            role="group"
            aria-label={`Linked repeaters: ${linkedLabels.join(', ')}`}
            title={`Linked: ${linkedLabels.join(', ')}`}
            data-testid="repeater-links"
            className="hna-mono"
            style={{
              fontSize: 12,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--color-fg-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            +{linked.length} LINKED
          </span>
        ) : (
          <span
            role="group"
            aria-label="Linked repeaters"
            data-testid="repeater-links"
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 8,
              flexWrap: 'wrap',
              minWidth: 0,
            }}
          >
            <span
              className="hna-cap"
              aria-hidden="true"
              style={{ margin: 0, color: 'var(--color-fg-muted)' }}
            >
              LINKED
            </span>
            {linked.map((l, i) => (
              <RepeaterLine key={l.id || `link-${i}`} repeater={l.repeater} testId="repeater-link" />
            ))}
          </span>
        ))}
    </span>
  );
}
