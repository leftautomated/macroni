import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Recording } from '@/types'
import { useVideoAssetUrl } from '@/hooks/useVideoAssetUrl'

// Simplest studio: list recordings and play the selected one. Effects
// (background/framing/zoom) come later, one quality-checked feature at a time.

function formatWhen(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function StudioEditor() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const recs = await invoke<Recording[]>('load_recordings')
      // Only video recordings are playable here; newest first (id = ms timestamp).
      const withVideo = recs
        .filter((r) => r.video)
        .sort((a, b) => (b.id > a.id ? 1 : -1))
      setRecordings(withVideo)
      setSelectedId((prev) =>
        prev && withVideo.some((r) => r.id === prev) ? prev : (withVideo[0]?.id ?? null),
      )
    } catch (e) {
      console.error('load_recordings failed', e)
    } finally {
      setLoaded(true)
    }
  }, [])

  // Load on mount, and refresh whenever the window regains focus so a recording
  // made in the main window shows up without a restart.
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const selected = useMemo(
    () => recordings.find((r) => r.id === selectedId) ?? null,
    [recordings, selectedId],
  )
  const { url } = useVideoAssetUrl(selected?.video)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        display: 'flex',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#e5e7eb',
        background: '#0f0f14',
      }}
    >
      {/* Recordings list */}
      <div
        style={{
          width: 260,
          flexShrink: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(20,20,28,0.96)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 14px 10px',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}>RECORDINGS</span>
          <button
            type="button"
            onClick={() => void load()}
            title="Refresh"
            style={{
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'transparent',
              color: '#cbd5e1',
              borderRadius: 6,
              padding: '2px 8px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
          {loaded && recordings.length === 0 && (
            <div style={{ padding: 14, fontSize: 13, color: 'rgba(255,255,255,0.45)' }}>
              No recordings yet. Record one in the main window, then come back.
            </div>
          )}
          {recordings.map((r) => {
            const isSel = r.id === selectedId
            return (
              <button
                type="button"
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: '1px solid',
                  borderColor: isSel ? '#6366f1' : 'transparent',
                  background: isSel ? 'rgba(99,102,241,0.18)' : 'transparent',
                  color: 'inherit',
                  borderRadius: 8,
                  padding: '10px 12px',
                  marginBottom: 4,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                  {r.name && r.name !== 'Untitled' ? r.name : formatWhen(r.created_at)}
                </div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                  {r.video ? formatDuration(r.video.duration_ms) : '—'} · {r.events.length} actions
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Player */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          boxSizing: 'border-box',
        }}
      >
        {selected && url ? (
          <video
            key={selected.id}
            src={url}
            controls
            autoPlay
            loop
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              borderRadius: 8,
              boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
              background: '#000',
            }}
          />
        ) : (
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>
            {loaded ? 'Select a recording to play.' : 'Loading…'}
          </div>
        )}
      </div>
    </div>
  )
}
