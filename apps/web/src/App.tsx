import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider.js';
import { ThemeProvider, useTheme } from './theme/ThemeProvider.js';
import { effectiveLogoUrl } from './theme/registry.js';
import { RequireRole } from './auth/RequireRole.js';
import { LoginPage } from './auth/LoginPage.js';
import { RegisterPage } from './auth/RegisterPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { Dashboard } from './pages/Dashboard.js';
import { RepeatersPage } from './pages/RepeatersPage.js';
import { NetsPage } from './pages/NetsPage.js';
import { RunNetPage } from './pages/RunNetPage.js';
import { JoinNetPage } from './pages/JoinNetPage.js';
import { SessionSummaryPage } from './pages/SessionSummaryPage.js';
import { StatsPage } from './pages/StatsPage.js';
import { TopicsPage } from './pages/TopicsPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { Button } from './components/ui/Button.js';
import { displayCallsign } from './lib/format.js';

function NavBar() {
  const { user, logout } = useAuth();
  const { current } = useTheme();
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '14px 24px',
        background: 'var(--color-bg-muted)',
        borderBottom: '1px solid var(--color-border)',
        position: 'relative',
      }}
    >
      <img src={effectiveLogoUrl(current)} alt={current.logo.alt} style={{ height: 28 }} />
      <strong
        style={{
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          fontSize: 14,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        Ham-Net-Assistant
      </strong>
      {user && (
        <>
          <Link to="/" className="hna-nav-link">Dashboard</Link>
          <Link to="/nets" className="hna-nav-link">Nets</Link>
          <Link to="/topics" className="hna-nav-link">Topics</Link>
          <Link to="/stats" className="hna-nav-link">Stats</Link>
          <Link to="/settings" className="hna-nav-link">Settings</Link>
          {user.role === 'ADMIN' && <Link to="/admin" className="hna-nav-link">Admin</Link>}
          <span
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              letterSpacing: '0.06em',
            }}
          >
            <span style={{
              height: 20,
              width: 1,
              background: 'var(--color-border)',
              marginRight: 4,
            }} />
            {displayCallsign(user.callsign)}
            <Button variant="secondary" onClick={() => logout()}>Sign out</Button>
          </span>
        </>
      )}
    </nav>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <NavBar />
          <main>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/" element={<RequireRole><Dashboard /></RequireRole>} />
              <Route path="/repeaters" element={<RequireRole><RepeatersPage /></RequireRole>} />
              <Route path="/nets" element={<RequireRole><NetsPage /></RequireRole>} />
              <Route path="/nets/:netId/join" element={<RequireRole><JoinNetPage /></RequireRole>} />
              <Route path="/run/:sessionId" element={<RequireRole min="OFFICER"><RunNetPage /></RequireRole>} />
              <Route path="/sessions/:sessionId/summary" element={<RequireRole min="OFFICER"><SessionSummaryPage /></RequireRole>} />
              <Route path="/stats" element={<RequireRole min="OFFICER"><StatsPage /></RequireRole>} />
              <Route path="/topics" element={<RequireRole><TopicsPage /></RequireRole>} />
              <Route path="/settings" element={<RequireRole><SettingsPage /></RequireRole>} />
              <Route path="/admin" element={<RequireRole min="ADMIN"><AdminPage /></RequireRole>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
