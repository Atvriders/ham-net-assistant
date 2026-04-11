import type { Role } from '@hna/shared';

/**
 * Returns true if the given role is allowed to view net scripts.
 * Officers and admins can see scripts; plain members cannot.
 */
export function canViewScripts(role: Role | undefined): boolean {
  return role === 'OFFICER' || role === 'ADMIN';
}

/**
 * Recursively redact scriptMd from any Net object in a response payload.
 * Walks objects and arrays shallowly; targets anything that looks like a Net
 * (has numeric dayOfWeek + startLocal keys) and sets its scriptMd to null.
 * Mutates in place and returns the same value for chaining.
 */
export function redactScriptsForRole<T>(payload: T, role: Role | undefined): T {
  if (canViewScripts(role)) return payload;
  walk(payload);
  return payload;

  function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      'scriptMd' in obj &&
      ('dayOfWeek' in obj || 'startLocal' in obj || 'repeaterId' in obj)
    ) {
      obj.scriptMd = null;
    }
    for (const key of Object.keys(obj)) {
      walk(obj[key]);
    }
  }
}
