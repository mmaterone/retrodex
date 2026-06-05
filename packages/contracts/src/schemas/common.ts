import { z } from "zod";

export const schemaVersion = "2026-06-04.v1" as const;

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const pixelPathSchema = z.string().min(1);

export const canvasSizeSchema = z.object({
  height: z.number().int().positive(),
  width: z.number().int().positive(),
});

export const rgbaColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{8}$/u, "Expected #rrggbbaa");

export const rgbColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, "Expected #rrggbb");

export const bboxSchema = z.object({
  height: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const anchorSchema = z.object({
  mode: z.enum(["center", "bottom", "feet", "custom"]),
  x: z.number(),
  y: z.number(),
});

export const qcSummarySchema = z.object({
  blockingIssues: z.array(z.string()),
  passes: z.boolean(),
  retryHints: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type CanvasSize = z.infer<typeof canvasSizeSchema>;
export type BBox = z.infer<typeof bboxSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type QcSummary = z.infer<typeof qcSummarySchema>;
