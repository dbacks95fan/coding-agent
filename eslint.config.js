// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: ESLint flat config: the recommended JavaScript and typescript-eslint rule sets.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "node_modules/", "deployment-packages/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
  {
    rules: {
      // Leading underscores mark values intentionally discarded during destructuring.
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
);
