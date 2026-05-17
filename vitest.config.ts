import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

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
      // Ratchet baseline — after the App + RecordingControls + ExpandToggle
      // tests landed, totals are statements 32.85%, branches 15.61%,
      // functions 25.71%, lines 33.65%. Gate sits a few points below to fire
      // on regression without churning on rounding. Ratchet upward (never
      // down) as more component tests are added. See docs/adrs/0005-coverage-gate.md.
      thresholds: {
        lines: 30,
        statements: 30,
        functions: 22,
        branches: 14,
      },
    },
  },
});
