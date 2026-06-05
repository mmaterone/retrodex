import { z } from "zod";

import {
  anchorSchema,
  bboxSchema,
  canvasSizeSchema,
  isoDateTimeSchema,
  pixelPathSchema,
  qcSummarySchema,
  rgbColorSchema,
  schemaVersion,
} from "./common";

export const frameSourceSchema = z.object({
  cleanupRunId: z.string().optional(),
  inputPath: pixelPathSchema.optional(),
  jobId: z.string().optional(),
  kind: z.enum([
    "user-edited",
    "imagegen-raw",
    "cleanup-output",
    "rig-render",
    "imported",
  ]),
});

export const frameSchema = z.object({
  alphaBBox: bboxSchema.nullable(),
  anchor: anchorSchema,
  approved: z.boolean().default(false),
  approvedAt: isoDateTimeSchema.nullable().default(null),
  canvas: canvasSizeSchema,
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  name: z.string().min(1),
  palette: z.object({
    colors: z.array(rgbColorSchema),
    lockedTo: pixelPathSchema.nullable(),
  }),
  path: pixelPathSchema,
  qc: qcSummarySchema,
  schemaVersion: z.literal(schemaVersion),
  source: frameSourceSchema,
});

export type FrameSource = z.infer<typeof frameSourceSchema>;
export type Frame = z.infer<typeof frameSchema>;
