import tseslint from "typescript-eslint";

import reactConfig from "@tsmono/eslint-config/react";

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", "eslint.config.js"],
  },
  ...reactConfig,
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // The annotation model is shared by every view of annotations, so it
  // stays free of React and of the components that draw it: it imports its
  // own files and packages checked to be React-free, nothing else.
  {
    files: ["src/chat/annotations/model/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!\\./|@tsmono/util$|@tsmono/inspect-common/(types|testing)$|vitest$)",
              message:
                "The annotation model imports only model/ files and React-free packages listed in eslint.config.js.",
            },
          ],
        },
      ],
    },
  },
  // Test helpers / fixture files — allow _-prefixed unused vars for API compat
  {
    files: ["**/*.test.ts", "**/testHelpers.ts", "**/syntheticNodes.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
