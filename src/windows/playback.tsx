import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { ThemeProvider } from "@/components/theme-provider";
import { PlaybackView } from "@/components/playback/PlaybackView";

const Playback = () => {
  const params = new URLSearchParams(window.location.search);
  const recordingId = params.get("id") ?? "";
  return (
    <ThemeProvider>
      <PlaybackView recordingId={recordingId} />
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Playback />
  </React.StrictMode>,
);
