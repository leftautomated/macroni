import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StudioPlayer } from "./StudioPlayer";

const noop = () => {};

describe("StudioPlayer", () => {
  it("renders the custom controls and fires onReplay", async () => {
    const onReplay = vi.fn();
    render(
      <StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={onReplay} />,
    );

    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /jump to start/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /jump to end/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /replay macro/i }));
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it("changes playback speed via the slider", () => {
    render(<StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={noop} />);
    expect(screen.getByText("1×")).toBeInTheDocument();
    const slider = screen.getByRole("slider", { name: /playback speed/i });
    fireEvent.change(slider, { target: { value: "1.5" } });
    expect(screen.getByText("1.5×")).toBeInTheDocument();
  });
});
