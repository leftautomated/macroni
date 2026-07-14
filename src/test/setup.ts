import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom doesn't implement ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom doesn't implement scrollIntoView or pointer capture, both of which
// Radix popovers/selects call when opening.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;

vi.mock("@tauri-apps/plugin-log", () => ({
  attachConsole: vi.fn().mockResolvedValue(() => {}),
  debug: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
  info: vi.fn().mockResolvedValue(undefined),
  trace: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
}));
