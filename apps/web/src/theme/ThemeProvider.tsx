import React, { createContext, useContext, useEffect, useState } from 'react';
import { themes, themeBySlug, type Theme } from './registry.js';
import { useAuth } from '../auth/AuthProvider.js';

interface ThemeCtx {
  current: Theme;
  all: Theme[];
  setTheme: (slug: string) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const LS_KEY = 'hna_theme_slug';

function applyTheme(t: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = t.slug;
  const c = t.colors;
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

  useEffect(() => {
    if (user?.collegeSlug && user.collegeSlug !== slug) setSlug(user.collegeSlug);
  }, [user?.collegeSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    applyTheme(themeBySlug(slug));
    localStorage.setItem(LS_KEY, slug);
  }, [slug]);

  const setTheme = (next: string) => {
    setSlug(next);
    if (user) void updateMe({ collegeSlug: next });
  };

  return (
    <Ctx.Provider value={{ current: themeBySlug(slug), all: themes, setTheme }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
