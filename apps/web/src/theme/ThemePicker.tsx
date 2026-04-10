import React from 'react';
import { useTheme } from './ThemeProvider.js';
import { Card } from '../components/ui/Card.js';

export function ThemePicker() {
  const { current, all, setTheme } = useTheme();
  return (
    <Card>
      <h3>College theme</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 12,
        }}
      >
        {all.map((t) => (
          <button
            key={t.slug}
            type="button"
            onClick={() => setTheme(t.slug)}
            aria-pressed={current.slug === t.slug}
            style={{
              cursor: 'pointer',
              padding: 12,
              border: `2px solid ${current.slug === t.slug ? t.colors.primary : 'var(--color-border)'}`,
              borderRadius: 8,
              background: t.colors.bg,
              color: t.colors.fg,
              textAlign: 'left',
            }}
          >
            <div
              style={{
                width: '100%',
                height: 32,
                background: t.colors.primary,
                borderRadius: 4,
                marginBottom: 8,
              }}
            />
            <strong style={{ display: 'block' }}>{t.shortName}</strong>
            <small>{t.name}</small>
          </button>
        ))}
      </div>
    </Card>
  );
}
