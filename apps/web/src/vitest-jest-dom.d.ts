import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

// @testing-library/jest-dom/vitest (imported in test-setup.ts) registers the
// matchers at runtime, but its shipped types still augment vitest's legacy
// `Assertion` interface. Vitest 4 types matchers through the `Matchers`
// interface instead, so without this augmentation every jest-dom matcher
// (toBeInTheDocument, toHaveAttribute, ...) is a TS2339 at typecheck while
// passing at runtime. Remove once jest-dom ships a Matchers-based vitest.d.ts.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging: the "empty" interface is how the jest-dom matcher members get merged into vitest's Matchers
  interface Matchers<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
}
