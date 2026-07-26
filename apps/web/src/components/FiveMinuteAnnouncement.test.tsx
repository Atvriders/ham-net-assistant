import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { FiveMinuteAnnouncement } from './FiveMinuteAnnouncement.js';

const weeklyUtc = { kind: 'weekly', startLocal: '20:00', timezone: 'UTC' };

/** Injectable-clock helper: a `now` prop pinned to the given instant. */
const at = (iso: string) => () => new Date(iso);

describe('FiveMinuteAnnouncement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the flashing banner with the 12-hour start time inside the window', () => {
    render(
      <FiveMinuteAnnouncement net={weeklyUtc} now={at('2026-07-18T19:57:00Z')} />,
    );
    const banner = screen.getByTestId('five-minute-banner');
    expect(banner).toHaveTextContent(
      '// 5-MINUTE ANNOUNCEMENT — NET STARTS AT 8:00 PM',
    );
    expect(banner).toHaveClass('hna-fivemin');
  });

  it('shows at exactly 5 minutes out but not before', () => {
    const { unmount } = render(
      <FiveMinuteAnnouncement net={weeklyUtc} now={at('2026-07-18T19:55:00Z')} />,
    );
    expect(screen.getByTestId('five-minute-banner')).toBeInTheDocument();
    unmount();
    // 5m30s out — still outside the window.
    render(
      <FiveMinuteAnnouncement net={weeklyUtc} now={at('2026-07-18T19:54:30Z')} />,
    );
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it('hides once the start time is reached or passed', () => {
    const { unmount } = render(
      <FiveMinuteAnnouncement net={weeklyUtc} now={at('2026-07-18T20:00:00Z')} />,
    );
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
    unmount();
    render(
      <FiveMinuteAnnouncement net={weeklyUtc} now={at('2026-07-18T20:03:00Z')} />,
    );
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it("computes the window in the net's IANA timezone, not UTC", () => {
    const chicago = {
      kind: 'weekly',
      startLocal: '20:00',
      timezone: 'America/Chicago',
    };
    // 00:58Z on Jul 19 = 19:58 CDT on Jul 18 — 2 minutes before the start.
    const { unmount } = render(
      <FiveMinuteAnnouncement net={chicago} now={at('2026-07-19T00:58:00Z')} />,
    );
    expect(screen.getByTestId('five-minute-banner')).toBeInTheDocument();
    unmount();
    // 19:58Z = 14:58 CDT — hours away on the net's wall clock.
    render(
      <FiveMinuteAnnouncement net={chicago} now={at('2026-07-18T19:58:00Z')} />,
    );
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it('handles a start just after midnight (23:59 counts as 3 minutes before 00:02)', () => {
    const midnight = { kind: 'weekly', startLocal: '00:02', timezone: 'UTC' };
    render(
      <FiveMinuteAnnouncement net={midnight} now={at('2026-07-18T23:59:00Z')} />,
    );
    expect(screen.getByTestId('five-minute-banner')).toHaveTextContent(
      'NET STARTS AT 12:02 AM',
    );
  });

  it('renders nothing for impromptu nets even inside the window', () => {
    render(
      <FiveMinuteAnnouncement
        net={{ kind: 'impromptu', startLocal: '20:00', timezone: 'UTC' }}
        now={at('2026-07-18T19:57:00Z')}
      />,
    );
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it('renders nothing when the schedule fields are missing', () => {
    render(
      <FiveMinuteAnnouncement
        net={{ kind: 'weekly', startLocal: null, timezone: null }}
        now={at('2026-07-18T19:57:00Z')}
      />,
    );
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it('ticks itself into and out of the window on its interval', () => {
    vi.useFakeTimers();
    // 7 minutes before the 20:00Z start — outside the window.
    vi.setSystemTime(new Date('2026-07-18T19:53:00Z'));
    render(<FiveMinuteAnnouncement net={weeklyUtc} />);
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
    // +2m30s → 19:55:30, 4.5 minutes out: the 15s tick picks it up.
    act(() => {
      vi.advanceTimersByTime(150_000);
    });
    expect(screen.getByTestId('five-minute-banner')).toBeInTheDocument();
    // +5m → 20:00:30, the start has passed: banner clears on its own.
    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });
});

describe('FiveMinuteAnnouncement auto-start countdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a seconds-aware countdown outside the 5-minute window (calm strip, no flash class)', () => {
    // 20:00 start, now 19:20:28 → 39m32s remaining.
    render(
      <FiveMinuteAnnouncement net={weeklyUtc} now={at('2026-07-18T19:20:28Z')} />,
    );
    const strip = screen.getByTestId('prep-countdown');
    expect(strip).toHaveTextContent('// AUTO-START IN 39:32');
    expect(strip).not.toHaveClass('hna-fivemin');
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it('ticks toward zero every second and carries the countdown into the flashing 5-minute banner', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T19:55:28Z'));
    render(<FiveMinuteAnnouncement net={weeklyUtc} />);
    // 4m32s out — inside the window, so the flashing banner hosts the countdown.
    const banner = screen.getByTestId('five-minute-banner');
    expect(banner).toHaveTextContent('AUTO-START IN 04:32');
    expect(banner).toHaveTextContent('5-MINUTE ANNOUNCEMENT');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('five-minute-banner')).toHaveTextContent(
      'AUTO-START IN 04:31',
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByTestId('five-minute-banner')).toHaveTextContent(
      'AUTO-START IN 04:01',
    );
  });

  it('shows STARTING… at zero and fires onStartDue exactly once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T19:59:58Z'));
    const onStartDue = vi.fn();
    render(<FiveMinuteAnnouncement net={weeklyUtc} onStartDue={onStartDue} />);
    // Still 2 seconds out — countdown visible, callback not yet fired.
    expect(screen.getByTestId('five-minute-banner')).toHaveTextContent(
      'AUTO-START IN 00:02',
    );
    expect(onStartDue).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const strip = screen.getByTestId('prep-countdown');
    expect(strip).toHaveTextContent('// STARTING…');
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
    expect(onStartDue).toHaveBeenCalledTimes(1);
    // Ticking on through the grace window must not re-fire the callback.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('prep-countdown')).toHaveTextContent(
      '// STARTING…',
    );
    expect(onStartDue).toHaveBeenCalledTimes(1);
  });

  it('hides the strip once the grace window passes (manual start is the fallback)', () => {
    // 15 minutes after the 20:00 start — grace expired, server missed it.
    render(
      <FiveMinuteAnnouncement net={weeklyUtc} now={at('2026-07-18T20:15:00Z')} />,
    );
    expect(screen.queryByTestId('prep-countdown')).not.toBeInTheDocument();
    expect(screen.queryByTestId('five-minute-banner')).not.toBeInTheDocument();
  });

  it('renders no countdown for impromptu nets', () => {
    render(
      <FiveMinuteAnnouncement
        net={{ kind: 'impromptu', startLocal: '20:00', timezone: 'UTC' }}
        now={at('2026-07-18T19:30:00Z')}
      />,
    );
    expect(screen.queryByTestId('prep-countdown')).not.toBeInTheDocument();
  });
});
