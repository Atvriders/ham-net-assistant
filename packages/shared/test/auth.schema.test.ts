import { describe, it, expect } from 'vitest';
import { Email, LoginInput, Password, RegisterInput } from '../src/auth.js';

describe('Email', () => {
  it('trims and lowercases so one address cannot become two accounts', () => {
    // SQLite's unique index is BINARY: "Bob@X.com" and "bob@x.com" are two
    // distinct keys unless the input is normalized first.
    expect(Email.parse('  Bob@X.com ')).toBe('bob@x.com');
  });

  it('accepts an address at the RFC 5321 length limit', () => {
    const local = 'a'.repeat(254 - '@example.com'.length);
    expect(Email.parse(`${local}@example.com`)).toHaveLength(254);
  });

  it('rejects an address past the limit rather than persisting it', () => {
    expect(() => Email.parse(`${'a'.repeat(300)}@example.com`)).toThrow();
  });

  it('still rejects a non-address', () => {
    expect(() => Email.parse('not-an-email')).toThrow();
  });
});

describe('Password', () => {
  it('requires 12 characters', () => {
    expect(() => Password.parse('hunter22')).toThrow();
    expect(() => Password.parse('elevenchars')).toThrow();
    expect(Password.parse('twelvechars!')).toBe('twelvechars!');
  });

  it('caps length so argon2 work per request stays bounded', () => {
    expect(() => Password.parse('x'.repeat(129))).toThrow();
  });
});

describe('RegisterInput / LoginInput email handling', () => {
  it('normalizes on registration', () => {
    const out = RegisterInput.parse({
      email: 'Alice@Example.COM',
      password: 'hunter2hunter2',
      name: 'Alice',
      callsign: 'W1AW',
    });
    expect(out.email).toBe('alice@example.com');
  });

  it('normalizes on login so the casing typed at sign-in does not matter', () => {
    const out = LoginInput.parse({ email: ' ALICE@example.com ', password: 'x' });
    expect(out.email).toBe('alice@example.com');
  });

  it('keeps login password validation permissive for pre-existing accounts', () => {
    // Members who registered under the old 8-char rule must still be able to
    // sign in; only registration enforces the new floor.
    expect(() => LoginInput.parse({ email: 'a@b.co', password: 'old8pass' })).not.toThrow();
  });
});
