import React, { useState } from 'react';
import { Card } from '../components/ui/Card.js';
import { Input } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { useAuth } from '../auth/AuthProvider.js';
import { ThemePicker } from '../theme/ThemePicker.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { displayCallsign } from '../lib/format.js';

export function SettingsPage() {
  const { user, updateMe } = useAuth();
  const { mode, setMode } = useTheme();
  const [name, setName] = useState(user?.name ?? '');
  if (!user) return null;
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 800, margin: '24px auto' }}>
      <Card>
        <h2>Profile</h2>
        <label>
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div style={{ marginTop: 12 }}>
          <Button onClick={() => updateMe({ name })}>Save</Button>
        </div>
        <p>
          Callsign: <strong>{displayCallsign(user.callsign)}</strong> (permanent)
        </p>
        <p>Role: {user.role}</p>
      </Card>
      <Card>
        <h3>Color mode</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant={mode === 'dark' ? 'primary' : 'secondary'}
            onClick={() => setMode('dark')}
          >
            Dark
          </Button>
          <Button
            variant={mode === 'light' ? 'primary' : 'secondary'}
            onClick={() => setMode('light')}
          >
            Light
          </Button>
        </div>
      </Card>
      <ThemePicker />
    </div>
  );
}
