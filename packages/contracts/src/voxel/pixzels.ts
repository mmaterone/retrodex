import { z } from "zod";
import { buildVoxelModel } from "./core";
import { voxelModelSchema } from "./model";
import type {
  VoxelCell,
  VoxelModel,
  VoxelProjection,
  VoxelView,
} from "./model";
const rgb = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
});
const override = z.object({
  present: z.boolean(),
  color: rgb.optional(),
  frontColor: rgb.optional(),
  backColor: rgb.optional(),
  leftColor: rgb.optional(),
  rightColor: rgb.optional(),
  topColor: rgb.optional(),
  bottomColor: rgb.optional(),
  sideColor: rgb.optional(),
});
const png = z
  .string()
  .startsWith("data:image/png;base64,")
  .max(6_000_000)
  .nullable()
  .optional();
const projectSchema = z.object({
  version: z.literal(1),
  meta: z.object({ activeSize: z.number().int().min(1).max(128) }),
  projections: z.object({ front: png, side: png, top: png }),
  sixViews: z
    .object({
      front: png,
      back: png,
      left: png,
      right: png,
      top: png,
      bottom: png,
    })
    .nullable()
    .optional(),
  voxelOverrides: z
    .array(z.tuple([z.string().regex(/^\d+,\d+,\d+$/), override]))
    .max(2097152)
    .default([]),
});
function flipVertical(p: VoxelProjection): VoxelProjection {
  return {
    ...p,
    cells: Array.from({ length: p.height }, (_, y) =>
      p.cells.slice((p.height - 1 - y) * p.width, (p.height - y) * p.width),
    ).flat(),
  };
}
// Pixzels uses linear RGB for override colors. Restore encoded sRGB before
// inserting them into Retrodex's exact hex palette.
function srgb(c: { r: number; g: number; b: number }) {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((v) =>
        Math.round(
          255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export async function importPixzelsModel(
  input: unknown,
  decode: (png: string) => Promise<VoxelProjection>,
): Promise<VoxelModel> {
  const project = projectSchema.parse(input),
    n = project.meta.activeSize;
  const projections: Partial<Record<VoxelView, VoxelProjection>> = {};
  const six = project.sixViews;
  // Match the original loader: six-view mode only when all six exist.
  if (
    six?.front &&
    six.back &&
    six.left &&
    six.right &&
    six.top &&
    six.bottom
  ) {
    projections.front = await decode(six.front);
    projections.back = await decode(six.back);
    projections.right = await decode(six.left);
    projections.left = await decode(six.right);
    projections.top = flipVertical(await decode(six.top));
    projections.bottom = await decode(six.bottom);
  } else {
    if (project.projections.front)
      projections.front = await decode(project.projections.front);
    if (project.projections.side)
      projections.right = await decode(project.projections.side);
    if (project.projections.top)
      projections.top = flipVertical(await decode(project.projections.top));
  }
  let model: VoxelModel;
  if (Object.keys(projections).length)
    model = buildVoxelModel({ size: n, projections });
  else
    model = {
      version: 1,
      size: n,
      palette: ["#ffffff"],
      voxels: [],
      projections: {},
      recipe: { algorithm: "silhouette-intersection-v1", singleViewDepth: 1 },
    };
  if (Object.keys(projections).length === 1 && projections.top && n % 2 === 0) {
    // The source's single top plane uses floor(n/2) in Y; X/Z are reversed,
    // while Y is not. Preserve that even-grid offset during compatibility import.
    model = {
      ...model,
      voxels: model.voxels.map((v) => ({ ...v, y: v.y + 1 })),
    };
  }
  const voxels = new Map(model.voxels.map((v) => [`${v.x},${v.y},${v.z}`, v]));
  const palette = [...model.palette];
  const color = (rgbColor: z.infer<typeof rgb>) => {
    const hex = srgb(rgbColor);
    let i = palette.indexOf(hex);
    if (i < 0) {
      if (palette.length >= 65536)
        throw new Error("Pixzels model exceeds the 65536-color palette limit.");
      i = palette.length;
      palette.push(hex);
    }
    return i;
  };
  for (const [key, o] of new Map(project.voxelOverrides)) {
    const [px, py, pz] = key.split(",").map(Number) as [number, number, number];
    if (Math.max(px, py, pz) >= n)
      throw new Error("Pixzels override is outside the native grid.");
    const x = n - 1 - px,
      y = py,
      z = n - 1 - pz,
      k = `${x},${y},${z}`;
    if (!o.present) {
      voxels.delete(k);
      continue;
    }
    // Unspecified faces keep the projected color. Newly occupied cells start
    // with black, matching the source's freshly allocated Float32 color buffer.
    const old = voxels.get(k);
    let fallback = 0;
    if (o.color) fallback = color(o.color);
    else if (!old) fallback = color({ r: 0, g: 0, b: 0 });
    const colors: VoxelCell["colors"] =
      old && !o.color
        ? [...old.colors]
        : [fallback, fallback, fallback, fallback, fallback, fallback];
    const mapped = [
      o.frontColor,
      o.backColor,
      o.rightColor,
      o.leftColor,
      o.topColor,
      o.bottomColor,
    ];
    mapped.forEach((c, i) => {
      if (c) colors[i] = color(c);
    });
    // Source sideColor overwrites its right (+X) face, now our left (-X).
    if (o.sideColor) colors[2] = color(o.sideColor);
    voxels.set(k, { x, y, z, colors });
  }
  return voxelModelSchema.parse({
    ...model,
    palette,
    voxels: [...voxels.values()],
  });
}
