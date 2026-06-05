import { describe, expect, it } from "vitest";

import { cellIndex, createEmptyGrid, interpolate, resizeGrid } from "../grid";
import {
  cursorForHitTarget,
  hitTestCanvas,
  hitTestZones,
} from "../hit-testing";
import {
  applyPixelGradientToGrid,
  createEmptyMask,
  fillBucketGrid,
  getBoxMask,
  getBrushOperationMask,
  getConnectedColorMask,
  getDragBounds,
  getEllipseMask,
  getMaskBounds,
  getMaskLayerFamilyIds,
  getOutlineMask,
  getPatternThreshold,
  getPolygonMask,
  getShapeMask,
  getTriangleMask,
  resizeBooleanMask,
  transformSelectionGrid,
  wouldCreateMaskParentCycle,
} from "../masks";
import type { CellColor, MaskLayer, Size } from "../types";

const size: Size = { height: 4, width: 4 };

const selectedIndexes = (mask: boolean[]) =>
  mask.flatMap((selected, index) => (selected ? [index] : []));

describe("editor grid core", () => {
  it("interpolates straight and diagonal brush lines", () => {
    expect(interpolate({ x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(interpolate({ x: 0, y: 0 }, { x: 3, y: 3 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it("creates brush operation masks with clipped size", () => {
    expect(
      selectedIndexes(getBrushOperationMask(size, { x: 0, y: 0 }, 3))
    ).toEqual([0, 1, 4, 5]);
  });

  it("resizes grids and masks while preserving top-left pixels", () => {
    const grid = createEmptyGrid(size);
    grid[cellIndex(size, 2, 1)] = "#fff";
    const nextSize = { height: 3, width: 3 };
    expect(resizeGrid(grid, size, nextSize)[cellIndex(nextSize, 2, 1)]).toBe(
      "#fff"
    );

    const mask = createEmptyMask(size);
    mask[cellIndex(size, 2, 1)] = true;
    expect(
      resizeBooleanMask(mask, size, nextSize)[cellIndex(nextSize, 2, 1)]
    ).toBe(true);
  });
});

describe("selection and shape masks", () => {
  it("builds box, ellipse, outline, triangle and polygon masks", () => {
    const bounds = getDragBounds({ x: 0, y: 0 }, { x: 2, y: 2 });
    expect(selectedIndexes(getBoxMask(size, bounds))).toEqual([
      0, 1, 2, 4, 5, 6, 8, 9, 10,
    ]);
    expect(selectedIndexes(getEllipseMask(size, bounds))).toEqual([
      0, 1, 2, 4, 5, 6, 8, 9, 10,
    ]);
    expect(
      selectedIndexes(getOutlineMask(size, getBoxMask(size, bounds)))
    ).toEqual([0, 1, 2, 4, 6, 8, 9, 10]);
    expect(
      selectedIndexes(getTriangleMask(size, bounds)).length
    ).toBeGreaterThan(0);
    expect(
      selectedIndexes(
        getPolygonMask(size, [
          { x: 0, y: 0 },
          { x: 3, y: 0 },
          { x: 0, y: 3 },
        ])
      ).length
    ).toBeGreaterThan(0);
  });

  it("supports shape masks for line and rounded triangle modes", () => {
    const largerSize = { height: 6, width: 6 };
    expect(
      selectedIndexes(
        getShapeMask(size, { x: 0, y: 0 }, { x: 3, y: 3 }, "line", "fill", 0)
      )
    ).toEqual([0, 5, 10, 15]);
    expect(
      selectedIndexes(
        getShapeMask(
          largerSize,
          { x: 0, y: 0 },
          { x: 5, y: 5 },
          "triangle",
          "outline",
          1
        )
      ).length
    ).toBeGreaterThan(0);
  });
});

describe("canvas hit testing", () => {
  it("prioritizes rotate zones, scale handles and selection body", () => {
    const hitInput = {
      canvasRect: { height: 320, width: 320 },
      selectionBounds: { height: 8, width: 8, x: 8, y: 8 },
      size: { height: 32, width: 32 },
    };
    expect(
      hitTestCanvas({
        ...hitInput,
        canvasPoint: { x: 5.8, y: 5.8 },
      })
    ).toEqual({ corner: "nw", kind: "rotate-handle" });
    expect(
      hitTestCanvas({
        ...hitInput,
        canvasPoint: { x: 8, y: 8 },
      })
    ).toEqual({ corner: "nw", kind: "scale-handle" });
    expect(
      hitTestCanvas({
        ...hitInput,
        canvasPoint: { x: 12, y: 12 },
      })
    ).toEqual({ kind: "selection-body" });
  });

  it("keeps the current target stable near boundaries", () => {
    const previousTarget = { corner: "nw", kind: "scale-handle" } as const;
    const target = hitTestCanvas({
      canvasPoint: { x: 8.95, y: 8.95 },
      canvasRect: { height: 320, width: 320 },
      previousTarget,
      selectionBounds: { height: 8, width: 8, x: 8, y: 8 },
      size: { height: 32, width: 32 },
    });
    expect(target).toEqual(previousTarget);
    expect(cursorForHitTarget(target)).toBe("nwse-resize");
  });

  it("detects mask anchors as canvas hit targets with hysteresis", () => {
    const previousTarget = {
      kind: "mask-anchor",
      layerId: "mask_1",
    } as const;
    const target = hitTestCanvas({
      canvasPoint: { x: 10.9, y: 10.9 },
      canvasRect: { height: 320, width: 320 },
      maskAnchors: [{ layerId: "mask_1", point: { x: 10, y: 10 } }],
      previousTarget,
      size: { height: 32, width: 32 },
    });
    expect(target).toEqual(previousTarget);
    expect(cursorForHitTarget(target)).toBe("grab");
  });

  it("uses reusable zones with priority, magnetic radius and hysteresis", () => {
    const lowerPriorityTarget = { kind: "timeline-frame" };
    const higherPriorityTarget = { kind: "modal-handle" };
    const hit = hitTestZones({
      point: { x: 14, y: 14 },
      zones: [
        {
          id: "frame",
          priority: 10,
          rect: { height: 20, width: 20, x: 0, y: 0 },
          target: lowerPriorityTarget,
        },
        {
          id: "modal",
          priority: 100,
          rect: { height: 8, width: 8, x: 12, y: 12 },
          target: higherPriorityTarget,
        },
      ],
    });
    expect(hit?.target).toEqual(higherPriorityTarget);

    const magnetic = hitTestZones({
      point: { x: 27, y: 10 },
      zones: [
        {
          id: "frame",
          magneticRadius: 8,
          priority: 10,
          rect: { height: 20, width: 20, x: 0, y: 0 },
          target: lowerPriorityTarget,
        },
      ],
    });
    expect(magnetic?.isMagnetic).toBe(true);

    const stable = hitTestZones({
      point: { x: 24, y: 10 },
      previousTarget: lowerPriorityTarget,
      zones: [
        {
          id: "frame",
          magneticRadius: 0,
          priority: 10,
          rect: { height: 20, width: 20, x: 0, y: 0 },
          target: lowerPriorityTarget,
        },
      ],
    });
    expect(stable?.target).toEqual(lowerPriorityTarget);
  });
});

describe("fill and gradient core", () => {
  it("bucket fills a connected region and honors active masks", () => {
    const grid: CellColor[] = [
      null,
      null,
      "#1",
      "#1",
      null,
      "#2",
      "#1",
      "#1",
      "#3",
      "#3",
      "#1",
      "#1",
      "#3",
      "#3",
      "#1",
      "#1",
    ];
    const activeMask = createEmptyMask(size);
    activeMask[0] = true;
    activeMask[1] = true;
    activeMask[4] = true;
    const next = fillBucketGrid(size, grid, { x: 0, y: 0 }, "#f00", activeMask);
    expect(next[0]).toBe("#f00");
    expect(next[1]).toBe("#f00");
    expect(next[4]).toBe("#f00");
    expect(next[5]).toBe("#2");
  });

  it("finds connected color masks and applies pixel gradient thresholds", () => {
    const grid = createEmptyGrid(size);
    const mask = getConnectedColorMask(size, { x: 0, y: 0 }, grid);
    expect(mask.every(Boolean)).toBe(true);
    expect(getPatternThreshold(0, 0, "hard")).toBe(0.5);
    const gradient = applyPixelGradientToGrid({
      baseGrid: grid,
      endCell: { x: 3, y: 0 },
      endColor: "#fff",
      kind: "linear",
      pattern: "hard",
      size,
      startCell: { x: 0, y: 0 },
      startColor: "#000",
      targetMask: mask,
    });
    expect(gradient[cellIndex(size, 0, 0)]).toBe("#000");
    expect(gradient[cellIndex(size, 3, 0)]).toBe("#fff");
  });
});

describe("mask layers and transforms", () => {
  const layers: MaskLayer[] = [
    {
      anchor: { x: 0, y: 0 },
      color: "#f00",
      id: "a",
      mask: createEmptyMask(size),
      name: "Mask 1",
      parentId: null,
      visible: true,
    },
    {
      anchor: { x: 0, y: 0 },
      color: "#0f0",
      id: "b",
      mask: createEmptyMask(size),
      name: "Mask 2",
      parentId: "a",
      visible: true,
    },
  ];

  it("tracks mask families and rejects parenting cycles", () => {
    expect(getMaskLayerFamilyIds("a", layers)).toEqual(["a", "b"]);
    expect(wouldCreateMaskParentCycle("a", "b", layers)).toBe(true);
  });

  it("transforms selected pixels into snapped grid cells", () => {
    const grid = createEmptyGrid(size);
    grid[cellIndex(size, 0, 0)] = "#fff";
    const mask = createEmptyMask(size);
    mask[cellIndex(size, 0, 0)] = true;
    const result = transformSelectionGrid(
      size,
      grid,
      { height: 1, width: 1, x: 0, y: 0 },
      mask,
      { x: 1, y: 1 },
      0,
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 }
    );
    expect(result.grid[cellIndex(size, 1, 1)]).toBe("#fff");
    expect(getMaskBounds(size, result.mask)).toEqual({
      height: 1,
      width: 1,
      x: 1,
      y: 1,
    });
  });
});
