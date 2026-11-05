// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'packages/results-schema/src/generated/**',
      // a consumer project's tests, type-checked by Playwright when the e2e runs
      'e2e/fixture/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.mjs', 'e2e/*.mjs', 'packages/*/scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'off',
    },
  },
  {
    // node:test's test() returns a promise the runner tracks; tests narrow and cast defensively on purpose
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
)
