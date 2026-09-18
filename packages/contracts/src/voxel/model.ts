import { z } from "zod";

export const voxelViews = [
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
] as const;
export type VoxelView = (typeof voxelViews)[number];
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((v) => v.toLowerCase());
const integer = z.number().int().min(0).max(127);
const point = z.object({ x: integer, y: integer, z: integer });
export const voxelProjectionSchema = z
  .object({
    width: z.number().int().min(1).max(128),
    height: z.number().int().min(1).max(128),
    cells: z.array(color.nullable()).max(16384),
  })
  .superRefine((p, ctx) => {
    if (p.cells.length !== p.width * p.height)
      ctx.addIssue({
        code: "custom",
        message: "Projection cell count must match dimensions.",
      });
  });
export type VoxelProjection = z.infer<typeof voxelProjectionSchema>;
export const voxelProjectionsSchema = z.object({
  front: voxelProjectionSchema.optional(),
  back: voxelProjectionSchema.optional(),
  left: voxelProjectionSchema.optional(),
  right: voxelProjectionSchema.optional(),
  top: voxelProjectionSchema.optional(),
  bottom: voxelProjectionSchema.optional(),
});
// Palette indices use a separate bound from spatial coordinates.
const paletteIndex = z.number().int().min(0).max(65535);
const faceColors = z.tuple([
  paletteIndex,
  paletteIndex,
  paletteIndex,
  paletteIndex,
  paletteIndex,
  paletteIndex,
]);
export const voxelCellSchema = point.extend({ colors: faceColors });
export type VoxelCell = z.infer<typeof voxelCellSchema>;
export const voxelSettingsSchema = z.object({
  yaw: z.number().finite().default(35),
  pitch: z.number().min(-90).max(90).default(20),
  zoom: z.number().min(0.1).max(8).default(1),
  panX: z.number().min(-512).max(512).default(0),
  panY: z.number().min(-512).max(512).default(0),
  pixelMode: z.boolean().default(true),
  grid: z.boolean().default(true),
  outline: z.boolean().default(false),
  edges: z.boolean().default(false),
  shading: z.boolean().default(false),
  outlineColor: color.default("#15171c"),
  background: color.default("#20252c"),
  lightYaw: z.number().finite().default(-45),
  lightPitch: z.number().min(-90).max(90).default(45),
  outputSize: z.number().int().min(8).max(512).default(64),
  fps: z.number().int().min(1).max(60).default(8),
  viewLock: z.boolean().default(false),
});
export type VoxelSettings = z.infer<typeof voxelSettingsSchema>;
export const voxelModelSchema = z
  .object({
    version: z.literal(1),
    settings: voxelSettingsSchema.optional(),
    size: z.number().int().min(1).max(128),
    palette: z.array(color).min(1).max(65536),
    voxels: z.array(voxelCellSchema).max(2097152),
    projections: voxelProjectionsSchema,
    recipe: z.object({
      algorithm: z.literal("silhouette-intersection-v1"),
      singleViewDepth: z.number().int().min(1).max(128),
    }),
  })
  .superRefine((m, ctx) => {
    const keys = new Set<string>();
    for (const v of m.voxels) {
      const k = `${v.x},${v.y},${v.z}`;
      if (
        keys.has(k) ||
        Math.max(v.x, v.y, v.z) >= m.size ||
        v.colors.some((c) => c >= m.palette.length)
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Voxels must have unique, in-bounds coordinates and valid palette indices.",
        });
        break;
      }
      keys.add(k);
    }
    for (const p of Object.values(m.projections))
      if (p && (p.width !== m.size || p.height !== m.size)) {
        ctx.addIssue({
          code: "custom",
          message:
            "All projections must match the native cubic grid size; no implicit resampling.",
        });
        break;
      }
    if (m.recipe.singleViewDepth > m.size)
      ctx.addIssue({ code: "custom", message: "Depth exceeds model size." });
  });
export type VoxelModel = z.infer<typeof voxelModelSchema>;
export const voxelBuildSchema = z
  .object({
    size: z.number().int().min(1).max(128),
    projections: voxelProjectionsSchema,
    singleViewDepth: z.number().int().min(1).max(128).default(1),
  })
  .superRefine((r, ctx) => {
    if (!Object.keys(r.projections).length)
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one projection.",
      });
    if (r.singleViewDepth > r.size)
      ctx.addIssue({ code: "custom", message: "Depth exceeds model size." });
    for (const p of Object.values(r.projections))
      if (p && (p.width !== r.size || p.height !== r.size))
        ctx.addIssue({
          code: "custom",
          message: "Projection dimensions must equal the native grid size.",
        });
  });
const vector = z.object({
  x: z.number().int().min(-128).max(128),
  y: z.number().int().min(-128).max(128),
  z: z.number().int().min(-128).max(128),
});
const bounds = z.object({ min: point, max: point });
const regions = z.array(bounds).min(1).max(64).optional();
export const voxelOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clear") }),
  z.object({
    type: z.literal("fill-plane"),
    point,
    face: z.enum(voxelViews),
    color,
    selection: bounds.optional(),
    regions,
    enclosed: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("fill"),
    point,
    face: z.enum(voxelViews),
    color,
    contiguous: z.boolean().default(true),
    selection: bounds.optional(),
    regions,
  }),
  z.object({
    type: z.literal("transform"),
    min: point,
    max: point,
    offset: vector,
    regions,
    copy: z.boolean().default(false),
    scale: z
      .object({
        x: z.number().int().min(1).max(128),
        y: z.number().int().min(1).max(128),
        z: z.number().int().min(1).max(128),
      })
      .optional(),
  }),
  z.object({ type: z.literal("delete"), min: point, max: point, regions }),
  z.object({
    type: z.literal("resize"),
    size: z.number().int().min(1).max(128),
    anchor: z.enum(["origin", "center"]).default("center"),
  }),
  z.object({
    type: z.literal("interpolate"),
    views: z.enum(["front-side", "front-side-top"]),
  }),
  z.object({
    type: z.literal("set"),
    points: z.array(point).min(1).max(32768),
    color: color.nullable(),
  }),
  z.object({
    type: z.literal("paint"),
    points: z.array(point).min(1).max(32768),
    color,
    face: z.enum(voxelViews).optional(),
  }),
  z.object({
    type: z.literal("extrude"),
    points: z.array(point).min(1).max(16384),
    face: z.enum(voxelViews),
    distance: z.number().int().min(1).max(128),
  }),
  z.object({
    type: z.literal("mirror"),
    axis: z.enum(["x", "y", "z"]),
    min: point,
    max: point,
  }),
]);
export type VoxelOperation = z.infer<typeof voxelOperationSchema>;
export const voxelRenderSchema = z.object({
  width: z.number().int().min(8).max(512).default(64),
  height: z.number().int().min(8).max(512).default(64),
  yaw: z.number().finite().default(0),
  pitch: z.number().min(-90).max(90).default(20),
  zoom: z.number().min(0.1).max(8).default(1),
  panX: z.number().min(-512).max(512).default(0),
  panY: z.number().min(-512).max(512).default(0),
  shading: z.boolean().default(false),
  lightYaw: z.number().finite().default(-45),
  lightPitch: z.number().min(-90).max(90).default(45),
  outline: z.boolean().default(false),
  outlineColor: color.default("#17191d"),
  edges: z.boolean().default(false),
  background: color.nullable().default(null),
  directions: z.union([z.literal(1), z.literal(8), z.literal(16)]).default(1),
});
