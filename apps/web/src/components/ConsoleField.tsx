import React, { useEffect, useRef, useState } from 'react';

/*
 * ConsoleField — "phosphor excitation field" interactive background.
 *
 * The app's static graph-paper grid (painted by ui.css on <body>, 24px pitch,
 * background-attachment: fixed) becomes a live instrument surface:
 *
 *   1. Phosphor persistence (pointermove): grid intersections near the cursor
 *      are "excited" with a soft radial glow in the live --color-primary that
 *      decays over ~800ms, like a CRT trace cooling. Intensity falls off with
 *      distance from the cursor; the whole field is capped at a whisper-level
 *      alpha so it reads as ambient instrument behavior, not a game.
 *
 *   2. RF wavefront (pointerdown): two concentric stroke-drawn rings expand
 *      from the tap point at ~560px/s, their alpha decaying with radius and
 *      dying out entirely by ~640px — a transmitted wavefront washing across
 *      the calibrated surface.
 *
 * Stacking: the canvas is position:fixed, inset:0, z-index:-1, pointer-events
 * none. <html> carries no background of its own, so <body>'s grid background
 * propagates to the root canvas and paints BELOW negative-z-index elements;
 * the canvas therefore sits above the static grid but below all in-flow app
 * content, the sticky nav (z-index 30), and modal backdrops (z-index 50).
 *
 * Idle-loop guarantee: a requestAnimationFrame is scheduled ONLY while there
 * is live state (trail points, ripples, or an unsampled pointer move). When
 * everything has decayed, the final frame clears the canvas and simply does
 * not reschedule — zero CPU while idle. Pointer events restart the loop.
 */

/** Grid geometry — must match the repeating-linear-gradient in ui.css:
 *  each 24px period is transparent for 23px then a 1px line, so line pixel
 *  centers sit at 24k - 0.5 (k >= 1) in viewport coordinates. */
const GRID = 24;
const GRID_LINE = -0.5;

/* Phosphor (mouse trail) tuning */
const TRAIL_LIFE_MS = 800; // CRT-style persistence
const TRAIL_MAX = 40; // cap stored samples; drop oldest
const TRAIL_RADIUS = 125; // px radius of excitation around the cursor
const TRAIL_MIN_DIST = 2; // ignore sub-pixel jitter between samples
const DOT_SIZE = 18; // drawn diameter of one excited intersection

/* Wavefront (click) tuning */
const RIPPLE_MAX = 8; // cap live ripples; drop oldest
const RING_SPEED = 560; // px/s expansion
const RING_MAX_R = 640; // rings die out by this radius
const RING_ECHO_S = 0.13; // second wavefront launches this much later
const RIPPLE_LIFE_MS = (RING_MAX_R / RING_SPEED + RING_ECHO_S) * 1000; // ~1.27s

interface TrailPoint {
  x: number;
  y: number;
  born: number;
}
interface Ripple {
  x: number;
  y: number;
  born: number;
}
interface Rgb {
  r: number;
  g: number;
  b: number;
}

const AMBER_FALLBACK: Rgb = { r: 255, g: 180, b: 84 }; // #FFB454

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
    let fieldAlpha = 0.14; // phosphor cap (whisper level)
    let ringAlpha = 0.4; // crisp-ring peak alpha
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
      ringAlpha = darkMode ? 0.4 : 0.3;
      buildSprite();
    };
    readTheme();

    // Retint live when mode/theme change. ThemeProvider stamps data-theme /
    // data-color-mode and sets the --color-primary inline style on <html>,
    // so watching those attributes covers both switches.
    const themeObserver = new MutationObserver(readTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-color-mode', 'style'],
    });

    /* ---- DPR-aware sizing -------------------------------------------- */
    let vw = 0;
    let vh = 0;
    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      vw = window.innerWidth;
      vh = window.innerHeight;
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // Re-size when devicePixelRatio itself changes (browser zoom / monitor
    // hop): a resolution media query matches the CURRENT dpr, so it must be
    // re-armed after each change.
    let dprMql: MediaQueryList | null = null;
    const onDprChange = () => {
      resize();
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

    /* ---- animation state ---------------------------------------------- */
    let trail: TrailPoint[] = [];
    let ripples: Ripple[] = [];
    let pendingMove: { x: number; y: number } | null = null;
    let lastSample: { x: number; y: number } | null = null;
    let rafId: number | null = null;

    /** Draw the phosphor field: accumulate excitation per grid intersection
     *  from every live trail point, then stamp the soft dot sprite once per
     *  intersection. Excitation = trace decay × distance falloff, clamped so
     *  overlapping samples can never exceed the whisper-level alpha cap. */
    const drawPhosphor = (now: number) => {
      if (!sprite || trail.length === 0) return;
      const excite = new Map<number, number>();
      for (const p of trail) {
        const decay = 1 - (now - p.born) / TRAIL_LIFE_MS;
        if (decay <= 0) continue;
        const d2 = decay * decay; // quadratic cool-off reads like phosphor
        const kMin = Math.max(1, Math.ceil((p.x - TRAIL_RADIUS - GRID_LINE) / GRID));
        const kMax = Math.floor((p.x + TRAIL_RADIUS - GRID_LINE) / GRID);
        const jMin = Math.max(1, Math.ceil((p.y - TRAIL_RADIUS - GRID_LINE) / GRID));
        const jMax = Math.floor((p.y + TRAIL_RADIUS - GRID_LINE) / GRID);
        for (let k = kMin; k <= kMax; k++) {
          const cx = k * GRID + GRID_LINE;
          const dx = cx - p.x;
          for (let j = jMin; j <= jMax; j++) {
            const cy = j * GRID + GRID_LINE;
            const dy = cy - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist >= TRAIL_RADIUS) continue;
            const fall = 1 - dist / TRAIL_RADIUS;
            const key = k * 4096 + j;
            excite.set(key, (excite.get(key) ?? 0) + d2 * fall * fall);
          }
        }
      }
      // Additive compositing lets overlapping glows bloom in dark mode;
      // plain low-alpha source-over suits the light (brass on cream) mode.
      ctx.globalCompositeOperation = darkMode ? 'lighter' : 'source-over';
      const half = DOT_SIZE / 2;
      for (const [key, v] of excite) {
        const k = Math.floor(key / 4096);
        const j = key % 4096;
        ctx.globalAlpha = Math.min(1, v) * fieldAlpha;
        ctx.drawImage(
          sprite,
          k * GRID + GRID_LINE - half,
          j * GRID + GRID_LINE - half,
          DOT_SIZE,
          DOT_SIZE,
        );
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    /** Draw the RF wavefronts: for each ripple, a leading ring plus a delayed
     *  echo, each stroked twice (wide faint pass = glow, thin pass = crisp
     *  wavefront). Alpha decays with radius and hits zero at RING_MAX_R. */
    const drawRipples = (now: number) => {
      if (ripples.length === 0) return;
      ctx.globalCompositeOperation = darkMode ? 'lighter' : 'source-over';
      ctx.strokeStyle = primaryCss;
      for (const rp of ripples) {
        const t = (now - rp.born) / 1000;
        for (const delay of [0, RING_ECHO_S]) {
          const tt = t - delay;
          if (tt <= 0) continue;
          const r = RING_SPEED * tt;
          if (r >= RING_MAX_R) continue;
          const fade = Math.pow(1 - r / RING_MAX_R, 1.6);
          // Glow pass — the ring itself brightens the grid it crosses.
          ctx.globalAlpha = fade * ringAlpha * 0.35;
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, r, 0, Math.PI * 2);
          ctx.stroke();
          // Crisp pass.
          ctx.globalAlpha = fade * ringAlpha;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    const frame = (now: number) => {
      rafId = null;
      // Pointer sampling is throttled to once per frame: the move handler
      // only records the latest position; it is consumed here.
      if (pendingMove) {
        const { x, y } = pendingMove;
        pendingMove = null;
        if (
          !lastSample ||
          Math.abs(x - lastSample.x) + Math.abs(y - lastSample.y) >= TRAIL_MIN_DIST
        ) {
          trail.push({ x, y, born: now });
          if (trail.length > TRAIL_MAX) trail.shift();
          lastSample = { x, y };
        }
      }
      trail = trail.filter((p) => now - p.born < TRAIL_LIFE_MS);
      ripples = ripples.filter((r) => now - r.born < RIPPLE_LIFE_MS);

      ctx.clearRect(0, 0, vw, vh);
      drawPhosphor(now);
      drawRipples(now);

      // Idle-loop guarantee: only reschedule while something is alive. When
      // everything has decayed the canvas has just been cleared and no rAF
      // remains scheduled — zero work until the next pointer event.
      if (trail.length > 0 || ripples.length > 0 || pendingMove) {
        rafId = requestAnimationFrame(frame);
      }
    };

    const ensureRunning = () => {
      if (rafId == null && !document.hidden) {
        rafId = requestAnimationFrame(frame);
      }
    };

    /* ---- input: listeners live on window so the field reacts everywhere,
     *      even over content (the canvas itself is pointer-events: none). */
    const onPointerMove = (e: PointerEvent) => {
      pendingMove = { x: e.clientX, y: e.clientY };
      ensureRunning();
    };
    const onPointerDown = (e: PointerEvent) => {
      ripples.push({ x: e.clientX, y: e.clientY, born: performance.now() });
      if (ripples.length > RIPPLE_MAX) ripples.shift();
      ensureRunning();
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerdown', onPointerDown);

    // Pause and clear when the tab is hidden: drop all state, cancel the
    // loop, wipe the surface. Fresh pointer events restart it on return.
    const onVisibility = () => {
      if (document.hidden) {
        trail = [];
        ripples = [];
        pendingMove = null;
        lastSample = null;
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
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', resize);
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
