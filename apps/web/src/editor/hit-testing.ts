import type { Bounds, Cell, Corner, Point, Size } from "./types";

export type CanvasHitTarget =
  | { kind: "anchor" }
  | { kind: "canvas-cell"; cell: Cell }
  | { kind: "mask-anchor"; layerId: string }
  | { corner: Corner; kind: "rotate-handle" }
  | { corner: Corner; kind: "scale-handle" }
  | { kind: "selection-body" };

interface HitTestInput {
  anchor?: Point | null;
  canvasPoint: Point;
  canvasRect: { height: number; width: number };
  maskAnchors?: { layerId: string; point: Point }[];
  previousTarget?: CanvasHitTarget | null;
  selectionBounds?: Bounds | null;
  size: Size;
}

export interface HitZone<T extends { kind: string }> {
  id: string;
  magneticRadius?: number;
  priority: number;
  rect: Bounds;
  target: T;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ZoneHit<T extends { kind: string }> {
  distance: number;
  isMagnetic: boolean;
  target: T;
  zone: HitZone<T>;
}

const handleCorners: Corner[] = ["nw", "ne", "sw", "se"];

const cornerPoint = (bounds: Bounds, corner: Corner): Point => ({
  x: corner.includes("e") ? bounds.x + bounds.width : bounds.x,
  y: corner.includes("s") ? bounds.y + bounds.height : bounds.y,
});

const rotatePoint = (bounds: Bounds, corner: Corner, offsetCells: number) => {
  const point = cornerPoint(bounds, corner);
  return {
    x: point.x + (corner.includes("e") ? offsetCells : -offsetCells),
    y: point.y + (corner.includes("s") ? offsetCells : -offsetCells),
  };
};

const distance = (left: Point, right: Point) =>
  Math.hypot(left.x - right.x, left.y - right.y);

const isInsideBounds = (point: Point, bounds: Bounds) =>
  point.x >= bounds.x &&
  point.x <= bounds.x + bounds.width &&
  point.y >= bounds.y &&
  point.y <= bounds.y + bounds.height;

const isInsideRect = (point: Point, rect: Bounds) =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height;

const rectCenter = (rect: Bounds): Point => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

const distanceToRect = (point: Point, rect: Bounds) => {
  if (isInsideRect(point, rect)) {
    return 0;
  }
  const nearestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.width));
  const nearestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.height));
  return distance(point, { x: nearestX, y: nearestY });
};

const targetKey = (target: { kind: string }) => {
  if ("corner" in target) {
    return `${target.kind}:${String(target.corner)}`;
  }
  if ("layerId" in target) {
    return `${target.kind}:${String(target.layerId)}`;
  }
  return target.kind;
};

export const hitTestZones = <T extends { kind: string }>({
  hysteresisPx = 8,
  point,
  previousTarget,
  zones,
}: {
  hysteresisPx?: number;
  point: ScreenPoint;
  previousTarget?: null | T;
  zones: HitZone<T>[];
}): null | ZoneHit<T> => {
  if (previousTarget) {
    const previousKey = targetKey(previousTarget);
    const previousZone = zones.find(
      (zone) => targetKey(zone.target) === previousKey
    );
    if (
      previousZone &&
      distanceToRect(point, previousZone.rect) <=
        (previousZone.magneticRadius ?? 0) + hysteresisPx
    ) {
      return {
        distance: distanceToRect(point, previousZone.rect),
        isMagnetic: !isInsideRect(point, previousZone.rect),
        target: previousZone.target,
        zone: previousZone,
      };
    }
  }

  let bestHit: null | ZoneHit<T> = null;
  for (const zone of zones) {
    const zoneDistance = distanceToRect(point, zone.rect);
    const isHit = zoneDistance === 0;
    const isMagnetic = !isHit && zoneDistance <= (zone.magneticRadius ?? 0);
    if (!isHit && !isMagnetic) {
      continue;
    }
    const hit = {
      distance: zoneDistance,
      isMagnetic,
      target: zone.target,
      zone,
    };
    if (
      !bestHit ||
      zone.priority > bestHit.zone.priority ||
      (zone.priority === bestHit.zone.priority &&
        zoneDistance < bestHit.distance)
    ) {
      bestHit = hit;
    }
  }
  return bestHit;
};

const isPointNearTarget = (
  point: Point,
  target: CanvasHitTarget,
  bounds: Bounds | null | undefined,
  anchor: Point | null | undefined,
  maskAnchors: { layerId: string; point: Point }[],
  toleranceCells: number,
  rotateOffsetCells: number
) => {
  if (target.kind === "anchor") {
    return anchor ? distance(point, anchor) <= toleranceCells : false;
  }
  if (target.kind === "mask-anchor") {
    const maskAnchor = maskAnchors.find(
      (item) => item.layerId === target.layerId
    );
    return maskAnchor
      ? distance(point, maskAnchor.point) <= toleranceCells
      : false;
  }
  if (!bounds) {
    return false;
  }
  if (target.kind === "selection-body") {
    return isInsideBounds(point, bounds);
  }
  if (target.kind === "scale-handle") {
    return (
      distance(point, cornerPoint(bounds, target.corner)) <= toleranceCells
    );
  }
  if (target.kind === "rotate-handle") {
    return (
      distance(point, rotatePoint(bounds, target.corner, rotateOffsetCells)) <=
      toleranceCells
    );
  }
  return false;
};

export const hitTestCanvas = ({
  anchor,
  canvasPoint,
  canvasRect,
  maskAnchors = [],
  previousTarget,
  selectionBounds,
  size,
}: HitTestInput): CanvasHitTarget => {
  const cellSize = Math.min(
    canvasRect.width / size.width,
    canvasRect.height / size.height
  );
  const toleranceCells = Math.max(0.45, 12 / cellSize);
  const hysteresisCells = toleranceCells * 1.35;
  const rotateOffsetCells = Math.max(1, 22 / cellSize);

  if (
    previousTarget &&
    isPointNearTarget(
      canvasPoint,
      previousTarget,
      selectionBounds,
      anchor,
      maskAnchors,
      hysteresisCells,
      rotateOffsetCells
    )
  ) {
    return previousTarget;
  }

  if (selectionBounds) {
    for (const corner of handleCorners) {
      if (
        distance(
          canvasPoint,
          rotatePoint(selectionBounds, corner, rotateOffsetCells)
        ) <= toleranceCells
      ) {
        return { corner, kind: "rotate-handle" };
      }
    }
    for (const corner of handleCorners) {
      if (
        distance(canvasPoint, cornerPoint(selectionBounds, corner)) <=
        toleranceCells
      ) {
        return { corner, kind: "scale-handle" };
      }
    }
    if (anchor && distance(canvasPoint, anchor) <= toleranceCells) {
      return { kind: "anchor" };
    }
    for (const maskAnchor of maskAnchors) {
      if (distance(canvasPoint, maskAnchor.point) <= toleranceCells) {
        return { kind: "mask-anchor", layerId: maskAnchor.layerId };
      }
    }
    if (isInsideBounds(canvasPoint, selectionBounds)) {
      return { kind: "selection-body" };
    }
  }

  for (const maskAnchor of maskAnchors) {
    if (distance(canvasPoint, maskAnchor.point) <= toleranceCells) {
      return { kind: "mask-anchor", layerId: maskAnchor.layerId };
    }
  }

  return {
    cell: {
      x: Math.min(Math.max(0, Math.floor(canvasPoint.x)), size.width - 1),
      y: Math.min(Math.max(0, Math.floor(canvasPoint.y)), size.height - 1),
    },
    kind: "canvas-cell",
  };
};

export const cursorForHitTarget = (target: CanvasHitTarget) => {
  if (target.kind === "rotate-handle") {
    return "grab";
  }
  if (target.kind === "scale-handle") {
    return target.corner === "nw" || target.corner === "se"
      ? "nwse-resize"
      : "nesw-resize";
  }
  if (target.kind === "selection-body" || target.kind === "anchor") {
    return "move";
  }
  if (target.kind === "mask-anchor") {
    return "grab";
  }
  return "crosshair";
};

export const magneticPointForHitTarget = (
  target: CanvasHitTarget,
  input: {
    anchor?: Point | null;
    maskAnchors?: { layerId: string; point: Point }[];
    selectionBounds?: Bounds | null;
  }
): null | Point => {
  if (target.kind === "anchor") {
    return input.anchor ?? null;
  }
  if (target.kind === "mask-anchor") {
    return (
      input.maskAnchors?.find((anchor) => anchor.layerId === target.layerId)
        ?.point ?? null
    );
  }
  if (target.kind === "scale-handle" && input.selectionBounds) {
    return cornerPoint(input.selectionBounds, target.corner);
  }
  if (target.kind === "rotate-handle" && input.selectionBounds) {
    return rotatePoint(input.selectionBounds, target.corner, 2);
  }
  if (target.kind === "selection-body" && input.selectionBounds) {
    return rectCenter(input.selectionBounds);
  }
  return null;
};
