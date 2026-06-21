import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// Phase 0 spike (Task 5) — THROWAWAY discovery UI.
//
// Renders a full-window layout containing a transparent, clearly-bordered
// "hole" div. Clicking "Show surface" (and any window resize) reads the hole's
// on-screen rect in CSS pixels, multiplies by devicePixelRatio to get PHYSICAL
// pixels, and asks Rust to position a native wgpu/Metal surface behind it.
//
// The whole point is to SEE the native solid color through the transparent
// hole, aligned to the bordered box. Visual verification is the human's job.
export function StudioSpike() {
  const holeRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<string>('idle')
  const [shown, setShown] = useState(false)

  const showSurface = useCallback(async () => {
    const el = holeRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    // Physical pixels (top-left origin, as the webview sees them). Rust converts
    // to AppKit's bottom-left point coordinates.
    const payload = {
      x: r.left * dpr,
      y: r.top * dpr,
      w: r.width * dpr,
      h: r.height * dpr,
    }
    try {
      await invoke('spike_show_surface', payload)
      setShown(true)
      setStatus(
        `surface @ x=${payload.x.toFixed(0)} y=${payload.y.toFixed(0)} ` +
          `w=${payload.w.toFixed(0)} h=${payload.h.toFixed(0)} (dpr=${dpr})`,
      )
    } catch (e) {
      setStatus(`error: ${String(e)}`)
    }
  }, [])

  // Keep the surface aligned to the hole on resize, but only after it's been
  // shown once (so we don't create the surface before the user opts in).
  useEffect(() => {
    if (!shown) return
    const onResize = () => {
      void showSurface()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [shown, showSurface])

  return (
    <div
      style={{
        // Pin to the viewport and forbid scrolling: an editor preview is a
        // fixed region. If the document could scroll, the hole div would move
        // while the native surface (positioned in window coords) stayed put.
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        // Transparent so the native layer can show through the hole. A faint
        // tint on the chrome (NOT the hole) helps the human see the webview vs.
        // the native surface boundary.
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        fontFamily: 'system-ui, sans-serif',
        color: '#e5e7eb',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          borderRadius: 8,
          background: 'rgba(30,30,40,0.85)',
        }}
      >
        <button
          type="button"
          onClick={() => void showSurface()}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid #6366f1',
            background: '#4f46e5',
            color: 'white',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          Show surface
        </button>
        <span style={{ fontSize: 12, opacity: 0.8 }}>{status}</span>
      </div>

      {/* The transparent hole. The native Metal surface should appear here. */}
      <div
        ref={holeRef}
        id="preview-hole"
        style={{
          width: 800,
          height: 450,
          background: 'transparent',
          // Bright dashed border so the human can compare the native surface
          // edges against the div edges.
          border: '3px dashed #f43f5e',
          borderRadius: 4,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 13, opacity: 0.6, pointerEvents: 'none' }}>
          native surface should fill this box
        </span>
      </div>
    </div>
  )
}
