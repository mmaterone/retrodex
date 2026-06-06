import { useMemo, useReducer } from "react";
import type { Dispatch, SetStateAction } from "react";

import { defaultAnimationFps, defaultColor } from "./constants";
import { createFrame } from "./grid";
import { createEmptyMask, createMaskLayer } from "./masks";
import type {
  AnimationFrame,
  Bounds,
  EditorMode,
  ExportFormat,
  ExportScope,
  FillTool,
  GradientKind,
  GradientPattern,
  MaskLayer,
  Point,
  SelectionMode,
  ShapeMode,
  ShapeTool,
  Size,
  Tool,
} from "./types";

export interface EditorState {
  activeMaskLayerId: string;
  activeTool: Tool;
  animationFps: number;
  artOrigin: Point;
  artPan: Point;
  artRotation: number;
  artScale: Point;
  brushSize: number;
  canvasSize: Size;
  currentColor: string;
  currentOpacity: number;
  editorMode: EditorMode;
  exportFormat: ExportFormat;
  exportFrameId: string;
  exportPreviewFrames: AnimationFrame[];
  exportScale: number;
  exportScope: ExportScope;
  fillTool: FillTool;
  frames: AnimationFrame[];
  gradientEndColor: string;
  gradientKind: GradientKind;
  gradientPattern: GradientPattern;
  gradientStartColor: string;
  isColorPanelOpen: boolean;
  isExportOpen: boolean;
  isFillMenuOpen: boolean;
  isGridVisible: boolean;
  isPlaying: boolean;
  isReferenceMinimized: boolean;
  isReferenceOpen: boolean;
  isSelectionMenuOpen: boolean;
  isShapeMenuOpen: boolean;
  isTimelineOpen: boolean;
  maskLayers: MaskLayer[];
  pan: Point;
  savedColors: string[];
  selectedFrameId: string;
  selectionBounds: Bounds | null;
  selectionMask: boolean[];
  selectionMode: SelectionMode;
  shapeMode: ShapeMode;
  shapeRadius: number;
  shapeTool: ShapeTool;
  zoomLevel: number;
}

interface EditorStateAction<K extends keyof EditorState = keyof EditorState> {
  key: K;
  value: SetStateAction<EditorState[K]>;
}

export type EditorStateSetters = {
  [K in keyof EditorState as `set${Capitalize<string & K>}`]: Dispatch<
    SetStateAction<EditorState[K]>
  >;
};

const setterNameFor = (key: string) =>
  `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;

const editorStateKeys = [
  "activeMaskLayerId",
  "activeTool",
  "animationFps",
  "artOrigin",
  "artPan",
  "artRotation",
  "artScale",
  "brushSize",
  "canvasSize",
  "currentColor",
  "currentOpacity",
  "editorMode",
  "exportFormat",
  "exportFrameId",
  "exportPreviewFrames",
  "exportScale",
  "exportScope",
  "fillTool",
  "frames",
  "gradientEndColor",
  "gradientKind",
  "gradientPattern",
  "gradientStartColor",
  "isColorPanelOpen",
  "isExportOpen",
  "isFillMenuOpen",
  "isGridVisible",
  "isPlaying",
  "isReferenceMinimized",
  "isReferenceOpen",
  "isSelectionMenuOpen",
  "isShapeMenuOpen",
  "isTimelineOpen",
  "maskLayers",
  "pan",
  "savedColors",
  "selectedFrameId",
  "selectionBounds",
  "selectionMask",
  "selectionMode",
  "shapeMode",
  "shapeRadius",
  "shapeTool",
  "zoomLevel",
] as const satisfies readonly (keyof EditorState)[];

const editorStateReducer = (
  state: EditorState,
  action: EditorStateAction
): EditorState => {
  const currentValue = state[action.key];
  const nextValue =
    typeof action.value === "function"
      ? (action.value as (value: typeof currentValue) => typeof currentValue)(
          currentValue
        )
      : action.value;
  return { ...state, [action.key]: nextValue };
};

export const createInitialEditorState = ({
  initialFrameId,
  initialMaskLayerId,
  size,
}: {
  initialFrameId: string;
  initialMaskLayerId: string;
  size: Size;
}): EditorState => {
  const initialMaskLayer = {
    ...createMaskLayer(size, 0),
    id: initialMaskLayerId,
  };
  return {
    activeMaskLayerId: initialMaskLayerId,
    activeTool: "brush",
    animationFps: defaultAnimationFps,
    artOrigin: { x: size.width / 2, y: size.height / 2 },
    artPan: { x: 0, y: 0 },
    artRotation: 0,
    artScale: { x: 1, y: 1 },
    brushSize: 1,
    canvasSize: size,
    currentColor: defaultColor,
    currentOpacity: 1,
    editorMode: "edit",
    exportFormat: "png",
    exportFrameId: initialFrameId,
    exportPreviewFrames: [],
    exportScale: 1,
    exportScope: "animation",
    fillTool: "bucket",
    frames: [createFrame(size, undefined, initialFrameId)],
    gradientEndColor: "#f4f4f4",
    gradientKind: "linear",
    gradientPattern: "bayer",
    gradientStartColor: defaultColor,
    isColorPanelOpen: false,
    isExportOpen: false,
    isFillMenuOpen: false,
    isGridVisible: true,
    isPlaying: false,
    isReferenceMinimized: false,
    isReferenceOpen: false,
    isSelectionMenuOpen: false,
    isShapeMenuOpen: false,
    isTimelineOpen: false,
    maskLayers: [initialMaskLayer],
    pan: { x: 0, y: 0 },
    savedColors: [],
    selectedFrameId: initialFrameId,
    selectionBounds: null,
    selectionMask: createEmptyMask(size),
    selectionMode: "box",
    shapeMode: "outline",
    shapeRadius: 0,
    shapeTool: "rectangle",
    zoomLevel: 1,
  };
};

export const useEditorState = ({
  initialFrameId,
  initialMaskLayerId,
  size,
}: {
  initialFrameId: string;
  initialMaskLayerId: string;
  size: Size;
}) => {
  const [state, dispatch] = useReducer(
    editorStateReducer,
    { initialFrameId, initialMaskLayerId, size },
    createInitialEditorState
  );
  const setters = useMemo(() => {
    const entries = editorStateKeys.map((key) => [
      setterNameFor(String(key)),
      (value: SetStateAction<EditorState[typeof key]>) =>
        dispatch({ key, value }),
    ]);
    return Object.fromEntries(entries) as EditorStateSetters;
  }, []);
  return { setters, state };
};
