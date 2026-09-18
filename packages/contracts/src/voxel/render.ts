import type { VoxelModel, VoxelProjection } from "./model";
import { voxelRenderSchema } from "./model";
import { voxelNormals, voxelSurface } from "./core";
import type { VoxelFace } from "./core";

// Shared CPU rasterizer: same palette, orthographic camera and pixel-center sampling
// in the browser and agent API. Depth and face IDs also provide exact picking.
export function renderVoxelModel(
  model: VoxelModel,
  input: unknown = {},
  surface?: VoxelFace[],
) {
  const options = voxelRenderSchema.parse(input);
  const { width, height, yaw, pitch, zoom, panX, panY } = options;
  const a = (yaw * Math.PI) / 180,
    b = (pitch * Math.PI) / 180;
  const right = [Math.cos(a), 0, -Math.sin(a)];
  const up = [
    -Math.sin(a) * Math.sin(b),
    Math.cos(b),
    -Math.cos(a) * Math.sin(b),
  ];
  const eye = [
    Math.sin(a) * Math.cos(b),
    Math.sin(b),
    Math.cos(a) * Math.cos(b),
  ];
  const dot = (v: readonly number[], w: number[]) =>
    v[0]! * w[0]! + v[1]! * w[1]! + v[2]! * w[2]!;
  // Fixed cube framing across all directions; no per-frame bounding-box jitter.
  const scale =
    ((Math.min(width, height) - 2) * zoom) / (model.size * Math.sqrt(3));
  const project = (v: number[]) => {
    const p = v.map((c) => c - model.size / 2);
    return [
      width / 2 + panX + dot(p, right) * scale,
      height / 2 + panY - dot(p, up) * scale,
      dot(p, eye),
    ];
  };
  const cells: (string | null)[] = Array(width * height).fill(null);
  const depth = new Float64Array(width * height).fill(-Infinity);
  const hits = new Int32Array(width * height).fill(-1);
  const edge = (p: number[], q: number[], x: number, y: number) =>
    (x - p[0]!) * (q[1]! - p[1]!) - (y - p[1]!) * (q[0]! - p[0]!);
  const la = (options.lightYaw * Math.PI) / 180,
    lb = (options.lightPitch * Math.PI) / 180;
  const light = [
    Math.sin(la) * Math.cos(lb),
    Math.sin(lb),
    Math.cos(la) * Math.cos(lb),
  ];
  for (const f of surface ?? voxelSurface(model)) {
    if (dot(voxelNormals[f.face]!, eye) <= 1e-8) continue;
    const v = f.vertices.map(project);
    const intensity = options.shading
      ? 0.4 + 0.6 * Math.max(0, dot(voxelNormals[f.face]!, light))
      : 1;
    const shaded =
      intensity === 1
        ? f.color
        : "#" +
          [1, 3, 5]
            .map((i) =>
              Math.round(parseInt(f.color.slice(i, i + 2), 16) * intensity)
                .toString(16)
                .padStart(2, "0"),
            )
            .join("");
    for (const ids of [
      [0, 1, 2],
      [0, 2, 3],
    ]) {
      const p = v[ids[0]!]!,
        q = v[ids[1]!]!,
        r = v[ids[2]!]!;
      const area = edge(p, q, r[0]!, r[1]!);
      if (Math.abs(area) < 1e-10) continue;
      const x0 = Math.max(0, Math.floor(Math.min(p[0]!, q[0]!, r[0]!))),
        x1 = Math.min(width - 1, Math.ceil(Math.max(p[0]!, q[0]!, r[0]!)));
      const y0 = Math.max(0, Math.floor(Math.min(p[1]!, q[1]!, r[1]!))),
        y1 = Math.min(height - 1, Math.ceil(Math.max(p[1]!, q[1]!, r[1]!)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const w0 = edge(q, r, x + 0.5, y + 0.5) / area,
            w1 = edge(r, p, x + 0.5, y + 0.5) / area,
            w2 = 1 - w0 - w1;
          if (Math.min(w0, w1, w2) < -1e-8) continue;
          const d = w0 * p[2]! + w1 * q[2]! + w2 * r[2]!,
            i = x + y * width;
          if (d > depth[i]!) {
            depth[i] = d;
            const border =
              options.edges &&
              v.some((p, j) => {
                const q = v[(j + 1) % 4]!;
                return (
                  Math.abs(edge(p, q, x + 0.5, y + 0.5)) /
                    Math.max(1e-8, Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!)) <
                  0.45
                );
              });
            cells[i] = border ? options.outlineColor : shaded;
            hits[i] = f.voxel * 6 + f.face;
          }
        }
    }
  }
  if (options.outline) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = x + y * width;
        if (hits[i] !== -1) continue;
        if (
          (x > 0 && hits[i - 1] !== -1) ||
          (x + 1 < width && hits[i + 1] !== -1) ||
          (y > 0 && hits[i - width] !== -1) ||
          (y + 1 < height && hits[i + width] !== -1)
        )
          cells[i] = options.outlineColor;
      }
  }
  if (options.background)
    for (let i = 0; i < cells.length; i++)
      if (cells[i] === null) cells[i] = options.background;
  return { width, height, cells, hits };
}
export function renderVoxelDirections(
  model: VoxelModel,
  input: unknown,
): VoxelProjection[] {
  const options = voxelRenderSchema.parse(input),
    surface = voxelSurface(model);
  return Array.from({ length: options.directions }, (_, i) => {
    const { hits, ...grid } = renderVoxelModel(
      model,
      { ...options, yaw: options.yaw + (i * 360) / options.directions },
      surface,
    );
    return grid;
  });
}
