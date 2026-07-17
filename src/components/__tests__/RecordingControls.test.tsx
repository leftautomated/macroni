import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecordingControls } from "../RecordingControls";

describe("RecordingControls", () => {
  it("shows separate Record and Play buttons when idle", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onPlay = vi.fn();
    render(
      <RecordingControls
        canPlay
        isRecording={false}
        onStartPlayback={onPlay}
        onStartRecording={onStart}
        onStopRecording={onStop}
      />,
    );

    const recordButton = screen.getByRole("button", { name: "Record macro" });
    const playButton = screen.getByRole("button", { name: "Play current macro" });
    expect(recordButton).toBeInTheDocument();
    expect(playButton).toBeEnabled();

    await userEvent.click(recordButton);
    expect(onStart).toHaveBeenCalledTimes(1);
    await userEvent.click(playButton);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("turns Record into Stop while recording and disables Play", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    render(
      <RecordingControls canPlay isRecording onStartRecording={onStart} onStopRecording={onStop} />,
    );

    const stopButton = screen.getByRole("button", { name: "Stop recording" });
    expect(stopButton).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play current macro" })).toBeDisabled();

    await userEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("does not invoke either handler at mount", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    render(
      <RecordingControls isRecording={false} onStartRecording={onStart} onStopRecording={onStop} />,
    );
    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("disables Play until a recording is available", () => {
    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={vi.fn()}
        onStopRecording={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Play current macro" })).toBeDisabled();
  });

  it("turns Play into Stop while playing and disables Record", async () => {
    const onStopPlayback = vi.fn();
    render(
      <RecordingControls
        canPlay
        isPlaying
        isRecording={false}
        onStartRecording={vi.fn()}
        onStopPlayback={onStopPlayback}
        onStopRecording={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Record macro" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Stop playing macro" }));
    expect(onStopPlayback).toHaveBeenCalledTimes(1);
  });
});
