import type { EditorDocument, EditorOperation, PixelCell } from "@retrodex/contracts";
import { ApiError } from "./errors.js";

type DrawingOperation = Extract<EditorOperation, {
  type: "polygon-pixels" | "mirror-pixels" | "paint-mask";
}>;
type Point = { x: number; y: number };

// Vertices address pixel centers. Include edge pixels and use even-odd fill
// for concave or self-intersecting contours, independent of winding direction.
const insidePolygon = (x: number, y: number, points: Point[]): boolean => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
    if (cross === 0 && x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) &&
        y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) return true;
    if ((a.y > y) !== (b.y > y) &&
        x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

const visible = (cell: PixelCell): boolean => {
  if (cell === null) return false;
  if (cell.startsWith("#")) return cell.length !== 9 || cell.slice(7) !== "00";
  return Number(cell.slice(5, -1).split(",")[3]) > 0;
};

export function applyDrawingOperation(document: EditorDocument, operation: DrawingOperation): EditorDocument {
  const frame = document.frames.find((entry) => entry.frameId === operation.frameId);
  if (!frame) throw new ApiError("editor-frame-not-found", "Drawing target frame does not exist.", 404, true);
  const { width, height } = frame.grid.size;
  const count = width * height;
  if (frame.grid.cells.length !== count || document.canvas.width !== width || document.canvas.height !== height) {
    throw new ApiError("drawing-grid-mismatch", "Drawing requires matching canvas and frame grid geometry.", 400, true);
  }
  const targets = operation.targetMaskLayerIds.map((id) => {
    const layer = document.masks.find((entry) => entry.id === id);
    if (!layer) throw new ApiError("editor-mask-not-found", `Drawing target mask does not exist: ${id}`, 404, true);
    return layer;
  });
  const locked = document.masks.filter((layer) => layer.regenerationPolicy.locked);
  for (const layer of [...targets, ...locked]) {
    if (layer.mask.length !== count) {
      throw new ApiError("drawing-mask-mismatch", `Mask geometry does not match the frame: ${layer.id}`, 400, true);
    }
  }
  const selection = document.selection;
  const selectionApplies = (selection.selectedFrameId ?? document.selectedFrameId) === frame.frameId;
  const selectionMask = selectionApplies ? selection.selectedPixelsMask : null;
  const bounds = selectionApplies ? selection.selectedBounds : null;
  if (selectionMask && selectionMask.length !== count) {
    throw new ApiError("drawing-selection-mismatch", "Selection geometry does not match the frame.", 400, true);
  }
  // An explicit selection mask is authoritative; bounds are its coarse fallback.
  const canPaint = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const index = y * width + x;
    if (selectionMask ? !selectionMask[index] : bounds &&
        (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height)) return false;
    return (!targets.length || targets.some((layer) => layer.mask[index])) &&
      !locked.some((layer) => layer.mask[index]) &&
      (!operation.respectAlpha || visible(frame.grid.cells[index]));
  };
  const cells = [...frame.grid.cells];
  if (operation.type === "mirror-pixels") {
    const b = operation.sourceBounds;
    if (b.x + b.width > width || b.y + b.height > height) {
      throw new ApiError("drawing-source-outside-frame", "Mirror source bounds must fit inside the frame.", 400, true);
    }
    const vertical = operation.axis === "vertical";
    const position = operation.axisPosition ?? ((vertical ? width : height) - 1) / 2;
    if (position < -0.5 || position > (vertical ? width : height) - 0.5) {
      throw new ApiError("drawing-axis-outside-frame", "Mirror axis must lie within the canvas edges.", 400, true);
    }
    for (let y = b.y; y < b.y + b.height; y++) {
      for (let x = b.x; x < b.x + b.width; x++) {
        const dx = vertical ? 2 * position - x : x;
        const dy = vertical ? y : 2 * position - y;
        const source = frame.grid.cells[y * width + x];
        if (canPaint(dx, dy) && (operation.copyTransparent || visible(source))) {
          cells[dy * width + dx] = source;
        }
      }
    }
  } else {
    // Include a thickness-sized halo so an off-canvas contour does not
    // create an artificial outline along the canvas edge.
    const pad = operation.type === "polygon-pixels" && operation.mode === "outline" ? operation.thickness : 0;
    const rasterWidth = width + 2 * pad, rasterHeight = height + 2 * pad;
    const filled = operation.type === "polygon-pixels"
      ? Array.from({ length: rasterWidth * rasterHeight }, (_, index) =>
          insidePolygon(index % rasterWidth - pad, Math.floor(index / rasterWidth) - pad, operation.points))
      : null;
    let interior = filled;
    if (filled && operation.type === "polygon-pixels" && operation.mode === "outline") {
      // Inward 4-connected outline, calculated before selection/mask clipping.
      for (let pass = 0; pass < operation.thickness; pass++) {
        const previous = interior!;
        interior = previous.map((enabled, index) => {
          const x = index % rasterWidth, y = Math.floor(index / rasterWidth);
          return enabled && x > 0 && x < rasterWidth - 1 && y > 0 && y < rasterHeight - 1 &&
            previous[index - 1] && previous[index + 1] && previous[index - rasterWidth] && previous[index + rasterWidth];
        });
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const rasterIndex = (y + pad) * rasterWidth + x + pad;
        if (canPaint(x, y) && (!filled || (filled[rasterIndex] &&
            (operation.type !== "polygon-pixels" || operation.mode === "fill" || !interior![rasterIndex])))) {
          cells[index] = operation.color;
        }
      }
    }
  }
  return { ...document, frames: document.frames.map((entry) => entry.frameId === frame.frameId ? {
    ...entry,
    alphaBBox: pixelAlphaBBox(cells, frame.grid.size),
    grid: { ...entry.grid, cells },
  } : entry) };
}

export function pixelAlphaBBox(cells: PixelCell[], size: { width: number; height: number }) {
  const { width, height } = size;
  const count = width * height;
  let left = width, top = height, right = -1, bottom = -1;
  for (let index = 0; index < count; index++) {
    if (!visible(cells[index])) continue;
    const x = index % width, y = Math.floor(index / width);
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
