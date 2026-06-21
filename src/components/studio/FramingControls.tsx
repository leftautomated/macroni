import { type Framing, type ProjectDoc } from '../../types/project'

interface Props {
  doc: ProjectDoc
  onChange: (p: Partial<Framing>) => void
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onValue: (v: number) => void
  display?: string
}

function Slider({ label, value, min, max, step = 1, onValue, display }: SliderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', minWidth: 100 }}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(e) => onValue(Number((e.target as HTMLInputElement).value))}
        style={{ flex: 1 }}
      />
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', minWidth: 36, textAlign: 'right' }}>
        {display ?? String(Math.round(value))}
      </span>
    </div>
  )
}

export function FramingControls({ doc, onChange }: Props) {
  const f = doc.framing

  const paddingPx = f.paddingPx
  const borderRadiusPx = f.borderRadiusPx
  const blurPx = f.shadow.blurPx
  const offsetYPx = f.shadow.offsetYPx
  const opacity = f.shadow.opacity

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Framing
      </span>

      <Slider
        label="Padding"
        value={paddingPx}
        min={0}
        max={200}
        onValue={(v) => onChange({ paddingPx: v })}
        display={`${Math.round(paddingPx)}px`}
      />

      <Slider
        label="Corner radius"
        value={borderRadiusPx}
        min={0}
        max={80}
        onValue={(v) => onChange({ borderRadiusPx: v })}
        display={`${Math.round(borderRadiusPx)}px`}
      />

      <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>
        Shadow
      </span>

      <Slider
        label="Blur"
        value={blurPx}
        min={0}
        max={80}
        onValue={(v) =>
          onChange({ shadow: { ...doc.framing.shadow, blurPx: v } })
        }
        display={`${Math.round(blurPx)}px`}
      />

      <Slider
        label="Offset Y"
        value={offsetYPx}
        min={0}
        max={60}
        onValue={(v) =>
          onChange({ shadow: { ...doc.framing.shadow, offsetYPx: v } })
        }
        display={`${Math.round(offsetYPx)}px`}
      />

      <Slider
        label="Opacity"
        value={opacity}
        min={0}
        max={1}
        step={0.05}
        onValue={(v) =>
          onChange({ shadow: { ...doc.framing.shadow, opacity: v } })
        }
        display={opacity.toFixed(2)}
      />
    </div>
  )
}
