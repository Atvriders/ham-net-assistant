import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, NavLink } from 'react-router-dom';
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
import { TopicsPage } from './pages/TopicsPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { OfficerToolsPage } from './pages/OfficerToolsPage.js';
import { Clock } from './components/ui/Clock.js';
import { ConsoleField } from './components/ConsoleField.js';
import { NetStatusIndicator } from './components/NetStatusIndicator.js';
import { displayCallsign } from './lib/format.js';

// Lazy-load the StatsPage so the recharts bundle (~300-400 KB) is only fetched
// when an officer/admin actually navigates to /stats. Most users never hit
// this route, so it stays out of the initial payload.
const StatsPage = lazy(() =>
  import('./pages/StatsPage.js').then((m) => ({ default: m.StatsPage })),
);

/**
 * Fallback shown while the StatsPage chunk (recharts) is being fetched.
 * Mirrors the calibrated Card + mono caption used elsewhere so the loading
 * state looks intentional rather than blank.
 */
function StatsPageFallback() {
  return (
    <div className="hna-page">
      <div className="hna-card" aria-busy="true" aria-live="polite">
        <div
          className="hna-mono"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            letterSpacing: '0.08em',
            color: 'var(--color-fg-muted, #888)',
            padding: 24,
          }}
        >
          {'// LOADING STATS'}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline radio-mast glyph. Two arcs (signal) sweeping out of a vertical mast,
 * topped with the amber "broadcast" dot. Pure SVG — no external asset.
 */
function MastGlyph() {
  return (
    <svg
      width="28"
      height="28"
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

function ColorModeToggle() {
  const { mode, setMode } = useTheme();
  const next = mode === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setMode(next)}
      className="hna-mode-toggle"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      [ {mode === 'dark' ? 'DARK' : 'LIGHT'} ]
    </button>
  );
}

function NavBar() {
  const { user, logout } = useAuth();
  const { current } = useTheme();
  return (
    <header className="hna-shell__nav">
      <div className="hna-shell__nav-inner">
        <Link to="/" className="hna-shell__brand" aria-label="Ham-Net-Assistant home">
          <span className="hna-shell__brand-mark">
            {current.logoUrl || current.uploadedLogoUrl ? (
              <img
                src={effectiveLogoUrl(current)}
                alt=""
                style={{ height: 28, width: 'auto' }}
              />
            ) : (
              <MastGlyph />
            )}
          </span>
          <span className="hna-shell__brand-name">Ham-Net-Assistant</span>
        </Link>
        {user && (
          <nav
            aria-label="Primary"
            className="hna-shell__nav-links"
          >
            <NavLink to="/" end className={({ isActive }) => `hna-nav-link${isActive ? ' active' : ''}`}>
              Dashboard
            </NavLink>
            <NavLink to="/nets" className={({ isActive }) => `hna-nav-link${isActive ? ' active' : ''}`}>
              Nets
            </NavLink>
            <NavLink to="/topics" className={({ isActive }) => `hna-nav-link${isActive ? ' active' : ''}`}>
              Topics
            </NavLink>
            {(user.role === 'OFFICER' || user.role === 'ADMIN') && (
              <NavLink to="/stats" className={({ isActive }) => `hna-nav-link${isActive ? ' active' : ''}`}>
                Stats
              </NavLink>
            )}
            <NavLink to="/settings" className={({ isActive }) => `hna-nav-link${isActive ? ' active' : ''}`}>
              Settings
            </NavLink>
            {(user.role === 'OFFICER' || user.role === 'ADMIN') && (
              <NavLink to="/officer-tools" className={({ isActive }) => `hna-nav-link${isActive ? ' active' : ''}`}>
                Officer tools
              </NavLink>
            )}
            {user.role === 'ADMIN' && (
              <NavLink to="/admin" className={({ isActive }) => `hna-nav-link${isActive ? ' active' : ''}`}>
                Admin
              </NavLink>
            )}
          </nav>
        )}
        <div className="hna-shell__tail">
          {user && <NetStatusIndicator enabled={!!user} />}
          <Clock />
          <ColorModeToggle />
          {user && (
            <>
              <span className="hna-shell__divider" aria-hidden="true" />
              <span className="hna-shell__user-callsign">
                {displayCallsign(user.callsign)}
              </span>
              <button
                type="button"
                onClick={() => logout()}
                className="hna-btn secondary size-sm"
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

const HNA_VERSION = '0.1';

function Footer() {
  return (
    <footer className="hna-shell__footer">
      <span>{`// HAM-NET-ASSISTANT v${HNA_VERSION}`}</span>
    </footer>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <div className="hna-shell">
            {/* Interactive phosphor background — fixed, z-index:-1, pointer-
                events:none. Sits above the body's static graph-paper grid
                (which propagates to the root canvas) and below all shell
                content, the sticky nav, and modal backdrops. */}
            <ConsoleField />
            <NavBar />
            <main className="hna-shell__main">
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/" element={<RequireRole><Dashboard /></RequireRole>} />
                <Route path="/repeaters" element={<RequireRole><RepeatersPage /></RequireRole>} />
                <Route path="/nets" element={<RequireRole><NetsPage /></RequireRole>} />
                <Route path="/nets/:netId/join" element={<RequireRole><JoinNetPage /></RequireRole>} />
                <Route path="/run/:sessionId" element={<RequireRole min="NET_CONTROL"><RunNetPage /></RequireRole>} />
                <Route path="/sessions/:sessionId/summary" element={<RequireRole min="NET_CONTROL"><SessionSummaryPage /></RequireRole>} />
                <Route
                  path="/stats"
                  element={
                    <RequireRole min="OFFICER">
                      <Suspense fallback={<StatsPageFallback />}>
                        <StatsPage />
                      </Suspense>
                    </RequireRole>
                  }
                />
                <Route path="/topics" element={<RequireRole><TopicsPage /></RequireRole>} />
                <Route path="/settings" element={<RequireRole><SettingsPage /></RequireRole>} />
                <Route path="/officer-tools" element={<RequireRole min="OFFICER"><OfficerToolsPage /></RequireRole>} />
                <Route path="/admin" element={<RequireRole min="ADMIN"><AdminPage /></RequireRole>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
            <Footer />
          </div>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
