import { GIFEncoder, applyPalette, quantize } from "gifenc";

import { fpsToFrameDurationMs, playbackIntervalMs } from "../constants";
import type { AnimationFrame } from "../types";

export const drawFramePixels = (
  context: CanvasRenderingContext2D,
  frame: AnimationFrame,
  scaleFactor: number
) => {
  context.imageSmoothingEnabled = false;
  for (let y = 0; y < frame.size.height; y += 1) {
    for (let x = 0; x < frame.size.width; x += 1) {
      const color = frame.grid[y * frame.size.width + x];
      if (color) {
        context.fillStyle = color;
        context.fillRect(
          x * scaleFactor,
          y * scaleFactor,
          scaleFactor,
          scaleFactor
        );
      }
    }
  }
};

export const createFrameCanvas = (
  frame: AnimationFrame,
  scaleFactor: number
) => {
  const canvas = document.createElement("canvas");
  canvas.width = frame.size.width * scaleFactor;
  canvas.height = frame.size.height * scaleFactor;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawFramePixels(context, frame, scaleFactor);
  }
  return canvas;
};

export const createStripCanvas = (
  frames: AnimationFrame[],
  scaleFactor: number
) => {
  const [firstFrame] = frames;
  const canvas = document.createElement("canvas");
  if (!firstFrame) {
    canvas.width = 1;
    canvas.height = 1;
    return canvas;
  }
  canvas.width = firstFrame.size.width * frames.length * scaleFactor;
  canvas.height = firstFrame.size.height * scaleFactor;
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  context.imageSmoothingEnabled = false;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const frameCanvas = createFrameCanvas(frame, scaleFactor);
    context.drawImage(frameCanvas, index * frame.size.width * scaleFactor, 0);
  }
  return canvas;
};

export const createCssExport = (
  frames: AnimationFrame[],
  scaleFactor: number,
  fps = Math.round(1000 / playbackIntervalMs)
) => {
  const strip = createStripCanvas(frames, scaleFactor);
  const dataUrl = strip.toDataURL("image/png");
  const [frame] = frames;
  const frameWidth = (frame?.size.width ?? 1) * scaleFactor;
  const frameHeight = (frame?.size.height ?? 1) * scaleFactor;
  return `.pixel-animation {
  width: ${frameWidth}px;
  height: ${frameHeight}px;
  background-image: url("${dataUrl}");
  background-size: ${strip.width}px ${strip.height}px;
  image-rendering: pixelated;
  animation: pixel-animation ${frames.length * fpsToFrameDurationMs(fps)}ms steps(${frames.length}) infinite;
}

@keyframes pixel-animation {
  from { background-position-x: 0; }
  to { background-position-x: -${strip.width}px; }
}
`;
};

export const createGifBlob = (
  frames: AnimationFrame[],
  scaleFactor: number,
  fps = Math.round(1000 / playbackIntervalMs)
) => {
  const frameDurationMs = fpsToFrameDurationMs(fps);
  const encoder = GIFEncoder();
  for (const frame of frames) {
    const canvas = createFrameCanvas(frame, scaleFactor);
    const context = canvas.getContext("2d");
    if (!context) {
      continue;
    }
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const palette = quantize(rgba, 256);
    const indexed = applyPalette(rgba, palette);
    encoder.writeFrame(indexed, canvas.width, canvas.height, {
      delay: frameDurationMs,
      palette,
    });
  }
  encoder.finish();
  const bytes = new Uint8Array(encoder.bytes());
  return new Blob([bytes.buffer], { type: "image/gif" });
};

const webmMimeTypes = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

const delay = (durationMs: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, durationMs);
  });

export const createWebmBlob = async (
  frames: AnimationFrame[],
  scaleFactor: number,
  fps = Math.round(1000 / playbackIntervalMs)
) => {
  const [firstFrame] = frames;
  if (!firstFrame) {
    throw new Error("Cannot export WebM without frames.");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("This browser does not support WebM recording.");
  }
  const mimeType = webmMimeTypes.find((type) =>
    MediaRecorder.isTypeSupported(type)
  );
  if (!mimeType) {
    throw new Error("This browser does not expose a supported WebM codec.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = firstFrame.size.width * scaleFactor;
  canvas.height = firstFrame.size.height * scaleFactor;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a canvas context for WebM export.");
  }
  context.imageSmoothingEnabled = false;

  const frameDurationMs = fpsToFrameDurationMs(fps);
  const frameRate = Math.max(1, Math.round(fps));
  const stream = canvas.captureStream(frameRate);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: BlobPart[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener("error", () => {
      reject(new Error("WebM recording failed."));
    });
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });

  recorder.start();
  for (const frame of frames) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawFramePixels(context, frame, scaleFactor);
    await delay(frameDurationMs);
  }
  recorder.stop();
  for (const track of stream.getTracks()) {
    track.stop();
  }
  await stopped;
  return new Blob(chunks, { type: mimeType });
};
