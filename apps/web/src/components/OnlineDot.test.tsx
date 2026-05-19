import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OnlineDot } from './OnlineDot.js';

describe('OnlineDot', () => {
  it('labels itself Online when online', () => {
    render(<OnlineDot online />);
    expect(screen.getByLabelText('Online')).toBeInTheDocument();
  });

  it('labels itself Offline when not online', () => {
    render(<OnlineDot online={false} />);
    expect(screen.getByLabelText('Offline')).toBeInTheDocument();
  });

  it('uses a custom title when provided', () => {
    render(<OnlineDot online title="Seen 1m ago" />);
    expect(screen.getByLabelText('Online')).toHaveAttribute('title', 'Seen 1m ago');
  });
});
