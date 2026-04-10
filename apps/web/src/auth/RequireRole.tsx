import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '@hna/shared';
import { useAuth } from './AuthProvider.js';

const ORDER: Record<Role, number> = { MEMBER: 0, OFFICER: 1, ADMIN: 2 };

export function RequireRole({
  min = 'MEMBER',
  children,
}: React.PropsWithChildren<{ min?: Role }>) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div>Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc }} />;
  if (ORDER[user.role] < ORDER[min]) return <div>Forbidden</div>;
  return <>{children}</>;
}
