import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Clock } from './Clock.js';

describe('Clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin to a known wall-clock instant so the rendered string is stable.
    vi.setSystemTime(new Date(2026, 5, 22, 13, 45, 10));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an HH:MM:SS time string', () => {
    render(<Clock />);
    const timer = screen.getByLabelText('Current local time');
    expect(timer.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('advances every second', () => {
    render(<Clock />);
    const timer = screen.getByLabelText('Current local time');
    expect(timer.textContent).toContain('13:45:10');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(timer.textContent).toContain('13:45:11');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(timer.textContent).toContain('13:45:13');
  });

  it('drops the seconds in compact mode', () => {
    render(<Clock compact />);
    const timer = screen.getByLabelText('Current local time');
    // Still HH:MM but no trailing :SS segment in the visible time span.
    expect(timer.querySelector('.hna-clock__seconds')).toBeNull();
    expect(timer.textContent).toContain('13:45');
  });

  it('omits the tz label when hideTz is set', () => {
    render(<Clock hideTz />);
    const timer = screen.getByLabelText('Current local time');
    expect(timer.querySelector('.hna-clock__tz')).toBeNull();
  });
});
