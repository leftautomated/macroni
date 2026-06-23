import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: /step back/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /step forward/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fullscreen/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /replay macro/i }));
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it("cycles playback speed on click", async () => {
    render(<StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={noop} />);
    expect(screen.getByText("1×")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1×" }));
    expect(screen.getByText("1.5×")).toBeInTheDocument();
  });
});
