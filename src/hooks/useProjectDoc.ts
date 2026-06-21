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

  // Keep ref in sync so the debounce callback always sees the latest doc.
  useEffect(() => {
    docRef.current = doc
  }, [doc])

  useEffect(() => {
    if (!recordingId) {
      setDoc(null)
      return
    }
    let cancelled = false
    invoke<ProjectDoc>('studio_load_project', { recordingId }).then((loaded) => {
      if (!cancelled) {
        setDoc(loaded)
      }
    })
    return () => {
      cancelled = true
    }
  }, [recordingId])

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
        invoke('studio_save_project', { recordingId, doc: latest })
        invoke('studio_render_preview', { doc: latest, frameIndex: 0 })
      }, DEBOUNCE_MS)
    },
    [recordingId],
  )

  return { doc, updateFraming }
}
