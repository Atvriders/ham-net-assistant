import React, { useId, useState } from 'react';
import { Card } from '../components/ui/Card.js';
import { Input } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { useAuth } from '../auth/AuthProvider.js';
import { ThemePicker } from '../theme/ThemePicker.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { displayCallsign } from '../lib/format.js';

/**
 * Per-operator settings: profile, appearance (theme + color mode), and the
 * account actions (sign out). Calibrated radio-console identity, three
 * stacked sections with SectionDividers and mono captions.
 *
 * Callsign is intentionally read-only — it is the operator's permanent
 * identifier, set at registration. The auth provider doesn't expose a
 * password-change path today, so the Account section is just the sign-out
 * affordance; if a password endpoint lands the form can drop in here.
 */
export function SettingsPage() {
  const { user, updateMe, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const [name, setName] = useState(user?.name ?? '');
  const [savedFlash, setSavedFlash] = useState(false);
  const nameId = useId();
  const callsignId = useId();

  if (!user) return null;

  async function saveProfile() {
    await updateMe({ name });
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1800);
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <header className="hna-page-header">
        <p className="hna-page-marker">// SETTINGS</p>
        <h1 className="hna-page-title">Settings</h1>
        <p className="hna-page-sub">
          Profile, theme, color mode. The callsign you registered with is
          permanent — talk to an admin if it needs to change.
        </p>
      </header>

      <p className="hna-cap hna-cap--accent">[ PROFILE ]</p>
      <Card>
        <div className="hna-form">
          <div className="hna-field">
            <label htmlFor={callsignId}>Callsign</label>
            <Input
              id={callsignId}
              value={displayCallsign(user.callsign)}
              readOnly
              disabled
              className="hna-mono"
            />
            <p
              className="hna-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.08em',
                color: 'var(--color-fg-muted)',
                margin: 0,
              }}
            >
              Permanent — set at registration
            </p>
          </div>
          <div className="hna-field">
            <label htmlFor={nameId}>Name</label>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <Button onClick={saveProfile}>Save</Button>
            {savedFlash && (
              <span
                className="hna-mono"
                style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--color-success)' }}
              >
                SAVED
              </span>
            )}
            <span
              className="hna-mono"
              style={{
                marginLeft: 'auto',
                fontSize: 11,
                letterSpacing: '0.14em',
                color: 'var(--color-fg-muted)',
              }}
            >
              ROLE · {user.role}
            </span>
          </div>
        </div>
      </Card>

      <SectionDivider>APPEARANCE</SectionDivider>
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <div>
            <p
              className="hna-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.14em',
                color: 'var(--color-fg-muted)',
                margin: '0 0 var(--space-2)',
              }}
            >
              COLOR MODE
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button
                variant={mode === 'dark' ? 'primary' : 'secondary'}
                onClick={() => setMode('dark')}
                aria-pressed={mode === 'dark'}
              >
                Dark
              </Button>
              <Button
                variant={mode === 'light' ? 'primary' : 'secondary'}
                onClick={() => setMode('light')}
                aria-pressed={mode === 'light'}
              >
                Light
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* ThemePicker is its own Card; render below the appearance block. */}
      <div style={{ marginTop: 'var(--space-4)' }}>
        <ThemePicker />
      </div>

      <SectionDivider>ACCOUNT</SectionDivider>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'center' }}>
          <Button variant="danger" onClick={() => logout()}>
            Sign out
          </Button>
          <p
            className="hna-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              color: 'var(--color-fg-muted)',
              margin: 0,
            }}
          >
            Ends this session on this device.
          </p>
        </div>
      </Card>
    </div>
  );
}
