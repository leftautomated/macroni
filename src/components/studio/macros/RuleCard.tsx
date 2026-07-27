import { ChevronDown, ChevronUp, Image as ImageIcon, ScanText, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ruleSummary, triggerLabel } from "@/lib/macro-rules";
import type { MacroRule } from "@/types";

export interface RuleCardProps {
  rule: MacroRule;
  index: number;
  count: number;
  live: boolean; // this rule is currently firing
  failedReason: string | null; // non-null → failed styling + reason line
  watching: boolean; // run in progress and rule enabled
  onSelect: (ruleId: string) => void;
  onToggle: (ruleId: string) => void;
  onDelete: (ruleId: string) => void;
  onMove: (ruleId: string, delta: -1 | 1) => void;
}

export function RuleCard({
  rule,
  index,
  count,
  live,
  failedReason,
  watching,
  onSelect,
  onToggle,
  onDelete,
  onMove,
}: RuleCardProps) {
  const kind = rule.trigger.kind;
  const label = triggerLabel(rule.trigger);
  return (
    <div
      className="rc-root"
      data-live={live || undefined}
      data-failed={failedReason ? true : undefined}
      data-watching={watching || undefined}
      data-disabled={!rule.enabled || undefined}
    >
      <button type="button" className="rc-body" onClick={() => onSelect(rule.id)}>
        <span className="rc-when">
          {kind.type === "TextOcr" && <ScanText aria-hidden="true" />}
          {kind.type === "TemplateMatch" && <ImageIcon aria-hidden="true" />}
          {kind.type === "ColorSample" && (
            <span
              className="rc-swatch"
              style={{ background: `rgb(${kind.rgb[0]} ${kind.rgb[1]} ${kind.rgb[2]})` }}
              aria-hidden="true"
            />
          )}
          <span className="rc-when-label">When {label}</span>
        </span>
        <span className="rc-then">{ruleSummary(rule)}</span>
        {failedReason && <span className="rc-failed">{failedReason}</span>}
      </button>
      <div className="rc-controls">
        <Switch
          checked={rule.enabled}
          onCheckedChange={() => onToggle(rule.id)}
          aria-label={`Rule enabled: ${label}`}
        />
        <button
          type="button"
          className="rc-icon"
          aria-label={`Move up: ${label}`}
          disabled={index === 0}
          onClick={() => onMove(rule.id, -1)}
        >
          <ChevronUp aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rc-icon"
          aria-label={`Move down: ${label}`}
          disabled={index === count - 1}
          onClick={() => onMove(rule.id, 1)}
        >
          <ChevronDown aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rc-icon rc-delete"
          aria-label={`Delete rule: ${label}`}
          onClick={() => onDelete(rule.id)}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
