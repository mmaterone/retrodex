import animationDraftSchemaJson from "../../../packages/contracts/src/schemas/animation-draft.schema.json";
import frameSchemaJson from "../../../packages/contracts/src/schemas/frame.schema.json";
import runSchemaJson from "../../../packages/contracts/src/schemas/run.schema.json";
import savedAnimationSchemaJson from "../../../packages/contracts/src/schemas/saved-animation.schema.json";

const rewriteContractRefs = (
  value: unknown,
  componentName: string
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteContractRefs(item, componentName));
  }
  if (!(value && typeof value === "object")) {
    return value;
  }
  const entries = Object.entries(value).map(([key, item]) => {
    if (key === "$id" || key === "$schema") {
      return null;
    }
    if (key === "$ref" && typeof item === "string") {
      if (item.startsWith("#/")) {
        return [key, `#/components/schemas/${componentName}/${item.slice(2)}`];
      }
      return [
        key,
        item
          .replaceAll("run.schema.json#", "#/components/schemas/Run")
          .replaceAll("frame.schema.json#", "#/components/schemas/Frame"),
      ];
    }
    return [key, rewriteContractRefs(item, componentName)];
  });
  return Object.fromEntries(
    entries.filter((entry): entry is [string, unknown] => entry !== null)
  );
};

const runContractSchema = rewriteContractRefs(runSchemaJson, "Run");
const frameContractSchema = rewriteContractRefs(frameSchemaJson, "Frame");
const animationDraftContractSchema = rewriteContractRefs(
  animationDraftSchemaJson,
  "AnimationDraft"
);
const savedAnimationContractSchema = rewriteContractRefs(
  savedAnimationSchemaJson,
  "SavedAnimation"
);

const jsonContent = (schema: unknown) => ({
  content: {
    "application/json": {
      schema,
    },
  },
});

const response = (description: string, schema: unknown) => ({
  content: {
    "application/json": {
      schema,
    },
  },
  description,
});

const pathParam = (name: string, description: string) => ({
  description,
  in: "path",
  name,
  required: true,
  schema: { minLength: 1, type: "string" },
});

const exportTargets = [
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
] as const;

const schemas: Record<string, unknown> = {
  AddFrameAutoSliceComponentsRequest: {
    additionalProperties: false,
    properties: {
      mode: { const: "auto-slice-components" },
      sheet: { $ref: "#/components/schemas/AutoSliceSourceSheet" },
    },
    required: ["mode", "sheet"],
    type: "object",
  },
  AddFrameCopyRequest: {
    additionalProperties: false,
    properties: {
      frame: { $ref: "#/components/schemas/SourceFrame" },
      mode: { const: "copy-frame", default: "copy-frame" },
    },
    required: ["frame"],
    type: "object",
  },
  AddFrameRequest: {
    oneOf: [
      { $ref: "#/components/schemas/AddFrameAutoSliceComponentsRequest" },
      { $ref: "#/components/schemas/AddFrameCopyRequest" },
      { $ref: "#/components/schemas/AddFrameSplitSheetRequest" },
    ],
  },
  AddFrameResponse: {
    additionalProperties: false,
    properties: {
      run: { $ref: "#/components/schemas/Run" },
    },
    required: ["run"],
    type: "object",
  },
  AddFrameSplitSheetRequest: {
    additionalProperties: false,
    properties: {
      mode: { const: "split-sheet" },
      sheet: { $ref: "#/components/schemas/SourceSheet" },
    },
    required: ["mode", "sheet"],
    type: "object",
  },
  AgentProjectMemory: {
    additionalProperties: false,
    properties: {
      constraints: { items: { type: "string" }, type: "array" },
      decisionLog: {
        items: {
          additionalProperties: false,
          properties: {
            at: { format: "date-time", type: "string" },
            by: { enum: ["agent", "system", "user"] },
            decision: { minLength: 1, type: "string" },
            reason: { type: "string" },
          },
          required: ["at", "by", "decision", "reason"],
          type: "object",
        },
        type: "array",
      },
      projectBrief: { type: "string" },
      protectedDetails: { items: { type: "string" }, type: "array" },
      schemaVersion: { const: "2026-06-04.v1" },
      styleGuide: {
        additionalProperties: false,
        properties: {
          animationRules: { items: { type: "string" }, type: "array" },
          outlineRules: { items: { type: "string" }, type: "array" },
          palette: {
            items: { pattern: "^#[0-9a-fA-F]{6}$", type: "string" },
            type: "array",
          },
          shadingRules: { items: { type: "string" }, type: "array" },
        },
        required: ["animationRules", "outlineRules", "palette", "shadingRules"],
        type: "object",
      },
      updatedAt: { format: "date-time", type: "string" },
    },
    required: [
      "constraints",
      "decisionLog",
      "projectBrief",
      "protectedDetails",
      "schemaVersion",
      "styleGuide",
      "updatedAt",
    ],
    type: "object",
  },
  AgentProjectMemoryResponse: {
    additionalProperties: false,
    properties: {
      memory: { $ref: "#/components/schemas/AgentProjectMemory" },
    },
    required: ["memory"],
    type: "object",
  },
  AnimationDraft: animationDraftContractSchema,
  AnimationFixPatch: {
    additionalProperties: false,
    properties: {
      after: { $ref: "#/components/schemas/PixelCell" },
      before: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      reason: { minLength: 1, type: "string" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["after", "before", "frameId", "reason", "x", "y"],
    type: "object",
  },
  AnimationFixPreview: {
    additionalProperties: false,
    properties: {
      beforeInspection: { $ref: "#/components/schemas/AnimationInspection" },
      estimatedAfterInspection: {
        $ref: "#/components/schemas/AnimationInspection",
      },
      mode: {
        enum: ["fix-flicker", "repair-loop-pop", "smooth-mask-motion"],
      },
      patches: {
        items: { $ref: "#/components/schemas/AnimationFixPatch" },
        type: "array",
      },
      recommendations: { items: { type: "string" }, type: "array" },
      requiresCheckpoint: { type: "boolean" },
      runId: { minLength: 1, type: "string" },
    },
    required: [
      "beforeInspection",
      "estimatedAfterInspection",
      "mode",
      "patches",
      "recommendations",
      "requiresCheckpoint",
      "runId",
    ],
    type: "object",
  },
  AnimationFixPreviewResponse: {
    additionalProperties: false,
    properties: {
      preview: { $ref: "#/components/schemas/AnimationFixPreview" },
    },
    required: ["preview"],
    type: "object",
  },
  AnimationFixRequest: {
    additionalProperties: false,
    properties: {
      frameIds: { items: { minLength: 1, type: "string" }, type: "array" },
      maskLayerId: { minLength: 1, type: "string" },
      mode: {
        enum: ["fix-flicker", "repair-loop-pop", "smooth-mask-motion"],
      },
    },
    required: ["mode"],
    type: "object",
  },
  AnimationFixResponse: {
    additionalProperties: false,
    properties: {
      animationFix: { $ref: "#/components/schemas/AnimationFixResult" },
    },
    required: ["animationFix"],
    type: "object",
  },
  AnimationFixResult: {
    additionalProperties: false,
    properties: {
      afterInspection: { $ref: "#/components/schemas/AnimationInspection" },
      appliedPatches: {
        items: { $ref: "#/components/schemas/AnimationFixPatch" },
        type: "array",
      },
      beforeInspection: { $ref: "#/components/schemas/AnimationInspection" },
      checkpoint: { $ref: "#/components/schemas/EditorCheckpoint" },
      document: { $ref: "#/components/schemas/EditorDocument" },
      mode: {
        enum: ["fix-flicker", "repair-loop-pop", "smooth-mask-motion"],
      },
      preview: { $ref: "#/components/schemas/AnimationFixPreview" },
      recommendations: { items: { type: "string" }, type: "array" },
      runId: { minLength: 1, type: "string" },
    },
    required: [
      "afterInspection",
      "appliedPatches",
      "beforeInspection",
      "checkpoint",
      "document",
      "mode",
      "preview",
      "recommendations",
      "runId",
    ],
    type: "object",
  },
  AnimationFlickerRegion: {
    additionalProperties: false,
    properties: {
      bbox: { $ref: "#/components/schemas/Frame/$defs/bbox" },
      confidence: { maximum: 1, minimum: 0, type: "number" },
      description: { minLength: 1, type: "string" },
      pixels: {
        items: { $ref: "#/components/schemas/EditorPoint" },
        type: "array",
      },
    },
    required: ["bbox", "confidence", "description", "pixels"],
    type: "object",
  },
  AnimationFrameDiff: {
    additionalProperties: false,
    properties: {
      changedPixels: { minimum: 0, type: "integer" },
      changedRatio: { maximum: 1, minimum: 0, type: "number" },
      fromFrameId: { minLength: 1, type: "string" },
      motionBBox: {
        anyOf: [
          { $ref: "#/components/schemas/Frame/$defs/bbox" },
          { type: "null" },
        ],
      },
      silhouetteChangedPixels: { minimum: 0, type: "integer" },
      silhouetteWarning: { type: ["string", "null"] },
      toFrameId: { minLength: 1, type: "string" },
    },
    required: [
      "changedPixels",
      "changedRatio",
      "fromFrameId",
      "motionBBox",
      "silhouetteChangedPixels",
      "silhouetteWarning",
      "toFrameId",
    ],
    type: "object",
  },
  AnimationInspection: {
    additionalProperties: false,
    properties: {
      diagnostics: {
        items: {
          additionalProperties: false,
          properties: {
            code: {
              enum: [
                "empty-animation",
                "flicker-risk",
                "loop-break",
                "mask-motion",
                "silhouette-break",
              ],
            },
            details: { type: "object" },
            message: { minLength: 1, type: "string" },
            severity: { enum: ["error", "info", "warning"] },
          },
          required: ["code", "details", "message", "severity"],
          type: "object",
        },
        type: "array",
      },
      flickerRegions: {
        items: { $ref: "#/components/schemas/AnimationFlickerRegion" },
        type: "array",
      },
      fps: { minimum: 1, type: "integer" },
      frameDiffs: {
        items: { $ref: "#/components/schemas/AnimationFrameDiff" },
        type: "array",
      },
      frameIds: { items: { minLength: 1, type: "string" }, type: "array" },
      loopQualityScore: { maximum: 1, minimum: 0, type: "number" },
      maskMotionTracks: {
        items: { $ref: "#/components/schemas/AnimationMaskMotionTrack" },
        type: "array",
      },
      recommendations: { items: { type: "string" }, type: "array" },
      runId: { minLength: 1, type: "string" },
      schemaVersion: { const: "2026-06-04.v1" },
      summary: { type: "string" },
      updatedAt: { format: "date-time", type: "string" },
    },
    required: [
      "diagnostics",
      "flickerRegions",
      "fps",
      "frameDiffs",
      "frameIds",
      "loopQualityScore",
      "maskMotionTracks",
      "recommendations",
      "runId",
      "schemaVersion",
      "summary",
      "updatedAt",
    ],
    type: "object",
  },
  AnimationInspectionResponse: {
    additionalProperties: false,
    properties: {
      animationInspection: {
        $ref: "#/components/schemas/AnimationInspection",
      },
    },
    required: ["animationInspection"],
    type: "object",
  },
  AnimationMaskMotionTrack: {
    additionalProperties: false,
    properties: {
      averageChangedPixels: { minimum: 0, type: "number" },
      keyframes: {
        items: {
          additionalProperties: false,
          properties: {
            changedPixels: { minimum: 0, type: "integer" },
            frameId: { minLength: 1, type: "string" },
            motionBBox: {
              anyOf: [
                { $ref: "#/components/schemas/Frame/$defs/bbox" },
                { type: "null" },
              ],
            },
          },
          required: ["changedPixels", "frameId", "motionBBox"],
          type: "object",
        },
        type: "array",
      },
      maskLayerId: { minLength: 1, type: "string" },
      semanticLabel: { type: "string" },
      semanticRole: {
        enum: [
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
        ],
      },
      stability: { maximum: 1, minimum: 0, type: "number" },
    },
    required: [
      "averageChangedPixels",
      "keyframes",
      "maskLayerId",
      "semanticLabel",
      "semanticRole",
      "stability",
    ],
    type: "object",
  },
  ApplyImagegenResultRequest: {
    additionalProperties: false,
    properties: {
      candidateId: { minLength: 1, type: "string" },
    },
    type: "object",
  },
  ApproveFrameRequest: {
    additionalProperties: false,
    properties: {
      approved: { default: true, type: "boolean" },
      approvedBy: {
        default: "user",
        enum: ["user", "agent", "system"],
      },
      note: { minLength: 1, type: "string" },
    },
    type: "object",
  },
  ApproveFrameResponse: {
    additionalProperties: false,
    properties: {
      frame: { $ref: "#/components/schemas/Frame" },
      run: { $ref: "#/components/schemas/Run" },
    },
    required: ["frame", "run"],
    type: "object",
  },
  AutoSliceSourceSheet: {
    additionalProperties: false,
    properties: {
      alphaThreshold: { minimum: 1, type: "integer" },
      minAreaFrac: { exclusiveMinimum: 0, type: "number" },
      pad: { minimum: 0, type: "integer" },
      path: { minLength: 1, type: "string" },
    },
    required: ["path"],
    type: "object",
  },
  CancelJobRequest: {
    additionalProperties: false,
    properties: {
      action: { const: "cancel" },
    },
    required: ["action"],
    type: "object",
  },
  CheckpointComparison: {
    additionalProperties: false,
    properties: {
      createdAt: { format: "date-time", type: "string" },
      frameDiffs: {
        items: { $ref: "#/components/schemas/CheckpointFrameDiff" },
        type: "array",
      },
      leftCheckpointId: { minLength: 1, type: "string" },
      maskDiffs: {
        items: { $ref: "#/components/schemas/CheckpointMaskDiff" },
        type: "array",
      },
      rightCheckpointId: { minLength: 1, type: "string" },
      runId: { minLength: 1, type: "string" },
      schemaVersion: { const: "2026-06-04.v1" },
      summary: {
        additionalProperties: false,
        properties: {
          changedFrames: { minimum: 0, type: "integer" },
          changedMasks: { minimum: 0, type: "integer" },
          changedPixels: { minimum: 0, type: "integer" },
        },
        required: ["changedFrames", "changedMasks", "changedPixels"],
        type: "object",
      },
    },
    required: [
      "createdAt",
      "frameDiffs",
      "leftCheckpointId",
      "maskDiffs",
      "rightCheckpointId",
      "runId",
      "schemaVersion",
      "summary",
    ],
    type: "object",
  },
  CheckpointComparisonResponse: {
    additionalProperties: false,
    properties: {
      comparison: { $ref: "#/components/schemas/CheckpointComparison" },
    },
    required: ["comparison"],
    type: "object",
  },
  CheckpointFrameDiff: {
    additionalProperties: false,
    properties: {
      bbox: {
        anyOf: [
          { $ref: "#/components/schemas/Frame/$defs/bbox" },
          { type: "null" },
        ],
      },
      changedPixels: { minimum: 0, type: "integer" },
      frameId: { minLength: 1, type: "string" },
    },
    required: ["bbox", "changedPixels", "frameId"],
    type: "object",
  },
  CheckpointMaskDiff: {
    additionalProperties: false,
    properties: {
      bbox: {
        anyOf: [
          { $ref: "#/components/schemas/Frame/$defs/bbox" },
          { type: "null" },
        ],
      },
      changedPixels: { minimum: 0, type: "integer" },
      layerId: { minLength: 1, type: "string" },
    },
    required: ["bbox", "changedPixels", "layerId"],
    type: "object",
  },
  CreateEditorCheckpointRequest: {
    additionalProperties: false,
    properties: {
      label: { minLength: 1, type: "string" },
      reason: { type: "string" },
      source: {
        enum: ["agent", "api", "imagegen-apply", "manual", "system"],
      },
    },
    type: "object",
  },
  CreateExportRequest: {
    additionalProperties: false,
    properties: {
      fps: { minimum: 1, type: "integer" },
      name: { minLength: 1, type: "string" },
      targets: {
        default: ["raw-frames", "game-strip"],
        items: { enum: exportTargets },
        type: "array",
      },
    },
    required: ["name"],
    type: "object",
  },
  CreateImagegenRequest: {
    additionalProperties: false,
    properties: {
      candidateCount: { minimum: 1, type: "integer" },
      negativePrompt: { type: "string" },
      prompt: { minLength: 1, type: "string" },
      regenerationId: { minLength: 1, type: "string" },
    },
    required: ["regenerationId"],
    type: "object",
  },
  CreatePartReferenceRequest: {
    additionalProperties: false,
    properties: {
      frameId: { minLength: 1, type: "string" },
      maskLayerId: { minLength: 1, type: "string" },
    },
    required: ["maskLayerId"],
    type: "object",
  },
  CreateRunRequest: {
    additionalProperties: false,
    properties: {
      asset: { $ref: "#/components/schemas/AssetPlan" },
      canvas: { $ref: "#/components/schemas/CanvasSize" },
      importRunPath: { minLength: 1, type: "string" },
      name: { minLength: 1, type: "string" },
      presetId: { minLength: 1, type: "string" },
      sourceFrames: {
        default: [],
        items: { $ref: "#/components/schemas/SourceFrame" },
        type: "array",
      },
      sourceSheet: { $ref: "#/components/schemas/SourceSheet" },
    },
    required: ["asset", "name"],
    type: "object",
  },
  EditIntentApplyResponse: {
    additionalProperties: false,
    properties: {
      checkpoint: { $ref: "#/components/schemas/EditorCheckpoint" },
      document: { $ref: "#/components/schemas/EditorDocument" },
      preview: { $ref: "#/components/schemas/EditIntentPreview" },
    },
    required: ["checkpoint", "document", "preview"],
    type: "object",
  },
  EditIntentPatch: {
    additionalProperties: false,
    properties: {
      after: { $ref: "#/components/schemas/PixelCell" },
      before: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["after", "before", "frameId", "x", "y"],
    type: "object",
  },
  EditIntentPreview: {
    additionalProperties: false,
    properties: {
      changedPixels: { minimum: 0, type: "integer" },
      intent: {
        oneOf: [
          { $ref: "#/components/schemas/EditRecolorTargetIntent" },
          { $ref: "#/components/schemas/EditRecolorMaskIntent" },
        ],
      },
      patches: {
        items: { $ref: "#/components/schemas/EditIntentPatch" },
        type: "array",
      },
      recommendations: { items: { type: "string" }, type: "array" },
      requiresCheckpoint: { type: "boolean" },
      runId: { minLength: 1, type: "string" },
      targetSummary: { type: "string" },
    },
    required: [
      "changedPixels",
      "intent",
      "patches",
      "recommendations",
      "requiresCheckpoint",
      "runId",
      "targetSummary",
    ],
    type: "object",
  },
  EditIntentPreviewResponse: {
    additionalProperties: false,
    properties: {
      preview: { $ref: "#/components/schemas/EditIntentPreview" },
    },
    required: ["preview"],
    type: "object",
  },
  EditIntentRequest: {
    additionalProperties: false,
    properties: {
      intent: {
        oneOf: [
          { $ref: "#/components/schemas/EditRecolorTargetIntent" },
          { $ref: "#/components/schemas/EditRecolorMaskIntent" },
        ],
      },
    },
    required: ["intent"],
    type: "object",
  },
  EditIntentTarget: {
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          kind: { const: "mask-layer" },
          maskLayerId: { minLength: 1, type: "string" },
        },
        required: ["kind", "maskLayerId"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          kind: { const: "semantic-role" },
          role: {
            enum: [
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
            ],
          },
        },
        required: ["kind", "role"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          frameId: { minLength: 1, type: "string" },
          kind: { const: "visual-feature" },
          visualKind: {
            enum: [
              "alpha-bbox",
              "eye-candidate",
              "face-candidate",
              "mask-part",
              "motion-region",
              "palette-cluster",
              "tiny-detail",
            ],
          },
        },
        required: ["kind", "visualKind"],
        type: "object",
      },
    ],
  },
  EditRecolorMaskIntent: {
    additionalProperties: false,
    properties: {
      color: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      intent: { const: "recolor-mask" },
      maskLayerId: { minLength: 1, type: "string" },
      preserveOutline: { type: "boolean" },
    },
    required: ["color", "intent", "maskLayerId", "preserveOutline"],
    type: "object",
  },
  EditRecolorTargetIntent: {
    additionalProperties: false,
    properties: {
      color: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      intent: { const: "recolor-target" },
      preserveOutline: { type: "boolean" },
      target: { $ref: "#/components/schemas/EditIntentTarget" },
    },
    required: ["color", "intent", "preserveOutline", "target"],
    type: "object",
  },
  EditorBucketFillOperation: {
    additionalProperties: false,
    properties: {
      color: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      respectMaskLayerIds: {
        items: { minLength: 1, type: "string" },
        type: "array",
      },
      type: { const: "bucket-fill" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["color", "frameId", "type", "x", "y"],
    type: "object",
  },
  EditorCheckpoint: {
    additionalProperties: false,
    properties: {
      createdAt: { format: "date-time", type: "string" },
      document: { $ref: "#/components/schemas/EditorDocument" },
      id: { minLength: 1, type: "string" },
      label: { minLength: 1, type: "string" },
      reason: { type: "string" },
      runId: { minLength: 1, type: "string" },
      schemaVersion: { const: "2026-06-04.v1" },
      source: {
        enum: ["agent", "api", "imagegen-apply", "manual", "system"],
      },
    },
    required: [
      "createdAt",
      "document",
      "id",
      "label",
      "reason",
      "runId",
      "schemaVersion",
      "source",
    ],
    type: "object",
  },
  EditorCheckpointResponse: {
    additionalProperties: false,
    properties: {
      checkpoint: { $ref: "#/components/schemas/EditorCheckpoint" },
    },
    required: ["checkpoint"],
    type: "object",
  },
  EditorCheckpointsResponse: {
    additionalProperties: false,
    properties: {
      checkpoints: {
        items: { $ref: "#/components/schemas/EditorCheckpoint" },
        type: "array",
      },
    },
    required: ["checkpoints"],
    type: "object",
  },
  EditorDeleteMaskLayerOperation: {
    additionalProperties: false,
    properties: {
      layerId: { minLength: 1, type: "string" },
      type: { const: "delete-mask-layer" },
    },
    required: ["layerId", "type"],
    type: "object",
  },
  EditorDeleteSelectedPixelsOperation: {
    additionalProperties: false,
    properties: {
      bounds: { $ref: "#/components/schemas/EditorTargetBounds" },
      clearMaskLayerIds: {
        items: { minLength: 1, type: "string" },
        type: "array",
      },
      frameId: { minLength: 1, type: "string" },
      mask: { items: { type: "boolean" }, type: "array" },
      maskLayerIds: {
        items: { minLength: 1, type: "string" },
        type: "array",
      },
      type: { const: "delete-selected-pixels" },
    },
    required: ["frameId", "type"],
    type: "object",
  },
  EditorDeleteTargetOperation: {
    additionalProperties: false,
    properties: {
      bounds: { $ref: "#/components/schemas/EditorTargetBounds" },
      clearMaskLayerIds: {
        items: { minLength: 1, type: "string" },
        type: "array",
      },
      frameId: { minLength: 1, type: "string" },
      type: { const: "delete-target" },
    },
    required: ["bounds", "frameId", "type"],
    type: "object",
  },
  EditorDocument: {
    additionalProperties: false,
    properties: {
      activeMaskLayerId: { type: ["string", "null"] },
      canvas: { $ref: "#/components/schemas/CanvasSize" },
      createdAt: { format: "date-time", type: "string" },
      frames: {
        items: { $ref: "#/components/schemas/EditorFrame" },
        type: "array",
      },
      masks: {
        items: { $ref: "#/components/schemas/EditorMaskLayer" },
        type: "array",
      },
      runId: { minLength: 1, type: "string" },
      saveState: { $ref: "#/components/schemas/EditorSaveState" },
      schemaVersion: { const: "2026-06-04.v1" },
      selectedFrameId: { type: ["string", "null"] },
      selection: { $ref: "#/components/schemas/EditorSelectionState" },
      timeline: {
        additionalProperties: false,
        properties: {
          fps: { minimum: 1, type: "integer" },
          framesList: { items: { type: "string" }, type: "array" },
          isPlaying: { type: "boolean" },
        },
        required: ["fps", "framesList", "isPlaying"],
        type: "object",
      },
      updatedAt: { format: "date-time", type: "string" },
    },
    required: [
      "activeMaskLayerId",
      "canvas",
      "createdAt",
      "frames",
      "masks",
      "runId",
      "saveState",
      "schemaVersion",
      "selection",
      "selectedFrameId",
      "timeline",
      "updatedAt",
    ],
    type: "object",
  },
  EditorDocumentResponse: {
    additionalProperties: false,
    properties: {
      document: { $ref: "#/components/schemas/EditorDocument" },
    },
    required: ["document"],
    type: "object",
  },
  EditorDocumentSaveRequest: {
    additionalProperties: false,
    properties: {
      document: { $ref: "#/components/schemas/EditorDocument" },
      expectedRevision: { minimum: 0, type: "integer" },
    },
    required: ["document"],
    type: "object",
  },
  EditorExportPreviewFile: {
    additionalProperties: false,
    properties: {
      contentBase64: { minLength: 1, type: "string" },
      filename: { minLength: 1, type: "string" },
      mediaType: { minLength: 1, type: "string" },
      size: { minimum: 0, type: "integer" },
    },
    required: ["contentBase64", "filename", "mediaType", "size"],
    type: "object",
  },
  EditorExportPreviewRequest: {
    additionalProperties: false,
    properties: {
      expectedRevision: { minimum: 0, type: "integer" },
      formats: {
        items: {
          enum: [
            "css",
            "gif",
            "json",
            "lottie",
            "png",
            "react",
            "svg",
            "tgs",
            "webm",
            "webp",
          ],
        },
        type: "array",
      },
      fps: { minimum: 1, type: "integer" },
      frameId: { minLength: 1, type: "string" },
      scale: { minimum: 1, type: "integer" },
      scope: { enum: ["animation", "frame"] },
    },
    type: "object",
  },
  EditorExportPreviewResponse: {
    additionalProperties: false,
    properties: {
      preview: {
        additionalProperties: false,
        properties: {
          files: {
            items: { $ref: "#/components/schemas/EditorExportPreviewFile" },
            type: "array",
          },
          formats: { items: { type: "string" }, type: "array" },
          frameIds: { items: { type: "string" }, type: "array" },
          revision: { minimum: 0, type: "integer" },
          warnings: { items: { type: "string" }, type: "array" },
        },
        required: ["files", "formats", "frameIds", "revision", "warnings"],
        type: "object",
      },
    },
    required: ["preview"],
    type: "object",
  },
  EditorFrame: {
    additionalProperties: false,
    properties: {
      alphaBBox: {
        anyOf: [
          { $ref: "#/components/schemas/Frame/$defs/bbox" },
          { type: "null" },
        ],
      },
      anchor: { $ref: "#/components/schemas/Frame/$defs/anchor" },
      frameId: { minLength: 1, type: "string" },
      grid: { $ref: "#/components/schemas/PixelGrid" },
      name: { minLength: 1, type: "string" },
      sourcePath: { type: ["string", "null"] },
    },
    required: ["alphaBBox", "anchor", "frameId", "grid", "name", "sourcePath"],
    type: "object",
  },
  EditorGradientFillOperation: {
    additionalProperties: false,
    properties: {
      endCell: { $ref: "#/components/schemas/EditorPoint" },
      endColor: { $ref: "#/components/schemas/PixelColor" },
      frameId: { minLength: 1, type: "string" },
      kind: { enum: ["linear", "radial"] },
      pattern: { enum: ["bayer", "checker", "fine", "hard"] },
      startCell: { $ref: "#/components/schemas/EditorPoint" },
      startColor: { $ref: "#/components/schemas/PixelColor" },
      target: { enum: ["canvas", "connected", "mask"] },
      targetMaskLayerIds: {
        items: { minLength: 1, type: "string" },
        type: "array",
      },
      type: { const: "gradient-fill" },
    },
    required: [
      "endCell",
      "endColor",
      "frameId",
      "startCell",
      "startColor",
      "type",
    ],
    type: "object",
  },
  EditorMaskBucketOperation: {
    additionalProperties: false,
    properties: {
      excludeOtherMasks: { type: "boolean" },
      layerId: { minLength: 1, type: "string" },
      respectAlpha: { type: "boolean" },
      type: { const: "mask-bucket" },
      value: { type: "boolean" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["layerId", "type", "x", "y"],
    type: "object",
  },
  EditorMaskLayer: {
    additionalProperties: false,
    properties: {
      anchor: { $ref: "#/components/schemas/EditorPoint" },
      color: { pattern: "^#[0-9a-fA-F]{6}$", type: "string" },
      id: { minLength: 1, type: "string" },
      mask: { items: { type: "boolean" }, type: "array" },
      name: { minLength: 1, type: "string" },
      parentId: { type: ["string", "null"] },
      promptHint: { type: "string" },
      regenerationPolicy: {
        additionalProperties: false,
        properties: {
          allowImagegenReference: { type: "boolean" },
          allowRegenerate: { type: "boolean" },
          locked: { type: "boolean" },
          preservePalette: { type: "boolean" },
        },
        required: [
          "allowImagegenReference",
          "allowRegenerate",
          "locked",
          "preservePalette",
        ],
        type: "object",
      },
      semanticLabel: { type: "string" },
      semanticRole: {
        enum: [
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
        ],
      },
      visible: { type: "boolean" },
    },
    required: [
      "anchor",
      "color",
      "id",
      "mask",
      "name",
      "parentId",
      "promptHint",
      "regenerationPolicy",
      "semanticLabel",
      "semanticRole",
      "visible",
    ],
    type: "object",
  },
  EditorMaskOperationPatch: {
    additionalProperties: false,
    properties: {
      after: { type: "boolean" },
      before: { type: "boolean" },
      layerId: { minLength: 1, type: "string" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["after", "before", "layerId", "x", "y"],
    type: "object",
  },
  EditorMaskPatch: {
    additionalProperties: false,
    properties: {
      value: { type: "boolean" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["value", "x", "y"],
    type: "object",
  },
  EditorMaskShapeOperation: {
    additionalProperties: false,
    properties: {
      endCell: { $ref: "#/components/schemas/EditorPoint" },
      layerId: { minLength: 1, type: "string" },
      mode: { enum: ["fill", "outline"] },
      radius: { minimum: 0, type: "integer" },
      respectAlpha: { type: "boolean" },
      shape: { enum: ["ellipse", "line", "rectangle", "triangle"] },
      startCell: { $ref: "#/components/schemas/EditorPoint" },
      type: { const: "mask-shape" },
      value: { type: "boolean" },
    },
    required: ["endCell", "layerId", "shape", "startCell", "type"],
    type: "object",
  },
  EditorMaskStrokeOperation: {
    additionalProperties: false,
    properties: {
      layerId: { minLength: 1, type: "string" },
      points: {
        items: { $ref: "#/components/schemas/EditorPoint" },
        minItems: 1,
        type: "array",
      },
      respectAlpha: { type: "boolean" },
      size: { minimum: 1, type: "integer" },
      type: { const: "mask-stroke" },
      value: { type: "boolean" },
    },
    required: ["layerId", "points", "type"],
    type: "object",
  },
  EditorOperation: {
    oneOf: [
      { $ref: "#/components/schemas/EditorSetPixelOperation" },
      { $ref: "#/components/schemas/EditorPatchPixelsOperation" },
      { $ref: "#/components/schemas/EditorToolStrokeOperation" },
      { $ref: "#/components/schemas/EditorBucketFillOperation" },
      { $ref: "#/components/schemas/EditorGradientFillOperation" },
      { $ref: "#/components/schemas/EditorShapePixelsOperation" },
      { $ref: "#/components/schemas/EditorTransformPixelsOperation" },
      { $ref: "#/components/schemas/EditorDeleteSelectedPixelsOperation" },
      { $ref: "#/components/schemas/EditorDeleteTargetOperation" },
      { $ref: "#/components/schemas/EditorPatchMaskOperation" },
      { $ref: "#/components/schemas/EditorMaskStrokeOperation" },
      { $ref: "#/components/schemas/EditorMaskBucketOperation" },
      { $ref: "#/components/schemas/EditorMaskShapeOperation" },
      { $ref: "#/components/schemas/EditorSelectFrameOperation" },
      { $ref: "#/components/schemas/EditorReorderFrameOperation" },
      { $ref: "#/components/schemas/EditorUpsertMaskLayerOperation" },
      { $ref: "#/components/schemas/EditorDeleteMaskLayerOperation" },
    ],
  },
  EditorOperationLogEntry: {
    additionalProperties: false,
    properties: {
      afterRevision: { minimum: 0, type: "integer" },
      beforeRevision: { minimum: 0, type: "integer" },
      checkpointId: { type: ["string", "null"] },
      createdAt: { format: "date-time", type: "string" },
      id: { minLength: 1, type: "string" },
      label: { minLength: 1, type: "string" },
      maskPatches: {
        items: { $ref: "#/components/schemas/EditorMaskOperationPatch" },
        type: "array",
      },
      operationType: {
        enum: [
          "animation-fix",
          "checkpoint-revert",
          "edit-intent",
          "editor-operations",
          "imagegen-apply",
          "operation-revert",
          "pixel-write",
          "snapshot",
        ],
      },
      patches: {
        items: { $ref: "#/components/schemas/EditorOperationPatch" },
        type: "array",
      },
      reason: { type: "string" },
      revertedAt: { format: "date-time", type: ["string", "null"] },
      revertedByOperationId: { type: ["string", "null"] },
      runId: { minLength: 1, type: "string" },
      schemaVersion: { const: "2026-06-04.v1" },
      source: {
        enum: ["agent", "api", "imagegen-apply", "manual", "system"],
      },
    },
    required: [
      "afterRevision",
      "beforeRevision",
      "checkpointId",
      "createdAt",
      "id",
      "label",
      "maskPatches",
      "operationType",
      "patches",
      "reason",
      "revertedAt",
      "revertedByOperationId",
      "runId",
      "schemaVersion",
      "source",
    ],
    type: "object",
  },
  EditorOperationLogResponse: {
    additionalProperties: false,
    properties: {
      operations: {
        items: { $ref: "#/components/schemas/EditorOperationLogEntry" },
        type: "array",
      },
    },
    required: ["operations"],
    type: "object",
  },
  EditorOperationPatch: {
    additionalProperties: false,
    properties: {
      after: { $ref: "#/components/schemas/PixelCell" },
      before: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["after", "before", "frameId", "x", "y"],
    type: "object",
  },
  EditorOperationsRequest: {
    additionalProperties: false,
    properties: {
      expectedRevision: { minimum: 0, type: "integer" },
      operations: {
        items: { $ref: "#/components/schemas/EditorOperation" },
        minItems: 1,
        type: "array",
      },
    },
    required: ["operations"],
    type: "object",
  },
  EditorPatchMaskOperation: {
    additionalProperties: false,
    properties: {
      layerId: { minLength: 1, type: "string" },
      patches: {
        items: { $ref: "#/components/schemas/EditorMaskPatch" },
        minItems: 1,
        type: "array",
      },
      type: { const: "patch-mask" },
    },
    required: ["layerId", "patches", "type"],
    type: "object",
  },
  EditorPatchPixelsOperation: {
    additionalProperties: false,
    properties: {
      frameId: { minLength: 1, type: "string" },
      patches: {
        items: { $ref: "#/components/schemas/EditorPixelPatch" },
        minItems: 1,
        type: "array",
      },
      type: { const: "patch-pixels" },
    },
    required: ["frameId", "patches", "type"],
    type: "object",
  },
  EditorPixelPatch: {
    additionalProperties: false,
    properties: {
      color: { $ref: "#/components/schemas/PixelCell" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["color", "x", "y"],
    type: "object",
  },
  EditorPoint: {
    additionalProperties: false,
    properties: {
      x: { type: "number" },
      y: { type: "number" },
    },
    required: ["x", "y"],
    type: "object",
  },
  EditorReorderFrameOperation: {
    additionalProperties: false,
    properties: {
      frameId: { minLength: 1, type: "string" },
      targetIndex: { minimum: 0, type: "integer" },
      type: { const: "reorder-frame" },
    },
    required: ["frameId", "targetIndex", "type"],
    type: "object",
  },
  EditorSaveState: {
    additionalProperties: false,
    properties: {
      dirty: { type: "boolean" },
      lastSavedAt: { format: "date-time", type: ["string", "null"] },
      revision: { minimum: 0, type: "integer" },
    },
    required: ["dirty", "lastSavedAt", "revision"],
    type: "object",
  },
  EditorSelectionResponse: {
    additionalProperties: false,
    properties: {
      document: { $ref: "#/components/schemas/EditorDocument" },
      selection: { $ref: "#/components/schemas/EditorSelectionState" },
    },
    required: ["selection"],
    type: "object",
  },
  EditorSelectionState: {
    additionalProperties: false,
    properties: {
      activeMaskLayerId: { type: ["string", "null"] },
      selectedBounds: {
        anyOf: [
          { $ref: "#/components/schemas/EditorTargetBounds" },
          { type: "null" },
        ],
      },
      selectedFrameId: { type: ["string", "null"] },
      selectedMaskLayerIds: {
        items: { minLength: 1, type: "string" },
        type: "array",
      },
      selectedPixelsMask: {
        anyOf: [
          { items: { type: "boolean" }, type: "array" },
          { type: "null" },
        ],
      },
      transformTarget: {
        enum: ["none", "pixels", "mask-layer", "mask-family", "frame"],
      },
    },
    required: [
      "activeMaskLayerId",
      "selectedBounds",
      "selectedFrameId",
      "selectedMaskLayerIds",
      "selectedPixelsMask",
      "transformTarget",
    ],
    type: "object",
  },
  EditorSelectionWriteRequest: {
    additionalProperties: false,
    properties: {
      expectedRevision: { minimum: 0, type: "integer" },
      selection: { $ref: "#/components/schemas/EditorSelectionState" },
    },
    required: ["selection"],
    type: "object",
  },
  EditorStatusResponse: {
    additionalProperties: false,
    properties: {
      status: {
        additionalProperties: false,
        properties: {
          activeMaskLayerId: { type: ["string", "null"] },
          canvas: { $ref: "#/components/schemas/CanvasSize" },
          editorPath: { minLength: 1, type: "string" },
          frameCount: { minimum: 0, type: "integer" },
          maskCount: { minimum: 0, type: "integer" },
          runId: { minLength: 1, type: "string" },
          saveState: { $ref: "#/components/schemas/EditorSaveState" },
          selectedFrameId: { type: ["string", "null"] },
          timeline: {
            additionalProperties: false,
            properties: {
              fps: { minimum: 1, type: "integer" },
              framesList: { items: { type: "string" }, type: "array" },
              isPlaying: { type: "boolean" },
            },
            required: ["fps", "framesList", "isPlaying"],
            type: "object",
          },
          updatedAt: { format: "date-time", type: "string" },
        },
        required: [
          "activeMaskLayerId",
          "canvas",
          "editorPath",
          "frameCount",
          "maskCount",
          "runId",
          "saveState",
          "selectedFrameId",
          "timeline",
          "updatedAt",
        ],
        type: "object",
      },
    },
    required: ["status"],
    type: "object",
  },
  EditorSelectFrameOperation: {
    additionalProperties: false,
    properties: {
      frameId: { minLength: 1, type: "string" },
      type: { const: "select-frame" },
    },
    required: ["frameId", "type"],
    type: "object",
  },
  EditorSetPixelOperation: {
    additionalProperties: false,
    properties: {
      color: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      type: { const: "set-pixel" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["color", "frameId", "type", "x", "y"],
    type: "object",
  },
  EditorShapePixelsOperation: {
    additionalProperties: false,
    properties: {
      color: { $ref: "#/components/schemas/PixelCell" },
      endCell: { $ref: "#/components/schemas/EditorPoint" },
      frameId: { minLength: 1, type: "string" },
      mode: { enum: ["fill", "outline"] },
      radius: { minimum: 0, type: "integer" },
      shape: { enum: ["ellipse", "line", "rectangle", "triangle"] },
      startCell: { $ref: "#/components/schemas/EditorPoint" },
      type: { const: "shape-pixels" },
    },
    required: ["color", "endCell", "frameId", "shape", "startCell", "type"],
    type: "object",
  },
  EditorTargetBounds: {
    additionalProperties: false,
    properties: {
      height: { minimum: 1, type: "integer" },
      width: { minimum: 1, type: "integer" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["height", "width", "x", "y"],
    type: "object",
  },
  EditorToolStrokeOperation: {
    additionalProperties: false,
    properties: {
      color: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      points: {
        items: { $ref: "#/components/schemas/EditorPoint" },
        minItems: 1,
        type: "array",
      },
      size: { minimum: 1, type: "integer" },
      tool: {
        enum: [
          "brush",
          "bucket",
          "eraser",
          "gradient",
          "shape",
          "selection",
          "transform",
        ],
      },
      type: { const: "tool-stroke" },
    },
    required: ["color", "frameId", "points", "size", "tool", "type"],
    type: "object",
  },
  EditorTransformPixelsOperation: {
    additionalProperties: false,
    properties: {
      bounds: {
        additionalProperties: false,
        properties: {
          height: { minimum: 1, type: "integer" },
          width: { minimum: 1, type: "integer" },
          x: { minimum: 0, type: "integer" },
          y: { minimum: 0, type: "integer" },
        },
        required: ["height", "width", "x", "y"],
        type: "object",
      },
      frameId: { minLength: 1, type: "string" },
      mask: { items: { type: "boolean" }, type: "array" },
      origin: { $ref: "#/components/schemas/EditorPoint" },
      rotation: { type: "number" },
      scale: { $ref: "#/components/schemas/EditorPoint" },
      translation: { $ref: "#/components/schemas/EditorPoint" },
      type: { const: "transform-pixels" },
    },
    required: ["bounds", "frameId", "origin", "scale", "type"],
    type: "object",
  },
  EditorUpsertMaskLayerOperation: {
    additionalProperties: false,
    properties: {
      layer: { $ref: "#/components/schemas/EditorMaskLayer" },
      type: { const: "upsert-mask-layer" },
    },
    required: ["layer", "type"],
    type: "object",
  },
  EditorUrlResponse: {
    additionalProperties: false,
    properties: {
      url: { format: "uri", type: "string" },
    },
    required: ["url"],
    type: "object",
  },
  ErrorResponse: {
    additionalProperties: false,
    properties: {
      error: {
        additionalProperties: false,
        properties: {
          code: { type: "string" },
          details: {},
          message: { type: "string" },
          retryable: { type: "boolean" },
        },
        required: ["code", "message", "retryable"],
        type: "object",
      },
    },
    required: ["error"],
    type: "object",
  },
  ExportJobResponse: {
    additionalProperties: false,
    properties: {
      job: { $ref: "#/components/schemas/Job" },
    },
    required: ["job"],
    type: "object",
  },
  Frame: frameContractSchema,
  FrameResponse: {
    additionalProperties: false,
    properties: {
      frame: { $ref: "#/components/schemas/Frame" },
    },
    required: ["frame"],
    type: "object",
  },
  FrameVisualInspection: {
    additionalProperties: false,
    properties: {
      alphaBBox: {
        anyOf: [
          { $ref: "#/components/schemas/Frame/$defs/bbox" },
          { type: "null" },
        ],
      },
      dominantColors: {
        items: { pattern: "^#[0-9a-fA-F]{6}$", type: "string" },
        type: "array",
      },
      features: {
        items: { $ref: "#/components/schemas/VisualFeature" },
        type: "array",
      },
      frameId: { minLength: 1, type: "string" },
      fullPreviewUrl: { minLength: 1, type: "string" },
      humanSummary: { type: "string" },
      pixelMapUrl: { minLength: 1, type: "string" },
      recommendations: { items: { type: "string" }, type: "array" },
      zoomHints: {
        items: {
          additionalProperties: false,
          properties: {
            bbox: { $ref: "#/components/schemas/Frame/$defs/bbox" },
            label: { minLength: 1, type: "string" },
            reason: { minLength: 1, type: "string" },
          },
          required: ["bbox", "label", "reason"],
          type: "object",
        },
        type: "array",
      },
    },
    required: [
      "alphaBBox",
      "dominantColors",
      "features",
      "frameId",
      "fullPreviewUrl",
      "humanSummary",
      "pixelMapUrl",
      "recommendations",
      "zoomHints",
    ],
    type: "object",
  },
  FrameVisualInspectionResponse: {
    additionalProperties: false,
    properties: {
      inspection: { $ref: "#/components/schemas/FrameVisualInspection" },
    },
    required: ["inspection"],
    type: "object",
  },
  HealthResponse: {
    additionalProperties: false,
    properties: {
      ok: { const: true },
      runsDir: { type: "string" },
      service: { const: "retrodex-api" },
    },
    required: ["ok", "runsDir", "service"],
    type: "object",
  },
  ImagegenApplyPatch: {
    additionalProperties: false,
    properties: {
      after: { $ref: "#/components/schemas/PixelCell" },
      before: { $ref: "#/components/schemas/PixelCell" },
      frameId: { minLength: 1, type: "string" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["after", "before", "frameId", "x", "y"],
    type: "object",
  },
  ImagegenApplyPreview: {
    additionalProperties: false,
    properties: {
      beforeInspection: { $ref: "#/components/schemas/FrameVisualInspection" },
      candidateId: { minLength: 1, type: "string" },
      comparePreviewUrl: { minLength: 1, type: "string" },
      estimatedAfterInspection: {
        $ref: "#/components/schemas/FrameVisualInspection",
      },
      frameId: { minLength: 1, type: "string" },
      ignoredOutsideMaskPixels: {
        items: { $ref: "#/components/schemas/ImagegenIgnoredOutsideMaskPixel" },
        type: "array",
      },
      patches: {
        items: { $ref: "#/components/schemas/ImagegenApplyPatch" },
        type: "array",
      },
      recommendations: { items: { type: "string" }, type: "array" },
      requiresCheckpoint: { type: "boolean" },
      resultId: { minLength: 1, type: "string" },
      runId: { minLength: 1, type: "string" },
    },
    required: [
      "beforeInspection",
      "candidateId",
      "comparePreviewUrl",
      "estimatedAfterInspection",
      "frameId",
      "ignoredOutsideMaskPixels",
      "patches",
      "recommendations",
      "requiresCheckpoint",
      "resultId",
      "runId",
    ],
    type: "object",
  },
  ImagegenApplyPreviewResponse: {
    additionalProperties: false,
    properties: {
      preview: { $ref: "#/components/schemas/ImagegenApplyPreview" },
    },
    required: ["preview"],
    type: "object",
  },
  ImagegenApplyResponse: {
    additionalProperties: false,
    properties: {
      document: { $ref: "#/components/schemas/EditorDocument" },
      imagegenResult: {
        $ref: "#/components/schemas/ImagegenResultArtifact",
      },
    },
    required: ["document", "imagegenResult"],
    type: "object",
  },
  ImagegenCandidate: {
    additionalProperties: false,
    properties: {
      frameId: { minLength: 1, type: "string" },
      grid: { $ref: "#/components/schemas/PixelGrid" },
      id: { minLength: 1, type: "string" },
      imagePath: { minLength: 1, type: "string" },
      notes: { type: "string" },
      score: { maximum: 1, minimum: 0, type: ["number", "null"] },
    },
    required: ["frameId", "id", "notes", "score"],
    type: "object",
  },
  ImagegenCandidateInspection: {
    additionalProperties: false,
    properties: {
      alphaBBoxDriftPixels: { minimum: 0, type: "integer" },
      candidateId: { minLength: 1, type: "string" },
      comparePreviewUrl: { minLength: 1, type: "string" },
      diagnostics: {
        items: {
          additionalProperties: false,
          properties: {
            code: {
              enum: [
                "empty-candidate",
                "large-alpha-drift",
                "low-mask-change",
                "outside-mask-change",
                "palette-drift",
              ],
            },
            details: { type: "object" },
            message: { minLength: 1, type: "string" },
            severity: { enum: ["error", "info", "warning"] },
          },
          required: ["code", "details", "message", "severity"],
          type: "object",
        },
        type: "array",
      },
      diffSummary: {
        additionalProperties: false,
        properties: {
          changedInsideMask: { minimum: 0, type: "integer" },
          outsideMaskChangesIgnored: { minimum: 0, type: "integer" },
        },
        required: ["changedInsideMask", "outsideMaskChangesIgnored"],
        type: "object",
      },
      frameId: { minLength: 1, type: "string" },
      maskCoverageRatio: { maximum: 1, minimum: 0, type: "number" },
      outsideMaskIgnoredPixels: { minimum: 0, type: "integer" },
      paletteDriftColors: {
        items: { pattern: "^#[0-9a-fA-F]{6}$", type: "string" },
        type: "array",
      },
      recommendations: { items: { type: "string" }, type: "array" },
      score: { maximum: 1, minimum: 0, type: "number" },
    },
    required: [
      "alphaBBoxDriftPixels",
      "candidateId",
      "comparePreviewUrl",
      "diagnostics",
      "diffSummary",
      "frameId",
      "maskCoverageRatio",
      "outsideMaskIgnoredPixels",
      "paletteDriftColors",
      "recommendations",
      "score",
    ],
    type: "object",
  },
  ImagegenIgnoredOutsideMaskPixel: {
    additionalProperties: false,
    properties: {
      color: { $ref: "#/components/schemas/PixelCell" },
      x: { minimum: 0, type: "integer" },
      y: { minimum: 0, type: "integer" },
    },
    required: ["color", "x", "y"],
    type: "object",
  },
  ImagegenPreserveRules: {
    additionalProperties: false,
    properties: {
      lockedLayerIds: {
        items: { minLength: 1, type: "string" },
        type: "array",
      },
      preserveOutsideMask: { type: "boolean" },
      preservePalette: { type: "boolean" },
    },
    required: ["lockedLayerIds", "preserveOutsideMask", "preservePalette"],
    type: "object",
  },
  ImagegenRequestArtifact: {
    additionalProperties: false,
    properties: {
      candidateCount: { minimum: 1, type: "integer" },
      createdAt: { format: "date-time", type: "string" },
      frameIds: { items: { minLength: 1, type: "string" }, type: "array" },
      fullPreviewUrl: { minLength: 1, type: "string" },
      id: { minLength: 1, type: "string" },
      maskLayerId: { minLength: 1, type: "string" },
      negativePrompt: { type: "string" },
      pixelMapUrl: { minLength: 1, type: "string" },
      preserveRules: { $ref: "#/components/schemas/ImagegenPreserveRules" },
      prompt: { minLength: 1, type: "string" },
      reference: { $ref: "#/components/schemas/PartReferencePackage" },
      regenerationId: { minLength: 1, type: "string" },
      requestJsonPath: { minLength: 1, type: "string" },
      runId: { minLength: 1, type: "string" },
      status: {
        enum: ["ready-for-imagegen", "result-recorded", "applied"],
      },
    },
    required: [
      "candidateCount",
      "createdAt",
      "frameIds",
      "fullPreviewUrl",
      "id",
      "maskLayerId",
      "negativePrompt",
      "pixelMapUrl",
      "preserveRules",
      "prompt",
      "reference",
      "regenerationId",
      "requestJsonPath",
      "runId",
      "status",
    ],
    type: "object",
  },
  ImagegenRequestResponse: {
    additionalProperties: false,
    properties: {
      imagegenRequest: {
        $ref: "#/components/schemas/ImagegenRequestArtifact",
      },
    },
    required: ["imagegenRequest"],
    type: "object",
  },
  ImagegenResultArtifact: {
    additionalProperties: false,
    properties: {
      appliedAt: { format: "date-time", type: ["string", "null"] },
      candidates: {
        items: { $ref: "#/components/schemas/ImagegenCandidate" },
        type: "array",
      },
      createdAt: { format: "date-time", type: "string" },
      diffSummary: {
        additionalProperties: false,
        properties: {
          changedInsideMask: { minimum: 0, type: "integer" },
          outsideMaskChangesIgnored: { minimum: 0, type: "integer" },
        },
        required: ["changedInsideMask", "outsideMaskChangesIgnored"],
        type: "object",
      },
      id: { minLength: 1, type: "string" },
      notes: { type: "string" },
      requestId: { minLength: 1, type: "string" },
      resultJsonPath: { minLength: 1, type: "string" },
      runId: { minLength: 1, type: "string" },
      selectedCandidateId: { type: ["string", "null"] },
      status: { enum: ["candidate", "approved", "applied", "rejected"] },
    },
    required: [
      "appliedAt",
      "candidates",
      "createdAt",
      "diffSummary",
      "id",
      "notes",
      "requestId",
      "resultJsonPath",
      "runId",
      "selectedCandidateId",
      "status",
    ],
    type: "object",
  },
  ImagegenResultInspection: {
    additionalProperties: false,
    properties: {
      candidates: {
        items: { $ref: "#/components/schemas/ImagegenCandidateInspection" },
        type: "array",
      },
      recommendedCandidateId: { type: ["string", "null"] },
      requestId: { minLength: 1, type: "string" },
      resultId: { minLength: 1, type: "string" },
      runId: { minLength: 1, type: "string" },
      summary: { type: "string" },
      updatedAt: { format: "date-time", type: "string" },
    },
    required: [
      "candidates",
      "recommendedCandidateId",
      "requestId",
      "resultId",
      "runId",
      "summary",
      "updatedAt",
    ],
    type: "object",
  },
  ImagegenResultInspectionResponse: {
    additionalProperties: false,
    properties: {
      inspection: {
        $ref: "#/components/schemas/ImagegenResultInspection",
      },
    },
    required: ["inspection"],
    type: "object",
  },
  ImagegenResultResponse: {
    additionalProperties: false,
    properties: {
      imagegenResult: {
        $ref: "#/components/schemas/ImagegenResultArtifact",
      },
    },
    required: ["imagegenResult"],
    type: "object",
  },
  Job: {
    additionalProperties: false,
    properties: {
      cancelledAt: { format: "date-time", type: ["string", "null"] },
      completedAt: { format: "date-time", type: ["string", "null"] },
      createdAt: { format: "date-time", type: "string" },
      currentFrameId: { type: ["string", "null"] },
      currentStepId: { type: ["string", "null"] },
      error: {
        anyOf: [{ $ref: "#/components/schemas/JobError" }, { type: "null" }],
      },
      frames: {
        items: { $ref: "#/components/schemas/Frame" },
        type: "array",
      },
      id: { minLength: 1, type: "string" },
      progress: {
        additionalProperties: false,
        properties: {
          done: { minimum: 0, type: "integer" },
          total: { minimum: 0, type: "integer" },
        },
        required: ["done", "total"],
        type: "object",
      },
      retryHints: { items: { type: "string" }, type: "array" },
      runId: { minLength: 1, type: "string" },
      startedAt: { format: "date-time", type: ["string", "null"] },
      status: {
        enum: ["queued", "running", "succeeded", "failed", "cancelled"],
      },
      type: { enum: ["cleanup", "export"] },
      updatedAt: { format: "date-time", type: "string" },
    },
    required: [
      "cancelledAt",
      "completedAt",
      "createdAt",
      "currentFrameId",
      "currentStepId",
      "error",
      "frames",
      "id",
      "progress",
      "retryHints",
      "runId",
      "startedAt",
      "status",
      "type",
      "updatedAt",
    ],
    type: "object",
  },
  JobError: {
    additionalProperties: false,
    properties: {
      code: { type: "string" },
      details: {},
      message: { type: "string" },
      retryable: { type: "boolean" },
    },
    required: ["code", "message", "retryable"],
    type: "object",
  },
  JobResponse: {
    additionalProperties: false,
    properties: {
      job: { $ref: "#/components/schemas/Job" },
    },
    required: ["job"],
    type: "object",
  },
  MaskDiagnostic: {
    additionalProperties: false,
    properties: {
      code: {
        enum: [
          "empty-mask",
          "intersects-other-mask",
          "missing-semantic-role",
          "outside-visible-alpha",
          "parent-not-found",
        ],
      },
      details: { type: "object" },
      layerId: { minLength: 1, type: "string" },
      message: { minLength: 1, type: "string" },
      severity: { enum: ["error", "info", "warning"] },
    },
    required: ["code", "details", "layerId", "message", "severity"],
    type: "object",
  },
  MaskIntelligenceReport: {
    additionalProperties: false,
    properties: {
      diagnostics: {
        items: { $ref: "#/components/schemas/MaskDiagnostic" },
        type: "array",
      },
      maskCount: { minimum: 0, type: "integer" },
      recommendations: { items: { type: "string" }, type: "array" },
      runId: { minLength: 1, type: "string" },
      suggestions: {
        items: { $ref: "#/components/schemas/MaskSuggestion" },
        type: "array",
      },
      updatedAt: { format: "date-time", type: "string" },
    },
    required: [
      "diagnostics",
      "maskCount",
      "recommendations",
      "runId",
      "suggestions",
      "updatedAt",
    ],
    type: "object",
  },
  MaskIntelligenceResponse: {
    additionalProperties: false,
    properties: {
      maskIntelligence: {
        $ref: "#/components/schemas/MaskIntelligenceReport",
      },
    },
    required: ["maskIntelligence"],
    type: "object",
  },
  MaskSuggestion: {
    additionalProperties: false,
    properties: {
      bbox: { $ref: "#/components/schemas/Frame/$defs/bbox" },
      confidence: { maximum: 1, minimum: 0, type: "number" },
      id: { minLength: 1, type: "string" },
      label: { minLength: 1, type: "string" },
      mask: { items: { type: "boolean" }, type: "array" },
      pixelCount: { minimum: 0, type: "integer" },
      promptHint: { type: "string" },
      role: {
        enum: [
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
        ],
      },
      source: {
        enum: ["alpha-bbox", "connected-component", "contrast-detail"],
      },
    },
    required: [
      "bbox",
      "confidence",
      "id",
      "label",
      "mask",
      "pixelCount",
      "promptHint",
      "role",
      "source",
    ],
    type: "object",
  },
  PartReferencePackage: {
    additionalProperties: false,
    properties: {
      bbox: { $ref: "#/components/schemas/Frame/$defs/bbox" },
      createdAt: { format: "date-time", type: "string" },
      exactMaskPixels: {
        items: { $ref: "#/components/schemas/EditorPoint" },
        type: "array",
      },
      frameId: { minLength: 1, type: "string" },
      fullPreviewUrl: { minLength: 1, type: "string" },
      id: { minLength: 1, type: "string" },
      maskLayerId: { minLength: 1, type: "string" },
      pixelMapUrl: { minLength: 1, type: "string" },
      promptHint: { type: "string" },
      referenceImagePath: { minLength: 1, type: "string" },
      referenceImageUrl: { minLength: 1, type: "string" },
      runId: { minLength: 1, type: "string" },
      semanticLabel: { type: "string" },
      semanticRole: {
        enum: [
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
        ],
      },
    },
    required: [
      "bbox",
      "createdAt",
      "exactMaskPixels",
      "frameId",
      "fullPreviewUrl",
      "id",
      "maskLayerId",
      "pixelMapUrl",
      "promptHint",
      "referenceImagePath",
      "referenceImageUrl",
      "runId",
      "semanticLabel",
      "semanticRole",
    ],
    type: "object",
  },
  PartReferenceResponse: {
    additionalProperties: false,
    properties: {
      reference: { $ref: "#/components/schemas/PartReferencePackage" },
    },
    required: ["reference"],
    type: "object",
  },
  PartRegenerationDraft: {
    additionalProperties: false,
    properties: {
      createdAt: { format: "date-time", type: "string" },
      id: { minLength: 1, type: "string" },
      input: { $ref: "#/components/schemas/PartRegenerationRequest" },
      instructions: { items: { type: "string" }, type: "array" },
      reference: { $ref: "#/components/schemas/PartReferencePackage" },
      runId: { minLength: 1, type: "string" },
      status: {
        enum: ["draft", "ready-for-imagegen", "applied", "cancelled"],
      },
    },
    required: [
      "createdAt",
      "id",
      "input",
      "instructions",
      "reference",
      "runId",
      "status",
    ],
    type: "object",
  },
  PartRegenerationDraftResponse: {
    additionalProperties: false,
    properties: {
      regeneration: { $ref: "#/components/schemas/PartRegenerationDraft" },
    },
    required: ["regeneration"],
    type: "object",
  },
  PartRegenerationRequest: {
    additionalProperties: false,
    properties: {
      frameIds: { items: { minLength: 1, type: "string" }, type: "array" },
      maskLayerId: { minLength: 1, type: "string" },
      mode: { enum: ["animation", "single-frame"] },
      preserveOutsideMask: { type: "boolean" },
      prompt: { minLength: 1, type: "string" },
      referenceId: { minLength: 1, type: "string" },
    },
    required: ["maskLayerId", "prompt"],
    type: "object",
  },
  PixelCell: {
    anyOf: [
      { pattern: "^#[0-9a-fA-F]{6}$", type: "string" },
      { pattern: "^#[0-9a-fA-F]{8}$", type: "string" },
      { pattern: "^rgba\\(", type: "string" },
      { type: "null" },
    ],
  },
  PixelColor: {
    anyOf: [
      { pattern: "^#[0-9a-fA-F]{6}$", type: "string" },
      { pattern: "^#[0-9a-fA-F]{8}$", type: "string" },
      { pattern: "^rgba\\(", type: "string" },
    ],
  },
  PixelGrid: {
    additionalProperties: false,
    properties: {
      cells: {
        items: { $ref: "#/components/schemas/PixelCell" },
        type: "array",
      },
      palette: {
        items: { pattern: "^#[0-9a-fA-F]{6}$", type: "string" },
        type: "array",
      },
      size: { $ref: "#/components/schemas/CanvasSize" },
    },
    required: ["cells", "palette", "size"],
    type: "object",
  },
  PixelGridResponse: {
    additionalProperties: false,
    properties: {
      alphaBBox: {
        anyOf: [
          { $ref: "#/components/schemas/Frame/$defs/bbox" },
          { type: "null" },
        ],
      },
      frameId: { minLength: 1, type: "string" },
      grid: { $ref: "#/components/schemas/PixelGrid" },
      previewUrl: { type: "string" },
    },
    required: ["alphaBBox", "frameId", "grid"],
    type: "object",
  },
  PixelGridWriteRequest: {
    additionalProperties: false,
    properties: {
      expectedRevision: { minimum: 0, type: "integer" },
      grid: { $ref: "#/components/schemas/PixelGrid" },
    },
    required: ["grid"],
    type: "object",
  },
  RecordImagegenResultRequest: {
    additionalProperties: false,
    properties: {
      candidates: {
        items: { $ref: "#/components/schemas/ImagegenCandidate" },
        minItems: 1,
        type: "array",
      },
      notes: { type: "string" },
      requestId: { minLength: 1, type: "string" },
      selectedCandidateId: { minLength: 1, type: "string" },
    },
    required: ["candidates", "requestId"],
    type: "object",
  },
  RevertEditorCheckpointRequest: {
    additionalProperties: false,
    properties: {
      createRollbackCheckpoint: { type: "boolean" },
    },
    type: "object",
  },
  RevertEditorCheckpointResponse: {
    additionalProperties: false,
    properties: {
      checkpoint: { $ref: "#/components/schemas/EditorCheckpoint" },
      document: { $ref: "#/components/schemas/EditorDocument" },
      rollbackCheckpoint: {
        anyOf: [
          { $ref: "#/components/schemas/EditorCheckpoint" },
          { type: "null" },
        ],
      },
    },
    required: ["checkpoint", "document", "rollbackCheckpoint"],
    type: "object",
  },
  RevertEditorOperationRequest: {
    additionalProperties: false,
    properties: {
      createRollbackCheckpoint: { type: "boolean" },
    },
    type: "object",
  },
  RevertEditorOperationResponse: {
    additionalProperties: false,
    properties: {
      document: { $ref: "#/components/schemas/EditorDocument" },
      operation: { $ref: "#/components/schemas/EditorOperationLogEntry" },
      revertOperation: { $ref: "#/components/schemas/EditorOperationLogEntry" },
      rollbackCheckpoint: {
        anyOf: [
          { $ref: "#/components/schemas/EditorCheckpoint" },
          { type: "null" },
        ],
      },
    },
    required: [
      "document",
      "operation",
      "revertOperation",
      "rollbackCheckpoint",
    ],
    type: "object",
  },
  Run: runContractSchema,
  RunResponse: {
    additionalProperties: false,
    properties: {
      run: { $ref: "#/components/schemas/Run" },
    },
    required: ["run"],
    type: "object",
  },
  RunsResponse: {
    additionalProperties: false,
    properties: {
      runs: {
        items: { $ref: "#/components/schemas/Run" },
        type: "array",
      },
    },
    required: ["runs"],
    type: "object",
  },
  SavedAnimation: savedAnimationContractSchema,
  SavedAnimationResponse: {
    additionalProperties: false,
    properties: {
      savedAnimation: { $ref: "#/components/schemas/SavedAnimation" },
    },
    required: ["savedAnimation"],
    type: "object",
  },
  SavedAnimationsResponse: {
    additionalProperties: false,
    properties: {
      exports: {
        items: { $ref: "#/components/schemas/SavedAnimation" },
        type: "array",
      },
    },
    required: ["exports"],
    type: "object",
  },
  SourceFrame: {
    additionalProperties: false,
    properties: {
      gridStrategy: {
        default: "infer-hidden-grid",
        enum: ["infer-hidden-grid", "preserve-source", "resize-to-run-canvas"],
      },
      name: { minLength: 1, type: "string" },
      path: { minLength: 1, type: "string" },
    },
    required: ["path"],
    type: "object",
  },
  SourceSheet: {
    additionalProperties: false,
    properties: {
      count: { minimum: 1, type: "integer" },
      frameHeight: { minimum: 1, type: "integer" },
      frameWidth: { minimum: 1, type: "integer" },
      path: { minLength: 1, type: "string" },
    },
    required: ["frameHeight", "frameWidth", "path"],
    type: "object",
  },
  VisualFeature: {
    additionalProperties: false,
    properties: {
      bbox: {
        anyOf: [
          { $ref: "#/components/schemas/Frame/$defs/bbox" },
          { type: "null" },
        ],
      },
      confidence: { maximum: 1, minimum: 0, type: "number" },
      description: { type: "string" },
      id: { minLength: 1, type: "string" },
      kind: {
        enum: [
          "alpha-bbox",
          "eye-candidate",
          "face-candidate",
          "mask-part",
          "motion-region",
          "palette-cluster",
          "tiny-detail",
        ],
      },
      maskLayerId: { minLength: 1, type: "string" },
      pixels: {
        items: { $ref: "#/components/schemas/EditorPoint" },
        type: "array",
      },
    },
    required: ["bbox", "confidence", "description", "id", "kind", "pixels"],
    type: "object",
  },
  VisualSummary: {
    additionalProperties: false,
    properties: {
      animation: {
        additionalProperties: false,
        properties: {
          contactSheetUrl: { minLength: 1, type: "string" },
          frameCount: { minimum: 0, type: "integer" },
          frameIds: { items: { minLength: 1, type: "string" }, type: "array" },
          movingRegions: {
            items: { $ref: "#/components/schemas/VisualFeature" },
            type: "array",
          },
          stableMaskLayerIds: {
            items: { minLength: 1, type: "string" },
            type: "array",
          },
          summary: { type: "string" },
        },
        required: [
          "frameCount",
          "frameIds",
          "movingRegions",
          "stableMaskLayerIds",
          "summary",
        ],
        type: "object",
      },
      frames: {
        items: { $ref: "#/components/schemas/FrameVisualInspection" },
        type: "array",
      },
      runId: { minLength: 1, type: "string" },
      schemaVersion: { const: "2026-06-04.v1" },
      updatedAt: { format: "date-time", type: "string" },
    },
    required: ["animation", "frames", "runId", "schemaVersion", "updatedAt"],
    type: "object",
  },
  VisualSummaryResponse: {
    additionalProperties: false,
    properties: {
      visualSummary: { $ref: "#/components/schemas/VisualSummary" },
    },
    required: ["visualSummary"],
    type: "object",
  },
};

schemas.AssetPlan = (
  schemas.Run as { properties: Record<string, unknown> }
).properties.asset;
schemas.CanvasSize = (
  schemas.Run as { $defs: Record<string, unknown> }
).$defs.canvas;

const errorResponses = {
  "400": response("Validation error", {
    $ref: "#/components/schemas/ErrorResponse",
  }),
  "404": response("Resource not found", {
    $ref: "#/components/schemas/ErrorResponse",
  }),
  "500": response("Internal error", {
    $ref: "#/components/schemas/ErrorResponse",
  }),
};

export const openApiDocument = {
  components: {
    parameters: {
      exportId: pathParam("exportId", "Saved animation export id."),
      filePath: pathParam(
        "filePath",
        "URL-encoded artifact path inside the export folder."
      ),
      frameId: pathParam("frameId", "Frame id, for example frame_01."),
      jobId: pathParam("jobId", "Persistent job id."),
      runId: pathParam("runId", "Run id."),
    },
    schemas,
  },
  info: {
    title: "Retrodex API",
    version: "0.1.0",
  },
  openapi: "3.1.0",
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        responses: {
          "200": response("Service health", {
            $ref: "#/components/schemas/HealthResponse",
          }),
        },
      },
    },
    "/jobs/{jobId}": {
      get: {
        operationId: "getJob",
        parameters: [{ $ref: "#/components/parameters/jobId" }],
        responses: {
          "200": response("Persistent job state", {
            $ref: "#/components/schemas/JobResponse",
          }),
          ...errorResponses,
        },
      },
      post: {
        operationId: "cancelJob",
        parameters: [{ $ref: "#/components/parameters/jobId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/CancelJobRequest",
        }),
        responses: {
          "200": response("Cancelled job state", {
            $ref: "#/components/schemas/JobResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApiDocument",
        responses: {
          "200": {
            description: "OpenAPI 3.1 document for this local API.",
          },
        },
      },
    },
    "/runs": {
      get: {
        operationId: "listRuns",
        responses: {
          "200": response("List runs", {
            $ref: "#/components/schemas/RunsResponse",
          }),
          ...errorResponses,
        },
      },
      post: {
        operationId: "createRun",
        requestBody: jsonContent({
          $ref: "#/components/schemas/CreateRunRequest",
        }),
        responses: {
          "201": response("Created run", {
            $ref: "#/components/schemas/RunResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}": {
      get: {
        operationId: "getRun",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("Read run", {
            $ref: "#/components/schemas/RunResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/cleanup": {
      post: {
        operationId: "createCleanupJob",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "202": response("Queued cleanup job", {
            $ref: "#/components/schemas/JobResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor": {
      get: {
        operationId: "getRunEditorDocument",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("Read run editor document", {
            $ref: "#/components/schemas/EditorDocumentResponse",
          }),
          ...errorResponses,
        },
      },
      put: {
        operationId: "saveRunEditorDocument",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          oneOf: [
            { $ref: "#/components/schemas/EditorDocument" },
            { $ref: "#/components/schemas/EditorDocumentSaveRequest" },
          ],
        }),
        responses: {
          "200": response("Saved run editor document", {
            $ref: "#/components/schemas/EditorDocumentResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/export-preview": {
      post: {
        operationId: "previewRunEditorExport",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/EditorExportPreviewRequest",
        }),
        responses: {
          "200": response("Preview editor export payload without writing files", {
            $ref: "#/components/schemas/EditorExportPreviewResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/status": {
      get: {
        operationId: "getRunEditorStatus",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("Read run editor status and active workspace path", {
            $ref: "#/components/schemas/EditorStatusResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/selection": {
      get: {
        operationId: "getRunEditorSelection",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("Read run editor selection state", {
            $ref: "#/components/schemas/EditorSelectionResponse",
          }),
          ...errorResponses,
        },
      },
      put: {
        operationId: "saveRunEditorSelection",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/EditorSelectionWriteRequest",
        }),
        responses: {
          "200": response("Saved run editor selection state", {
            $ref: "#/components/schemas/EditorSelectionResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/animation-fixes/apply": {
      post: {
        operationId: "applyRunEditorAnimationFix",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/AnimationFixRequest",
        }),
        responses: {
          "200": response("Applied deterministic animation fix", {
            $ref: "#/components/schemas/AnimationFixResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/animation-fixes/preview": {
      post: {
        operationId: "previewRunEditorAnimationFix",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/AnimationFixRequest",
        }),
        responses: {
          "200": response("Preview deterministic animation fix", {
            $ref: "#/components/schemas/AnimationFixPreviewResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/animation-inspection": {
      get: {
        operationId: "inspectRunEditorAnimation",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("Temporal animation quality inspection", {
            $ref: "#/components/schemas/AnimationInspectionResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/checkpoints": {
      get: {
        operationId: "listRunEditorCheckpoints",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("List editor checkpoints", {
            $ref: "#/components/schemas/EditorCheckpointsResponse",
          }),
          ...errorResponses,
        },
      },
      post: {
        operationId: "createRunEditorCheckpoint",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/CreateEditorCheckpointRequest",
        }),
        responses: {
          "201": response("Created editor checkpoint", {
            $ref: "#/components/schemas/EditorCheckpointResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/checkpoints/{checkpointId}/compare/{otherCheckpointId}":
      {
        get: {
          operationId: "compareRunEditorCheckpoints",
          parameters: [
            { $ref: "#/components/parameters/runId" },
            pathParam("checkpointId", "Left editor checkpoint id."),
            pathParam("otherCheckpointId", "Right editor checkpoint id."),
          ],
          responses: {
            "200": response("Compared editor checkpoints", {
              $ref: "#/components/schemas/CheckpointComparisonResponse",
            }),
            ...errorResponses,
          },
        },
      },
    "/runs/{runId}/editor/checkpoints/{checkpointId}/revert": {
      post: {
        operationId: "revertRunEditorCheckpoint",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          pathParam("checkpointId", "Editor checkpoint id."),
        ],
        requestBody: jsonContent({
          $ref: "#/components/schemas/RevertEditorCheckpointRequest",
        }),
        responses: {
          "200": response("Reverted editor document to checkpoint", {
            $ref: "#/components/schemas/RevertEditorCheckpointResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/frames/{frameId}/inspect": {
      get: {
        operationId: "inspectRunEditorFrame",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          { $ref: "#/components/parameters/frameId" },
        ],
        responses: {
          "200": response("Human-oriented frame inspection", {
            $ref: "#/components/schemas/FrameVisualInspectionResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/frames/{frameId}/pixels": {
      get: {
        operationId: "getRunEditorFramePixels",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          { $ref: "#/components/parameters/frameId" },
        ],
        responses: {
          "200": response("Read full frame pixel grid", {
            $ref: "#/components/schemas/PixelGridResponse",
          }),
          ...errorResponses,
        },
      },
      put: {
        operationId: "saveRunEditorFramePixels",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          { $ref: "#/components/parameters/frameId" },
        ],
        requestBody: jsonContent({
          $ref: "#/components/schemas/PixelGridWriteRequest",
        }),
        responses: {
          "200": response("Saved full frame pixel grid", {
            $ref: "#/components/schemas/PixelGridResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/imagegen-requests": {
      post: {
        operationId: "createRunEditorImagegenRequest",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/CreateImagegenRequest",
        }),
        responses: {
          "201": response("Created imagegen handoff request", {
            $ref: "#/components/schemas/ImagegenRequestResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/imagegen-results": {
      post: {
        operationId: "recordRunEditorImagegenResult",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/RecordImagegenResultRequest",
        }),
        responses: {
          "201": response("Recorded imagegen result candidates", {
            $ref: "#/components/schemas/ImagegenResultResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/imagegen-results/{resultId}/apply": {
      post: {
        operationId: "applyRunEditorImagegenResult",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          pathParam("resultId", "Imagegen result artifact id."),
        ],
        requestBody: jsonContent({
          $ref: "#/components/schemas/ApplyImagegenResultRequest",
        }),
        responses: {
          "200": response("Applied selected candidate inside the target mask", {
            $ref: "#/components/schemas/ImagegenApplyResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/imagegen-results/{resultId}/apply-preview": {
      post: {
        operationId: "previewRunEditorImagegenApply",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          pathParam("resultId", "Imagegen result artifact id."),
        ],
        requestBody: jsonContent({
          $ref: "#/components/schemas/ApplyImagegenResultRequest",
        }),
        responses: {
          "200": response("Preview selected candidate apply patches", {
            $ref: "#/components/schemas/ImagegenApplyPreviewResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/imagegen-results/{resultId}/compare/{candidateId}/image":
      {
        get: {
          operationId: "getRunEditorImagegenComparePreview",
          parameters: [
            { $ref: "#/components/parameters/runId" },
            pathParam("resultId", "Imagegen result artifact id."),
            pathParam("candidateId", "Imagegen candidate id."),
          ],
          responses: {
            "200": {
              content: { "image/png": { schema: { type: "string" } } },
              description: "Before/after/diff PNG for one imagegen candidate.",
            },
            ...errorResponses,
          },
        },
      },
    "/runs/{runId}/editor/imagegen-results/{resultId}/inspect": {
      get: {
        operationId: "inspectRunEditorImagegenResult",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          pathParam("resultId", "Imagegen result artifact id."),
        ],
        responses: {
          "200": response("Inspect imagegen result candidates", {
            $ref: "#/components/schemas/ImagegenResultInspectionResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/import-approved": {
      post: {
        operationId: "importApprovedFramesToEditor",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "201": response("Created editor document from approved frames", {
            $ref: "#/components/schemas/EditorDocumentResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/intents/apply": {
      post: {
        operationId: "applyRunEditorEditIntent",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/EditIntentRequest",
        }),
        responses: {
          "200": response("Applied semantic edit intent with checkpoint", {
            $ref: "#/components/schemas/EditIntentApplyResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/intents/preview": {
      post: {
        operationId: "previewRunEditorEditIntent",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/EditIntentRequest",
        }),
        responses: {
          "200": response("Preview semantic edit intent patch", {
            $ref: "#/components/schemas/EditIntentPreviewResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/mask-intelligence": {
      get: {
        operationId: "getRunEditorMaskIntelligence",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("Mask diagnostics and deterministic suggestions", {
            $ref: "#/components/schemas/MaskIntelligenceResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/memory": {
      get: {
        operationId: "getRunEditorAgentMemory",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("Agent-facing project memory", {
            $ref: "#/components/schemas/AgentProjectMemoryResponse",
          }),
          ...errorResponses,
        },
      },
      put: {
        operationId: "saveRunEditorAgentMemory",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/AgentProjectMemory",
        }),
        responses: {
          "200": response("Saved agent-facing project memory", {
            $ref: "#/components/schemas/AgentProjectMemoryResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/operations": {
      patch: {
        operationId: "applyRunEditorOperations",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/EditorOperationsRequest",
        }),
        responses: {
          "200": response("Editor document after applied operations", {
            $ref: "#/components/schemas/EditorDocumentResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/operations-log": {
      get: {
        operationId: "listRunEditorOperations",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("List editor operation log entries", {
            $ref: "#/components/schemas/EditorOperationLogResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/operations-log/{operationId}/revert": {
      post: {
        operationId: "revertRunEditorOperation",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          pathParam("operationId", "Editor operation log id."),
        ],
        requestBody: jsonContent({
          $ref: "#/components/schemas/RevertEditorOperationRequest",
        }),
        responses: {
          "200": response("Reverted exact editor operation", {
            $ref: "#/components/schemas/RevertEditorOperationResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/references": {
      post: {
        operationId: "createRunEditorPartReference",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/CreatePartReferenceRequest",
        }),
        responses: {
          "201": response("Created masked part reference package", {
            $ref: "#/components/schemas/PartReferenceResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/references/{referenceId}/image": {
      get: {
        operationId: "getRunEditorPartReferenceImage",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          pathParam("referenceId", "Part reference package id."),
        ],
        responses: {
          "200": {
            content: {
              "image/png": { schema: { format: "binary", type: "string" } },
            },
            description: "Masked part reference PNG crop.",
          },
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/regenerate": {
      post: {
        operationId: "createRunEditorPartRegenerationDraft",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/PartRegenerationRequest",
        }),
        responses: {
          "201": response("Created targeted regeneration draft", {
            $ref: "#/components/schemas/PartRegenerationDraftResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/url": {
      get: {
        operationId: "getRunEditorUrl",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("Codex browser handoff URL", {
            $ref: "#/components/schemas/EditorUrlResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/editor/visual-summary": {
      get: {
        operationId: "getRunEditorVisualSummary",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response(
            "Human-oriented visual summary for agent inspection",
            {
              $ref: "#/components/schemas/VisualSummaryResponse",
            }
          ),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/exports": {
      get: {
        operationId: "listRunExports",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        responses: {
          "200": response("List saved animation export snapshots", {
            $ref: "#/components/schemas/SavedAnimationsResponse",
          }),
          ...errorResponses,
        },
      },
      post: {
        operationId: "createExportJob",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/CreateExportRequest",
        }),
        responses: {
          "202": response("Queued export job", {
            $ref: "#/components/schemas/ExportJobResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/exports/{exportId}": {
      get: {
        operationId: "getRunExport",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          { $ref: "#/components/parameters/exportId" },
        ],
        responses: {
          "200": response("Read saved animation export snapshot", {
            $ref: "#/components/schemas/SavedAnimationResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/exports/{exportId}/files/{filePath}": {
      get: {
        operationId: "getRunExportFile",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          { $ref: "#/components/parameters/exportId" },
          { $ref: "#/components/parameters/filePath" },
        ],
        responses: {
          "200": {
            content: {
              "application/json": { schema: { type: "object" } },
              "image/gif": { schema: { format: "binary", type: "string" } },
              "image/png": { schema: { format: "binary", type: "string" } },
              "image/svg+xml": {
                schema: { format: "binary", type: "string" },
              },
              "image/webp": { schema: { format: "binary", type: "string" } },
              "text/css": { schema: { type: "string" } },
              "text/plain": { schema: { type: "string" } },
            },
            description: "Read a generated export artifact file.",
          },
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/frames": {
      post: {
        operationId: "addRunFrame",
        parameters: [{ $ref: "#/components/parameters/runId" }],
        requestBody: jsonContent({
          $ref: "#/components/schemas/AddFrameRequest",
        }),
        responses: {
          "201": response("Updated run after ingesting frames", {
            $ref: "#/components/schemas/AddFrameResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/frames/{frameId}": {
      get: {
        operationId: "getRunFrame",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          { $ref: "#/components/parameters/frameId" },
        ],
        responses: {
          "200": response("Read frame metadata", {
            $ref: "#/components/schemas/FrameResponse",
          }),
          ...errorResponses,
        },
      },
    },
    "/runs/{runId}/frames/{frameId}/approve": {
      post: {
        operationId: "approveRunFrame",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          { $ref: "#/components/parameters/frameId" },
        ],
        requestBody: jsonContent({
          $ref: "#/components/schemas/ApproveFrameRequest",
        }),
        responses: {
          "200": response(
            "Updated run approval model and mirrored frame fields",
            { $ref: "#/components/schemas/ApproveFrameResponse" }
          ),
          ...errorResponses,
        },
        summary:
          "Updates run.approval.approvedFrames and mirrored frame approval fields.",
      },
    },
    "/runs/{runId}/frames/{frameId}/image": {
      get: {
        operationId: "getRunFrameImage",
        parameters: [
          { $ref: "#/components/parameters/runId" },
          { $ref: "#/components/parameters/frameId" },
        ],
        responses: {
          "200": {
            content: {
              "image/png": { schema: { format: "binary", type: "string" } },
            },
            description: "Read frame PNG image.",
          },
          ...errorResponses,
        },
      },
    },
  },
} as const;
