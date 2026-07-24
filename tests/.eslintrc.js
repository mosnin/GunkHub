/**
 * Package-local ESLint config for `tests/`. Merges with the repo-root
 * `.eslintrc.js` (which is `root: true`, so resolution stops there — but
 * nested configs below it still cascade).
 *
 * WHY IT EXISTS: type-aware linting needs every linted file to belong to the
 * TSConfig named by `parserOptions.project`. The root config resolves that
 * with `project: true`, i.e. the nearest `tsconfig.json` — which for this
 * package is `tests/tsconfig.json`, and that file deliberately EXCLUDES the
 * files checked by the two sibling projects:
 *
 *   - `unit/fix_confidence_vocab.test.ts` -> tsconfig.convex-seam.json
 *   - `unit/patterns_a11y.test.tsx` and the modules it pulls in
 *     -> tsconfig.dom.json
 *
 * The convex-seam file gets away with it because the root config has an
 * override matching `**\/*.test.ts` that sets `project: null` and drops
 * type-aware linting entirely. That override does not match `.tsx`, so
 * without this file ESLint fails to parse the DOM test with "TSConfig does
 * not include this file".
 *
 * Rather than disabling type-aware linting for DOM tests — which is the part
 * of the lint that actually catches a floating promise in an async
 * `userEvent` call, exactly the bug class these tests are full of — this
 * points them at the project that DOES include them. They stay fully
 * type-checked and fully type-linted.
 *
 * @type {import('eslint').Linter.Config}
 */
module.exports = {
  overrides: [
    {
      files: ['unit/patterns_a11y.test.tsx', 'stubs/next-link.tsx', 'setup/dom.ts'],
      parserOptions: {
        project: './tsconfig.dom.json',
        tsconfigRootDir: __dirname,
      },
      rules: {
        // Same relaxations the root config grants every other test file.
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
}
