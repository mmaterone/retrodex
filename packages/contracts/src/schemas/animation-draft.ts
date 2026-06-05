import { z } from "zod";

import {
  anchorSchema,
  bboxSchema,
  canvasSizeSchema,
  pixelPathSchema,
  schemaVersion,
} from "./common";

export const transformSchema = z.object({
  rotate: z.number().default(0),
  scale: z.number().positive().default(100),
  x: z.number().default(0),
  y: z.number().default(0),
});

export const rigPartSchema = z.object({
  anchor: anchorSchema,
  bbox: bboxSchema.nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
  id: z.string().min(1),
  maskPath: pixelPathSchema.nullable(),
  name: z.string().min(1),
  parentId: z.string().nullable(),
  pinned: z.boolean().default(false),
});

export const animationDraftFrameSchema = z.object({
  frameId: z.string().min(1),
  framePath: pixelPathSchema,
  transforms: z.record(z.string(), transformSchema),
});

export const animationDraftSchema = z.object({
  canvasSize: canvasSizeSchema,
  fps: z.number().int().positive(),
  frames: z.record(z.string(), animationDraftFrameSchema),
  framesList: z.array(z.string().min(1)),
  rigParts: z.array(rigPartSchema),
  runId: z.string().min(1),
  schemaVersion: z.literal(schemaVersion),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Transform = z.infer<typeof transformSchema>;
export type RigPart = z.infer<typeof rigPartSchema>;
export type AnimationDraft = z.infer<typeof animationDraftSchema>;
