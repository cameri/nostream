module.exports = {
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
  },
  plugins: ["@typescript-eslint/eslint-plugin"],
  extends: ["plugin:@typescript-eslint/recommended"],
  root: true,
  env: {
    node: true,
  },
  ignorePatterns: [".eslintrc.js", "dist", "tslint.json", "node_modules"],
  rules: {
    "@typescript-eslint/interface-name-prefix": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-console": "off",
    semi: ["error", "never"],
    quotes: ["error", "single", { avoidEscape: true }]
  },
};
