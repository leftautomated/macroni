import type { MacroDoc } from "@/types";

/** True iff the nodes form exactly one linear path (backend chain_order shape). */
export function isLinearChain(doc: Pick<MacroDoc, "nodes" | "edges">): boolean {
  const { nodes, edges } = doc;
  if (nodes.length === 0) return false;
  const ids = new Set(nodes.map((n) => n.id));
  const outOf = new Map<string, string>();
  const inDeg = new Map<string, number>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return false;
    if (outOf.has(e.from)) return false; // fork (second out-edge)
    outOf.set(e.from, e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    if ((inDeg.get(e.to) ?? 0) > 1) return false; // converging
  }
  const starts = nodes.filter((nd) => (inDeg.get(nd.id) ?? 0) === 0);
  if (nodes.length === 1) return edges.length === 0;
  if (starts.length !== 1) return false; // cycle → 0 starts; orphan → >1
  let cur: string | undefined = starts[0].id;
  const seen = new Set<string>();
  while (cur !== undefined) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = outOf.get(cur);
  }
  return seen.size === nodes.length;
}
