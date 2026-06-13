import React, { useState } from 'react';
import { useTheme } from './ThemeProvider.js';
import { effectiveLogoUrl, type Theme } from './registry.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { LogoUploadModal } from '../components/LogoUploadModal.js';

function AdminLogoControls({
  theme,
  onChanged,
  onOpenUpload,
}: {
  theme: Theme;
  onChanged: () => Promise<void>;
  onOpenUpload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/themes/${theme.slug}/logo`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 404) {
        setErr(`Delete failed (${res.status})`);
      } else {
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Button
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onOpenUpload();
        }}
        disabled={busy}
      >
        Upload logo
      </Button>
      {theme.uploadedLogoUrl && (
        <Button
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            void remove();
          }}
          disabled={busy}
        >
          Remove uploaded
        </Button>
      )}
      {err && <small style={{ color: 'var(--color-danger)' }}>{err}</small>}
    </div>
  );
}

/**
 * Theme picker — calibrated chip vocabulary. Each theme renders as a small
 * card with the slug in mono caption above, the college name in display,
 * and a row of small hairline-bordered color swatches. The active card
 * gets a 2px amber underline on the name to match the rest of the app's
 * selected-state vocabulary.
 */
export function ThemePicker() {
  const { current, all, setTheme, refresh } = useTheme();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [uploadingSlug, setUploadingSlug] = useState<string | null>(null);
  return (
    <Card>
      <h3>College theme</h3>
      <div className="hna-theme-grid">
        {all.map((t) => {
          const active = current.slug === t.slug;
          // Up to four swatches per card: primary first, then fg, accent, bg.
          // We render solid hairline-bordered squares — no soft blobs.
          const swatches: { label: string; color: string }[] = [
            { label: 'primary', color: t.colors.primary ?? 'transparent' },
            { label: 'fg', color: t.colors.fg ?? 'transparent' },
            { label: 'bg', color: t.colors.bg ?? 'transparent' },
          ];
          return (
            <div
              key={t.slug}
              className="hna-theme-card"
              data-active={active ? 'true' : undefined}
            >
              <button
                type="button"
                onClick={() => setTheme(t.slug)}
                aria-pressed={active}
                className="hna-theme-card__btn"
              >
                <span className="hna-theme-card__slug">// {t.slug}</span>
                <img
                  src={effectiveLogoUrl(t)}
                  alt={t.logo.alt}
                  className="hna-theme-card__logo"
                />
                <span className="hna-theme-card__name">{t.shortName}</span>
                <span className="hna-theme-card__sub">{t.name}</span>
                <span
                  className="hna-theme-card__swatches"
                  aria-hidden="true"
                >
                  {swatches.map((sw) => (
                    <span
                      key={sw.label}
                      className="hna-theme-card__swatch"
                      style={{ background: sw.color }}
                      title={sw.label}
                    />
                  ))}
                </span>
              </button>
              {isAdmin && (
                <AdminLogoControls
                  theme={t}
                  onChanged={refresh}
                  onOpenUpload={() => setUploadingSlug(t.slug)}
                />
              )}
            </div>
          );
        })}
      </div>
      {isAdmin && uploadingSlug && (
        <LogoUploadModal
          open={!!uploadingSlug}
          slug={uploadingSlug}
          onClose={() => setUploadingSlug(null)}
          onUploaded={() => {
            void refresh();
          }}
        />
      )}
    </Card>
  );
}
