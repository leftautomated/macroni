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
      <style>{`
        .mm-root { position: relative; display: flex; }
        .mm-folder {
          display: inline-flex; align-items: center; justify-content: center;
          width: 28px; height: 24px; padding: 0;
          border: none; border-radius: 6px; background: transparent;
          color: rgba(255,255,255,0.65); cursor: pointer;
          transition: background 120ms ease, color 120ms ease;
        }
        .mm-folder:hover, .mm-folder.open { background: rgba(255,255,255,0.1); color: #fff; }
        .mm-menu {
          position: absolute; top: calc(100% + 6px); left: 0; z-index: 100;
          width: 280px; max-height: 60vh; overflow-y: auto;
          background: #1c1c24; border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; box-shadow: 0 16px 40px rgba(0,0,0,0.5);
          padding: 6px;
        }
        .mm-head {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 8px 8px; font-size: 11px; font-weight: 600;
          letter-spacing: 0.4px; color: rgba(255,255,255,0.5);
        }
        .mm-count {
          font-weight: 600; color: rgba(255,255,255,0.4);
          background: rgba(255,255,255,0.08); border-radius: 999px; padding: 0 6px;
        }
        .mm-empty { padding: 10px 8px 12px; font-size: 12px; color: rgba(255,255,255,0.45); }
        .mm-row {
          display: flex; align-items: center; gap: 4px;
          border: 1px solid transparent; border-radius: 8px; padding-right: 6px;
          transition: background 120ms ease, border-color 120ms ease;
        }
        .mm-row:hover { background: rgba(255,255,255,0.05); }
        .mm-row.sel { border-color: #6366f1; background: rgba(99,102,241,0.18); }
        .mm-pick {
          flex: 1; min-width: 0; text-align: left;
          border: none; background: transparent; color: inherit;
          border-radius: 8px; padding: 8px 10px; cursor: pointer;
        }
        .mm-name {
          font-size: 13px; font-weight: 600; margin-bottom: 2px; color: #e5e7eb;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .mm-meta { font-size: 12px; color: rgba(255,255,255,0.5); }
        .mm-del {
          flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
          border: none; background: transparent; color: rgba(255,255,255,0.4);
          border-radius: 6px; padding: 4px; cursor: pointer; opacity: 0;
          transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
        }
        .mm-row:hover .mm-del, .mm-row.sel .mm-del { opacity: 1; }
        .mm-del:hover { color: #f87171; background: rgba(248,113,113,0.14); }
        .mm-del.armed { opacity: 1; color: #f87171; background: rgba(248,113,113,0.22); }
        .mm-create { padding: 6px 4px 2px; border-top: 1px solid rgba(255,255,255,0.08); margin-top: 4px; }
        .mm-new {
          display: flex; align-items: center; gap: 6px; width: 100%;
          border: none; background: transparent; color: rgba(255,255,255,0.7);
          border-radius: 8px; padding: 8px 10px; cursor: pointer; font-size: 12px; font-weight: 600;
        }
        .mm-new:hover { background: rgba(255,255,255,0.06); color: #fff; }
        .mm-create-row { display: flex; gap: 6px; padding: 4px; }
        .mm-input {
          flex: 1; min-width: 0; background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
          padding: 6px 8px; color: #e5e7eb; font-size: 12px;
        }
        .mm-input:focus { outline: none; border-color: #6366f1; }
        .mm-confirm {
          border: 1px solid rgba(99,102,241,0.5); background: rgba(99,102,241,0.28);
          color: #fff; border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 600;
          cursor: pointer;
        }
      `}</style>

      <button
        type="button"
        className={`mm-folder${open ? " open" : ""}`}
        title="Macros"
        aria-label="Macros"
        aria-expanded={open}
        onClick={toggle}
      >
        <Workflow size={15} />
      </button>

      {open && (
        <div className="mm-menu">
          <div className="mm-head">
            MACROS <span className="mm-count">{macros.length}</span>
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
