import { z } from "zod";

import {
  canvasSizeSchema,
  isoDateTimeSchema,
  pixelPathSchema,
  qcSummarySchema,
  schemaVersion,
} from "./common";

export const assetPlanSchema = z.object({
  action: z.string().min(1),
  frames: z.number().int().positive(),
  sheet: z.string().min(1),
  style: z.enum(["pixel-art", "retro", "clean-hd", "pixel-inspired"]),
  type: z.enum([
    "background",
    "character",
    "fx",
    "icon",
    "projectile",
    "prop",
    "tile",
  ]),
  view: z.enum(["side", "topdown", "three-quarter", "front"]),
});

export const runStatusSchema = z.enum([
  "planned",
  "awaiting-generation",
  "raw-ready",
  "cleaning",
  "review",
  "approved",
  "exported",
  "rejected",
]);

export const frameApprovalSchema = z.object({
  approvedAt: isoDateTimeSchema,
  approvedBy: z.enum(["user", "agent", "system"]).default("user"),
  frameId: z.string().min(1),
  note: z.string().min(1).optional(),
});

export const runApprovalSchema = z
  .object({
    approvedFrames: z.array(frameApprovalSchema).default([]),
    updatedAt: isoDateTimeSchema.nullable().default(null),
  })
  .default({ approvedFrames: [], updatedAt: null });

export const runSchema = z.object({
  activeFrameIds: z.array(z.string()),
  approval: runApprovalSchema,
  asset: assetPlanSchema,
  canvas: canvasSizeSchema,
  createdAt: isoDateTimeSchema,
  id: z.string().min(1),
  name: z.string().min(1),
  palettePath: pixelPathSchema.nullable(),
  paths: z.object({
    diagnosticsDir: pixelPathSchema,
    exportsDir: pixelPathSchema,
    framesDir: pixelPathSchema,
    masksDir: pixelPathSchema,
    pipelineDir: pixelPathSchema,
    root: pixelPathSchema,
  }),
  presetId: z.string().min(1),
  qc: qcSummarySchema,
  schemaVersion: z.literal(schemaVersion),
  status: runStatusSchema,
  updatedAt: isoDateTimeSchema,
});

export type AssetPlan = z.infer<typeof assetPlanSchema>;
export type FrameApproval = z.infer<typeof frameApprovalSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunApproval = z.infer<typeof runApprovalSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
