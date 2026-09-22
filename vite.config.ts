import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

import manifest from "./manifest.config.ts";

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  build: {
    // A release package carries no source maps: each one ships the original source with every install and
    // adds nothing a person needs (Phase 4 Task 26). Stated, not left to Vite's default, so that changing it
    // is a decision. `vite` in development keeps its own debugging support; this is the production build only.
    sourcemap: false,
  },
});
