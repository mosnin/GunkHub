/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: true,
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  rules: {
    // Unused variables are always a bug
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    // Explicit any is usually a design smell; warn rather than error so it doesn't block
    '@typescript-eslint/no-explicit-any': 'warn',
    // Enforce `import type` for type-only imports to keep runtime bundles clean
    '@typescript-eslint/consistent-type-imports': [
      'error',
      {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
        disallowTypeAnnotations: false,
      },
    ],
    // Consistent type exports to match import style
    '@typescript-eslint/consistent-type-exports': [
      'error',
      { fixMixedExportsWithInlineTypeSpecifier: true },
    ],
    // Prefer using nullish coalescing over || for nullable checks
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    // Don't use non-null assertions — use proper narrowing
    '@typescript-eslint/no-non-null-assertion': 'error',
    // Import ordering: built-ins, externals, internals, relatives
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    // No duplicate imports
    'import/no-duplicates': 'error',
    // Disallow default exports in non-framework files (components use default; modules use named)
    // This is a warn so Next.js page/layout files (which require default) don't break
    'import/no-default-export': 'off',
    // Ensure imports resolve
    'import/no-unresolved': 'off', // TypeScript handles this
    // No floating promises — all async calls must be awaited or handled
    '@typescript-eslint/no-floating-promises': 'error',
    // Require await in async functions (catches accidentally-async functions)
    '@typescript-eslint/require-await': 'error',
    // No unnecessary type assertions
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  },
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
      },
    },
  },
  overrides: [
    {
      // Relax some rules for config files that run in Node without bundling
      files: ['*.config.{js,ts,mjs,cjs}', '*.eslintrc.{js,cjs}', 'scripts/**/*.{js,ts}'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
    {
      // Test files can use explicit any for mocking
      files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
      },
    },
  ],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    '.next/',
    'coverage/',
    '.turbo/',
    '*.d.ts',
  ],
}
