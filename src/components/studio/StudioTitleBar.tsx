import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface StudioTitleBarProps {
  /** Centered label — the active recording's name, or a fallback. */
  title: string;
}

/**
 * Fully custom title bar for the borderless Studio window. Hand-drawn traffic
 * lights (close / minimize / expand) stand in for the native ones so the whole
 * strip can be themed: the glyphs reveal on hover, the lights dim grey when the
 * window is inactive, and the bar itself is a drag region. Green is a `+`
 * (zoom) rather than the native fullscreen arrows — a smooth in-window
 * fullscreen can replace plain maximize later.
 */
export function StudioTitleBar({ title }: StudioTitleBarProps) {
  const win = useMemo(() => getCurrentWindow(), []);
  const [focused, setFocused] = useState(true);
  // Reveal the glyphs while hovering the cluster. Driven by JS pointer events,
  // not CSS :hover — WKWebView frequently fails to clear :hover when the pointer
  // leaves (especially next to a drag region), leaving the - and + glyphs stuck.
  const [lightsHover, setLightsHover] = useState(false);

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
      onDoubleClick={() => void win.toggleMaximize()}
    >
      <style>{`
        .studio-titlebar {
          position: relative;
          flex-shrink: 0;
          height: 40px;
          display: flex;
          align-items: center;
          padding: 0 14px;
          background: #16161d;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          user-select: none;
        }
        .tl-lights { display: flex; align-items: center; gap: 8px; }
        .tl-light {
          width: 12px; height: 12px; padding: 0;
          border: none; border-radius: 50%;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer;
          box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.18);
        }
        .tl-close { background: #ff5f57; }
        .tl-min { background: #febc2e; }
        .tl-zoom { background: #28c840; }
        /* Glyphs are mounted only while hovering (see JSX), so leaving removes
           them from the DOM and forces a repaint — WKWebView otherwise ghosts
           the axis-aligned - and + strokes when fading opacity back to 0. */
        .tl-glyph { width: 10px; height: 10px; animation: tl-glyph-in 100ms ease; }
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
          font-size: 13px;
          font-weight: 500;
          color: rgba(255,255,255,0.78);
          pointer-events: none;
        }
        .studio-titlebar.inactive .studio-title { color: rgba(255,255,255,0.4); }
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
          onClick={() => void win.toggleMaximize()}
        >
          {lightsHover && (
            <svg className="tl-glyph" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 3v4M3 5h4" />
            </svg>
          )}
        </button>
      </div>

      <div className="studio-title">{title}</div>
    </div>
  );
}
