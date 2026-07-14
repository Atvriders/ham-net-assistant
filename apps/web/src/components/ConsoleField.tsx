import React, { useEffect, useRef, useState } from 'react';

/*
 * ConsoleField — "phosphor excitation field" interactive background.
 *
 * The app's static graph-paper grid (painted by ui.css on <body>, 24px pitch,
 * background-attachment: fixed) becomes a live instrument surface. The cursor
 * IS the electron beam; the grid is the phosphor. There is no click feedback
 * of any kind — every bit of the interaction budget goes into hover:
 *
 *   1. Crosshair scan — the grid column and row passing through the cursor's
 *      nearest intersection illuminate along their length, brightest at the
 *      cursor and dying away with a gaussian falloff (1px strokes painted with
 *      a linear gradient, so they fade out instead of ending abruptly). The
 *      dimmest element on screen: an instrument's cursor readout.
 *
 *   2. Velocity-reactive trace — the beam deposits excitation at grid
 *      intersections it passes. Cursor speed (smoothed) maps to trail
 *      retention, per-sample intensity, and excitation radius: a fast sweep
 *      lays a long, wide, dim streak; slow movement lays a short, tight, bright
 *      one. Every deposit cools over ~800ms like CRT persistence.
 *
 *   3. Dwell bloom — when the beam rests, the intersection it is parked on
 *      accumulates charge over ~800ms: it brightens beyond the normal
 *      excitation cap (up to ~2x, still a whisper) and its glow grows from
 *      18px to 26px. Moving off lets the charge bleed away over ~320ms.
 *
 *   4. Node lock — the single nearest intersection carries a slightly brighter
 *      core plus a small crisp ring, snapping intersection-to-intersection as
 *      the cursor crosses cell boundaries: a subtle "signal lock".
 *
 * Brightness order (all ambient): crosshair < excited dots < node-lock core.
 *
 * Stacking: the canvas is position:fixed, inset:0, z-index:-1, pointer-events
 * none. <html> carries no background of its own, so <body>'s grid background
 * propagates to the root canvas and paints BELOW negative-z-index elements;
 * the canvas therefore sits above the static grid but below all in-flow app
 * content, the sticky nav (z-index 30), and modal backdrops (z-index 50).
 *
 * IDLE-LOOP GUARANTEE (critical): a requestAnimationFrame is scheduled only
 * while something is actually changing frame-over-frame. The loop stops when
 * ALL of the following hold, and the last frame is simply left painted on the
 * canvas — the phosphor holds its charge when the beam rests:
 *
 *      no unconsumed pointer move  &&  no live trail samples  &&
 *      smoothed speed snapped to exactly 0  &&
 *      the presence energy did not change this frame  &&
 *      the dwell charge did not change this frame
 *
 * Because energy and dwell integrate LINEARLY with a dt that is clamped to at
 * least 1ms, "did not change this frame" can only mean "clamped at a limit"
 * (0 or 1) — i.e. fully faded in/out and fully bloomed/bled — so the test is
 * exact and needs no epsilon. A stationary cursor therefore saturates its bloom
 * and then costs zero CPU; a pointermove sets pendingMove and calls
 * ensureRunning(), which re-arms the loop exactly once (it no-ops while an rAF
 * is already pending, so there is never a double loop).
 */

/** Grid geometry — must match the repeating-linear-gradient in ui.css:
 *  each 24px period is transparent for 23px then a 1px line, so line pixel
 *  centers sit at 24k - 0.5 (k >= 1) in viewport coordinates. */
const GRID = 24;
const GRID_LINE = -0.5;

/* Beam trace (velocity-reactive) tuning */
const TRAIL_LIFE_MS = 800; // CRT-style persistence
const TRAIL_CAP_MAX = 48; // hard bound on retained samples (fast sweep)
const TRAIL_CAP_MIN = 12; // retained samples when the beam crawls
const TRAIL_MIN_DIST = 2; // ignore sub-pixel jitter between samples
const SPEED_FAST = 1800; // px/s treated as "fully fast"
const SPEED_SMOOTH = 0.25; // per-frame lerp toward the instantaneous speed
const SPEED_EPS = 1; // px/s below which the smoothed speed snaps to exactly 0
const RADIUS_SLOW = 92; // tight excitation when moving slowly
const RADIUS_FAST = 132; // wide, smeared excitation on a fast sweep
const GAIN_SLOW = 1; // per-sample intensity when moving slowly (bright)
const GAIN_FAST = 0.45; // per-sample intensity on a fast sweep (dim streak)
const DOT_SIZE = 18; // drawn diameter of one excited intersection

/* Crosshair scan tuning */
const CROSS_REACH = 280; // px each way the scan line is drawn
const CROSS_SIGMA = 108; // gaussian sigma of the falloff along the line
const CROSS_STOPS = 9; // gradient stops used to approximate the gaussian

/* Dwell bloom tuning */
const DWELL_SPEED = 26; // px/s — below this the beam counts as resting
const DWELL_RISE_MS = 800; // dwell time to full charge
const DWELL_FALL_MS = 320; // charge bleed-off once the beam moves on
const DWELL_DOT_SIZE = 26; // fully-charged glow diameter (from DOT_SIZE)
const DWELL_BOOST = 0.8; // fully-charged alpha multiplier bonus

/* Node-lock tuning */
const LOCK_BOOST = 0.2; // alpha multiplier bonus on the locked intersection
const LOCK_RING_R = 7.5; // ring radius (grows to 9 at full dwell)

/* Presence (pointer in/out of the window) */
const ENERGY_IN_MS = 160;
const ENERGY_OUT_MS = 420;

const MAX_FRAME_MS = 50; // clamp dt across dropped frames / tab wake-ups

interface TrailPoint {
  x: number;
  y: number;
  born: number;
  gain: number;
  radius: number;
}
interface Pt {
  x: number;
  y: number;
}
interface Rgb {
  r: number;
  g: number;
  b: number;
}

const AMBER_FALLBACK: Rgb = { r: 255, g: 180, b: 84 }; // #FFB454

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Parse the value of --color-primary (#rgb, #rrggbb, or rgb[a](...)). */
function parseColor(raw: string): Rgb {
  const s = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  const h = hex?.[1];
  if (h) {
    if (h.length === 3) {
      return {
        r: parseInt(h.slice(0, 1).repeat(2), 16),
        g: parseInt(h.slice(1, 2).repeat(2), 16),
        b: parseInt(h.slice(2, 3).repeat(2), 16),
      };
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return AMBER_FALLBACK;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function ConsoleField(): React.ReactElement | null {
  // The ONLY React state: the reduced-motion mount gate. All animation is
  // drawn imperatively — no re-render per frame.
  const [reduced, setReduced] = useState<boolean>(prefersReducedMotion);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Respond to prefers-reduced-motion changes live.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (reduced) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    /* ---- theme: cache the live --color-primary; retint on theme flips --- */
    let primary: Rgb = AMBER_FALLBACK;
    let primaryCss = 'rgb(255, 180, 84)';
    let darkMode = true;
    let fieldAlpha = 0.14; // excited-intersection cap (whisper level)
    let crossAlpha = 0.08; // crosshair peak — the dimmest element on screen
    let lockAlpha = 0.13; // node-lock ring
    // Pre-rendered soft radial dot; drawImage per intersection is far cheaper
    // than building a gradient per intersection per frame.
    let sprite: HTMLCanvasElement | null = null;

    const buildSprite = () => {
      const s = document.createElement('canvas');
      s.width = 32;
      s.height = 32;
      const sctx = s.getContext('2d');
      if (!sctx || typeof sctx.createRadialGradient !== 'function') {
        sprite = null;
        return;
      }
      const grad = sctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, `rgba(${primary.r}, ${primary.g}, ${primary.b}, 1)`);
      grad.addColorStop(0.55, `rgba(${primary.r}, ${primary.g}, ${primary.b}, 0.35)`);
      grad.addColorStop(1, `rgba(${primary.r}, ${primary.g}, ${primary.b}, 0)`);
      sctx.fillStyle = grad;
      sctx.fillRect(0, 0, 32, 32);
      sprite = s;
    };

    const readTheme = () => {
      const root = document.documentElement;
      const raw = getComputedStyle(root).getPropertyValue('--color-primary');
      primary = raw.trim() ? parseColor(raw) : AMBER_FALLBACK;
      primaryCss = `rgb(${primary.r}, ${primary.g}, ${primary.b})`;
      darkMode = root.dataset.colorMode !== 'light';
      fieldAlpha = darkMode ? 0.14 : 0.1;
      crossAlpha = darkMode ? 0.08 : 0.05;
      lockAlpha = darkMode ? 0.13 : 0.1;
      buildSprite();
    };
    readTheme();

    /* ---- DPR-aware sizing -------------------------------------------- */
    let vw = 0;
    let vh = 0;
    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      vw = window.innerWidth;
      vh = window.innerHeight;
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      // Pin the CSS box to the buffer's CSS-pixel size. With `width: 100%` on
      // a fixed element the box resolves to documentElement.clientWidth
      // (excludes classic scrollbars) while innerWidth includes them, which
      // would compress drawing horizontally and misalign glow dots from the
      // 24px grid intersections whenever a classic scrollbar is present.
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    /* ---- animation state ---------------------------------------------- */
    let trail: TrailPoint[] = [];
    let pendingMove: Pt | null = null;
    let cursor: Pt | null = null; // last sampled beam position
    let present = false; // pointer is inside the window
    let energy = 0; // 0..1 presence envelope (fades the cursor-bound layers)
    let speedSm = 0; // smoothed cursor speed, px/s
    let dwell = 0; // 0..1 accumulated charge on dwellKey
    let dwellKey = -1; // intersection currently holding charge
    let lastTs: number | null = null;
    let rafId: number | null = null;

    /** Pack an intersection index pair into one map key. */
    const keyOf = (k: number, j: number) => k * 4096 + j;
    /** Nearest on-screen grid line index for a viewport coordinate. */
    const nearestIdx = (v: number) => Math.max(1, Math.round((v - GRID_LINE) / GRID));

    /** Approximate a gaussian falloff along a gradient drawn over
     *  [center - CROSS_REACH, center + CROSS_REACH]; the ends are pinned to
     *  fully transparent so the scan line dissolves rather than stopping. */
    const gaussStops = (grad: CanvasGradient, peak: number) => {
      for (let i = 0; i < CROSS_STOPS; i++) {
        const u = i / (CROSS_STOPS - 1);
        const d = (u - 0.5) * 2 * CROSS_REACH;
        const a =
          i === 0 || i === CROSS_STOPS - 1
            ? 0
            : peak * Math.exp(-(d * d) / (2 * CROSS_SIGMA * CROSS_SIGMA));
        grad.addColorStop(u, `rgba(${primary.r}, ${primary.g}, ${primary.b}, ${a})`);
      }
    };

    /** Crosshair scan: the column and row through the locked intersection,
     *  brightest at the beam and dissolving along their length. */
    const drawCrosshair = (lx: number, ly: number) => {
      if (!cursor || energy <= 0 || typeof ctx.createLinearGradient !== 'function') return;
      const peak = crossAlpha * energy;
      ctx.lineWidth = 1;
      // Column (vertical line at lx, falling off in y away from the cursor).
      const gv = ctx.createLinearGradient(lx, cursor.y - CROSS_REACH, lx, cursor.y + CROSS_REACH);
      gaussStops(gv, peak);
      ctx.strokeStyle = gv;
      ctx.beginPath();
      ctx.moveTo(lx, Math.max(0, cursor.y - CROSS_REACH));
      ctx.lineTo(lx, Math.min(vh, cursor.y + CROSS_REACH));
      ctx.stroke();
      // Row (horizontal line at ly, falling off in x away from the cursor).
      const gh = ctx.createLinearGradient(cursor.x - CROSS_REACH, ly, cursor.x + CROSS_REACH, ly);
      gaussStops(gh, peak);
      ctx.strokeStyle = gh;
      ctx.beginPath();
      ctx.moveTo(Math.max(0, cursor.x - CROSS_REACH), ly);
      ctx.lineTo(Math.min(vw, cursor.x + CROSS_REACH), ly);
      ctx.stroke();
    };

    /** Phosphor field: accumulate excitation per grid intersection from every
     *  cooling trail sample plus the live beam, then stamp the soft dot sprite
     *  once per intersection. The locked intersection gets a brighter core and
     *  the charged one blooms bigger — both ride on the same excitation value,
     *  so they never detach from the field. */
    const drawField = (now: number, lockKey: number, gainNow: number, radiusNow: number) => {
      if (!sprite) return;
      const sources: { x: number; y: number; w: number; r: number }[] = [];
      for (const p of trail) {
        const decay = 1 - (now - p.born) / TRAIL_LIFE_MS;
        if (decay <= 0) continue;
        // Quadratic cool-off reads like phosphor; p.gain is the velocity-
        // derived intensity this sample was deposited with.
        sources.push({ x: p.x, y: p.y, w: decay * decay * p.gain, r: p.radius });
      }
      // The beam itself is a steady source while the pointer is present, so a
      // resting cursor keeps a soft pool of light instead of evaporating once
      // the trail has cooled.
      if (cursor && energy > 0) {
        sources.push({ x: cursor.x, y: cursor.y, w: energy * gainNow, r: radiusNow });
      }
      if (sources.length === 0) return;

      const excite = new Map<number, number>();
      for (const s of sources) {
        const kMin = Math.max(1, Math.ceil((s.x - s.r - GRID_LINE) / GRID));
        const kMax = Math.floor((s.x + s.r - GRID_LINE) / GRID);
        const jMin = Math.max(1, Math.ceil((s.y - s.r - GRID_LINE) / GRID));
        const jMax = Math.floor((s.y + s.r - GRID_LINE) / GRID);
        for (let k = kMin; k <= kMax; k++) {
          const cx = k * GRID + GRID_LINE;
          const dx = cx - s.x;
          for (let j = jMin; j <= jMax; j++) {
            const cy = j * GRID + GRID_LINE;
            const dy = cy - s.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist >= s.r) continue;
            const fall = 1 - dist / s.r;
            const key = keyOf(k, j);
            excite.set(key, (excite.get(key) ?? 0) + s.w * fall * fall);
          }
        }
      }

      // Additive compositing lets overlapping glows bloom in dark mode;
      // plain low-alpha source-over suits the light (brass on cream) mode.
      ctx.globalCompositeOperation = darkMode ? 'lighter' : 'source-over';
      for (const [key, v] of excite) {
        let boost = 0;
        let size = DOT_SIZE;
        if (key === lockKey) boost += LOCK_BOOST * energy;
        if (key === dwellKey && dwell > 0) {
          const charge = dwell * energy;
          boost += DWELL_BOOST * charge;
          size = lerp(DOT_SIZE, DWELL_DOT_SIZE, charge);
        }
        const k = Math.floor(key / 4096);
        const j = key % 4096;
        const half = size / 2;
        ctx.globalAlpha = Math.min(1, v) * fieldAlpha * (1 + boost);
        ctx.drawImage(
          sprite,
          k * GRID + GRID_LINE - half,
          j * GRID + GRID_LINE - half,
          size,
          size,
        );
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    /** Node lock: a small crisp ring on the nearest intersection. It snaps from
     *  node to node as the beam crosses cell boundaries — the one hard-edged
     *  element in an otherwise soft field. */
    const drawLock = (lx: number, ly: number) => {
      if (!cursor || energy <= 0) return;
      ctx.globalCompositeOperation = darkMode ? 'lighter' : 'source-over';
      ctx.globalAlpha = lockAlpha * energy;
      ctx.strokeStyle = primaryCss;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(lx, ly, LOCK_RING_R + 1.5 * dwell * energy, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    const frame = (now: number) => {
      rafId = null;
      // dt is floored at 1ms so the linear energy/dwell integrators ALWAYS move
      // unless they are clamped at a limit — that is what makes the idle test
      // below exact (see the idle-loop guarantee at the top of the file).
      const dt = Math.min(MAX_FRAME_MS, Math.max(1, lastTs == null ? 16 : now - lastTs));
      lastTs = now;

      /* -- sample the pointer (throttled to one sample per frame) --------- */
      let inst = 0;
      let sample: Pt | null = null;
      if (pendingMove) {
        const p = pendingMove;
        pendingMove = null;
        present = true;
        if (cursor) inst = (Math.hypot(p.x - cursor.x, p.y - cursor.y) / dt) * 1000;
        const far =
          !cursor || Math.abs(p.x - cursor.x) + Math.abs(p.y - cursor.y) >= TRAIL_MIN_DIST;
        cursor = p;
        if (far) sample = p;
      }

      /* -- velocity → trail retention / intensity / radius ---------------- */
      speedSm += (inst - speedSm) * SPEED_SMOOTH;
      if (speedSm < SPEED_EPS) speedSm = 0; // exact rest, so the loop can stop
      const t = clamp01(speedSm / SPEED_FAST);
      const gainNow = lerp(GAIN_SLOW, GAIN_FAST, t);
      const radiusNow = lerp(RADIUS_SLOW, RADIUS_FAST, t);

      if (sample) trail.push({ ...sample, born: now, gain: gainNow, radius: radiusNow });
      const cap = Math.round(lerp(TRAIL_CAP_MIN, TRAIL_CAP_MAX, t));
      while (trail.length > cap) trail.shift();
      trail = trail.filter((p) => now - p.born < TRAIL_LIFE_MS);

      /* -- presence envelope ---------------------------------------------- */
      const prevEnergy = energy;
      energy = present
        ? Math.min(1, energy + dt / ENERGY_IN_MS)
        : Math.max(0, energy - dt / ENERGY_OUT_MS);

      /* -- dwell charge on the locked intersection ------------------------ */
      const lockK = cursor ? nearestIdx(cursor.x) : 0;
      const lockJ = cursor ? nearestIdx(cursor.y) : 0;
      const lockKey = cursor ? keyOf(lockK, lockJ) : -1;
      const prevDwell = dwell;
      if (dwellKey !== lockKey) {
        // The beam moved to a new node: the old node's charge bleeds away
        // where it sat, and only once it is spent does the new node start
        // charging. Node lock (crisp, instant) and bloom (soft, lagging).
        dwell = Math.max(0, dwell - dt / DWELL_FALL_MS);
        if (dwell === 0) dwellKey = lockKey;
      } else if (present && speedSm < DWELL_SPEED) {
        dwell = Math.min(1, dwell + dt / DWELL_RISE_MS);
      } else {
        dwell = Math.max(0, dwell - dt / DWELL_FALL_MS);
      }

      /* -- paint ----------------------------------------------------------- */
      ctx.clearRect(0, 0, vw, vh);
      const lx = lockK * GRID + GRID_LINE;
      const ly = lockJ * GRID + GRID_LINE;
      drawCrosshair(lx, ly); // dimmest, underneath
      drawField(now, lockKey, gainNow, radiusNow);
      drawLock(lx, ly); // crispest, on top

      /* -- idle-loop guarantee -------------------------------------------- */
      // Nothing is animating when: no pointer sample is waiting, no trail
      // sample is still cooling, the beam is at exact rest, and both linear
      // integrators are pinned at a limit (unchanged across a >=1ms dt). Do not
      // reschedule — the frame just painted stays on the canvas (a saturated
      // dwell bloom simply holds), and the next pointermove re-arms the loop.
      const live =
        pendingMove !== null ||
        trail.length > 0 ||
        speedSm > 0 ||
        energy !== prevEnergy ||
        dwell !== prevDwell;
      if (live) {
        rafId = requestAnimationFrame(frame);
      } else {
        lastTs = null; // next start-up gets a nominal dt, not a multi-second one
      }
    };

    const ensureRunning = () => {
      if (rafId == null && !document.hidden) {
        rafId = requestAnimationFrame(frame);
      }
    };

    /** Repaint one frame after something invalidated the held canvas (a resize
     *  wipes the buffer; a theme flip changes the tint) — but only if there is
     *  anything to show, so an untouched page never starts the loop. */
    const repaint = () => {
      if (present || energy > 0 || dwell > 0 || trail.length > 0) ensureRunning();
    };

    /* ---- input: listeners live on window so the field reacts everywhere,
     *      even over content (the canvas itself is pointer-events: none).
     *      There is deliberately NO pointerdown handler: clicks do nothing. */
    const onPointerMove = (e: PointerEvent) => {
      pendingMove = { x: e.clientX, y: e.clientY };
      ensureRunning();
    };
    // Pointer left the window (or the window lost focus): drop presence and let
    // every cursor-bound layer decay to nothing, then the loop idles by itself.
    const onLeave = () => {
      present = false;
      repaint();
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('blur', onLeave);
    document.addEventListener('pointerleave', onLeave);
    document.addEventListener('mouseleave', onLeave);

    const onResize = () => {
      resize();
      repaint();
    };
    window.addEventListener('resize', onResize);

    // Re-size when devicePixelRatio itself changes (browser zoom / monitor
    // hop): a resolution media query matches the CURRENT dpr, so it must be
    // re-armed after each change.
    let dprMql: MediaQueryList | null = null;
    const onDprChange = () => {
      onResize();
      armDprWatch();
    };
    const armDprWatch = () => {
      dprMql?.removeEventListener('change', onDprChange);
      dprMql =
        typeof window.matchMedia === 'function'
          ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
          : null;
      dprMql?.addEventListener('change', onDprChange);
    };
    armDprWatch();

    // Retint live when mode/theme change. ThemeProvider stamps data-theme /
    // data-color-mode and sets the --color-primary inline style on <html>,
    // so watching those attributes covers both switches.
    const themeObserver = new MutationObserver(() => {
      readTheme();
      repaint();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-color-mode', 'style'],
    });

    // Pause and clear when the tab is hidden: drop all state, cancel the
    // loop, wipe the surface. Fresh pointer events restart it on return.
    const onVisibility = () => {
      if (document.hidden) {
        trail = [];
        pendingMove = null;
        cursor = null;
        present = false;
        energy = 0;
        speedSm = 0;
        dwell = 0;
        dwellKey = -1;
        lastTs = null;
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        ctx.clearRect(0, 0, vw, vh);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      dprMql?.removeEventListener('change', onDprChange);
      themeObserver.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [reduced]);

  // prefers-reduced-motion: reduce → no canvas, no listeners, nothing at all.
  if (reduced) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="console-field"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: -1,
      }}
    />
  );
}
