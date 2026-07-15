import { describe, expect, it } from "vitest";
import { fmtMmSs } from "./time-format";

describe("fmtMmSs", () => {
  it("formats ms as m:ss, flooring and clamping negatives", () => {
    expect(fmtMmSs(0)).toBe("0:00");
    expect(fmtMmSs(2999)).toBe("0:02");
    expect(fmtMmSs(65_000)).toBe("1:05");
    expect(fmtMmSs(-50)).toBe("0:00");
  });
});
