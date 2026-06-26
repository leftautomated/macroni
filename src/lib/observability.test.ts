import { describe, expect, it } from "vitest";
import { createTraceId, stableStringify, stringifyError, toKeyValues } from "@/lib/observability";

describe("observability helpers", () => {
  it("createTraceId includes the requested prefix", () => {
    expect(createTraceId("recording")).toMatch(/^recording-/);
  });

  it("stringifyError preserves error messages", () => {
    expect(stringifyError(new Error("capture failed"))).toContain("capture failed");
  });

  it("stableStringify falls back for circular values", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(stableStringify(value)).toBe("[object Object]");
  });

  it("toKeyValues drops undefined and stringifies nested values", () => {
    expect(
      toKeyValues({
        command: "start_recording",
        traceId: undefined,
        fields: { fps: 30 },
      }),
    ).toEqual({
      command: "start_recording",
      fields: '{"fps":30}',
    });
  });
});
