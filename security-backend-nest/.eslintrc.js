// @ts-check
'use strict';

/** @type {import('eslint').Linter.Config} */
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'prettier'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: {
    node: true,
    es2021: true,
  },
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {
    // Formatting is managed separately by prettier; do not enforce it as a lint error
    // (the codebase predates this ESLint setup and a full reformat is out of RC scope).
    'prettier/prettier': 'off',

    // NestJS codebase uses `any` in generic service/repository types; warn only
    '@typescript-eslint/no-explicit-any': 'warn',

    // Unused vars: warn except for names prefixed with _ (intentionally unused)
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

    // NestJS DI constructors and lifecycle hooks are sometimes empty by design
    '@typescript-eslint/no-empty-function': 'off',

    // Decorators use require-style imports in some generated code
    '@typescript-eslint/no-require-imports': 'off',

    // Non-null assertions are used intentionally in TypeORM entity relations
    '@typescript-eslint/no-non-null-assertion': 'warn',
  },
};
