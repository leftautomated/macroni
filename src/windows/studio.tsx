import React from 'react'
import ReactDOM from 'react-dom/client'
import { StudioEditor } from '@/components/studio/StudioEditor'

// Reset default margins and forbid document scroll. The studio is an opaque
// player now (HTML5 <video>), so the window/body are dark, not transparent.
for (const el of [document.documentElement, document.body]) {
  el.style.margin = '0'
  el.style.height = '100%'
  el.style.overflow = 'hidden'
  el.style.background = '#0f0f14'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StudioEditor />
  </React.StrictMode>,
)
