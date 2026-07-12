import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { themes, themeBySlug, loadThemesFromApi, type Theme } from './registry.js';
import { useAuth } from '../auth/AuthProvider.js';
import { apiFetch } from '../api/client.js';

export type ColorMode = 'light' | 'dark';

interface ThemeCtx {
  current: Theme;
  all: Theme[];
  setTheme: (slug: string) => void;
  refresh: () => Promise<void>;
  mode: ColorMode;
  setMode: (m: ColorMode) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const LS_KEY = 'hna_theme_slug';
const LS_MODE_KEY = 'hna_color_mode';

/**
 * Apply per-college accents on top of the base "radio-console" tokens.
 *
 * Phase A keeps the canvas / surface / ink / signal tokens (defined in
 * theme-vars.css) as the single source of truth and only lets the college
 * theme JSON drive the primary-accent pair. This keeps the new design coherent
 * across themes while preserving the college-theme picker.
 */
function applyTheme(t: Theme, mode: ColorMode): void {
  const root = document.documentElement;
  root.dataset.theme = t.slug;
  root.dataset.colorMode = mode;
  const c = mode === 'dark' ? t.darkColors ?? t.colors : t.colors;
  const set = (k: string, v: string | undefined) => {
    if (v) root.style.setProperty(k, v);
    else root.style.removeProperty(k);
  };
  // College accent — the only chrome the theme JSON drives in Phase A.
  set('--color-primary', c.primary);
  set('--color-primary-fg', c.primaryFg);
  // Tertiary accent for per-page phases to lean on.
  set('--color-accent', c.accent);
  // Tokens we do NOT let the per-college theme override; clear any leftover
  // inline overrides so the base palette in theme-vars.css wins.
  ['--color-bg', '--color-bg-muted', '--color-fg', '--color-border',
   '--color-success', '--color-danger',
   '--font-display', '--font-body', '--font-mono'].forEach((k) => {
    root.style.removeProperty(k);
  });
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { user, updateMe } = useAuth();
  const hadStoredSlug = typeof window !== 'undefined' && localStorage.getItem(LS_KEY) !== null;
  const [slug, setSlug] = useState<string>(
    () => user?.collegeSlug ?? localStorage.getItem(LS_KEY) ?? 'default',
  );

  useEffect(() => {
    if (user?.collegeSlug || hadStoredSlug) return;
    let cancelled = false;
    apiFetch<{ slug: string }>('/themes/default')
      .then((r) => {
        if (!cancelled && r?.slug) setSlug(r.slug);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [mode, setModeState] = useState<ColorMode>(() => {
    const stored = localStorage.getItem(LS_MODE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  });
  const [runtimeThemes, setRuntimeThemes] = useState<Theme[]>(themes);

  const refresh = useCallback(async () => {
    const next = await loadThemesFromApi();
    setRuntimeThemes(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (user?.collegeSlug && user.collegeSlug !== slug) setSlug(user.collegeSlug);
  }, [user?.collegeSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  const current: Theme =
    runtimeThemes.find((t) => t.slug === slug) ?? themeBySlug(slug);

  useEffect(() => {
    applyTheme(current, mode);
    localStorage.setItem(LS_KEY, slug);
  }, [slug, current, mode]);

  const setMode = (m: ColorMode) => {
    setModeState(m);
    localStorage.setItem(LS_MODE_KEY, m);
  };

  const setTheme = (next: string) => {
    const prev = slug;
    setSlug(next);
    if (user) {
      void updateMe({ collegeSlug: next }).catch(() => {
        // Persist failed — roll back so the picker reflects what's actually
        // saved rather than silently reverting on the next login.
        setSlug(prev);
      });
    }
  };

  return (
    <Ctx.Provider value={{ current, all: runtimeThemes, setTheme, refresh, mode, setMode }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
