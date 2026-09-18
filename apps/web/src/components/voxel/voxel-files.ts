import { GIFEncoder, quantize, applyPalette } from "gifenc";
import type { VoxelProjection } from "@retrodex/contracts";

export function download(
  name: string,
  content: Blob | string,
  type = "application/json",
) {
  const url = URL.createObjectURL(
    content instanceof Blob ? content : new Blob([content], { type }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function paintCanvas(canvas: HTMLCanvasElement, grid: VoxelProjection) {
  canvas.width = grid.width;
  canvas.height = grid.height;
  const ctx = canvas.getContext("2d")!,
    data = ctx.createImageData(grid.width, grid.height);
  grid.cells.forEach((c, i) => {
    if (c) {
      [1, 3, 5].forEach(
        (j, k) => (data.data[i * 4 + k] = parseInt(c.slice(j, j + 2), 16)),
      );
      data.data[i * 4 + 3] = 255;
    }
  });
  ctx.putImageData(data, 0, 0);
}
export async function savePNG(name: string, grid: VoxelProjection) {
  const c = document.createElement("canvas");
  paintCanvas(c, grid);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve));
  if (!blob) throw new Error("PNG encoding failed.");
  download(name, blob);
}
export function composeSheet(
  frames: VoxelProjection[],
  rpg = false,
): VoxelProjection {
  const w = frames[0]!.width,
    h = frames[0]!.height,
    width = w * (rpg ? 12 : frames.length),
    height = h * (rpg ? 8 : 1),
    cells: (string | null)[] = Array(width * height).fill(null);
  frames.forEach((f, i) => {
    const col = rpg ? Math.floor(i / 4) * 3 : i,
      row = rpg ? i % 4 : 0;
    for (let repeat = 0; repeat < (rpg ? 3 : 1); repeat++)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          cells[(col + repeat) * w + x + (row * h + y) * width] =
            f.cells[x + y * w]!;
  });
  return { width, height, cells };
}
export function encodeGIF(frames: VoxelProjection[], fps: number) {
  const encoder = GIFEncoder();
  for (const f of frames) {
    const data = new Uint8Array(f.width * f.height * 4);
    f.cells.forEach((c, i) => {
      if (c) {
        [1, 3, 5].forEach(
          (j, k) => (data[i * 4 + k] = parseInt(c.slice(j, j + 2), 16)),
        );
        data[i * 4 + 3] = 255;
      }
    });
    // Reserve palette index zero for transparency; quantize only visible colors.
    const visible = new Uint8Array(f.cells.filter(Boolean).length * 4);
    let j = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3]) {
        visible.set(data.subarray(i, i + 4), j);
        j += 4;
      }
    const colors = visible.length ? quantize(visible, 255) : [[0, 0, 0]],
      palette = [[0, 0, 0], ...colors];
    const indices = applyPalette(data, colors);
    for (let i = 0; i < indices.length; i++)
      indices[i] = data[i * 4 + 3] ? indices[i]! + 1 : 0;
    encoder.writeFrame(indices, f.width, f.height, {
      palette,
      delay: 1000 / fps,
      transparent: true,
      transparentIndex: 0,
      dispose: 2,
      repeat: 0,
    });
  }
  encoder.finish();
  return new Uint8Array(encoder.bytes());
}
export function saveGIF(frames: VoxelProjection[], fps: number) {
  download(
    "retrodex-turntable.gif",
    new Blob([encodeGIF(frames, fps)], { type: "image/gif" }),
  );
}
export async function readProjection(
  file: Blob,
  strictAlpha = true,
  atlas = false,
): Promise<VoxelProjection> {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width !== bitmap.height * (atlas ? 6 : 1) || bitmap.height > 128)
      throw new Error(
        atlas
          ? "ORTHO must contain six square views in one row, up to 128 pixels each."
          : "Use a square native image up to 128 × 128. Clean ImageGen output first.",
      );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
      cells: (string | null)[] = [];
    for (let i = 0; i < data.length; i += 4) {
      if (strictAlpha && data[i + 3] !== 0 && data[i + 3] !== 255)
        throw new Error("Clean partial alpha before reconstruction.");
      cells.push(
        data[i + 3] === 0
          ? null
          : "#" +
              [data[i], data[i + 1], data[i + 2]]
                .map((v) => v!.toString(16).padStart(2, "0"))
                .join(""),
      );
    }
    return { width: bitmap.width, height: bitmap.height, cells };
  } finally {
    bitmap.close();
  }
}
export function splitOrtho(grid: VoxelProjection) {
  const n = grid.height;
  return Object.fromEntries(
    (["front", "right", "back", "left", "top", "bottom"] as const).map(
      (view, i) => [
        view,
        {
          width: n,
          height: n,
          cells: Array.from(
            { length: n * n },
            (_, p) =>
              grid.cells[i * n + (p % n) + Math.floor(p / n) * grid.width]!,
          ),
        },
      ],
    ),
  );
}

/** Normalize the 2D editor's sampled RGBA pixels without changing alpha. */
export function nativeProjectionCells(
  cells: (string | null)[],
): (string | null)[] {
  return cells.map((c) => {
    if (!c) return null;
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    const m =
      /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
        c,
      );
    if (!m) throw new Error("Unsupported frame color. Use opaque RGB pixels.");
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    if (alpha === 0) return null;
    if (alpha !== 1)
      throw new Error(
        "Frame has partial alpha. Clean transparency before using it as a projection.",
      );
    const rgb = m.slice(1, 4).map(Number);
    if (rgb.some((v) => v > 255)) throw new Error("Invalid RGB frame color.");
    return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
  });
}
/** Stored ZIP writer, same CRC/header layout as Retrodex's backend share bundle. */
export function storedZip(
  entries: { name: string; bytes: Uint8Array }[],
): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  const text = new TextEncoder();
  for (const e of entries) {
    const name = text.encode(e.name);
    let crc = 0xffffffff;
    for (const b of e.bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30),
      l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x800, true);
    l.setUint16(12, 33, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, e.bytes.length, true);
    l.setUint32(22, e.bytes.length, true);
    l.setUint16(26, name.length, true);
    parts.push(local, name, e.bytes);
    const header = new Uint8Array(46),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 20, true);
    h.setUint16(8, 0x800, true);
    h.setUint16(14, 33, true);
    h.setUint32(16, crc, true);
    h.setUint32(20, e.bytes.length, true);
    h.setUint32(24, e.bytes.length, true);
    h.setUint16(28, name.length, true);
    h.setUint32(42, offset, true);
    central.push(header, name);
    offset += local.length + name.length + e.bytes.length;
  }
  const length = central.reduce((n, p) => n + p.length, 0),
    end = new Uint8Array(22),
    v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, length, true);
  v.setUint32(16, offset, true);
  const output = new Uint8Array(offset + length + 22);
  let i = 0;
  for (const p of [...parts, ...central, end]) {
    output.set(p, i);
    i += p.length;
  }
  return output;
}
export async function textureBundle(output: {
  obj: string;
  mtl: string;
  texture: VoxelProjection;
  manifest: unknown;
}) {
  const c = document.createElement("canvas");
  paintCanvas(c, output.texture);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve));
  if (!blob) throw new Error("Texture encoding failed.");
  const text = new TextEncoder();
  download(
    "retrodex-model.zip",
    new Blob(
      [
        storedZip([
          { name: "model.obj", bytes: text.encode(output.obj) },
          { name: "model.mtl", bytes: text.encode(output.mtl) },
          {
            name: "model.png",
            bytes: new Uint8Array(await blob.arrayBuffer()),
          },
          {
            name: "manifest.json",
            bytes: text.encode(JSON.stringify(output.manifest, null, 2)),
          },
        ]),
      ],
      { type: "application/zip" },
    ),
  );
}
