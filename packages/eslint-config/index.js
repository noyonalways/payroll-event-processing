// @ts-check
// Shared backend flat config — the pre-move repository-root eslint.config.js,
// extracted verbatim (design D8: same rules, same results). Consumers keep a
// one-line eslint.config.js that re-exports this.
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettierConfig = require('eslint-config-prettier');

module.exports = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
);
