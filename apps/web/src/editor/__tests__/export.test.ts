import { describe, expect, it } from "vitest";

import {
  createLottieExport,
  createReactExport,
  createSavedAnimationJson,
  createSvgExport,
  frameToSvgRects,
  getExportDialogFrames,
  getExportFramesForScope,
} from "../export/serializers";
import { createFrame } from "../grid";

describe("export serializers", () => {
  const frame = createFrame(
    { height: 2, width: 2 },
    ["#111111", null, "#ffffff", null],
    "frame-a"
  );
  const frameB = createFrame(
    { height: 2, width: 2 },
    [null, "#222222", null, null],
    "frame-b"
  );

  it("serializes SVG rects and animation groups", () => {
    expect(frameToSvgRects(frame, 2)).toContain(
      '<rect x="0" y="0" width="2" height="2" fill="#111111" />'
    );
    expect(createSvgExport([frame, frameB], 2)).toContain(
      'shape-rendering="crispEdges"'
    );
  });

  it("serializes saved animation, lottie and react exports", () => {
    const saved = JSON.parse(
      createSavedAnimationJson([frame], 3, "json", "frame")
    );
    expect(saved.canvas).toEqual({ height: 2, width: 2 });
    expect(saved.scale).toBe(3);
    const lottie = JSON.parse(createLottieExport([frame], 2));
    expect(lottie.layers.length).toBe(1);
    expect(lottie.meta.generator).toBe("retrodex-rect-runs");
    expect(createReactExport([frame], 2)).toContain(
      "export function PixelAnimation"
    );
  });

  it("selects export frames and preview frame fallbacks", () => {
    expect(
      getExportFramesForScope([frame, frameB], "frame-b", "frame")
    ).toEqual([frameB]);
    expect(
      getExportFramesForScope([frame, frameB], "missing", "frame")
    ).toEqual([]);
    expect(getExportDialogFrames([], [frame])).toEqual([frame]);
    expect(getExportDialogFrames([frameB], [frame])).toEqual([frameB]);
  });
});
