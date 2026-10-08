/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    browser: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    'node_modules/',
    '.next/',
    'dist/',
    'coverage/',
    'src/lib/db/migrations/',
    '*.config.js',
    '*.config.cjs',
  ],
  rules: {
    // Forbidden list items 1 and 2 (AGENTS.md).
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'warn',

    // Forbidden list item 3 (AGENTS.md): direct Edge table inserts are banned.
    // Only insertVerifiedEdge() may write to the Edge table. The rule is a
    // generic AST match on `x.insert(edges)` so it catches `db.insert(edges)`
    // and `tx.insert(edges)` alike.
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "CallExpression[callee.property.name='insert'][arguments.0.name='edges']",
        message:
          'Direct inserts into the Edge table are forbidden. Use insertVerifiedEdge() in src/lib/graph/insertVerifiedEdge.ts (invariant P3).',
      },
    ],
  },
  overrides: [
    {
      // The one sanctioned Edge write path.
      files: ['**/insertVerifiedEdge.ts'],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
  ],
};
