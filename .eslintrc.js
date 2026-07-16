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
      node: {
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
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
      // Files not included in a tsconfig `project` (tests, config, examples,
      // hand-authored generated files). Disable type-aware linting so ESLint does
      // not error with "file not included in project", and relax rules that are
      // idiomatic in these files. Syntactic lint (import/order, unused, etc.) stays.
      files: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/__tests__/**/*.ts',
        '**/*.config.{ts,js,mjs,cjs}',
        '**/examples/**/*.ts',
        'convex/_generated/**/*.ts',
      ],
      parserOptions: { project: null },
      extends: ['plugin:@typescript-eslint/disable-type-checked'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    {
      // Convex backend source: ctx.db/ctx.runQuery returns are `any` at the type
      // level (the generated api uses anyApi / string refs), so the unsafe-* rules
      // fire pervasively without catching real bugs. Relax them for convex source
      // only (NOT tests or generated, handled above).
      files: ['convex/**/*.ts'],
      excludedFiles: ['**/*.test.ts', 'convex/_generated/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        // Idiomatic in Convex handlers: `args.agentId!` after an undefined guard,
        // `conditions[0]!` on a proven-non-empty array. The null-checks are present;
        // the assertions just narrow what the flow already guarantees.
        '@typescript-eslint/no-non-null-assertion': 'off',
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
