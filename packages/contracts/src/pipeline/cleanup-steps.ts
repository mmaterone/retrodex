import { z } from "zod";

export const cleanupStepIdSchema = z.enum([
  "validate-control-grid",
  "detect-backdrop",
  "remove-background",
  "sample-control-grid",
  "recover-lattice",
  "remove-service-colors",
  "remove-small-components",
  "protect-face-details",
  "lock-palette",
  "align-anchor",
  "score-frame",
  "write-diagnostics",
  "assemble-export",
]);

export const cleanupStepSchema = z.object({
  blocking: z.boolean().default(false),
  enabled: z.boolean().default(true),
  id: cleanupStepIdSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});

export const cleanupPipelineSchema = z.object({
  description: z.string().min(1),
  id: z.string().min(1),
  steps: z.array(cleanupStepSchema),
});

export type CleanupStepId = z.infer<typeof cleanupStepIdSchema>;
export type CleanupStep = z.infer<typeof cleanupStepSchema>;
export type CleanupPipeline = z.infer<typeof cleanupPipelineSchema>;

export const controlGridCleanupPipeline: CleanupPipeline = {
  description:
    "Validate a visible service grid, sample cell centers, then run conservative sprite cleanup.",
  id: "control-grid-v1",
  steps: [
    {
      blocking: false,
      enabled: true,
      id: "detect-backdrop",
      params: {},
    },
    {
      blocking: true,
      enabled: true,
      id: "validate-control-grid",
      params: {
        maxGutterForegroundRatio: 0.1,
        maxPartialCellRatio: 0.28,
        minVisibleLineRatio: 0.45,
      },
    },
    {
      blocking: true,
      enabled: true,
      id: "sample-control-grid",
      params: { sampleMarginRatio: 0.4, sampleMode: "median" },
    },
    { blocking: false, enabled: true, id: "remove-service-colors", params: {} },
    {
      blocking: false,
      enabled: true,
      id: "protect-face-details",
      params: { contrastThreshold: 42, maxDetailSize: 8, regionTopRatio: 0.62 },
    },
    {
      blocking: false,
      enabled: true,
      id: "remove-small-components",
      params: { minSize: 4 },
    },
    {
      blocking: false,
      enabled: true,
      id: "lock-palette",
      params: { source: "approved-keyframe" },
    },
    {
      blocking: false,
      enabled: true,
      id: "align-anchor",
      params: { mode: "feet" },
    },
    {
      blocking: false,
      enabled: true,
      id: "score-frame",
      params: { preset: "fighter" },
    },
    { blocking: false, enabled: true, id: "write-diagnostics", params: {} },
  ],
};

export const promptOnlySheetCleanupPipeline: CleanupPipeline = {
  description:
    "Recover action frames from flat-background imagegen sheets without trusting raw downscale.",
  id: "prompt-only-horizontal-sheet-v1",
  steps: [
    {
      blocking: false,
      enabled: true,
      id: "detect-backdrop",
      params: {},
    },
    {
      blocking: true,
      enabled: true,
      id: "remove-background",
      params: { autoDetect: true, mode: "auto" },
    },
    {
      blocking: true,
      enabled: true,
      id: "recover-lattice",
      params: { grouping: "horizontal-content-runs", mergeFragmentsPx: 38 },
    },
    {
      blocking: false,
      enabled: true,
      id: "lock-palette",
      params: { source: "approved-keyframe" },
    },
    {
      blocking: false,
      enabled: true,
      id: "align-anchor",
      params: { bottomPad: 2, mode: "feet" },
    },
    {
      blocking: false,
      enabled: true,
      id: "score-frame",
      params: { preset: "fighter" },
    },
    { blocking: false, enabled: true, id: "write-diagnostics", params: {} },
  ],
};

export const cleanupPipelines = [
  controlGridCleanupPipeline,
  promptOnlySheetCleanupPipeline,
] as const;
