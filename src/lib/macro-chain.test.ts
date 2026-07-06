import { describe, expect, it } from "vitest";
import { isLinearChain } from "./macro-chain";

const n = (id: string) => ({
  id,
  kind: { type: "Segment" as const, events: [], speed: 1 },
  x: 0,
  y: 0,
});
const chain = (ids: string[], edges: Array<[string, string]>) => ({
  nodes: ids.map(n),
  edges: edges.map(([from, to]) => ({ from, to })),
});

describe("isLinearChain", () => {
  it("accepts a single node and a valid chain in any node order", () => {
    expect(isLinearChain(chain(["a"], []))).toBe(true);
    expect(
      isLinearChain(
        chain(
          ["c", "a", "b"],
          [
            ["a", "b"],
            ["b", "c"],
          ],
        ),
      ),
    ).toBe(true);
  });
  it("rejects empty, fork, cycle, orphan, unknown, self", () => {
    expect(isLinearChain(chain([], []))).toBe(false);
    expect(
      isLinearChain(
        chain(
          ["a", "b", "c"],
          [
            ["a", "b"],
            ["a", "c"],
          ],
        ),
      ),
    ).toBe(false); // fork
    expect(
      isLinearChain(
        chain(
          ["a", "b"],
          [
            ["a", "b"],
            ["b", "a"],
          ],
        ),
      ),
    ).toBe(false); // cycle
    expect(isLinearChain(chain(["a", "b"], []))).toBe(false); // orphan pair
    expect(isLinearChain(chain(["a"], [["a", "ghost"]]))).toBe(false); // unknown
    expect(isLinearChain(chain(["a"], [["a", "a"]]))).toBe(false); // self
  });
});
