import { useEffect, useRef, useState } from "react";
import { Folder, Trash2 } from "lucide-react";
import { formatDuration, recordingTitle } from "@/lib/recording-format";
import type { Recording } from "@/types";

interface RecordingsMenuProps {
  recordings: Recording[];
  selectedId: string | null;
  /** Id armed for delete (first click); a second click confirms. */
  confirmDeleteId: string | null;
  onSelect: (id: string) => void;
  onDeleteClick: (id: string) => void;
  /** Called when the menu opens, so the list can refresh. */
  onOpen: () => void;
}

/**
 * Folder button in the title bar that drops down the recordings picker — the
 * single place to switch clips, replacing the old left-hand list nav. Selecting
 * loads the clip and closes; the same two-click delete lives on each row.
 */
export function RecordingsMenu({
  recordings,
  selectedId,
  confirmDeleteId,
  onSelect,
  onDeleteClick,
  onOpen,
}: RecordingsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on a click anywhere outside the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const toggle = () => {
    setOpen((wasOpen) => {
      if (!wasOpen) onOpen();
      return !wasOpen;
    });
  };

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="rm-root">
      <style>{`
        .rm-root { position: relative; display: flex; }
        .rm-folder {
          display: inline-flex; align-items: center; justify-content: center;
          width: 28px; height: 24px; padding: 0;
          border: none; border-radius: 6px; background: transparent;
          color: var(--studio-text-muted); cursor: pointer;
          transition: background 120ms ease, color 120ms ease;
        }
        .rm-folder:hover, .rm-folder.open { background: rgba(240,205,120,0.14); color: #f0cd78; }
        .rm-menu {
          position: absolute; top: calc(100% + 6px); left: 0; z-index: 100;
          width: 280px; max-height: 60vh; overflow-y: auto;
          background: var(--studio-surface); border: 1px solid var(--studio-border);
          border-radius: 10px; box-shadow: 0 16px 40px rgba(0,0,0,0.5);
          padding: 6px;
        }
        .rm-head {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 8px 8px; font-size: 11px; font-weight: 600;
          letter-spacing: 0.4px; color: var(--studio-text-muted);
        }
        .rm-count {
          font-weight: 600; color: var(--studio-text-subtle);
          background: var(--studio-hover); border-radius: 999px; padding: 0 6px;
        }
        .rm-empty { padding: 10px 8px 12px; font-size: 12px; color: var(--studio-text-subtle); }
        .rm-row {
          display: flex; align-items: center; gap: 4px;
          border: 1px solid transparent; border-radius: 8px; padding-right: 6px;
          transition: background 120ms ease, border-color 120ms ease;
        }
        .rm-row:hover { background: var(--studio-hover); }
        .rm-row.sel { border-color: rgba(240,205,120,0.5); background: rgba(240,205,120,0.14); }
        .rm-pick {
          flex: 1; min-width: 0; text-align: left;
          border: none; background: transparent; color: inherit;
          border-radius: 8px; padding: 8px 10px; cursor: pointer;
        }
        .rm-name {
          font-size: 13px; font-weight: 600; margin-bottom: 2px; color: var(--studio-text);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .rm-meta { font-size: 12px; color: var(--studio-text-muted); }
        .rm-del {
          flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
          border: none; background: transparent; color: var(--studio-text-subtle);
          border-radius: 6px; padding: 4px; cursor: pointer; opacity: 0;
          transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
        }
        .rm-row:hover .rm-del, .rm-row.sel .rm-del { opacity: 1; }
        .rm-del:hover { color: #f87171; background: rgba(248,113,113,0.14); }
        .rm-del.armed { opacity: 1; color: #f87171; background: rgba(248,113,113,0.22); }
      `}</style>

      <button
        type="button"
        className={`rm-folder${open ? " open" : ""}`}
        title="Recordings"
        aria-label="Recordings"
        aria-expanded={open}
        onClick={toggle}
      >
        <Folder size={15} />
      </button>

      {open && (
        <div className="rm-menu">
          <div className="rm-head">
            RECORDINGS <span className="rm-count">{recordings.length}</span>
          </div>
          {recordings.length === 0 ? (
            <div className="rm-empty">No recordings yet. Record one in the main window.</div>
          ) : (
            recordings.map((r) => {
              const sel = r.id === selectedId;
              return (
                <div key={r.id} className={`rm-row${sel ? " sel" : ""}`}>
                  <button type="button" className="rm-pick" onClick={() => pick(r.id)}>
                    <div className="rm-name">{recordingTitle(r)}</div>
                    <div className="rm-meta">
                      {r.video ? formatDuration(r.video.duration_ms) : "No video"} ·{" "}
                      {r.events.length} actions
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`rm-del${confirmDeleteId === r.id ? " armed" : ""}`}
                    title={confirmDeleteId === r.id ? "Click again to delete" : "Delete recording"}
                    aria-label="Delete recording"
                    onClick={() => onDeleteClick(r.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
