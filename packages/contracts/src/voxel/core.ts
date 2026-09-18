import {
  voxelBuildSchema,
  voxelModelSchema,
  voxelOperationSchema,
  voxelViews,
} from "./model";
import type {
  VoxelCell,
  VoxelModel,
  VoxelOperation,
  VoxelProjection,
  VoxelView,
} from "./model";
export const voxelNormals = [
  [0, 0, 1],
  [0, 0, -1],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
] as const;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
export function projectionUV(
  view: VoxelView,
  x: number,
  y: number,
  z: number,
  n: number,
): [number, number] {
  switch (view) {
    case "front":
      return [x, n - 1 - y];
    case "back":
      return [n - 1 - x, n - 1 - y];
    case "left":
      return [z, n - 1 - y];
    case "right":
      return [n - 1 - z, n - 1 - y];
    case "top":
      return [x, z];
    case "bottom":
      return [x, n - 1 - z];
  }
}
function indexColor(palette: string[], color: string): number {
  const normalized = color.toLowerCase();
  const found = palette.indexOf(normalized);
  if (found >= 0) return found;
  if (palette.length >= 65536)
    throw new Error(
      "Palette exceeds 65536 colors. Clean and share the projection palette first.",
    );
  palette.push(normalized);
  return palette.length - 1;
}
export function buildVoxelModel(input: unknown): VoxelModel {
  const {
    size: n,
    projections,
    singleViewDepth,
  } = voxelBuildSchema.parse(input);
  const entries = voxelViews.filter((v) => projections[v]);
  const palette: string[] = [];
  const voxels: VoxelCell[] = [];
  const first = entries[0]!;
  const low = Math.floor((n - singleViewDepth) / 2);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (entries.length === 1) {
          const depth =
            first === "front" || first === "back"
              ? z
              : first === "left" || first === "right"
                ? x
                : y;
          if (depth < low || depth >= low + singleViewDepth) continue;
        }
        const sampled: Partial<Record<VoxelView, string>> = {};
        let occupied = true;
        for (const view of entries) {
          const p = projections[view]!;
          const [u, v] = projectionUV(view, x, y, z, n);
          const c = p.cells[u + v * n];
          if (!c) {
            occupied = false;
            break;
          }
          sampled[view] = c;
        }
        if (!occupied) continue;
        const fallback = sampled[first]!;
        const colors = voxelViews.map((view, i) =>
          indexColor(
            palette,
            sampled[view] ?? sampled[voxelViews[i ^ 1]!] ?? fallback,
          ),
        ) as VoxelCell["colors"];
        voxels.push({ x, y, z, colors });
      }
  return {
    version: 1,
    size: n,
    palette: palette.length ? palette : ["#ffffff"],
    voxels,
    projections,
    recipe: { algorithm: "silhouette-intersection-v1", singleViewDepth },
  };
}
export function applyVoxelOperation(
  model: VoxelModel,
  input: VoxelOperation,
): VoxelModel {
  const op = voxelOperationSchema.parse(input);
  const palette = [...model.palette];
  const cells = new Map(model.voxels.map((v) => [key(v.x, v.y, v.z), v]));
  const check = (p: { x: number; y: number; z: number }) => {
    if (Math.max(p.x, p.y, p.z) >= model.size)
      throw new Error("Operation exceeds model bounds.");
  };
  const inside = (
    v: { x: number; y: number; z: number },
    min: typeof v,
    max: typeof v,
  ) =>
    v.x >= min.x &&
    v.x <= max.x &&
    v.y >= min.y &&
    v.y <= max.y &&
    v.z >= min.z &&
    v.z <= max.z;
  if (op.type === "clear") return { ...model, voxels: [], projections: {} };
  if (op.type === "interpolate") {
    const p = projectVoxelModel(model);
    return buildVoxelModel({
      size: model.size,
      projections: {
        front: p.front,
        right: p.right,
        ...(op.views === "front-side-top" ? { top: p.top } : {}),
      },
    });
  }
  if (op.type === "resize") {
    const d =
      op.anchor === "center" ? Math.floor((op.size - model.size) / 2) : 0;
    const voxels = model.voxels.map((v) => ({
      ...v,
      x: v.x + d,
      y: v.y + d,
      z: v.z + d,
    }));
    if (
      voxels.some(
        (v) =>
          Math.min(v.x, v.y, v.z) < 0 || Math.max(v.x, v.y, v.z) >= op.size,
      )
    )
      throw new Error(
        "Resize would crop occupied voxels. Move or delete them first.",
      );
    return {
      ...model,
      size: op.size,
      voxels,
      projections: {},
      recipe: {
        ...model.recipe,
        singleViewDepth: Math.min(op.size, model.recipe.singleViewDepth),
      },
    };
  }
  if (op.type === "fill-plane") {
    check(op.point);
    const n = voxelNormals[voxelViews.indexOf(op.face)]!;
    const axes = (["x", "y", "z"] as const).filter((_, i) => n[i] === 0),
      queue = [op.point],
      visited = new Set<string>(),
      fill: typeof queue = [];
    const min = op.selection?.min ?? { x: 0, y: 0, z: 0 },
      max = op.selection?.max ?? {
        x: model.size - 1,
        y: model.size - 1,
        z: model.size - 1,
      };
    check(min);
    check(max);
    let touchesEdge = false;
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i]!,
        k = key(p.x, p.y, p.z);
      if (
        visited.has(k) ||
        !inside(p, min, max) ||
        (op.regions && !op.regions.some((b) => inside(p, b.min, b.max))) ||
        cells.has(k)
      )
        continue;
      visited.add(k);
      fill.push(p);
      for (const a of axes) {
        if (p[a] === min[a] || p[a] === max[a]) touchesEdge = true;
        for (const d of [-1, 1]) queue.push({ ...p, [a]: p[a] + d });
      }
    }
    if (op.enclosed && touchesEdge)
      throw new Error(
        "Empty region is not enclosed. Draw its border or select a bounded area first.",
      );
    const ci = indexColor(palette, op.color);
    for (const p of fill)
      cells.set(key(p.x, p.y, p.z), { ...p, colors: [ci, ci, ci, ci, ci, ci] });
    return { ...model, palette, voxels: [...cells.values()] };
  }
  if (op.type === "delete" || op.type === "transform") {
    check(op.min);
    check(op.max);
    if (op.min.x > op.max.x || op.min.y > op.max.y || op.min.z > op.max.z)
      throw new Error("Invalid selection bounds.");
    const selected = model.voxels.filter(
      (v) =>
        inside(v, op.min, op.max) &&
        (!op.regions || op.regions.some((b) => inside(v, b.min, b.max))),
    );
    if (op.type === "delete" || !op.copy)
      for (const v of selected) cells.delete(key(v.x, v.y, v.z));
    if (op.type === "transform") {
      const dimensions = {
        x: op.max.x - op.min.x + 1,
        y: op.max.y - op.min.y + 1,
        z: op.max.z - op.min.z + 1,
      };
      const target = op.scale ?? dimensions;
      const origin = {
        x: op.min.x + op.offset.x,
        y: op.min.y + op.offset.y,
        z: op.min.z + op.offset.z,
      };
      if (
        Math.min(origin.x, origin.y, origin.z) < 0 ||
        origin.x + target.x > model.size ||
        origin.y + target.y > model.size ||
        origin.z + target.z > model.size
      )
        throw new Error("Selection transform exceeds model bounds.");
      const source = new Map(selected.map((v) => [key(v.x, v.y, v.z), v]));
      for (let z = 0; z < target.z; z++)
        for (let y = 0; y < target.y; y++)
          for (let x = 0; x < target.x; x++) {
            const v = source.get(
              key(
                op.min.x + Math.floor((x * dimensions.x) / target.x),
                op.min.y + Math.floor((y * dimensions.y) / target.y),
                op.min.z + Math.floor((z * dimensions.z) / target.z),
              ),
            );
            if (v) {
              const q = {
                ...v,
                x: origin.x + x,
                y: origin.y + y,
                z: origin.z + z,
              };
              cells.set(key(q.x, q.y, q.z), q);
            }
          }
    }
  } else if (op.type === "fill") {
    check(op.point);
    const face = voxelViews.indexOf(op.face),
      n = voxelNormals[face]!,
      start = cells.get(key(op.point.x, op.point.y, op.point.z));
    if (!start) throw new Error("Fill target is empty.");
    const target = start.colors[face],
      ci = indexColor(palette, op.color);
    const exposed = (v: VoxelCell) =>
      !cells.has(key(v.x + n[0], v.y + n[1], v.z + n[2]));
    const queue = op.contiguous
      ? [start]
      : model.voxels.filter((v) => v.colors[face] === target && exposed(v));
    const visited = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i]!,
        k = key(v.x, v.y, v.z);
      if (visited.has(k)) continue;
      visited.add(k);
      if (
        v.colors[face] !== target ||
        !exposed(v) ||
        (op.selection && !inside(v, op.selection.min, op.selection.max)) ||
        (op.regions && !op.regions.some((b) => inside(v, b.min, b.max)))
      )
        continue;
      const colors = [...v.colors] as VoxelCell["colors"];
      colors[face] = ci;
      cells.set(k, { ...v, colors });
      if (op.contiguous)
        for (const d of voxelNormals) {
          if (d[0] * n[0] + d[1] * n[1] + d[2] * n[2] !== 0) continue;
          const q = cells.get(key(v.x + d[0], v.y + d[1], v.z + d[2]));
          if (q && !visited.has(key(q.x, q.y, q.z))) queue.push(q);
        }
    }
  } else if (op.type === "mirror") {
    check(op.min);
    check(op.max);
    if (op.min.x > op.max.x || op.min.y > op.max.y || op.min.z > op.max.z)
      throw new Error("Invalid mirror bounds.");
    for (const v of model.voxels)
      if (
        v.x >= op.min.x &&
        v.x <= op.max.x &&
        v.y >= op.min.y &&
        v.y <= op.max.y &&
        v.z >= op.min.z &&
        v.z <= op.max.z
      ) {
        const copy = {
          ...v,
          colors: [...v.colors] as VoxelCell["colors"],
          [op.axis]: model.size - 1 - v[op.axis],
        };
        const f = op.axis === "x" ? 2 : op.axis === "y" ? 4 : 0;
        [copy.colors[f], copy.colors[f + 1]] = [
          copy.colors[f + 1]!,
          copy.colors[f]!,
        ];
        cells.set(key(copy.x, copy.y, copy.z), copy);
      }
  } else {
    const ci =
      (op.type === "set" || op.type === "paint") && op.color !== null
        ? indexColor(palette, op.color)
        : 0;
    for (const p of op.points) {
      check(p);
      const k = key(p.x, p.y, p.z);
      const old = cells.get(k);
      if (op.type === "set") {
        if (op.color === null) cells.delete(k);
        else cells.set(k, { ...p, colors: [ci, ci, ci, ci, ci, ci] });
      }
      if (op.type === "paint") {
        if (!old) throw new Error("Paint target is empty.");
        const colors = [...old.colors] as VoxelCell["colors"];
        if (op.face) colors[voxelViews.indexOf(op.face)] = ci;
        else colors.fill(ci);
        cells.set(k, { ...old, colors });
      }
      if (op.type === "extrude") {
        const source = model.voxels.find(
          (v) => v.x === p.x && v.y === p.y && v.z === p.z,
        );
        if (!source) throw new Error("Extrude target is empty.");
        const normal = voxelNormals[voxelViews.indexOf(op.face)]!;
        for (let d = 1; d <= op.distance; d++) {
          const q = {
            x: p.x + normal[0] * d,
            y: p.y + normal[1] * d,
            z: p.z + normal[2] * d,
          };
          if (Math.min(q.x, q.y, q.z) < 0)
            throw new Error("Extrusion exceeds model bounds.");
          check(q);
          cells.set(key(q.x, q.y, q.z), { ...q, colors: [...source.colors] });
        }
      }
    }
  }
  return { ...model, palette, voxels: [...cells.values()] };
}
// Counter-clockwise, outward-facing quads. Internal neighbor faces are omitted.
const corners = [
  [
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ],
  [
    [1, 0, 0],
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
  ],
  [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
    [0, 1, 0],
  ],
  [
    [1, 0, 1],
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
  ],
  [
    [0, 1, 1],
    [1, 1, 1],
    [1, 1, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ],
] as const;
export interface VoxelFace {
  voxel: number;
  face: number;
  color: string;
  vertices: number[][];
}
export function voxelSurface(model: VoxelModel): VoxelFace[] {
  const occupied = new Set(model.voxels.map((v) => key(v.x, v.y, v.z)));
  const result: VoxelFace[] = [];
  model.voxels.forEach((v, i) =>
    voxelNormals.forEach((normal, f) => {
      if (occupied.has(key(v.x + normal[0], v.y + normal[1], v.z + normal[2])))
        return;
      result.push({
        voxel: i,
        face: f,
        color: model.palette[v.colors[f]!]!,
        vertices: corners[f]!.map((c) => [v.x + c[0], v.y + c[1], v.z + c[2]]),
      });
    }),
  );
  return result;
}
export function inspectVoxelModel(model: VoxelModel) {
  const discrepancies: Partial<
    Record<VoxelView, { missing: number; extra: number; total: number }>
  > = {};
  for (const view of voxelViews) {
    const source = model.projections[view];
    if (!source) continue;
    const mask = new Uint8Array(model.size ** 2);
    for (const v of model.voxels) {
      const [x, y] = projectionUV(view, v.x, v.y, v.z, model.size);
      mask[x + y * model.size] = 1;
    }
    let missing = 0,
      extra = 0,
      total = 0;
    source.cells.forEach((c, i) => {
      if (c) total++;
      if (c && !mask[i]) missing++;
      if (!c && mask[i]) extra++;
    });
    discrepancies[view] = { missing, extra, total };
  }
  return {
    voxelCount: model.voxels.length,
    surfaceFaces: voxelSurface(model).length,
    paletteColors: model.palette.length,
    projections: discrepancies,
  };
}
export function exportVoxelOBJ(model: VoxelModel) {
  const surface = voxelSurface(model);
  const lines = ["# Retrodex voxel surface v1", "mtllib model.mtl"];
  let offset = 1;
  for (const f of surface) {
    for (const v of f.vertices)
      lines.push(
        `v ${v[0]! - model.size / 2} ${v[1]} ${v[2]! - model.size / 2}`,
      );
    lines.push(
      `usemtl c${model.palette.indexOf(f.color)}`,
      `f ${offset} ${offset + 1} ${offset + 2} ${offset + 3}`,
    );
    offset += 4;
  }
  const mtl = model.palette
    .map(
      (c, i) =>
        `newmtl c${i}\nKd ${[1, 3, 5].map((j) => parseInt(c.slice(j, j + 2), 16) / 255).join(" ")}\nKa 0 0 0\nKs 0 0 0\nillum 1\nd 1`,
    )
    .join("\n\n");
  return {
    obj: lines.join("\n") + "\n",
    mtl: mtl + "\n",
    manifest: {
      version: 1,
      format: "obj-mtl",
      voxelSize: 1,
      upAxis: "Y",
      frontAxis: "+Z",
      origin: "grid-bottom-center",
      surfaceFaces: surface.length,
      modelRecipe: model.recipe,
    },
  };
}

/** Exact, unlit native projections, with frontmost colors per face. */
export function projectVoxelModel(
  model: VoxelModel,
): Record<VoxelView, VoxelProjection> {
  return Object.fromEntries(
    voxelViews.map((view, face) => {
      const n = voxelNormals[face]!,
        depth = new Float64Array(model.size ** 2).fill(-Infinity);
      const cells: (string | null)[] = Array(model.size ** 2).fill(null);
      for (const v of model.voxels) {
        const [u, w] = projectionUV(view, v.x, v.y, v.z, model.size),
          i = u + w * model.size,
          d = v.x * n[0] + v.y * n[1] + v.z * n[2];
        if (d > depth[i]!) {
          depth[i] = d;
          cells[i] = model.palette[v.colors[face]!]!;
        }
      }
      return [view, { width: model.size, height: model.size, cells }];
    }),
  ) as Record<VoxelView, VoxelProjection>;
}
/** Palette texture uses texel centers, so every face retains its exact color. */
export function exportVoxelTexturedOBJ(model: VoxelModel) {
  const base = exportVoxelOBJ(model),
    width = Math.ceil(Math.sqrt(model.palette.length)),
    height = Math.ceil(model.palette.length / width);
  const texture: VoxelProjection = {
    width,
    height,
    cells: Array(width * height).fill(null),
  };
  model.palette.forEach((c, i) => (texture.cells[i] = c));
  const lines = [
    "# Retrodex textured voxel surface",
    "mtllib model.mtl",
    "usemtl palette",
  ];
  model.palette.forEach((_, i) =>
    lines.push(
      `vt ${((i % width) + 0.5) / width} ${1 - (Math.floor(i / width) + 0.5) / height}`,
    ),
  );
  let offset = 1;
  for (const f of voxelSurface(model)) {
    for (const v of f.vertices)
      lines.push(
        `v ${v[0]! - model.size / 2} ${v[1]} ${v[2]! - model.size / 2}`,
      );
    const uv = model.palette.indexOf(f.color) + 1;
    lines.push(`f ${[0, 1, 2, 3].map((i) => `${offset + i}/${uv}`).join(" ")}`);
    offset += 4;
  }
  return {
    ...base,
    obj: lines.join("\n") + "\n",
    mtl: "newmtl palette\nKd 1 1 1\nKa 0 0 0\nKs 0 0 0\nillum 1\nd 1\nmap_Kd model.png\n",
    texture,
    manifest: { ...base.manifest, format: "obj-mtl-png" },
  };
}
