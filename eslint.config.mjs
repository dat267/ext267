import js from "@eslint/js";
import prettierPlugin from "eslint-plugin-prettier";
import globals from "globals";

const commonRules = {
  "no-shadow": ["error", { allow: ["err"] }],
  "prefer-arrow-callback": "error",
  "curly": ["error", "multi", "consistent"],
  "prettier/prettier": "error"
};

export default [
  { ignores: ["**/node_modules/", "**/web-ext-artifacts/", "eslint.config.mjs"] },

  // Recommended rules for all JS files
  js.configs.recommended,

  // All project JS — browser + webextension globals
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        globalThis: "readonly"
      }
    },
    plugins: { prettier: prettierPlugin },
    rules: commonRules
  },

  // Node.js build scripts and unit tests override globals
  {
    files: [
      "build-package.js",
      "version-sync.js",
      "tests/**/*.test.js"
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node
      }
    },
    plugins: { prettier: prettierPlugin },
    rules: commonRules
  }
];
