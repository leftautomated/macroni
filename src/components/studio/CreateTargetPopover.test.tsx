import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateTargetPopover } from "./CreateTargetPopover";

const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

describe("CreateTargetPopover", () => {
  it("renders three kind buttons and saves a Text target by default", async () => {
    const onSave = vi.fn();
    render(
      <CreateTargetPopover
        region={region}
        anchor={{ x: 10, y: 20 }}
        defaultName="Target 1"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Text" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Color" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("Target 1", { type: "TextOcr", expect: null });
  });

  it("switches kind to Color and saves the ColorSample default", async () => {
    const onSave = vi.fn();
    render(
      <CreateTargetPopover
        region={region}
        anchor={{ x: 0, y: 0 }}
        defaultName="Target 2"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Color" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("Target 2", {
      type: "ColorSample",
      rgb: [0, 0, 0],
      tolerance: 10,
    });
  });

  it("includes the typed expect text for a Text target", async () => {
    const onSave = vi.fn();
    render(
      <CreateTargetPopover
        region={region}
        anchor={{ x: 0, y: 0 }}
        defaultName="Target 3"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText(/expected text/i), "Submit");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("Target 3", { type: "TextOcr", expect: "Submit" });
  });

  it("scopes the kind buttons to the provided `kinds` list, hiding Text", async () => {
    const onSave = vi.fn();
    render(
      <CreateTargetPopover
        region={region}
        anchor={{ x: 0, y: 0 }}
        defaultName="Target 1"
        kinds={["Image", "Color"]}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Text" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Color" })).toBeInTheDocument();

    // Defaults to the first of the scoped kinds (Image), not the hardcoded
    // "Text" default used when no `kinds` prop is passed.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("Target 1", {
      type: "TemplateMatch",
      image: "",
      threshold: 0.8,
      source_px: [0, 0],
    });
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const onCancel = vi.fn();
    render(
      <CreateTargetPopover
        region={region}
        anchor={{ x: 0, y: 0 }}
        defaultName="Target 1"
        onSave={() => {}}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
