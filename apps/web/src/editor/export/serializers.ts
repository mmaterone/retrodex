import { fpsToFrameDurationMs, playbackIntervalMs } from "../constants";
import { cellIndex, createEmptyGrid } from "../grid";
import type { AnimationFrame, ExportFormat, ExportScope, Size } from "../types";

export const JSON_EXPORT_MAX_SIZE = 512;

export const computeJsonExportScale = (
  size: Size,
  maxSize = JSON_EXPORT_MAX_SIZE
): number => {
  if (size.width < 1 || size.height < 1) {
    return 1;
  }
  return Math.max(
    1,
    Math.floor(Math.min(maxSize / size.width, maxSize / size.height))
  );
};

export const upscaleGridNearest = (
  grid: AnimationFrame["grid"],
  fromSize: Size,
  scaleFactor: number
): { grid: AnimationFrame["grid"]; size: Size } => {
  if (scaleFactor <= 1) {
    return { grid, size: fromSize };
  }
  const toSize = {
    height: fromSize.height * scaleFactor,
    width: fromSize.width * scaleFactor,
  };
  const nextGrid = createEmptyGrid(toSize);
  for (let y = 0; y < fromSize.height; y += 1) {
    for (let x = 0; x < fromSize.width; x += 1) {
      const color = grid[cellIndex(fromSize, x, y)];
      if (!color) {
        continue;
      }
      for (let offsetY = 0; offsetY < scaleFactor; offsetY += 1) {
        for (let offsetX = 0; offsetX < scaleFactor; offsetX += 1) {
          nextGrid[
            cellIndex(toSize, x * scaleFactor + offsetX, y * scaleFactor + offsetY)
          ] = color;
        }
      }
    }
  }
  return { grid: nextGrid, size: toSize };
};

const prepareJsonExportFrames = (frames: AnimationFrame[]) =>
  frames.map((frame) => {
    const scaleFactor = computeJsonExportScale(frame.size);
    const upscaled = upscaleGridNearest(frame.grid, frame.size, scaleFactor);
    return {
      ...frame,
      grid: upscaled.grid,
      size: upscaled.size,
    };
  });

interface LottieRectRun {
  color: number[];
  height: number;
  opacity: number;
  width: number;
  x: number;
  y: number;
}

const rgbaColorPattern =
  /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/iu;

const componentToUnit = (value: number) =>
  Math.max(0, Math.min(255, value)) / 255;

const parseColorAlpha = (value: string | undefined) => {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  if (parsed > 1) {
    return Math.max(0, Math.min(1, parsed / 255));
  }
  return Math.max(0, Math.min(1, parsed));
};

const colorToLottieFill = (color: string) => {
  const match = rgbaColorPattern.exec(color.trim());
  if (match) {
    const red = componentToUnit(Number(match[1]));
    const green = componentToUnit(Number(match[2]));
    const blue = componentToUnit(Number(match[3]));
    const alpha = parseColorAlpha(match[4]);
    return { color: [red, green, blue], opacity: alpha * 100 };
  }
  const normalized = color.trim().replace("#", "");
  if (/^[\da-f]{6}$/iu.test(normalized)) {
    const red = componentToUnit(Number.parseInt(normalized.slice(0, 2), 16));
    const green = componentToUnit(Number.parseInt(normalized.slice(2, 4), 16));
    const blue = componentToUnit(Number.parseInt(normalized.slice(4, 6), 16));
    return { color: [red, green, blue], opacity: 100 };
  }
  return { color: [0, 0, 0], opacity: 100 };
};

const createRectRuns = (
  frame: AnimationFrame,
  scaleFactor: number
): LottieRectRun[] => {
  const visited = new Set<number>();
  const runs: LottieRectRun[] = [];
  for (let y = 0; y < frame.size.height; y += 1) {
    for (let x = 0; x < frame.size.width; x += 1) {
      const index = y * frame.size.width + x;
      const color = frame.grid[index];
      if (!color || visited.has(index)) {
        continue;
      }
      let width = 1;
      while (x + width < frame.size.width) {
        const nextIndex = y * frame.size.width + x + width;
        if (visited.has(nextIndex) || frame.grid[nextIndex] !== color) {
          break;
        }
        width += 1;
      }
      let height = 1;
      let canGrow = true;
      while (y + height < frame.size.height && canGrow) {
        for (let offset = 0; offset < width; offset += 1) {
          const nextIndex = (y + height) * frame.size.width + x + offset;
          if (visited.has(nextIndex) || frame.grid[nextIndex] !== color) {
            canGrow = false;
            break;
          }
        }
        if (canGrow) {
          height += 1;
        }
      }
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          visited.add((y + row) * frame.size.width + x + column);
        }
      }
      const fill = colorToLottieFill(color);
      runs.push({
        color: fill.color,
        height: height * scaleFactor,
        opacity: fill.opacity,
        width: width * scaleFactor,
        x: x * scaleFactor,
        y: y * scaleFactor,
      });
    }
  }
  return runs;
};

const lottieColorKey = (run: LottieRectRun) =>
  `${run.color.join(",")}:${run.opacity}`;

export const LOTTIE_EXPORT_FPS = 60;
export const TGS_EXPORT_MAX_BYTES = 64_000;
export const TGS_LOTTIE_VERSION = "5.5.2";

export const computeLottieFrameHold = (sourceFps: number): number => {
  const source = Math.max(1, Math.round(sourceFps));
  if (LOTTIE_EXPORT_FPS % source === 0) {
    return LOTTIE_EXPORT_FPS / source;
  }
  return Math.max(1, Math.round(LOTTIE_EXPORT_FPS / source));
};

const lottieStaticScalar = (value: number) => ({ a: 0, k: value });

const lottieStaticVector2 = (x: number, y: number) => ({
  a: 0,
  k: [x, y],
});

const lottieStaticColor = (color: number[]) => ({ a: 0, k: color });

const createLottieRectShape = (run: LottieRectRun) => ({
  d: 1,
  p: lottieStaticVector2(run.x + run.width / 2, run.y + run.height / 2),
  r: lottieStaticScalar(0),
  s: lottieStaticVector2(run.width, run.height),
  ty: "rc",
});

const createLottieFillShape = (color: number[], opacity: number) => ({
  c: lottieStaticColor(color),
  o: lottieStaticScalar(opacity),
  r: 1,
  ty: "fl",
});

const createLottieTransformShape = () => ({
  a: lottieStaticVector2(0, 0),
  o: lottieStaticScalar(100),
  p: lottieStaticVector2(0, 0),
  r: lottieStaticScalar(0),
  s: lottieStaticVector2(100, 100),
  ty: "tr",
});

const createLottieLayerTransform = () => ({
  a: lottieStaticVector2(0, 0),
  o: lottieStaticScalar(100),
  p: lottieStaticVector2(0, 0),
  r: lottieStaticScalar(0),
  s: lottieStaticVector2(100, 100),
});

const createGroupedRectRunShapes = (
  runs: LottieRectRun[],
  frameIndex: number
) => {
  if (runs.length === 0) {
    return [];
  }
  const groups = new Map<string, LottieRectRun[]>();
  for (const run of runs) {
    const key = lottieColorKey(run);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((colorRuns, colorIndex) => {
    const [firstRun] = colorRuns;
    const items = [
      ...colorRuns.map((run) => createLottieRectShape(run)),
      createLottieFillShape(firstRun?.color ?? [0, 0, 0], firstRun?.opacity ?? 100),
      createLottieTransformShape(),
    ];
    return {
      it: items,
      np: items.length,
      ty: "gr",
    };
  });
};

const createLottieLayer = ({
  frame,
  frameIndex,
  holdFrames,
  scaleFactor,
}: {
  frame: AnimationFrame;
  frameIndex: number;
  holdFrames: number;
  scaleFactor: number;
}) => ({
  ddd: 0,
  ind: frameIndex + 1,
  ip: frameIndex * holdFrames,
  ks: createLottieLayerTransform(),
  op: (frameIndex + 1) * holdFrames,
  shapes: createGroupedRectRunShapes(createRectRuns(frame, scaleFactor), frameIndex),
  sr: 1,
  st: 0,
  ty: 4,
});

const unitToByte = (value: number) =>
  Math.round(Math.max(0, Math.min(1, value)) * 255);

const byteToHex = (value: number) =>
  unitToByte(value).toString(16).padStart(2, "0");

const lottieFillToSvgAttributes = (run: LottieRectRun) => {
  const fill = `#${byteToHex(run.color[0] ?? 0)}${byteToHex(
    run.color[1] ?? 0
  )}${byteToHex(run.color[2] ?? 0)}`;
  const opacity = Math.max(0, Math.min(100, run.opacity)) / 100;
  return opacity >= 1
    ? `fill="${fill}"`
    : `fill="${fill}" fill-opacity="${Number(opacity.toFixed(3))}"`;
};

const rectRunToSvgSubpath = (run: LottieRectRun) =>
  `M${run.x} ${run.y}h${run.width}v${run.height}h${-run.width}z`;

export const frameToSvgPaths = (frame: AnimationFrame, scaleFactor: number) => {
  const groups = new Map<string, LottieRectRun[]>();
  for (const run of createRectRuns(frame, scaleFactor)) {
    const key = lottieColorKey(run);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()]
    .map((runs) => {
      const [firstRun] = runs;
      if (!firstRun) {
        return "";
      }
      return `<path ${lottieFillToSvgAttributes(firstRun)} d="${runs
        .map(rectRunToSvgSubpath)
        .join("")}" />`;
    })
    .filter(Boolean)
    .join("\n");
};

export const frameToSvgRects = frameToSvgPaths;

export const createSvgExport = (
  frames: AnimationFrame[],
  scaleFactor: number,
  fps = Math.round(1000 / playbackIntervalMs)
) => {
  const [firstFrame] = frames;
  if (!firstFrame) {
    return "";
  }
  const frameWidth = firstFrame.size.width * scaleFactor;
  const frameHeight = firstFrame.size.height * scaleFactor;
  const frameDurationMs = fpsToFrameDurationMs(fps);
  const durationMs = frames.length * frameDurationMs;
  const frameGroups = frames
    .map((frame, index) => {
      const visible = frames.length === 1 ? "inline" : "none";
      const animation =
        frames.length === 1
          ? ""
          : `<set attributeName="display" to="inline" begin="${index * frameDurationMs}ms; animation.end+${index * frameDurationMs}ms" dur="${frameDurationMs}ms" />`;
      return `<g display="${visible}">
${animation}
${frameToSvgPaths(frame, scaleFactor)}
</g>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frameWidth}" height="${frameHeight}" viewBox="0 0 ${frameWidth} ${frameHeight}" shape-rendering="crispEdges">
${frames.length > 1 ? `<animate id="animation" attributeName="visibility" from="visible" to="visible" dur="${durationMs}ms" repeatCount="indefinite" />` : ""}
${frameGroups}
</svg>
`;
};

export const createSavedAnimationJson = (
  frames: AnimationFrame[],
  scaleFactor: number,
  format: ExportFormat,
  scope: ExportScope,
  fps = Math.round(1000 / playbackIntervalMs)
) => {
  const exportFrames =
    format === "json" ? prepareJsonExportFrames(frames) : frames;
  const [firstFrame] = exportFrames;
  const exportScale =
    format === "json" && firstFrame
      ? computeJsonExportScale(frames[0]?.size ?? firstFrame.size)
      : scaleFactor;

  return JSON.stringify(
    {
      canvas: firstFrame?.size ?? { height: 0, width: 0 },
      createdAt: new Date().toISOString(),
      format,
      fps,
      frames: exportFrames.map((frame, index) => ({
        grid: frame.grid,
        id: frame.id,
        index,
        size: frame.size,
      })),
      scale: exportScale,
      schemaVersion: "ui-export.v1",
      scope,
      ...(format === "json"
        ? { targetMaxSize: JSON_EXPORT_MAX_SIZE }
        : {}),
    },
    null,
    2
  );
};

export const getExportFramesForScope = (
  frames: AnimationFrame[],
  selectedFrameId: string,
  scope: ExportScope
) => {
  if (scope === "animation") {
    return frames;
  }
  const selectedFrame = frames.find((frame) => frame.id === selectedFrameId);
  return selectedFrame ? [selectedFrame] : [];
};

export const getExportDialogFrames = (
  previewFrames: AnimationFrame[],
  frames: AnimationFrame[]
) => (previewFrames.length > 0 ? previewFrames : frames);

export const createReactExport = (
  frames: AnimationFrame[],
  scaleFactor: number,
  fps = Math.round(1000 / playbackIntervalMs)
) => {
  const json = createSavedAnimationJson(
    frames,
    scaleFactor,
    "react",
    "animation",
    fps
  );
  return `import React from "react";

const animation = ${json};

export function PixelAnimation() {
  const frame = animation.frames[0];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: \`repeat(\${frame.size.width}, ${scaleFactor}px)\`,
        imageRendering: "pixelated",
      }}
    >
      {frame.grid.map((color, index) => (
        <span
          key={index}
          style={{
            width: ${scaleFactor},
            height: ${scaleFactor},
            background: color ?? "transparent",
          }}
        />
      ))}
    </div>
  );
}
`;
};

// Bodymovin-TG uses 100 for opaque fills and a 0-1 fraction for partial opacity.
const tgsFillOpacity = (opacity: number) => {
  if (opacity >= 100) {
    return 100;
  }
  const fraction = opacity > 1 ? opacity / 100 : opacity;
  return Math.round(fraction * 10) / 10;
};

const createTgsRectShape = (run: LottieRectRun, rectIndex: number) => ({
  ty: "rc",
  d: 1,
  s: lottieStaticVector2(run.width, run.height),
  p: lottieStaticVector2(run.x + run.width / 2, run.y + run.height / 2),
  r: lottieStaticScalar(0),
  nm: `Rectangle Path ${rectIndex}`,
  hd: false,
});

const createTgsFillShape = (color: number[], opacity: number) => ({
  ty: "fl",
  c: lottieStaticColor([color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, 1]),
  o: lottieStaticScalar(tgsFillOpacity(opacity)),
  r: 1,
  bm: 0,
  nm: "Fill 1",
  hd: false,
});

const createTgsTransformShape = () => ({
  ty: "tr",
  p: lottieStaticVector2(0, 0),
  a: lottieStaticVector2(0, 0),
  s: lottieStaticVector2(100, 100),
  r: lottieStaticScalar(0),
  o: lottieStaticScalar(100),
  sk: lottieStaticScalar(0),
  sa: lottieStaticScalar(0),
  nm: "Transform",
});

const createTgsGroupedRectRunShapes = (runs: LottieRectRun[]) => {
  if (runs.length === 0) {
    return [];
  }
  const groups = new Map<string, LottieRectRun[]>();
  for (const run of runs) {
    const key = lottieColorKey(run);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((colorRuns, colorIndex) => {
    const [firstRun] = colorRuns;
    let rectIndex = 1;
    const items = [
      ...colorRuns.map((run) => createTgsRectShape(run, rectIndex++)),
      createTgsFillShape(firstRun?.color ?? [0, 0, 0], firstRun?.opacity ?? 100),
      createTgsTransformShape(),
    ];
    return {
      ty: "gr",
      it: items,
      nm: `Group ${colorIndex + 1}`,
      bm: 0,
      hd: false,
    };
  });
};

const createTgsLayer = ({
  frame,
  frameIndex,
  frameCount,
  holdFrames,
  scaleFactor,
}: {
  frame: AnimationFrame;
  frameIndex: number;
  frameCount: number;
  holdFrames: number;
  scaleFactor: number;
}) => ({
  ddd: 0,
  ind: frameIndex + 1,
  ty: 4,
  nm: `Shape Layer ${frameCount - frameIndex}`,
  sr: 1,
  ks: {},
  ao: 0,
  shapes: createTgsGroupedRectRunShapes(createRectRuns(frame, scaleFactor)),
  ip: frameIndex * holdFrames,
  op: (frameIndex + 1) * holdFrames,
  st: 0,
  bm: 0,
});

export const buildTgsLottieDocument = (
  frames: AnimationFrame[],
  sourceFps = Math.round(1000 / playbackIntervalMs)
) => {
  const [frame] = frames;
  const roundedSourceFps = Math.max(1, Math.round(sourceFps));
  const holdFrames = computeLottieFrameHold(roundedSourceFps);
  const totalFrames = Math.max(1, frames.length * holdFrames);
  const tgsScale = frame ? computeJsonExportScale(frame.size) : 1;

  return {
    tgs: 1,
    v: TGS_LOTTIE_VERSION,
    fr: LOTTIE_EXPORT_FPS,
    ip: 0,
    op: totalFrames,
    w: (frame?.size.width ?? 1) * tgsScale,
    h: (frame?.size.height ?? 1) * tgsScale,
    nm: "Pixel Animation",
    ddd: 0,
    assets: [] as [],
    layers: frames.map((item, frameIndex) =>
      createTgsLayer({
        frame: item,
        frameCount: frames.length,
        frameIndex,
        holdFrames,
        scaleFactor: tgsScale,
      })
    ),
  };
};

const gzipUtf8Json = async (payload: unknown): Promise<Uint8Array> => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (typeof CompressionStream !== "undefined") {
    const compressed = await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer();
    return new Uint8Array(compressed);
  }
  throw new Error("TGS export requires browser gzip support.");
};

export const createTgsExportBlob = async (
  frames: AnimationFrame[],
  _scaleFactor: number,
  sourceFps = Math.round(1000 / playbackIntervalMs)
): Promise<Blob> => {
  const document = buildTgsLottieDocument(frames, sourceFps);
  const bytes = await gzipUtf8Json(document);
  if (bytes.length > TGS_EXPORT_MAX_BYTES) {
    throw new Error(
      `TGS export exceeds ${TGS_EXPORT_MAX_BYTES} bytes (${bytes.length}). Reduce frames or colors.`
    );
  }
  return new Blob([Uint8Array.from(bytes)], { type: "application/x-tgsticker" });
};

export const createLottieExport = (
  frames: AnimationFrame[],
  _scaleFactor: number,
  sourceFps = Math.round(1000 / playbackIntervalMs)
) => {
  const [frame] = frames;
  const roundedSourceFps = Math.max(1, Math.round(sourceFps));
  const holdFrames = computeLottieFrameHold(roundedSourceFps);
  const totalFrames = Math.max(1, frames.length * holdFrames);
  const lottieScale = frame ? computeJsonExportScale(frame.size) : 1;
  const width = (frame?.size.width ?? 1) * lottieScale;
  const height = (frame?.size.height ?? 1) * lottieScale;

  return JSON.stringify({
    assets: [],
    fr: LOTTIE_EXPORT_FPS,
    h: height,
    ip: 0,
    layers: frames.map((item, frameIndex) =>
      createLottieLayer({
        frame: item,
        frameIndex,
        holdFrames,
        scaleFactor: lottieScale,
      })
    ),
    markers: [
      {
        cm: `retrodex sourceFps=${roundedSourceFps} exportFps=${LOTTIE_EXPORT_FPS} frameHold=${holdFrames} pixelScale=${lottieScale}`,
        dr: 0,
        tm: 0,
      },
    ],
    nm: "Pixel Animation",
    op: totalFrames,
    v: "5.12.0",
    w: width,
  });
};
