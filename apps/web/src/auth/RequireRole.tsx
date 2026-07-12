import React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ROLE_RANK, type Role } from '@hna/shared';
import { useAuth } from './AuthProvider.js';
import { Card } from '../components/ui/Card.js';

// Lowercase labels for the "This area is for {label}s." sentence below.
const ROLE_LABEL: Record<Role, string> = {
  MEMBER: 'member',
  NET_CONTROL: 'net control operator',
  OFFICER: 'officer',
  ADMIN: 'admin',
};

export function RequireRole({
  min = 'MEMBER',
  children,
}: React.PropsWithChildren<{ min?: Role }>) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div>Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc }} />;
  if (ROLE_RANK[user.role] < ROLE_RANK[min]) {
    return (
      <div
        className="hna-container"
        style={{ maxWidth: 480, margin: '60px auto' }}
      >
        <Card>
          <h2 style={{ marginTop: 0 }}>Not available</h2>
          <p>This area is for {ROLE_LABEL[min]}s.</p>
          <Link to="/" className="hna-nav-link">
            Back to dashboard
          </Link>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
