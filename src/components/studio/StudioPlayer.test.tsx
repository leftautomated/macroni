import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StudioPlayer } from "./StudioPlayer";

const noop = () => {};

describe("StudioPlayer", () => {
  beforeEach(() => {
    // jsdom returns zeroed rects; give the interaction layer a fixed 100×50 box
    // at the origin so the normalized drag math is predictable, and stub
    // pointer capture (not implemented in jsdom) — same setup as
    // StudioTimeline.test.tsx.
    Element.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          right: 100,
          bottom: 50,
          width: 100,
          height: 50,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it("renders the custom controls and fires onReplay", async () => {
    const onReplay = vi.fn();
    render(
      <StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={onReplay} />,
    );

    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /jump to start/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /jump to end/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /replay macro/i }));
    expect(onReplay).toHaveBeenCalledWith(true);
  });

  it("passes the current loop toggle state to Replay macro", async () => {
    const onReplay = vi.fn();
    render(
      <StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={onReplay} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /loop on/i }));
    await userEvent.click(screen.getByRole("button", { name: /replay macro/i }));

    expect(onReplay).toHaveBeenCalledWith(false);
  });

  it("changes playback speed via the slider", () => {
    render(<StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={noop} />);
    expect(screen.getByText("1×")).toBeInTheDocument();
    const slider = screen.getByRole("slider", { name: /playback speed/i });
    fireEvent.change(slider, { target: { value: "1.5" } });
    expect(screen.getByText("1.5×")).toBeInTheDocument();
  });

  // jsdom's HTMLMediaElement play()/pause() are unimplemented no-ops that
  // never flip `.paused`, so control it explicitly: a flag backs a `paused`
  // getter, and play/pause spies flip the flag like a real media element.
  function stubPlayback(video: HTMLVideoElement, initiallyPlaying: boolean) {
    let paused = !initiallyPlaying;
    Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
    const play = vi.fn(() => {
      paused = false;
      return Promise.resolve();
    });
    const pause = vi.fn(() => {
      paused = true;
    });
    video.play = play;
    video.pause = pause;
    return { play, pause };
  }

  it("pauses on a click without movement while playing, and shows no popover", () => {
    const { container } = render(
      <StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={noop} />,
    );
    const video = container.querySelector("video") as HTMLVideoElement;
    const { play, pause } = stubPlayback(video, true);
    const layer = container.querySelector(".sp-interact") as HTMLElement;
    expect(layer).toBeTruthy();

    fireEvent.pointerDown(layer, { clientX: 30, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 30, clientY: 20, pointerId: 1 });

    // Click while playing toggles playing → paused: pointer-down pauses, and
    // pointer-up must NOT resume.
    expect(pause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("resumes on a click without movement while paused", () => {
    const { container } = render(
      <StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={noop} />,
    );
    const video = container.querySelector("video") as HTMLVideoElement;
    const { play } = stubPlayback(video, false);
    const layer = container.querySelector(".sp-interact") as HTMLElement;

    fireEvent.pointerDown(layer, { clientX: 30, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 30, clientY: 20, pointerId: 1 });

    // Click while paused toggles paused → playing.
    expect(play).toHaveBeenCalled();
    expect(video.paused).toBe(false);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("drags a selection, and saving a Color target samples the color before saving", async () => {
    const onSaveTarget = vi.fn().mockResolvedValue(undefined);
    const onSampleColor = vi.fn().mockResolvedValue([10, 20, 30]);

    const { container } = render(
      <StudioPlayer
        src="asset://clip.mp4"
        fps={30}
        onTimeUpdate={noop}
        onReplay={noop}
        onSaveTarget={onSaveTarget}
        onSampleColor={onSampleColor}
      />,
    );
    const layer = container.querySelector(".sp-interact") as HTMLElement;

    fireEvent.pointerDown(layer, { clientX: 30, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 60, clientY: 45, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 60, clientY: 45, pointerId: 1 });

    const saveButton = await screen.findByRole("button", { name: "Save" });
    await userEvent.click(screen.getByRole("button", { name: "Color" }));
    await userEvent.click(saveButton);

    await waitFor(() => expect(onSaveTarget).toHaveBeenCalled());

    expect(onSampleColor).toHaveBeenCalledTimes(1);
    const [region, tsMs] = onSampleColor.mock.calls[0];
    expect(region.x).toBeCloseTo(0.3);
    expect(region.y).toBeCloseTo(0.4);
    expect(region.w).toBeCloseTo(0.3);
    expect(region.h).toBeCloseTo(0.5);
    expect(tsMs).toBe(0);

    // Color must be sampled before the target is saved.
    expect(onSampleColor.mock.invocationCallOrder[0]).toBeLessThan(
      onSaveTarget.mock.invocationCallOrder[0],
    );

    const [target] = onSaveTarget.mock.calls[0];
    expect(target.kind).toEqual({ type: "ColorSample", rgb: [10, 20, 30], tolerance: 10 });
    expect(target.region.x).toBeCloseTo(0.3);
    expect(target.region.y).toBeCloseTo(0.4);
    expect(target.region.w).toBeCloseTo(0.3);
    expect(target.region.h).toBeCloseTo(0.5);

    // Popover cleans itself up after a successful save.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
