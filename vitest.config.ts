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
  },
});
