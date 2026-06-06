import type {
  EditorDocument,
  EditorMaskLayer,
} from "@retrodex/contracts";

import type { AnimationFrame, MaskLayer, Size } from "./types";

const viteEnv = (import.meta as unknown as { env?: { VITE_API_URL?: string } })
  .env;
const apiBase = viteEnv?.VITE_API_URL ?? "http://127.0.0.1:5175";

export interface EditorSessionParams {
  frameId: string | null;
  runId: string | null;
}

export const getEditorSessionParams = (): EditorSessionParams => {
  const params = new URLSearchParams(window.location.search);
  return {
    frameId: params.get("frameId"),
    runId: params.get("runId"),
  };
};

const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
};

export const fetchEditorDocument = async (
  runId: string
): Promise<EditorDocument> => {
  const result = await requestJson<{ document: EditorDocument }>(
    `/runs/${runId}/editor`
  );
  return result.document;
};

export const saveEditorDocument = async (
  document: EditorDocument,
  options: { expectedRevision?: number; writeFrameImages?: boolean } = {}
): Promise<EditorDocument> => {
  const params = new URLSearchParams();
  if (options.writeFrameImages === false) {
    params.set("writeFrames", "false");
  }
  const query = params.size ? `?${params.toString()}` : "";
  const result = await requestJson<{ document: EditorDocument }>(
    `/runs/${document.runId}/editor${query}`,
    {
      body: JSON.stringify(
        options.expectedRevision === undefined
          ? document
          : { document, expectedRevision: options.expectedRevision }
      ),
      method: "PUT",
    }
  );
  return result.document;
};

export const saveEditorFramePixels = ({
  expectedRevision,
  frame,
  runId,
}: {
  expectedRevision?: number;
  frame: AnimationFrame;
  runId: string;
}) =>
  requestJson<{
    alphaBBox: unknown;
    frameId: string;
    grid: { cells: AnimationFrame["grid"]; size: Size };
    previewUrl: string;
  }>(`/runs/${runId}/editor/frames/${frame.id}/pixels`, {
    body: JSON.stringify({
      expectedRevision,
      grid: {
        cells: frame.grid,
        size: frame.size,
      },
    }),
    method: "PUT",
  });

export const saveEditorFrameGrid = ({
  expectedRevision,
  frame,
  runId,
}: {
  expectedRevision?: number;
  frame: AnimationFrame;
  runId: string;
}) =>
  requestJson<{
    frameId: string;
    lastSavedAt: string;
    nonempty: number;
    revision: number;
  }>(`/runs/${runId}/editor/frames/${frame.id}/grid`, {
    body: JSON.stringify({
      expectedRevision,
      grid: {
        cells: frame.grid,
        size: frame.size,
      },
    }),
    method: "PUT",
  });

export const createBackendExport = ({
  fps,
  name,
  runId,
  targets,
}: {
  fps: number;
  name: string;
  runId: string;
  targets: string[];
}) =>
  requestJson<{ job: { id: string; status: string } }>(
    `/runs/${runId}/exports`,
    {
      body: JSON.stringify({ fps, name, targets }),
      method: "POST",
    }
  );

export const writeLocalExportFiles = ({
  directoryPath,
  files,
}: {
  directoryPath: string;
  files: { contentBase64: string; filename: string }[];
}) =>
  requestJson<{
    directoryPath: string;
    files: { filename: string; path: string; size: number }[];
  }>("/local-exports", {
    body: JSON.stringify({ directoryPath, files }),
    method: "POST",
  });

export const documentFramesToEditorFrames = (
  document: EditorDocument
): AnimationFrame[] =>
  document.frames.map((frame) => ({
    grid: frame.grid.cells,
    id: frame.frameId,
    size: frame.grid.size,
  }));

export const documentMasksToEditorMasks = (
  document: EditorDocument
): MaskLayer[] =>
  document.masks.map((layer) => ({
    aliases: layer.aliases,
    anchor: layer.anchor,
    color: layer.color,
    id: layer.id,
    mask: layer.mask,
    name: layer.name,
    parentId: layer.parentId,
    partKind: layer.partKind,
    promptHint: layer.promptHint,
    regenerationPolicy: layer.regenerationPolicy,
    semanticLabel: layer.semanticLabel,
    semanticRole: layer.semanticRole,
    visible: layer.visible,
  }));

export const editorMasksToDocumentMasks = (
  layers: MaskLayer[]
): EditorMaskLayer[] =>
  layers.map((layer) => ({
    aliases: layer.aliases ?? [],
    anchor: layer.anchor,
    color: layer.color,
    id: layer.id,
    mask: layer.mask,
    name: layer.name,
    parentId: layer.parentId,
    partKind: layer.partKind ?? layer.semanticLabel ?? layer.name,
    promptHint: layer.promptHint ?? "",
    regenerationPolicy: layer.regenerationPolicy ?? {
      allowImagegenReference: true,
      allowRegenerate: true,
      locked: false,
      preservePalette: true,
    },
    semanticLabel: layer.semanticLabel ?? layer.name,
    semanticRole: layer.semanticRole ?? "unknown",
    visible: layer.visible,
  }));

const cellColorToPaletteHex = (color: string): string | null => {
  const hex = color.match(/^#[0-9a-f]{6}$/iu);
  if (hex) {
    return color.toLowerCase();
  }
  const rgba = color.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/iu
  );
  if (!rgba) {
    return null;
  }
  const [red, green, blue] = rgba.slice(1, 4).map((value) =>
    Math.max(0, Math.min(255, Number(value)))
      .toString(16)
      .padStart(2, "0")
  );
  return `#${red}${green}${blue}`;
};

export const getFramePalette = (frame: AnimationFrame) =>
  [
    ...new Set(
      frame.grid.flatMap((color) => {
        const paletteColor = color ? cellColorToPaletteHex(color) : null;
        return paletteColor ? [paletteColor] : [];
      })
    ),
  ].slice(0, 32);

export const createEditorDocumentSnapshot = ({
  activeMaskLayerId,
  baseDocument,
  canvasSize,
  fps,
  frames,
  maskLayers,
  selectedFrameId,
}: {
  activeMaskLayerId: string;
  baseDocument: EditorDocument;
  canvasSize: Size;
  fps: number;
  frames: AnimationFrame[];
  maskLayers: MaskLayer[];
  selectedFrameId: string;
}): EditorDocument => ({
  ...baseDocument,
  activeMaskLayerId: activeMaskLayerId || null,
  canvas: canvasSize,
  frames: frames.map((frame, index) => {
    const original =
      baseDocument.frames.find((item) => item.frameId === frame.id) ??
      baseDocument.frames[index];
    return {
      alphaBBox: original?.alphaBBox ?? null,
      anchor: original?.anchor ?? {
        mode: "center",
        x: frame.size.width / 2,
        y: frame.size.height / 2,
      },
      frameId: frame.id,
      grid: {
        cells: frame.grid,
        palette: getFramePalette(frame),
        size: frame.size,
      },
      name: original?.name ?? `Frame ${index + 1}`,
      sourcePath: original?.sourcePath ?? null,
    };
  }),
  masks: editorMasksToDocumentMasks(maskLayers),
  saveState: {
    ...baseDocument.saveState,
    dirty: true,
  },
  selectedFrameId,
  timeline: {
    ...baseDocument.timeline,
    fps,
    framesList: frames.map((frame) => frame.id),
  },
});
