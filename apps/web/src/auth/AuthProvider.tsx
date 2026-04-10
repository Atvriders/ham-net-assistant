import React, { createContext, useContext, useEffect, useState } from 'react';
import type { PublicUser, RegisterInput, LoginInput } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';

interface AuthCtx {
  user: PublicUser | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  updateMe: (patch: Partial<Pick<PublicUser, 'name' | 'collegeSlug'>>) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<PublicUser>('/auth/me')
      .then(setUser)
      .catch((e) => {
        if (e instanceof ApiErrorException && e.status === 401) setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login: AuthCtx['login'] = async (input) => {
    setUser(
      await apiFetch<PublicUser>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
    );
  };
  const register: AuthCtx['register'] = async (input) => {
    setUser(
      await apiFetch<PublicUser>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
    );
  };
  const logout: AuthCtx['logout'] = async () => {
    await apiFetch<void>('/auth/logout', { method: 'POST' });
    setUser(null);
  };
  const updateMe: AuthCtx['updateMe'] = async (patch) => {
    setUser(
      await apiFetch<PublicUser>('/users/me', { method: 'PATCH', body: JSON.stringify(patch) }),
    );
  };

  return (
    <Ctx.Provider value={{ user, loading, login, register, logout, updateMe }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
