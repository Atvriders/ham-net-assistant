import { describe, it, expect } from 'vitest';
import { redactScriptsForRole, canViewScripts } from '../../src/lib/scriptGate.js';

describe('canViewScripts', () => {
  it('returns true for OFFICER and ADMIN, false otherwise', () => {
    expect(canViewScripts('OFFICER')).toBe(true);
    expect(canViewScripts('ADMIN')).toBe(true);
    expect(canViewScripts('MEMBER')).toBe(false);
    expect(canViewScripts(undefined)).toBe(false);
  });
});

describe('redactScriptsForRole', () => {
  const makeNet = () => ({
    id: 'n1',
    name: 'Wed Net',
    dayOfWeek: 3,
    startLocal: '20:00',
    repeaterId: 'r1',
    scriptMd: '# Secret script',
  });

  it('redacts scriptMd on a single net when role is MEMBER', () => {
    const n = makeNet();
    redactScriptsForRole(n, 'MEMBER');
    expect(n.scriptMd).toBeNull();
  });

  it('leaves scriptMd unchanged for OFFICER', () => {
    const n = makeNet();
    redactScriptsForRole(n, 'OFFICER');
    expect(n.scriptMd).toBe('# Secret script');
  });

  it('leaves scriptMd unchanged for ADMIN', () => {
    const n = makeNet();
    redactScriptsForRole(n, 'ADMIN');
    expect(n.scriptMd).toBe('# Secret script');
  });

  it('redacts nested session.net.scriptMd for MEMBER', () => {
    const session = {
      id: 's1',
      startedAt: new Date().toISOString(),
      net: makeNet(),
      checkIns: [],
    };
    redactScriptsForRole(session, 'MEMBER');
    expect(session.net.scriptMd).toBeNull();
  });

  it('redacts all scriptMd fields in an array of nets for MEMBER', () => {
    const list = [makeNet(), makeNet(), makeNet()];
    redactScriptsForRole(list, 'MEMBER');
    for (const n of list) expect(n.scriptMd).toBeNull();
  });

  it('leaves unrelated objects with scriptMd but no net markers unchanged', () => {
    const obj = { scriptMd: 'x', someOtherField: 1 };
    redactScriptsForRole(obj, 'MEMBER');
    expect(obj.scriptMd).toBe('x');
  });

  it('redacts scriptMd when undefined role (anonymous)', () => {
    const n = makeNet();
    redactScriptsForRole(n, undefined);
    expect(n.scriptMd).toBeNull();
  });
});
