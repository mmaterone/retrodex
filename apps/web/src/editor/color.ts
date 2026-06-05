import { clamp } from "./grid";
import type { HsvColor } from "./types";

export const rgbToHex = (red: number, green: number, blue: number) =>
  `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;

export const isHexColor = (value: string) =>
  /^#[\da-f]{6}$/iu.test(value.trim());

export const normalizeHexColor = (value: string) => {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return withHash.toLowerCase();
};

export const hexToRgb = (hex: string) => {
  const normalizedColor = normalizeHexColor(hex);
  if (!isHexColor(normalizedColor)) {
    return { b: 17, g: 17, r: 17 };
  }
  const value = normalizedColor.slice(1);
  return {
    b: Number.parseInt(value.slice(4, 6), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    r: Number.parseInt(value.slice(0, 2), 16),
  };
};

export const componentToHex = (value: number) =>
  clamp(Math.round(value), 255).toString(16).padStart(2, "0");

export const rgbToHexColor = (red: number, green: number, blue: number) =>
  `#${componentToHex(red)}${componentToHex(green)}${componentToHex(blue)}`;

export const rgbToHsv = (
  red: number,
  green: number,
  blue: number
): HsvColor => {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }
    hue *= 60;
  }
  return {
    h: hue < 0 ? hue + 360 : hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
};

export const hsvToHexColor = ({ h, s, v }: HsvColor) => {
  const chroma = v * s;
  const hue = h / 60;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const offset = v - chroma;
  let r = chroma;
  let g = 0;
  let b = x;
  if (hue < 1) {
    g = x;
    b = 0;
  } else if (hue < 2) {
    r = x;
    g = chroma;
    b = 0;
  } else if (hue < 3) {
    r = 0;
    g = chroma;
    b = x;
  } else if (hue < 4) {
    r = 0;
    g = x;
    b = chroma;
  } else if (hue < 5) {
    r = x;
    b = chroma;
  }
  return rgbToHexColor(
    (r + offset) * 255,
    (g + offset) * 255,
    (b + offset) * 255
  );
};

export const hexToHsvColor = (hex: string) => {
  const { b, g, r } = hexToRgb(hex);
  return rgbToHsv(r, g, b);
};
