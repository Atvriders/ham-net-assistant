import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { useAuth } from './AuthProvider.js';
import { ApiErrorException, apiFetch } from '../api/client.js';

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
    }
  }

  const update = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  if (step === 1) {
    return (
      <div style={{ maxWidth: 420, margin: '60px auto' }}>
        <Card>
          <h1>Create account</h1>
          <p>Start with your amateur radio callsign. We will look it up in the FCC database to prefill your info.</p>
          <form onSubmit={doLookup}>
            <label>
              Callsign
              <CallsignInput value={form.callsign} onChange={update('callsign')} />
            </label>
            {err && (
              <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 12 }}>
                {err}
              </div>
            )}
            <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
              <Button type="submit" disabled={lookingUp}>
                {lookingUp ? 'Looking up…' : 'Look up'}
              </Button>
              <Link className="hna-nav-link" to="/login">Sign in</Link>
            </div>
            <div style={{ marginTop: 12 }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  startUnlicensed();
                }}
              >
                I don't have a callsign yet
              </a>
            </div>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: '60px auto' }}>
      <Card>
        <h1>Create account</h1>
        {mode === 'unlicensed' && (
          <div style={{ color: 'var(--color-accent)', marginBottom: 12 }}>
            You'll be assigned a temporary placeholder callsign (e.g. N0CALL42).
            You can update it later from Settings.
          </div>
        )}
        {lookupNotice && (
          <div style={{ color: 'var(--color-accent)', marginBottom: 12 }}>{lookupNotice}</div>
        )}
        <form onSubmit={submit}>
          <label>
            Callsign
            <Input
              value={mode === 'unlicensed' ? 'N0CALL (will be auto-assigned)' : form.callsign}
              disabled
            />
          </label>
          <div style={{ marginTop: 4 }}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setMode('licensed');
                setStep(1);
                setLookupNotice(null);
                setForm((f) => ({ ...f, callsign: '' }));
              }}
            >
              {mode === 'unlicensed' ? 'I do have a callsign' : 'Change callsign'}
            </a>
          </div>
          <label style={{ display: 'block', marginTop: 12 }}>
            Name
            <Input
              value={form.name}
              onChange={(e) => update('name')(e.target.value)}
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Email
            <Input
              type="email"
              value={form.email}
              onChange={(e) => update('email')(e.target.value)}
              required
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Password
            <Input
              type="password"
              value={form.password}
              minLength={8}
              onChange={(e) => update('password')(e.target.value)}
              required
            />
          </label>
          {inviteCodeRequired === true && (
            <label style={{ display: 'block', marginTop: 12 }}>
              Invite code
              <Input
                value={form.inviteCode}
                onChange={(e) => update('inviteCode')(e.target.value)}
                required
              />
            </label>
          )}
          {err && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 12 }}>
              {err}
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
            <Button type="submit">Create account</Button>
            <Link className="hna-nav-link" to="/login">Sign in</Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
