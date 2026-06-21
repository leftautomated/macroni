import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useProjectDoc } from '../../hooks/useProjectDoc'
import { BackgroundPicker } from './BackgroundPicker'
import { FramingControls } from './FramingControls'
import { ExportButton } from './ExportButton'

// Inline type so this file is self-contained even if project.ts doesn't export it.
type Recording = { id: string; video?: string | null }

function holeRectPhysical(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  return {
    x: r.left * dpr,
    y: r.top * dpr,
    w: r.width * dpr,
    h: r.height * dpr,
  }
}

export function StudioEditor() {
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [noRecordings, setNoRecordings] = useState(false)
  const holeRef = useRef<HTMLDivElement>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewOpenedRef = useRef(false)

  const { doc, updateFraming } = useProjectDoc(recordingId)

  // Resolve recordingId on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('id')
    if (id) {
      setRecordingId(id)
      return
    }
    // No ?id= → pick most recent recording that has a video
    invoke<Recording[]>('load_recordings')
      .then((recordings) => {
        const withVideo = recordings.filter((r) => r.video)
        if (withVideo.length === 0) {
          setNoRecordings(true)
          return
        }
        // load_recordings returns recordings sorted newest-first (or not); pick last by id (timestamp)
        const sorted = [...withVideo].sort((a, b) => (b.id > a.id ? 1 : -1))
        setRecordingId(sorted[0].id)
      })
      .catch((e) => {
        console.error('load_recordings failed', e)
        setNoRecordings(true)
      })
  }, [])

  // Open preview once we have both recordingId and the hole in the DOM
  useEffect(() => {
    if (!recordingId || previewOpenedRef.current) return
    const el = holeRef.current
    if (!el) return
    previewOpenedRef.current = true
    const rect = holeRectPhysical(el)
    invoke('studio_open_preview', { recordingId, ...rect }).catch((e) =>
      console.error('studio_open_preview failed', e),
    )
  }, [recordingId])

  // Re-attach surface + re-render on resize (debounced 100ms)
  const handleResize = useCallback(() => {
    const el = holeRef.current
    if (!el || !recordingId) return
    if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current)
    resizeTimerRef.current = setTimeout(() => {
      const rect = holeRectPhysical(el)
      invoke('studio_attach_surface', rect).catch((e) =>
        console.error('studio_attach_surface failed', e),
      )
      if (doc) {
        invoke('studio_render_preview', { doc, frameIndex: 0 }).catch((e) =>
          console.error('studio_render_preview failed', e),
        )
      }
    }, 100)
  }, [recordingId, doc])

  useEffect(() => {
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current)
    }
  }, [handleResize])

  if (noRecordings) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          color: 'rgba(255,255,255,0.5)',
          fontSize: 14,
        }}
      >
        No recordings found. Record something first.
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        display: 'flex',
        fontFamily: 'system-ui, sans-serif',
        color: '#e5e7eb',
      }}
    >
      {/* Left control panel */}
      <div
        style={{
          width: 240,
          flexShrink: 0,
          height: '100%',
          overflowY: 'auto',
          padding: '16px 12px',
          background: 'rgba(15,15,20,0.92)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          boxSizing: 'border-box',
        }}
      >
        {doc === null ? (
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <BackgroundPicker doc={doc} onChange={updateFraming} />
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
            <FramingControls doc={doc} onChange={updateFraming} />
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
            <ExportButton recordingId={recordingId} />
          </>
        )}
      </div>

      {/* Centered preview hole — 70% of remaining width, 16:9 aspect ratio */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          ref={holeRef}
          id="preview-hole"
          style={{
            width: '70%',
            aspectRatio: '16 / 9',
            background: 'transparent',
            boxSizing: 'border-box',
          }}
        />
      </div>
    </div>
  )
}
