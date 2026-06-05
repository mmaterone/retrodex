import { z } from "zod";

import {
  canvasSizeSchema,
  isoDateTimeSchema,
  pixelPathSchema,
  schemaVersion,
} from "./common";
import { frameApprovalSchema } from "./run";

export const exportTargetSchema = z.enum([
  "raw-frames",
  "game-strip",
  "texturepacker",
  "aseprite",
  "godot",
  "webp",
  "svg",
  "tgs",
  "lottie",
  "react",
  "css",
]);

export const savedAnimationSchema = z.object({
  approval: z.object({
    approvedFrames: z.array(frameApprovalSchema),
  }),
  canvas: canvasSizeSchema,
  createdAt: isoDateTimeSchema,
  exports: z.array(
    z.object({
      path: pixelPathSchema,
      target: exportTargetSchema,
    })
  ),
  files: z.object({
    contactSheet: pixelPathSchema,
    css: pixelPathSchema,
    draft: pixelPathSchema,
    editorDiff: pixelPathSchema,
    gif: pixelPathSchema,
    lottie: pixelPathSchema,
    manifest: pixelPathSchema,
    preview: pixelPathSchema,
    react: pixelPathSchema,
    shareBundle: pixelPathSchema,
    stripTransparent: pixelPathSchema,
    svg: pixelPathSchema,
    tgs: pixelPathSchema,
    tgsMetadata: pixelPathSchema,
    validation: pixelPathSchema,
    webp: pixelPathSchema,
  }),
  fps: z.number().int().positive(),
  frames: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      savedPath: pixelPathSchema,
      sourceFrameId: z.string().min(1),
      sourcePath: pixelPathSchema,
    })
  ),
  id: z.string().min(1),
  name: z.string().min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal(schemaVersion),
  slug: z.string().min(1),
});

export type ExportTarget = z.infer<typeof exportTargetSchema>;
export type SavedAnimation = z.infer<typeof savedAnimationSchema>;
