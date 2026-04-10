const js = require('@eslint/js')
const { FlatCompat } = require('@eslint/eslintrc')

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
})

module.exports = [
  {
    ignores: ['node_modules', 'dist', '.test-reports', '.coverage', '.nostr', 'tslint.json'],
  },
  ...compat.config({
    parser: '@typescript-eslint/parser',
    parserOptions: {
      sourceType: 'module',
    },
    plugins: ['@typescript-eslint'],
    extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
    env: {
      node: true,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      '@typescript-eslint/no-unused-expressions': 'off',
      semi: ['error', 'never'],
      quotes: ['error', 'single', { avoidEscape: true }],
      'sort-imports': ['error', {
        ignoreCase: true,
        allowSeparatedGroups: true,
      }],
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
      'comma-dangle': ['error', {
        arrays: 'always-multiline',
        objects: 'always-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'ignore',
      }],
    },
  }),
]
