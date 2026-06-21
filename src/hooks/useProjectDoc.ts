import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { type Framing, type ProjectDoc } from '../types/project'

const DEBOUNCE_MS = 60

export function useProjectDoc(recordingId: string | null): {
  doc: ProjectDoc | null
  updateFraming: (partial: Partial<Framing>) => void
} {
  const [doc, setDoc] = useState<ProjectDoc | null>(null)
  const docRef = useRef<ProjectDoc | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fix #3: reset docRef before loading to avoid stale-doc writes when recordingId changes A→B
  useEffect(() => {
    if (!recordingId) {
      setDoc(null)
      docRef.current = null
      return
    }
    // Clear stale doc immediately so updateFraming no-ops while the new doc loads
    setDoc(null)
    docRef.current = null

    let cancelled = false
    invoke<ProjectDoc>('studio_load_project', { recordingId }).then((loaded) => {
      if (!cancelled) {
        setDoc(loaded)
        docRef.current = loaded
      }
    })
    return () => {
      cancelled = true
    }
  }, [recordingId])

  // Fix #2: clear debounce timer on unmount to prevent post-teardown invocations
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
  }, [])

  const updateFraming = useCallback(
    (partial: Partial<Framing>) => {
      if (!recordingId) return
      const current = docRef.current
      if (!current) return

      const nextDoc: ProjectDoc = {
        ...current,
        framing: { ...current.framing, ...partial },
      }
      setDoc(nextDoc)
      docRef.current = nextDoc

      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
      timerRef.current = setTimeout(() => {
        const latest = docRef.current
        if (!latest) return
        void Promise.all([
          invoke('studio_save_project', { recordingId, doc: latest }),
          invoke('studio_render_preview', { doc: latest, frameIndex: 0 }),
        ])
      }, DEBOUNCE_MS)
    },
    [recordingId],
  )

  return { doc, updateFraming }
}
