import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepeaterFacts } from './RepeaterFacts.js';

const primary = { name: 'W0QQQ 145.41', frequency: 145.41 };
const twoLinks = [
  { id: 'l1', repeater: { name: 'K0ABC 147.15', frequency: 147.15 } },
  { id: 'l2', repeater: { name: 'Mt Oread', frequency: 442.1 } },
];

describe('RepeaterFacts', () => {
  it('dedupes the frequency out of the primary name', () => {
    render(<RepeaterFacts repeater={primary} />);
    const row = screen.getByTestId('repeater-primary');
    // The bug: "W0QQQ 145.41 · 145.410 MHz" printed the number twice.
    expect(row).toHaveTextContent('W0QQQ');
    expect(row).toHaveTextContent('145.410 MHz');
    expect(row.textContent?.match(/145\.41/g)).toHaveLength(1);
  });

  it('leaves a name whose number is a DIFFERENT machine alone', () => {
    render(<RepeaterFacts repeater={{ name: 'Mt Oread 146.94', frequency: 145.41 }} />);
    const row = screen.getByTestId('repeater-primary');
    expect(row).toHaveTextContent('Mt Oread 146.94');
    expect(row).toHaveTextContent('145.410 MHz');
  });

  it('renders no linked group when there are no links', () => {
    const { rerender } = render(<RepeaterFacts repeater={primary} />);
    expect(screen.queryByTestId('repeater-links')).toBeNull();
    rerender(<RepeaterFacts repeater={primary} links={[]} />);
    expect(screen.queryByTestId('repeater-links')).toBeNull();
    rerender(<RepeaterFacts repeater={primary} links={null} />);
    expect(screen.queryByTestId('repeater-links')).toBeNull();
  });

  it('lists every linked repeater by name and frequency when not compact', () => {
    render(<RepeaterFacts repeater={primary} links={twoLinks} />);
    const group = screen.getByTestId('repeater-links');
    const rows = screen.getAllByTestId('repeater-link');
    expect(rows).toHaveLength(2);
    // Linked names are deduped too, and each carries its own frequency.
    expect(rows[0]).toHaveTextContent('K0ABC');
    expect(rows[0]).toHaveTextContent('147.150 MHz');
    expect(rows[0]?.textContent).not.toContain('147.15 ·');
    expect(rows[1]).toHaveTextContent('Mt Oread');
    expect(rows[1]).toHaveTextContent('442.100 MHz');
    // The roomy layout spells the machines out instead of folding them to "+N".
    expect(group).not.toHaveTextContent('+2');
  });

  it('folds the links to "+N LINKED" with the full list in the tooltip when compact', () => {
    render(<RepeaterFacts repeater={primary} links={twoLinks} compact />);
    const group = screen.getByTestId('repeater-links');
    expect(group).toHaveTextContent('+2 LINKED');
    // The strip is one line on a phone, so the machines net control has to
    // name on the air survive in the tooltip rather than being dropped.
    const title = group.getAttribute('title') ?? '';
    expect(title).toContain('K0ABC · 147.150 MHz');
    expect(title).toContain('Mt Oread · 442.100 MHz');
    expect(screen.queryAllByTestId('repeater-link')).toHaveLength(0);
    // The primary is still fully rendered alongside the summary.
    expect(screen.getByTestId('repeater-primary')).toHaveTextContent('W0QQQ');
  });

  it('names the linked group for screen readers instead of leaning on the · glyph', () => {
    const { rerender } = render(<RepeaterFacts repeater={primary} links={twoLinks} />);
    expect(screen.getByRole('group', { name: 'Linked repeaters' })).toBeInTheDocument();
    rerender(<RepeaterFacts repeater={primary} links={twoLinks} compact />);
    // Compact hides the list visually, so the accessible name carries it.
    const group = screen.getByRole('group', { name: /^Linked repeaters:/ });
    expect(group.getAttribute('aria-label')).toContain('K0ABC · 147.150 MHz');
  });
});
