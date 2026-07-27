import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Image as ImageIcon, Pencil, ScanText, Trash2 } from "lucide-react";
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
  /** Commits an edited expect text for a TextOcr rule (trimmed, non-empty). */
  onEditExpect: (ruleId: string, expect: string) => void;
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
  onEditExpect,
}: RuleCardProps) {
  const kind = rule.trigger.kind;
  const label = triggerLabel(rule.trigger);
  const editable = kind.type === "TextOcr";
  const currentExpect = kind.type === "TextOcr" ? (kind.expect ?? "") : "";
  const [editing, setEditing] = useState(false);
  const [draftExpect, setDraftExpect] = useState(currentExpect);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    setDraftExpect(currentExpect);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = draftExpect.trim();
    if (!trimmed || trimmed === currentExpect) return;
    onEditExpect(rule.id, trimmed);
  };

  return (
    <div
      className="rc-root"
      data-live={live || undefined}
      data-failed={failedReason ? true : undefined}
      data-watching={watching || undefined}
      data-disabled={!rule.enabled || undefined}
    >
      {/* The expect-text input/edit-affordance below stop their own click
          propagation so interacting with them never also fires select. */}
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
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              className="rc-when-input"
              value={draftExpect}
              aria-label={`Edit trigger text: ${label}`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraftExpect(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraftExpect(currentExpect);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="rc-when-label">When {label}</span>
          )}
          {editable && !editing && (
            <button
              type="button"
              className="rc-edit"
              aria-label={`Edit trigger text: ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
            >
              <Pencil aria-hidden="true" />
            </button>
          )}
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
