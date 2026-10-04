import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/__tests__/**/*.test.ts", "src/app/api/**/*.test.ts"],
    // Task 7: coverage gate — deterministic stats tool (utils.ts) stays
    // measured; CI enforces the thresholds below.
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, functions: 80, branches: 70 },
      include: ["src/lib/utils.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
