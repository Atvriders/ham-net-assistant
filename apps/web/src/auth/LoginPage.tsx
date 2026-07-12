import React, { useId, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { useAuth } from './AuthProvider.js';
import { ApiErrorException } from '../api/client.js';

/**
 * Inline radio-mast glyph reused on the auth pages — a compact echo of the
 * shell brand mark so the login screen still reads as Ham-Net-Assistant.
 */
function MastMark() {
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 64 64"
      role="img"
      aria-label="Ham-Net-Assistant"
      focusable="false"
    >
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="3"
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth="2"
      />
      <g
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="3.5"
        strokeLinecap="round"
      >
        <path d="M20 46 A17 17 0 0 1 44 46" />
        <path d="M26 46 A9 9 0 0 1 38 46" />
      </g>
      <circle cx="32" cy="46" r="3.5" fill="var(--color-primary)" />
      <rect x="30.5" y="14" width="3" height="22" rx="1" fill="var(--color-primary)" />
    </svg>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Block a second submit while the first is in flight — on a slow network a
    // dead-looking button otherwise invites a duplicate POST /auth/login.
    if (submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      await login({ email, password });
      const from = (loc.state as { from?: { pathname?: string } } | null)?.from?.pathname;
      nav(from && from !== '/login' ? from : '/', { replace: true });
    } catch (ex) {
      if (ex instanceof ApiErrorException) setErr(ex.payload.message);
      else setErr('Login failed');
      setSubmitting(false);
    }
  }

  return (
    <div className="hna-auth-shell">
      <div className="hna-auth-mark">
        <span className="hna-auth-mark__glyph">
          <MastMark />
        </span>
        <span className="hna-auth-mark__marker">// LOG-IN</span>
        <h1 className="hna-auth-mark__title">Sign in</h1>
        <p className="hna-auth-mark__sub">
          Operator login. Use your callsign-linked email and password.
        </p>
      </div>
      <Card>
        <form onSubmit={submit} className="hna-form" noValidate>
          <div className="hna-field">
            <label htmlFor={emailId}>Email</label>
            <Input
              id={emailId}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="hna-field">
            <label htmlFor={passwordId}>Password</label>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {err && (
              <p role="alert" className="hna-input-error">
                {err}
              </p>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 8,
              flexWrap: 'wrap',
            }}
          >
            <Link to="/register" className="hna-btn ghost" style={{ textDecoration: 'none' }}>
              Register
            </Link>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>
        </form>
      </Card>
      <p className="hna-auth-helptext">
        Trouble signing in? Ask a club officer to reset your password.
      </p>
    </div>
  );
}
