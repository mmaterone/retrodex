import { describe, it, expect } from "vitest";
import {
  composeSheet,
  splitOrtho,
  encodeGIF,
  nativeProjectionCells,
  storedZip,
} from "./voxel-files";
import type { VoxelProjection } from "@retrodex/contracts";
const frame = (color: string): VoxelProjection => ({
  width: 2,
  height: 2,
  cells: [color, null, null, color],
});
describe("3D export layouts", () => {
  it("round-trips six oriented views without scaling or flipped pixels", () => {
    const frames = [
        "#110000",
        "#220000",
        "#330000",
        "#440000",
        "#550000",
        "#660000",
      ].map(frame),
      sheet = composeSheet(frames),
      views = splitOrtho(sheet);
    expect(sheet.width).toBe(12);
    expect([
      views.front,
      views.right,
      views.back,
      views.left,
      views.top,
      views.bottom,
    ]).toEqual(frames);
  });
  it("places sixteen directions into Pixzels-compatible RPG Maker blocks", () => {
    const frames = Array.from({ length: 16 }, (_, i) =>
        frame("#" + (i + 1).toString(16).padStart(6, "0")),
      ),
      sheet = composeSheet(frames, true);
    expect(sheet.width).toBe(24);
    expect(sheet.height).toBe(16);
    frames.forEach((f, i) => {
      for (let k = 0; k < 3; k++) {
        const x = (Math.floor(i / 4) * 3 + k) * 2,
          y = (i % 4) * 2;
        expect(sheet.cells[x + y * sheet.width]).toBe(f.cells[0]);
        expect(sheet.cells[x + 1 + y * sheet.width]).toBeNull();
      }
    });
    expect(sheet.cells.slice(sheet.width * 8).every((c) => c === null)).toBe(
      true,
    );
  });
  it("encodes animated transparent GIFs with loop and disposal controls", () => {
    const bytes = encodeGIF([frame("#ff0000"), frame("#00ff00")], 8);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.slice(0, 6)).toBe("GIF89a");
    expect(text).toContain("NETSCAPE2.0");
    expect(bytes.at(-1)).toBe(0x3b);
    const controls = [];
    for (let i = 0; i < bytes.length - 7; i++)
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 4)
        controls.push(bytes.slice(i, i + 8));
    expect(controls).toHaveLength(2);
    for (const c of controls) {
      expect(c[3]! & 1).toBe(1);
      expect((c[3]! >> 2) & 7).toBe(2);
      expect(c[6]).toBe(0);
    }
  });
});

it("normalizes sampled 2D colors exactly and rejects partial alpha", () => {
  expect(
    nativeProjectionCells([
      "rgba(255, 128, 0, 1)",
      "#AABBCC",
      null,
      "rgba(0,0,0,0)",
    ]),
  ).toEqual(["#ff8000", "#aabbcc", null, null]);
  expect(() => nativeProjectionCells(["rgba(0,0,0,0.5)"])).toThrow(
    /partial alpha/,
  );
});
it("bundles model files with CRC and central directory entries", () => {
  const zip = storedZip([
      { name: "model.obj", bytes: new TextEncoder().encode("v 1 2 3") },
    ]),
    view = new DataView(zip.buffer);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint16(26, true)).toBe(9);
  expect(new TextDecoder().decode(zip.slice(30, 39))).toBe("model.obj");
  expect(new TextDecoder().decode(zip.slice(39, 46))).toBe("v 1 2 3");
  expect(view.getUint32(46, true)).toBe(0x02014b50);
  expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
  expect(view.getUint32(zip.length - 6, true)).toBe(46);
});
