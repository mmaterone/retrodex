import { fpsToFrameDurationMs, playbackIntervalMs } from "../constants";
import type { AnimationFrame, ExportFormat, ExportScope } from "../types";

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

const colorToLottieFill = (color: string) => {
  const match = rgbaColorPattern.exec(color.trim());
  if (match) {
    const red = componentToUnit(Number(match[1]));
    const green = componentToUnit(Number(match[2]));
    const blue = componentToUnit(Number(match[3]));
    const alpha =
      match[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(match[4])));
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

const createGroupedRectRunShapes = (
  runs: LottieRectRun[],
  frameIndex: number
) => {
  const groups = new Map<string, LottieRectRun[]>();
  for (const run of runs) {
    const key = lottieColorKey(run);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((colorRuns, colorIndex) => {
    const [firstRun] = colorRuns;
    return {
      it: [
        ...colorRuns.map((run) => ({
          p: { k: [run.x + run.width / 2, run.y + run.height / 2] },
          r: { k: 0 },
          s: { k: [run.width, run.height] },
          ty: "rc",
        })),
        {
          c: { k: firstRun?.color ?? [0, 0, 0] },
          o: { k: firstRun?.opacity ?? 100 },
          ty: "fl",
        },
        { p: { k: [0, 0] }, ty: "tr" },
      ],
      nm: `color-${frameIndex + 1}-${colorIndex + 1}`,
      ty: "gr",
    };
  });
};

export const frameToSvgRects = (frame: AnimationFrame, scaleFactor: number) =>
  frame.grid
    .map((color, index) => {
      if (!color) {
        return "";
      }
      const x = (index % frame.size.width) * scaleFactor;
      const y = Math.floor(index / frame.size.width) * scaleFactor;
      return `<rect x="${x}" y="${y}" width="${scaleFactor}" height="${scaleFactor}" fill="${color}" />`;
    })
    .filter(Boolean)
    .join("\n");

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
${frameToSvgRects(frame, scaleFactor)}
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
) =>
  JSON.stringify(
    {
      canvas: frames[0]?.size ?? { height: 0, width: 0 },
      createdAt: new Date().toISOString(),
      format,
      fps,
      frames: frames.map((frame, index) => ({
        grid: frame.grid,
        id: frame.id,
        index,
        size: frame.size,
      })),
      scale: scaleFactor,
      schemaVersion: "ui-export.v1",
      scope,
    },
    null,
    2
  );

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

export const createLottieExport = (
  frames: AnimationFrame[],
  scaleFactor: number,
  fps = Math.round(1000 / playbackIntervalMs)
) => {
  const [frame] = frames;
  const frameRate = Math.max(1, Math.round(fps));
  return JSON.stringify({
    assets: [],
    ddd: 0,
    fr: frameRate,
    h: (frame?.size.height ?? 1) * scaleFactor,
    ip: 0,
    layers: frames.map((item, frameIndex) => ({
      ddd: 0,
      ind: frameIndex + 1,
      ip: frameIndex,
      ks: {
        a: { k: [0, 0, 0] },
        o: { k: 100 },
        p: { k: [0, 0, 0] },
        r: { k: 0 },
        s: { k: [100, 100, 100] },
      },
      nm: `Frame ${frameIndex + 1}`,
      op: frameIndex + 1,
      shapes: createGroupedRectRunShapes(
        createRectRuns(item, scaleFactor),
        frameIndex
      ),
      sr: 1,
      st: 0,
      ty: 4,
    })),
    meta: {
      generator: "retrodex-rect-runs",
      note: "Pixel art is encoded as merged vector rectangle runs.",
    },
    nm: "Pixel Animation",
    op: Math.max(frames.length, 1),
    v: "5.12.0",
    w: (frame?.size.width ?? 1) * scaleFactor,
  });
};
