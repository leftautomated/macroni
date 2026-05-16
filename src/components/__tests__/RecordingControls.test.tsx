import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecordingControls } from "../RecordingControls";

describe("RecordingControls", () => {
  it("shows the Start button when not recording and calls onStartRecording on click", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    render(
      <RecordingControls isRecording={false} onStartRecording={onStart} onStopRecording={onStop} />,
    );

    const startButton = screen.getByRole("button", { name: /start/i });
    expect(startButton).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();

    await userEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("shows the Recording indicator + Stop button when recording, and calls onStopRecording on click", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    render(
      <RecordingControls isRecording={true} onStartRecording={onStart} onStopRecording={onStop} />,
    );

    expect(screen.getByText(/recording/i)).toBeInTheDocument();
    const stopButton = screen.getByRole("button", { name: /stop/i });
    expect(stopButton).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^start$/i })).not.toBeInTheDocument();

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
});
