import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { CallsignInput } from '../components/CallsignInput.js';
import { useAuth } from './AuthProvider.js';
import { ApiErrorException } from '../api/client.js';

export function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({
    email: '',
    password: '',
    name: '',
    callsign: '',
    inviteCode: '',
  });
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await register({
        email: form.email,
        password: form.password,
        name: form.name,
        callsign: form.callsign,
        inviteCode: form.inviteCode || undefined,
      });
      nav('/');
    } catch (ex) {
      if (ex instanceof ApiErrorException) setErr(ex.payload.message);
      else setErr('Registration failed');
    }
  }

  const update = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div style={{ maxWidth: 420, margin: '60px auto' }}>
      <Card>
        <h1>Create account</h1>
        <form onSubmit={submit}>
          <label>
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
            Callsign
            <CallsignInput value={form.callsign} onChange={update('callsign')} />
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
          <label style={{ display: 'block', marginTop: 12 }}>
            Invite code (if required)
            <Input
              value={form.inviteCode}
              onChange={(e) => update('inviteCode')(e.target.value)}
            />
          </label>
          {err && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 12 }}>
              {err}
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
            <Button type="submit">Create account</Button>
            <Link to="/login">Sign in</Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
