import type { GradientPattern } from "./types";

export const basePixelScale = 20;
export const defaultCanvasSize = { height: 32, width: 32 } as const;
export const defaultColor = "#111111";
export const minZoom = 0.5;
export const maxZoom = 8;
export const minCanvasDimension = 1;
export const maxCanvasDimension = 128;
export const minBrushSize = 1;
export const maxBrushSize = 16;
export const historyLimit = 100;
export const playbackIntervalMs = 160;
export const defaultAnimationFps = 8;
export const minAnimationFps = 1;
export const maxAnimationFps = 60;
export const trackpadPanDeltaLimit = 16;

export const fpsToFrameDurationMs = (fps: number) =>
  Math.max(1, Math.round(1000 / fps));

export const maskLayerColors = [
  "#ff4d6d",
  "#2ec4b6",
  "#3a86ff",
  "#ff9f1c",
  "#8338ec",
  "#ffd166",
] as const;

export const gradientKinds = ["linear", "radial"] as const;
export const gradientPatterns = [
  "bayer",
  "fine",
  "checker",
  "hard",
] as const satisfies readonly GradientPattern[];

export const exportScales = [1, 2, 3, 4, 6, 8] as const;

export const bayer4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

export const bayer8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
] as const;
