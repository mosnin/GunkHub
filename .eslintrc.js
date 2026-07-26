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

    // ── design.md alias trap ────────────────────────────────────────────────
    //
    // WHY THIS RULE EXISTS
    // `apps/web/tailwind.config.ts` remaps Tailwind's numeric `neutral` /
    // `primary` / `success` / `destructive` / `warning` scales onto the Neon
    // tokens. The class name then gives no hint which token you picked:
    // `text-neutral-500` IS Ash, and Ash fails WCAG AA on every elevated
    // surface (4.39:1 on Graphite Deep, 3.68:1 on Graphite). That spelling is
    // how the sub-AA token spread across the app unnoticed. See design.md
    // § "Tailwind alias trap" and § "Derived Tailwind ramps".
    //
    // WHY NOT JUST DELETE THE STOPS FROM tailwind.config.ts
    // Tailwind emits NOTHING for an unknown utility — no error, no warning. A
    // deleted stop turns a measurable 4.39:1 contrast defect into text with no
    // colour rule at all, inheriting whatever is above it. That is a silent,
    // unmeasurable regression across dozens of files, and strictly worse than
    // the defect it replaces. An authoring-time lint error is the correct tool.
    //
    // WHY THE LIST BELOW IS ONLY 15 OF THE 43 DEFINED STOPS — READ BEFORE ADDING
    // These 15 are the stops with ZERO usages in apps/web today, so banning
    // them costs nothing and closes them permanently. The remaining 28 have
    // ~1,125 live usages across 82 files (`neutral-800` 178, `neutral-500` 143,
    // `neutral-400` 132, `neutral-300` 125, …). Adding them here today would
    // produce ~1,125 lint errors, and the only way to ship that is a blanket
    // `eslint-disable` sweep — which would destroy the signal permanently and
    // is exactly the waiver-to-green pattern this repo forbids.
    //
    // So this rule is deliberately PARTIAL and is not the whole gate:
    // `scripts/check-design-tokens.ts` reports every one of those ~1,125
    // usages, with file, line, the token each resolves to, and the token
    // spelling to use. Migrating them is its own cycle, owned by the teams that
    // own apps/web. As each stop reaches zero usages, MOVE IT INTO THIS LIST —
    // that is the ratchet, and the design-token check tells you when a stop is
    // ready. Do not add a stop here while usages remain; do not silence the
    // design-token check instead.
    //
    // The boundaries matter: the trailing `(?:$|[\s\/])` is what stops
    // `neutral-50` from also matching inside `neutral-500` (Ash — still in wide
    // use and deliberately NOT banned yet), and the leading `[\s:-]` lets the
    // rule see the stop through any utility prefix and any variant
    // (`hover:border-warning-600`).
    'no-restricted-syntax': [
      'error',
      ...['Literal[value=/{RE}/]', 'TemplateElement[value.raw=/{RE}/]'].map((selector) => ({
        selector: selector.replace(
          '{RE}',
          '(?:^|[\\s:-])(?:neutral-(?:50|850)|primary-(?:50|100|200|600)|success-(?:50|100|500|600)|destructive-(?:50|100)|warning-(?:50|100|600))(?:$|[\\s\\/])',
        ),
        message:
          'Off-system Tailwind ramp stop. These numeric stops are remapped aliases, not design.md tokens — ' +
          'the class name hides which token (and which contrast ratio) you are choosing. Use the named token ' +
          'spelling instead (text-pewter, bg-graphite-deep, text-neon-glow, …). See design.md ' +
          '§ "Tailwind alias trap"; run `pnpm tsx scripts/check-design-tokens.ts` for the token each class resolves to.',
      })),
    ],
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
