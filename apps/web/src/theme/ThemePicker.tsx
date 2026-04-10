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

export function ThemePicker() {
  const { current, all, setTheme, refresh } = useTheme();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [uploadingSlug, setUploadingSlug] = useState<string | null>(null);
  return (
    <Card>
      <h3>College theme</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {all.map((t) => (
          <div
            key={t.slug}
            style={{
              padding: 12,
              border: `2px solid ${current.slug === t.slug ? t.colors.primary : 'var(--color-border)'}`,
              borderRadius: 8,
              background: t.colors.bg,
              color: t.colors.fg,
              textAlign: 'left',
            }}
          >
            <button
              type="button"
              onClick={() => setTheme(t.slug)}
              aria-pressed={current.slug === t.slug}
              style={{
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: 'inherit',
                textAlign: 'left',
                width: '100%',
              }}
            >
              <img
                src={effectiveLogoUrl(t)}
                alt={t.logo.alt}
                style={{ height: 32, marginBottom: 6, display: 'block' }}
              />
              <div
                style={{
                  width: '100%',
                  height: 24,
                  background: t.colors.primary,
                  borderRadius: 4,
                  marginBottom: 8,
                }}
              />
              <strong style={{ display: 'block' }}>{t.shortName}</strong>
              <small>{t.name}</small>
            </button>
            {isAdmin && (
              <AdminLogoControls
                theme={t}
                onChanged={refresh}
                onOpenUpload={() => setUploadingSlug(t.slug)}
              />
            )}
          </div>
        ))}
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
