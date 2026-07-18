import React from "react";
import ReactDOM from "react-dom/client";
import { StudioEditor } from "@/components/studio/StudioEditor";
import { ThemeProvider } from "@/components/theme-provider";
import { initObservability, logEvent } from "@/lib/observability";
import "../index.css";

initObservability("studio");

const onRender: React.ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  if (actualDuration < 16) return;
  logEvent("warn", "react.profiler", "slow_render", {
    fields: {
      id,
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
      windowLabel: "studio",
    },
  });
};

// Reset default margins and forbid document scroll. The window is borderless +
// transparent so its rounded corners show through; the StudioEditor root paints
// the active themed surface, so html/body stay transparent.
for (const el of [document.documentElement, document.body]) {
  el.style.margin = "0";
  el.style.height = "100%";
  el.style.overflow = "hidden";
  el.style.background = "transparent";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="macroni-ui-theme">
      <React.Profiler id="studio" onRender={onRender}>
        <StudioEditor />
      </React.Profiler>
    </ThemeProvider>
  </React.StrictMode>,
);
