import { useState } from 'react'
import { type Background, type Framing, type ProjectDoc, type Rgba } from '../../types/project'

function hexToRgba(hex: string): Rgba {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255,
  ]
}

function rgbaToHex(rgba: Rgba): string {
  return '#' + [rgba[0], rgba[1], rgba[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
}

type BgType = 'solid' | 'linear_gradient' | 'wallpaper'

interface Props {
  doc: ProjectDoc | null
  onChange: (p: Partial<Framing>) => void
}

export function BackgroundPicker({ doc, onChange }: Props) {
  const bg = doc?.framing.background

  // Derive current tab from the doc bg type, default to 'solid'
  const currentType: BgType = bg?.type ?? 'solid'

  // Local state for the tab selector (in case doc is null during init)
  const [tab, setTab] = useState<BgType>(currentType)

  // Use doc's values when available, otherwise sensible defaults
  const solidColor: Rgba =
    bg?.type === 'solid' ? bg.color : [30, 30, 30, 255]

  const gradFrom: Rgba =
    bg?.type === 'linear_gradient' ? bg.from : [0, 0, 0, 255]
  const gradTo: Rgba =
    bg?.type === 'linear_gradient' ? bg.to : [255, 255, 255, 255]
  const gradAngle: number =
    bg?.type === 'linear_gradient' ? bg.angleDeg : 135

  const wallpaperPath: string = bg?.type === 'wallpaper' ? bg.path : ''

  // Keep tab in sync with doc (when doc loads after mount)
  const effectiveTab = doc ? currentType : tab

  function emitBackground(background: Background) {
    onChange({ background })
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    background: active ? '#4f46e5' : 'rgba(255,255,255,0.08)',
    color: active ? '#fff' : 'rgba(255,255,255,0.7)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Background
      </span>

      {/* Tab row */}
      <div style={{ display: 'flex', gap: 4 }}>
        {(['solid', 'linear_gradient', 'wallpaper'] as BgType[]).map((t) => (
          <button
            key={t}
            type="button"
            style={tabStyle(effectiveTab === t)}
            onClick={() => {
              setTab(t)
              if (t === 'solid') {
                emitBackground({ type: 'solid', color: solidColor })
              } else if (t === 'linear_gradient') {
                emitBackground({ type: 'linear_gradient', from: gradFrom, to: gradTo, angleDeg: gradAngle })
              } else {
                emitBackground({ type: 'wallpaper', path: wallpaperPath })
              }
            }}
          >
            {t === 'solid' ? 'Solid' : t === 'linear_gradient' ? 'Gradient' : 'Wallpaper'}
          </button>
        ))}
      </div>

      {/* Solid */}
      {effectiveTab === 'solid' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="color"
            value={rgbaToHex(solidColor)}
            onChange={(e) => {
              emitBackground({ type: 'solid', color: hexToRgba(e.target.value) })
            }}
            style={{ width: 36, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
          />
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{rgbaToHex(solidColor)}</span>
        </div>
      )}

      {/* Linear gradient */}
      {effectiveTab === 'linear_gradient' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', minWidth: 32 }}>From</label>
            <input
              type="color"
              value={rgbaToHex(gradFrom)}
              onChange={(e) => {
                emitBackground({ type: 'linear_gradient', from: hexToRgba(e.target.value), to: gradTo, angleDeg: gradAngle })
              }}
              style={{ width: 36, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', minWidth: 32 }}>To</label>
            <input
              type="color"
              value={rgbaToHex(gradTo)}
              onChange={(e) => {
                emitBackground({ type: 'linear_gradient', from: gradFrom, to: hexToRgba(e.target.value), angleDeg: gradAngle })
              }}
              style={{ width: 36, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', minWidth: 32 }}>Angle</label>
            <input
              type="range"
              min={0}
              max={360}
              step={1}
              value={gradAngle}
              onInput={(e) => {
                emitBackground({ type: 'linear_gradient', from: gradFrom, to: gradTo, angleDeg: Number((e.target as HTMLInputElement).value) })
              }}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', minWidth: 32 }}>{Math.round(gradAngle)}°</span>
          </div>
        </div>
      )}

      {/* Wallpaper */}
      {effectiveTab === 'wallpaper' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Image path</label>
          <input
            type="text"
            value={wallpaperPath}
            placeholder="/path/to/image.jpg"
            onChange={(e) => {
              emitBackground({ type: 'wallpaper', path: e.target.value })
            }}
            style={{
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(0,0,0,0.3)',
              color: '#e5e7eb',
              fontSize: 12,
              outline: 'none',
            }}
          />
        </div>
      )}
    </div>
  )
}
