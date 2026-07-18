import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface StudioTitleBarProps {
  /** Centered label — the active recording's name, or a fallback. */
  title: string;
  /** Content rendered just right of the traffic lights (e.g. the recordings menu). */
  left?: ReactNode;
  /** Content pinned to the far right of the bar (e.g. the settings gear). */
  right?: ReactNode;
  /** When true, clicking the title lets the user rename it inline. */
  editable?: boolean;
  /** Commit a renamed title (trimmed, non-empty, changed). */
  onTitleChange?: (next: string) => void;
}

/**
 * Fully custom title bar for the borderless Studio window. Hand-drawn traffic
 * lights (close / minimize / expand) stand in for the native ones so the whole
 * strip can be themed: the glyphs reveal on hover, the lights dim grey when the
 * window is inactive, and the bar itself is a drag region. Green is a `+`
 * (zoom) rather than the native fullscreen arrows — a smooth in-window
 * fullscreen can replace plain maximize later.
 */
export function StudioTitleBar({
  title,
  left,
  right,
  editable,
  onTitleChange,
}: StudioTitleBarProps) {
  const win = useMemo(() => getCurrentWindow(), []);
  const [focused, setFocused] = useState(true);
  // Reveal the glyphs while hovering the cluster. Driven by JS pointer events,
  // not CSS :hover — WKWebView frequently fails to clear :hover when the pointer
  // leaves (especially next to a drag region), leaving the - and + glyphs stuck.
  const [lightsHover, setLightsHover] = useState(false);
  // Inline title rename.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Leaving edit mode whenever the active title changes (rename committed, or a
  // different recording was selected) keeps the input from showing a stale name.
  useEffect(() => {
    setEditing(false);
  }, [title]);

  // Focus + select the text the moment edit mode opens, so the user can just type.
  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      el?.focus();
      el?.select();
    }
  }, [editing]);

  const endedRef = useRef(false);
  const startEdit = () => {
    if (!editable) return;
    setDraft(title);
    endedRef.current = false;
    setEditing(true);
  };
  // Guarded so Enter/Escape (which unmount the input and may also fire onBlur)
  // finalize the edit exactly once.
  const endEdit = (commit: boolean) => {
    if (endedRef.current) return;
    endedRef.current = true;
    setEditing(false);
    if (commit) {
      const next = draft.trim();
      if (next && next !== title) onTitleChange?.(next);
    }
  };

  // Dim the lights when the window loses focus, like native macOS. DOM
  // focus/blur tracks the webview window and needs no extra Tauri permission.
  useEffect(() => {
    setFocused(document.hasFocus());
    const onFocus = () => setFocused(true);
    const onBlur = () => {
      setFocused(false);
      // Clear any stuck hover if the pointer left via window blur.
      setLightsHover(false);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      className={`studio-titlebar${focused ? "" : " inactive"}`}
      // Note: Tauri's drag-region script already toggles maximize on a
      // double-click of this element — adding our own here would toggle twice.
    >
      <style>{`
        .studio-titlebar {
          position: relative;
          /* Above the content row so the recordings dropdown isn't covered. */
          z-index: 20;
          flex-shrink: 0;
          height: 40px;
          display: flex;
          align-items: center;
          padding: 0 14px;
          background: var(--studio-surface);
          border-bottom: 1px solid var(--studio-border);
          user-select: none;
        }
        .tl-lights { display: flex; align-items: center; gap: 8px; }
        .tl-left { display: flex; align-items: center; margin-left: 8px; }
        .tl-right { display: flex; align-items: center; gap: 4px; margin-left: auto; }
        .tl-light {
          position: relative;
          flex: 0 0 12px;
          box-sizing: border-box;
          width: 12px; height: 12px; padding: 0;
          border: 1px solid transparent; border-radius: 50%;
          appearance: none; -webkit-appearance: none;
          display: block;
          line-height: 0;
          cursor: pointer;
          box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.18);
        }
        .tl-close { background: #ff5f57; }
        .tl-min { background: #febc2e; }
        .tl-zoom { background: #28c840; }
        /* Glyphs are mounted only while hovering (see JSX), so leaving removes
           them from the DOM and forces a repaint — WKWebView otherwise ghosts
           the axis-aligned - and + strokes when fading opacity back to 0. */
        .tl-glyph {
          position: absolute;
          inset: 1px;
          display: block;
          width: 10px;
          height: 10px;
          pointer-events: none;
          animation: tl-glyph-in 100ms ease;
        }
        .tl-glyph path { stroke: rgba(0,0,0,0.55); stroke-width: 1.3; stroke-linecap: round; fill: none; }
        @keyframes tl-glyph-in { from { opacity: 0; } to { opacity: 1; } }
        .studio-titlebar.inactive .tl-light { background: #4a4a4f; box-shadow: none; }
        .studio-title {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          max-width: 58%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          color: var(--studio-text-strong);
          border: 1px solid transparent;
          background: transparent;
          pointer-events: none;
        }
        .studio-title.editable {
          pointer-events: auto;
          cursor: text;
          border-radius: 5px;
          padding: 2px 8px;
          transition: background 120ms ease;
        }
        .studio-title.editable:hover { background: var(--studio-hover); color: var(--studio-text); }
        .studio-title-input {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          width: 280px;
          max-width: 58%;
          text-align: center;
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          color: var(--studio-text);
          background: var(--studio-hover);
          border: 1px solid var(--studio-accent-border);
          border-radius: 5px;
          padding: 2px 8px;
          outline: none;
        }
        .studio-titlebar.inactive .studio-title { color: var(--studio-text-subtle); }
      `}</style>

      {/* stopPropagation so double-clicking a light doesn't also zoom the bar */}
      <div
        className="tl-lights"
        onPointerEnter={() => setLightsHover(true)}
        onPointerLeave={() => setLightsHover(false)}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="tl-light tl-close"
          aria-label="Close window"
          onClick={() => void win.close()}
        >
          {lightsHover && (
            <svg className="tl-glyph" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3 3l4 4M7 3l-4 4" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="tl-light tl-min"
          aria-label="Minimize window"
          onClick={() => void win.minimize()}
        >
          {lightsHover && (
            <svg className="tl-glyph" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3 5h4" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="tl-light tl-zoom"
          aria-label="Expand window"
          // Maximize only — no restore here (double-clicking the bar still
          // toggles, so that's the way back to a windowed size).
          onClick={() => void win.maximize()}
        >
          {lightsHover && (
            <svg className="tl-glyph" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 3v4M3 5h4" />
            </svg>
          )}
        </button>
      </div>

      {left && (
        <div className="tl-left" onDoubleClick={(e) => e.stopPropagation()}>
          {left}
        </div>
      )}

      {right && (
        <div className="tl-right" onDoubleClick={(e) => e.stopPropagation()}>
          {right}
        </div>
      )}

      {editing ? (
        <input
          ref={inputRef}
          className="studio-title-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => endEdit(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") endEdit(true);
            else if (e.key === "Escape") endEdit(false);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : editable ? (
        <button
          type="button"
          className="studio-title editable"
          title="Click to rename"
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {title}
        </button>
      ) : (
        <div className="studio-title">{title}</div>
      )}
    </div>
  );
}
