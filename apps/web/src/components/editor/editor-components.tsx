import {
  Blend,
  Brush,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDashed,
  Download,
  Eraser,
  Grid3X3,
  Image as ImageIcon,
  Lasso,
  Minus,
  MousePointer2,
  PaintBucket,
  Palette,
  Pause,
  Pentagon,
  Pipette,
  Play,
  Plus,
  RectangleHorizontal,
  Slash,
  SquareDashed,
  Triangle,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import type { CSSProperties, WheelEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  hexToHsvColor,
  hsvToHexColor,
  isHexColor,
  normalizeHexColor,
  rgbToHex,
} from "@/editor/color";
import {
  exportScales,
  fpsToFrameDurationMs,
  gradientKinds,
  gradientPatterns,
  maxBrushSize,
  maxAnimationFps,
  maxCanvasDimension,
  minAnimationFps,
  minBrushSize,
  minCanvasDimension,
} from "@/editor/constants";
import { drawFramePixels } from "@/editor/export/canvas";
import {
  clamp,
  clampBrushSize,
  clampCanvasDimension,
  clampZoom,
} from "@/editor/grid";
import { hitTestZones } from "@/editor/hit-testing";
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
  PaletteEntry,
  Point,
  SelectionMode,
  ShapeMode,
  ShapeTool,
  Size,
  Tool,
  ToolGroupOption,
} from "@/editor/types";

interface ToolGroupProps<T extends string> {
  active: boolean;
  isOpen: boolean;
  label: string;
  options: readonly ToolGroupOption<T>[];
  selectedOption: ToolGroupOption<T>;
  selectedValue: T;
  shortcut: string;
  onContextToggle: () => void;
  onPrimaryClick: () => void;
  onSelect: (value: T) => void;
}

interface GradientOptionsBarProps {
  gradientEndColor: string;
  gradientKind: GradientKind;
  gradientPattern: GradientPattern;
  gradientStartColor: string;
  onGradientEndColorChange: (color: string) => void;
  onGradientKindChange: (kind: GradientKind) => void;
  onGradientPatternChange: (pattern: GradientPattern) => void;
  onGradientStartColorChange: (color: string) => void;
}

interface ReferencePanelProps {
  isMinimized: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onPickColor: (color: string) => void;
}

interface ShapeOptionsBarProps {
  shapeMode: ShapeMode;
  shapeRadius: number;
  shapeTool: ShapeTool;
  onShapeModeChange: (mode: ShapeMode) => void;
  onShapeRadiusChange: (radius: number) => void;
}

interface FloatingPanelsProps {
  activeTool: Tool;
  gradientEndColor: string;
  gradientKind: GradientKind;
  gradientPattern: GradientPattern;
  gradientStartColor: string;
  canDeleteSelection: boolean;
  hasSelection: boolean;
  isReferenceMinimized: boolean;
  isReferenceOpen: boolean;
  shapeMode: ShapeMode;
  shapeRadius: number;
  shapeTool: ShapeTool;
  onClearSelection: () => void;
  onDeleteSelection: () => void;
  onGradientEndColorChange: (color: string) => void;
  onGradientKindChange: (kind: GradientKind) => void;
  onGradientPatternChange: (pattern: GradientPattern) => void;
  onGradientStartColorChange: (color: string) => void;
  onReferenceClose: () => void;
  onReferenceMinimize: () => void;
  onReferencePickColor: (color: string) => void;
  onShapeModeChange: (mode: ShapeMode) => void;
  onShapeRadiusChange: (radius: number) => void;
}

interface CanvasSizeControlProps {
  size: Size;
  onResize: (size: Size) => void;
}

interface EditorModeTabsProps {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
}

interface BrushSizeControlProps {
  size: number;
  tool: "brush" | "eraser";
  onSizeChange: (size: number) => void;
}

interface BrushSizePanelProps {
  size: number;
  tool: Tool;
  onSizeChange: (size: number) => void;
}

interface ColorPanelProps {
  color: string;
  isOpen: boolean;
  opacity: number;
  savedColors: string[];
  onAddSavedColor: () => void;
  onChange: (color: string) => void;
  onClose: () => void;
  onOpacityChange: (opacity: number) => void;
}

interface MaskLayersPanelProps {
  activeLayerId: string;
  isVisible: boolean;
  layers: MaskLayer[];
  onAddLayer: () => void;
  onCenterAnchor: (layerId: string) => void;
  onDeleteLayer: (layerId: string) => void;
  onParentChange: (layerId: string, parentId: null | string) => void;
  onRenameLayer: (layerId: string, name: string) => void;
  onSelectLayer: (layerId: string) => void;
  onSetLayerColor: (layerId: string, color: string) => void;
  onToggleLayerVisibility: (layerId: string) => void;
}

interface MaskOverlayProps {
  activeLayerId: string;
  layers: MaskLayer[];
  size: Size;
}

interface SelectionMaskOverlayProps {
  isVisible: boolean;
  mask: boolean[];
  size: Size;
}

interface MaskAnchorsOverlayProps {
  activeLayerId: string;
  layers: MaskLayer[];
  size: Size;
  onMoveAnchorDrag: (event: React.PointerEvent<HTMLElement>) => boolean;
  onStartAnchorDrag: (
    layerId: string,
    event: React.PointerEvent<HTMLButtonElement>
  ) => void;
  onStopAnchorDrag: () => void;
}

interface TimelineProps {
  fps: number;
  frames: AnimationFrame[];
  isOpen: boolean;
  isPlaying: boolean;
  selectedFrameId: string;
  onAddFrame: () => void;
  onDeleteFrame: (frameId: string) => void;
  onFpsChange: (fps: number) => void;
  onReorderFrame: (frameId: string, targetIndex: number) => void;
  onSelectFrame: (frameId: string) => void;
  onTogglePlayback: () => void;
  onToggle: () => void;
}

interface FrameThumbnailProps {
  frame: AnimationFrame;
}

interface ExportDialogProps {
  directoryPath: string;
  excludedFrameIds: string[];
  fps: number;
  format: ExportFormat;
  frames: AnimationFrame[];
  isOpen: boolean;
  isExporting: boolean;
  scale: number;
  scope: ExportScope;
  selectedFrameId: string;
  status: string;
  onClose: () => void;
  onDirectoryPathChange: (path: string) => void;
  onExport: () => void;
  onFormatChange: (format: ExportFormat) => void;
  onScaleChange: (scale: number) => void;
  onScopeChange: (scope: ExportScope) => void;
  onSelectFrame: (frameId: string) => void;
  onToggleFrameExcluded: (frameId: string) => void;
}

interface ExportPreviewProps {
  fps: number;
  frames: AnimationFrame[];
  scale: number;
  scope: ExportScope;
  selectedFrameId: string;
}

const extractPalette = (image: HTMLImageElement): PaletteEntry[] => {
  const sampleSize = 96;
  const ratio = Math.min(
    sampleSize / image.naturalWidth,
    sampleSize / image.naturalHeight,
    1
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const context = canvas.getContext("2d");
  if (!context) {
    return [];
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const counts = new Map<string, number>();
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 16) {
      continue;
    }
    const color = rgbToHex(data[index], data[index + 1], data[index + 2]);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const paletteEntries = [...counts.entries()].map(([color, count]) => ({
    color,
    count,
  }));
  paletteEntries.sort((a, b) => b.count - a.count);
  return paletteEntries.slice(0, 32);
};

const selectionModes = [
  { icon: SquareDashed, label: "Box", value: "box" },
  { icon: CircleDashed, label: "Ellipse", value: "ellipse" },
  { icon: Lasso, label: "Lasso", value: "lasso" },
  { icon: Pentagon, label: "Polygon", value: "polygon" },
  { icon: WandSparkles, label: "Magic wand", value: "magic-wand" },
] as const;

const fillTools = [
  { icon: PaintBucket, label: "Bucket fill", value: "bucket" },
  { icon: Blend, label: "Gradient", value: "gradient" },
] as const;
const shapeTools = [
  { icon: RectangleHorizontal, label: "Rectangle", value: "rectangle" },
  { icon: Circle, label: "Ellipse", value: "ellipse" },
  { icon: Triangle, label: "Triangle", value: "triangle" },
  { icon: Slash, label: "Line", value: "line" },
] as const;
const exportFormats = [
  { label: "PNG frame", value: "png" },
  { label: "Raw frames", value: "raw-frames" },
  { label: "Strip PNG", value: "strip-png" },
  { label: "Preview GIF", value: "gif" },
  { label: "WebP", value: "webp" },
  { label: "WebM", value: "webm" },
  { label: "SVG", value: "svg" },
  { label: "Lottie JSON", value: "lottie" },
  { label: "TGS", value: "tgs" },
  { label: "React", value: "react" },
  { label: "CSS", value: "css" },
  { label: "Saved JSON", value: "json" },
] as const satisfies readonly { label: string; value: ExportFormat }[];
const GradientOptionsBar = ({
  gradientEndColor,
  gradientKind,
  gradientPattern,
  gradientStartColor,
  onGradientEndColorChange,
  onGradientKindChange,
  onGradientPatternChange,
  onGradientStartColorChange,
}: GradientOptionsBarProps) => (
  <div aria-label="Gradient options" className="gradient-bar">
    <label className="gradient-color">
      <span>Start</span>
      <input
        aria-label="Gradient start color"
        type="color"
        value={gradientStartColor}
        onChange={(event) => onGradientStartColorChange(event.target.value)}
      />
    </label>
    <label className="gradient-color">
      <span>End</span>
      <input
        aria-label="Gradient end color"
        type="color"
        value={gradientEndColor}
        onChange={(event) => onGradientEndColorChange(event.target.value)}
      />
    </label>
    <div aria-label="Gradient type" className="segmented">
      {gradientKinds.map((kind) => (
        <button
          aria-pressed={gradientKind === kind}
          className={gradientKind === kind ? "segment active" : "segment"}
          key={kind}
          type="button"
          onClick={() => onGradientKindChange(kind)}
        >
          {kind}
        </button>
      ))}
    </div>
    <div aria-label="Gradient pattern" className="segmented">
      {gradientPatterns.map((pattern) => (
        <button
          aria-pressed={gradientPattern === pattern}
          className={gradientPattern === pattern ? "segment active" : "segment"}
          key={pattern}
          type="button"
          onClick={() => onGradientPatternChange(pattern)}
        >
          {pattern}
        </button>
      ))}
    </div>
  </div>
);

const ShapeOptionsBar = ({
  onShapeModeChange,
  onShapeRadiusChange,
  shapeMode,
  shapeRadius,
  shapeTool,
}: ShapeOptionsBarProps) => (
  <div aria-label="Shape options" className="gradient-bar">
    <div aria-label="Shape mode" className="segmented">
      {(["outline", "fill"] as ShapeMode[]).map((mode) => (
        <button
          aria-pressed={shapeMode === mode}
          className={shapeMode === mode ? "segment active" : "segment"}
          key={mode}
          type="button"
          onClick={() => onShapeModeChange(mode)}
        >
          {mode}
        </button>
      ))}
    </div>
    {shapeTool === "rectangle" || shapeTool === "triangle" ? (
      <label className="shape-radius">
        <span>Radius</span>
        <input
          aria-label="Shape radius"
          max="8"
          min="0"
          type="range"
          value={shapeRadius}
          onChange={(event) => onShapeRadiusChange(Number(event.target.value))}
        />
        <span>{shapeRadius}</span>
      </label>
    ) : null}
  </div>
);

export const CanvasSizeControl = ({
  onResize,
  size,
}: CanvasSizeControlProps) => {
  const dimensionDragRef = useRef<{
    field: "height" | "width";
    startValue: number;
    startY: number;
  } | null>(null);
  const [draftHeight, setDraftHeight] = useState(String(size.height));
  const [draftWidth, setDraftWidth] = useState(String(size.width));
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!isEditing) {
      setDraftHeight(String(size.height));
      setDraftWidth(String(size.width));
    }
  }, [isEditing, size]);

  const applySize = () => {
    onResize({
      height: clampCanvasDimension(Number(draftHeight)),
      width: clampCanvasDimension(Number(draftWidth)),
    });
    setIsEditing(false);
  };

  const setDraftDimension = (field: "height" | "width", value: number) => {
    const nextValue = String(clampCanvasDimension(value));
    if (field === "width") {
      setDraftWidth(nextValue);
      return;
    }
    setDraftHeight(nextValue);
  };

  const startDimensionDrag = (
    field: "height" | "width",
    event: React.PointerEvent<HTMLInputElement>
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dimensionDragRef.current = {
      field,
      startValue: Number(field === "width" ? draftWidth : draftHeight),
      startY: event.clientY,
    };
  };

  const updateDimensionDrag = (event: React.PointerEvent<HTMLInputElement>) => {
    const drag = dimensionDragRef.current;
    if (!drag) {
      return;
    }
    const delta = Math.round((drag.startY - event.clientY) / 8);
    setDraftDimension(drag.field, drag.startValue + delta);
  };

  const stopDimensionDrag = () => {
    dimensionDragRef.current = null;
  };

  return (
    <div className="canvas-size-control">
      <button
        aria-expanded={isEditing}
        aria-label="Canvas size"
        className="canvas-size-button"
        type="button"
        onClick={() => setIsEditing((current) => !current)}
      >
        {size.width} x {size.height}
      </button>
      {isEditing ? (
        <form
          aria-label="Canvas size editor"
          className="canvas-size-popover"
          onSubmit={(event) => {
            event.preventDefault();
            applySize();
          }}
        >
          <label>
            <span>W</span>
            <input
              aria-label="Canvas width"
              max={maxCanvasDimension}
              min={minCanvasDimension}
              title="Drag up or down to change width"
              type="number"
              value={draftWidth}
              onChange={(event) => setDraftWidth(event.target.value)}
              onPointerCancel={stopDimensionDrag}
              onPointerDown={(event) => startDimensionDrag("width", event)}
              onPointerMove={updateDimensionDrag}
              onPointerUp={stopDimensionDrag}
            />
          </label>
          <label>
            <span>H</span>
            <input
              aria-label="Canvas height"
              max={maxCanvasDimension}
              min={minCanvasDimension}
              title="Drag up or down to change height"
              type="number"
              value={draftHeight}
              onChange={(event) => setDraftHeight(event.target.value)}
              onPointerCancel={stopDimensionDrag}
              onPointerDown={(event) => startDimensionDrag("height", event)}
              onPointerMove={updateDimensionDrag}
              onPointerUp={stopDimensionDrag}
            />
          </label>
          <button type="submit">Apply</button>
        </form>
      ) : null}
    </div>
  );
};

export const EditorModeTabs = ({ mode, onModeChange }: EditorModeTabsProps) => (
  <div aria-label="Editor mode" className="editor-mode-tabs">
    {(["edit", "mask"] as EditorMode[]).map((item) => (
      <button
        aria-pressed={mode === item}
        className={mode === item ? "active" : ""}
        key={item}
        type="button"
        onClick={() => onModeChange(item)}
      >
        {item === "edit" ? "Edit" : "Mask"}
      </button>
    ))}
  </div>
);

const BrushSizeControl = ({
  onSizeChange,
  size,
  tool,
}: BrushSizeControlProps) => (
  <div aria-label={`${tool} size`} className="brush-size-control">
    <label>
      <span>Size</span>
      <input
        aria-label={`${tool} size value`}
        max={maxBrushSize}
        min={minBrushSize}
        type="range"
        value={size}
        onChange={(event) =>
          onSizeChange(clampBrushSize(Number(event.target.value)))
        }
      />
      <strong>{size}</strong>
    </label>
  </div>
);

export const BrushSizePanel = ({
  onSizeChange,
  size,
  tool,
}: BrushSizePanelProps) => {
  if (tool !== "brush" && tool !== "eraser") {
    return null;
  }
  return (
    <BrushSizeControl size={size} tool={tool} onSizeChange={onSizeChange} />
  );
};

export const ColorPanel = ({
  color,
  isOpen,
  onAddSavedColor,
  onChange,
  onClose,
  onOpacityChange,
  opacity,
  savedColors,
}: ColorPanelProps) => {
  const [draftColor, setDraftColor] = useState(color.toUpperCase());
  const colorHsv = hexToHsvColor(color);
  const [selectedHue, setSelectedHue] = useState(colorHsv.h);
  const hsv = { ...colorHsv, h: selectedHue };
  const hueColor = hsvToHexColor({ h: selectedHue, s: 1, v: 1 });

  useEffect(() => {
    const nextHsv = hexToHsvColor(color);
    setDraftColor(color.toUpperCase());
    if (nextHsv.s > 0 && nextHsv.v > 0) {
      setSelectedHue(nextHsv.h);
    }
  }, [color]);

  if (!isOpen) {
    return null;
  }

  const updateDraftColor = (value: string) => {
    const normalizedColor = normalizeHexColor(value);
    setDraftColor(value);
    if (isHexColor(normalizedColor)) {
      onChange(normalizedColor);
      setDraftColor(normalizedColor.toUpperCase());
    }
  };

  const pickColorBox = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const saturation = clamp((event.clientX - rect.left) / rect.width, 1);
    const value = clamp(1 - (event.clientY - rect.top) / rect.height, 1);
    onChange(hsvToHexColor({ h: selectedHue, s: saturation, v: value }));
  };

  const pickHue = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hue = clamp(((event.clientX - rect.left) / rect.width) * 360, 360);
    setSelectedHue(hue);
    onChange(hsvToHexColor({ h: hue, s: colorHsv.s, v: colorHsv.v }));
  };

  const pickOpacity = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onOpacityChange(clamp((event.clientX - rect.left) / rect.width, 1));
  };

  return (
    <div className="color-panel">
      <div className="color-panel-head">
        <span>Color</span>
        <button aria-label="Close color panel" type="button" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <button
        aria-label="Color box"
        className="color-box"
        type="button"
        style={
          {
            "--hue-color": hueColor,
            "--picker-x": `${hsv.s * 100}%`,
            "--picker-y": `${(1 - hsv.v) * 100}%`,
          } as CSSProperties
        }
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pickColorBox(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) {
            pickColorBox(event);
          }
        }}
      >
        <span aria-hidden="true" />
      </button>
      <div className="color-controls-row">
        <span
          aria-hidden="true"
          className="color-preview"
          style={{ backgroundColor: color }}
        />
        <button
          aria-label="Hue"
          className="hue-slider"
          type="button"
          style={{ "--hue-x": `${(hsv.h / 360) * 100}%` } as CSSProperties}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pickHue(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1) {
              pickHue(event);
            }
          }}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <label className="hex-field">
        <span>HEX</span>
        <input
          aria-label="HEX color"
          spellCheck={false}
          value={draftColor}
          onChange={(event) => updateDraftColor(event.target.value)}
        />
      </label>
      <div className="opacity-control">
        <span>Opacity</span>
        <button
          aria-label="Brush and eraser opacity"
          className="opacity-slider"
          type="button"
          style={{ "--opacity-x": `${opacity * 100}%` } as CSSProperties}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pickOpacity(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1) {
              pickOpacity(event);
            }
          }}
        >
          <span aria-hidden="true" />
        </button>
        <strong>{Math.round(opacity * 100)}%</strong>
      </div>
      <div className="quick-colors" aria-label="Saved colors">
        <button
          aria-label="Add current color to palette"
          className="add-color"
          type="button"
          onClick={onAddSavedColor}
        >
          <Plus aria-hidden="true" />
        </button>
        {savedColors.map((item) => (
          <button
            aria-label={`Set color ${item}`}
            className={item === color.toLowerCase() ? "active" : ""}
            key={item}
            type="button"
            style={{ backgroundColor: item }}
            onClick={() => onChange(item)}
          />
        ))}
      </div>
    </div>
  );
};

export const MaskLayersPanel = ({
  activeLayerId,
  isVisible,
  layers,
  onAddLayer,
  onCenterAnchor,
  onDeleteLayer,
  onParentChange,
  onRenameLayer,
  onSelectLayer,
  onSetLayerColor,
  onToggleLayerVisibility,
}: MaskLayersPanelProps) => {
  if (!isVisible) {
    return null;
  }
  return (
    <aside aria-label="Mask layers" className="mask-layers-panel">
      <div className="mask-layers-header">
        <span>Masks</span>
        <button type="button" onClick={onAddLayer}>
          <Plus aria-hidden="true" />
        </button>
      </div>
      <div className="mask-layer-list">
        {layers.map((layer) => (
          <div
            className={
              activeLayerId === layer.id ? "mask-layer active" : "mask-layer"
            }
            key={layer.id}
          >
            <button
              aria-label={`Select ${layer.name}`}
              className="mask-layer-select"
              type="button"
              onClick={() => onSelectLayer(layer.id)}
            >
              <span
                aria-hidden="true"
                className="mask-layer-swatch"
                style={{ backgroundColor: layer.color }}
              />
            </button>
            <input
              aria-label={`${layer.name} name`}
              type="text"
              value={layer.name}
              onChange={(event) => onRenameLayer(layer.id, event.target.value)}
              onFocus={() => onSelectLayer(layer.id)}
            />
            <input
              aria-label={`${layer.name} color`}
              className="mask-layer-color"
              type="color"
              value={layer.color}
              onChange={(event) =>
                onSetLayerColor(layer.id, event.target.value)
              }
            />
            <button
              aria-pressed={layer.visible}
              aria-label={
                layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`
              }
              className="mask-layer-visibility"
              type="button"
              onClick={() => onToggleLayerVisibility(layer.id)}
            >
              {layer.visible ? "On" : "Off"}
            </button>
            <button
              aria-label={`Delete ${layer.name}`}
              className="mask-layer-delete"
              disabled={layers.length === 1}
              type="button"
              onClick={() => onDeleteLayer(layer.id)}
            >
              <X aria-hidden="true" />
            </button>
            <div className="mask-layer-rig">
              <label>
                <span>Parent</span>
                <select
                  aria-label={`${layer.name} parent`}
                  value={layer.parentId ?? ""}
                  onChange={(event) =>
                    onParentChange(layer.id, event.target.value || null)
                  }
                  onFocus={() => onSelectLayer(layer.id)}
                >
                  <option value="">None</option>
                  {layers
                    .filter((item) => item.id !== layer.id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  onSelectLayer(layer.id);
                  onCenterAnchor(layer.id);
                }}
              >
                Anchor {Math.round(layer.anchor.x)},{" "}
                {Math.round(layer.anchor.y)}
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
};

export const MaskAnchorsOverlay = ({
  activeLayerId,
  layers,
  size,
  onMoveAnchorDrag,
  onStartAnchorDrag,
  onStopAnchorDrag,
}: MaskAnchorsOverlayProps) => {
  if (layers.length === 0) {
    return null;
  }
  return (
    <div className="mask-anchors-overlay">
      {layers.map((layer) => (
        <button
          aria-label={`${layer.name} anchor`}
          className={
            activeLayerId === layer.id ? "mask-anchor active" : "mask-anchor"
          }
          key={layer.id}
          type="button"
          style={{
            left: `${(layer.anchor.x / size.width) * 100}%`,
            top: `${(layer.anchor.y / size.height) * 100}%`,
          }}
          onPointerCancel={onStopAnchorDrag}
          onPointerDown={(event) => onStartAnchorDrag(layer.id, event)}
          onPointerMove={onMoveAnchorDrag}
          onPointerUp={onStopAnchorDrag}
        />
      ))}
    </div>
  );
};

export const MaskOverlay = ({
  activeLayerId,
  layers,
  size,
}: MaskOverlayProps) => {
  if (layers.length === 0) {
    return null;
  }
  return (
    <div className="mask-overlay">
      {layers.flatMap((layer) =>
        layer.mask.map((isSelected, index) =>
          isSelected ? (
            <span
              className={
                activeLayerId === layer.id ? "mask-cell active" : "mask-cell"
              }
              key={`${layer.id}-${index}`}
              style={{
                backgroundColor: layer.color,
                left: `${((index % size.width) / size.width) * 100}%`,
                top: `${(Math.floor(index / size.width) / size.height) * 100}%`,
              }}
            />
          ) : null
        )
      )}
    </div>
  );
};

export const SelectionMaskOverlay = ({
  isVisible,
  mask,
  size,
}: SelectionMaskOverlayProps) => {
  if (!isVisible) {
    return null;
  }
  return (
    <div className="selection-mask">
      {mask.map((isSelected, index) =>
        isSelected ? (
          <span
            className="selection-cell"
            key={index}
            style={{
              left: `${((index % size.width) / size.width) * 100}%`,
              top: `${(Math.floor(index / size.width) / size.height) * 100}%`,
            }}
          />
        ) : null
      )}
    </div>
  );
};

const FrameThumbnail = ({ frame }: FrameThumbnailProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    canvas.width = frame.size.width;
    canvas.height = frame.size.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    for (let y = 0; y < frame.size.height; y += 1) {
      for (let x = 0; x < frame.size.width; x += 1) {
        const color = frame.grid[y * frame.size.width + x];
        if (color) {
          context.fillStyle = color;
          context.fillRect(x, y, 1, 1);
        }
      }
    }
  }, [frame]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="timeline-thumbnail"
      height={frame.size.height}
      width={frame.size.width}
    />
  );
};

const drawFrameToPreview = (
  canvas: HTMLCanvasElement | null,
  frame: AnimationFrame,
  scaleFactor: number
) => {
  const context = canvas?.getContext("2d");
  if (!canvas || !context) {
    return;
  }
  canvas.width = frame.size.width * scaleFactor;
  canvas.height = frame.size.height * scaleFactor;
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawFramePixels(context, frame, scaleFactor);
};

const ExportPreview = ({
  fps,
  frames,
  scale: scaleFactor,
  scope,
  selectedFrameId,
}: ExportPreviewProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const selectedFrame =
    frames.find((frame) => frame.id === selectedFrameId) ?? frames[0];
  const previewFrames = scope === "animation" ? frames : [selectedFrame];
  const previewFrame = previewFrames[previewIndex % previewFrames.length];

  useEffect(() => {
    setPreviewIndex(0);
  }, [scope, selectedFrameId, frames.length]);

  useEffect(() => {
    if (scope !== "animation" || frames.length < 2) {
      return;
    }
    const timer = window.setInterval(() => {
      setPreviewIndex((current) => (current + 1) % frames.length);
    }, fpsToFrameDurationMs(fps));
    return () => window.clearInterval(timer);
  }, [fps, frames.length, scope]);

  useEffect(() => {
    if (previewFrame) {
      drawFrameToPreview(canvasRef.current, previewFrame, scaleFactor);
    }
  }, [previewFrame, scaleFactor]);

  if (!previewFrame) {
    return null;
  }

  return (
    <div className="export-preview">
      <canvas
        ref={canvasRef}
        aria-label="Export preview"
        style={{
          aspectRatio: `${previewFrame.size.width} / ${previewFrame.size.height}`,
        }}
      />
      <span>
        {previewFrame.size.width * scaleFactor} x{" "}
        {previewFrame.size.height * scaleFactor}
      </span>
    </div>
  );
};

export const ExportDialog = ({
  directoryPath,
  excludedFrameIds,
  fps,
  format,
  frames,
  isOpen,
  isExporting,
  onClose,
  onDirectoryPathChange,
  onExport,
  onFormatChange,
  onScaleChange,
  onScopeChange,
  onSelectFrame,
  onToggleFrameExcluded,
  scale: scaleFactor,
  scope,
  selectedFrameId,
  status,
}: ExportDialogProps) => {
  if (!isOpen) {
    return null;
  }
  const previewFrames =
    scope === "animation"
      ? frames.filter((frame) => !excludedFrameIds.includes(frame.id))
      : frames;
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="export-dialog" size="lg">
        <div className="export-header">
          <DialogTitle>Export</DialogTitle>
        </div>
        <ExportPreview
          fps={fps}
          frames={previewFrames.length > 0 ? previewFrames : frames}
          scale={scaleFactor}
          scope={scope}
          selectedFrameId={selectedFrameId}
        />
        <div className="export-controls">
          <div className="export-control">
            <label htmlFor="export-folder-path">Folder</label>
            <div className="export-folder-row">
              <input
                aria-label="Export folder"
                className="export-folder-input"
                id="export-folder-path"
                spellCheck={false}
                type="text"
                value={directoryPath}
                onChange={(event) => onDirectoryPathChange(event.target.value)}
              />
            </div>
            <p className="export-hint">
              Files are written by the local Retrodex API. Use an absolute path
              or ~/Downloads/Retrodex.
            </p>
          </div>
          <div className="export-control">
            <span>Target</span>
            <Select
              value={scope}
              onValueChange={(value) => onScopeChange(value as ExportScope)}
            >
              <SelectTrigger className="export-select" />
              <SelectContent>
                <SelectItem index={0} value="animation">
                  Full animation
                </SelectItem>
                <SelectItem index={1} value="frame">
                  Single frame
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="export-control">
            <span>Frame</span>
            <Select
              disabled={scope === "animation"}
              value={selectedFrameId}
              onValueChange={onSelectFrame}
            >
              <SelectTrigger className="export-select" />
              <SelectContent>
                {frames.map((frame, index) => (
                  <SelectItem index={index} key={frame.id} value={frame.id}>
                    Frame {index + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="export-control">
            <span>Scale</span>
            <Select
              value={String(scaleFactor)}
              onValueChange={(value) => onScaleChange(Number(value))}
            >
              <SelectTrigger className="export-select" />
              <SelectContent>
                {exportScales.map((item, index) => (
                  <SelectItem index={index} key={item} value={String(item)}>
                    {item === 1 ? "As is" : `${item}x`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="export-control">
            <span>Format</span>
            <Select
              value={format}
              onValueChange={(value) => onFormatChange(value as ExportFormat)}
            >
              <SelectTrigger className="export-select" />
              <SelectContent>
                {exportFormats.map((item, index) => (
                  <SelectItem index={index} key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="export-frame-strip">
          {frames.map((frame, index) => (
            <button
              aria-label={
                scope === "animation"
                  ? `${excludedFrameIds.includes(frame.id) ? "Include" : "Exclude"} frame ${index + 1}`
                  : `Select frame ${index + 1}`
              }
              aria-pressed={
                scope === "animation"
                  ? !excludedFrameIds.includes(frame.id)
                  : selectedFrameId === frame.id
              }
              className={[
                selectedFrameId === frame.id ? "active" : "",
                scope === "animation" && excludedFrameIds.includes(frame.id)
                  ? "excluded"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={frame.id}
              type="button"
              onClick={() => {
                if (scope === "animation") {
                  onToggleFrameExcluded(frame.id);
                  return;
                }
                onSelectFrame(frame.id);
              }}
            >
              <FrameThumbnail frame={frame} />
              <span>
                {index + 1}
                {scope === "animation" && excludedFrameIds.includes(frame.id)
                  ? " off"
                  : ""}
              </span>
            </button>
          ))}
        </div>
        <Button
          className="export-submit"
          disabled={isExporting}
          type="button"
          variant="secondary"
          onClick={onExport}
        >
          <Download aria-hidden="true" />
          {isExporting ? "Exporting" : "Export"}
        </Button>
        {status ? <p className="export-status">{status}</p> : null}
      </DialogContent>
    </Dialog>
  );
};

const getTimelineDropIndex = (
  strip: Element | null,
  frameId: string,
  clientX: number
) => {
  const frameButtons = [
    ...(strip?.querySelectorAll<HTMLButtonElement>(".timeline-frame") ?? []),
  ].filter((button) => button.dataset.frameId !== frameId);
  const zones = frameButtons.map((button) => {
    const rect = button.getBoundingClientRect();
    return {
      id: button.dataset.frameId ?? "",
      magneticRadius: 10,
      priority: 20,
      rect: {
        height: rect.height,
        width: rect.width,
        x: rect.left,
        y: rect.top,
      },
      target: {
        frameId: button.dataset.frameId ?? "",
        kind: "timeline-frame",
      },
    };
  });
  const hit = hitTestZones({
    point: { x: clientX, y: zones[0]?.rect.y ?? 0 },
    zones,
  });
  if (hit) {
    const center = hit.zone.rect.x + hit.zone.rect.width / 2;
    const hitIndex = zones.findIndex((zone) => zone.id === hit.zone.id);
    return clientX < center ? hitIndex : hitIndex + 1;
  }
  const nextIndex = frameButtons.findIndex((button) => {
    const rect = button.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2;
  });
  return nextIndex === -1 ? frameButtons.length : nextIndex;
};

export const Timeline = ({
  fps,
  frames,
  isOpen,
  isPlaying,
  onAddFrame,
  onDeleteFrame,
  onFpsChange,
  onReorderFrame,
  onSelectFrame,
  onTogglePlayback,
  onToggle,
  selectedFrameId,
}: TimelineProps) => {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    frameId: string;
    hasMoved: boolean;
    startX: number;
  } | null>(null);
  const suppressFrameClickRef = useRef(false);
  const [draggingFrameId, setDraggingFrameId] = useState<string | null>(null);
  const PlaybackIcon = isPlaying ? Pause : Play;
  const ToggleIcon = isOpen ? ChevronDown : ChevronUp;
  const [hoverFrameId, setHoverFrameId] = useState<null | string>(null);
  const [contextMenu, setContextMenu] = useState<{
    frameId: string;
    x: number;
    y: number;
  } | null>(null);
  const setClampedFps = (nextFps: number) => {
    onFpsChange(
      Math.max(minAnimationFps, Math.min(maxAnimationFps, Math.round(nextFps)))
    );
  };
  const handleTimelineWheel = (event: WheelEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth) {
      return;
    }
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    strip.scrollLeft += delta;
  };

  useEffect(() => {
    if (!draggingFrameId) {
      return;
    }
    const moveFrame = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      if (Math.abs(event.clientX - drag.startX) > 4) {
        drag.hasMoved = true;
      }
      if (drag.hasMoved) {
        onReorderFrame(
          drag.frameId,
          getTimelineDropIndex(stripRef.current, drag.frameId, event.clientX)
        );
      }
    };
    const stopMovingFrame = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag?.hasMoved) {
        onReorderFrame(
          drag.frameId,
          getTimelineDropIndex(stripRef.current, drag.frameId, event.clientX)
        );
      }
      suppressFrameClickRef.current = Boolean(drag?.hasMoved);
      dragRef.current = null;
      setDraggingFrameId(null);
    };
    window.addEventListener("pointermove", moveFrame);
    window.addEventListener("pointerup", stopMovingFrame, { once: true });
    return () => {
      window.removeEventListener("pointermove", moveFrame);
      window.removeEventListener("pointerup", stopMovingFrame);
    };
  }, [draggingFrameId, onReorderFrame]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const closeMenu = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  return (
    <>
      <button
        aria-expanded={isOpen}
        aria-label={isOpen ? "Close timeline" : "Open timeline"}
        className="timeline-toggle"
        type="button"
        onClick={onToggle}
      >
        <ToggleIcon aria-hidden="true" />
      </button>
      <section
        aria-label="Animation timeline"
        className={isOpen ? "timeline open" : "timeline"}
      >
        <div
          ref={stripRef}
          className="timeline-strip"
          onWheel={handleTimelineWheel}
        >
          <button
            aria-label={isPlaying ? "Pause animation" : "Play animation"}
            aria-pressed={isPlaying}
            className={isPlaying ? "timeline-play active" : "timeline-play"}
            type="button"
            onClick={onTogglePlayback}
          >
            <PlaybackIcon aria-hidden="true" />
          </button>
          <div className="timeline-fps-control" aria-label="Animation FPS">
            <button
              aria-label="Decrease FPS"
              type="button"
              onClick={() => setClampedFps(fps - 1)}
            >
              <Minus aria-hidden="true" />
            </button>
            <span>{fps} fps</span>
            <button
              aria-label="Increase FPS"
              type="button"
              onClick={() => setClampedFps(fps + 1)}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
          {frames.map((frame, index) => (
            <button
              data-frame-id={frame.id}
              aria-label={`Frame ${index + 1}`}
              aria-pressed={selectedFrameId === frame.id}
              className={[
                "timeline-frame",
                selectedFrameId === frame.id ? "active" : "",
                draggingFrameId === frame.id ? "dragging" : "",
                hoverFrameId === frame.id ? "magnetic" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={frame.id}
              type="button"
              onClick={() => {
                if (suppressFrameClickRef.current) {
                  suppressFrameClickRef.current = false;
                  return;
                }
                onSelectFrame(frame.id);
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                setHoverFrameId(null);
                setDraggingFrameId(null);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  return;
                }
                event.preventDefault();
                dragRef.current = {
                  frameId: frame.id,
                  hasMoved: false,
                  startX: event.clientX,
                };
                setDraggingFrameId(frame.id);
              }}
              onPointerMove={(event) => {
                const zones = [
                  ...(stripRef.current?.querySelectorAll<HTMLButtonElement>(
                    ".timeline-frame"
                  ) ?? []),
                ].map((button) => {
                  const rect = button.getBoundingClientRect();
                  return {
                    id: button.dataset.frameId ?? "",
                    magneticRadius: 12,
                    priority: 20,
                    rect: {
                      height: rect.height,
                      width: rect.width,
                      x: rect.left,
                      y: rect.top,
                    },
                    target: {
                      frameId: button.dataset.frameId ?? "",
                      kind: "timeline-frame",
                    },
                  };
                });
                const hit = hitTestZones({
                  point: { x: event.clientX, y: event.clientY },
                  previousTarget: hoverFrameId
                    ? { frameId: hoverFrameId, kind: "timeline-frame" }
                    : null,
                  zones,
                });
                setHoverFrameId(hit?.target.frameId ?? null);
              }}
              onPointerLeave={() => setHoverFrameId(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({
                  frameId: frame.id,
                  x: Math.min(event.clientX, window.innerWidth - 184),
                  y: Math.min(event.clientY, window.innerHeight - 64),
                });
              }}
            >
              <FrameThumbnail frame={frame} />
              <span>{index + 1}</span>
            </button>
          ))}
          <button
            aria-label="Add frame"
            className="timeline-add"
            type="button"
            onClick={onAddFrame}
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
      </section>
      {contextMenu ? (
        <div
          className="timeline-context-menu"
          role="menu"
          tabIndex={-1}
          style={
            {
              "--menu-x": `${contextMenu.x}px`,
              "--menu-y": `${contextMenu.y}px`,
            } as CSSProperties
          }
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            className="timeline-context-menu-item danger"
            disabled={frames.length <= 1}
            role="menuitem"
            type="button"
            onClick={() => {
              onDeleteFrame(contextMenu.frameId);
              setContextMenu(null);
            }}
          >
            <Trash2 aria-hidden="true" />
            <span>Delete frame</span>
          </button>
        </div>
      ) : null}
    </>
  );
};

const ToolGroup = <T extends string>({
  active,
  isOpen,
  label,
  onContextToggle,
  onPrimaryClick,
  onSelect,
  options,
  selectedOption,
  selectedValue,
  shortcut,
}: ToolGroupProps<T>) => {
  const SelectedIcon = selectedOption.icon;
  const tooltip = `${label}: ${selectedOption.label} · ${shortcut}`;
  return (
    <div className="tool-menu-host">
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`${label}: ${selectedOption.label}`}
        className={active ? "tool active" : "tool"}
        data-tooltip={tooltip}
        title={tooltip}
        type="button"
        onClick={onPrimaryClick}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextToggle();
        }}
      >
        <SelectedIcon aria-hidden="true" />
      </button>
      {isOpen ? (
        <div className="tool-menu" role="menu">
          {options.map((option) => {
            const OptionIcon = option.icon;
            return (
              <button
                aria-checked={selectedValue === option.value}
                className={
                  selectedValue === option.value
                    ? "tool-menu-item active"
                    : "tool-menu-item"
                }
                key={option.value}
                role="menuitemradio"
                type="button"
                onClick={() => onSelect(option.value)}
              >
                <OptionIcon aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

const ReferencePanel = ({
  isMinimized,
  onClose,
  onMinimize,
  onPickColor,
}: ReferencePanelProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragOffsetRef = useRef<Point | null>(null);
  const resizeDragRef = useRef<{
    startHeight: number;
    startWidth: number;
    startX: number;
    startY: number;
  } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageName, setImageName] = useState("Reference");
  const [paletteEntries, setPaletteEntries] = useState<PaletteEntry[]>([]);
  const [panelSize, setPanelSize] = useState<Size>({
    height: 430,
    width: 420,
  });
  const [panelPosition, setPanelPosition] = useState<Point>({ x: 686, y: 72 });
  const [isResizeHover, setIsResizeHover] = useState(false);
  const [referenceZoom, setReferenceZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState<Size>({
    height: 320,
    width: 420,
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const { height: nextHeight, width: nextWidth } = entry.contentRect;
      setViewportSize({
        height: Math.max(1, Math.round(nextHeight)),
        width: Math.max(1, Math.round(nextWidth)),
      });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    canvas.width = viewportSize.width;
    canvas.height = viewportSize.height;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#1f2024";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!image) {
      return;
    }
    const drawWidth = image.naturalWidth * referenceZoom;
    const drawHeight = image.naturalHeight * referenceZoom;
    context.drawImage(
      image,
      (canvas.width - drawWidth) / 2,
      (canvas.height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
  }, [image, referenceZoom, viewportSize]);

  const loadReference = (file: File) => {
    const source = URL.createObjectURL(file);
    const nextImage = new Image();
    nextImage.addEventListener("load", () => {
      URL.revokeObjectURL(source);
      setImage(nextImage);
      setImageName(file.name);
      setPaletteEntries(extractPalette(nextImage));
      setReferenceZoom(
        Math.min(
          viewportSize.width / nextImage.naturalWidth,
          viewportSize.height / nextImage.naturalHeight,
          1
        )
      );
    });
    nextImage.src = source;
  };

  const movePanel = (event: React.PointerEvent<HTMLElement>) => {
    if (!dragOffsetRef.current) {
      return;
    }
    const panel = panelRef.current;
    const panelWidth = panel?.offsetWidth ?? 260;
    const panelHeight = panel?.offsetHeight ?? 42;
    setPanelPosition({
      x: clamp(
        event.clientX - dragOffsetRef.current.x,
        window.innerWidth - panelWidth
      ),
      y: clamp(
        event.clientY - dragOffsetRef.current.y,
        window.innerHeight - panelHeight
      ),
    });
  };

  const stopMovingPanel = () => {
    dragOffsetRef.current = null;
  };

  const getReferenceHitTarget = (event: React.PointerEvent<HTMLElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    return hitTestZones({
      point: { x: event.clientX, y: event.clientY },
      previousTarget: isResizeHover ? { kind: "reference-resize" } : null,
      zones: [
        {
          id: "reference-resize",
          magneticRadius: 10,
          priority: 100,
          rect: {
            height: 22,
            width: 22,
            x: rect.right - 22,
            y: rect.bottom - 22,
          },
          target: { kind: "reference-resize" },
        },
      ],
    });
  };

  const updateResizeHover = (event: React.PointerEvent<HTMLElement>) => {
    if (isMinimized || resizeDragRef.current || dragOffsetRef.current) {
      return;
    }
    const hit = getReferenceHitTarget(event);
    setIsResizeHover(Boolean(hit));
  };

  const startReferenceResize = (event: React.PointerEvent<HTMLElement>) => {
    if (isMinimized || !getReferenceHitTarget(event)) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDragRef.current = {
      startHeight: panelSize.height,
      startWidth: panelSize.width,
      startX: event.clientX,
      startY: event.clientY,
    };
    setIsResizeHover(true);
    return true;
  };

  const moveReferenceResize = (event: React.PointerEvent<HTMLElement>) => {
    const drag = resizeDragRef.current;
    if (!drag) {
      return false;
    }
    setPanelSize({
      height: Math.min(
        Math.max(180, drag.startHeight + event.clientY - drag.startY),
        window.innerHeight - 140
      ),
      width: Math.min(
        Math.max(260, drag.startWidth + event.clientX - drag.startX),
        window.innerWidth - 48
      ),
    });
    return true;
  };

  const stopReferenceResize = () => {
    resizeDragRef.current = null;
  };

  const pickReferenceColor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(
      ((event.clientX - rect.left) / rect.width) * canvas.width
    );
    const y = Math.floor(
      ((event.clientY - rect.top) / rect.height) * canvas.height
    );
    const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
    if (alpha === 0) {
      return;
    }
    onPickColor(rgbToHex(red, green, blue));
  };

  return (
    <section
      ref={panelRef}
      aria-label="Reference"
      className={isMinimized ? "reference-panel minimized" : "reference-panel"}
      style={{
        cursor: isResizeHover ? "nwse-resize" : undefined,
        height: isMinimized ? undefined : panelSize.height,
        left: panelPosition.x,
        top: panelPosition.y,
        width: isMinimized ? undefined : panelSize.width,
      }}
      onPointerCancel={() => {
        stopMovingPanel();
        stopReferenceResize();
      }}
      onPointerDown={(event) => {
        startReferenceResize(event);
      }}
      onPointerMove={(event) => {
        if (moveReferenceResize(event)) {
          return;
        }
        updateResizeHover(event);
      }}
      onPointerLeave={() => {
        if (!resizeDragRef.current) {
          setIsResizeHover(false);
        }
      }}
      onPointerUp={() => {
        stopReferenceResize();
      }}
    >
      <div
        className="reference-header"
        onPointerCancel={stopMovingPanel}
        onPointerDown={(event) => {
          if (isResizeHover) {
            return;
          }
          if (
            event.target instanceof Element &&
            event.target.closest("button")
          ) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = panelRef.current?.getBoundingClientRect();
          dragOffsetRef.current = {
            x: event.clientX - (rect?.left ?? 0),
            y: event.clientY - (rect?.top ?? 0),
          };
        }}
        onPointerMove={movePanel}
        onPointerUp={stopMovingPanel}
      >
        <span className="reference-title">{imageName}</span>
        <div className="reference-actions">
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            Open
          </button>
          <button
            aria-label="Minimize reference"
            type="button"
            onClick={onMinimize}
          >
            <Minus aria-hidden="true" />
          </button>
          <button aria-label="Close reference" type="button" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
      {isMinimized ? null : (
        <>
          <div ref={viewportRef} className="reference-viewport">
            <canvas
              ref={canvasRef}
              aria-label="Reference canvas"
              className="reference-canvas"
              height={viewportSize.height}
              width={viewportSize.width}
              onPointerDown={pickReferenceColor}
              onWheel={(event) => {
                event.preventDefault();
                setReferenceZoom((current) =>
                  clampZoom(current * Math.exp(-event.deltaY * 0.002))
                );
              }}
            />
          </div>
          <div aria-label="Reference palette" className="reference-palette">
            {paletteEntries.length === 0 ? (
              <span className="reference-empty">Open an image</span>
            ) : (
              paletteEntries.map((entry) => (
                <button
                  aria-label={`Pick ${entry.color}`}
                  className="reference-swatch"
                  key={entry.color}
                  style={{ backgroundColor: entry.color }}
                  title={entry.color}
                  type="button"
                  onClick={() => onPickColor(entry.color)}
                />
              ))
            )}
          </div>
        </>
      )}
      {isMinimized ? null : (
        <span aria-hidden="true" className="reference-resize-hit" />
      )}
      <input
        ref={fileInputRef}
        accept="image/*"
        aria-label="Reference image file"
        className="reference-file"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            loadReference(file);
          }
        }}
      />
    </section>
  );
};

export const FloatingPanels = ({
  activeTool,
  gradientEndColor,
  gradientKind,
  gradientPattern,
  gradientStartColor,
  canDeleteSelection,
  hasSelection,
  isReferenceMinimized,
  isReferenceOpen,
  onClearSelection,
  onDeleteSelection,
  onGradientEndColorChange,
  onGradientKindChange,
  onGradientPatternChange,
  onGradientStartColorChange,
  onReferenceClose,
  onReferenceMinimize,
  onReferencePickColor,
  onShapeModeChange,
  onShapeRadiusChange,
  shapeMode,
  shapeRadius,
  shapeTool,
}: FloatingPanelsProps) => (
  <>
    {hasSelection || canDeleteSelection ? (
      <div className="selection-action-bar">
        {canDeleteSelection ? (
          <Button
            className="selection-action-button delete-selection-button"
            type="button"
            variant="ghost"
            onClick={onDeleteSelection}
          >
            <Trash2 aria-hidden="true" size={15} />
            Delete
          </Button>
        ) : null}
        {hasSelection ? (
          <Button
            className="selection-action-button"
            type="button"
            variant="ghost"
            onClick={onClearSelection}
          >
            Deselect
          </Button>
        ) : null}
      </div>
    ) : null}
    {activeTool === "gradient" ? (
      <GradientOptionsBar
        gradientEndColor={gradientEndColor}
        gradientKind={gradientKind}
        gradientPattern={gradientPattern}
        gradientStartColor={gradientStartColor}
        onGradientEndColorChange={onGradientEndColorChange}
        onGradientKindChange={onGradientKindChange}
        onGradientPatternChange={onGradientPatternChange}
        onGradientStartColorChange={onGradientStartColorChange}
      />
    ) : null}
    {activeTool === "shape" ? (
      <ShapeOptionsBar
        shapeMode={shapeMode}
        shapeRadius={shapeRadius}
        shapeTool={shapeTool}
        onShapeModeChange={onShapeModeChange}
        onShapeRadiusChange={onShapeRadiusChange}
      />
    ) : null}
    {isReferenceOpen ? (
      <ReferencePanel
        isMinimized={isReferenceMinimized}
        onClose={onReferenceClose}
        onMinimize={onReferenceMinimize}
        onPickColor={onReferencePickColor}
      />
    ) : null}
  </>
);

interface ToolbarProps {
  activeTool: Tool;
  currentColor: string;
  fillTool: FillTool;
  isFillMenuOpen: boolean;
  isGridVisible: boolean;
  isReferenceOpen: boolean;
  isSelectionMenuOpen: boolean;
  isShapeMenuOpen: boolean;
  selectionBounds: Bounds | null;
  selectionMode: SelectionMode;
  shapeTool: ShapeTool;
  onColorToggle: () => void;
  onFillMenuToggle: () => void;
  onGridToggle: () => void;
  onReferenceToggle: () => void;
  onSelectionMenuToggle: () => void;
  onSetActiveTool: (tool: Tool) => void;
  onSetFillTool: (tool: FillTool) => void;
  onSetSelectionMode: (mode: SelectionMode) => void;
  onSetShapeTool: (tool: ShapeTool) => void;
  onSetTransformOriginToSelection: () => void;
  onShapeMenuToggle: () => void;
  onToolMenusClose: () => void;
}

export const Toolbar = ({
  activeTool,
  currentColor,
  fillTool,
  isFillMenuOpen,
  isGridVisible,
  isReferenceOpen,
  isSelectionMenuOpen,
  isShapeMenuOpen,
  selectionBounds,
  selectionMode,
  shapeTool,
  onColorToggle,
  onFillMenuToggle,
  onGridToggle,
  onReferenceToggle,
  onSelectionMenuToggle,
  onSetActiveTool,
  onSetFillTool,
  onSetSelectionMode,
  onSetShapeTool,
  onSetTransformOriginToSelection,
  onShapeMenuToggle,
  onToolMenusClose,
}: ToolbarProps) => {
  const selectedSelectionMode =
    selectionModes.find((mode) => mode.value === selectionMode) ??
    selectionModes[0];
  const selectedFillTool =
    fillTools.find((tool) => tool.value === fillTool) ?? fillTools[0];
  const selectedShapeTool =
    shapeTools.find((tool) => tool.value === shapeTool) ?? shapeTools[0];

  return (
    <div aria-label="Tools" className="toolbar" role="toolbar">
      <button
        aria-label="Transform"
        className={activeTool === "transform" ? "tool active" : "tool"}
        data-tooltip="Transform · V"
        title="Transform · V"
        type="button"
        onClick={() => {
          if (selectionBounds) {
            onSetTransformOriginToSelection();
          }
          onToolMenusClose();
          onSetActiveTool("transform");
        }}
      >
        <MousePointer2 aria-hidden="true" />
      </button>
      <button
        aria-label="Brush"
        className={activeTool === "brush" ? "tool active" : "tool"}
        data-tooltip="Brush · B"
        title="Brush · B"
        type="button"
        onClick={() => {
          onToolMenusClose();
          onSetActiveTool("brush");
        }}
      >
        <Brush aria-hidden="true" />
      </button>
      <button
        aria-label="Eraser"
        className={activeTool === "eraser" ? "tool active" : "tool"}
        data-tooltip="Eraser · E"
        title="Eraser · E"
        type="button"
        onClick={() => {
          onToolMenusClose();
          onSetActiveTool("eraser");
        }}
      >
        <Eraser aria-hidden="true" />
      </button>
      <ToolGroup
        active={activeTool === "selection"}
        isOpen={isSelectionMenuOpen}
        label="Selection"
        options={selectionModes}
        selectedOption={selectedSelectionMode}
        selectedValue={selectionMode}
        shortcut="S"
        onContextToggle={onSelectionMenuToggle}
        onPrimaryClick={() => {
          onToolMenusClose();
          onSetActiveTool("selection");
        }}
        onSelect={(value) => {
          onSetSelectionMode(value);
          onSetActiveTool("selection");
          onToolMenusClose();
        }}
      />
      <ToolGroup
        active={activeTool === "shape"}
        isOpen={isShapeMenuOpen}
        label="Shape"
        options={shapeTools}
        selectedOption={selectedShapeTool}
        selectedValue={shapeTool}
        shortcut="Q"
        onContextToggle={onShapeMenuToggle}
        onPrimaryClick={() => {
          onToolMenusClose();
          onSetActiveTool("shape");
        }}
        onSelect={(value) => {
          onSetShapeTool(value);
          onSetActiveTool("shape");
          onToolMenusClose();
        }}
      />
      <ToolGroup
        active={activeTool === "bucket" || activeTool === "gradient"}
        isOpen={isFillMenuOpen}
        label="Fill"
        options={fillTools}
        selectedOption={selectedFillTool}
        selectedValue={fillTool}
        shortcut="G"
        onContextToggle={onFillMenuToggle}
        onPrimaryClick={() => {
          onToolMenusClose();
          onSetActiveTool(fillTool);
        }}
        onSelect={(value) => {
          onSetFillTool(value);
          onSetActiveTool(value);
          onToolMenusClose();
        }}
      />
      <button
        aria-label="Picker"
        className={activeTool === "picker" ? "tool active" : "tool"}
        data-tooltip="Picker · I"
        title="Picker · I"
        type="button"
        onClick={() => {
          onToolMenusClose();
          onSetActiveTool("picker");
        }}
      >
        <Pipette aria-hidden="true" />
      </button>
      <button
        aria-label="Color"
        className="tool color-tool"
        data-tooltip="Color · C"
        title="Color · C"
        type="button"
        onClick={onColorToggle}
      >
        <Palette aria-hidden="true" />
        <span
          aria-hidden="true"
          className="color-swatch"
          style={{ backgroundColor: currentColor }}
        />
      </button>
      <button
        aria-pressed={isGridVisible}
        aria-label="Grid"
        className={isGridVisible ? "tool active" : "tool"}
        data-tooltip="Grid"
        title="Grid"
        type="button"
        onClick={onGridToggle}
      >
        <Grid3X3 aria-hidden="true" />
      </button>
      <button
        aria-pressed={isReferenceOpen}
        aria-label="Reference"
        className={isReferenceOpen ? "tool active" : "tool"}
        data-tooltip="Reference · R"
        title="Reference · R"
        type="button"
        onClick={onReferenceToggle}
      >
        <ImageIcon aria-hidden="true" />
      </button>
    </div>
  );
};
