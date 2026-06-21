import React from 'react'
import ReactDOM from 'react-dom/client'
import { StudioEditor } from '@/components/studio/StudioEditor'

// Reset default margins and forbid document scroll so the transparent hole
// stays at a fixed viewport position (the native surface is positioned in
// window coords and does not follow scroll).
for (const el of [document.documentElement, document.body]) {
  el.style.margin = '0'
  el.style.height = '100%'
  el.style.overflow = 'hidden'
  el.style.background = 'transparent'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StudioEditor />
  </React.StrictMode>,
)
