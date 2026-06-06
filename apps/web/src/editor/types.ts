import type { LucideIcon } from "lucide-react";

export type Tool =
  | "brush"
  | "bucket"
  | "eraser"
  | "gradient"
  | "picker"
  | "selection"
  | "shape"
  | "transform";

export type TransformTarget =
  | "selection-move"
  | "selection-rotate"
  | "selection-scale"
  | "viewport";

export type CellColor = null | string;
export type Corner = "ne" | "nw" | "se" | "sw";
export type FillTool = "bucket" | "gradient";
export type GradientKind = "linear" | "radial";
export type GradientPattern = "bayer" | "checker" | "fine" | "hard";
export type EditorMode = "edit" | "mask";
export type ExportFormat =
  | "css"
  | "gif"
  | "json"
  | "lottie"
  | "png"
  | "raw-frames"
  | "react"
  | "strip-png"
  | "svg"
  | "tgs"
  | "webm"
  | "webp";
export type ExportDestination = "backend" | "local";
export type ExportScope = "animation" | "frame";
export type SelectionMode =
  | "box"
  | "ellipse"
  | "lasso"
  | "magic-wand"
  | "polygon";
export type ShapeMode = "fill" | "outline";
export type ShapeTool = "ellipse" | "line" | "rectangle" | "triangle";

export interface Cell {
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  height: number;
  width: number;
}

export interface TransformStart {
  angle: number;
  bounds?: Bounds;
  corner?: Corner;
  distance: number;
  grid?: CellColor[];
  isExplicitSelection?: boolean;
  maskLayerId?: string;
  maskLayerIds?: string[];
  mask?: boolean[];
  origin: Point;
  pan: Point;
  point: Point;
  rotation: number;
  scale: Point;
}

export interface AnimationFrame {
  grid: CellColor[];
  id: string;
  size: Size;
}

export interface MaskLayer {
  aliases?: string[];
  anchor: Point;
  color: string;
  id: string;
  mask: boolean[];
  name: string;
  parentId: null | string;
  partKind?: string;
  promptHint?: string;
  regenerationPolicy?: {
    allowImagegenReference: boolean;
    allowRegenerate: boolean;
    locked: boolean;
    preservePalette: boolean;
  };
  semanticLabel?: string;
  semanticRole?:
    | "background"
    | "body"
    | "clothes"
    | "eyes"
    | "face"
    | "hair"
    | "head"
    | "mouth"
    | "prop"
    | "shadow"
    | "unknown"
    | "weapon";
  visible: boolean;
}

export interface TransformMaskTarget {
  bounds: Bounds;
  isExplicitSelection: boolean;
  mask: boolean[];
  maskLayerId?: string;
  maskLayerIds?: string[];
}

export interface PaletteEntry {
  color: string;
  count: number;
}

export interface CanvasSnapshot {
  activeMaskLayerId: string;
  grid: CellColor[];
  maskLayers: MaskLayer[];
  size: Size;
}

export interface ToolGroupOption<T extends string> {
  icon: LucideIcon;
  label: string;
  value: T;
}
