import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Avoid double-running tests that live inside worktrees nested in the repo root.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__tests__/**",
        "src/test/**",
        "src/components/ui/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      // Ratchet baseline — current totals (1 commit before #6 lands) are
      // statements 8.21%, branches 6.69%, functions 6.28%, lines 7.88%.
      // Floor sits just below those so the gate fires on regression but
      // doesn't churn on rounding. Ratchet upward (never down) as tests are
      // added. See docs/adrs/0005-coverage-gate.md.
      thresholds: {
        lines: 7,
        statements: 7,
        functions: 6,
        branches: 6,
      },
    },
  },
});
