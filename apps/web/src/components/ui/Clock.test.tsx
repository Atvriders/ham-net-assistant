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

  it('renders a 12-hour H:MM:SS AM|PM time string', () => {
    render(<Clock />);
    const timer = screen.getByLabelText('Current local time');
    expect(timer.textContent).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(timer.textContent).toMatch(/AM|PM/);
  });

  it('advances every second', () => {
    render(<Clock />);
    const timer = screen.getByLabelText('Current local time');
    // 13:45 wall clock renders as 1:45 PM on the 12-hour dial.
    expect(timer.textContent).toContain('1:45:10');
    expect(timer.textContent).toContain('PM');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(timer.textContent).toContain('1:45:11');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(timer.textContent).toContain('1:45:13');
  });

  it('renders midnight as 12:xx AM (no hour 0)', () => {
    vi.setSystemTime(new Date(2026, 5, 22, 0, 5, 7));
    render(<Clock />);
    const timer = screen.getByLabelText('Current local time');
    expect(timer.textContent).toContain('12:05:07');
    expect(timer.textContent).toContain('AM');
  });

  it('drops the seconds in compact mode', () => {
    render(<Clock compact />);
    const timer = screen.getByLabelText('Current local time');
    // Still H:MM but no trailing :SS segment in the visible time span.
    expect(timer.querySelector('.hna-clock__seconds')).toBeNull();
    expect(timer.textContent).toContain('1:45');
    // The meridiem stays even in compact mode.
    expect(timer.textContent).toContain('PM');
  });

  it('omits the tz label when hideTz is set', () => {
    render(<Clock hideTz />);
    const timer = screen.getByLabelText('Current local time');
    expect(timer.querySelector('.hna-clock__tz')).toBeNull();
  });
});
