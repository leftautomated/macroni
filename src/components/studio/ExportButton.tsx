import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

interface Props {
  recordingId: string | null
}

export function ExportButton({ recordingId }: Props) {
  const [progress, setProgress] = useState<number | null>(null)
  const [outputPath, setOutputPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []

    const setup = async () => {
      const ulProgress = await listen<number>('studio-export-progress', (e) => {
        setProgress(e.payload * 100)
      })
      unlisteners.push(ulProgress)

      const ulDone = await listen<string>('studio-export-done', (e) => {
        setProgress(100)
        setOutputPath(e.payload)
      })
      unlisteners.push(ulDone)

      const ulError = await listen<string>('studio-export-error', (e) => {
        setError(e.payload)
        setProgress(null)
      })
      unlisteners.push(ulError)
    }

    void setup()

    return () => {
      for (const ul of unlisteners) ul()
    }
  }, [])

  async function handleExport() {
    if (!recordingId) return
    setProgress(0)
    setOutputPath(null)
    setError(null)
    try {
      await invoke('studio_export', { recordingId })
    } catch (e) {
      setError(String(e))
      setProgress(null)
    }
  }

  const isExporting = progress !== null && progress < 100

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        type="button"
        disabled={!recordingId || isExporting}
        onClick={() => void handleExport()}
        style={{
          padding: '8px 16px',
          borderRadius: 8,
          border: 'none',
          background: isExporting ? 'rgba(79,70,229,0.5)' : '#4f46e5',
          color: '#fff',
          cursor: !recordingId || isExporting ? 'not-allowed' : 'pointer',
          fontSize: 14,
          fontWeight: 600,
          opacity: !recordingId ? 0.5 : 1,
        }}
      >
        {isExporting ? 'Exporting…' : 'Export MP4'}
      </button>

      {/* Progress bar */}
      {progress !== null && (
        <div style={{ position: 'relative', height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
          <div
            style={{
              position: 'absolute',
              inset: '0 auto 0 0',
              width: `${Math.min(progress, 100)}%`,
              background: '#4f46e5',
              borderRadius: 3,
              transition: 'width 0.1s ease',
            }}
          />
        </div>
      )}
      {progress !== null && (
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
          {Math.round(Math.min(progress, 100))}%
        </span>
      )}

      {/* Output path */}
      {outputPath && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#34d399' }}>Export complete</span>
          <span
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.5)',
              wordBreak: 'break-all',
              fontFamily: 'monospace',
            }}
          >
            {outputPath}
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <span style={{ fontSize: 11, color: '#f87171', wordBreak: 'break-all' }}>
          Error: {error}
        </span>
      )}
    </div>
  )
}
