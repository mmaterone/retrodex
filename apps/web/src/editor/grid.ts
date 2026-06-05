import {
  maxBrushSize,
  maxCanvasDimension,
  maxZoom,
  minBrushSize,
  minCanvasDimension,
  minZoom,
} from "./constants";
import type { AnimationFrame, Cell, CellColor, Size } from "./types";

export const clamp = (value: number, max: number) =>
  Math.max(0, Math.min(max, value));

export const clampCanvasDimension = (value: number) =>
  Math.max(minCanvasDimension, Math.min(maxCanvasDimension, Math.round(value)));

export const clampBrushSize = (value: number) =>
  Math.max(minBrushSize, Math.min(maxBrushSize, Math.round(value)));

export const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const clampZoom = (value: number) =>
  Math.max(minZoom, Math.min(maxZoom, value));

export const clampScale = (value: number, minimum: number) =>
  Math.max(minimum, Math.min(maxZoom, value));

export const cellIndex = (size: Size, x: number, y: number) =>
  y * size.width + x;

export const createEmptyGrid = (size: Size) =>
  Array.from({ length: size.width * size.height }, () => null as CellColor);

export const createFrameId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `frame-${Date.now()}-${Math.random()}`;

export const createFrame = (
  size: Size,
  grid = createEmptyGrid(size),
  id = createFrameId()
): AnimationFrame => ({
  grid,
  id,
  size,
});

export const interpolate = (from: Cell, to: Cell): Cell[] => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  return Array.from({ length: steps + 1 }, (_, step) => ({
    x: Math.round(from.x + (dx * step) / steps),
    y: Math.round(from.y + (dy * step) / steps),
  }));
};

export const resizeGrid = (
  grid: CellColor[],
  fromSize: Size,
  toSize: Size
): CellColor[] => {
  const nextGrid = createEmptyGrid(toSize);
  const copyWidth = Math.min(fromSize.width, toSize.width);
  const copyHeight = Math.min(fromSize.height, toSize.height);
  for (let y = 0; y < copyHeight; y += 1) {
    for (let x = 0; x < copyWidth; x += 1) {
      nextGrid[cellIndex(toSize, x, y)] =
        grid[cellIndex(fromSize, x, y)] ?? null;
    }
  }
  return nextGrid;
};

export const getGridBounds = (
  grid: CellColor[],
  size: Size
): null | { height: number; width: number; x: number; y: number } => {
  let minX = size.width;
  let minY = size.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      if (grid[cellIndex(size, x, y)]) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX === -1
    ? null
    : {
        height: maxY - minY + 1,
        width: maxX - minX + 1,
        x: minX,
        y: minY,
      };
};
