// Flat ESLint config. Mirrors the legacy .eslintrc.cjs as closely as possible.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'build/',
      'node_modules/',
      'coverage/',
      'apps/web/public/',
      '**/dist/',
      '**/build/',
      '**/coverage/',
      '**/node_modules/',
      '*.config.js',
      '**/*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-hooks v7 promoted two React-Compiler advisory rules into
      // `recommended`. They flag long-standing, working patterns here
      // (modal reset-on-open prop→state syncs; Date.now() freshness windows
      // evaluated during render) whose "fixes" are structural redesigns —
      // out of scope for a toolchain wave. Deferred deliberately, like the
      // Prisma 7 migration: adopt rule-by-rule in a dedicated refactor pass.
      // Every rule that was enforced before eslint 10 remains enforced.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },
  prettier,
);
