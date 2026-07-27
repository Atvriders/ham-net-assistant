import React, { useEffect, useId, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { useAuth } from './AuthProvider.js';
import { ApiErrorException, apiFetch } from '../api/client.js';
import { displayCallsign } from '../lib/format.js';

interface LookupResult {
  callsign: string;
  name: string | null;
  licenseClass: string | null;
  country: string;
  found: boolean;
}

interface AuthConfig {
  inviteCodeRequired: boolean;
}

export function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [mode, setMode] = useState<'licensed' | 'unlicensed'>('licensed');
  const [lookupNotice, setLookupNotice] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [inviteCodeRequired, setInviteCodeRequired] = useState<boolean | null>(
    null,
  );
  const [form, setForm] = useState({
    email: '',
    password: '',
    name: '',
    callsign: '',
    inviteCode: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const callsignId = useId();
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const passwordHintId = useId();
  const inviteId = useId();
  const inviteHintId = useId();
  const callsignDisplayId = useId();

  useEffect(() => {
    let cancelled = false;
    apiFetch<AuthConfig>('/auth/config')
      .then((cfg) => {
        if (!cancelled) setInviteCodeRequired(cfg.inviteCodeRequired);
      })
      .catch(() => {
        if (!cancelled) setInviteCodeRequired(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function doLookup(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setErr(null);
    setLookupNotice(null);
    const cs = form.callsign.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,7}$/.test(cs)) {
      setErr('Enter a valid callsign (3–7 letters/digits).');
      return;
    }
    setLookingUp(true);
    try {
      const res = await apiFetch<LookupResult>(`/callsign-lookup/${cs}`);
      if (res.found) {
        setForm((f) => ({ ...f, callsign: cs, name: res.name ?? f.name }));
        setLookupNotice(null);
      } else {
        setForm((f) => ({ ...f, callsign: cs }));
        setLookupNotice(
          'Callsign not found in FCC DB — you can continue with manual info.',
        );
      }
      setStep(2);
    } catch {
      setForm((f) => ({ ...f, callsign: cs }));
      setLookupNotice('Lookup failed — you can continue with manual info.');
      setStep(2);
    } finally {
      setLookingUp(false);
    }
  }

  function startUnlicensed() {
    setErr(null);
    setMode('unlicensed');
    setForm((f) => ({ ...f, callsign: 'N0CALL', name: '' }));
    setLookupNotice(null);
    setStep(2);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Guard against a double-submit that would fire a second POST /auth/register
    // (the second erroring "email already taken" after the first navigated).
    if (submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const payload: {
        email: string;
        password: string;
        name: string;
        callsign: string;
        inviteCode?: string;
      } = {
        email: form.email,
        password: form.password,
        name: form.name,
        callsign: form.callsign,
      };
      if (inviteCodeRequired === true && form.inviteCode) {
        payload.inviteCode = form.inviteCode;
      }
      await register(payload);
      nav('/');
    } catch (ex) {
      if (ex instanceof ApiErrorException) setErr(ex.payload.message);
      else setErr('Registration failed');
      setSubmitting(false);
    }
  }

  const update = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  if (step === 1) {
    return (
      <div style={{ maxWidth: 880, width: '100%', margin: '24px auto' }}>
        <header className="hna-page-header">
          <p className="hna-page-marker">// SIGN-UP</p>
          <h1 className="hna-page-title">Create account</h1>
          <p className="hna-page-sub">
            Two ways to get started — pick whichever describes you. Both paths
            land in the same operator console.
          </p>
        </header>

        <div className="hna-choice-grid">
          {/* Choice A — licensed */}
          <Card>
            <div className="hna-choice-card">
              <span className="hna-choice-card__num">// A — LICENSED</span>
              {/* Heading text preserved verbatim for tests. */}
              <h2 className="hna-choice-card__head">I have a callsign</h2>
              <p className="hna-choice-card__body">
                Enter your amateur radio callsign and we will look it up in the
                FCC database to prefill your info.
              </p>
              <form onSubmit={doLookup} className="hna-form">
                <div className="hna-field">
                  <label htmlFor={callsignId}>Callsign</label>
                  <CallsignInput
                    id={callsignId}
                    value={form.callsign}
                    onChange={update('callsign')}
                  />
                  {err && (
                    <p role="alert" className="hna-input-error">
                      {err}
                    </p>
                  )}
                </div>
                <div>
                  <Button type="submit" variant="primary" disabled={lookingUp}>
                    {lookingUp ? 'Looking up…' : 'Continue with callsign'}
                  </Button>
                </div>
              </form>
            </div>
          </Card>
          {/* Choice B — unlicensed */}
          <Card>
            <div className="hna-choice-card">
              <span className="hna-choice-card__num">// B — STUDYING</span>
              <h2 className="hna-choice-card__head">I&apos;m not licensed yet</h2>
              <p className="hna-choice-card__body">
                Join with the NØCALL placeholder. You can listen along and chat
                with the club while you study for your FCC license.
              </p>
              <div className="hna-choice-card__spacer" />
              <div>
                <Button type="button" variant="primary" onClick={startUnlicensed}>
                  Continue without callsign
                </Button>
              </div>
            </div>
          </Card>
        </div>

        <p className="hna-auth-helptext" style={{ marginTop: 24 }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="hna-auth-shell">
      <div className="hna-auth-mark">
        <span className="hna-auth-mark__marker">// SIGN-UP · STEP 2</span>
        <h1 className="hna-auth-mark__title">Create account</h1>
        <p className="hna-auth-mark__sub">
          One more screen and you&apos;re on the air.
        </p>
      </div>
      <Card>
        {mode === 'unlicensed' && (
          <p
            className="hna-mono"
            style={{
              fontSize: 12,
              color: 'var(--color-primary)',
              marginTop: 0,
              marginBottom: 16,
              letterSpacing: '0.08em',
            }}
          >
            You will share the NØCALL placeholder with other unlicensed
            operators. When you get your FCC license, register a new account
            with your real callsign.
          </p>
        )}
        {lookupNotice && (
          <p
            className="hna-mono"
            style={{
              fontSize: 12,
              color: 'var(--color-primary)',
              marginTop: 0,
              marginBottom: 16,
              letterSpacing: '0.08em',
            }}
          >
            {lookupNotice}
          </p>
        )}
        <form onSubmit={submit} className="hna-form" noValidate>
          <div className="hna-field">
            <label htmlFor={callsignDisplayId}>Callsign</label>
            <Input
              id={callsignDisplayId}
              value={
                mode === 'unlicensed'
                  ? 'NØCALL (unlicensed operator placeholder)'
                  : displayCallsign(form.callsign)
              }
              disabled
            />
            <button
              type="button"
              className="hna-btn ghost size-sm"
              style={{ justifySelf: 'start' }}
              onClick={() => {
                setMode('licensed');
                setStep(1);
                setLookupNotice(null);
                setForm((f) => ({ ...f, callsign: '' }));
              }}
            >
              {mode === 'unlicensed' ? 'I do have a callsign' : 'Change callsign'}
            </button>
          </div>
          <div className="hna-field">
            <label htmlFor={nameId}>Name</label>
            <Input
              id={nameId}
              value={form.name}
              onChange={(e) => update('name')(e.target.value)}
              required
            />
          </div>
          <div className="hna-field">
            <label htmlFor={emailId}>Email</label>
            <Input
              id={emailId}
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(e) => update('email')(e.target.value)}
              required
            />
          </div>
          <div className="hna-field">
            <label htmlFor={passwordId}>Password</label>
            {/*
              minLength must track `Password` in @hna/shared (currently min 12).
              If it is lower the browser happily submits a short password and the
              only feedback is the API's 400 VALIDATION — the user gets a generic
              server error instead of the field telling them the rule up front.
            */}
            <Input
              id={passwordId}
              type="password"
              autoComplete="new-password"
              value={form.password}
              minLength={12}
              aria-describedby={passwordHintId}
              onChange={(e) => update('password')(e.target.value)}
              required
            />
            <p id={passwordHintId} className="hna-help">
              At least 12 characters.
            </p>
          </div>
          {inviteCodeRequired === true && (
            <div className="hna-field">
              <label htmlFor={inviteId}>Invite code</label>
              <Input
                id={inviteId}
                value={form.inviteCode}
                onChange={(e) => update('inviteCode')(e.target.value)}
                aria-describedby={inviteHintId}
                required
              />
              {/* Without this, a prospective member who doesn't have the code
                  has no idea what the field wants or where to get one — the
                  club shares it at meetings and on the air, not on this page. */}
              <p id={inviteHintId} className="hna-help">
                The shared code your club gives out — ask a club officer, or
                check the club&rsquo;s announcement channel. It is not your
                callsign or password.
              </p>
            </div>
          )}
          {err && (
            <p role="alert" className="hna-input-error">
              {err}
            </p>
          )}
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 8,
              flexWrap: 'wrap',
            }}
          >
            <Link to="/login" className="hna-btn ghost" style={{ textDecoration: 'none' }}>
              Sign in
            </Link>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create account'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
