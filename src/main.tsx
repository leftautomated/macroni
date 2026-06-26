import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/theme-provider";
import { initObservability, logEvent } from "@/lib/observability";
import "./index.css";

initObservability("main");

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
      windowLabel: "main",
    },
  });
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <React.Profiler id="main" onRender={onRender}>
      <ThemeProvider defaultTheme="system" storageKey="macroni-ui-theme">
        <App />
      </ThemeProvider>
    </React.Profiler>
  </React.StrictMode>,
);
