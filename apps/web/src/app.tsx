import type { EditorDocument } from "@retrodex/contracts";
import { Download } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

import {
  BrushSizePanel,
  CanvasSizeControl,
  ColorPanel,
  EditorModeTabs,
  ExportDialog,
  FloatingPanels,
  MaskAnchorsOverlay,
  MaskLayersPanel,
  MaskOverlay,
  SelectionMaskOverlay,
  Timeline,
  Toolbar,
} from "@/components/editor/editor-components";

import {
  createEditorDocumentSnapshot,
  documentFramesToEditorFrames,
  documentMasksToEditorMasks,
  fetchEditorDocument,
  getFramePalette,
  getEditorSessionParams,
  saveEditorFramePixels,
  saveEditorFrameGrid,
  saveEditorDocument,
  writeLocalExportFiles,
} from "./editor/api";
import { normalizeHexColor } from "./editor/color";
import {
  basePixelScale as scale,
  defaultCanvasSize,
  fpsToFrameDurationMs,
  historyLimit,
  maxAnimationFps,
  minAnimationFps,
  trackpadPanDeltaLimit,
} from "./editor/constants";
import {
  createCssExport,
  createFrameCanvas,
  createGifBlob,
  createStripCanvas,
  createWebmBlob,
} from "./editor/export/canvas";
import {
  createLottieExport,
  createReactExport,
  createSavedAnimationJson,
  createSvgExport,
  createTgsExportBlob,
  getExportDialogFrames,
  getExportFramesForScope,
} from "./editor/export/serializers";
import {
  cellIndex as getCellIndex,
  clamp,
  clampCanvasDimension,
  clampScale,
  clampZoom,
  createFrame,
  createFrameId,
  interpolate,
  resizeGrid,
} from "./editor/grid";
import {
  cursorForHitTarget,
  hitTestCanvas,
  magneticPointForHitTarget,
} from "./editor/hit-testing";
import type { CanvasHitTarget } from "./editor/hit-testing";
import {
  cloneMaskLayers,
  combineMaskLayers as combineMaskLayersForSize,
  createEmptyMask as createEmptyMaskForSize,
  createMaskLayer as createMaskLayerForSize,
  getBoxMask as getBoxMaskForSize,
  getConnectedColorMask as getConnectedColorMaskForSize,
  getDragBounds,
  getEllipseMask as getEllipseMaskForSize,
  getMaskBounds as getMaskBoundsForSize,
  getMaskLayerFamilyIds,
  getMaskLayerFamilyIdsOrEmpty,
  getOptionalMaskLayerFamilyIds,
  getGradientAmount,
  getPatternThreshold,
  getPolygonDraftMask as getPolygonDraftMaskForSize,
  getPolygonMask as getPolygonMaskForSize,
  getSelectionCenter,
  getShapeMask as getShapeMaskForSize,
  resizeBooleanMask,
  transformSelectionGrid as transformSelectionGridForSize,
  transformSelectionMask as transformSelectionMaskForSize,
  transformSelectionPoint as transformSelectionPointForSize,
  wouldCreateMaskParentCycle,
} from "./editor/masks";
import type {
  AnimationFrame,
  Bounds,
  CanvasSnapshot,
  Cell,
  CellColor,
  Corner,
  EditorMode,
  ExportFormat,
  ExportScope,
  MaskLayer,
  Point,
  ShapeMode,
  ShapeTool,
  Size,
  Tool,
  TransformMaskTarget,
  TransformStart,
  TransformTarget,
} from "./editor/types";
import { useEditorState } from "./editor/use-editor-state";

let { height, width }: { height: number; width: number } = defaultCanvasSize;

const currentCanvasSize = (): Size => ({ height, width });
const cellIndex = (x: number, y: number) =>
  getCellIndex(currentCanvasSize(), x, y);
const createEmptyMask = () => createEmptyMaskForSize(currentCanvasSize());
const createMaskLayer = (index: number): MaskLayer =>
  createMaskLayerForSize(currentCanvasSize(), index);
const combineMaskLayers = (layerIds: string[], layers: MaskLayer[]) =>
  combineMaskLayersForSize(currentCanvasSize(), layerIds, layers);

interface EditorDebugEvent {
  activeTool: Tool;
  frameId: string;
  nonempty: number;
  reason: string;
  revision: null | number;
  timestamp: string;
}

interface EditorWorkspaceStatus {
  dirty: boolean;
  lastSavedAt: null | string;
  revision: null | number;
  runId: null | string;
  selectedFrameId: null | string;
}

const recordEditorDebugEvent = (event: EditorDebugEvent) => {
  const target = window as unknown as {
    __PCC_DEBUG?: { events: EditorDebugEvent[]; latest?: EditorDebugEvent };
  };
  const debug = target.__PCC_DEBUG ?? { events: [] };
  debug.events = [...debug.events, event].slice(-50);
  debug.latest = event;
  target.__PCC_DEBUG = debug;
  document.documentElement.dataset.pccDebug = JSON.stringify(debug);
  try {
    window.localStorage.setItem("PCC_DEBUG", JSON.stringify(debug));
  } catch {
    // Debug storage is best-effort only.
  }
};

const getMaskBounds = (mask: boolean[]) =>
  getMaskBoundsForSize(currentCanvasSize(), mask);
const getBoxMask = (bounds: Bounds) =>
  getBoxMaskForSize(currentCanvasSize(), bounds);
const getEllipseMask = (bounds: Bounds) =>
  getEllipseMaskForSize(currentCanvasSize(), bounds);
const getShapeMask = (
  startCell: Cell,
  endCell: Cell,
  shapeTool: ShapeTool,
  shapeMode: ShapeMode,
  radius: number
) =>
  getShapeMaskForSize(
    currentCanvasSize(),
    startCell,
    endCell,
    shapeTool,
    shapeMode,
    radius
  );
const getPolygonMask = (points: Cell[]) =>
  getPolygonMaskForSize(currentCanvasSize(), points);
const getPolygonDraftMask = (points: Cell[]) =>
  getPolygonDraftMaskForSize(currentCanvasSize(), points);
const getConnectedColorMask = (cell: Cell, grid: CellColor[]) =>
  getConnectedColorMaskForSize(currentCanvasSize(), cell, grid);
const getScaleOrigin = (bounds: Bounds, corner: Corner): Point => ({
  x: corner.includes("e") ? bounds.x : bounds.x + bounds.width,
  y: corner.includes("s") ? bounds.y : bounds.y + bounds.height,
});

const getMaskOverlayLayers = (
  mode: EditorMode,
  layers: MaskLayer[],
  excludedLayerIds: string[]
) => {
  if (mode !== "mask") {
    return [];
  }
  return layers.filter(
    (layer) => layer.visible && !excludedLayerIds.includes(layer.id)
  );
};

const transformSelectionGrid = (
  grid: CellColor[],
  bounds: Bounds,
  mask: boolean[],
  transformScale: Point,
  rotation: number,
  origin: Point,
  translation: Point
) =>
  transformSelectionGridForSize(
    currentCanvasSize(),
    grid,
    bounds,
    mask,
    transformScale,
    rotation,
    origin,
    translation
  );

const transformSelectionMask = (
  bounds: Bounds,
  mask: boolean[],
  transformScale: Point,
  rotation: number,
  origin: Point,
  translation: Point
) =>
  transformSelectionMaskForSize(
    currentCanvasSize(),
    bounds,
    mask,
    transformScale,
    rotation,
    origin,
    translation
  );

const transformSelectionPoint = (
  point: Point,
  transformScale: Point,
  rotation: number,
  origin: Point,
  translation: Point
): Point =>
  transformSelectionPointForSize(
    currentCanvasSize(),
    point,
    transformScale,
    rotation,
    origin,
    translation
  );

const canvasToBlob = async (canvas: HTMLCanvasElement, type = "image/png") => {
  const response = await fetch(canvas.toDataURL(type));
  return response.blob();
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const blobToBase64 = async (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(reader.error));
    reader.addEventListener("load", () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    });
    reader.readAsDataURL(blob);
  });

const downloadLocalExport = async ({
  directoryPath,
  filenameBase,
  format,
  frames,
  fps,
  scaleFactor,
  scope,
}: {
  directoryPath: string;
  filenameBase: string;
  format: ExportFormat;
  frames: AnimationFrame[];
  fps: number;
  scaleFactor: number;
  scope: ExportScope;
}) => {
  const exportFiles: { blob: Blob; filename: string }[] = [];
  const saveBlob = async (blob: Blob, filename: string) => {
    exportFiles.push({ blob, filename });
  };
  const saveText = async (content: string, filename: string, type: string) => {
    exportFiles.push({ blob: new Blob([content], { type }), filename });
  };

  if (format === "png") {
    await saveBlob(
      await canvasToBlob(createFrameCanvas(frames[0], scaleFactor)),
      `${filenameBase}.png`
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "raw-frames") {
    const downloads = frames.map(async (frame, index) => {
      const blob = await canvasToBlob(createFrameCanvas(frame, scaleFactor));
      await saveBlob(blob, `${filenameBase}-frame-${index + 1}.png`);
    });
    await Promise.all(downloads);
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "strip-png") {
    await saveBlob(
      await canvasToBlob(createStripCanvas(frames, scaleFactor)),
      `${filenameBase}-strip.png`
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "webp") {
    const canvas =
      scope === "animation"
        ? createStripCanvas(frames, scaleFactor)
        : createFrameCanvas(frames[0], scaleFactor);
    await saveBlob(
      await canvasToBlob(canvas, "image/webp"),
      `${filenameBase}.webp`
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "gif") {
    await saveBlob(
      createGifBlob(frames, scaleFactor, fps),
      `${filenameBase}.gif`
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "webm") {
    await saveBlob(
      await createWebmBlob(frames, scaleFactor, fps),
      `${filenameBase}.webm`
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "svg") {
    await saveText(
      createSvgExport(frames, scaleFactor, fps),
      `${filenameBase}.svg`,
      "image/svg+xml"
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "lottie") {
    await saveText(
      createLottieExport(frames, scaleFactor, fps),
      `${filenameBase}.lottie.json`,
      "application/json"
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "tgs") {
    await saveBlob(
      await createTgsExportBlob(frames, scaleFactor, fps),
      `${filenameBase}.tgs`
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "react") {
    await saveText(
      createReactExport(frames, scaleFactor, fps),
      `${filenameBase}.tsx`,
      "text/plain"
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  if (format === "css") {
    await saveText(
      createCssExport(frames, scaleFactor, fps),
      `${filenameBase}.css`,
      "text/css"
    );
    return saveExportFiles(directoryPath, exportFiles);
  }
  await saveText(
    createSavedAnimationJson(frames, scaleFactor, format, scope, fps),
    `${filenameBase}.saved-animation.json`,
    "application/json"
  );
  return saveExportFiles(directoryPath, exportFiles);
};

const saveExportFiles = async (
  directoryPath: string,
  files: { blob: Blob; filename: string }[]
) => {
  if (!directoryPath.trim()) {
    for (const file of files) {
      downloadBlob(file.blob, file.filename);
    }
    return { directoryPath: "", files, mode: "download" as const };
  }
  const result = await writeLocalExportFiles({
    directoryPath,
    files: await Promise.all(
      files.map(async (file) => ({
        contentBase64: await blobToBase64(file.blob),
        filename: file.filename,
      }))
    ),
  });
  return { ...result, mode: "directory" as const };
};

const canDeleteActiveTarget = (
  tool: Tool,
  hasSelection: boolean,
  selectionBounds: Bounds | null
) => {
  if (tool === "selection") {
    return hasSelection;
  }
  return tool === "transform" && Boolean(selectionBounds);
};

export const App = () => {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const redoStackRef = useRef<CanvasSnapshot[]>([]);
  const loadFrameRef = useRef<((frame: AnimationFrame) => void) | null>(null);
  const redoCanvasRef = useRef<(() => void) | null>(null);
  const saveProjectRef = useRef<(() => Promise<void>) | null>(null);
  const suppressToolShortcutUntilRef = useRef(0);
  const togglePlaybackRef = useRef<(() => void) | null>(null);
  const undoStackRef = useRef<CanvasSnapshot[]>([]);
  const undoCanvasRef = useRef<(() => void) | null>(null);
  const panningRef = useRef(false);
  const selectingRef = useRef(false);
  const transformTargetRef = useRef<TransformTarget>("viewport");
  const lastCellRef = useRef<Cell | null>(null);
  const lastPanPointRef = useRef<Point | null>(null);
  const lineAnchorRef = useRef<Cell | null>(null);
  const gradientBaseGridRef = useRef<CellColor[] | null>(null);
  const gradientMaskRef = useRef<boolean[] | null>(null);
  const gradientStartRef = useRef<Cell | null>(null);
  const lassoPointsRef = useRef<Cell[]>([]);
  const polygonPointsRef = useRef<Cell[]>([]);
  const selectionMaskRef = useRef<boolean[]>(createEmptyMask());
  const hitTargetRef = useRef<CanvasHitTarget | null>(null);
  const [hoverHitTarget, setHoverHitTarget] = useState<CanvasHitTarget | null>(
    null
  );
  const selectionStartRef = useRef<Cell | null>(null);
  const maskShapeBaseRef = useRef<boolean[] | null>(null);
  const shapeBaseGridRef = useRef<CellColor[] | null>(null);
  const shapeStartRef = useRef<Cell | null>(null);
  const strokeToolRef = useRef<Tool | null>(null);
  const activeToolRef = useRef<Tool>("brush");
  const anchorDragLayerIdRef = useRef<null | string>(null);
  const artPanRef = useRef<Point>({ x: 0, y: 0 });
  const artRotationRef = useRef(0);
  const artOriginRef = useRef<Point>({ x: width / 2, y: height / 2 });
  const artScaleRef = useRef<Point>({ x: 1, y: 1 });
  const zoomLevelRef = useRef(1);
  const transformStartRef = useRef<TransformStart | null>(null);
  const activeTransformMaskLayerIdRef = useRef<string | null>(null);
  const initialFrameIdRef = useRef(createFrameId());
  const initialMaskLayerIdRef = useRef(createFrameId());
  const editorDocumentRef = useRef<EditorDocument | null>(null);
  const editorRunIdRef = useRef<string | null>(getEditorSessionParams().runId);
  const hydrationCompleteRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const documentSaveTimerRef = useRef<number | null>(null);
  const isHydratingEditorRef = useRef(false);
  const [exportDirectoryPath, setExportDirectoryPath] = useState(
    "~/Downloads/Retrodex"
  );
  const [exportStatus, setExportStatus] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [editorWorkspaceStatus, setEditorWorkspaceStatus] =
    useState<EditorWorkspaceStatus>({
      dirty: false,
      lastSavedAt: null,
      revision: null,
      runId: editorRunIdRef.current,
      selectedFrameId: getEditorSessionParams().frameId,
    });
  const [excludedExportFrameIds, setExcludedExportFrameIds] = useState<
    string[]
  >([]);
  const { setters, state } = useEditorState({
    initialFrameId: initialFrameIdRef.current,
    initialMaskLayerId: initialMaskLayerIdRef.current,
    size: { height, width },
  });
  const {
    activeMaskLayerId,
    activeTool,
    animationFps,
    artOrigin,
    artPan,
    artRotation,
    artScale,
    brushSize,
    canvasSize,
    currentColor,
    currentOpacity,
    editorMode,
    exportFormat,
    exportFrameId,
    exportPreviewFrames,
    exportScale,
    exportScope,
    fillTool,
    frames,
    gradientEndColor,
    gradientKind,
    gradientPattern,
    gradientStartColor,
    isColorPanelOpen,
    isExportOpen,
    isFillMenuOpen,
    isGridVisible,
    isPlaying,
    isReferenceMinimized,
    isReferenceOpen,
    isSelectionMenuOpen,
    isShapeMenuOpen,
    isTimelineOpen,
    maskLayers,
    pan,
    savedColors,
    selectedFrameId,
    selectionBounds,
    selectionMask,
    selectionMode,
    shapeMode,
    shapeRadius,
    shapeTool,
    zoomLevel,
  } = state;
  const {
    setActiveMaskLayerId,
    setActiveTool,
    setAnimationFps,
    setArtOrigin,
    setArtPan,
    setArtRotation,
    setArtScale,
    setBrushSize,
    setCanvasSize,
    setCurrentColor,
    setCurrentOpacity,
    setEditorMode,
    setExportFormat,
    setExportFrameId,
    setExportPreviewFrames,
    setExportScale,
    setExportScope,
    setFillTool,
    setFrames,
    setGradientEndColor,
    setGradientKind,
    setGradientPattern,
    setGradientStartColor,
    setIsColorPanelOpen,
    setIsExportOpen,
    setIsFillMenuOpen,
    setIsGridVisible,
    setIsPlaying,
    setIsReferenceMinimized,
    setIsReferenceOpen,
    setIsSelectionMenuOpen,
    setIsShapeMenuOpen,
    setIsTimelineOpen,
    setMaskLayers,
    setPan,
    setSavedColors,
    setSelectedFrameId,
    setSelectionBounds,
    setSelectionMask,
    setSelectionMode,
    setShapeMode,
    setShapeRadius,
    setShapeTool,
    setZoomLevel,
  } = setters;

  useEffect(() => {
    const selectedFrame =
      frames.find((frame) => frame.id === selectedFrameId) ?? frames[0];
    recordEditorDebugEvent({
      activeTool,
      frameId: selectedFrame?.id ?? "",
      nonempty: selectedFrame?.grid.filter(Boolean).length ?? 0,
      reason: "app:loaded",
      revision: editorDocumentRef.current?.saveState.revision ?? null,
      timestamp: new Date().toISOString(),
    });
    // Only record that this browser tab has loaded the instrumented app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  useEffect(() => {
    artPanRef.current = artPan;
  }, [artPan]);

  useEffect(() => {
    artRotationRef.current = artRotation;
  }, [artRotation]);

  useEffect(() => {
    artOriginRef.current = artOrigin;
  }, [artOrigin]);

  useEffect(() => {
    artScaleRef.current = artScale;
  }, [artScale]);

  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);

  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    const transformCanvas = transformCanvasRef.current;
    const context = canvas?.getContext("2d");
    const transformContext = transformCanvas?.getContext("2d");
    if (
      !shell ||
      !canvas ||
      !context ||
      !transformCanvas ||
      !transformContext
    ) {
      return;
    }
    canvas.width = width * scale;
    canvas.height = height * scale;
    transformCanvas.width = width * scale;
    transformCanvas.height = height * scale;
    context.imageSmoothingEnabled = false;
    transformContext.imageSmoothingEnabled = false;
    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      const isTrackpadPan =
        !event.ctrlKey &&
        event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
        (Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
          Math.abs(event.deltaY) <= trackpadPanDeltaLimit);
      if (isTrackpadPan) {
        setPan((current) => ({
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
        return;
      }
      const speed = event.ctrlKey ? 0.006 : 0.002;
      const factor = Math.exp(-event.deltaY * speed);
      setZoomLevel((current) => clampZoom(current * factor));
    };
    shell.addEventListener("wheel", zoom, { passive: false });
    return () => {
      shell.removeEventListener("wheel", zoom);
    };
  }, [setPan, setZoomLevel]);

  const pointToCell = (event: React.PointerEvent<HTMLElement>): Cell => {
    const rect =
      canvasRef.current?.getBoundingClientRect() ??
      event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(
        Math.floor(((event.clientX - rect.left) / rect.width) * width),
        width - 1
      ),
      y: clamp(
        Math.floor(((event.clientY - rect.top) / rect.height) * height),
        height - 1
      ),
    };
  };

  const pointerToCanvasPoint = (
    event: React.PointerEvent<HTMLElement>
  ): Point | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * width, width - 1),
      y: clamp(((event.clientY - rect.top) / rect.height) * height, height - 1),
    };
  };

  const getCanvasHitTarget = (
    event: React.PointerEvent<HTMLElement>
  ): CanvasHitTarget | null => {
    const canvasPoint = pointerToCanvasPoint(event);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!canvasPoint || !rect) {
      return null;
    }
    return hitTestCanvas({
      anchor: selectionBounds ? artOriginRef.current : null,
      canvasPoint,
      canvasRect: rect,
      maskAnchors:
        editorMode === "mask"
          ? maskLayers
              .filter((layer) => layer.visible)
              .map((layer) => ({ layerId: layer.id, point: layer.anchor }))
          : [],
      previousTarget: hitTargetRef.current,
      selectionBounds,
      size: canvasSize,
    });
  };

  const updateCanvasCursor = (event: React.PointerEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    if (activeTool !== "transform") {
      hitTargetRef.current = null;
      setHoverHitTarget(null);
      canvas.style.cursor = "";
      return;
    }
    const target = getCanvasHitTarget(event);
    if (!target) {
      setHoverHitTarget(null);
      canvas.style.cursor = "";
      return;
    }
    hitTargetRef.current = target;
    setHoverHitTarget(target);
    canvas.style.cursor = cursorForHitTarget(target);
  };

  const getCellSize = () => (shellRef.current?.clientWidth ?? width) / width;

  const setTransformOrigin = (origin: Point) => {
    artOriginRef.current = origin;
    setArtOrigin(origin);
  };

  const hasActiveSelection = () => selectionMaskRef.current.some(Boolean);

  const setCanvasElementDimensions = () => {
    const canvas = canvasRef.current;
    const transformCanvas = transformCanvasRef.current;
    const context = canvas?.getContext("2d");
    const transformContext = transformCanvas?.getContext("2d");
    if (!canvas || !context || !transformCanvas || !transformContext) {
      return;
    }
    canvas.width = width * scale;
    canvas.height = height * scale;
    transformCanvas.width = width * scale;
    transformCanvas.height = height * scale;
    context.imageSmoothingEnabled = false;
    transformContext.imageSmoothingEnabled = false;
  };

  const clearSelectionState = () => {
    const emptyMask = createEmptyMask();
    activeTransformMaskLayerIdRef.current = null;
    selectionMaskRef.current = emptyMask;
    setSelectionMask(emptyMask);
    setSelectionBounds(null);
    selectionStartRef.current = null;
    lassoPointsRef.current = [];
    polygonPointsRef.current = [];
  };

  const applySelectionMask = (mask: boolean[]) => {
    const bounds = getMaskBounds(mask);
    selectionMaskRef.current = mask;
    setSelectionMask(mask);
    setSelectionBounds(bounds);
    if (bounds) {
      setTransformOrigin(getSelectionCenter(bounds));
    }
  };

  const clearSelection = () => {
    clearSelectionState();
    setTransformOrigin({ x: width / 2, y: height / 2 });
  };

  const readGrid = (): CellColor[] => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return Array.from({ length: width * height }, () => null);
    }
    const image = context.getImageData(0, 0, width * scale, height * scale);
    return Array.from({ length: width * height }, (_, index) => {
      const x = index % width;
      const y = Math.floor(index / width);
      const pixelIndex =
        ((y * scale + Math.floor(scale / 2)) * image.width +
          x * scale +
          Math.floor(scale / 2)) *
        4;
      const alpha = image.data[pixelIndex + 3];
      if (alpha === 0) {
        return null;
      }
      const red = image.data[pixelIndex];
      const green = image.data[pixelIndex + 1];
      const blue = image.data[pixelIndex + 2];
      return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
    });
  };

  const persistCurrentFrame = () => {
    const snapshot = {
      grid: readGrid(),
      size: canvasSize,
    };
    setFrames((currentFrames) =>
      currentFrames.map((frame) =>
        frame.id === selectedFrameId ? { ...frame, ...snapshot } : frame
      )
    );
  };

  const getSyncedFrames = () => {
    const snapshot = {
      grid: readGrid(),
      size: canvasSize,
    };
    const snapshotIsEmpty = snapshot.grid.every((cell) => !cell);
    return frames.map((frame) => {
      if (frame.id !== selectedFrameId) {
        return frame;
      }
      if (snapshotIsEmpty && frame.grid.some(Boolean)) {
        return frame;
      }
      return { ...frame, ...snapshot };
    });
  };

  const syncEditorWorkspaceStatus = (document: EditorDocument) => {
    setEditorWorkspaceStatus({
      dirty: document.saveState.dirty,
      lastSavedAt: document.saveState.lastSavedAt,
      revision: document.saveState.revision,
      runId: document.runId,
      selectedFrameId: document.selectedFrameId,
    });
  };

  const markEditorWorkspaceDirty = () => {
    setEditorWorkspaceStatus((current) =>
      current.runId
        ? {
            ...current,
            dirty: true,
            selectedFrameId,
          }
        : current
    );
  };

  const saveEditorDocumentSnapshot = async (
    syncedFrames: AnimationFrame[],
    reason = "snapshot"
  ) => {
    const baseDocument = editorDocumentRef.current;
    if (!baseDocument) {
      return null;
    }
    const debugFrame =
      syncedFrames.find((frame) => frame.id === selectedFrameId) ??
      syncedFrames[0];
    if (debugFrame) {
      recordEditorDebugEvent({
        activeTool,
        frameId: debugFrame.id,
        nonempty: debugFrame.grid.filter(Boolean).length,
        reason: `${reason}:start`,
        revision: baseDocument.saveState.revision,
        timestamp: new Date().toISOString(),
      });
    }
    const snapshot = createEditorDocumentSnapshot({
      activeMaskLayerId,
      baseDocument,
      canvasSize,
      fps: animationFps,
      frames: syncedFrames,
      maskLayers,
      selectedFrameId,
    });
    const document = await saveEditorDocument(snapshot, {
      expectedRevision: baseDocument.saveState.revision,
      writeFrameImages: false,
    });
    editorDocumentRef.current = document;
    syncEditorWorkspaceStatus(document);
    if (debugFrame) {
      const savedFrame =
        document.frames.find((frame) => frame.frameId === debugFrame.id) ??
        document.frames[0];
      recordEditorDebugEvent({
        activeTool,
        frameId: savedFrame?.frameId ?? debugFrame.id,
        nonempty: savedFrame?.grid.cells.filter(Boolean).length ?? 0,
        reason: `${reason}:done`,
        revision: document.saveState.revision,
        timestamp: new Date().toISOString(),
      });
    }
    return document;
  };

  const scheduleEditorDocumentSave = (
    syncedFrames: AnimationFrame[],
    reason = "scheduled"
  ) => {
    if (!(editorDocumentRef.current && hydrationCompleteRef.current)) {
      return;
    }
    markEditorWorkspaceDirty();
    if (documentSaveTimerRef.current) {
      window.clearTimeout(documentSaveTimerRef.current);
      documentSaveTimerRef.current = null;
    }
    void (async () => {
      try {
        await saveEditorDocumentSnapshot(syncedFrames, reason);
      } catch (error: unknown) {
        console.error("Failed to autosave editor document", error);
      }
    })();
  };

  const scheduleCurrentCanvasDocumentSave = (reason: string) => {
    if (!(editorDocumentRef.current && hydrationCompleteRef.current)) {
      return;
    }
    if (documentSaveTimerRef.current) {
      window.clearTimeout(documentSaveTimerRef.current);
    }
    documentSaveTimerRef.current = window.setTimeout(() => {
      documentSaveTimerRef.current = null;
      const syncedFrames = getSyncedFrames();
      setFrames(syncedFrames);
      const selectedFrame = syncedFrames.find(
        (frame) => frame.id === selectedFrameId
      );
      const runId = editorRunIdRef.current;
      if (!(selectedFrame && runId && editorDocumentRef.current)) {
        scheduleEditorDocumentSave(syncedFrames, reason);
        return;
      }
      recordEditorDebugEvent({
        activeTool,
        frameId: selectedFrame.id,
        nonempty: selectedFrame.grid.filter(Boolean).length,
        reason: `${reason}:frame-grid:start`,
        revision: editorDocumentRef.current.saveState.revision,
        timestamp: new Date().toISOString(),
      });
      const expectedRevision = editorDocumentRef.current.saveState.revision;
      void (async () => {
        try {
          const result = await saveEditorFrameGrid({
            expectedRevision,
            frame: selectedFrame,
            runId,
          });
          const currentDocument = editorDocumentRef.current;
          if (currentDocument) {
            editorDocumentRef.current = {
              ...currentDocument,
              frames: currentDocument.frames.map((frame) =>
                frame.frameId === selectedFrame.id
                  ? {
                      ...frame,
                      grid: {
                        ...frame.grid,
                        cells: selectedFrame.grid,
                        palette: getFramePalette(selectedFrame),
                        size: selectedFrame.size,
                      },
                    }
                  : frame
              ),
              saveState: {
                ...currentDocument.saveState,
                dirty: false,
                lastSavedAt: result.lastSavedAt,
                revision: result.revision,
              },
              selectedFrameId: selectedFrame.id,
              updatedAt: result.lastSavedAt,
            };
            setEditorWorkspaceStatus({
              dirty: false,
              lastSavedAt: result.lastSavedAt,
              revision: result.revision,
              runId,
              selectedFrameId: selectedFrame.id,
            });
          }
          recordEditorDebugEvent({
            activeTool,
            frameId: result.frameId,
            nonempty: result.nonempty,
            reason: `${reason}:frame-grid:done`,
            revision: result.revision,
            timestamp: new Date().toISOString(),
          });
        } catch (error: unknown) {
          recordEditorDebugEvent({
            activeTool,
            frameId: selectedFrame.id,
            nonempty: selectedFrame.grid.filter(Boolean).length,
            reason: `${reason}:frame-grid:error`,
            revision: editorDocumentRef.current?.saveState.revision ?? null,
            timestamp: new Date().toISOString(),
          });
          console.error("Failed to autosave editor frame grid", error);
        }
      })();
    }, 80);
  };

  const saveProject = async () => {
    const baseDocument = editorDocumentRef.current;
    const runId = editorRunIdRef.current;
    if (!(baseDocument && runId)) {
      console.warn("No run-linked editor document to save.");
      return;
    }
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (documentSaveTimerRef.current) {
      window.clearTimeout(documentSaveTimerRef.current);
      documentSaveTimerRef.current = null;
    }
    const syncedFrames = getSyncedFrames();
    setFrames(syncedFrames);
    const selectedFrame = syncedFrames.find(
      (frame) => frame.id === selectedFrameId
    );
    const document = await saveEditorDocumentSnapshot(
      syncedFrames,
      "manual-save"
    );
    if (selectedFrame) {
      await saveEditorFramePixels({
        expectedRevision: document?.saveState.revision,
        frame: selectedFrame,
        runId,
      });
    }
  };

  useEffect(() => {
    saveProjectRef.current = saveProject;
  });

  useEffect(() => {
    const baseDocument = editorDocumentRef.current;
    if (
      !baseDocument ||
      !hydrationCompleteRef.current ||
      isHydratingEditorRef.current
    ) {
      return;
    }
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      const save = async () => {
        try {
          await saveEditorDocumentSnapshot(
            getSyncedFrames(),
            "effect-autosave"
          );
        } catch (error: unknown) {
          console.error("Failed to autosave editor document", error);
        }
      };
      void save();
    }, 350);
    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeMaskLayerId,
    animationFps,
    canvasSize,
    frames,
    maskLayers,
    selectedFrameId,
  ]);

  const openExportDialog = () => {
    const syncedFrames = getSyncedFrames();
    setFrames(syncedFrames);
    setExportPreviewFrames(syncedFrames);
    setExportFrameId(selectedFrameId);
    setExcludedExportFrameIds((current) =>
      current.filter((frameId) =>
        syncedFrames.some((frame) => frame.id === frameId)
      )
    );
    setExportStatus("");
    setIsExportOpen(true);
  };

  const requestExport = async () => {
    setIsExporting(true);
    setExportStatus("");
    const syncedFrames = getSyncedFrames();
    setFrames(syncedFrames);
    setExportPreviewFrames(syncedFrames);
    const scopedExportFrames = getExportFramesForScope(
      syncedFrames,
      exportFrameId,
      exportScope
    );
    const exportFrames =
      exportScope === "animation"
        ? scopedExportFrames.filter(
            (frame) => !excludedExportFrameIds.includes(frame.id)
          )
        : scopedExportFrames;
    if (exportFrames.length === 0) {
      setExportStatus("At least one frame must be included in the export.");
      setIsExporting(false);
      return;
    }
    const filenameBase = `retrodex-${Date.now().toString(36)}`;
    try {
      const result = await downloadLocalExport({
        directoryPath: exportDirectoryPath,
        filenameBase,
        format: exportFormat,
        fps: animationFps,
        frames: exportFrames,
        scaleFactor: exportScale,
        scope: exportScope,
      });
      setExportStatus(
        result.mode === "directory"
          ? `Saved ${result.files.length} file${
              result.files.length === 1 ? "" : "s"
            } to ${result.directoryPath}.`
          : `Downloaded ${result.files.length} file${
              result.files.length === 1 ? "" : "s"
            }.`
      );
    } catch (error: unknown) {
      setExportStatus(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsExporting(false);
    }
  };

  const toggleExportFrameExcluded = (frameId: string) => {
    setExcludedExportFrameIds((current) =>
      current.includes(frameId)
        ? current.filter((item) => item !== frameId)
        : [...current, frameId]
    );
  };

  const getMagicWandMask = (cell: Cell) => {
    const grid = readGrid();
    const targetColor = grid[cellIndex(cell.x, cell.y)];
    const mask = createEmptyMask();
    const queue = [cell];
    const visited = createEmptyMask();
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      const index = cellIndex(current.x, current.y);
      if (visited[index] || grid[index] !== targetColor) {
        continue;
      }
      visited[index] = true;
      mask[index] = true;
      for (const next of [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]) {
        if (next.x >= 0 && next.x < width && next.y >= 0 && next.y < height) {
          queue.push(next);
        }
      }
    }
    return mask;
  };

  const getActiveSelectionMask = (bounds: Bounds) =>
    selectionMaskRef.current.some(Boolean)
      ? selectionMaskRef.current
      : getBoxMask(bounds);

  const getMaskLayerAtCell = (cell: Cell) => {
    const index = cellIndex(cell.x, cell.y);
    const orderedLayers = [
      ...maskLayers.filter((layer) => layer.id === activeMaskLayerId),
      ...maskLayers.filter((layer) => layer.id !== activeMaskLayerId),
    ];
    return orderedLayers.find((layer) => layer.visible && layer.mask[index]);
  };

  const drawGridToCanvas = (
    target: HTMLCanvasElement | null,
    grid: CellColor[]
  ) => {
    const context = target?.getContext("2d");
    if (!context) {
      return;
    }
    context.clearRect(0, 0, width * scale, height * scale);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cellColor = grid[cellIndex(x, y)];
        if (cellColor) {
          context.fillStyle = cellColor;
          context.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }
  };

  const beginTransformPreview = (grid: CellColor[], mask: boolean[]) => {
    const baseGrid = [...grid];
    const selectedGrid: CellColor[] = Array.from(
      { length: width * height },
      () => null
    );
    for (let index = 0; index < mask.length; index += 1) {
      if (mask[index]) {
        selectedGrid[index] = grid[index];
        baseGrid[index] = null;
      }
    }
    drawGridToCanvas(canvasRef.current, baseGrid);
    drawGridToCanvas(transformCanvasRef.current, selectedGrid);
  };

  const clearTransformPreview = () => {
    drawGridToCanvas(
      transformCanvasRef.current,
      Array.from({ length: width * height }, () => null)
    );
  };

  const getGridBounds = (grid: CellColor[]): Bounds | null => {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (grid[cellIndex(x, y)]) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return maxX === -1
      ? null
      : {
          height: maxY - minY + 1,
          width: maxX - minX + 1,
          x: minX,
          y: minY,
        };
  };

  const getTransformMaskTarget = (cell: Cell): TransformMaskTarget | null => {
    const layer = getMaskLayerAtCell(cell);
    const layerIds = layer ? getMaskLayerFamilyIds(layer.id, maskLayers) : [];
    const layerMask = layer
      ? combineMaskLayers(layerIds, maskLayers)
      : createEmptyMask();
    const layerBounds = layer ? getMaskBounds(layerMask) : null;
    if (layer && layerBounds) {
      activeTransformMaskLayerIdRef.current = layer.id;
      setActiveMaskLayerId(layer.id);
      applySelectionMask([...layerMask]);
      return {
        bounds: layerBounds,
        isExplicitSelection: true,
        mask: [...layerMask],
        maskLayerId: layer.id,
        maskLayerIds: layerIds,
      };
    }
    if (hasActiveSelection() && selectionBounds) {
      activeTransformMaskLayerIdRef.current = null;
      return {
        bounds: selectionBounds,
        isExplicitSelection: true,
        mask: selectionMaskRef.current,
      };
    }
    const gridBounds = getGridBounds(readGrid());
    if (!gridBounds) {
      return null;
    }
    activeTransformMaskLayerIdRef.current = null;
    return {
      bounds: gridBounds,
      isExplicitSelection: false,
      mask: getBoxMask(gridBounds),
    };
  };

  const writeGrid = (grid: CellColor[], mask?: boolean[]) => {
    drawGridToCanvas(canvasRef.current, grid);
    if (mask) {
      applySelectionMask(mask);
      return;
    }
    setSelectionBounds(getGridBounds(grid));
  };

  const restoreGrid = (grid: CellColor[]) => {
    clearTransformPreview();
    artPanRef.current = { x: 0, y: 0 };
    artScaleRef.current = { x: 1, y: 1 };
    artRotationRef.current = 0;
    setArtPan({ x: 0, y: 0 });
    setArtScale({ x: 1, y: 1 });
    setArtRotation(0);
    writeGrid(
      grid,
      hasActiveSelection() ? selectionMaskRef.current : undefined
    );
  };

  const applyCanvasSize = (size: Size) => {
    ({ width } = size);
    ({ height } = size);
    setCanvasSize(size);
    setCanvasElementDimensions();
  };

  const loadFrame = (frame: AnimationFrame) => {
    applyCanvasSize(frame.size);
    clearSelectionState();
    setTransformOrigin({ x: frame.size.width / 2, y: frame.size.height / 2 });
    writeGrid(frame.grid);
  };

  useEffect(() => {
    loadFrameRef.current = loadFrame;
  });

  useEffect(() => {
    const { frameId, runId } = getEditorSessionParams();
    if (!runId || hydrationCompleteRef.current) {
      hydrationCompleteRef.current = true;
      return;
    }
    let cancelled = false;
    isHydratingEditorRef.current = true;
    const loadEditorDocument = async () => {
      try {
        const document = await fetchEditorDocument(runId);
        if (cancelled) {
          return;
        }
        const hydratedFrames = documentFramesToEditorFrames(document);
        const selectedFrame =
          hydratedFrames.find((frame) => frame.id === frameId) ??
          hydratedFrames.find(
            (frame) => frame.id === document.selectedFrameId
          ) ??
          hydratedFrames[0];
        editorDocumentRef.current = document;
        editorRunIdRef.current = runId;
        syncEditorWorkspaceStatus(document);
        setFrames(hydratedFrames);
        setMaskLayers(documentMasksToEditorMasks(document));
        setActiveMaskLayerId(document.activeMaskLayerId ?? "");
        setAnimationFps(
          Math.max(
            minAnimationFps,
            Math.min(maxAnimationFps, document.timeline.fps)
          )
        );
        setSelectedFrameId(selectedFrame?.id ?? "");
        setExportFrameId(selectedFrame?.id ?? "");
        if (selectedFrame) {
          loadFrame(selectedFrame);
        }
        undoStackRef.current = [];
        redoStackRef.current = [];
      } catch (error: unknown) {
        console.error("Failed to load editor document", error);
      } finally {
        if (!cancelled) {
          isHydratingEditorRef.current = false;
          hydrationCompleteRef.current = true;
        }
      }
    };
    void loadEditorDocument();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    setActiveMaskLayerId,
    setExportFrameId,
    setFrames,
    setMaskLayers,
    setSelectedFrameId,
  ]);

  const selectFrame = (frameId: string) => {
    if (frameId === selectedFrameId) {
      return;
    }
    const currentSnapshot = {
      grid: readGrid(),
      size: canvasSize,
    };
    const nextFrame = frames.find((frame) => frame.id === frameId);
    if (!nextFrame) {
      return;
    }
    setFrames((currentFrames) =>
      currentFrames.map((frame) =>
        frame.id === selectedFrameId ? { ...frame, ...currentSnapshot } : frame
      )
    );
    setSelectedFrameId(frameId);
    loadFrame(nextFrame);
  };

  const addFrameAfterSelection = () => {
    const currentSnapshot = {
      grid: readGrid(),
      size: canvasSize,
    };
    const selectedIndex = frames.findIndex(
      (frame) => frame.id === selectedFrameId
    );
    const sourceFrame = frames[selectedIndex] ?? frames[0];
    const sourceGrid =
      sourceFrame.id === selectedFrameId
        ? currentSnapshot.grid
        : sourceFrame.grid;
    const sourceSize =
      sourceFrame.id === selectedFrameId
        ? currentSnapshot.size
        : sourceFrame.size;
    const newFrame = createFrame(sourceSize, [...sourceGrid]);
    const insertIndex = Math.max(0, selectedIndex) + 1;
    setFrames((currentFrames) => {
      const syncedFrames = currentFrames.map((frame) =>
        frame.id === selectedFrameId ? { ...frame, ...currentSnapshot } : frame
      );
      return [
        ...syncedFrames.slice(0, insertIndex),
        newFrame,
        ...syncedFrames.slice(insertIndex),
      ];
    });
    setSelectedFrameId(newFrame.id);
    loadFrame(newFrame);
  };

  const deleteFrame = (frameId: string) => {
    if (frames.length <= 1) {
      return;
    }
    const syncedFrames = getSyncedFrames();
    const deleteIndex = syncedFrames.findIndex((frame) => frame.id === frameId);
    if (deleteIndex === -1) {
      return;
    }
    const nextFrames = syncedFrames.filter((frame) => frame.id !== frameId);
    const fallbackFrame =
      nextFrames[Math.min(deleteIndex, nextFrames.length - 1)] ?? nextFrames[0];
    if (!fallbackFrame) {
      return;
    }
    setFrames(nextFrames);
    if (selectedFrameId === frameId) {
      setSelectedFrameId(fallbackFrame.id);
      setExportFrameId(fallbackFrame.id);
      clearSelectionState();
      clearTransformPreview();
      loadFrame(fallbackFrame);
      undoStackRef.current = [];
      redoStackRef.current = [];
    } else if (exportFrameId === frameId) {
      setExportFrameId(fallbackFrame.id);
    }
    if (nextFrames.length < 2) {
      setIsPlaying(false);
    }
  };

  const createSnapshot = (): CanvasSnapshot => ({
    activeMaskLayerId,
    grid: readGrid(),
    maskLayers: cloneMaskLayers(maskLayers),
    size: canvasSize,
  });

  const pushHistory = () => {
    undoStackRef.current = [...undoStackRef.current, createSnapshot()].slice(
      -historyLimit
    );
    redoStackRef.current = [];
  };

  const deleteSelectedPixels = () => {
    const isExplicitSelection = hasActiveSelection();
    if (
      !(isExplicitSelection || (activeTool === "transform" && selectionBounds))
    ) {
      return;
    }
    const activeMask =
      isExplicitSelection || !selectionBounds
        ? selectionMaskRef.current
        : getBoxMask(selectionBounds);
    pushHistory();
    clearTransformPreview();
    const nextGrid = readGrid().map((cell, index) =>
      activeMask[index] ? null : cell
    );
    const maskLayerIds = getOptionalMaskLayerFamilyIds(
      activeTransformMaskLayerIdRef.current,
      maskLayers
    );
    if (maskLayerIds) {
      const maskLayerIdSet = new Set(maskLayerIds);
      setMaskLayers((currentLayers) =>
        currentLayers.map((layer) =>
          maskLayerIdSet.has(layer.id)
            ? {
                ...layer,
                mask: layer.mask.map((value, index) =>
                  activeMask[index] ? false : value
                ),
              }
            : layer
        )
      );
    }
    writeGrid(nextGrid);
    clearSelection();
    persistCurrentFrame();
  };

  const addMaskLayer = () => {
    pushHistory();
    const nextLayer = createMaskLayer(maskLayers.length);
    setMaskLayers((currentLayers) => [...currentLayers, nextLayer]);
    setActiveMaskLayerId(nextLayer.id);
  };

  const updateMaskLayer = (
    layerId: string,
    update: (layer: MaskLayer) => MaskLayer
  ) => {
    setMaskLayers((currentLayers) =>
      currentLayers.map((layer) =>
        layer.id === layerId ? update(layer) : layer
      )
    );
  };

  const updateMaskLayerAnchor = (layerId: string, anchor: Point) => {
    updateMaskLayer(layerId, (layer) => ({ ...layer, anchor }));
  };

  const startAnchorDrag = (
    layerId: string,
    event: React.PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pushHistory();
    anchorDragLayerIdRef.current = layerId;
    setActiveMaskLayerId(layerId);
  };

  const moveAnchorDrag = (event: React.PointerEvent<HTMLElement>) => {
    const layerId = anchorDragLayerIdRef.current;
    if (!layerId) {
      return false;
    }
    const anchor = pointerToCanvasPoint(event);
    if (anchor) {
      updateMaskLayerAnchor(layerId, anchor);
    }
    return true;
  };

  const stopAnchorDrag = () => {
    anchorDragLayerIdRef.current = null;
  };

  const deleteMaskLayer = (layerId: string) => {
    pushHistory();
    setMaskLayers((currentLayers) => {
      if (currentLayers.length === 1) {
        return currentLayers;
      }
      const nextLayers = currentLayers
        .filter((layer) => layer.id !== layerId)
        .map((layer) =>
          layer.parentId === layerId ? { ...layer, parentId: null } : layer
        );
      if (activeMaskLayerId === layerId) {
        setActiveMaskLayerId(nextLayers[0]?.id ?? "");
      }
      return nextLayers;
    });
  };

  const renameMaskLayer = (layerId: string, name: string) => {
    pushHistory();
    updateMaskLayer(layerId, (layer) => ({ ...layer, name }));
  };

  const setMaskLayerColor = (layerId: string, color: string) => {
    pushHistory();
    updateMaskLayer(layerId, (layer) => ({ ...layer, color }));
  };

  const setMaskLayerParent = (layerId: string, parentId: null | string) => {
    pushHistory();
    updateMaskLayer(layerId, (layer) => ({
      ...layer,
      parentId: wouldCreateMaskParentCycle(layerId, parentId, maskLayers)
        ? null
        : parentId,
    }));
  };

  const centerMaskLayerAnchor = (layerId: string) => {
    const layer = maskLayers.find((item) => item.id === layerId);
    const bounds = layer ? getMaskBounds(layer.mask) : null;
    if (!bounds) {
      return;
    }
    pushHistory();
    updateMaskLayer(layerId, (item) => ({
      ...item,
      anchor: getSelectionCenter(bounds),
    }));
  };

  const toggleMaskLayerVisibility = (layerId: string) => {
    pushHistory();
    updateMaskLayer(layerId, (layer) => ({
      ...layer,
      visible: !layer.visible,
    }));
  };

  const addCurrentColorToPalette = () => {
    const normalizedColor = normalizeHexColor(currentColor);
    setSavedColors((currentColors) =>
      currentColors.includes(normalizedColor)
        ? currentColors
        : [...currentColors, normalizedColor]
    );
  };

  const togglePlayback = () => {
    if (frames.length < 2) {
      return;
    }
    persistCurrentFrame();
    setIsTimelineOpen(true);
    setIsPlaying((current) => !current);
  };

  useEffect(() => {
    togglePlaybackRef.current = togglePlayback;
  });

  const reorderFrame = (frameId: string, targetIndex: number) => {
    setFrames((currentFrames) => {
      const sourceIndex = currentFrames.findIndex(
        (frame) => frame.id === frameId
      );
      if (sourceIndex === -1) {
        return currentFrames;
      }
      const frame = currentFrames[sourceIndex];
      const remainingFrames = currentFrames.filter(
        (item) => item.id !== frameId
      );
      const insertIndex = Math.max(
        0,
        Math.min(targetIndex, remainingFrames.length)
      );
      if (sourceIndex === insertIndex) {
        return currentFrames;
      }
      return [
        ...remainingFrames.slice(0, insertIndex),
        frame,
        ...remainingFrames.slice(insertIndex),
      ];
    });
  };

  useEffect(() => {
    if (!isPlaying || frames.length < 2) {
      return;
    }
    const timer = window.setInterval(() => {
      const currentIndex = frames.findIndex(
        (frame) => frame.id === selectedFrameId
      );
      const nextFrame = frames[(currentIndex + 1) % frames.length] ?? frames[0];
      setSelectedFrameId(nextFrame.id);
      loadFrameRef.current?.(nextFrame);
    }, fpsToFrameDurationMs(animationFps));
    return () => window.clearInterval(timer);
  }, [animationFps, frames, isPlaying, selectedFrameId, setSelectedFrameId]);

  const restoreSnapshot = (snapshot: CanvasSnapshot) => {
    const dimensionChanged =
      snapshot.size.width !== width || snapshot.size.height !== height;
    applyCanvasSize(snapshot.size);
    setMaskLayers(cloneMaskLayers(snapshot.maskLayers));
    setActiveMaskLayerId(
      snapshot.maskLayers.some(
        (layer) => layer.id === snapshot.activeMaskLayerId
      )
        ? snapshot.activeMaskLayerId
        : (snapshot.maskLayers[0]?.id ?? "")
    );
    if (
      dimensionChanged ||
      selectionMaskRef.current.length !== width * height
    ) {
      clearSelectionState();
    }
    restoreGrid(snapshot.grid);
  };

  const undoCanvas = () => {
    const previous = undoStackRef.current.at(-1);
    if (!previous) {
      return;
    }
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, createSnapshot()].slice(
      -historyLimit
    );
    restoreSnapshot(previous);
  };

  const redoCanvas = () => {
    const next = redoStackRef.current.at(-1);
    if (!next) {
      return;
    }
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, createSnapshot()].slice(
      -historyLimit
    );
    restoreSnapshot(next);
  };

  useEffect(() => {
    redoCanvasRef.current = redoCanvas;
    undoCanvasRef.current = undoCanvas;
  });

  const resizeCanvas = (size: Size) => {
    const nextSize = {
      height: clampCanvasDimension(size.height),
      width: clampCanvasDimension(size.width),
    };
    if (nextSize.width === width && nextSize.height === height) {
      return;
    }
    const currentSize = { height, width };
    const currentGrid = readGrid();
    pushHistory();
    applyCanvasSize(nextSize);
    clearSelectionState();
    clearTransformPreview();
    setTransformOrigin({ x: nextSize.width / 2, y: nextSize.height / 2 });
    const nextGrid = resizeGrid(currentGrid, currentSize, nextSize);
    writeGrid(nextGrid);
    setFrames((currentFrames) =>
      currentFrames.map((frame) =>
        frame.id === selectedFrameId
          ? { ...frame, grid: nextGrid, size: nextSize }
          : frame
      )
    );
    setMaskLayers((currentLayers) =>
      currentLayers.map((layer) => ({
        ...layer,
        mask: resizeBooleanMask(layer.mask, currentSize, nextSize),
      }))
    );
  };

  useEffect(() => {
    const isSaveShortcut = (event: KeyboardEvent) =>
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (event.code === "KeyS" || event.key.toLowerCase() === "s");
    const handleCommandShortcut = (event: KeyboardEvent, code: string) => {
      if (code === "KeyZ") {
        event.preventDefault();
        if (event.shiftKey) {
          redoCanvasRef.current?.();
          return true;
        }
        undoCanvasRef.current?.();
        return true;
      }
      return false;
    };
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (isSaveShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        suppressToolShortcutUntilRef.current = Date.now() + 500;
        void (async () => {
          try {
            await saveProjectRef.current?.();
          } catch (error: unknown) {
            console.error("Failed to save editor project", error);
          }
        })();
        return;
      }
      const { code } = event;
      const isCommand = event.metaKey || event.ctrlKey;
      const { target } = event;
      const isEditing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          Boolean(target.closest("input, textarea, select")));
      if (isEditing) {
        return;
      }
      if (
        event.type === "keydown" &&
        isCommand &&
        !event.altKey &&
        !event.shiftKey &&
        code === "KeyD"
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        clearSelection();
        return;
      }
      if (isCommand && handleCommandShortcut(event, code)) {
        suppressToolShortcutUntilRef.current = Date.now() + 500;
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        suppressToolShortcutUntilRef.current = Date.now() + 500;
        return;
      }
      if (Date.now() < suppressToolShortcutUntilRef.current) {
        return;
      }
      if (code === "Space") {
        event.preventDefault();
        togglePlaybackRef.current?.();
        return;
      }
      const shortcutTools: Partial<Record<string, Tool>> = {
        KeyB: "brush",
        KeyE: "eraser",
        KeyG: fillTool,
        KeyI: "picker",
        KeyQ: "shape",
        KeyS: "selection",
        KeyV: "transform",
      };
      const shortcutTool = shortcutTools[code];
      if (shortcutTool) {
        setIsFillMenuOpen(false);
        setIsSelectionMenuOpen(false);
        setIsShapeMenuOpen(false);
        setActiveTool(shortcutTool);
      } else if (code === "KeyC") {
        setIsFillMenuOpen(false);
        setIsColorPanelOpen((current) => !current);
        setIsSelectionMenuOpen(false);
        setIsShapeMenuOpen(false);
      } else if (code === "KeyR") {
        setIsFillMenuOpen(false);
        setIsReferenceMinimized(false);
        setIsReferenceOpen(true);
        setIsSelectionMenuOpen(false);
        setIsShapeMenuOpen(false);
      }
    };
    document.addEventListener("keydown", handleShortcut, { capture: true });
    document.addEventListener("keyup", handleShortcut, { capture: true });
    window.addEventListener("keydown", handleShortcut, { capture: true });
    window.addEventListener("keyup", handleShortcut, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleShortcut, {
        capture: true,
      });
      document.removeEventListener("keyup", handleShortcut, {
        capture: true,
      });
      window.removeEventListener("keydown", handleShortcut, { capture: true });
      window.removeEventListener("keyup", handleShortcut, { capture: true });
    };
  }, [
    fillTool,
    setActiveTool,
    setIsColorPanelOpen,
    setIsFillMenuOpen,
    setIsReferenceMinimized,
    setIsReferenceOpen,
    setIsSelectionMenuOpen,
    setIsShapeMenuOpen,
    clearSelection,
  ]);

  const refreshSelectionBounds = () => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return;
    }
    const image = context.getImageData(0, 0, width * scale, height * scale);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let hasPixel = false;
        for (let py = 0; py < scale && !hasPixel; py += 1) {
          for (let px = 0; px < scale; px += 1) {
            const index = ((y * scale + py) * image.width + x * scale + px) * 4;
            if (image.data[index + 3] > 0) {
              hasPixel = true;
              break;
            }
          }
        }
        if (hasPixel) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    setSelectionBounds(
      maxX === -1
        ? null
        : {
            height: maxY - minY + 1,
            width: maxX - minX + 1,
            x: minX,
            y: minY,
          }
    );
  };

  const paintCell = (
    context: CanvasRenderingContext2D,
    cell: Cell,
    tool: Tool
  ) => {
    if (cell.x < 0 || cell.x >= width || cell.y < 0 || cell.y >= height) {
      return;
    }
    if (
      hasActiveSelection() &&
      !selectionMaskRef.current[cellIndex(cell.x, cell.y)]
    ) {
      return;
    }
    if (tool === "eraser") {
      context.save();
      context.globalAlpha = currentOpacity;
      context.globalCompositeOperation = "destination-out";
      context.fillRect(cell.x * scale, cell.y * scale, scale, scale);
      context.restore();
      return;
    }
    context.save();
    context.globalAlpha = currentOpacity;
    context.fillStyle = currentColor;
    context.fillRect(cell.x * scale, cell.y * scale, scale, scale);
    context.restore();
  };

  const paint = (cell: Cell, tool: Tool) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return;
    }
    const size = tool === "brush" || tool === "eraser" ? brushSize : 1;
    const offset = Math.floor(size / 2);
    for (let y = cell.y - offset; y < cell.y - offset + size; y += 1) {
      for (let x = cell.x - offset; x < cell.x - offset + size; x += 1) {
        paintCell(context, { x, y }, tool);
      }
    }
    if (hasActiveSelection()) {
      setSelectionBounds(getMaskBounds(selectionMaskRef.current));
      scheduleCurrentCanvasDocumentSave(`paint:${tool}`);
      return;
    }
    refreshSelectionBounds();
    scheduleCurrentCanvasDocumentSave(`paint:${tool}`);
  };

  const getDrawableMask = () => readGrid().map(Boolean);

  const getActiveMaskLayer = () =>
    maskLayers.find((layer) => layer.id === activeMaskLayerId) ?? maskLayers[0];

  const getOtherMaskLayersOccupancy = (layerId: string) => {
    const occupiedMask = createEmptyMask();
    for (const layer of maskLayers) {
      if (layer.id === layerId) {
        continue;
      }
      for (let index = 0; index < layer.mask.length; index += 1) {
        occupiedMask[index] ||= layer.mask[index];
      }
    }
    return occupiedMask;
  };

  const applyActiveMaskLayerMask = (nextMask: boolean[]) => {
    updateMaskLayer(activeMaskLayerId, (layer) => ({
      ...layer,
      mask: nextMask,
    }));
  };

  const applyMaskOperation = (
    operationMask: boolean[],
    shouldPaint: boolean,
    baseMask = getActiveMaskLayer()?.mask ?? createEmptyMask()
  ) => {
    const drawableMask = getDrawableMask();
    const nextMask = [...baseMask];
    for (let index = 0; index < operationMask.length; index += 1) {
      if (operationMask[index] && drawableMask[index]) {
        nextMask[index] = shouldPaint;
      }
    }
    applyActiveMaskLayerMask(nextMask);
  };

  const getBrushOperationMask = (cell: Cell) => {
    const operationMask = createEmptyMask();
    const offset = Math.floor(brushSize / 2);
    for (let y = cell.y - offset; y < cell.y - offset + brushSize; y += 1) {
      for (let x = cell.x - offset; x < cell.x - offset + brushSize; x += 1) {
        if (x >= 0 && x < width && y >= 0 && y < height) {
          operationMask[cellIndex(x, y)] = true;
        }
      }
    }
    return operationMask;
  };

  const paintMask = (cell: Cell, tool: Tool) => {
    const shouldPaint = tool !== "eraser";
    applyMaskOperation(getBrushOperationMask(cell), shouldPaint);
  };

  const paintMaskLine = (from: Cell, to: Cell, tool: Tool) => {
    const operationMask = createEmptyMask();
    for (const cell of interpolate(from, to)) {
      const brushMask = getBrushOperationMask(cell);
      for (let index = 0; index < brushMask.length; index += 1) {
        operationMask[index] ||= brushMask[index];
      }
    }
    applyMaskOperation(operationMask, tool !== "eraser");
    lineAnchorRef.current = to;
  };

  const fillMaskBucket = (cell: Cell) => {
    const drawableMask = getDrawableMask();
    const startIndex = cellIndex(cell.x, cell.y);
    if (!drawableMask[startIndex]) {
      return;
    }
    const activeLayer = getActiveMaskLayer();
    if (!activeLayer) {
      return;
    }
    const otherLayersOccupancy = getOtherMaskLayersOccupancy(activeLayer.id);
    if (otherLayersOccupancy[startIndex]) {
      return;
    }
    const targetValue = activeLayer.mask[startIndex];
    const operationMask = createEmptyMask();
    const visited = createEmptyMask();
    const queue = [cell];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      const index = cellIndex(current.x, current.y);
      if (
        visited[index] ||
        !drawableMask[index] ||
        otherLayersOccupancy[index] ||
        activeLayer.mask[index] !== targetValue
      ) {
        continue;
      }
      visited[index] = true;
      operationMask[index] = true;
      for (const next of [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]) {
        if (next.x >= 0 && next.x < width && next.y >= 0 && next.y < height) {
          queue.push(next);
        }
      }
    }
    applyMaskOperation(operationMask, true, activeLayer.mask);
  };

  const applyMaskShape = (
    startCell: Cell,
    endCell: Cell,
    baseMask: boolean[]
  ) => {
    applyMaskOperation(
      getShapeMask(startCell, endCell, shapeTool, shapeMode, shapeRadius),
      true,
      baseMask
    );
  };

  const paintLine = (from: Cell, to: Cell, tool: Tool) => {
    for (const item of interpolate(from, to)) {
      paint(item, tool);
    }
    lineAnchorRef.current = to;
  };

  const pick = (cell: Cell) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return;
    }
    const [red, green, blue, alpha] = context.getImageData(
      cell.x * scale,
      cell.y * scale,
      1,
      1
    ).data;
    if (alpha === 0) {
      return;
    }
    setCurrentColor(
      `#${[red, green, blue]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")}`
    );
  };

  const fillBucket = (cell: Cell) => {
    const activeSelection = hasActiveSelection();
    const activeMask = selectionMaskRef.current;
    if (activeSelection && !activeMask[cellIndex(cell.x, cell.y)]) {
      return;
    }
    const grid = readGrid();
    const targetColor = grid[cellIndex(cell.x, cell.y)];
    const nextGrid = [...grid];
    const visited = createEmptyMask();
    const queue = [cell];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      const index = cellIndex(current.x, current.y);
      if (
        visited[index] ||
        grid[index] !== targetColor ||
        (activeSelection && !activeMask[index])
      ) {
        continue;
      }
      visited[index] = true;
      nextGrid[index] = currentColor;
      for (const next of [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]) {
        if (next.x >= 0 && next.x < width && next.y >= 0 && next.y < height) {
          queue.push(next);
        }
      }
    }
    writeGrid(nextGrid, activeSelection ? activeMask : undefined);
  };

  const applyPixelGradient = (
    startCell: Cell,
    endCell: Cell,
    baseGrid: CellColor[],
    targetMask: boolean[]
  ) => {
    const activeSelection = hasActiveSelection();
    const nextGrid = [...baseGrid];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = cellIndex(x, y);
        if (!targetMask[index]) {
          continue;
        }
        const amount = getGradientAmount(
          { x, y },
          startCell,
          endCell,
          gradientKind
        );
        const threshold = getPatternThreshold(x, y, gradientPattern);
        nextGrid[index] =
          amount >= threshold ? gradientEndColor : gradientStartColor;
      }
    }
    writeGrid(nextGrid, activeSelection ? selectionMaskRef.current : undefined);
  };

  const applyShape = (
    startCell: Cell,
    endCell: Cell,
    baseGrid: CellColor[]
  ) => {
    const activeSelection = hasActiveSelection();
    const activeMask = selectionMaskRef.current;
    const shapeMask = getShapeMask(
      startCell,
      endCell,
      shapeTool,
      shapeMode,
      shapeRadius
    );
    const nextGrid = [...baseGrid];
    for (let index = 0; index < shapeMask.length; index += 1) {
      if (shapeMask[index] && (!activeSelection || activeMask[index])) {
        nextGrid[index] = currentColor;
      }
    }
    writeGrid(nextGrid, activeSelection ? activeMask : undefined);
  };

  const updateDragSelection = (cell: Cell) => {
    const startCell = selectionStartRef.current;
    if (!startCell) {
      return;
    }
    if (selectionMode === "box") {
      applySelectionMask(getBoxMask(getDragBounds(startCell, cell)));
    } else if (selectionMode === "ellipse") {
      applySelectionMask(getEllipseMask(getDragBounds(startCell, cell)));
    } else if (selectionMode === "lasso") {
      const previous = lassoPointsRef.current.at(-1);
      const nextPoints = previous
        ? [...lassoPointsRef.current, ...interpolate(previous, cell)]
        : [cell];
      lassoPointsRef.current = nextPoints;
      applySelectionMask(getPolygonMask(nextPoints));
    }
  };

  const addPolygonPoint = (cell: Cell) => {
    const nextPoints = [...polygonPointsRef.current, cell];
    polygonPointsRef.current = nextPoints;
    applySelectionMask(getPolygonDraftMask(nextPoints));
  };

  const finishPolygonSelection = () => {
    if (polygonPointsRef.current.length < 3) {
      return;
    }
    applySelectionMask(getPolygonMask(polygonPointsRef.current));
    polygonPointsRef.current = [];
  };

  const startMaskEdit = (
    cell: Cell,
    event: React.PointerEvent<HTMLElement>
  ) => {
    if (activeTool === "picker") {
      pick(cell);
      return;
    }
    if (activeTool === "bucket") {
      pushHistory();
      fillMaskBucket(cell);
      lineAnchorRef.current = cell;
      return;
    }
    if (activeTool === "shape") {
      const activeLayer = getActiveMaskLayer();
      if (!activeLayer) {
        return;
      }
      pushHistory();
      maskShapeBaseRef.current = [...activeLayer.mask];
      shapeStartRef.current = cell;
      applyMaskShape(cell, cell, activeLayer.mask);
      return;
    }
    if (activeTool !== "brush" && activeTool !== "eraser") {
      return;
    }
    pushHistory();
    if (event.shiftKey && lineAnchorRef.current) {
      paintMaskLine(lineAnchorRef.current, cell, activeTool);
      return;
    }
    drawingRef.current = true;
    strokeToolRef.current = activeTool;
    lastCellRef.current = cell;
    paintMask(cell, activeTool);
    lineAnchorRef.current = cell;
  };

  const startTransformPointer = (
    event: React.PointerEvent<HTMLElement>,
    cell: Cell
  ) => {
    const hitTarget = getCanvasHitTarget(event);
    hitTargetRef.current = hitTarget;
    if (hitTarget?.kind === "scale-handle") {
      // eslint-disable-next-line no-use-before-define
      startScaleTransform(event, hitTarget.corner);
      return;
    }
    if (hitTarget?.kind === "rotate-handle") {
      // eslint-disable-next-line no-use-before-define
      startRotateTransform(event);
      return;
    }
    if (hitTarget?.kind === "anchor") {
      setTransformOrigin(pointerToCanvasPoint(event) ?? artOriginRef.current);
      return;
    }
    if (hitTarget?.kind === "mask-anchor") {
      pushHistory();
      anchorDragLayerIdRef.current = hitTarget.layerId;
      setActiveMaskLayerId(hitTarget.layerId);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const target = getTransformMaskTarget(cell);
    if (!target) {
      return;
    }
    const grid = readGrid();
    pushHistory();
    beginTransformPreview(grid, target.mask);
    transformTargetRef.current = "selection-move";
    panningRef.current = true;
    transformStartRef.current = {
      angle: 0,
      bounds: target.bounds,
      distance: 0,
      grid,
      isExplicitSelection: target.isExplicitSelection,
      mask: target.mask,
      maskLayerId: target.maskLayerId,
      maskLayerIds: target.maskLayerIds,
      origin: getSelectionCenter(target.bounds),
      pan: artPanRef.current,
      point: {
        x: event.clientX,
        y: event.clientY,
      },
      rotation: artRotationRef.current,
      scale: artScaleRef.current,
    };
    setTransformOrigin(getSelectionCenter(target.bounds));
    lastPanPointRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  };

  const start = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.button === 1) {
      transformTargetRef.current = "viewport";
      panningRef.current = true;
      lastPanPointRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      return;
    }
    if (event.button === 2) {
      if (event.currentTarget instanceof HTMLCanvasElement) {
        pick(pointToCell(event));
      }
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const cell = pointToCell(event);
    if (editorMode === "mask" && activeTool !== "transform") {
      startMaskEdit(cell, event);
      return;
    }
    if (activeTool === "transform") {
      startTransformPointer(event, cell);
      return;
    }
    if (activeTool === "selection") {
      activeTransformMaskLayerIdRef.current = null;
      if (selectionMode === "magic-wand") {
        applySelectionMask(getMagicWandMask(cell));
      } else if (selectionMode === "polygon") {
        addPolygonPoint(cell);
      } else {
        selectingRef.current = true;
        selectionStartRef.current = cell;
        lassoPointsRef.current = [cell];
        updateDragSelection(cell);
      }
      return;
    }
    if (activeTool === "picker") {
      pick(cell);
      return;
    }
    if (activeTool === "bucket") {
      pushHistory();
      fillBucket(cell);
      return;
    }
    if (activeTool === "gradient") {
      pushHistory();
      const baseGrid = readGrid();
      const targetMask = hasActiveSelection()
        ? selectionMaskRef.current
        : getConnectedColorMask(cell, baseGrid);
      gradientStartRef.current = cell;
      gradientBaseGridRef.current = baseGrid;
      gradientMaskRef.current = targetMask;
      applyPixelGradient(cell, cell, baseGrid, targetMask);
      return;
    }
    if (activeTool === "shape") {
      pushHistory();
      const baseGrid = readGrid();
      shapeStartRef.current = cell;
      shapeBaseGridRef.current = baseGrid;
      applyShape(cell, cell, baseGrid);
      return;
    }
    pushHistory();
    if (event.shiftKey && lineAnchorRef.current) {
      paintLine(lineAnchorRef.current, cell, activeTool);
      return;
    }
    drawingRef.current = true;
    strokeToolRef.current = activeTool;
    lastCellRef.current = cell;
    paint(cell, activeTool);
    lineAnchorRef.current = cell;
  };

  const updateSelectionScale = (
    point: Point,
    startTransform: TransformStart
  ) => {
    if (!startTransform.bounds || !startTransform.corner) {
      return;
    }
    const rect = shellRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const cellSize = rect.width / width;
    const deltaX =
      (point.x - startTransform.point.x) / zoomLevelRef.current / cellSize;
    const deltaY =
      (point.y - startTransform.point.y) / zoomLevelRef.current / cellSize;
    const nextWidth = startTransform.corner.includes("e")
      ? startTransform.bounds.width + deltaX
      : startTransform.bounds.width - deltaX;
    const nextHeight = startTransform.corner.includes("s")
      ? startTransform.bounds.height + deltaY
      : startTransform.bounds.height - deltaY;
    const nextScale = {
      x: clampScale(
        startTransform.scale.x * (nextWidth / startTransform.bounds.width),
        1 / startTransform.bounds.width
      ),
      y: clampScale(
        startTransform.scale.y * (nextHeight / startTransform.bounds.height),
        1 / startTransform.bounds.height
      ),
    };
    artScaleRef.current = nextScale;
    setArtScale(nextScale);
  };

  const updateSelectionRotation = (
    point: Point,
    startTransform: TransformStart
  ) => {
    const rect = shellRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const cellSize = rect.width / width;
    const center = {
      x: rect.left + startTransform.origin.x * cellSize,
      y: rect.top + startTransform.origin.y * cellSize,
    };
    const angle = Math.atan2(point.y - center.y, point.x - center.x);
    const nextRotation =
      startTransform.rotation +
      ((angle - startTransform.angle) * 180) / Math.PI;
    artRotationRef.current = nextRotation;
    setArtRotation(nextRotation);
  };

  const updateActivePanOrTransform = (
    point: Point,
    previous: Point,
    startTransform: TransformStart | null
  ) => {
    if (transformTargetRef.current === "selection-move" && startTransform) {
      const cellSize = getCellSize();
      const scaledDeltaX =
        (point.x - startTransform.point.x) / zoomLevelRef.current;
      const scaledDeltaY =
        (point.y - startTransform.point.y) / zoomLevelRef.current;
      const nextPan = {
        x:
          startTransform.pan.x + Math.round(scaledDeltaX / cellSize) * cellSize,
        y:
          startTransform.pan.y + Math.round(scaledDeltaY / cellSize) * cellSize,
      };
      artPanRef.current = nextPan;
      setArtPan(nextPan);
      return;
    }
    if (transformTargetRef.current === "selection-scale" && startTransform) {
      updateSelectionScale(point, startTransform);
      return;
    }
    if (transformTargetRef.current === "selection-rotate" && startTransform) {
      updateSelectionRotation(point, startTransform);
      return;
    }
    setPan((current) => ({
      x: current.x + point.x - previous.x,
      y: current.y + point.y - previous.y,
    }));
  };

  const move = (event: React.PointerEvent<HTMLElement>) => {
    if (moveAnchorDrag(event)) {
      return;
    }
    if (panningRef.current && lastPanPointRef.current) {
      const startTransform = transformStartRef.current;
      const previous = lastPanPointRef.current;
      const point = {
        x: event.clientX,
        y: event.clientY,
      };
      updateActivePanOrTransform(point, previous, startTransform);
      lastPanPointRef.current = point;
      return;
    }
    if (selectingRef.current) {
      updateDragSelection(pointToCell(event));
      return;
    }
    if (
      gradientStartRef.current &&
      gradientBaseGridRef.current &&
      gradientMaskRef.current
    ) {
      applyPixelGradient(
        gradientStartRef.current,
        pointToCell(event),
        gradientBaseGridRef.current,
        gradientMaskRef.current
      );
      return;
    }
    if (shapeStartRef.current && maskShapeBaseRef.current) {
      applyMaskShape(
        shapeStartRef.current,
        pointToCell(event),
        maskShapeBaseRef.current
      );
      return;
    }
    if (shapeStartRef.current && shapeBaseGridRef.current) {
      applyShape(
        shapeStartRef.current,
        pointToCell(event),
        shapeBaseGridRef.current
      );
      return;
    }
    if (!drawingRef.current || !lastCellRef.current) {
      updateCanvasCursor(event);
      return;
    }
    const cell = pointToCell(event);
    const strokeTool = strokeToolRef.current;
    if (!strokeTool) {
      return;
    }
    for (const item of interpolate(lastCellRef.current, cell)) {
      if (editorMode === "mask") {
        paintMask(item, strokeTool);
      } else {
        paint(item, strokeTool);
      }
    }
    lastCellRef.current = cell;
    lineAnchorRef.current = cell;
  };

  const shouldSaveOnStop = () => {
    if (
      editorRunIdRef.current !== null &&
      editorMode === "edit" &&
      activeTool !== "picker" &&
      activeTool !== "selection"
    ) {
      return true;
    }
    return (
      drawingRef.current ||
      Boolean(transformStartRef.current) ||
      selectingRef.current ||
      Boolean(gradientBaseGridRef.current) ||
      Boolean(maskShapeBaseRef.current) ||
      Boolean(shapeBaseGridRef.current) ||
      Boolean(anchorDragLayerIdRef.current)
    );
  };

  const stop = () => {
    const shouldSaveEditorDocument = shouldSaveOnStop();
    const transformStart = transformStartRef.current;
    if (
      (transformTargetRef.current === "selection-move" ||
        transformTargetRef.current === "selection-scale" ||
        transformTargetRef.current === "selection-rotate") &&
      transformStart?.bounds &&
      transformStart.grid &&
      transformStart.mask
    ) {
      const cellSize = getCellSize();
      const translation = {
        x: artPanRef.current.x / cellSize,
        y: artPanRef.current.y / cellSize,
      };
      const result = transformSelectionGrid(
        transformStart.grid,
        transformStart.bounds,
        transformStart.mask,
        artScaleRef.current,
        artRotationRef.current,
        transformStart.origin,
        translation
      );
      if (transformStart.maskLayerId) {
        const transformBounds = transformStart.bounds;
        const transformedLayerIds = transformStart.maskLayerIds ?? [
          transformStart.maskLayerId,
        ];
        const transformedLayerIdSet = new Set(transformedLayerIds);
        setMaskLayers((currentLayers) =>
          currentLayers.map((layer) =>
            transformedLayerIdSet.has(layer.id)
              ? {
                  ...layer,
                  anchor: transformSelectionPoint(
                    layer.anchor,
                    artScaleRef.current,
                    artRotationRef.current,
                    transformStart.origin,
                    translation
                  ),
                  mask: transformSelectionMask(
                    transformBounds,
                    layer.mask,
                    artScaleRef.current,
                    artRotationRef.current,
                    transformStart.origin,
                    translation
                  ),
                }
              : layer
          )
        );
        activeTransformMaskLayerIdRef.current = null;
        writeGrid(result.grid, result.mask);
      } else if (transformStart.isExplicitSelection) {
        writeGrid(result.grid, result.mask);
      } else {
        const emptyMask = createEmptyMask();
        activeTransformMaskLayerIdRef.current = null;
        selectionMaskRef.current = emptyMask;
        setSelectionMask(emptyMask);
        writeGrid(result.grid);
      }
      clearTransformPreview();
      artPanRef.current = { x: 0, y: 0 };
      artScaleRef.current = { x: 1, y: 1 };
      artRotationRef.current = 0;
      setArtPan({ x: 0, y: 0 });
      setArtScale({ x: 1, y: 1 });
      setArtRotation(0);
    }
    selectingRef.current = false;
    if (selectionMode === "lasso" && lassoPointsRef.current.length >= 3) {
      applySelectionMask(getPolygonMask(lassoPointsRef.current));
    }
    selectionStartRef.current = null;
    lassoPointsRef.current = [];
    drawingRef.current = false;
    panningRef.current = false;
    lastCellRef.current = null;
    lastPanPointRef.current = null;
    gradientBaseGridRef.current = null;
    gradientMaskRef.current = null;
    gradientStartRef.current = null;
    maskShapeBaseRef.current = null;
    shapeBaseGridRef.current = null;
    shapeStartRef.current = null;
    strokeToolRef.current = null;
    stopAnchorDrag();
    transformTargetRef.current = "viewport";
    transformStartRef.current = null;
    const syncedFrames = getSyncedFrames();
    const debugFrame =
      syncedFrames.find((frame) => frame.id === selectedFrameId) ??
      syncedFrames[0];
    if (debugFrame) {
      recordEditorDebugEvent({
        activeTool,
        frameId: debugFrame.id,
        nonempty: debugFrame.grid.filter(Boolean).length,
        reason: shouldSaveEditorDocument ? "stop:will-save" : "stop:no-save",
        revision: editorDocumentRef.current?.saveState.revision ?? null,
        timestamp: new Date().toISOString(),
      });
    }
    setFrames(syncedFrames);
    if (shouldSaveEditorDocument) {
      scheduleEditorDocumentSave(syncedFrames, "stop");
    }
  };

  const startScaleTransform = (
    event: React.PointerEvent<HTMLElement>,
    corner: Corner
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectionBounds) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const grid = readGrid();
    const isExplicitSelection = hasActiveSelection();
    const mask = getActiveSelectionMask(selectionBounds);
    pushHistory();
    beginTransformPreview(grid, mask);
    panningRef.current = true;
    transformTargetRef.current = "selection-scale";
    lastPanPointRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
    const origin = getScaleOrigin(selectionBounds, corner);
    setTransformOrigin(origin);
    transformStartRef.current = {
      angle: 0,
      bounds: selectionBounds,
      corner,
      distance: 0,
      grid,
      isExplicitSelection,
      mask,
      maskLayerId: activeTransformMaskLayerIdRef.current ?? undefined,
      maskLayerIds: getOptionalMaskLayerFamilyIds(
        activeTransformMaskLayerIdRef.current,
        maskLayers
      ),
      origin,
      pan: artPanRef.current,
      point: {
        x: event.clientX,
        y: event.clientY,
      },
      rotation: artRotationRef.current,
      scale: artScaleRef.current,
    };
  };

  const startRotateTransform = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const shell = shellRef.current;
    if (!shell || !selectionBounds) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const grid = readGrid();
    const isExplicitSelection = hasActiveSelection();
    const mask = getActiveSelectionMask(selectionBounds);
    pushHistory();
    beginTransformPreview(grid, mask);
    const rect = shell.getBoundingClientRect();
    const cellSize = rect.width / width;
    const origin = getSelectionCenter(selectionBounds);
    const center = {
      x: rect.left + origin.x * cellSize,
      y: rect.top + origin.y * cellSize,
    };
    setTransformOrigin(origin);
    panningRef.current = true;
    transformTargetRef.current = "selection-rotate";
    lastPanPointRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
    transformStartRef.current = {
      angle: Math.atan2(event.clientY - center.y, event.clientX - center.x),
      bounds: selectionBounds,
      distance: 0,
      grid,
      isExplicitSelection,
      mask,
      maskLayerId: activeTransformMaskLayerIdRef.current ?? undefined,
      maskLayerIds: getOptionalMaskLayerFamilyIds(
        activeTransformMaskLayerIdRef.current,
        maskLayers
      ),
      origin,
      pan: artPanRef.current,
      point: {
        x: event.clientX,
        y: event.clientY,
      },
      rotation: artRotationRef.current,
      scale: artScaleRef.current,
    };
  };

  const hasSelection = selectionMask.some(Boolean);
  const showSelection = activeTool === "transform" && selectionBounds;
  const canDeleteSelection = canDeleteActiveTarget(
    activeTool,
    hasSelection,
    selectionBounds
  );
  const transformingMaskLayerId = activeTransformMaskLayerIdRef.current;
  const showSelectionMask = hasSelection && editorMode === "edit";
  const anchorPosition = selectionBounds ? artOrigin : null;
  const visibleMaskLayers = getMaskOverlayLayers(
    editorMode,
    maskLayers,
    getMaskLayerFamilyIdsOrEmpty(transformingMaskLayerId, maskLayers)
  );
  const transformingMaskLayerIds = getMaskLayerFamilyIdsOrEmpty(
    transformingMaskLayerId,
    maskLayers
  );
  const transformingMaskLayerSet = new Set(transformingMaskLayerIds);
  const transformMaskOverlayLayers =
    showSelection && transformingMaskLayerId
      ? maskLayers.filter((layer) => transformingMaskLayerSet.has(layer.id))
      : [];
  const hoverCorner =
    hoverHitTarget && "corner" in hoverHitTarget ? hoverHitTarget.corner : null;
  const magneticPoint = hoverHitTarget
    ? magneticPointForHitTarget(hoverHitTarget, {
        anchor: selectionBounds ? artOrigin : null,
        maskAnchors:
          editorMode === "mask"
            ? maskLayers
                .filter((layer) => layer.visible)
                .map((layer) => ({ layerId: layer.id, point: layer.anchor }))
            : [],
        selectionBounds,
      })
    : null;

  return (
    <>
      <button
        aria-label="Export"
        className="export-open-button"
        type="button"
        onClick={openExportDialog}
      >
        <Download aria-hidden="true" />
        <span>Export</span>
      </button>
      <CanvasSizeControl size={canvasSize} onResize={resizeCanvas} />
      <EditorModeTabs mode={editorMode} onModeChange={setEditorMode} />
      {editorWorkspaceStatus.runId ? (
        <div className="editor-workspace-status">
          <span
            aria-hidden="true"
            className={
              editorWorkspaceStatus.dirty
                ? "editor-workspace-status-dot dirty"
                : "editor-workspace-status-dot"
            }
          />
          <span>{editorWorkspaceStatus.runId}</span>
          <span>{editorWorkspaceStatus.selectedFrameId ?? "no frame"}</span>
          <span>r{editorWorkspaceStatus.revision ?? 0}</span>
          <span>{editorWorkspaceStatus.dirty ? "dirty" : "saved"}</span>
        </div>
      ) : null}
      <BrushSizePanel
        size={brushSize}
        tool={activeTool}
        onSizeChange={setBrushSize}
      />
      <Timeline
        fps={animationFps}
        frames={frames}
        isOpen={isTimelineOpen}
        isPlaying={isPlaying}
        selectedFrameId={selectedFrameId}
        onAddFrame={addFrameAfterSelection}
        onDeleteFrame={deleteFrame}
        onFpsChange={setAnimationFps}
        onReorderFrame={reorderFrame}
        onSelectFrame={selectFrame}
        onTogglePlayback={togglePlayback}
        onToggle={() => setIsTimelineOpen((current) => !current)}
      />
      <ExportDialog
        directoryPath={exportDirectoryPath}
        excludedFrameIds={excludedExportFrameIds}
        fps={animationFps}
        format={exportFormat}
        frames={getExportDialogFrames(exportPreviewFrames, frames)}
        isExporting={isExporting}
        isOpen={isExportOpen}
        scale={exportScale}
        scope={exportScope}
        selectedFrameId={exportFrameId}
        status={exportStatus}
        onClose={() => setIsExportOpen(false)}
        onDirectoryPathChange={setExportDirectoryPath}
        onExport={requestExport}
        onFormatChange={setExportFormat}
        onScaleChange={setExportScale}
        onScopeChange={setExportScope}
        onSelectFrame={setExportFrameId}
        onToggleFrameExcluded={toggleExportFrameExcluded}
      />
      <ColorPanel
        color={currentColor}
        isOpen={isColorPanelOpen}
        opacity={currentOpacity}
        savedColors={savedColors}
        onAddSavedColor={addCurrentColorToPalette}
        onChange={setCurrentColor}
        onClose={() => setIsColorPanelOpen(false)}
        onOpacityChange={setCurrentOpacity}
      />
      <FloatingPanels
        activeTool={activeTool}
        canDeleteSelection={canDeleteSelection}
        gradientEndColor={gradientEndColor}
        gradientKind={gradientKind}
        gradientPattern={gradientPattern}
        gradientStartColor={gradientStartColor}
        hasSelection={hasSelection}
        isReferenceMinimized={isReferenceMinimized}
        isReferenceOpen={isReferenceOpen}
        shapeMode={shapeMode}
        shapeRadius={shapeRadius}
        shapeTool={shapeTool}
        onClearSelection={clearSelection}
        onDeleteSelection={deleteSelectedPixels}
        onGradientEndColorChange={setGradientEndColor}
        onGradientKindChange={setGradientKind}
        onGradientPatternChange={setGradientPattern}
        onGradientStartColorChange={setGradientStartColor}
        onReferenceClose={() => setIsReferenceOpen(false)}
        onReferenceMinimize={() =>
          setIsReferenceMinimized((current) => !current)
        }
        onReferencePickColor={setCurrentColor}
        onShapeModeChange={setShapeMode}
        onShapeRadiusChange={setShapeRadius}
      />
      <MaskLayersPanel
        activeLayerId={activeMaskLayerId}
        isVisible={editorMode === "mask"}
        layers={maskLayers}
        onAddLayer={addMaskLayer}
        onCenterAnchor={centerMaskLayerAnchor}
        onDeleteLayer={deleteMaskLayer}
        onParentChange={setMaskLayerParent}
        onRenameLayer={renameMaskLayer}
        onSelectLayer={setActiveMaskLayerId}
        onSetLayerColor={setMaskLayerColor}
        onToggleLayerVisibility={toggleMaskLayerVisibility}
      />
      <div
        ref={shellRef}
        className="canvas-shell"
        data-hit-corner={hoverCorner ?? undefined}
        data-hit-kind={hoverHitTarget?.kind}
        style={
          {
            "--canvas-aspect": canvasSize.width / canvasSize.height,
            "--canvas-height": canvasSize.height,
            "--canvas-width": canvasSize.width,
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoomLevel})`,
          } as CSSProperties
        }
      >
        <canvas
          ref={canvasRef}
          aria-label="Pixel canvas"
          data-mode={editorMode}
          data-tool={activeTool}
          onAuxClick={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
          onDoubleClick={finishPolygonSelection}
          onPointerCancel={stop}
          onPointerDown={start}
          onPointerLeave={stop}
          onPointerMove={move}
          onPointerUp={stop}
        />
        <div
          className="art-layer"
          style={{
            transform: `translate3d(${artPan.x}px, ${artPan.y}px, 0) rotate(${artRotation}deg) scale(${artScale.x}, ${artScale.y})`,
            transformOrigin: `${(artOrigin.x / width) * 100}% ${
              (artOrigin.y / height) * 100
            }%`,
          }}
        >
          <canvas
            ref={transformCanvasRef}
            aria-hidden="true"
            className="transform-canvas"
          />
          <MaskOverlay
            activeLayerId={activeMaskLayerId}
            layers={transformMaskOverlayLayers}
            size={canvasSize}
          />
          <MaskAnchorsOverlay
            activeLayerId={activeMaskLayerId}
            layers={transformMaskOverlayLayers}
            size={canvasSize}
            onMoveAnchorDrag={moveAnchorDrag}
            onStartAnchorDrag={startAnchorDrag}
            onStopAnchorDrag={stopAnchorDrag}
          />
          <SelectionMaskOverlay
            isVisible={showSelectionMask}
            mask={selectionMask}
            size={canvasSize}
          />
          {showSelection ? (
            <div
              className="selection-box"
              style={{
                height: `${(selectionBounds.height / height) * 100}%`,
                left: `${(selectionBounds.x / width) * 100}%`,
                top: `${(selectionBounds.y / height) * 100}%`,
                width: `${(selectionBounds.width / width) * 100}%`,
              }}
              onPointerCancel={stop}
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={stop}
            >
              {(["nw", "ne", "sw", "se"] as Corner[]).map((corner) => (
                <button
                  aria-label={`Scale ${corner}`}
                  className={[
                    "selection-handle",
                    corner,
                    hoverHitTarget?.kind === "scale-handle" &&
                    hoverHitTarget.corner === corner
                      ? "magnetic"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={`scale-${corner}`}
                  type="button"
                  onPointerCancel={stop}
                  onPointerDown={(event) => startScaleTransform(event, corner)}
                  onPointerMove={move}
                  onPointerUp={stop}
                />
              ))}
              {(["nw", "ne", "sw", "se"] as Corner[]).map((corner) => (
                <button
                  aria-label={`Rotate ${corner}`}
                  className={[
                    "rotate-handle",
                    corner,
                    hoverHitTarget?.kind === "rotate-handle" &&
                    hoverHitTarget.corner === corner
                      ? "magnetic"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={`rotate-${corner}`}
                  type="button"
                  onPointerCancel={stop}
                  onPointerDown={startRotateTransform}
                  onPointerMove={move}
                  onPointerUp={stop}
                />
              ))}
            </div>
          ) : null}
        </div>
        <MaskOverlay
          activeLayerId={activeMaskLayerId}
          layers={visibleMaskLayers}
          size={canvasSize}
        />
        <MaskAnchorsOverlay
          activeLayerId={activeMaskLayerId}
          layers={visibleMaskLayers}
          size={canvasSize}
          onMoveAnchorDrag={moveAnchorDrag}
          onStartAnchorDrag={startAnchorDrag}
          onStopAnchorDrag={stopAnchorDrag}
        />
        {showSelection && anchorPosition ? (
          <div
            aria-hidden="true"
            className={
              hoverHitTarget?.kind === "anchor"
                ? "selection-anchor magnetic"
                : "selection-anchor"
            }
            style={{
              left: `${(anchorPosition.x / width) * 100}%`,
              top: `${(anchorPosition.y / height) * 100}%`,
              transform: `translate3d(${artPan.x}px, ${artPan.y}px, 0) translate(-50%, -50%)`,
            }}
          />
        ) : null}
        {magneticPoint ? (
          <span
            aria-hidden="true"
            className="magnetic-target"
            style={{
              left: `${(magneticPoint.x / width) * 100}%`,
              top: `${(magneticPoint.y / height) * 100}%`,
            }}
          />
        ) : null}
        {isGridVisible ? <div className="pixel-grid" /> : null}
      </div>
      <Toolbar
        activeTool={activeTool}
        currentColor={currentColor}
        fillTool={fillTool}
        isFillMenuOpen={isFillMenuOpen}
        isGridVisible={isGridVisible}
        isReferenceOpen={isReferenceOpen}
        isSelectionMenuOpen={isSelectionMenuOpen}
        isShapeMenuOpen={isShapeMenuOpen}
        selectionBounds={selectionBounds}
        selectionMode={selectionMode}
        shapeTool={shapeTool}
        onColorToggle={() => {
          setIsFillMenuOpen(false);
          setIsColorPanelOpen((current) => !current);
          setIsSelectionMenuOpen(false);
          setIsShapeMenuOpen(false);
        }}
        onFillMenuToggle={() => {
          setIsSelectionMenuOpen(false);
          setIsShapeMenuOpen(false);
          setIsFillMenuOpen((current) => !current);
        }}
        onGridToggle={() => {
          setIsFillMenuOpen(false);
          setIsSelectionMenuOpen(false);
          setIsShapeMenuOpen(false);
          setIsGridVisible((current) => !current);
        }}
        onReferenceToggle={() => {
          setIsFillMenuOpen(false);
          setIsReferenceMinimized(false);
          setIsReferenceOpen((current) => !current);
          setIsSelectionMenuOpen(false);
          setIsShapeMenuOpen(false);
        }}
        onSelectionMenuToggle={() => {
          setIsFillMenuOpen(false);
          setIsShapeMenuOpen(false);
          setIsSelectionMenuOpen((current) => !current);
        }}
        onSetActiveTool={setActiveTool}
        onSetFillTool={setFillTool}
        onSetSelectionMode={setSelectionMode}
        onSetShapeTool={setShapeTool}
        onSetTransformOriginToSelection={() => {
          if (selectionBounds) {
            setTransformOrigin(getSelectionCenter(selectionBounds));
          }
        }}
        onShapeMenuToggle={() => {
          setIsFillMenuOpen(false);
          setIsSelectionMenuOpen(false);
          setIsShapeMenuOpen((current) => !current);
        }}
        onToolMenusClose={() => {
          setIsFillMenuOpen(false);
          setIsSelectionMenuOpen(false);
          setIsShapeMenuOpen(false);
        }}
      />
    </>
  );
};
