module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ['dist', 'build', 'coverage', 'node_modules'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
  },
  overrides: [
    {
      files: ['apps/web/src/**/*.{ts,tsx}'],
      plugins: ['react-hooks'],
      extends: ['plugin:react-hooks/recommended'],
    },
  ],
};
