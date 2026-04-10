import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CallsignInput } from './CallsignInput.js';

describe('CallsignInput', () => {
  it('uppercases as the user types', async () => {
    const onChange = vi.fn();
    render(<CallsignInput value="" onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), 'w1aw');
    expect(onChange).toHaveBeenLastCalledWith('W1AW');
  });

  it('marks invalid value as aria-invalid', () => {
    render(<CallsignInput value="X" onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('marks valid value as not invalid', () => {
    render(<CallsignInput value="W1AW" onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
  });
});
