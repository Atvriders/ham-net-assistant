import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { themes, themeBySlug, loadThemesFromApi, type Theme } from './registry.js';
import { useAuth } from '../auth/AuthProvider.js';

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

function applyTheme(t: Theme, mode: ColorMode): void {
  const root = document.documentElement;
  root.dataset.theme = t.slug;
  root.dataset.colorMode = mode;
  const c = mode === 'dark' ? t.darkColors ?? t.colors : t.colors;
  const set = (k: string, v: string | undefined) => root.style.setProperty(k, v ?? '');
  set('--color-primary', c.primary);
  set('--color-primary-fg', c.primaryFg);
  set('--color-accent', c.accent);
  set('--color-bg', c.bg);
  set('--color-bg-muted', c.bgMuted);
  set('--color-fg', c.fg);
  set('--color-border', c.border);
  set('--color-success', c.success);
  set('--color-danger', c.danger);
  set('--font-display', t.font.display);
  set('--font-body', t.font.body);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { user, updateMe } = useAuth();
  const [slug, setSlug] = useState<string>(
    () => user?.collegeSlug ?? localStorage.getItem(LS_KEY) ?? 'default',
  );
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

  const setTheme = (next: string) => {
    setSlug(next);
    if (user) void updateMe({ collegeSlug: next });
  };

  const setMode = (m: ColorMode) => {
    setModeState(m);
    localStorage.setItem(LS_MODE_KEY, m);
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
