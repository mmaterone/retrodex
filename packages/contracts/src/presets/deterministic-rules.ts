import type { CleanupPipeline } from "../pipeline/cleanup-steps";
import {
  controlGridCleanupPipeline,
  promptOnlySheetCleanupPipeline,
} from "../pipeline/cleanup-steps";

export type PresetId =
  | "character.fighter.control-grid.v1"
  | "character.utya.prompt-sheet.v1"
  | "item.control-grid.v1"
  | "fx.sheet.v1";

export interface DeterministicPreset {
  appliesTo: {
    actions: string[];
    assetTypes: string[];
  };
  cleanupPipeline: CleanupPipeline;
  exportDefaults: {
    anchor: "center" | "bottom" | "feet";
    canvasSize: number;
    fps: number;
  };
  generationContract: {
    background: string;
    editableCanvases: number;
    grid: string | null;
    guidance: string[];
    referencesInsideEditableCanvas: false;
  };
  id: PresetId;
  label: string;
  qcPolicy: {
    anchorDrift: "reject" | "warn";
    faceFeatureLoss: "reject" | "warn";
    gridMismatch: "reject" | "warn";
    paletteDrift: "reject" | "warn";
  };
}

export const deterministicPresets: Record<PresetId, DeterministicPreset> = {
  "character.fighter.control-grid.v1": {
    appliesTo: {
      actions: ["single", "idle", "walk", "run", "attack", "hurt", "cast"],
      assetTypes: ["character", "player", "npc", "creature"],
    },
    cleanupPipeline: controlGridCleanupPipeline,
    exportDefaults: { anchor: "feet", canvasSize: 32, fps: 8 },
    generationContract: {
      background: "#ff00ff",
      editableCanvases: 1,
      grid: "#00ffff",
      guidance: [
        "Use one editable grid canvas only.",
        "Keep references outside the edited image.",
        "Each visible cell is one final logical pixel.",
        "Do not paint across gutters.",
      ],
      referencesInsideEditableCanvas: false,
    },
    id: "character.fighter.control-grid.v1",
    label: "Character fighter on real control grid",
    qcPolicy: {
      anchorDrift: "warn",
      faceFeatureLoss: "reject",
      gridMismatch: "reject",
      paletteDrift: "warn",
    },
  },
  "character.utya.prompt-sheet.v1": {
    appliesTo: {
      actions: ["dash", "slide", "run", "jump", "attack", "breathing"],
      assetTypes: ["character", "player"],
    },
    cleanupPipeline: promptOnlySheetCleanupPipeline,
    exportDefaults: { anchor: "feet", canvasSize: 32, fps: 8 },
    generationContract: {
      background: "#ff00ff",
      editableCanvases: 1,
      grid: null,
      guidance: [
        "Generate one horizontal sheet for one action family.",
        "Facing and motion direction are separate fields.",
        "Never downsample the whole sheet directly.",
        "Extract palette from approved keyframe.",
      ],
      referencesInsideEditableCanvas: false,
    },
    id: "character.utya.prompt-sheet.v1",
    label: "Utya prompt-only action sheet",
    qcPolicy: {
      anchorDrift: "warn",
      faceFeatureLoss: "reject",
      gridMismatch: "warn",
      paletteDrift: "reject",
    },
  },
  "fx.sheet.v1": {
    appliesTo: {
      actions: ["impact", "slash", "projectile", "burst"],
      assetTypes: ["fx", "impact", "projectile"],
    },
    cleanupPipeline: controlGridCleanupPipeline,
    exportDefaults: { anchor: "center", canvasSize: 32, fps: 12 },
    generationContract: {
      background: "#ff00ff",
      editableCanvases: 1,
      grid: "#00ffff",
      guidance: [
        "Keep FX detached from character body.",
        "Use component mode all.",
        "Center anchor by default.",
      ],
      referencesInsideEditableCanvas: false,
    },
    id: "fx.sheet.v1",
    label: "Separated FX sheet",
    qcPolicy: {
      anchorDrift: "warn",
      faceFeatureLoss: "warn",
      gridMismatch: "reject",
      paletteDrift: "warn",
    },
  },
  "item.control-grid.v1": {
    appliesTo: {
      actions: ["single", "idle", "projectile"],
      assetTypes: ["background", "icon", "item", "prop", "projectile"],
    },
    cleanupPipeline: controlGridCleanupPipeline,
    exportDefaults: { anchor: "center", canvasSize: 32, fps: 10 },
    generationContract: {
      background: "#ff00ff",
      editableCanvases: 1,
      grid: "#00ffff",
      guidance: [
        "Use a single centered subject.",
        "Use center anchor unless the object is grounded.",
        "Preserve silhouette before reducing color count.",
      ],
      referencesInsideEditableCanvas: false,
    },
    id: "item.control-grid.v1",
    label: "Single item on control grid",
    qcPolicy: {
      anchorDrift: "warn",
      faceFeatureLoss: "warn",
      gridMismatch: "reject",
      paletteDrift: "warn",
    },
  },
};

export const selectPreset = (
  assetType: string,
  action: string
): DeterministicPreset =>
  Object.values(deterministicPresets).find(
    (preset) =>
      preset.appliesTo.assetTypes.includes(assetType) &&
      preset.appliesTo.actions.includes(action)
  ) ?? deterministicPresets["character.fighter.control-grid.v1"];
