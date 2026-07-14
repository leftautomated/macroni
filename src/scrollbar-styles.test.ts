import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalStyles = readFileSync("src/index.css", "utf8");

describe("custom scrollbar styles", () => {
  it("keeps WebKit pseudo-element styling enabled", () => {
    expect(globalStyles).toContain("*::-webkit-scrollbar");
    expect(globalStyles).toContain("*::-webkit-scrollbar-thumb");
    expect(globalStyles).toMatch(/background-color:\s*rgb\(240 205 120 \/ 42%\)/);

    // Non-auto CSS Scrollbars properties take precedence over the WebKit
    // pseudo-elements in current WebKit and make the native bar reappear.
    expect(globalStyles).not.toMatch(/scrollbar-(?:width|color)\s*:/);
  });
});
