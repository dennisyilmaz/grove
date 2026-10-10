import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against source so they never depend on a stale build.
    alias: {
      "@grove/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
    },
  },
  test: {
    // `.tsx` picks up component render tests (server-rendered, no DOM needed).
    include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
