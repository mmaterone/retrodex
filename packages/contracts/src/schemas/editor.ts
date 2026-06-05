import { z } from "zod";

import {
  anchorSchema,
  bboxSchema,
  canvasSizeSchema,
  isoDateTimeSchema,
  rgbColorSchema,
  schemaVersion,
} from "./common";

export const pixelColorSchema = z
  .string()
  .regex(
    /^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba\(\d{1,3},\s*\d{1,3},\s*\d{1,3},\s*(0|1|0?\.\d+)\))$/u,
    "Expected #rrggbb, #rrggbbaa, or rgba(r,g,b,a)"
  );

export const pixelCellSchema = pixelColorSchema.nullable();

export const pixelGridSchema = z.object({
  cells: z.array(pixelCellSchema),
  palette: z.array(rgbColorSchema).default([]),
  size: canvasSizeSchema,
});

export const editorPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const semanticMaskRoleSchema = z.enum([
  "background",
  "body",
  "clothes",
  "eyes",
  "face",
  "hair",
  "head",
  "mouth",
  "prop",
  "shadow",
  "unknown",
  "weapon",
]);

export const maskRegenerationPolicySchema = z.object({
  allowImagegenReference: z.boolean().default(true),
  allowRegenerate: z.boolean().default(true),
  locked: z.boolean().default(false),
  preservePalette: z.boolean().default(true),
});

export const editorMaskLayerSchema = z.object({
  anchor: editorPointSchema,
  color: rgbColorSchema,
  id: z.string().min(1),
  mask: z.array(z.boolean()),
  name: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  promptHint: z.string().default(""),
  regenerationPolicy: maskRegenerationPolicySchema.default({}),
  semanticLabel: z.string().default(""),
  semanticRole: semanticMaskRoleSchema.default("unknown"),
  visible: z.boolean().default(true),
});

export const editorFrameSchema = z.object({
  alphaBBox: bboxSchema.nullable(),
  anchor: anchorSchema,
  frameId: z.string().min(1),
  grid: pixelGridSchema,
  name: z.string().min(1),
  sourcePath: z.string().min(1).nullable(),
});

export const editorSaveStateSchema = z.object({
  dirty: z.boolean().default(false),
  lastSavedAt: isoDateTimeSchema.nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
});

const editorBoundsSchema = z.object({
  height: z.number().int().positive(),
  width: z.number().int().positive(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const editorSelectionStateSchema = z
  .object({
    activeMaskLayerId: z.string().min(1).nullable().default(null),
    selectedBounds: editorBoundsSchema.nullable().default(null),
    selectedFrameId: z.string().min(1).nullable().default(null),
    selectedMaskLayerIds: z.array(z.string().min(1)).default([]),
    selectedPixelsMask: z.array(z.boolean()).nullable().default(null),
    transformTarget: z
      .enum(["none", "pixels", "mask-layer", "mask-family", "frame"])
      .default("none"),
  })
  .default({});

export const editorDocumentSchema = z.object({
  activeMaskLayerId: z.string().min(1).nullable(),
  canvas: canvasSizeSchema,
  createdAt: isoDateTimeSchema,
  frames: z.array(editorFrameSchema),
  masks: z.array(editorMaskLayerSchema).default([]),
  runId: z.string().min(1),
  saveState: editorSaveStateSchema,
  schemaVersion: z.literal(schemaVersion),
  selectedFrameId: z.string().min(1).nullable(),
  selection: editorSelectionStateSchema,
  timeline: z.object({
    fps: z.number().int().positive().default(8),
    framesList: z.array(z.string().min(1)),
    isPlaying: z.boolean().default(false),
  }),
  updatedAt: isoDateTimeSchema,
});

export const editorPixelPatchSchema = z.object({
  color: pixelCellSchema,
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const editorMaskPatchSchema = z.object({
  value: z.boolean(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

const toolNameSchema = z.enum([
  "brush",
  "bucket",
  "eraser",
  "gradient",
  "shape",
  "selection",
  "transform",
]);

export const editorOperationSchema = z.discriminatedUnion("type", [
  z.object({
    color: pixelCellSchema,
    frameId: z.string().min(1),
    type: z.literal("set-pixel"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  z.object({
    frameId: z.string().min(1),
    patches: z.array(editorPixelPatchSchema).min(1),
    type: z.literal("patch-pixels"),
  }),
  z.object({
    color: pixelCellSchema,
    frameId: z.string().min(1),
    points: z.array(editorPointSchema).min(1),
    size: z.number().int().positive().default(1),
    tool: toolNameSchema,
    type: z.literal("tool-stroke"),
  }),
  z.object({
    color: pixelCellSchema,
    frameId: z.string().min(1),
    respectMaskLayerIds: z.array(z.string().min(1)).default([]),
    type: z.literal("bucket-fill"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  z.object({
    endCell: editorPointSchema,
    endColor: pixelColorSchema,
    frameId: z.string().min(1),
    kind: z.enum(["linear", "radial"]).default("linear"),
    pattern: z.enum(["bayer", "checker", "fine", "hard"]).default("bayer"),
    startCell: editorPointSchema,
    startColor: pixelColorSchema,
    target: z.enum(["connected", "canvas", "mask"]).default("connected"),
    targetMaskLayerIds: z.array(z.string().min(1)).default([]),
    type: z.literal("gradient-fill"),
  }),
  z.object({
    color: pixelCellSchema,
    endCell: editorPointSchema,
    frameId: z.string().min(1),
    mode: z.enum(["fill", "outline"]).default("outline"),
    radius: z.number().int().nonnegative().default(0),
    shape: z.enum(["ellipse", "line", "rectangle", "triangle"]),
    startCell: editorPointSchema,
    type: z.literal("shape-pixels"),
  }),
  z.object({
    bounds: editorBoundsSchema,
    frameId: z.string().min(1),
    mask: z.array(z.boolean()).optional(),
    origin: editorPointSchema,
    rotation: z.number().default(0),
    scale: editorPointSchema,
    translation: editorPointSchema.default({ x: 0, y: 0 }),
    type: z.literal("transform-pixels"),
  }),
  z.object({
    bounds: editorBoundsSchema.optional(),
    clearMaskLayerIds: z.array(z.string().min(1)).default([]),
    frameId: z.string().min(1),
    mask: z.array(z.boolean()).optional(),
    maskLayerIds: z.array(z.string().min(1)).default([]),
    type: z.literal("delete-selected-pixels"),
  }),
  z.object({
    bounds: editorBoundsSchema,
    clearMaskLayerIds: z.array(z.string().min(1)).default([]),
    frameId: z.string().min(1),
    type: z.literal("delete-target"),
  }),
  z.object({
    layerId: z.string().min(1),
    patches: z.array(editorMaskPatchSchema).min(1),
    type: z.literal("patch-mask"),
  }),
  z.object({
    layerId: z.string().min(1),
    points: z.array(editorPointSchema).min(1),
    respectAlpha: z.boolean().default(true),
    size: z.number().int().positive().default(1),
    type: z.literal("mask-stroke"),
    value: z.boolean().default(true),
  }),
  z.object({
    excludeOtherMasks: z.boolean().default(true),
    layerId: z.string().min(1),
    respectAlpha: z.boolean().default(true),
    type: z.literal("mask-bucket"),
    value: z.boolean().default(true),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  z.object({
    endCell: editorPointSchema,
    layerId: z.string().min(1),
    mode: z.enum(["fill", "outline"]).default("outline"),
    radius: z.number().int().nonnegative().default(0),
    respectAlpha: z.boolean().default(true),
    shape: z.enum(["ellipse", "line", "rectangle", "triangle"]),
    startCell: editorPointSchema,
    type: z.literal("mask-shape"),
    value: z.boolean().default(true),
  }),
  z.object({
    frameId: z.string().min(1),
    type: z.literal("select-frame"),
  }),
  z.object({
    frameId: z.string().min(1),
    targetIndex: z.number().int().nonnegative(),
    type: z.literal("reorder-frame"),
  }),
  z.object({
    layer: editorMaskLayerSchema,
    type: z.literal("upsert-mask-layer"),
  }),
  z.object({
    layerId: z.string().min(1),
    type: z.literal("delete-mask-layer"),
  }),
]);

export const editorOperationsRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  operations: z.array(editorOperationSchema).min(1),
});

export const editorDocumentResponseSchema = z.object({
  document: editorDocumentSchema,
});

export const editorUrlResponseSchema = z.object({
  url: z.string().url(),
});

export const pixelGridResponseSchema = z.object({
  alphaBBox: bboxSchema.nullable(),
  frameId: z.string().min(1),
  grid: pixelGridSchema,
  previewUrl: z.string().min(1).optional(),
});

export const pixelGridWriteRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  grid: pixelGridSchema,
});

export const visualFeatureSchema = z.object({
  bbox: bboxSchema.nullable(),
  confidence: z.number().min(0).max(1),
  description: z.string(),
  id: z.string().min(1),
  kind: z.enum([
    "alpha-bbox",
    "eye-candidate",
    "face-candidate",
    "mask-part",
    "motion-region",
    "palette-cluster",
    "tiny-detail",
  ]),
  maskLayerId: z.string().min(1).optional(),
  pixels: z.array(editorPointSchema).default([]),
});

export const frameVisualInspectionSchema = z.object({
  alphaBBox: bboxSchema.nullable(),
  dominantColors: z.array(rgbColorSchema),
  features: z.array(visualFeatureSchema),
  frameId: z.string().min(1),
  fullPreviewUrl: z.string().min(1),
  humanSummary: z.string(),
  pixelMapUrl: z.string().min(1),
  recommendations: z.array(z.string()),
  zoomHints: z.array(
    z.object({
      bbox: bboxSchema,
      label: z.string().min(1),
      reason: z.string().min(1),
    })
  ),
});

export const animationVisualSummarySchema = z.object({
  contactSheetUrl: z.string().min(1).optional(),
  frameCount: z.number().int().nonnegative(),
  frameIds: z.array(z.string().min(1)),
  movingRegions: z.array(visualFeatureSchema),
  stableMaskLayerIds: z.array(z.string().min(1)),
  summary: z.string(),
});

export const visualSummarySchema = z.object({
  animation: animationVisualSummarySchema,
  frames: z.array(frameVisualInspectionSchema),
  runId: z.string().min(1),
  schemaVersion: z.literal(schemaVersion),
  updatedAt: isoDateTimeSchema,
});

export const visualSummaryResponseSchema = z.object({
  visualSummary: visualSummarySchema,
});

export const animationFrameDiffSchema = z.object({
  changedPixels: z.number().int().nonnegative(),
  changedRatio: z.number().min(0).max(1),
  fromFrameId: z.string().min(1),
  motionBBox: bboxSchema.nullable(),
  silhouetteChangedPixels: z.number().int().nonnegative(),
  silhouetteWarning: z.string().nullable(),
  toFrameId: z.string().min(1),
});

export const animationMaskMotionTrackSchema = z.object({
  averageChangedPixels: z.number().nonnegative(),
  keyframes: z.array(
    z.object({
      changedPixels: z.number().int().nonnegative(),
      frameId: z.string().min(1),
      motionBBox: bboxSchema.nullable(),
    })
  ),
  maskLayerId: z.string().min(1),
  semanticLabel: z.string(),
  semanticRole: semanticMaskRoleSchema,
  stability: z.number().min(0).max(1),
});

export const animationFlickerRegionSchema = z.object({
  bbox: bboxSchema,
  confidence: z.number().min(0).max(1),
  description: z.string().min(1),
  pixels: z.array(editorPointSchema),
});

export const animationInspectionSchema = z.object({
  diagnostics: z.array(
    z.object({
      code: z.enum([
        "empty-animation",
        "flicker-risk",
        "loop-break",
        "mask-motion",
        "silhouette-break",
      ]),
      details: z.record(z.string(), z.unknown()).default({}),
      message: z.string().min(1),
      severity: z.enum(["error", "info", "warning"]),
    })
  ),
  flickerRegions: z.array(animationFlickerRegionSchema),
  fps: z.number().int().positive(),
  frameDiffs: z.array(animationFrameDiffSchema),
  frameIds: z.array(z.string().min(1)),
  loopQualityScore: z.number().min(0).max(1),
  maskMotionTracks: z.array(animationMaskMotionTrackSchema),
  recommendations: z.array(z.string()),
  runId: z.string().min(1),
  schemaVersion: z.literal(schemaVersion),
  summary: z.string(),
  updatedAt: isoDateTimeSchema,
});

export const animationInspectionResponseSchema = z.object({
  animationInspection: animationInspectionSchema,
});

export const animationFixRequestSchema = z.object({
  frameIds: z.array(z.string().min(1)).optional(),
  maskLayerId: z.string().min(1).optional(),
  mode: z.enum(["fix-flicker", "repair-loop-pop", "smooth-mask-motion"]),
});

export const animationFixPatchSchema = z.object({
  after: pixelCellSchema,
  before: pixelCellSchema,
  frameId: z.string().min(1),
  reason: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const agentProjectMemorySchema = z.object({
  constraints: z.array(z.string()).default([]),
  decisionLog: z
    .array(
      z.object({
        at: isoDateTimeSchema,
        by: z.enum(["agent", "system", "user"]),
        decision: z.string().min(1),
        reason: z.string().default(""),
      })
    )
    .default([]),
  projectBrief: z.string().default(""),
  protectedDetails: z.array(z.string()).default([]),
  schemaVersion: z.literal(schemaVersion),
  styleGuide: z
    .object({
      animationRules: z.array(z.string()).default([]),
      outlineRules: z.array(z.string()).default([]),
      palette: z.array(rgbColorSchema).default([]),
      shadingRules: z.array(z.string()).default([]),
    })
    .default({}),
  updatedAt: isoDateTimeSchema,
});

export const agentProjectMemoryResponseSchema = z.object({
  memory: agentProjectMemorySchema,
});

export const maskDiagnosticSchema = z.object({
  code: z.enum([
    "empty-mask",
    "intersects-other-mask",
    "missing-semantic-role",
    "outside-visible-alpha",
    "parent-not-found",
  ]),
  details: z.record(z.string(), z.unknown()).default({}),
  layerId: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(["error", "info", "warning"]),
});

export const maskSuggestionSchema = z.object({
  bbox: bboxSchema,
  confidence: z.number().min(0).max(1),
  id: z.string().min(1),
  label: z.string().min(1),
  mask: z.array(z.boolean()),
  pixelCount: z.number().int().nonnegative(),
  promptHint: z.string(),
  role: semanticMaskRoleSchema,
  source: z.enum(["alpha-bbox", "connected-component", "contrast-detail"]),
});

export const maskIntelligenceReportSchema = z.object({
  diagnostics: z.array(maskDiagnosticSchema),
  maskCount: z.number().int().nonnegative(),
  recommendations: z.array(z.string()),
  runId: z.string().min(1),
  suggestions: z.array(maskSuggestionSchema),
  updatedAt: isoDateTimeSchema,
});

export const maskIntelligenceResponseSchema = z.object({
  maskIntelligence: maskIntelligenceReportSchema,
});

export const partReferencePackageSchema = z.object({
  bbox: bboxSchema,
  createdAt: isoDateTimeSchema,
  exactMaskPixels: z.array(editorPointSchema),
  frameId: z.string().min(1),
  fullPreviewUrl: z.string().min(1),
  id: z.string().min(1),
  maskLayerId: z.string().min(1),
  pixelMapUrl: z.string().min(1),
  promptHint: z.string(),
  referenceImagePath: z.string().min(1),
  referenceImageUrl: z.string().min(1),
  runId: z.string().min(1),
  semanticLabel: z.string(),
  semanticRole: semanticMaskRoleSchema,
});

export const createPartReferenceRequestSchema = z.object({
  frameId: z.string().min(1).optional(),
  maskLayerId: z.string().min(1),
});

export const partReferenceResponseSchema = z.object({
  reference: partReferencePackageSchema,
});

export const partRegenerationRequestSchema = z.object({
  frameIds: z.array(z.string().min(1)).default([]),
  maskLayerId: z.string().min(1),
  mode: z.enum(["animation", "single-frame"]).default("single-frame"),
  preserveOutsideMask: z.boolean().default(true),
  prompt: z.string().min(1),
  referenceId: z.string().min(1).optional(),
});

export const partRegenerationDraftSchema = z.object({
  createdAt: isoDateTimeSchema,
  id: z.string().min(1),
  input: partRegenerationRequestSchema,
  instructions: z.array(z.string()),
  reference: partReferencePackageSchema,
  runId: z.string().min(1),
  status: z.enum(["draft", "ready-for-imagegen", "applied", "cancelled"]),
});

export const partRegenerationDraftResponseSchema = z.object({
  regeneration: partRegenerationDraftSchema,
});

export const imagegenPreserveRulesSchema = z.object({
  lockedLayerIds: z.array(z.string().min(1)).default([]),
  preserveOutsideMask: z.boolean().default(true),
  preservePalette: z.boolean().default(true),
});

export const createImagegenRequestSchema = z.object({
  candidateCount: z.number().int().positive().default(1),
  negativePrompt: z
    .string()
    .default(
      "Do not change pixels outside the selected mask. Do not introduce anti-aliasing."
    ),
  prompt: z.string().min(1).optional(),
  regenerationId: z.string().min(1),
});

export const imagegenRequestArtifactSchema = z.object({
  candidateCount: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  frameIds: z.array(z.string().min(1)),
  fullPreviewUrl: z.string().min(1),
  id: z.string().min(1),
  maskLayerId: z.string().min(1),
  negativePrompt: z.string(),
  pixelMapUrl: z.string().min(1),
  preserveRules: imagegenPreserveRulesSchema,
  prompt: z.string().min(1),
  reference: partReferencePackageSchema,
  regenerationId: z.string().min(1),
  requestJsonPath: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["ready-for-imagegen", "result-recorded", "applied"]),
});

export const imagegenCandidateSchema = z.object({
  frameId: z.string().min(1),
  grid: pixelGridSchema.optional(),
  id: z.string().min(1),
  imagePath: z.string().min(1).optional(),
  notes: z.string().default(""),
  score: z.number().min(0).max(1).nullable().default(null),
});

export const recordImagegenResultRequestSchema = z.object({
  candidates: z.array(imagegenCandidateSchema).min(1),
  notes: z.string().default(""),
  requestId: z.string().min(1),
  selectedCandidateId: z.string().min(1).optional(),
});

export const imagegenResultArtifactSchema = z.object({
  appliedAt: isoDateTimeSchema.nullable().default(null),
  candidates: z.array(imagegenCandidateSchema),
  createdAt: isoDateTimeSchema,
  diffSummary: z.object({
    changedInsideMask: z.number().int().nonnegative(),
    outsideMaskChangesIgnored: z.number().int().nonnegative(),
  }),
  id: z.string().min(1),
  notes: z.string(),
  requestId: z.string().min(1),
  resultJsonPath: z.string().min(1),
  runId: z.string().min(1),
  selectedCandidateId: z.string().min(1).nullable(),
  status: z.enum(["candidate", "approved", "applied", "rejected"]),
});

export const imagegenCandidateInspectionSchema = z.object({
  alphaBBoxDriftPixels: z.number().int().nonnegative(),
  candidateId: z.string().min(1),
  comparePreviewUrl: z.string().min(1),
  diagnostics: z.array(
    z.object({
      code: z.enum([
        "empty-candidate",
        "large-alpha-drift",
        "low-mask-change",
        "outside-mask-change",
        "palette-drift",
      ]),
      details: z.record(z.string(), z.unknown()).default({}),
      message: z.string().min(1),
      severity: z.enum(["error", "info", "warning"]),
    })
  ),
  diffSummary: imagegenResultArtifactSchema.shape.diffSummary,
  frameId: z.string().min(1),
  maskCoverageRatio: z.number().min(0).max(1),
  outsideMaskIgnoredPixels: z.number().int().nonnegative(),
  paletteDriftColors: z.array(rgbColorSchema),
  recommendations: z.array(z.string()),
  score: z.number().min(0).max(1),
});

export const imagegenResultInspectionSchema = z.object({
  candidates: z.array(imagegenCandidateInspectionSchema),
  recommendedCandidateId: z.string().min(1).nullable(),
  requestId: z.string().min(1),
  resultId: z.string().min(1),
  runId: z.string().min(1),
  summary: z.string(),
  updatedAt: isoDateTimeSchema,
});

export const imagegenResultInspectionResponseSchema = z.object({
  inspection: imagegenResultInspectionSchema,
});

export const imagegenApplyPatchSchema = z.object({
  after: pixelCellSchema,
  before: pixelCellSchema,
  frameId: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const imagegenIgnoredOutsideMaskPixelSchema = z.object({
  color: pixelCellSchema,
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const applyImagegenResultRequestSchema = z.object({
  candidateId: z.string().min(1).optional(),
});

export const imagegenApplyPreviewSchema = z.object({
  beforeInspection: frameVisualInspectionSchema,
  candidateId: z.string().min(1),
  comparePreviewUrl: z.string().min(1),
  estimatedAfterInspection: frameVisualInspectionSchema,
  frameId: z.string().min(1),
  ignoredOutsideMaskPixels: z.array(imagegenIgnoredOutsideMaskPixelSchema),
  patches: z.array(imagegenApplyPatchSchema),
  recommendations: z.array(z.string()),
  requiresCheckpoint: z.boolean(),
  resultId: z.string().min(1),
  runId: z.string().min(1),
});

export const imagegenApplyPreviewResponseSchema = z.object({
  preview: imagegenApplyPreviewSchema,
});

export const imagegenRequestResponseSchema = z.object({
  imagegenRequest: imagegenRequestArtifactSchema,
});

export const imagegenResultResponseSchema = z.object({
  imagegenResult: imagegenResultArtifactSchema,
});

export const createEditorCheckpointRequestSchema = z.object({
  label: z.string().min(1).default("Checkpoint"),
  reason: z.string().default(""),
  source: z
    .enum(["agent", "api", "imagegen-apply", "manual", "system"])
    .default("agent"),
});

export const editorCheckpointSchema = z.object({
  createdAt: isoDateTimeSchema,
  document: editorDocumentSchema,
  id: z.string().min(1),
  label: z.string().min(1),
  reason: z.string(),
  runId: z.string().min(1),
  schemaVersion: z.literal(schemaVersion),
  source: z.enum(["agent", "api", "imagegen-apply", "manual", "system"]),
});

export const editorCheckpointResponseSchema = z.object({
  checkpoint: editorCheckpointSchema,
});

export const editorOperationPatchSchema = z.object({
  after: pixelCellSchema,
  before: pixelCellSchema,
  frameId: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const editorMaskOperationPatchSchema = z.object({
  after: z.boolean(),
  before: z.boolean(),
  layerId: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const editorOperationLogEntrySchema = z.object({
  afterRevision: z.number().int().nonnegative(),
  beforeRevision: z.number().int().nonnegative(),
  checkpointId: z.string().min(1).nullable().default(null),
  createdAt: isoDateTimeSchema,
  id: z.string().min(1),
  label: z.string().min(1),
  maskPatches: z.array(editorMaskOperationPatchSchema).default([]),
  operationType: z.enum([
    "animation-fix",
    "checkpoint-revert",
    "edit-intent",
    "editor-operations",
    "imagegen-apply",
    "operation-revert",
    "pixel-write",
    "snapshot",
  ]),
  patches: z.array(editorOperationPatchSchema),
  reason: z.string().default(""),
  revertedAt: isoDateTimeSchema.nullable().default(null),
  revertedByOperationId: z.string().min(1).nullable().default(null),
  runId: z.string().min(1),
  schemaVersion: z.literal(schemaVersion),
  source: z.enum(["agent", "api", "imagegen-apply", "manual", "system"]),
});

export const editorOperationLogResponseSchema = z.object({
  operations: z.array(editorOperationLogEntrySchema),
});

export const revertEditorOperationRequestSchema = z.object({
  createRollbackCheckpoint: z.boolean().default(true),
  operationId: z.string().min(1),
});

export const revertEditorOperationResponseSchema = z.object({
  document: editorDocumentSchema,
  operation: editorOperationLogEntrySchema,
  revertOperation: editorOperationLogEntrySchema,
  rollbackCheckpoint: editorCheckpointSchema.nullable(),
});

export const checkpointFrameDiffSchema = z.object({
  bbox: bboxSchema.nullable(),
  changedPixels: z.number().int().nonnegative(),
  frameId: z.string().min(1),
});

export const checkpointMaskDiffSchema = z.object({
  bbox: bboxSchema.nullable(),
  changedPixels: z.number().int().nonnegative(),
  layerId: z.string().min(1),
});

export const checkpointComparisonSchema = z.object({
  createdAt: isoDateTimeSchema,
  frameDiffs: z.array(checkpointFrameDiffSchema),
  leftCheckpointId: z.string().min(1),
  maskDiffs: z.array(checkpointMaskDiffSchema),
  rightCheckpointId: z.string().min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal(schemaVersion),
  summary: z.object({
    changedFrames: z.number().int().nonnegative(),
    changedMasks: z.number().int().nonnegative(),
    changedPixels: z.number().int().nonnegative(),
  }),
});

export const checkpointComparisonResponseSchema = z.object({
  comparison: checkpointComparisonSchema,
});

export const animationFixPreviewSchema = z.object({
  beforeInspection: animationInspectionSchema,
  estimatedAfterInspection: animationInspectionSchema,
  mode: animationFixRequestSchema.shape.mode,
  patches: z.array(animationFixPatchSchema),
  recommendations: z.array(z.string()),
  requiresCheckpoint: z.boolean(),
  runId: z.string().min(1),
});

export const animationFixPreviewResponseSchema = z.object({
  preview: animationFixPreviewSchema,
});

export const animationFixResultSchema = z.object({
  afterInspection: animationInspectionSchema,
  appliedPatches: z.array(animationFixPatchSchema),
  beforeInspection: animationInspectionSchema,
  checkpoint: editorCheckpointSchema,
  document: editorDocumentSchema,
  mode: animationFixRequestSchema.shape.mode,
  preview: animationFixPreviewSchema,
  recommendations: z.array(z.string()),
  runId: z.string().min(1),
});

export const animationFixResponseSchema = z.object({
  animationFix: animationFixResultSchema,
});

export const editorCheckpointsResponseSchema = z.object({
  checkpoints: z.array(editorCheckpointSchema),
});

export const revertEditorCheckpointRequestSchema = z.object({
  checkpointId: z.string().min(1),
  createRollbackCheckpoint: z.boolean().default(true),
});

export const revertEditorCheckpointResponseSchema = z.object({
  checkpoint: editorCheckpointSchema,
  document: editorDocumentSchema,
  rollbackCheckpoint: editorCheckpointSchema.nullable(),
});

export const editIntentTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mask-layer"),
    maskLayerId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("semantic-role"),
    role: semanticMaskRoleSchema,
  }),
  z.object({
    frameId: z.string().min(1).optional(),
    kind: z.literal("visual-feature"),
    visualKind: visualFeatureSchema.shape.kind,
  }),
]);

export const editIntentSchema = z.discriminatedUnion("intent", [
  z.object({
    color: pixelColorSchema,
    frameId: z.string().min(1).optional(),
    intent: z.literal("recolor-target"),
    preserveOutline: z.boolean().default(true),
    target: editIntentTargetSchema,
  }),
  z.object({
    color: pixelColorSchema,
    frameId: z.string().min(1).optional(),
    intent: z.literal("recolor-mask"),
    maskLayerId: z.string().min(1),
    preserveOutline: z.boolean().default(true),
  }),
]);

export const editIntentRequestSchema = z.object({
  intent: editIntentSchema,
});

export const editIntentPatchSchema = z.object({
  after: pixelCellSchema,
  before: pixelCellSchema,
  frameId: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const editIntentPreviewSchema = z.object({
  changedPixels: z.number().int().nonnegative(),
  intent: editIntentSchema,
  patches: z.array(editIntentPatchSchema),
  recommendations: z.array(z.string()),
  requiresCheckpoint: z.boolean(),
  runId: z.string().min(1),
  targetSummary: z.string(),
});

export const editIntentPreviewResponseSchema = z.object({
  preview: editIntentPreviewSchema,
});

export const editIntentApplyResponseSchema = z.object({
  checkpoint: editorCheckpointSchema,
  document: editorDocumentSchema,
  preview: editIntentPreviewSchema,
});

export type EditorDocument = z.infer<typeof editorDocumentSchema>;
export type EditorCheckpoint = z.infer<typeof editorCheckpointSchema>;
export type EditorOperationLogEntry = z.infer<
  typeof editorOperationLogEntrySchema
>;
export type CheckpointComparison = z.infer<typeof checkpointComparisonSchema>;
export type EditIntentPreview = z.infer<typeof editIntentPreviewSchema>;
export type EditorFrame = z.infer<typeof editorFrameSchema>;
export type EditorMaskLayer = z.infer<typeof editorMaskLayerSchema>;
export type EditorOperation = z.infer<typeof editorOperationSchema>;
export type EditorOperationsRequest = z.infer<
  typeof editorOperationsRequestSchema
>;
export type EditorSelectionState = z.infer<typeof editorSelectionStateSchema>;
export type FrameVisualInspection = z.infer<typeof frameVisualInspectionSchema>;
export type AnimationInspection = z.infer<typeof animationInspectionSchema>;
export type AnimationFixPreview = z.infer<typeof animationFixPreviewSchema>;
export type AnimationFixResult = z.infer<typeof animationFixResultSchema>;
export type AgentProjectMemory = z.infer<typeof agentProjectMemorySchema>;
export type MaskIntelligenceReport = z.infer<
  typeof maskIntelligenceReportSchema
>;
export type PartReferencePackage = z.infer<typeof partReferencePackageSchema>;
export type PartRegenerationDraft = z.infer<typeof partRegenerationDraftSchema>;
export type ImagegenRequestArtifact = z.infer<
  typeof imagegenRequestArtifactSchema
>;
export type ImagegenResultArtifact = z.infer<
  typeof imagegenResultArtifactSchema
>;
export type ImagegenResultInspection = z.infer<
  typeof imagegenResultInspectionSchema
>;
export type ImagegenApplyPreview = z.infer<typeof imagegenApplyPreviewSchema>;
export type PixelCell = z.infer<typeof pixelCellSchema>;
export type PixelGrid = z.infer<typeof pixelGridSchema>;
export type VisualSummary = z.infer<typeof visualSummarySchema>;
