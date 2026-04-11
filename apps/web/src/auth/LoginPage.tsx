import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { useAuth } from './AuthProvider.js';
import { ApiErrorException } from '../api/client.js';

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await login({ email, password });
      const from = (loc.state as { from?: { pathname?: string } } | null)?.from?.pathname;
      nav(from && from !== '/login' ? from : '/', { replace: true });
    } catch (ex) {
      if (ex instanceof ApiErrorException) setErr(ex.payload.message);
      else setErr('Login failed');
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '60px auto' }}>
      <Card>
        <h1>Sign in</h1>
        <form onSubmit={submit}>
          <label>
            Email
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            Password
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {err && (
            <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 12 }}>
              {err}
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
            <Button type="submit">Sign in</Button>
            <Link className="hna-nav-link" to="/register">Register</Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
