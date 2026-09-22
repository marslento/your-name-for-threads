import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    css: true,
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    // The 5 s default is a wall-clock limit, not a work budget: with all test
    // files running in parallel a loaded machine (or a small CI runner) pushes
    // otherwise-fast jsdom tests past it. Three suites run at once timed out
    // 25 unrelated tests; a real hang still fails, just later.
    testTimeout: 20_000,
    // Bound jsdom concurrency on developer machines and CI; the default CPU-based
    // worker count can starve UI queries even when their behavior is correct.
    maxWorkers: 2,
  },
});
