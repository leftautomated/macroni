import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProjectDoc } from '../useProjectDoc'
import type { ProjectDoc } from '../../types/project'

// Mock @tauri-apps/api/core before importing the hook.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
const mockInvoke = vi.mocked(invoke)

const makeDoc = (): ProjectDoc => ({
  version: 1,
  media: { screenMp4: '/tmp/screen.mp4', webcamMp4: null, cursorJson: null },
  framing: {
    background: { type: 'solid', color: [30, 30, 30, 255] },
    paddingPx: 64,
    borderRadiusPx: 12,
    shadow: { blurPx: 32, offsetYPx: 16, opacity: 0.35 },
  },
  zoomRegions: [],
  trimRegions: [],
  speedRegions: [],
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useProjectDoc', () => {
  it('loads the project doc on mount', async () => {
    const doc = makeDoc()
    mockInvoke.mockResolvedValueOnce(doc)

    const { result } = renderHook(() => useProjectDoc('rec-1'))

    await waitFor(() => {
      expect(result.current.doc).toEqual(doc)
    })
    expect(mockInvoke).toHaveBeenCalledWith('studio_load_project', { recordingId: 'rec-1' })
  })

  it('updateFraming merges partial into framing.paddingPx', async () => {
    const doc = makeDoc()
    mockInvoke.mockResolvedValueOnce(doc)

    const { result } = renderHook(() => useProjectDoc('rec-1'))

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })

    act(() => {
      result.current.updateFraming({ paddingPx: 99 })
    })

    expect(result.current.doc?.framing.paddingPx).toBe(99)
    // Other framing fields remain intact.
    expect(result.current.doc?.framing.borderRadiusPx).toBe(12)
  })

  it('debounces save and render calls', async () => {
    // Use fake timers but still allow promise resolution.
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const doc = makeDoc()
    mockInvoke.mockResolvedValueOnce(doc)
    mockInvoke.mockResolvedValue(undefined)

    const { result } = renderHook(() => useProjectDoc('rec-1'))

    await waitFor(() => expect(result.current.doc).not.toBeNull())

    // Clear the load call so we can track subsequent calls.
    mockInvoke.mockClear()
    mockInvoke.mockResolvedValue(undefined)

    act(() => {
      result.current.updateFraming({ paddingPx: 10 })
      result.current.updateFraming({ paddingPx: 20 })
      result.current.updateFraming({ paddingPx: 99 })
    })

    // Not yet called — debounce timer not elapsed.
    expect(mockInvoke).not.toHaveBeenCalledWith('studio_save_project', expect.anything())

    act(() => {
      vi.runAllTimers()
    })

    // After timer fires, exactly one save and one render.
    const saveCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'studio_save_project')
    const renderCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'studio_render_preview')
    expect(saveCalls).toHaveLength(1)
    expect(renderCalls).toHaveLength(1)
    // Final paddingPx wins.
    expect((saveCalls[0][1] as { doc: ProjectDoc }).doc.framing.paddingPx).toBe(99)
  })

  it('returns null doc when recordingId is null', () => {
    const { result } = renderHook(() => useProjectDoc(null))
    expect(result.current.doc).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
