import { rgbToHex } from "./color";
import type { PaletteEntry } from "./types";

export const extractPalette = (image: HTMLImageElement): PaletteEntry[] => {
  const sampleSize = 96;
  const ratio = Math.min(
    sampleSize / image.naturalWidth,
    sampleSize / image.naturalHeight,
    1
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const context = canvas.getContext("2d");
  if (!context) {
    return [];
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const counts = new Map<string, number>();
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 16) {
      continue;
    }
    const color = rgbToHex(data[index], data[index + 1], data[index + 2]);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const paletteEntries = [...counts.entries()].map(([color, count]) => ({
    color,
    count,
  }));
  paletteEntries.sort((a, b) => b.count - a.count);
  return paletteEntries.slice(0, 32);
};
