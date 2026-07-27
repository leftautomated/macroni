import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { RuleCard } from "@/components/studio/macros/RuleCard";
import type { MacroRule } from "@/types";

export interface RuleDeckProps {
  rules: MacroRule[];
  liveRuleId: string | null;
  failed: { ruleId: string; reason: string } | null;
  running: boolean;
  draft: ReactNode | null; // draft card slot, rendered pinned at the top
  onAddRule: () => void;
  onSelect: (ruleId: string) => void;
  onToggle: (ruleId: string) => void;
  onDelete: (ruleId: string) => void;
  onMove: (ruleId: string, delta: -1 | 1) => void;
}

/**
 * Sidebar list of rule cards. Always shows the "Add rule" affordance, even
 * when there are no rules yet — no empty-state copy, the button alone is
 * the invitation to create the first one.
 */
export function RuleDeck({
  rules,
  liveRuleId,
  failed,
  running,
  draft,
  onAddRule,
  onSelect,
  onToggle,
  onDelete,
  onMove,
}: RuleDeckProps) {
  return (
    <div className="rd-root">
      <button type="button" className="rd-add" aria-label="Add rule" onClick={onAddRule}>
        <Plus aria-hidden="true" />
        Add rule
      </button>
      {draft}
      {rules.map((rule, index) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          index={index}
          count={rules.length}
          live={liveRuleId === rule.id}
          failedReason={failed?.ruleId === rule.id ? failed.reason : null}
          watching={running && rule.enabled && liveRuleId !== rule.id}
          onSelect={onSelect}
          onToggle={onToggle}
          onDelete={onDelete}
          onMove={onMove}
        />
      ))}
    </div>
  );
}
