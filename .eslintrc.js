module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  root: true,
  env: {
    node: true,
  },
  ignorePatterns: ['dist', 'tslint.json', 'node_modules'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
      },
    ],
    '@typescript-eslint/no-require-imports': 'off',

    semi: ['error', 'never'],
    quotes: ['error', 'single', { avoidEscape: true }],
    'sort-imports': [
      'error',
      {
        ignoreCase: true,
        allowSeparatedGroups: true,
      },
    ],
    curly: [2, 'multi-line'],
    'max-len': [
      'error',
      {
        code: 120,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
      },
    ],
    'comma-dangle': ['error', 'always-multiline'],
  },
  overrides: [
    {
      files: ['test/**/*.ts', '**/*.spec.ts'],
      rules: {
        '@typescript-eslint/no-unused-expressions': 'off',
      },
    },
  ],
}