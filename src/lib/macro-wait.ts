import type { MacroNode, PerceptionTarget } from "@/types";

/**
 * Builds a WaitFor MacroNode from a PerceptionTarget of any kind (text,
 * template, or color) — shared by every "Add ... Wait" authoring path so
 * they all produce identically-shaped nodes with the same defaults.
 */
export function waitNodeFromTarget(target: PerceptionTarget, timeoutMs = 10000): MacroNode {
  return {
    id: crypto.randomUUID(),
    kind: {
      type: "WaitFor",
      target,
      timeout_ms: timeoutMs,
      poll_interval_ms: 500,
    },
    x: 40,
    y: 160,
  };
}
