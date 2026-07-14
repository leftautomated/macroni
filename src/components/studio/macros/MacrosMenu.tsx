import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Workflow } from "lucide-react";
import type { MacroDoc } from "@/types";

export interface MacrosMenuProps {
  macros: MacroDoc[];
  selectedId: string | null;
  /** Id armed for delete (first click); a second click confirms. */
  confirmDeleteId: string | null;
  onSelect: (id: string) => void;
  /** Confirmed create — name is already trimmed / defaulted upstream isn't required, this passes the raw draft. */
  onCreate: (name: string) => void;
  onDeleteClick: (id: string) => void;
}

const DEFAULT_NAME = "Untitled Macro";

/**
 * Dropdown menu that lists saved macros — mirrors `RecordingsMenu`'s two-click
 * delete — plus an inline "New macro" row for creating one. Creating doesn't
 * touch the backend itself; it just hands a name up so the editor can seed a
 * fresh working doc (nothing persists until the caller explicitly saves it).
 */
export function MacrosMenu({
  macros,
  selectedId,
  confirmDeleteId,
  onSelect,
  onCreate,
  onDeleteClick,
}: MacrosMenuProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on a click anywhere outside the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const toggle = () => setOpen((wasOpen) => !wasOpen);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  const startCreate = () => {
    setDraftName("");
    setCreating(true);
  };

  const confirmCreate = () => {
    onCreate(draftName.trim() || DEFAULT_NAME);
    setCreating(false);
    setDraftName("");
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="mm-root">
      <button
        type="button"
        className={`mm-folder${open ? " open" : ""}`}
        title="Macros"
        aria-label="Macros"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
      >
        <Workflow size={15} />
      </button>

      {open && (
        <div className="mm-menu">
          <div className="mm-head">
            Macros <span className="mm-count">{macros.length}</span>
          </div>
          {macros.length === 0 ? (
            <div className="mm-empty">No macros yet. Create one below.</div>
          ) : (
            macros.map((m) => {
              const sel = m.id === selectedId;
              return (
                <div key={m.id} className={`mm-row${sel ? " sel" : ""}`}>
                  <button type="button" className="mm-pick" onClick={() => pick(m.id)}>
                    <div className="mm-name">{m.name}</div>
                    <div className="mm-meta">
                      {m.nodes.length} node{m.nodes.length === 1 ? "" : "s"}
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`mm-del${confirmDeleteId === m.id ? " armed" : ""}`}
                    title={confirmDeleteId === m.id ? "Click again to delete" : "Delete macro"}
                    aria-label="Delete macro"
                    onClick={() => onDeleteClick(m.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })
          )}
          <div className="mm-create">
            {creating ? (
              <div className="mm-create-row">
                <input
                  aria-label="Macro name"
                  className="mm-input"
                  value={draftName}
                  placeholder={DEFAULT_NAME}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmCreate();
                    else if (e.key === "Escape") setCreating(false);
                  }}
                />
                <button type="button" className="mm-confirm" onClick={confirmCreate}>
                  Create
                </button>
              </div>
            ) : (
              <button type="button" className="mm-new" onClick={startCreate}>
                <Plus size={14} />
                New macro
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
