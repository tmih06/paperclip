import path from "path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";
import { createApiProxy } from "./src/lib/vite-api-proxy";
import { serviceWorkerBuildIdPlugin } from "./src/lib/vite-sw-build-id";
import { readBrowserBuildCommit } from "./src/lib/vite-build-commit";
import { preloadIssueDetail } from "./src/lib/vite-issue-detail-preload";

const apiProxy = createApiProxy();
const lexicalEntry = createRequire(import.meta.url).resolve("lexical");

export default defineConfig(({ mode }) => ({
  define: {
    __PAPERCLIP_BUILD_COMMIT__: JSON.stringify(
      readBrowserBuildCommit(__dirname),
    ),
  },
  plugins: [react(), tailwindcss(), serviceWorkerBuildIdPlugin(), preloadIssueDetail()],
  build: {
    minify: "oxc",
    rolldownOptions: {
      output: {
        minify: mode === "production" ? {
          compress: { dropConsole: true, dropDebugger: true, keepNames: { function: true, class: true } },
          mangle: { keepNames: true },
        } : undefined,
        comments: { legal: false },
        codeSplitting: {
          groups: [
            { name: "board-startup", tags: ["$initial"], priority: 10 },
            { name: "collections", test: /\/src\/pages\/(?:Issues|Inbox|LegacyInbox|CoordinatorTasks)\.tsx$/, priority: 6 },
            { name: "issue-detail", test: /\/src\/pages\/IssueDetail\.tsx$/, priority: 5 },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.join(path.dirname(lexicalEntry), "Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: apiProxy,
  },
  preview: {
    port: 3101,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: apiProxy,
  },
}));
