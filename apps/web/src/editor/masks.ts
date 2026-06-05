import { bayer4, bayer8, maskLayerColors } from "./constants";
import { cellIndex, clamp, clamp01, createFrameId, interpolate } from "./grid";
import type {
  Bounds,
  Cell,
  CellColor,
  GradientKind,
  GradientPattern,
  MaskLayer,
  Point,
  ShapeMode,
  ShapeTool,
  Size,
} from "./types";

export const createEmptyMask = (size: Size) =>
  Array.from({ length: size.width * size.height }, () => false);

export const getSelectionCenter = (bounds: Bounds): Point => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height / 2,
});

export const createMaskLayer = (size: Size, index: number): MaskLayer => ({
  anchor: { x: size.width / 2, y: size.height / 2 },
  color: maskLayerColors[index % maskLayerColors.length],
  id: createFrameId(),
  mask: createEmptyMask(size),
  name: `Mask ${index + 1}`,
  parentId: null,
  visible: true,
});

export const cloneMaskLayers = (layers: MaskLayer[]): MaskLayer[] =>
  layers.map((layer) => ({
    ...layer,
    anchor: { ...layer.anchor },
    mask: [...layer.mask],
  }));

export const getMaskLayerFamilyIds = (
  rootLayerId: string,
  layers: MaskLayer[]
): string[] => {
  const familyIds = new Set([rootLayerId]);
  let didChange = true;
  while (didChange) {
    didChange = false;
    for (const layer of layers) {
      if (
        layer.parentId &&
        familyIds.has(layer.parentId) &&
        !familyIds.has(layer.id)
      ) {
        familyIds.add(layer.id);
        didChange = true;
      }
    }
  }
  return [...familyIds];
};

export const getOptionalMaskLayerFamilyIds = (
  rootLayerId: null | string | undefined,
  layers: MaskLayer[]
) => (rootLayerId ? getMaskLayerFamilyIds(rootLayerId, layers) : undefined);

export const getMaskLayerFamilyIdsOrEmpty = (
  rootLayerId: null | string,
  layers: MaskLayer[]
) => (rootLayerId ? getMaskLayerFamilyIds(rootLayerId, layers) : []);

export const combineMaskLayers = (
  size: Size,
  layerIds: string[],
  layers: MaskLayer[]
) => {
  const layerIdSet = new Set(layerIds);
  const combinedMask = createEmptyMask(size);
  for (const layer of layers) {
    if (!layerIdSet.has(layer.id)) {
      continue;
    }
    for (let index = 0; index < layer.mask.length; index += 1) {
      combinedMask[index] ||= layer.mask[index];
    }
  }
  return combinedMask;
};

export const wouldCreateMaskParentCycle = (
  layerId: string,
  parentId: null | string,
  layers: MaskLayer[]
) => {
  const parentByLayerId = new Map(
    layers.map((layer) => [layer.id, layer.parentId])
  );
  let currentParentId = parentId;
  while (currentParentId) {
    if (currentParentId === layerId) {
      return true;
    }
    currentParentId = parentByLayerId.get(currentParentId) ?? null;
  }
  return false;
};

export const resizeBooleanMask = (
  mask: boolean[],
  fromSize: Size,
  toSize: Size
): boolean[] => {
  const nextMask = createEmptyMask(toSize);
  const copyWidth = Math.min(fromSize.width, toSize.width);
  const copyHeight = Math.min(fromSize.height, toSize.height);
  for (let y = 0; y < copyHeight; y += 1) {
    for (let x = 0; x < copyWidth; x += 1) {
      nextMask[cellIndex(toSize, x, y)] =
        mask[cellIndex(fromSize, x, y)] ?? false;
    }
  }
  return nextMask;
};

export const getMaskBounds = (size: Size, mask: boolean[]): Bounds | null => {
  let minX = size.width;
  let minY = size.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      if (mask[cellIndex(size, x, y)]) {
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

export const getDragBounds = (from: Cell, to: Cell): Bounds => {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return {
    height: Math.abs(to.y - from.y) + 1,
    width: Math.abs(to.x - from.x) + 1,
    x,
    y,
  };
};

export const getBoxMask = (size: Size, bounds: Bounds) => {
  const mask = createEmptyMask(size);
  for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
    for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
      mask[cellIndex(size, x, y)] = true;
    }
  }
  return mask;
};

export const getEllipseMask = (size: Size, bounds: Bounds) => {
  const mask = createEmptyMask(size);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const radiusX = Math.max(bounds.width / 2, 0.5);
  const radiusY = Math.max(bounds.height / 2, 0.5);
  for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
    for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
      const dx = (x + 0.5 - centerX) / radiusX;
      const dy = (y + 0.5 - centerY) / radiusY;
      mask[cellIndex(size, x, y)] = dx * dx + dy * dy <= 1;
    }
  }
  return mask;
};

export const getRoundedRectangleMask = (
  size: Size,
  bounds: Bounds,
  radius: number
) => {
  const mask = createEmptyMask(size);
  const clampedRadius = Math.min(
    Math.max(0, radius),
    Math.floor(Math.min(bounds.width, bounds.height) / 2)
  );
  for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
    for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
      if (clampedRadius === 0) {
        mask[cellIndex(size, x, y)] = true;
        continue;
      }
      const localX = x - bounds.x;
      const localY = y - bounds.y;
      const nearLeft = localX < clampedRadius;
      const nearRight = localX >= bounds.width - clampedRadius;
      const nearTop = localY < clampedRadius;
      const nearBottom = localY >= bounds.height - clampedRadius;
      if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
        const cornerX = nearLeft
          ? clampedRadius - 0.5
          : bounds.width - clampedRadius - 0.5;
        const cornerY = nearTop
          ? clampedRadius - 0.5
          : bounds.height - clampedRadius - 0.5;
        mask[cellIndex(size, x, y)] =
          Math.hypot(localX - cornerX, localY - cornerY) <= clampedRadius;
      } else {
        mask[cellIndex(size, x, y)] = true;
      }
    }
  }
  return mask;
};

export const getOutlineMask = (size: Size, mask: boolean[]) => {
  const outline = createEmptyMask(size);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const index = cellIndex(size, x, y);
      if (!mask[index]) {
        continue;
      }
      let isOutlineCell = false;
      for (const cell of [
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 },
      ]) {
        if (
          cell.x < 0 ||
          cell.x >= size.width ||
          cell.y < 0 ||
          cell.y >= size.height ||
          !mask[cellIndex(size, cell.x, cell.y)]
        ) {
          isOutlineCell = true;
          break;
        }
      }
      outline[index] = isOutlineCell;
    }
  }
  return outline;
};

export const dilateMask = (size: Size, mask: boolean[], radius: number) => {
  const nextMask = createEmptyMask(size);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      if (!mask[cellIndex(size, x, y)]) {
        continue;
      }
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nextX = x + dx;
          const nextY = y + dy;
          if (
            nextX >= 0 &&
            nextX < size.width &&
            nextY >= 0 &&
            nextY < size.height &&
            Math.hypot(dx, dy) <= radius
          ) {
            nextMask[cellIndex(size, nextX, nextY)] = true;
          }
        }
      }
    }
  }
  return nextMask;
};

export const erodeMask = (size: Size, mask: boolean[], radius: number) => {
  const nextMask = createEmptyMask(size);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      if (!mask[cellIndex(size, x, y)]) {
        continue;
      }
      let keepCell = true;
      for (let dy = -radius; dy <= radius && keepCell; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nextX = x + dx;
          const nextY = y + dy;
          if (
            Math.hypot(dx, dy) <= radius &&
            (nextX < 0 ||
              nextX >= size.width ||
              nextY < 0 ||
              nextY >= size.height ||
              !mask[cellIndex(size, nextX, nextY)])
          ) {
            keepCell = false;
            break;
          }
        }
      }
      nextMask[cellIndex(size, x, y)] = keepCell;
    }
  }
  return nextMask;
};

export const roundMaskCorners = (
  size: Size,
  mask: boolean[],
  radius: number
) => {
  if (radius <= 0) {
    return mask;
  }
  return dilateMask(size, erodeMask(size, mask, radius), radius);
};

export const isPointInsidePolygon = (point: Point, polygon: Point[]) => {
  let isInside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (intersects) {
      isInside = !isInside;
    }
  }
  return isInside;
};

export const getTriangleMask = (size: Size, bounds: Bounds) => {
  const mask = createEmptyMask(size);
  const top = { x: bounds.x + bounds.width / 2, y: bounds.y };
  const left = { x: bounds.x, y: bounds.y + bounds.height };
  const right = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
  for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
    for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
      mask[cellIndex(size, x, y)] = isPointInsidePolygon(
        { x: x + 0.5, y: y + 0.5 },
        [top, right, left]
      );
    }
  }
  return mask;
};

export const getShapeMask = (
  size: Size,
  startCell: Cell,
  endCell: Cell,
  shapeTool: ShapeTool,
  shapeMode: ShapeMode,
  radius: number
) => {
  if (shapeTool === "line") {
    const mask = createEmptyMask(size);
    for (const cell of interpolate(startCell, endCell)) {
      mask[cellIndex(size, cell.x, cell.y)] = true;
    }
    return mask;
  }
  const bounds = getDragBounds(startCell, endCell);
  let filledMask = getRoundedRectangleMask(size, bounds, radius);
  if (shapeTool === "ellipse") {
    filledMask = getEllipseMask(size, bounds);
  } else if (shapeTool === "triangle") {
    filledMask = roundMaskCorners(size, getTriangleMask(size, bounds), radius);
  }
  return shapeMode === "outline"
    ? getOutlineMask(size, filledMask)
    : filledMask;
};

export const getPolygonMask = (size: Size, points: Cell[]) => {
  const polygon = points.map((point) => ({
    x: point.x + 0.5,
    y: point.y + 0.5,
  }));
  const mask = createEmptyMask(size);
  if (polygon.length < 3) {
    return mask;
  }
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      mask[cellIndex(size, x, y)] = isPointInsidePolygon(
        { x: x + 0.5, y: y + 0.5 },
        polygon
      );
    }
  }
  return mask;
};

export const getPolygonDraftMask = (size: Size, points: Cell[]) => {
  if (points.length >= 3) {
    return getPolygonMask(size, points);
  }
  const mask = createEmptyMask(size);
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const cells = next ? interpolate(current, next) : [current];
    for (const cell of cells) {
      mask[cellIndex(size, cell.x, cell.y)] = true;
    }
  }
  return mask;
};

export const getConnectedColorMask = (
  size: Size,
  cell: Cell,
  grid: CellColor[]
) => {
  const targetColor = grid[cellIndex(size, cell.x, cell.y)];
  const mask = createEmptyMask(size);
  const visited = createEmptyMask(size);
  const queue = [cell];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    const index = cellIndex(size, current.x, current.y);
    if (visited[index] || grid[index] !== targetColor) {
      continue;
    }
    visited[index] = true;
    mask[index] = true;
    for (const next of [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ]) {
      if (
        next.x >= 0 &&
        next.x < size.width &&
        next.y >= 0 &&
        next.y < size.height
      ) {
        queue.push(next);
      }
    }
  }
  return mask;
};

export const getBrushOperationMask = (
  size: Size,
  cell: Cell,
  brushSize: number
) => {
  const operationMask = createEmptyMask(size);
  const offset = Math.floor(brushSize / 2);
  for (let y = cell.y - offset; y < cell.y - offset + brushSize; y += 1) {
    for (let x = cell.x - offset; x < cell.x - offset + brushSize; x += 1) {
      if (x >= 0 && x < size.width && y >= 0 && y < size.height) {
        operationMask[cellIndex(size, x, y)] = true;
      }
    }
  }
  return operationMask;
};

export const fillBucketGrid = (
  size: Size,
  grid: CellColor[],
  cell: Cell,
  color: string,
  activeMask?: boolean[]
) => {
  if (activeMask && !activeMask[cellIndex(size, cell.x, cell.y)]) {
    return grid;
  }
  const targetColor = grid[cellIndex(size, cell.x, cell.y)];
  const nextGrid = [...grid];
  const visited = createEmptyMask(size);
  const queue = [cell];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    const index = cellIndex(size, current.x, current.y);
    if (
      visited[index] ||
      grid[index] !== targetColor ||
      (activeMask && !activeMask[index])
    ) {
      continue;
    }
    visited[index] = true;
    nextGrid[index] = color;
    for (const next of [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ]) {
      if (
        next.x >= 0 &&
        next.x < size.width &&
        next.y >= 0 &&
        next.y < size.height
      ) {
        queue.push(next);
      }
    }
  }
  return nextGrid;
};

export const getGradientAmount = (
  cell: Cell,
  startCell: Cell,
  endCell: Cell,
  kind: GradientKind
) => {
  const start = { x: startCell.x + 0.5, y: startCell.y + 0.5 };
  const end = { x: endCell.x + 0.5, y: endCell.y + 0.5 };
  const point = { x: cell.x + 0.5, y: cell.y + 0.5 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return 1;
  }
  if (kind === "radial") {
    const radius = Math.sqrt(lengthSquared);
    const distance = Math.hypot(point.x - start.x, point.y - start.y);
    return clamp01(distance / radius);
  }
  return clamp01(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  );
};

export const getPatternThreshold = (
  x: number,
  y: number,
  pattern: GradientPattern
) => {
  if (pattern === "hard") {
    return 0.5;
  }
  if (pattern === "checker") {
    return (x + y) % 2 === 0 ? 0.38 : 0.62;
  }
  if (pattern === "fine") {
    return (bayer8[y % 8][x % 8] + 0.5) / 64;
  }
  return (bayer4[y % 4][x % 4] + 0.5) / 16;
};

export const applyPixelGradientToGrid = ({
  baseGrid,
  endCell,
  endColor,
  kind,
  pattern,
  size,
  startCell,
  startColor,
  targetMask,
}: {
  baseGrid: CellColor[];
  endCell: Cell;
  endColor: string;
  kind: GradientKind;
  pattern: GradientPattern;
  size: Size;
  startCell: Cell;
  startColor: string;
  targetMask: boolean[];
}) => {
  const nextGrid = [...baseGrid];
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const index = cellIndex(size, x, y);
      if (!targetMask[index]) {
        continue;
      }
      const amount = getGradientAmount({ x, y }, startCell, endCell, kind);
      const threshold = getPatternThreshold(x, y, pattern);
      nextGrid[index] = amount >= threshold ? endColor : startColor;
    }
  }
  return nextGrid;
};

export const transformSelectionGrid = (
  size: Size,
  grid: CellColor[],
  bounds: Bounds,
  mask: boolean[],
  transformScale: Point,
  rotation: number,
  origin: Point,
  translation: Point
) => {
  const next = [...grid];
  const nextMask = createEmptyMask(size);
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
    for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
      if (mask[cellIndex(size, x, y)]) {
        next[cellIndex(size, x, y)] = null;
      }
    }
  }
  for (let targetY = 0; targetY < size.height; targetY += 1) {
    for (let targetX = 0; targetX < size.width; targetX += 1) {
      const dx = targetX + 0.5 - origin.x - translation.x;
      const dy = targetY + 0.5 - origin.y - translation.y;
      const rotatedX = dx * cos - dy * sin;
      const rotatedY = dx * sin + dy * cos;
      const sourceX = origin.x + rotatedX / transformScale.x;
      const sourceY = origin.y + rotatedY / transformScale.y;
      const sampleX = Math.floor(sourceX);
      const sampleY = Math.floor(sourceY);
      if (
        sampleX >= bounds.x &&
        sampleX < bounds.x + bounds.width &&
        sampleY >= bounds.y &&
        sampleY < bounds.y + bounds.height
      ) {
        const sourceIndex = cellIndex(size, sampleX, sampleY);
        if (mask[sourceIndex]) {
          const targetIndex = cellIndex(size, targetX, targetY);
          next[targetIndex] = grid[sourceIndex];
          nextMask[targetIndex] = true;
        }
      }
    }
  }
  return { grid: next, mask: nextMask };
};

export const transformSelectionMask = (
  size: Size,
  bounds: Bounds,
  mask: boolean[],
  transformScale: Point,
  rotation: number,
  origin: Point,
  translation: Point
) => {
  const nextMask = createEmptyMask(size);
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  for (let targetY = 0; targetY < size.height; targetY += 1) {
    for (let targetX = 0; targetX < size.width; targetX += 1) {
      const dx = targetX + 0.5 - origin.x - translation.x;
      const dy = targetY + 0.5 - origin.y - translation.y;
      const rotatedX = dx * cos - dy * sin;
      const rotatedY = dx * sin + dy * cos;
      const sourceX = origin.x + rotatedX / transformScale.x;
      const sourceY = origin.y + rotatedY / transformScale.y;
      const sampleX = Math.floor(sourceX);
      const sampleY = Math.floor(sourceY);
      if (
        sampleX >= bounds.x &&
        sampleX < bounds.x + bounds.width &&
        sampleY >= bounds.y &&
        sampleY < bounds.y + bounds.height &&
        mask[cellIndex(size, sampleX, sampleY)]
      ) {
        nextMask[cellIndex(size, targetX, targetY)] = true;
      }
    }
  }
  return nextMask;
};

export const transformSelectionPoint = (
  size: Size,
  point: Point,
  transformScale: Point,
  rotation: number,
  origin: Point,
  translation: Point
): Point => {
  const radians = (rotation * Math.PI) / 180;
  const scaledX = (point.x - origin.x) * transformScale.x;
  const scaledY = (point.y - origin.y) * transformScale.y;
  const rotatedX = scaledX * Math.cos(radians) - scaledY * Math.sin(radians);
  const rotatedY = scaledX * Math.sin(radians) + scaledY * Math.cos(radians);
  return {
    x: clamp(Math.round(origin.x + translation.x + rotatedX), size.width - 1),
    y: clamp(Math.round(origin.y + translation.y + rotatedY), size.height - 1),
  };
};
