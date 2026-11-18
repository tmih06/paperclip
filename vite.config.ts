import { defineConfig } from "vite-plus";

// Lint and format settings only. The workspace has no single Vite app config,
// so each package keeps its own Vite/Vitest config and `vp test` finds them.
export default defineConfig({
  lint: {
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    plugins: ["typescript", "unicorn", "oxc", "react", "vitest", "import"],
    rules: {
      // The app uses the automatic JSX runtime, so React need not be imported.
      "react/react-in-jsx-scope": "off",
    },
    ignorePatterns: [
      "**/dist/**",
      "**/dist-*/**",
      "**/node_modules/**",
      "**/storybook-static/**",
      "**/ui-dist/**",
      "**/coverage/**",
      "maps/generated/**",
      "**/*.generated.*",
      "**/vendor/**",
      "packages/db/src/migrations/**",
      "ui/storybook/generated/**",
    ],
  },
  fmt: {
    printWidth: 120,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    ignorePatterns: [
      "**/dist/**",
      "**/node_modules/**",
      "**/storybook-static/**",
      "**/ui-dist/**",
      "**/coverage/**",
      "maps/generated/**",
      "**/*.generated.*",
      "packages/db/src/migrations/**",
      "ui/storybook/generated/**",
      "**/vendor/**",
    ],
  },
});
