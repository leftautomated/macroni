import React from "react";
import ReactDOM from "react-dom/client";
import { StudioEditor } from "@/components/studio/StudioEditor";
import { initObservability, logEvent } from "@/lib/observability";

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

// Reset default margins and forbid document scroll. The studio is an opaque
// player now (HTML5 <video>), so the window/body are dark, not transparent.
for (const el of [document.documentElement, document.body]) {
  el.style.margin = "0";
  el.style.height = "100%";
  el.style.overflow = "hidden";
  el.style.background = "#0f0f14";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Profiler id="studio" onRender={onRender}>
      <StudioEditor />
    </React.Profiler>
  </React.StrictMode>,
);
