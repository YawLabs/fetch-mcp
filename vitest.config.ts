import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    include: ["src/**/*.test.ts"],
    // Cap workers: fixture-server suites leave no headroom at cores-1 when
    // several sessions test at once. 4 matches ctxlint/typed/mcp-compliance.
    maxWorkers: 4,
  },
});
