import React from 'react'
import ReactDOM from 'react-dom/client'
import { StudioSpike } from '@/components/studio/StudioSpike'

// Phase 0 spike (Task 5) entry point. THROWAWAY discovery code.
//
// This window proves whether a native wgpu/Metal surface can render UNDER a
// transparent region of the WKWebview, aligned to a React <div>. There is no
// ThemeProvider / app shell here on purpose — the body must be transparent so
// the native layer shows through the hole.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StudioSpike />
  </React.StrictMode>,
)
