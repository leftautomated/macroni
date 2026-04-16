import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { ThemeProvider } from "@/components/theme-provider";

const Playback = () => {
  const params = new URLSearchParams(window.location.search);
  const recordingId = params.get("id") ?? "";
  return (
    <ThemeProvider>
      <div className="w-screen h-screen flex items-center justify-center bg-background text-foreground">
        <p>Playback window — recording id: {recordingId}</p>
      </div>
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Playback />
  </React.StrictMode>,
);
