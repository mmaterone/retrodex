import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

import {
  animationDraftSchema,
  animationFixRequestSchema,
  animationFixPreviewSchema,
  animationFixResultSchema,
  animationInspectionSchema,
  assetPlanSchema,
  deterministicPresets,
  agentProjectMemorySchema,
  applyImagegenResultRequestSchema,
  createEditorCheckpointRequestSchema,
  createImagegenRequestSchema,
  editorDocumentSchema,
  editorCheckpointSchema,
  editorOperationLogEntrySchema,
  editorSelectionStateSchema,
  editIntentPreviewSchema,
  editIntentRequestSchema,
  editorOperationsRequestSchema,
  exportTargetSchema,
  frameSchema,
  imagegenRequestArtifactSchema,
  imagegenApplyPreviewSchema,
  imagegenResultArtifactSchema,
  imagegenResultInspectionSchema,
  maskIntelligenceReportSchema,
  createPartReferenceRequestSchema,
  partReferencePackageSchema,
  partRegenerationDraftSchema,
  partRegenerationRequestSchema,
  recordImagegenResultRequestSchema,
  revertEditorCheckpointRequestSchema,
  revertEditorOperationRequestSchema,
  pixelGridWriteRequestSchema,
  runSchema,
  savedAnimationSchema,
  schemaVersion,
  selectPreset,
  visualSummarySchema,
} from "@retrodex/contracts";
import type {
  AnimationDraft,
  AnimationFixPreview,
  AnimationFixResult,
  AnimationInspection,
  BBox,
  AgentProjectMemory,
  CheckpointComparison,
  EditorCheckpoint,
  EditorDocument,
  EditIntentPreview,
  EditorMaskLayer,
  EditorOperation,
  EditorOperationLogEntry,
  EditorSelectionState,
  FrameVisualInspection,
  Frame,
  ImagegenRequestArtifact,
  ImagegenApplyPreview,
  ImagegenResultArtifact,
  ImagegenResultInspection,
  MaskIntelligenceReport,
  PartReferencePackage,
  PartRegenerationDraft,
  PixelCell,
  PixelGrid,
  Run,
  SavedAnimation,
  VisualSummary,
} from "@retrodex/contracts";
import { z } from "zod";

import { readJsonFile, writeJsonAtomic } from "./json.js";
import { resolveRunsDir } from "./paths.js";
import { ApiError } from "./errors.js";

/* eslint-disable class-methods-use-this */

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export const jobSchema = z.object({
  cancelledAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  currentFrameId: z.string().nullable(),
  currentStepId: z.string().nullable(),
  error: z
    .object({
      code: z.string(),
      details: z.unknown().optional(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
  frames: z.array(frameSchema),
  id: z.string().min(1),
  progress: z.object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  retryHints: z.array(z.string()),
  runId: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  type: z.enum(["cleanup", "export"]),
  updatedAt: z.string().datetime({ offset: true }),
});

export type PersistentJob = z.infer<typeof jobSchema>;

const sourceFrameSchema = z.object({
  gridStrategy: z
    .enum(["infer-hidden-grid", "preserve-source", "resize-to-run-canvas"])
    .default("infer-hidden-grid"),
  name: z.string().min(1).optional(),
  path: z.string().min(1),
});

const sourceSheetSchema = z.object({
  count: z.number().int().positive().optional(),
  frameHeight: z.number().int().positive(),
  frameWidth: z.number().int().positive(),
  path: z.string().min(1),
});

const autoSliceSheetSchema = z.object({
  alphaThreshold: z.number().int().positive().optional(),
  minAreaFrac: z.number().positive().optional(),
  pad: z.number().int().nonnegative().optional(),
  path: z.string().min(1),
});

export const createRunInputSchema = z.object({
  asset: assetPlanSchema,
  canvas: z
    .object({
      height: z.number().int().positive(),
      width: z.number().int().positive(),
    })
    .optional(),
  importRunPath: z.string().min(1).optional(),
  name: z.string().min(1),
  presetId: z.string().min(1).optional(),
  sourceFrames: z.array(sourceFrameSchema).default([]),
  sourceSheet: sourceSheetSchema.optional(),
});

export const addFrameInputSchema = z.union([
  z.object({
    frame: sourceFrameSchema,
    mode: z.literal("copy-frame").default("copy-frame"),
  }),
  z.object({
    mode: z.literal("split-sheet"),
    sheet: sourceSheetSchema,
  }),
  z.object({
    mode: z.literal("auto-slice-components"),
    sheet: autoSliceSheetSchema,
  }),
]);

export const approveFrameInputSchema = z.object({
  approved: z.boolean().default(true),
  approvedBy: z.enum(["user", "agent", "system"]).default("user"),
  note: z.string().min(1).optional(),
});

export const createExportInputSchema = z.object({
  fps: z.number().int().positive().optional(),
  name: z.string().min(1),
  targets: z.array(exportTargetSchema).default(["raw-frames", "game-strip"]),
});

export type CreateExportInput = z.infer<typeof createExportInputSchema>;
export type CreateRunInput = z.infer<typeof createRunInputSchema>;

const nowIso = (): string => new Date().toISOString();

const defaultMaskColor = "#4da3ff";

const parsePixelCell = (
  color: PixelCell
): null | { alpha: number; blue: number; green: number; red: number } => {
  if (!color) {
    return null;
  }
  if (color.startsWith("#")) {
    return {
      alpha: color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) : 255,
      blue: Number.parseInt(color.slice(5, 7), 16),
      green: Number.parseInt(color.slice(3, 5), 16),
      red: Number.parseInt(color.slice(1, 3), 16),
    };
  }
  const match = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*(\d*\.?\d+)\)/u.exec(color);
  if (!match) {
    return null;
  }
  return {
    alpha: Math.round(Number.parseFloat(match[4] ?? "1") * 255),
    blue: Number.parseInt(match[3] ?? "0", 10),
    green: Number.parseInt(match[2] ?? "0", 10),
    red: Number.parseInt(match[1] ?? "0", 10),
  };
};

const luminance = (color: PixelCell): number => {
  const rgba = parsePixelCell(color);
  if (!rgba) {
    return 255;
  }
  return rgba.red * 0.2126 + rgba.green * 0.7152 + rgba.blue * 0.0722;
};

const bboxFromPoints = (points: { x: number; y: number }[]): BBox | null => {
  if (!points.length) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    height: maxY - minY + 1,
    width: maxX - minX + 1,
    x: minX,
    y: minY,
  };
};

const cellIndex = (
  size: { height: number; width: number },
  x: number,
  y: number
): number => y * size.width + x;

const interpolateCells = (
  from: { x: number; y: number },
  to: { x: number; y: number }
): { x: number; y: number }[] => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) {
    return [{ x: Math.round(from.x), y: Math.round(from.y) }];
  }
  const cells: { x: number; y: number }[] = [];
  for (let step = 0; step <= steps; step += 1) {
    cells.push({
      x: Math.round(from.x + (dx * step) / steps),
      y: Math.round(from.y + (dy * step) / steps),
    });
  }
  return cells;
};

const dragBounds = (
  from: { x: number; y: number },
  to: { x: number; y: number }
): BBox => ({
  height: Math.abs(to.y - from.y) + 1,
  width: Math.abs(to.x - from.x) + 1,
  x: Math.min(from.x, to.x),
  y: Math.min(from.y, to.y),
});

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 64) || "run";

const createId = (name: string): string =>
  `run_${slugify(name)}_${Date.now().toString(36)}`;

const isRun = (value: Run | null): value is Run => value !== null;

const assertPngReadable = async (path: string): Promise<void> => {
  await access(path);
  const handle = await readFile(path);
  const pngSignature = "89504e470d0a1a0a";
  if (handle.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error(`Source is not a readable PNG: ${path}`);
  }
};

const safeResolveInside = (root: string, ...parts: string[]): string => {
  const target = resolve(root, ...parts);
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes run root: ${target}`);
  }
  return target;
};

const normalizeMaskLookupText = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

const compactMaskLookupText = (value: string): string =>
  normalizeMaskLookupText(value).replace(/\s+/g, "");

export class RunRepository {
  readonly runsDir: string;

  constructor(rootDir = resolveRunsDir(process.env.RUNS_DIR)) {
    this.runsDir = rootDir;
  }

  async addFrame(runId: string, inputValue: unknown): Promise<Run> {
    const input = addFrameInputSchema.parse(inputValue);
    const run = await this.readRun(runId);
    if (input.mode === "split-sheet") {
      return this.addSheetFrames(run, input.sheet);
    }
    if (input.mode === "auto-slice-components") {
      return this.addAutoSlicedFrames(run, input.sheet);
    }
    const frameId = this.nextFrameId(run);
    const { framePath, materialization } = await this.copySourceFrame(
      run,
      input.frame.path,
      frameId,
      input.frame.gridStrategy
    );
    const { readPixelGridWithPython } = await import("./python-worker.js");
    const pixelGrid = await readPixelGridWithPython(framePath);
    await this.writeFrame(run, {
      alphaBBox: pixelGrid.alphaBBox,
      anchor: {
        mode: "center",
        x: Math.floor(pixelGrid.grid.size.width / 2),
        y: Math.floor(pixelGrid.grid.size.height / 2),
      },
      approved: false,
      approvedAt: null,
      canvas: pixelGrid.grid.size,
      id: frameId,
      index: run.activeFrameIds.length,
      name: input.frame.name ?? `Frame ${run.activeFrameIds.length + 1}`,
      palette: {
        colors: pixelGrid.grid.palette,
        lockedTo: null,
      },
      path: framePath,
      qc: {
        blockingIssues: pixelGrid.alphaBBox ? [] : ["empty-frame"],
        passes: Boolean(pixelGrid.alphaBBox),
        retryHints: pixelGrid.alphaBBox
          ? []
          : ["Provide a PNG with at least one visible pixel."],
        warnings: [],
      },
      schemaVersion,
      source: {
        inputPath: input.frame.path,
        kind: "imported",
      },
    });
    const nextRun = await this.writeRun({
      ...run,
      activeFrameIds: [...run.activeFrameIds, frameId],
      canvas:
        run.activeFrameIds.length === 0 ? pixelGrid.grid.size : run.canvas,
      qc: {
        ...run.qc,
        passes: true,
        retryHints: [],
      },
      status: "raw-ready",
    });
    await writeJsonAtomic(
      join(run.paths.pipelineDir, `ingest-${frameId}.json`),
      {
        frameId,
        gridStrategy: input.frame.gridStrategy,
        materialization,
        mode: "copy-frame",
        sourcePath: input.frame.path,
        storedPath: framePath,
      }
    );
    return nextRun;
  }

  async createRun(inputValue: unknown): Promise<Run> {
    const input = createRunInputSchema.parse(inputValue);
    if (input.importRunPath) {
      return this.importRun(input);
    }

    const autoPreset = selectPreset(input.asset.type, input.asset.action);
    const selectedPreset = input.presetId ?? autoPreset.id;
    const preset =
      selectedPreset in deterministicPresets
        ? deterministicPresets[
            selectedPreset as keyof typeof deterministicPresets
          ]
        : autoPreset;
    const canvasSize = input.canvas ?? {
      height: preset.exportDefaults.canvasSize,
      width: preset.exportDefaults.canvasSize,
    };
    const id = createId(input.name);
    const paths = this.createRunPaths(id);

    await this.ensureRunDirs(paths);

    const timestamp = nowIso();
    let run = runSchema.parse({
      activeFrameIds: [],
      approval: {
        approvedFrames: [],
        updatedAt: null,
      },
      asset: input.asset,
      canvas: canvasSize,
      createdAt: timestamp,
      id,
      name: input.name,
      palettePath: null,
      paths,
      presetId: selectedPreset,
      qc: {
        blockingIssues: [],
        passes: false,
        retryHints: ["Add at least one source frame before cleanup."],
        warnings: [],
      },
      schemaVersion,
      status: "planned",
      updatedAt: timestamp,
    });

    await this.writeRun(run);
    for (const sourceFrame of input.sourceFrames) {
      run = await this.addFrame(run.id, {
        frame: sourceFrame,
        mode: "copy-frame",
      });
    }
    if (input.sourceSheet) {
      run = await this.addSheetFrames(run, input.sourceSheet);
    }

    await writeJsonAtomic(join(paths.pipelineDir, "create-run.json"), {
      createdAt: timestamp,
      ingest: {
        sourceFrameCount: input.sourceFrames.length,
        sourceSheet: input.sourceSheet ?? null,
      },
    });

    return run;
  }

  async createJob(
    runId: string,
    type: PersistentJob["type"]
  ): Promise<PersistentJob> {
    const run = await this.readRun(runId);
    const timestamp = nowIso();
    const job = jobSchema.parse({
      cancelledAt: null,
      completedAt: null,
      createdAt: timestamp,
      currentFrameId: null,
      currentStepId: null,
      error: null,
      frames: [],
      id: `job_${type}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      progress: { done: 0, total: run.activeFrameIds.length },
      retryHints: [],
      runId,
      startedAt: null,
      status: "queued",
      type,
      updatedAt: timestamp,
    });
    await this.writeJob(job);
    return job;
  }

  async listJobs(runId?: string): Promise<PersistentJob[]> {
    const runs = runId ? [await this.readRun(runId)] : await this.listRuns();
    const jobs = await Promise.all(
      runs.map(async (run) => {
        const jobsDir = safeResolveInside(run.paths.root, "jobs");
        try {
          const entries = await readdir(jobsDir);
          const jobFiles = entries.filter((entry) => entry.endsWith(".json"));
          return Promise.all(
            jobFiles.map((entry) => this.readJobByPath(join(jobsDir, entry)))
          );
        } catch {
          return [];
        }
      })
    );
    return jobs
      .flat()
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listRuns(): Promise<Run[]> {
    await mkdir(this.runsDir, { recursive: true });
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.readRun(entry.name);
          } catch {
            return null;
          }
        })
    );
    return runs
      .filter(isRun)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listExports(run: Run): Promise<SavedAnimation[]> {
    const exportsRoot = safeResolveInside(run.paths.root, "saved-animations");
    try {
      const entries = await readdir(exportsRoot, { withFileTypes: true });
      const exports = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            try {
              return await this.readExport(run, entry.name);
            } catch {
              return null;
            }
          })
      );
      return exports
        .filter((item): item is SavedAnimation => item !== null)
        .toSorted((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
        );
    } catch {
      return [];
    }
  }

  async applyEditorOperations(
    runId: string,
    inputValue: unknown
  ): Promise<EditorDocument> {
    const input = editorOperationsRequestSchema.parse(inputValue);
    const beforeDocument = await this.readEditorDocument(runId);
    this.assertExpectedEditorRevision(beforeDocument, input.expectedRevision);
    let document = beforeDocument;
    for (const operation of input.operations) {
      document = await this.applyEditorOperation(document, operation);
    }
    const nextDocument = await this.writeEditorDocument(document);
    await this.recordEditorOperationFromDocuments(runId, {
      afterDocument: nextDocument,
      beforeDocument,
      label: "Editor operations",
      operationType: "editor-operations",
      reason: `${input.operations.length} editor operation(s) applied.`,
      source: "api",
    });
    return nextDocument;
  }

  async readEditorSelection(runId: string): Promise<EditorSelectionState> {
    const document = await this.readEditorDocument(runId);
    return editorSelectionStateSchema.parse({
      activeMaskLayerId:
        document.selection.activeMaskLayerId ?? document.activeMaskLayerId,
      selectedBounds: document.selection.selectedBounds,
      selectedFrameId:
        document.selection.selectedFrameId ?? document.selectedFrameId,
      selectedMaskLayerIds: document.selection.selectedMaskLayerIds,
      selectedPixelsMask: document.selection.selectedPixelsMask,
      transformTarget: document.selection.transformTarget,
    });
  }

  async writeEditorSelection(
    runId: string,
    inputValue: unknown
  ): Promise<{
    document: EditorDocument;
    selection: EditorSelectionState;
  }> {
    const input = z
      .object({
        expectedRevision: z.number().int().nonnegative().optional(),
        selection: editorSelectionStateSchema,
      })
      .parse(inputValue);
    const document = await this.readEditorDocument(runId);
    this.assertExpectedEditorRevision(document, input.expectedRevision);
    const selection = editorSelectionStateSchema.parse(input.selection);
    const nextDocument = await this.writeEditorDocument(
      {
        ...document,
        activeMaskLayerId:
          selection.activeMaskLayerId ?? document.activeMaskLayerId,
        selectedFrameId: selection.selectedFrameId ?? document.selectedFrameId,
        selection,
      },
      { writeFrameImages: false }
    );
    return { document: nextDocument, selection: nextDocument.selection };
  }

  async readEditorStatus(runId: string): Promise<{
    activeMaskLayerId: null | string;
    canvas: EditorDocument["canvas"];
    editorPath: string;
    frameCount: number;
    maskCount: number;
    runId: string;
    saveState: EditorDocument["saveState"];
    selectedFrameId: null | string;
    timeline: EditorDocument["timeline"];
    updatedAt: string;
  }> {
    const run = await this.readRun(runId);
    const document = await this.readEditorDocument(runId);
    return {
      activeMaskLayerId: document.activeMaskLayerId,
      canvas: document.canvas,
      editorPath: this.editorDocumentPath(run),
      frameCount: document.frames.length,
      maskCount: document.masks.length,
      runId,
      saveState: document.saveState,
      selectedFrameId: document.selectedFrameId,
      timeline: document.timeline,
      updatedAt: document.updatedAt,
    };
  }

  async previewEditorExport(
    runId: string,
    inputValue: unknown
  ): Promise<{
    files: {
      contentBase64: string;
      filename: string;
      mediaType: string;
      size: number;
    }[];
    formats: string[];
    frameIds: string[];
    revision: number;
    warnings: string[];
  }> {
    const input = z
      .object({
        expectedRevision: z.number().int().nonnegative().optional(),
        formats: z
          .array(
            z.enum([
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
            ])
          )
          .default(["json", "svg"]),
        fps: z.number().int().positive().default(8),
        frameId: z.string().min(1).optional(),
        scale: z.number().int().positive().default(1),
        scope: z.enum(["animation", "frame"]).default("animation"),
      })
      .parse(inputValue);
    const document = await this.readEditorDocument(runId);
    this.assertExpectedEditorRevision(document, input.expectedRevision);
    const frames =
      input.scope === "frame"
        ? document.frames.filter(
            (frame) => frame.frameId === (input.frameId ?? document.selectedFrameId)
          )
        : document.timeline.framesList.flatMap((frameId) =>
            document.frames.filter((frame) => frame.frameId === frameId)
          );
    if (!frames.length) {
      throw new Error("No editor frames available for export preview.");
    }
    const files: {
      contentBase64: string;
      filename: string;
      mediaType: string;
      size: number;
    }[] = [];
    const warnings: string[] = [];
    const addTextFile = (
      filename: string,
      mediaType: string,
      content: string
    ): void => {
      const buffer = Buffer.from(content, "utf-8");
      files.push({
        contentBase64: buffer.toString("base64"),
        filename,
        mediaType,
        size: buffer.byteLength,
      });
    };
    const baseName = `retrodex-preview-${Date.now().toString(36)}`;
    for (const format of input.formats) {
      if (format === "json") {
        addTextFile(
          `${baseName}.saved-animation.json`,
          "application/json",
          JSON.stringify(
            {
              canvas: document.canvas,
              createdAt: nowIso(),
              fps: input.fps,
              frames: frames.map((frame, index) => ({
                frameId: frame.frameId,
                grid: frame.grid,
                index,
              })),
              revision: document.saveState.revision,
              scale: input.scale,
              schemaVersion: "editor-export-preview.v1",
              scope: input.scope,
            },
            null,
            2
          )
        );
      } else if (format === "svg") {
        addTextFile(
          `${baseName}.svg`,
          "image/svg+xml",
          this.editorFramesToSvg(frames, input.scale, input.fps)
        );
      } else if (format === "lottie") {
        addTextFile(
          `${baseName}.lottie.json`,
          "application/json",
          JSON.stringify(
            this.editorFramesToLottie(frames, input.scale, input.fps),
            null,
            2
          )
        );
      } else if (format === "react") {
        addTextFile(
          `${baseName}.tsx`,
          "text/plain",
          this.editorFramesToReact(frames, input.scale)
        );
      } else if (format === "css") {
        addTextFile(
          `${baseName}.css`,
          "text/css",
          this.editorFramesToCss(frames, input.scale, input.fps)
        );
      } else {
        warnings.push(
          `${format} preview needs raster encoding; create an export job for exact bytes.`
        );
      }
    }
    return {
      files,
      formats: input.formats,
      frameIds: frames.map((frame) => frame.frameId),
      revision: document.saveState.revision,
      warnings,
    };
  }

  async readDraft(run: Run): Promise<AnimationDraft | null> {
    const path = this.draftPath(run);
    try {
      return animationDraftSchema.parse(await readJsonFile(path));
    } catch {
      return null;
    }
  }

  async importApprovedFramesToEditor(runId: string): Promise<EditorDocument> {
    const run = await this.readRun(runId);
    const approvedFrameIds = run.approval.approvedFrames.map(
      (item) => item.frameId
    );
    if (!approvedFrameIds.length) {
      throw new Error("Editor import requires at least one approved frame.");
    }
    const frames = await Promise.all(
      approvedFrameIds.map((frameId) =>
        this.editorFrameFromRunFrame(run, frameId)
      )
    );
    const draft = await this.readDraft(run);
    const rigMasks = this.maskLayersFromDraft(run, draft);
    const timestamp = nowIso();
    const document = editorDocumentSchema.parse({
      activeMaskLayerId: rigMasks[0]?.id ?? null,
      canvas: run.canvas,
      createdAt: timestamp,
      frames,
      masks: rigMasks,
      runId: run.id,
      saveState: {
        dirty: false,
        lastSavedAt: timestamp,
        revision: 0,
      },
      schemaVersion,
      selectedFrameId: frames[0]?.frameId ?? null,
      timeline: {
        fps: draft?.fps ?? 8,
        framesList: frames.map((frame) => frame.frameId),
        isPlaying: false,
      },
      updatedAt: timestamp,
    });
    return this.writeEditorDocument(document);
  }

  async readEditorDocument(runId: string): Promise<EditorDocument> {
    const run = await this.readRun(runId);
    try {
      return editorDocumentSchema.parse(
        await readJsonFile(this.editorDocumentPath(run))
      );
    } catch {
      return this.importApprovedFramesToEditor(runId);
    }
  }

  async readExport(run: Run, exportId: string): Promise<SavedAnimation> {
    return savedAnimationSchema.parse(
      await readJsonFile(this.exportJsonPath(run, exportId))
    );
  }

  async readFrame(run: Run, frameId: string): Promise<Frame> {
    return frameSchema.parse(
      await readJsonFile(this.frameJsonPath(run, frameId))
    );
  }

  async readPixelGrid(
    runId: string,
    frameId: string
  ): Promise<{
    alphaBBox: Frame["alphaBBox"];
    frameId: string;
    grid: PixelGrid;
    previewUrl: string;
  }> {
    const run = await this.readRun(runId);
    const { readPixelGridWithPython } = await import("./python-worker.js");
    const result = await readPixelGridWithPython(
      this.framePngPath(run, frameId)
    );
    return {
      alphaBBox: result.alphaBBox,
      frameId,
      grid: result.grid,
      previewUrl: `/runs/${runId}/frames/${frameId}/image`,
    };
  }

  async inspectEditorFrame(
    runId: string,
    frameId: string
  ): Promise<FrameVisualInspection> {
    const document = await this.readEditorDocument(runId);
    const frame = document.frames.find((item) => item.frameId === frameId);
    if (!frame) {
      throw new Error(`Editor frame not found: ${frameId}`);
    }
    return this.inspectFrameDocument(document, frame);
  }

  async readVisualSummary(runId: string): Promise<VisualSummary> {
    const document = await this.readEditorDocument(runId);
    const frames = document.frames.map((frame) =>
      this.inspectFrameDocument(document, frame)
    );
    const movingRegions = this.detectAnimationMotion(document);
    const stableMaskLayerIds = document.masks
      .filter(
        (layer) => !movingRegions.some((item) => item.maskLayerId === layer.id)
      )
      .map((layer) => layer.id);
    return visualSummarySchema.parse({
      animation: {
        frameCount: document.frames.length,
        frameIds: document.timeline.framesList,
        movingRegions,
        stableMaskLayerIds,
        summary:
          document.frames.length > 1
            ? `${document.frames.length} frame animation with ${movingRegions.length} detected changing region(s).`
            : "Single-frame sprite; no temporal motion to inspect.",
      },
      frames,
      runId,
      schemaVersion,
      updatedAt: nowIso(),
    });
  }

  async inspectAnimation(runId: string): Promise<AnimationInspection> {
    const document = await this.readEditorDocument(runId);
    return this.inspectAnimationDocument(document);
  }

  private inspectAnimationDocument(
    document: EditorDocument
  ): AnimationInspection {
    const orderedFrames = this.orderedEditorFrames(document);
    const frameDiffs = this.diffOrderedFrames(orderedFrames);
    const loopDiff =
      orderedFrames.length > 1
        ? this.diffFrames(
            orderedFrames.at(-1) ?? orderedFrames[0],
            orderedFrames[0] ?? orderedFrames.at(-1)
          )
        : null;
    const flickerRegions = this.detectFlickerRegions(orderedFrames);
    const maskMotionTracks = document.masks.map((layer) =>
      this.trackMaskMotion(layer, orderedFrames)
    );
    const diagnostics: AnimationInspection["diagnostics"] = [];
    if (!orderedFrames.length) {
      diagnostics.push({
        code: "empty-animation",
        details: {},
        message: "No frames are available in the editor timeline.",
        severity: "error",
      });
    }
    for (const diff of frameDiffs) {
      if (diff.silhouetteWarning) {
        diagnostics.push({
          code: "silhouette-break",
          details: {
            fromFrameId: diff.fromFrameId,
            toFrameId: diff.toFrameId,
          },
          message: diff.silhouetteWarning,
          severity: "warning",
        });
      }
    }
    if (flickerRegions.length) {
      diagnostics.push({
        code: "flicker-risk",
        details: { regions: flickerRegions.length },
        message: `${flickerRegions.length} flicker-prone region(s) detected.`,
        severity: "warning",
      });
    }
    if (loopDiff && loopDiff.changedRatio > 0.35) {
      diagnostics.push({
        code: "loop-break",
        details: { changedRatio: loopDiff.changedRatio },
        message:
          "Last frame differs strongly from the first frame; loop may pop.",
        severity: "warning",
      });
    }
    for (const track of maskMotionTracks) {
      if (track.averageChangedPixels > 0) {
        diagnostics.push({
          code: "mask-motion",
          details: {
            averageChangedPixels: track.averageChangedPixels,
            maskLayerId: track.maskLayerId,
          },
          message: `${track.semanticLabel || track.maskLayerId} changes across frames.`,
          severity: "info",
        });
      }
    }
    const averageChangedRatio =
      frameDiffs.reduce((sum, diff) => sum + diff.changedRatio, 0) /
      Math.max(1, frameDiffs.length);
    const loopPenalty = loopDiff ? loopDiff.changedRatio * 0.35 : 0;
    const flickerPenalty = Math.min(0.35, flickerRegions.length * 0.08);
    const loopQualityScore = Math.max(
      0,
      Math.min(1, 1 - averageChangedRatio * 0.5 - loopPenalty - flickerPenalty)
    );
    return animationInspectionSchema.parse({
      diagnostics,
      flickerRegions,
      fps: document.timeline.fps,
      frameDiffs,
      frameIds: orderedFrames.map((frame) => frame.frameId),
      loopQualityScore,
      maskMotionTracks,
      recommendations: [
        "Use frameDiffs to locate large motion jumps before editing individual pixels.",
        "Use maskMotionTracks to verify rig parts move intentionally.",
        "Investigate flickerRegions before exporting looping animation.",
      ],
      runId: document.runId,
      schemaVersion,
      summary:
        orderedFrames.length > 1
          ? `${orderedFrames.length} frame animation, ${frameDiffs.length} temporal diff(s), loop score ${loopQualityScore.toFixed(2)}.`
          : "Single-frame sprite; animation inspection is limited.",
      updatedAt: nowIso(),
    });
  }

  async createPartReferencePackage(
    runId: string,
    inputValue: unknown
  ): Promise<PartReferencePackage> {
    const input = createPartReferenceRequestSchema.parse(inputValue);
    const run = await this.readRun(runId);
    const document = await this.readEditorDocument(runId);
    const layer = document.masks.find((item) => item.id === input.maskLayerId);
    if (!layer) {
      throw new Error(`Mask layer not found: ${input.maskLayerId}`);
    }
    if (!layer.regenerationPolicy.allowImagegenReference) {
      throw new Error(
        `Mask layer does not allow imagegen references: ${layer.id}`
      );
    }
    const frame =
      document.frames.find((item) => item.frameId === input.frameId) ??
      document.frames.find(
        (item) => item.frameId === document.selectedFrameId
      ) ??
      document.frames[0];
    if (!frame) {
      throw new Error("Editor document has no frames to reference.");
    }
    const maskPixels = layer.mask.flatMap((enabled, index) =>
      enabled
        ? [
            {
              x: index % document.canvas.width,
              y: Math.floor(index / document.canvas.width),
            },
          ]
        : []
    );
    const bbox = bboxFromPoints(maskPixels);
    if (!bbox) {
      throw new Error(`Mask layer is empty: ${layer.id}`);
    }
    const cropGrid: PixelGrid = {
      cells: Array.from({ length: bbox.width * bbox.height }, (_, index) => {
        const x = bbox.x + (index % bbox.width);
        const y = bbox.y + Math.floor(index / bbox.width);
        const sourceIndex = y * frame.grid.size.width + x;
        return layer.mask[sourceIndex] ? frame.grid.cells[sourceIndex] : null;
      }),
      palette: [],
      size: { height: bbox.height, width: bbox.width },
    };
    const normalizedCropGrid = this.normalizePixelGrid(cropGrid);
    const referenceId = `ref_${layer.id}_${Date.now().toString(36)}`;
    const referenceDir = safeResolveInside(this.editorDir(run), "references");
    await mkdir(referenceDir, { recursive: true });
    const referenceImagePath = safeResolveInside(
      referenceDir,
      `${referenceId}.png`
    );
    const { writePixelGridWithPython } = await import("./python-worker.js");
    await writePixelGridWithPython({
      grid: normalizedCropGrid,
      path: referenceImagePath,
      payloadPath: safeResolveInside(
        run.paths.pipelineDir,
        `reference-${referenceId}.json`
      ),
    });
    const reference = partReferencePackageSchema.parse({
      bbox,
      createdAt: nowIso(),
      exactMaskPixels: maskPixels,
      frameId: frame.frameId,
      fullPreviewUrl: `/runs/${run.id}/frames/${frame.frameId}/image`,
      id: referenceId,
      maskLayerId: layer.id,
      pixelMapUrl: `/runs/${run.id}/editor/frames/${frame.frameId}/pixels`,
      promptHint: layer.promptHint,
      referenceImagePath,
      referenceImageUrl: `/runs/${run.id}/editor/references/${referenceId}/image`,
      runId: run.id,
      aliases: layer.aliases,
      partKind: layer.partKind,
      semanticLabel: layer.semanticLabel || layer.name,
      semanticRole: layer.semanticRole,
    });
    await writeJsonAtomic(
      safeResolveInside(referenceDir, `${referenceId}.json`),
      reference
    );
    return reference;
  }

  async createPartRegenerationDraft(
    runId: string,
    inputValue: unknown
  ): Promise<PartRegenerationDraft> {
    const input = partRegenerationRequestSchema.parse(inputValue);
    const reference = input.referenceId
      ? await this.readPartReferencePackage(runId, input.referenceId)
      : await this.createPartReferencePackage(runId, {
          frameId: input.frameIds[0],
          maskLayerId: input.maskLayerId,
        });
    const run = await this.readRun(runId);
    const regeneration = partRegenerationDraftSchema.parse({
      createdAt: nowIso(),
      id: `regen_${input.maskLayerId}_${Date.now().toString(36)}`,
      input,
      instructions: [
        "Use referenceImageUrl as the precise masked part crop.",
        "Use fullPreviewUrl for whole-sprite context and pixelMapUrl for exact pixel constraints.",
        "Preserve all pixels outside exactMaskPixels.",
        "After imagegen, apply result only through the referenced mask layer.",
      ],
      reference,
      runId,
      status: "ready-for-imagegen",
    });
    await mkdir(safeResolveInside(this.editorDir(run), "regeneration"), {
      recursive: true,
    });
    await writeJsonAtomic(
      safeResolveInside(
        this.editorDir(run),
        "regeneration",
        `${regeneration.id}.json`
      ),
      regeneration
    );
    return regeneration;
  }

  async createImagegenRequest(
    runId: string,
    inputValue: unknown
  ): Promise<ImagegenRequestArtifact> {
    const input = createImagegenRequestSchema.parse(inputValue);
    const run = await this.readRun(runId);
    const regeneration = await this.readPartRegenerationDraft(
      runId,
      input.regenerationId
    );
    const prompt = input.prompt ?? regeneration.input.prompt;
    const requestId = `imgreq_${regeneration.reference.maskLayerId}_${Date.now().toString(36)}`;
    const requestDir = safeResolveInside(this.editorDir(run), "imagegen");
    await mkdir(requestDir, { recursive: true });
    const requestJsonPath = safeResolveInside(requestDir, `${requestId}.json`);
    const imagegenRequest = imagegenRequestArtifactSchema.parse({
      candidateCount: input.candidateCount,
      createdAt: nowIso(),
      frameIds:
        regeneration.input.frameIds.length > 0
          ? regeneration.input.frameIds
          : [regeneration.reference.frameId],
      fullPreviewUrl: regeneration.reference.fullPreviewUrl,
      id: requestId,
      maskLayerId: regeneration.reference.maskLayerId,
      negativePrompt: input.negativePrompt,
      pixelMapUrl: regeneration.reference.pixelMapUrl,
      preserveRules: {
        lockedLayerIds: [],
        preserveOutsideMask: regeneration.input.preserveOutsideMask,
        preservePalette: regeneration.reference.semanticRole !== "unknown",
      },
      prompt,
      reference: regeneration.reference,
      regenerationId: regeneration.id,
      requestJsonPath,
      runId,
      status: "ready-for-imagegen",
    });
    await writeJsonAtomic(requestJsonPath, imagegenRequest);
    return imagegenRequest;
  }

  async recordImagegenResult(
    runId: string,
    inputValue: unknown
  ): Promise<ImagegenResultArtifact> {
    const input = recordImagegenResultRequestSchema.parse(inputValue);
    const run = await this.readRun(runId);
    const imagegenRequest = await this.readImagegenRequest(
      runId,
      input.requestId
    );
    const selectedCandidateId =
      input.selectedCandidateId ?? input.candidates[0]?.id ?? null;
    const selectedCandidate =
      input.candidates.find(
        (candidate) => candidate.id === selectedCandidateId
      ) ?? input.candidates[0];
    const diffSummary = selectedCandidate?.grid
      ? this.diffCandidateAgainstMask(imagegenRequest, selectedCandidate.grid)
      : { changedInsideMask: 0, outsideMaskChangesIgnored: 0 };
    const resultId = `imgres_${imagegenRequest.maskLayerId}_${Date.now().toString(36)}`;
    const resultJsonPath = safeResolveInside(
      this.editorDir(run),
      "imagegen",
      `${resultId}.json`
    );
    const imagegenResult = imagegenResultArtifactSchema.parse({
      appliedAt: null,
      candidates: input.candidates,
      createdAt: nowIso(),
      diffSummary,
      id: resultId,
      notes: input.notes,
      requestId: imagegenRequest.id,
      resultJsonPath,
      runId,
      selectedCandidateId,
      status: selectedCandidateId ? "approved" : "candidate",
    });
    await mkdir(safeResolveInside(this.editorDir(run), "imagegen"), {
      recursive: true,
    });
    await writeJsonAtomic(resultJsonPath, imagegenResult);
    await writeJsonAtomic(imagegenRequest.requestJsonPath, {
      ...imagegenRequest,
      status: "result-recorded",
    });
    return imagegenResult;
  }

  async inspectImagegenResult(
    runId: string,
    resultId: string
  ): Promise<ImagegenResultInspection> {
    const result = await this.readImagegenResult(runId, resultId);
    const request = await this.readImagegenRequest(runId, result.requestId);
    const document = await this.readEditorDocument(runId);
    const candidates = result.candidates.map((candidate) =>
      this.inspectImagegenCandidate(document, request, result, candidate)
    );
    const recommendedCandidateId =
      candidates
        .filter((candidate) =>
          candidate.diagnostics.every(
            (diagnostic) => diagnostic.severity !== "error"
          )
        )
        .toSorted((left, right) => right.score - left.score)[0]?.candidateId ??
      null;
    return imagegenResultInspectionSchema.parse({
      candidates,
      recommendedCandidateId,
      requestId: request.id,
      resultId: result.id,
      runId,
      summary: `${candidates.length} imagegen candidate(s), recommended ${recommendedCandidateId ?? "none"}.`,
      updatedAt: nowIso(),
    });
  }

  async createImagegenComparePreview(
    runId: string,
    resultId: string,
    candidateId: string
  ): Promise<string> {
    const run = await this.readRun(runId);
    const result = await this.readImagegenResult(runId, resultId);
    const request = await this.readImagegenRequest(runId, result.requestId);
    const document = await this.readEditorDocument(runId);
    const candidate = result.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      throw new Error(`Imagegen candidate not found: ${candidateId}`);
    }
    const sourceFrame = this.imagegenSourceFrame(document, candidate.frameId);
    const layer = this.imagegenMaskLayer(document, request.maskLayerId);
    const candidateGrid = candidate.grid;
    const appliedGrid = candidateGrid
      ? this.applyCandidateGridToFrame(
          sourceFrame,
          layer,
          request,
          candidateGrid
        )
      : sourceFrame.grid;
    const compareGrid = this.buildImagegenCompareGrid(
      sourceFrame.grid,
      appliedGrid,
      candidateGrid,
      request
    );
    const previewPath = this.imagegenComparePreviewPath(
      run,
      resultId,
      candidate.id
    );
    await mkdir(
      safeResolveInside(this.editorDir(run), "imagegen", "previews"),
      {
        recursive: true,
      }
    );
    const { writePixelGridWithPython } = await import("./python-worker.js");
    await writePixelGridWithPython({
      grid: compareGrid,
      path: previewPath,
      payloadPath: `${previewPath}.payload.json`,
    });
    return previewPath;
  }

  async previewImagegenApply(
    runId: string,
    resultId: string,
    inputValue: unknown
  ): Promise<ImagegenApplyPreview> {
    const input = applyImagegenResultRequestSchema.parse(inputValue ?? {});
    const result = await this.readImagegenResult(runId, resultId);
    const request = await this.readImagegenRequest(runId, result.requestId);
    const candidateId =
      input.candidateId ??
      result.selectedCandidateId ??
      result.candidates[0]?.id;
    const candidate = result.candidates.find((item) => item.id === candidateId);
    const candidateGrid = candidate?.grid;
    if (!(candidate && candidateGrid)) {
      throw new Error(`Imagegen candidate has no pixel grid: ${candidateId}`);
    }
    const document = await this.readEditorDocument(runId);
    const sourceFrame = this.imagegenSourceFrame(document, candidate.frameId);
    const layer = this.imagegenMaskLayer(document, request.maskLayerId);
    const { patches, ignoredOutsideMaskPixels } =
      this.buildImagegenApplyPatches(
        sourceFrame,
        layer,
        request,
        candidateGrid
      );
    const estimatedDocument = this.applyImagegenPatchesToDocument(
      document,
      candidate.frameId,
      patches
    );
    const estimatedFrame = this.imagegenSourceFrame(
      estimatedDocument,
      candidate.frameId
    );
    return imagegenApplyPreviewSchema.parse({
      beforeInspection: this.inspectFrameDocument(document, sourceFrame),
      candidateId: candidate.id,
      comparePreviewUrl: `/runs/${runId}/editor/imagegen-results/${result.id}/compare/${candidate.id}/image`,
      estimatedAfterInspection: this.inspectFrameDocument(
        estimatedDocument,
        estimatedFrame
      ),
      frameId: candidate.frameId,
      ignoredOutsideMaskPixels,
      patches,
      recommendations: [
        "Review comparePreviewUrl before applying this candidate.",
        "Apply creates a checkpoint and preserves pixels outside the selected mask.",
      ],
      requiresCheckpoint: patches.length > 0,
      resultId: result.id,
      runId,
    });
  }

  async applyImagegenResult(
    runId: string,
    resultId: string,
    inputValue: unknown
  ): Promise<{
    document: EditorDocument;
    imagegenResult: ImagegenResultArtifact;
  }> {
    const preview = await this.previewImagegenApply(
      runId,
      resultId,
      inputValue
    );
    const result = await this.readImagegenResult(runId, resultId);
    const request = await this.readImagegenRequest(runId, result.requestId);
    const document = await this.readEditorDocument(runId);
    const checkpoint = await this.createEditorCheckpoint(runId, {
      label: `Before ${result.id}`,
      reason: `Rollback before applying imagegen candidate ${preview.candidateId}.`,
      source: "imagegen-apply",
    });
    const patchedDocument = this.applyImagegenPatchesToDocument(
      document,
      preview.frameId,
      preview.patches
    );
    const nextDocument = await this.writeEditorDocument({
      ...patchedDocument,
      saveState: {
        ...document.saveState,
        dirty: false,
        revision: document.saveState.revision + 1,
      },
      updatedAt: nowIso(),
    });
    await this.recordEditorOperation(runId, {
      afterDocument: nextDocument,
      beforeDocument: document,
      checkpointId: checkpoint.id,
      label: `Apply imagegen ${preview.candidateId}`,
      operationType: "imagegen-apply",
      patches: preview.patches,
      reason: `Applied imagegen candidate ${preview.candidateId} from ${result.id}.`,
      source: "imagegen-apply",
    });
    const applied = imagegenResultArtifactSchema.parse({
      ...result,
      appliedAt: nowIso(),
      selectedCandidateId: preview.candidateId,
      status: "applied",
    });
    await writeJsonAtomic(applied.resultJsonPath, applied);
    await writeJsonAtomic(request.requestJsonPath, {
      ...request,
      status: "applied",
    });
    return { document: nextDocument, imagegenResult: applied };
  }

  async createEditorCheckpoint(
    runId: string,
    inputValue: unknown
  ): Promise<EditorCheckpoint> {
    const input = createEditorCheckpointRequestSchema.parse(inputValue ?? {});
    const run = await this.readRun(runId);
    const document = await this.readEditorDocument(runId);
    const checkpoint = editorCheckpointSchema.parse({
      createdAt: nowIso(),
      document,
      id: `checkpoint_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      label: input.label,
      reason: input.reason,
      runId,
      schemaVersion,
      source: input.source,
    });
    await mkdir(this.editorCheckpointsDir(run), { recursive: true });
    await writeJsonAtomic(
      this.editorCheckpointPath(run, checkpoint.id),
      checkpoint
    );
    return checkpoint;
  }

  async listEditorCheckpoints(runId: string): Promise<EditorCheckpoint[]> {
    const run = await this.readRun(runId);
    try {
      const files = await readdir(this.editorCheckpointsDir(run));
      const checkpoints = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) =>
            editorCheckpointSchema.parse(
              await readJsonFile(
                safeResolveInside(this.editorCheckpointsDir(run), file)
              )
            )
          )
      );
      return checkpoints.toSorted((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      );
    } catch {
      return [];
    }
  }

  async listEditorOperations(
    runId: string
  ): Promise<EditorOperationLogEntry[]> {
    const run = await this.readRun(runId);
    try {
      const files = await readdir(this.editorOperationsDir(run));
      const operations = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) =>
            editorOperationLogEntrySchema.parse(
              await readJsonFile(
                safeResolveInside(this.editorOperationsDir(run), file)
              )
            )
          )
      );
      return operations.toSorted((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      );
    } catch {
      return [];
    }
  }

  async revertEditorOperation(
    runId: string,
    inputValue: unknown
  ): Promise<{
    document: EditorDocument;
    operation: EditorOperationLogEntry;
    revertOperation: EditorOperationLogEntry;
    rollbackCheckpoint: EditorCheckpoint | null;
  }> {
    const input = revertEditorOperationRequestSchema.parse(inputValue);
    const run = await this.readRun(runId);
    const operation = await this.readEditorOperation(run, input.operationId);
    if (operation.revertedAt) {
      throw new Error(`Editor operation is already reverted: ${operation.id}`);
    }
    const beforeDocument = await this.readEditorDocument(runId);
    const rollbackCheckpoint = input.createRollbackCheckpoint
      ? await this.createEditorCheckpoint(runId, {
          label: `Before reverting ${operation.label}`,
          reason: `Automatic rollback point before reverting operation ${operation.id}.`,
          source: "system",
        })
      : null;
    const inversePatches = operation.patches.map((patch) => ({
      ...patch,
      after: patch.before,
      before: patch.after,
    }));
    const inverseMaskPatches = operation.maskPatches.map((patch) => ({
      ...patch,
      after: patch.before,
      before: patch.after,
    }));
    const patchedDocument = this.applyOperationPatchesToDocument(
      beforeDocument,
      inversePatches,
      inverseMaskPatches
    );
    const document = await this.writeEditorDocument({
      ...patchedDocument,
      saveState: {
        ...beforeDocument.saveState,
        dirty: false,
        revision: beforeDocument.saveState.revision + 1,
      },
      updatedAt: nowIso(),
    });
    const revertOperation = await this.recordEditorOperation(runId, {
      afterDocument: document,
      beforeDocument,
      checkpointId: rollbackCheckpoint?.id ?? null,
      label: `Revert ${operation.label}`,
      maskPatches: inverseMaskPatches,
      operationType: "operation-revert",
      patches: inversePatches,
      reason: `Exact inverse of operation ${operation.id}.`,
      source: "system",
    });
    const revertedOperation = editorOperationLogEntrySchema.parse({
      ...operation,
      revertedAt: nowIso(),
      revertedByOperationId: revertOperation.id,
    });
    await writeJsonAtomic(
      this.editorOperationPath(run, operation.id),
      revertedOperation
    );
    return {
      document,
      operation: revertedOperation,
      revertOperation,
      rollbackCheckpoint,
    };
  }

  async compareEditorCheckpoints(
    runId: string,
    leftCheckpointId: string,
    rightCheckpointId: string
  ): Promise<CheckpointComparison> {
    const run = await this.readRun(runId);
    const left = await this.readEditorCheckpoint(run, leftCheckpointId);
    const right = await this.readEditorCheckpoint(run, rightCheckpointId);
    const frameDiffs = this.diffCheckpointFrames(left.document, right.document);
    const maskDiffs = this.diffCheckpointMasks(left.document, right.document);
    let changedPixels = 0;
    for (const diff of frameDiffs) {
      changedPixels += diff.changedPixels;
    }
    return {
      createdAt: nowIso(),
      frameDiffs,
      leftCheckpointId,
      maskDiffs,
      rightCheckpointId,
      runId,
      schemaVersion,
      summary: {
        changedFrames: frameDiffs.filter((diff) => diff.changedPixels > 0)
          .length,
        changedMasks: maskDiffs.filter((diff) => diff.changedPixels > 0).length,
        changedPixels,
      },
    };
  }

  async revertEditorCheckpoint(
    runId: string,
    inputValue: unknown
  ): Promise<{
    checkpoint: EditorCheckpoint;
    document: EditorDocument;
    rollbackCheckpoint: EditorCheckpoint | null;
  }> {
    const input = revertEditorCheckpointRequestSchema.parse(inputValue);
    const run = await this.readRun(runId);
    const checkpoint = await this.readEditorCheckpoint(run, input.checkpointId);
    const beforeDocument = await this.readEditorDocument(runId);
    const rollbackCheckpoint = input.createRollbackCheckpoint
      ? await this.createEditorCheckpoint(runId, {
          label: `Before revert to ${checkpoint.label}`,
          reason: `Automatic rollback point before reverting to ${checkpoint.id}.`,
          source: "system",
        })
      : null;
    const document = await this.writeEditorDocument({
      ...checkpoint.document,
      saveState: {
        ...checkpoint.document.saveState,
        dirty: false,
        revision: checkpoint.document.saveState.revision + 1,
      },
      updatedAt: nowIso(),
    });
    await this.recordEditorOperationFromDocuments(runId, {
      afterDocument: document,
      beforeDocument,
      checkpointId: rollbackCheckpoint?.id ?? null,
      label: `Revert to ${checkpoint.label}`,
      operationType: "checkpoint-revert",
      reason: `Reverted editor document to checkpoint ${checkpoint.id}.`,
      source: "system",
    });
    return { checkpoint, document, rollbackCheckpoint };
  }

  async previewEditIntent(
    runId: string,
    inputValue: unknown
  ): Promise<EditIntentPreview> {
    const input = editIntentRequestSchema.parse(inputValue);
    const document = await this.readEditorDocument(runId);
    const { intent } = input;
    const frameId =
      intent.frameId ?? document.selectedFrameId ?? document.frames[0]?.frameId;
    if (!frameId) {
      throw new Error("No editor frame is available for edit intent.");
    }
    const frame = document.frames.find((item) => item.frameId === frameId);
    if (!frame) {
      throw new Error(`Editor frame not found: ${frameId}`);
    }
    const targetMask = this.resolveEditIntentMask(document, frame, intent);
    const patches = targetMask.flatMap((enabled, index) => {
      if (!enabled) {
        return [];
      }
      const before = frame.grid.cells[index] ?? null;
      const after = intent.color;
      if (before === after) {
        return [];
      }
      return [
        {
          after,
          before,
          frameId,
          x: index % frame.grid.size.width,
          y: Math.floor(index / frame.grid.size.width),
        },
      ];
    });
    return editIntentPreviewSchema.parse({
      changedPixels: patches.length,
      intent,
      patches,
      recommendations: [
        "Review changedPixels and patches before applying broad edits.",
        "Apply creates a checkpoint before writing pixels.",
      ],
      requiresCheckpoint: true,
      runId,
      targetSummary: this.describeEditIntentTarget(document, intent),
    });
  }

  async applyEditIntent(
    runId: string,
    inputValue: unknown
  ): Promise<{
    checkpoint: EditorCheckpoint;
    document: EditorDocument;
    preview: EditIntentPreview;
  }> {
    const preview = await this.previewEditIntent(runId, inputValue);
    const sourceDocument = await this.readEditorDocument(runId);
    const checkpoint = await this.createEditorCheckpoint(runId, {
      label: `Before ${preview.intent.intent}`,
      reason: `Automatic checkpoint before applying ${preview.intent.intent}.`,
      source: "agent",
    });
    const document =
      preview.patches.length > 0
        ? await this.writeEditorDocument({
            ...this.applyOperationPatchesToDocument(
              sourceDocument,
              preview.patches
            ),
            saveState: {
              ...sourceDocument.saveState,
              dirty: false,
              revision: sourceDocument.saveState.revision + 1,
            },
            updatedAt: nowIso(),
          })
        : sourceDocument;
    await this.recordEditorOperation(runId, {
      afterDocument: document,
      beforeDocument: sourceDocument,
      checkpointId: checkpoint.id,
      label: `Apply ${preview.intent.intent}`,
      operationType: "edit-intent",
      patches: preview.patches,
      reason: preview.targetSummary,
      source: "agent",
    });
    return { checkpoint, document, preview };
  }

  async previewAnimationFix(
    runId: string,
    inputValue: unknown
  ): Promise<AnimationFixPreview> {
    const input = animationFixRequestSchema.parse(inputValue);
    const beforeInspection = await this.inspectAnimation(runId);
    const sourceDocument = await this.readEditorDocument(runId);
    const orderedFrames = this.orderedEditorFrames(sourceDocument).filter(
      (frame) => !input.frameIds || input.frameIds.includes(frame.frameId)
    );
    let patches: AnimationFixResult["appliedPatches"];
    if (input.mode === "fix-flicker") {
      patches = this.buildFlickerFixPatches(sourceDocument, orderedFrames);
    } else if (input.mode === "repair-loop-pop") {
      patches = this.buildLoopRepairPatches(orderedFrames);
    } else {
      patches = this.buildMaskMotionSmoothingPatches(
        sourceDocument,
        orderedFrames,
        input.maskLayerId
      );
    }
    const patchesByFrame = new Map<
      string,
      Map<string, AnimationFixResult["appliedPatches"][number]>
    >();
    for (const patch of patches) {
      const framePatches = patchesByFrame.get(patch.frameId) ?? new Map();
      framePatches.set(this.animationFixPatchKey(patch), patch);
      patchesByFrame.set(patch.frameId, framePatches);
    }
    const appliedPatches = [...patchesByFrame.values()].flatMap(
      (framePatches) => [...framePatches.values()]
    );
    const estimatedDocument = this.applyAnimationFixPatchesToDocument(
      sourceDocument,
      patchesByFrame
    );
    const estimatedAfterInspection =
      this.inspectAnimationDocument(estimatedDocument);
    return animationFixPreviewSchema.parse({
      beforeInspection,
      estimatedAfterInspection,
      mode: input.mode,
      patches: appliedPatches,
      recommendations:
        patches.length > 0
          ? [
              "Review patches before applying this animation fix.",
              "Apply creates a checkpoint before writing pixels.",
            ]
          : ["No deterministic patches are needed for this animation fix."],
      requiresCheckpoint: patches.length > 0,
      runId,
    });
  }

  async applyAnimationFix(
    runId: string,
    inputValue: unknown
  ): Promise<AnimationFixResult> {
    const preview = await this.previewAnimationFix(runId, inputValue);
    const sourceDocument = await this.readEditorDocument(runId);
    const patchesByFrame = new Map<
      string,
      Map<string, AnimationFixResult["appliedPatches"][number]>
    >();
    for (const patch of preview.patches) {
      const framePatches = patchesByFrame.get(patch.frameId) ?? new Map();
      framePatches.set(this.animationFixPatchKey(patch), patch);
      patchesByFrame.set(patch.frameId, framePatches);
    }
    const checkpoint = await this.createEditorCheckpoint(runId, {
      label: `Before ${preview.mode}`,
      reason: `Automatic checkpoint before applying animation fix ${preview.mode}.`,
      source: "agent",
    });
    const patchedDocument = this.applyAnimationFixPatchesToDocument(
      sourceDocument,
      patchesByFrame
    );
    const document =
      preview.patches.length > 0
        ? await this.writeEditorDocument({
            ...patchedDocument,
            saveState: {
              ...sourceDocument.saveState,
              dirty: false,
              revision: sourceDocument.saveState.revision + 1,
            },
            updatedAt: nowIso(),
          })
        : sourceDocument;
    await this.recordEditorOperation(runId, {
      afterDocument: document,
      beforeDocument: sourceDocument,
      checkpointId: checkpoint.id,
      label: `Apply animation fix ${preview.mode}`,
      operationType: "animation-fix",
      patches: preview.patches,
      reason: `Applied deterministic animation fix ${preview.mode}.`,
      source: "agent",
    });
    const afterInspection = await this.inspectAnimation(runId);
    return animationFixResultSchema.parse({
      afterInspection,
      appliedPatches: preview.patches,
      beforeInspection: preview.beforeInspection,
      checkpoint,
      document,
      mode: preview.mode,
      preview,
      recommendations:
        preview.patches.length > 0
          ? [
              "Inspect animation again before export.",
              "Use checkpoint revert if the automatic fix changed intentional motion.",
            ]
          : ["No deterministic patches were needed for this animation fix."],
      runId,
    });
  }

  private applyAnimationFixPatchesToDocument(
    document: EditorDocument,
    patchesByFrame: Map<
      string,
      Map<string, AnimationFixResult["appliedPatches"][number]>
    >
  ): EditorDocument {
    const frames = document.frames.map((frame) => {
      const framePatches = patchesByFrame.get(frame.frameId);
      if (!framePatches) {
        return frame;
      }
      const cells = [...frame.grid.cells];
      for (const patch of framePatches.values()) {
        cells[patch.y * frame.grid.size.width + patch.x] = patch.after;
      }
      return {
        ...frame,
        grid: this.normalizePixelGrid({ ...frame.grid, cells }),
      };
    });
    return {
      ...document,
      frames,
      updatedAt: nowIso(),
    };
  }

  async readAgentProjectMemory(runId: string): Promise<AgentProjectMemory> {
    const run = await this.readRun(runId);
    try {
      await access(this.agentProjectMemoryPath(run));
      return agentProjectMemorySchema.parse(
        await readJsonFile(this.agentProjectMemoryPath(run))
      );
    } catch {
      return this.defaultAgentProjectMemory(run);
    }
  }

  async writeAgentProjectMemory(
    runId: string,
    inputValue: unknown
  ): Promise<AgentProjectMemory> {
    const run = await this.readRun(runId);
    const current = await this.readAgentProjectMemory(runId);
    const input =
      typeof inputValue === "object" && inputValue && "memory" in inputValue
        ? inputValue.memory
        : inputValue;
    const memory = agentProjectMemorySchema.parse({
      ...current,
      ...(typeof input === "object" && input ? input : {}),
      schemaVersion,
      updatedAt: nowIso(),
    });
    await mkdir(this.editorDir(run), { recursive: true });
    await writeJsonAtomic(this.agentProjectMemoryPath(run), memory);
    return memory;
  }

  async readMaskIntelligence(runId: string): Promise<MaskIntelligenceReport> {
    const document = await this.readEditorDocument(runId);
    const selectedFrame =
      document.frames.find(
        (frame) => frame.frameId === document.selectedFrameId
      ) ?? document.frames[0];
    const diagnostics: MaskIntelligenceReport["diagnostics"] = [];
    const suggestions: MaskIntelligenceReport["suggestions"] = [];
    const visibleAlpha = new Set<number>();
    if (selectedFrame) {
      for (const [index, cell] of selectedFrame.grid.cells.entries()) {
        if (cell) {
          visibleAlpha.add(index);
        }
      }
      const visiblePoints = [...visibleAlpha].map((index) => ({
        x: index % selectedFrame.grid.size.width,
        y: Math.floor(index / selectedFrame.grid.size.width),
      }));
      const alphaBBox = bboxFromPoints(visiblePoints);
      if (alphaBBox) {
        const alphaMask = Array.from(
          { length: document.canvas.width * document.canvas.height },
          (_, index) => visibleAlpha.has(index)
        );
        suggestions.push({
          bbox: alphaBBox,
          confidence: 0.72,
          id: "suggest_alpha_silhouette",
          label: "Visible Silhouette",
          mask: alphaMask,
          pixelCount: visibleAlpha.size,
          promptHint: "Whole visible sprite silhouette.",
          role: "body",
          source: "alpha-bbox",
        });
      }
      const components = this.connectedComponents(document.canvas, (index) =>
        visibleAlpha.has(index)
      ).slice(0, 6);
      for (const [index, component] of components.entries()) {
        const bbox = bboxFromPoints(component);
        if (!bbox || component.length < 2) {
          continue;
        }
        suggestions.push({
          bbox,
          confidence: Math.min(0.9, 0.45 + component.length / 256),
          id: `suggest_component_${index + 1}`,
          label: `Part ${index + 1}`,
          mask: Array.from(
            { length: document.canvas.width * document.canvas.height },
            (_, maskIndex) =>
              component.some(
                (point) =>
                  point.x === maskIndex % document.canvas.width &&
                  point.y === Math.floor(maskIndex / document.canvas.width)
              )
          ),
          pixelCount: component.length,
          promptHint:
            "Connected visible region; review before using for targeted regeneration.",
          role: "unknown",
          source: "connected-component",
        });
      }
    }
    const parentIds = new Set(document.masks.map((layer) => layer.id));
    for (const layer of document.masks) {
      const pixels = layer.mask.flatMap((enabled, index) =>
        enabled ? [index] : []
      );
      if (!pixels.length) {
        diagnostics.push({
          code: "empty-mask",
          details: {},
          layerId: layer.id,
          message: `${layer.name} has no selected pixels.`,
          severity: "warning",
        });
      }
      if (layer.semanticRole === "unknown" && pixels.length) {
        diagnostics.push({
          code: "missing-semantic-role",
          details: {},
          layerId: layer.id,
          message: `${layer.name} has pixels but no semantic role.`,
          severity: "info",
        });
      }
      if (layer.parentId && !parentIds.has(layer.parentId)) {
        diagnostics.push({
          code: "parent-not-found",
          details: { parentId: layer.parentId },
          layerId: layer.id,
          message: `${layer.name} references a missing parent mask.`,
          severity: "error",
        });
      }
      const outsideAlpha = selectedFrame
        ? pixels.filter((index) => !visibleAlpha.has(index))
        : [];
      if (outsideAlpha.length) {
        diagnostics.push({
          code: "outside-visible-alpha",
          details: { pixels: outsideAlpha.length },
          layerId: layer.id,
          message: `${layer.name} contains pixels outside the visible sprite alpha.`,
          severity: "warning",
        });
      }
      for (const other of document.masks) {
        if (other.id <= layer.id) {
          continue;
        }
        const overlap = pixels.filter((index) => other.mask[index]).length;
        if (overlap) {
          diagnostics.push({
            code: "intersects-other-mask",
            details: { otherLayerId: other.id, pixels: overlap },
            layerId: layer.id,
            message: `${layer.name} overlaps ${other.name}.`,
            severity: "warning",
          });
        }
      }
    }
    return maskIntelligenceReportSchema.parse({
      diagnostics,
      maskCount: document.masks.length,
      recommendations: [
        "Name every non-empty mask with semanticLabel and semanticRole before targeted regeneration.",
        "Resolve mask overlaps unless the overlap is intentional for a parent/child rig.",
        "Use suggestions as draft masks only after review; they are deterministic hints, not approvals.",
      ],
      runId,
      suggestions: suggestions.slice(0, 8),
      updatedAt: nowIso(),
    });
  }

  async readJob(jobId: string): Promise<PersistentJob | null> {
    const jobs = await this.listJobs();
    return jobs.find((job) => job.id === jobId) ?? null;
  }

  async readRun(id: string): Promise<Run> {
    return runSchema.parse(await readJsonFile(this.runPath(id)));
  }

  async setFrameApproval(
    runId: string,
    frameId: string,
    inputValue: unknown
  ): Promise<{ frame: Frame; run: Run }> {
    const input = approveFrameInputSchema.parse(inputValue);
    const run = await this.readRun(runId);
    if (!run.activeFrameIds.includes(frameId)) {
      throw new Error(`Frame is not active in this run: ${frameId}`);
    }
    const frame = await this.readFrame(run, frameId);
    const approvedAt = input.approved ? nowIso() : null;
    const approvedFrames = input.approved
      ? [
          ...run.approval.approvedFrames.filter(
            (item) => item.frameId !== frameId
          ),
          {
            approvedAt: approvedAt ?? nowIso(),
            approvedBy: input.approvedBy,
            frameId,
            ...(input.note ? { note: input.note } : {}),
          },
        ]
      : run.approval.approvedFrames.filter((item) => item.frameId !== frameId);
    const approvedFrameIds = new Set(
      approvedFrames.map((item) => item.frameId)
    );
    let { status } = run;
    if (
      run.activeFrameIds.length > 0 &&
      run.activeFrameIds.every((activeFrameId) =>
        approvedFrameIds.has(activeFrameId)
      )
    ) {
      status = "approved";
    } else if (run.status === "approved") {
      status = "review";
    }
    const nextFrame = frameSchema.parse({
      ...frame,
      approved: input.approved,
      approvedAt,
    });
    await this.writeFrame(run, nextFrame);
    const nextRun = await this.writeRun({
      ...run,
      approval: {
        approvedFrames,
        updatedAt: nowIso(),
      },
      status,
    });
    return { frame: nextFrame, run: nextRun };
  }

  async recoverJobs(): Promise<PersistentJob[]> {
    const jobs = await this.listJobs();
    const recovered: PersistentJob[] = [];
    for (const job of jobs) {
      if (job.status === "running") {
        const failedJob = await this.writeJob({
          ...job,
          completedAt: nowIso(),
          error: {
            code: "api-restart",
            message: "API restarted while job was running.",
            retryable: true,
          },
          status: "failed",
        });
        recovered.push(failedJob);
      } else if (job.status === "queued") {
        recovered.push(job);
      }
    }
    return recovered;
  }

  async writeDraft(run: Run, draft: AnimationDraft): Promise<void> {
    await writeJsonAtomic(
      this.draftPath(run),
      animationDraftSchema.parse(draft)
    );
  }

  async writeEditorDocument(
    inputDocument: EditorDocument,
    options: { expectedRevision?: number; writeFrameImages?: boolean } = {}
  ): Promise<EditorDocument> {
    const run = await this.readRun(inputDocument.runId);
    if (options.expectedRevision !== undefined) {
      this.assertExpectedEditorRevision(
        await this.readEditorDocument(inputDocument.runId),
        options.expectedRevision
      );
    }
    const timestamp = nowIso();
    const document = editorDocumentSchema.parse({
      ...inputDocument,
      frames: inputDocument.frames.map((frame) => ({
        ...frame,
        grid: this.normalizePixelGrid(frame.grid),
      })),
      saveState: {
        ...inputDocument.saveState,
        dirty: false,
        lastSavedAt: timestamp,
        revision: inputDocument.saveState.revision + 1,
      },
      updatedAt: timestamp,
    });
    await mkdir(this.editorDir(run), { recursive: true });
    await writeJsonAtomic(this.editorDocumentPath(run), document);
    await this.writeDraft(run, this.draftFromEditorDocument(run, document));
    if (options.writeFrameImages ?? true) {
      for (const frame of document.frames) {
        await this.writePixelGrid(run.id, frame.frameId, { grid: frame.grid });
      }
    }
    return document;
  }

  async writeEditorFrameGrid(
    runId: string,
    frameId: string,
    inputValue: unknown
  ): Promise<{
    frameId: string;
    lastSavedAt: string;
    nonempty: number;
    revision: number;
  }> {
    const input = pixelGridWriteRequestSchema.parse(inputValue);
    const document = await this.readEditorDocument(runId);
    this.assertExpectedEditorRevision(document, input.expectedRevision);
    const frameIndex = document.frames.findIndex(
      (frame) => frame.frameId === frameId
    );
    if (frameIndex === -1) {
      throw new Error(`Editor frame not found: ${frameId}`);
    }
    const grid = this.normalizePixelGrid(input.grid);
    const nextFrames = document.frames.map((frame, index) =>
      index === frameIndex
        ? {
            ...frame,
            grid,
          }
        : frame
    );
    const nextDocument = await this.writeEditorDocument(
      {
        ...document,
        frames: nextFrames,
        selectedFrameId: frameId,
      },
      { writeFrameImages: false }
    );
    const savedFrame =
      nextDocument.frames.find((frame) => frame.frameId === frameId) ??
      nextDocument.frames[frameIndex];
    if (!savedFrame) {
      throw new Error(`Editor frame not found after save: ${frameId}`);
    }
    return {
      frameId,
      lastSavedAt: nextDocument.saveState.lastSavedAt ?? nextDocument.updatedAt,
      nonempty: savedFrame.grid.cells.filter(Boolean).length,
      revision: nextDocument.saveState.revision,
    };
  }

  async writeExport(run: Run, savedAnimation: SavedAnimation): Promise<void> {
    await writeJsonAtomic(
      this.exportJsonPath(run, savedAnimation.id),
      savedAnimationSchema.parse(savedAnimation)
    );
  }

  async writeFrame(run: Run, frame: Frame): Promise<void> {
    await writeJsonAtomic(
      this.frameJsonPath(run, frame.id),
      frameSchema.parse(frame)
    );
  }

  async writePixelGrid(
    runId: string,
    frameId: string,
    inputValue: unknown
  ): Promise<{
    alphaBBox: Frame["alphaBBox"];
    frameId: string;
    grid: PixelGrid;
    previewUrl: string;
  }> {
    const input = pixelGridWriteRequestSchema.parse(inputValue);
    if (input.expectedRevision !== undefined) {
      this.assertExpectedEditorRevision(
        await this.readEditorDocument(runId),
        input.expectedRevision
      );
    }
    const run = await this.readRun(runId);
    const frame = await this.readFrame(run, frameId);
    const { writePixelGridWithPython } = await import("./python-worker.js");
    const result = await writePixelGridWithPython({
      grid: input.grid,
      path: this.framePngPath(run, frameId),
      payloadPath: safeResolveInside(
        run.paths.pipelineDir,
        `editor-pixels-${frameId}-${Date.now().toString(36)}.json`
      ),
    });
    await this.writeFrame(run, {
      ...frame,
      alphaBBox: result.alphaBBox,
      canvas: result.grid.size,
      palette: {
        ...frame.palette,
        colors: result.grid.palette,
      },
      source: {
        ...frame.source,
        kind: "user-edited",
      },
    });
    return {
      alphaBBox: result.alphaBBox,
      frameId,
      grid: result.grid,
      previewUrl: `/runs/${runId}/frames/${frameId}/image`,
    };
  }

  async writeJob(job: PersistentJob): Promise<PersistentJob> {
    const timestamp = nowIso();
    const parsedJob = jobSchema.parse({ ...job, updatedAt: timestamp });
    const run = await this.readRun(parsedJob.runId);
    await writeJsonAtomic(this.jobPath(run, parsedJob.id), parsedJob);
    return parsedJob;
  }

  async writeRun(run: Run): Promise<Run> {
    const parsedRun = runSchema.parse({ ...run, updatedAt: nowIso() });
    await writeJsonAtomic(this.runPath(parsedRun.id), parsedRun);
    return parsedRun;
  }

  createRunPaths(id: string): Run["paths"] {
    const root = safeResolveInside(this.runsDir, id);
    return {
      diagnosticsDir: safeResolveInside(root, "diagnostics"),
      exportsDir: safeResolveInside(root, "exports"),
      framesDir: safeResolveInside(root, "frames"),
      masksDir: safeResolveInside(root, "masks"),
      pipelineDir: safeResolveInside(root, "pipeline"),
      root,
    };
  }

  draftPath(run: Run): string {
    return safeResolveInside(run.paths.root, "animation-draft.json");
  }

  editorDir(run: Run): string {
    return safeResolveInside(run.paths.root, "editor");
  }

  editorDocumentPath(run: Run): string {
    return safeResolveInside(this.editorDir(run), "editor-document.json");
  }

  editorCheckpointsDir(run: Run): string {
    return safeResolveInside(this.editorDir(run), "checkpoints");
  }

  editorCheckpointPath(run: Run, checkpointId: string): string {
    return safeResolveInside(
      this.editorCheckpointsDir(run),
      `${checkpointId}.json`
    );
  }

  editorOperationsDir(run: Run): string {
    return safeResolveInside(this.editorDir(run), "operations");
  }

  editorOperationPath(run: Run, operationId: string): string {
    return safeResolveInside(
      this.editorOperationsDir(run),
      `${operationId}.json`
    );
  }

  agentProjectMemoryPath(run: Run): string {
    return safeResolveInside(this.editorDir(run), "agent-memory.json");
  }

  editorReferenceImagePath(run: Run, referenceId: string): string {
    return safeResolveInside(
      this.editorDir(run),
      "references",
      `${referenceId}.png`
    );
  }

  imagegenComparePreviewPath(
    run: Run,
    resultId: string,
    candidateId: string
  ): string {
    return safeResolveInside(
      this.editorDir(run),
      "imagegen",
      "previews",
      `${resultId}_${candidateId}.compare.png`
    );
  }

  exportDir(run: Run, exportId: string): string {
    return safeResolveInside(run.paths.root, "saved-animations", exportId);
  }

  exportArtifactPath(run: Run, exportId: string, filePath: string): string {
    return safeResolveInside(this.exportDir(run, exportId), filePath);
  }

  exportJsonPath(run: Run, exportId: string): string {
    return safeResolveInside(
      this.exportDir(run, exportId),
      "saved-animation.json"
    );
  }

  frameJsonPath(run: Run, frameId: string): string {
    return safeResolveInside(run.paths.framesDir, `${frameId}.frame.json`);
  }

  framePngPath(run: Run, frameId: string): string {
    return safeResolveInside(run.paths.framesDir, `${frameId}.png`);
  }

  jobPath(run: Run, jobId: string): string {
    return safeResolveInside(run.paths.root, "jobs", `${jobId}.json`);
  }

  runPath(id: string): string {
    return safeResolveInside(this.runsDir, id, "run.json");
  }

  private async addSheetFrames(
    run: Run,
    sheet: z.infer<typeof sourceSheetSchema>
  ): Promise<Run> {
    await assertPngReadable(sheet.path);
    const { splitSheetWithPython } = await import("./python-worker.js");
    const frameIds = await splitSheetWithPython({
      run,
      sheet,
      startIndex: run.activeFrameIds.length,
    });
    const nextRun = await this.writeRun({
      ...run,
      activeFrameIds: [...run.activeFrameIds, ...frameIds],
      qc: { ...run.qc, passes: true, retryHints: [] },
      status: "raw-ready",
    });
    await writeJsonAtomic(
      join(run.paths.pipelineDir, `ingest-sheet-${Date.now()}.json`),
      {
        frameIds,
        mode: "split-sheet",
        sheet,
      }
    );
    return nextRun;
  }

  private async addAutoSlicedFrames(
    run: Run,
    sheet: z.infer<typeof autoSliceSheetSchema>
  ): Promise<Run> {
    await assertPngReadable(sheet.path);
    const { splitSheetWithPython } = await import("./python-worker.js");
    const frameIds = await splitSheetWithPython({
      mode: "auto-slice-components",
      run,
      sheet: {
        ...sheet,
        frameHeight: 0,
        frameWidth: 0,
      },
      startIndex: run.activeFrameIds.length,
    });
    const nextRun = await this.writeRun({
      ...run,
      activeFrameIds: [...run.activeFrameIds, ...frameIds],
      qc: { ...run.qc, passes: true, retryHints: [] },
      status: "raw-ready",
    });
    await writeJsonAtomic(
      join(run.paths.pipelineDir, `ingest-auto-slice-${Date.now()}.json`),
      {
        frameIds,
        mode: "auto-slice-components",
        sheet,
      }
    );
    return nextRun;
  }

  private async copySourceFrame(
    run: Run,
    sourcePath: string,
    frameId: string,
    gridStrategy:
      | "infer-hidden-grid"
      | "preserve-source"
      | "resize-to-run-canvas"
  ): Promise<{
    framePath: string;
    materialization: unknown;
  }> {
    await assertPngReadable(sourcePath);
    const extension = extname(sourcePath) || ".png";
    const framePath = safeResolveInside(
      run.paths.framesDir,
      `${frameId}${extension}`
    );
    const { materializeFrameWithPython } = await import("./python-worker.js");
    const materialization = await materializeFrameWithPython(
      {
        assetType: run.asset.type,
        canvas: run.canvas,
        gridStrategy,
        outputPath: framePath,
        sourcePath,
      },
      run.paths.pipelineDir
    );
    return { framePath, materialization };
  }

  private async ensureRunDirs(paths: Run["paths"]): Promise<void> {
    await Promise.all(
      [
        paths.diagnosticsDir,
        paths.exportsDir,
        paths.framesDir,
        paths.masksDir,
        paths.pipelineDir,
        safeResolveInside(paths.root, "editor"),
        safeResolveInside(paths.root, "jobs"),
        safeResolveInside(paths.root, "saved-animations"),
      ].map((path) => mkdir(path, { recursive: true }))
    );
  }

  private async importRun(input: CreateRunInput): Promise<Run> {
    const sourceRun = runSchema.parse(
      await readJsonFile(join(input.importRunPath ?? "", "run.json"))
    );
    const id = createId(input.name);
    const paths = this.createRunPaths(id);
    await this.ensureRunDirs(paths);
    const importedRun = await this.writeRun({
      ...sourceRun,
      id,
      name: input.name,
      paths,
      status: "planned",
    });
    const frameStats = await stat(sourceRun.paths.framesDir);
    if (!frameStats.isDirectory()) {
      throw new Error("Imported run frames path is not a directory.");
    }
    const frameFiles = await readdir(sourceRun.paths.framesDir);
    for (const file of frameFiles.filter((entry) => entry.endsWith(".png"))) {
      await copyFile(
        join(sourceRun.paths.framesDir, file),
        safeResolveInside(paths.framesDir, file)
      );
    }
    await writeJsonAtomic(join(paths.pipelineDir, "import-run.json"), {
      importedFrom: input.importRunPath,
      sourceRunId: sourceRun.id,
    });
    return importedRun;
  }

  private nextFrameId(run: Run): string {
    return `frame_${String(run.activeFrameIds.length + 1).padStart(2, "0")}`;
  }

  private applyEditorOperation(
    document: EditorDocument,
    operation: EditorOperation
  ): EditorDocument {
    if (operation.type === "select-frame") {
      return document.frames.some(
        (frame) => frame.frameId === operation.frameId
      )
        ? { ...document, selectedFrameId: operation.frameId }
        : document;
    }
    if (operation.type === "reorder-frame") {
      const framesList = document.timeline.framesList.filter(
        (frameId) => frameId !== operation.frameId
      );
      const targetIndex = Math.min(operation.targetIndex, framesList.length);
      framesList.splice(targetIndex, 0, operation.frameId);
      return {
        ...document,
        timeline: { ...document.timeline, framesList },
      };
    }
    if (operation.type === "upsert-mask-layer") {
      const masks = document.masks.some(
        (layer) => layer.id === operation.layer.id
      )
        ? document.masks.map((layer) =>
            layer.id === operation.layer.id ? operation.layer : layer
          )
        : [...document.masks, operation.layer];
      return {
        ...document,
        activeMaskLayerId: operation.layer.id,
        masks,
      };
    }
    if (operation.type === "delete-mask-layer") {
      const masks = document.masks.filter(
        (layer) => layer.id !== operation.layerId
      );
      return {
        ...document,
        activeMaskLayerId:
          document.activeMaskLayerId === operation.layerId
            ? (masks[0]?.id ?? null)
            : document.activeMaskLayerId,
        masks,
      };
    }
    if (
      operation.type === "patch-mask" ||
      operation.type === "mask-stroke" ||
      operation.type === "mask-bucket" ||
      operation.type === "mask-shape"
    ) {
      return this.applyMaskEditorOperation(document, operation);
    }
    const frames = document.frames.map((frame) => {
      if (frame.frameId !== operation.frameId) {
        return frame;
      }
      const cells = [...frame.grid.cells];
      if (operation.type === "set-pixel") {
        cells[operation.y * frame.grid.size.width + operation.x] =
          operation.color;
      } else if (operation.type === "patch-pixels") {
        for (const patch of operation.patches) {
          cells[patch.y * frame.grid.size.width + patch.x] = patch.color;
        }
      } else if (operation.type === "tool-stroke") {
        this.applyStrokeToCells(frame.grid.size, cells, operation.points, {
          color: operation.tool === "eraser" ? null : operation.color,
          size: operation.size,
        });
      } else if (operation.type === "bucket-fill") {
        this.applyBucketFillToCells(document, frame, cells, {
          color: operation.color,
          respectMaskLayerIds: operation.respectMaskLayerIds,
          x: operation.x,
          y: operation.y,
        });
      } else if (operation.type === "gradient-fill") {
        this.applyGradientFillToCells(document, frame, cells, operation);
      } else if (operation.type === "shape-pixels") {
        const mask = this.shapeMask(
          frame.grid.size,
          operation.startCell,
          operation.endCell,
          operation.shape,
          operation.mode,
          operation.radius
        );
        for (const [index, enabled] of mask.entries()) {
          if (enabled) {
            cells[index] = operation.color;
          }
        }
      } else if (operation.type === "transform-pixels") {
        return {
          ...frame,
          grid: this.normalizePixelGrid({
            ...frame.grid,
            cells: this.transformCells(frame.grid.size, cells, operation),
          }),
        };
      } else if (
        operation.type === "delete-selected-pixels" ||
        operation.type === "delete-target"
      ) {
        const targetMask = this.deleteTargetMask(document, frame, operation);
        for (const [index, enabled] of targetMask.entries()) {
          if (enabled) {
            cells[index] = null;
          }
        }
      }
      return {
        ...frame,
        grid: this.normalizePixelGrid({ ...frame.grid, cells }),
      };
    });
    if (
      operation.type !== "delete-selected-pixels" &&
      operation.type !== "delete-target"
    ) {
      return { ...document, frames };
    }
    if (!operation.clearMaskLayerIds.length) {
      return { ...document, frames };
    }
    const targetFrame = frames.find(
      (frame) => frame.frameId === operation.frameId
    );
    const targetMask = targetFrame
      ? this.deleteTargetMask(document, targetFrame, operation)
      : null;
    if (!targetMask) {
      return { ...document, frames };
    }
    const clearMaskLayerIdSet = new Set(operation.clearMaskLayerIds);
    const masks = document.masks.map((layer) =>
      clearMaskLayerIdSet.has(layer.id)
        ? {
            ...layer,
            mask: layer.mask.map((value, index) =>
              targetMask[index] ? false : value
            ),
          }
        : layer
    );
    return { ...document, frames, masks };
  }

  private deleteTargetMask(
    document: EditorDocument,
    frame: EditorDocument["frames"][number],
    operation: Extract<
      EditorOperation,
      { type: "delete-selected-pixels" } | { type: "delete-target" }
    >
  ): boolean[] {
    if (operation.type === "delete-target") {
      return this.maskFromBounds(frame.grid.size, operation.bounds);
    }
    if (operation.mask) {
      return operation.mask.slice(0, frame.grid.cells.length);
    }
    const maskFromLayers = this.combinedMask(document, operation.maskLayerIds);
    if (maskFromLayers) {
      return maskFromLayers.slice(0, frame.grid.cells.length);
    }
    if (operation.bounds) {
      return this.maskFromBounds(frame.grid.size, operation.bounds);
    }
    return Array.from({ length: frame.grid.cells.length }, () => false);
  }

  private applyStrokeToCells(
    size: { height: number; width: number },
    cells: PixelCell[],
    points: { x: number; y: number }[],
    input: { color: PixelCell; size: number }
  ): void {
    const brushSize = Math.max(1, input.size);
    const offset = Math.floor(brushSize / 2);
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[index + 1];
      const strokeCells = next ? interpolateCells(current, next) : [current];
      for (const cell of strokeCells) {
        for (let y = cell.y - offset; y < cell.y - offset + brushSize; y += 1) {
          for (
            let x = cell.x - offset;
            x < cell.x - offset + brushSize;
            x += 1
          ) {
            if (x >= 0 && y >= 0 && x < size.width && y < size.height) {
              cells[cellIndex(size, x, y)] = input.color;
            }
          }
        }
      }
    }
  }

  private applyBucketFillToCells(
    document: EditorDocument,
    frame: EditorDocument["frames"][number],
    cells: PixelCell[],
    input: {
      color: PixelCell;
      respectMaskLayerIds: string[];
      x: number;
      y: number;
    }
  ): void {
    const { size } = frame.grid;
    if (
      input.x >= size.width ||
      input.y >= size.height ||
      input.x < 0 ||
      input.y < 0
    ) {
      return;
    }
    const activeMask = this.combinedMask(document, input.respectMaskLayerIds);
    const startIndex = cellIndex(size, input.x, input.y);
    if (activeMask && !activeMask[startIndex]) {
      return;
    }
    const targetColor = cells[startIndex] ?? null;
    const visited = new Set<number>();
    const queue = [{ x: input.x, y: input.y }];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      const index = cellIndex(size, current.x, current.y);
      if (
        visited.has(index) ||
        (cells[index] ?? null) !== targetColor ||
        (activeMask && !activeMask[index])
      ) {
        continue;
      }
      visited.add(index);
      cells[index] = input.color;
      for (const next of [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]) {
        if (
          next.x >= 0 &&
          next.y >= 0 &&
          next.x < size.width &&
          next.y < size.height
        ) {
          queue.push(next);
        }
      }
    }
  }

  private applyGradientFillToCells(
    document: EditorDocument,
    frame: EditorDocument["frames"][number],
    cells: PixelCell[],
    operation: Extract<EditorOperation, { type: "gradient-fill" }>
  ): void {
    let targetMask: boolean[];
    if (operation.target === "canvas") {
      targetMask = Array.from({ length: cells.length }, () => true);
    } else if (operation.target === "mask") {
      targetMask =
        this.combinedMask(document, operation.targetMaskLayerIds) ??
        Array.from({ length: cells.length }, () => false);
    } else {
      targetMask = this.connectedColorMask(
        frame.grid.size,
        cells,
        operation.startCell
      );
    }
    for (let y = 0; y < frame.grid.size.height; y += 1) {
      for (let x = 0; x < frame.grid.size.width; x += 1) {
        const index = cellIndex(frame.grid.size, x, y);
        if (!targetMask[index]) {
          continue;
        }
        const amount = this.gradientAmount(
          { x, y },
          operation.startCell,
          operation.endCell,
          operation.kind
        );
        cells[index] =
          amount >= this.gradientThreshold(x, y, operation.pattern)
            ? operation.endColor
            : operation.startColor;
      }
    }
  }

  private applyMaskEditorOperation(
    document: EditorDocument,
    operation: Extract<
      EditorOperation,
      | { type: "mask-bucket" }
      | { type: "mask-shape" }
      | { type: "mask-stroke" }
      | { type: "patch-mask" }
    >
  ): EditorDocument {
    const selectedFrame =
      document.frames.find(
        (frame) => frame.frameId === document.selectedFrameId
      ) ?? document.frames[0];
    const masks = document.masks.map((layer) => {
      if (layer.id !== operation.layerId) {
        return layer;
      }
      const mask = [...layer.mask];
      if (operation.type === "patch-mask") {
        for (const patch of operation.patches) {
          mask[cellIndex(document.canvas, patch.x, patch.y)] = patch.value;
        }
      } else if (operation.type === "mask-stroke") {
        this.applyStrokeToMask(document, selectedFrame, mask, operation);
      } else if (operation.type === "mask-bucket") {
        this.applyBucketFillToMask(document, selectedFrame, mask, operation);
      } else {
        this.applyShapeToMask(document, selectedFrame, mask, operation);
      }
      return { ...layer, mask };
    });
    return { ...document, masks };
  }

  private applyStrokeToMask(
    document: EditorDocument,
    frame: EditorDocument["frames"][number] | undefined,
    mask: boolean[],
    operation: Extract<EditorOperation, { type: "mask-stroke" }>
  ): void {
    const operationMask = Array.from({ length: mask.length }, () => false);
    this.applyStrokeToBooleanMask(document.canvas, operationMask, operation);
    this.applyMaskConstraints(document, frame, mask, operationMask, {
      respectAlpha: operation.respectAlpha,
      value: operation.value,
    });
  }

  private applyShapeToMask(
    document: EditorDocument,
    frame: EditorDocument["frames"][number] | undefined,
    mask: boolean[],
    operation: Extract<EditorOperation, { type: "mask-shape" }>
  ): void {
    const operationMask = this.shapeMask(
      document.canvas,
      operation.startCell,
      operation.endCell,
      operation.shape,
      operation.mode,
      operation.radius
    );
    this.applyMaskConstraints(document, frame, mask, operationMask, {
      respectAlpha: operation.respectAlpha,
      value: operation.value,
    });
  }

  private applyBucketFillToMask(
    document: EditorDocument,
    frame: EditorDocument["frames"][number] | undefined,
    mask: boolean[],
    operation: Extract<EditorOperation, { type: "mask-bucket" }>
  ): void {
    const startIndex = cellIndex(document.canvas, operation.x, operation.y);
    const targetValue = mask[startIndex] ?? false;
    const blockedByOtherMasks = this.otherMaskPixels(
      document,
      operation.layerId,
      operation.excludeOtherMasks
    );
    const operationMask = Array.from({ length: mask.length }, () => false);
    const visited = new Set<number>();
    const queue = [{ x: operation.x, y: operation.y }];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      const index = cellIndex(document.canvas, current.x, current.y);
      if (
        visited.has(index) ||
        (mask[index] ?? false) !== targetValue ||
        blockedByOtherMasks[index]
      ) {
        continue;
      }
      visited.add(index);
      operationMask[index] = true;
      for (const next of [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]) {
        if (
          next.x >= 0 &&
          next.y >= 0 &&
          next.x < document.canvas.width &&
          next.y < document.canvas.height
        ) {
          queue.push(next);
        }
      }
    }
    this.applyMaskConstraints(document, frame, mask, operationMask, {
      respectAlpha: operation.respectAlpha,
      value: operation.value,
    });
  }

  private applyStrokeToBooleanMask(
    size: { height: number; width: number },
    mask: boolean[],
    input: {
      points: { x: number; y: number }[];
      size: number;
      value: boolean;
    }
  ): void {
    const brushSize = Math.max(1, input.size);
    const offset = Math.floor(brushSize / 2);
    for (let index = 0; index < input.points.length; index += 1) {
      const current = input.points[index];
      const next = input.points[index + 1];
      const strokeCells = next ? interpolateCells(current, next) : [current];
      for (const cell of strokeCells) {
        for (let y = cell.y - offset; y < cell.y - offset + brushSize; y += 1) {
          for (
            let x = cell.x - offset;
            x < cell.x - offset + brushSize;
            x += 1
          ) {
            if (x >= 0 && y >= 0 && x < size.width && y < size.height) {
              mask[cellIndex(size, x, y)] = input.value;
            }
          }
        }
      }
    }
  }

  private applyMaskConstraints(
    document: EditorDocument,
    frame: EditorDocument["frames"][number] | undefined,
    targetMask: boolean[],
    operationMask: boolean[],
    input: { respectAlpha: boolean; value: boolean }
  ): void {
    for (const [index, enabled] of operationMask.entries()) {
      if (!enabled) {
        continue;
      }
      if (input.respectAlpha && frame && !frame.grid.cells[index]) {
        continue;
      }
      if (index < document.canvas.width * document.canvas.height) {
        targetMask[index] = input.value;
      }
    }
  }

  private otherMaskPixels(
    document: EditorDocument,
    layerId: string,
    enabled: boolean
  ): boolean[] {
    const blocked = Array.from(
      { length: document.canvas.width * document.canvas.height },
      () => false
    );
    if (!enabled) {
      return blocked;
    }
    for (const layer of document.masks) {
      if (layer.id === layerId) {
        continue;
      }
      for (const [index, value] of layer.mask.entries()) {
        blocked[index] ||= value;
      }
    }
    return blocked;
  }

  private combinedMask(
    document: EditorDocument,
    layerIds: string[]
  ): boolean[] | null {
    if (!layerIds.length) {
      return null;
    }
    const selectedLayerIds = new Set(layerIds);
    const mask = Array.from(
      { length: document.canvas.width * document.canvas.height },
      () => false
    );
    for (const layer of document.masks) {
      if (!selectedLayerIds.has(layer.id)) {
        continue;
      }
      for (const [index, value] of layer.mask.entries()) {
        mask[index] ||= value;
      }
    }
    return mask;
  }

  private connectedColorMask(
    size: { height: number; width: number },
    cells: PixelCell[],
    cell: { x: number; y: number }
  ): boolean[] {
    const mask = Array.from({ length: cells.length }, () => false);
    const targetColor = cells[cellIndex(size, cell.x, cell.y)] ?? null;
    const visited = new Set<number>();
    const queue = [cell];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      const index = cellIndex(size, current.x, current.y);
      if (visited.has(index) || (cells[index] ?? null) !== targetColor) {
        continue;
      }
      visited.add(index);
      mask[index] = true;
      for (const next of [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]) {
        if (
          next.x >= 0 &&
          next.y >= 0 &&
          next.x < size.width &&
          next.y < size.height
        ) {
          queue.push(next);
        }
      }
    }
    return mask;
  }

  private shapeMask(
    size: { height: number; width: number },
    startCell: { x: number; y: number },
    endCell: { x: number; y: number },
    shape: "ellipse" | "line" | "rectangle" | "triangle",
    mode: "fill" | "outline",
    radius: number
  ): boolean[] {
    if (shape === "line") {
      const mask = Array.from(
        { length: size.width * size.height },
        () => false
      );
      for (const cell of interpolateCells(startCell, endCell)) {
        if (
          cell.x >= 0 &&
          cell.y >= 0 &&
          cell.x < size.width &&
          cell.y < size.height
        ) {
          mask[cellIndex(size, cell.x, cell.y)] = true;
        }
      }
      return mask;
    }
    const bounds = dragBounds(startCell, endCell);
    let filled: boolean[];
    if (shape === "ellipse") {
      filled = this.ellipseMask(size, bounds);
    } else if (shape === "triangle") {
      filled = this.triangleMask(size, bounds, radius);
    } else {
      filled = this.roundedRectangleMask(size, bounds, radius);
    }
    return mode === "outline" ? this.outlineMask(size, filled) : filled;
  }

  private roundedRectangleMask(
    size: { height: number; width: number },
    bounds: BBox,
    radius: number
  ): boolean[] {
    const mask = Array.from({ length: size.width * size.height }, () => false);
    const clampedRadius = Math.min(
      Math.max(0, radius),
      Math.floor(Math.min(bounds.width, bounds.height) / 2)
    );
    for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
      for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
        if (x < 0 || y < 0 || x >= size.width || y >= size.height) {
          continue;
        }
        if (clampedRadius === 0) {
          mask[cellIndex(size, x, y)] = true;
          continue;
        }
        const localX = x - bounds.x;
        const localY = y - bounds.y;
        const nearLeft = localX < clampedRadius;
        const nearRight = localX >= bounds.width - clampedRadius;
        const nearTop = localY < clampedRadius;
        const nearBottom = localY >= bounds.height - clampedRadius;
        if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
          const cornerX = nearLeft
            ? clampedRadius - 0.5
            : bounds.width - clampedRadius - 0.5;
          const cornerY = nearTop
            ? clampedRadius - 0.5
            : bounds.height - clampedRadius - 0.5;
          mask[cellIndex(size, x, y)] =
            Math.hypot(localX - cornerX, localY - cornerY) <= clampedRadius;
        } else {
          mask[cellIndex(size, x, y)] = true;
        }
      }
    }
    return mask;
  }

  private ellipseMask(
    size: { height: number; width: number },
    bounds: BBox
  ): boolean[] {
    const mask = Array.from({ length: size.width * size.height }, () => false);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const radiusX = Math.max(bounds.width / 2, 0.5);
    const radiusY = Math.max(bounds.height / 2, 0.5);
    for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
      for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
        if (x < 0 || y < 0 || x >= size.width || y >= size.height) {
          continue;
        }
        const dx = (x + 0.5 - centerX) / radiusX;
        const dy = (y + 0.5 - centerY) / radiusY;
        mask[cellIndex(size, x, y)] = dx * dx + dy * dy <= 1;
      }
    }
    return mask;
  }

  private triangleMask(
    size: { height: number; width: number },
    bounds: BBox,
    radius: number
  ): boolean[] {
    const mask = Array.from({ length: size.width * size.height }, () => false);
    const top = { x: bounds.x + bounds.width / 2, y: bounds.y };
    const left = { x: bounds.x, y: bounds.y + bounds.height };
    const right = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
    for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
      for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
        if (x < 0 || y < 0 || x >= size.width || y >= size.height) {
          continue;
        }
        mask[cellIndex(size, x, y)] = this.isInsidePolygon(
          { x: x + 0.5, y: y + 0.5 },
          [top, right, left]
        );
      }
    }
    return radius > 0
      ? this.dilateMask(size, this.erodeMask(size, mask, radius), radius)
      : mask;
  }

  private outlineMask(
    size: { height: number; width: number },
    mask: boolean[]
  ): boolean[] {
    const outline = Array.from({ length: mask.length }, () => false);
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const index = cellIndex(size, x, y);
        if (!mask[index]) {
          continue;
        }
        for (const next of [
          { x: x + 1, y },
          { x: x - 1, y },
          { x, y: y + 1 },
          { x, y: y - 1 },
        ]) {
          if (
            next.x < 0 ||
            next.y < 0 ||
            next.x >= size.width ||
            next.y >= size.height ||
            !mask[cellIndex(size, next.x, next.y)]
          ) {
            outline[index] = true;
            break;
          }
        }
      }
    }
    return outline;
  }

  private erodeMask(
    size: { height: number; width: number },
    mask: boolean[],
    radius: number
  ): boolean[] {
    const next = Array.from({ length: mask.length }, () => false);
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        if (!mask[cellIndex(size, x, y)]) {
          continue;
        }
        let keep = true;
        for (let dy = -radius; dy <= radius && keep; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nextX = x + dx;
            const nextY = y + dy;
            if (
              Math.hypot(dx, dy) <= radius &&
              (nextX < 0 ||
                nextY < 0 ||
                nextX >= size.width ||
                nextY >= size.height ||
                !mask[cellIndex(size, nextX, nextY)])
            ) {
              keep = false;
              break;
            }
          }
        }
        next[cellIndex(size, x, y)] = keep;
      }
    }
    return next;
  }

  private dilateMask(
    size: { height: number; width: number },
    mask: boolean[],
    radius: number
  ): boolean[] {
    const next = Array.from({ length: mask.length }, () => false);
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        if (!mask[cellIndex(size, x, y)]) {
          continue;
        }
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nextX = x + dx;
            const nextY = y + dy;
            if (
              nextX >= 0 &&
              nextY >= 0 &&
              nextX < size.width &&
              nextY < size.height &&
              Math.hypot(dx, dy) <= radius
            ) {
              next[cellIndex(size, nextX, nextY)] = true;
            }
          }
        }
      }
    }
    return next;
  }

  private isInsidePolygon(
    point: { x: number; y: number },
    polygon: { x: number; y: number }[]
  ): boolean {
    let inside = false;
    for (
      let index = 0, previous = polygon.length - 1;
      index < polygon.length;
      previous = index, index += 1
    ) {
      const currentPoint = polygon[index];
      const previousPoint = polygon[previous];
      const intersects =
        currentPoint.y > point.y !== previousPoint.y > point.y &&
        point.x <
          ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
            (previousPoint.y - currentPoint.y) +
            currentPoint.x;
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  private gradientAmount(
    cell: { x: number; y: number },
    startCell: { x: number; y: number },
    endCell: { x: number; y: number },
    kind: "linear" | "radial"
  ): number {
    const start = { x: startCell.x + 0.5, y: startCell.y + 0.5 };
    const end = { x: endCell.x + 0.5, y: endCell.y + 0.5 };
    const point = { x: cell.x + 0.5, y: cell.y + 0.5 };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) {
      return 1;
    }
    if (kind === "radial") {
      return Math.min(
        Math.max(
          0,
          Math.hypot(point.x - start.x, point.y - start.y) /
            Math.sqrt(lengthSquared)
        ),
        1
      );
    }
    return Math.min(
      Math.max(
        0,
        ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
      ),
      1
    );
  }

  private gradientThreshold(
    x: number,
    y: number,
    pattern: "bayer" | "checker" | "fine" | "hard"
  ): number {
    if (pattern === "hard") {
      return 0.5;
    }
    if (pattern === "checker") {
      return (x + y) % 2 === 0 ? 0.38 : 0.62;
    }
    const bayer4 = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    const bayer8 = [
      [0, 32, 8, 40, 2, 34, 10, 42],
      [48, 16, 56, 24, 50, 18, 58, 26],
      [12, 44, 4, 36, 14, 46, 6, 38],
      [60, 28, 52, 20, 62, 30, 54, 22],
      [3, 35, 11, 43, 1, 33, 9, 41],
      [51, 19, 59, 27, 49, 17, 57, 25],
      [15, 47, 7, 39, 13, 45, 5, 37],
      [63, 31, 55, 23, 61, 29, 53, 21],
    ];
    if (pattern === "fine") {
      return ((bayer8[y % 8]?.[x % 8] ?? 0) + 0.5) / 64;
    }
    return ((bayer4[y % 4]?.[x % 4] ?? 0) + 0.5) / 16;
  }

  private transformCells(
    size: { height: number; width: number },
    cells: PixelCell[],
    operation: Extract<EditorOperation, { type: "transform-pixels" }>
  ): PixelCell[] {
    const next = [...cells];
    const mask = operation.mask ?? this.maskFromBounds(size, operation.bounds);
    const radians = (operation.rotation * Math.PI) / 180;
    const cos = Math.cos(-radians);
    const sin = Math.sin(-radians);
    for (
      let { y } = operation.bounds;
      y < operation.bounds.y + operation.bounds.height;
      y += 1
    ) {
      for (
        let { x } = operation.bounds;
        x < operation.bounds.x + operation.bounds.width;
        x += 1
      ) {
        if (
          x >= 0 &&
          y >= 0 &&
          x < size.width &&
          y < size.height &&
          mask[cellIndex(size, x, y)]
        ) {
          next[cellIndex(size, x, y)] = null;
        }
      }
    }
    for (let targetY = 0; targetY < size.height; targetY += 1) {
      for (let targetX = 0; targetX < size.width; targetX += 1) {
        const dx = targetX + 0.5 - operation.origin.x - operation.translation.x;
        const dy = targetY + 0.5 - operation.origin.y - operation.translation.y;
        const rotatedX = dx * cos - dy * sin;
        const rotatedY = dx * sin + dy * cos;
        const sourceX = operation.origin.x + rotatedX / operation.scale.x;
        const sourceY = operation.origin.y + rotatedY / operation.scale.y;
        const sampleX = Math.floor(sourceX);
        const sampleY = Math.floor(sourceY);
        if (
          sampleX >= operation.bounds.x &&
          sampleX < operation.bounds.x + operation.bounds.width &&
          sampleY >= operation.bounds.y &&
          sampleY < operation.bounds.y + operation.bounds.height &&
          sampleX >= 0 &&
          sampleY >= 0 &&
          sampleX < size.width &&
          sampleY < size.height
        ) {
          const sourceIndex = cellIndex(size, sampleX, sampleY);
          if (mask[sourceIndex]) {
            next[cellIndex(size, targetX, targetY)] = cells[sourceIndex];
          }
        }
      }
    }
    return next;
  }

  private maskFromBounds(
    size: { height: number; width: number },
    bounds: BBox
  ): boolean[] {
    const mask = Array.from({ length: size.width * size.height }, () => false);
    for (let { y } = bounds; y < bounds.y + bounds.height; y += 1) {
      for (let { x } = bounds; x < bounds.x + bounds.width; x += 1) {
        if (x >= 0 && y >= 0 && x < size.width && y < size.height) {
          mask[cellIndex(size, x, y)] = true;
        }
      }
    }
    return mask;
  }

  private connectedComponents(
    size: Run["canvas"],
    isEnabled: (index: number) => boolean
  ): { x: number; y: number }[][] {
    const visited = new Set<number>();
    const components: { x: number; y: number }[][] = [];
    for (let index = 0; index < size.width * size.height; index += 1) {
      if (visited.has(index) || !isEnabled(index)) {
        continue;
      }
      const queue = [index];
      const component: { x: number; y: number }[] = [];
      visited.add(index);
      for (const current of queue) {
        const x = current % size.width;
        const y = Math.floor(current / size.width);
        component.push({ x, y });
        const neighbors = [
          { x: x + 1, y },
          { x: x - 1, y },
          { x, y: y + 1 },
          { x, y: y - 1 },
        ];
        for (const neighbor of neighbors) {
          if (
            neighbor.x < 0 ||
            neighbor.y < 0 ||
            neighbor.x >= size.width ||
            neighbor.y >= size.height
          ) {
            continue;
          }
          const neighborIndex = neighbor.y * size.width + neighbor.x;
          if (!visited.has(neighborIndex) && isEnabled(neighborIndex)) {
            visited.add(neighborIndex);
            queue.push(neighborIndex);
          }
        }
      }
      components.push(component);
    }
    return components.toSorted((left, right) => right.length - left.length);
  }

  private describeEditIntentTarget(
    document: EditorDocument,
    intent: EditIntentPreview["intent"]
  ): string {
    if (intent.intent === "recolor-mask") {
      const layer = document.masks.find(
        (item) => item.id === intent.maskLayerId
      );
      return layer
        ? `${layer.name} (${layer.partKind}, ${layer.semanticRole})`
        : `Mask ${intent.maskLayerId}`;
    }
    if (intent.target.kind === "mask-layer") {
      const { maskLayerId } = intent.target;
      const layer = document.masks.find((item) => item.id === maskLayerId);
      return layer
        ? `${layer.name} (${layer.partKind}, ${layer.semanticRole})`
        : `Mask ${maskLayerId}`;
    }
    if (intent.target.kind === "semantic-role") {
      return `Semantic role ${intent.target.role}`;
    }
    if (intent.target.kind === "semantic-part") {
      const layer = this.findMaskLayerBySemanticPart(
        document,
        intent.target.part
      );
      return layer
        ? `${layer.name} (${layer.partKind}, ${layer.semanticRole})`
        : `Semantic part ${intent.target.part}`;
    }
    return `Visual feature ${intent.target.visualKind}`;
  }

  private resolveEditIntentMask(
    document: EditorDocument,
    frame: EditorDocument["frames"][number],
    intent: EditIntentPreview["intent"]
  ): boolean[] {
    const mask =
      intent.intent === "recolor-mask"
        ? this.maskByLayerId(document, intent.maskLayerId)
        : this.maskByTarget(document, frame, intent.target);
    return intent.preserveOutline
      ? mask.map(
          (enabled, index) =>
            enabled && !this.isBoundaryPixel(frame.grid, index)
        )
      : mask;
  }

  private maskByLayerId(document: EditorDocument, layerId: string): boolean[] {
    const layer = document.masks.find((item) => item.id === layerId);
    if (!layer) {
      throw new Error(`Mask layer not found: ${layerId}`);
    }
    return layer.mask;
  }

  private maskByTarget(
    document: EditorDocument,
    frame: EditorDocument["frames"][number],
    target: Extract<
      EditIntentPreview["intent"],
      { intent: "recolor-target" }
    >["target"]
  ): boolean[] {
    if (target.kind === "mask-layer") {
      return this.maskByLayerId(document, target.maskLayerId);
    }
    if (target.kind === "semantic-role") {
      const layer = document.masks.find(
        (item) => item.semanticRole === target.role && item.mask.some(Boolean)
      );
      if (layer) {
        return layer.mask;
      }
      const inspection = this.inspectFrameDocument(document, frame);
      const feature = inspection.features.find(
        (item) =>
          item.kind === "eye-candidate" &&
          (target.role === "eyes" || target.role === "face")
      );
      if (feature?.pixels.length) {
        return this.maskFromPoints(frame.grid.size, feature.pixels);
      }
      throw new Error(
        `No mask or visual feature found for role: ${target.role}`
      );
    }
    if (target.kind === "semantic-part") {
      const layer = this.findMaskLayerBySemanticPart(document, target.part);
      if (!layer) {
        throw new Error(`No mask found for semantic part: ${target.part}`);
      }
      return layer.mask;
    }
    const inspection = this.inspectFrameDocument(document, frame);
    const feature = inspection.features.find(
      (item) => item.kind === target.visualKind
    );
    if (!feature?.pixels.length) {
      throw new Error(`No visual feature pixels found: ${target.visualKind}`);
    }
    return this.maskFromPoints(frame.grid.size, feature.pixels);
  }

  private findMaskLayerBySemanticPart(
    document: EditorDocument,
    part: string
  ): EditorMaskLayer | null {
    const normalizedPart = normalizeMaskLookupText(part);
    const compactPart = compactMaskLookupText(part);
    const scored = document.masks
      .filter((layer) => layer.mask.some(Boolean))
      .map((layer) => {
        const values = [
          layer.id,
          layer.name,
          layer.semanticLabel,
          layer.partKind,
          layer.promptHint,
          ...layer.aliases,
        ].filter((value): value is string => Boolean(value));
        let score = 0;
        for (const value of values) {
          const normalizedValue = normalizeMaskLookupText(value);
          const compactValue = compactMaskLookupText(value);
          if (normalizedValue === normalizedPart) {
            score = Math.max(score, 100);
          } else if (compactValue === compactPart) {
            score = Math.max(score, 95);
          } else if (
            normalizedValue.includes(normalizedPart) ||
            normalizedPart.includes(normalizedValue)
          ) {
            score = Math.max(score, 70);
          } else if (
            compactValue.includes(compactPart) ||
            compactPart.includes(compactValue)
          ) {
            score = Math.max(score, 65);
          }
        }
        return { layer, score };
      })
      .filter((item) => item.score > 0)
      .toSorted((left, right) => right.score - left.score);
    return scored[0]?.layer ?? null;
  }

  private maskFromPoints(
    size: Run["canvas"],
    points: { x: number; y: number }[]
  ): boolean[] {
    const selected = new Set(points.map((point) => `${point.x},${point.y}`));
    return Array.from({ length: size.width * size.height }, (_, index) =>
      selected.has(`${index % size.width},${Math.floor(index / size.width)}`)
    );
  }

  private isBoundaryPixel(grid: PixelGrid, index: number): boolean {
    if (!grid.cells[index]) {
      return false;
    }
    const x = index % grid.size.width;
    const y = Math.floor(index / grid.size.width);
    const neighbors = [
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    ];
    return neighbors.some(
      (point) =>
        point.x < 0 ||
        point.y < 0 ||
        point.x >= grid.size.width ||
        point.y >= grid.size.height ||
        !grid.cells[point.y * grid.size.width + point.x]
    );
  }

  private defaultAgentProjectMemory(run: Run): AgentProjectMemory {
    return agentProjectMemorySchema.parse({
      constraints: [
        "Preserve pixels outside selected masks during targeted regeneration.",
        "Use visual inspection and exact pixel maps before tiny detail edits.",
      ],
      projectBrief: `${run.name}: ${run.asset.type} ${run.asset.action} pixel-art asset.`,
      protectedDetails: [],
      schemaVersion,
      styleGuide: {
        animationRules: [
          "Prefer small, readable motion arcs for pixel-art animation.",
          "Keep anchors and mask parents stable unless the user requests rig changes.",
        ],
        outlineRules: ["Preserve crisp one-pixel outlines unless restyling."],
        palette: [],
        shadingRules: ["Avoid introducing anti-aliased intermediate colors."],
      },
      updatedAt: nowIso(),
    });
  }

  private async editorFrameFromRunFrame(
    run: Run,
    frameId: string
  ): Promise<EditorDocument["frames"][number]> {
    const frame = await this.readFrame(run, frameId);
    const pixels = await this.readPixelGrid(run.id, frameId);
    return {
      alphaBBox: pixels.alphaBBox,
      anchor: frame.anchor,
      frameId,
      grid: pixels.grid,
      name: frame.name,
      sourcePath: frame.path,
    };
  }

  private draftFromEditorDocument(
    run: Run,
    document: EditorDocument
  ): AnimationDraft {
    return animationDraftSchema.parse({
      canvasSize: document.canvas,
      fps: document.timeline.fps,
      frames: Object.fromEntries(
        document.frames.map((frame) => [
          frame.frameId,
          {
            frameId: frame.frameId,
            framePath: this.framePngPath(run, frame.frameId),
            transforms: {},
          },
        ])
      ),
      framesList: document.timeline.framesList,
      rigParts: document.masks.map((layer) => ({
        anchor: {
          mode: "custom",
          x: layer.anchor.x,
          y: layer.anchor.y,
        },
        bbox: null,
        color: layer.color,
        id: layer.id,
        maskPath: safeResolveInside(
          run.paths.masksDir,
          `${layer.id}.mask.json`
        ),
        name: layer.name,
        parentId: layer.parentId,
        pinned: layer.regenerationPolicy.locked,
      })),
      runId: run.id,
      schemaVersion,
      updatedAt: nowIso(),
    });
  }

  private maskLayersFromDraft(
    run: Run,
    draft: AnimationDraft | null
  ): EditorMaskLayer[] {
    if (!draft?.rigParts.length) {
      return [
        {
          aliases: [],
          anchor: { x: run.canvas.width / 2, y: run.canvas.height / 2 },
          color: defaultMaskColor,
          id: "mask_1",
          mask: Array.from(
            { length: run.canvas.width * run.canvas.height },
            () => false
          ),
          name: "Mask 1",
          parentId: null,
          partKind: "unknown",
          promptHint: "",
          regenerationPolicy: {
            allowImagegenReference: true,
            allowRegenerate: true,
            locked: false,
            preservePalette: true,
          },
          semanticLabel: "",
          semanticRole: "unknown",
          visible: true,
        },
      ];
    }
    return draft.rigParts.map((part, index) => ({
      aliases: [],
      anchor: { x: part.anchor.x, y: part.anchor.y },
      color: part.color,
      id: part.id,
      mask: Array.from(
        { length: run.canvas.width * run.canvas.height },
        () => false
      ),
      name: part.name || `Mask ${index + 1}`,
      parentId: part.parentId,
      partKind: part.name || "unknown",
      promptHint: "",
      regenerationPolicy: {
        allowImagegenReference: true,
        allowRegenerate: true,
        locked: part.pinned,
        preservePalette: true,
      },
      semanticLabel: part.name || "",
      semanticRole: "unknown",
      visible: true,
    }));
  }

  private normalizePixelGrid(grid: PixelGrid): PixelGrid {
    const colors = new Set<string>();
    for (const cell of grid.cells) {
      const color = this.pixelCellToPaletteHex(cell);
      if (color) {
        colors.add(color);
      }
    }
    return {
      ...grid,
      palette: [...colors].slice(0, 32),
    };
  }

  private editorFramesToSvg(
    frames: EditorDocument["frames"],
    scale: number,
    fps: number
  ): string {
    const [firstFrame] = frames;
    const width = (firstFrame?.grid.size.width ?? 1) * scale;
    const height = (firstFrame?.grid.size.height ?? 1) * scale;
    const frameDurationMs = Math.round(1000 / Math.max(1, fps));
    const durationMs = frameDurationMs * Math.max(1, frames.length);
    const groups = frames
      .map((frame, frameIndex) => {
        const rects = frame.grid.cells
          .map((cell, index) => {
            if (!cell) {
              return "";
            }
            const x = (index % frame.grid.size.width) * scale;
            const y = Math.floor(index / frame.grid.size.width) * scale;
            return `<rect x="${x}" y="${y}" width="${scale}" height="${scale}" fill="${cell}" />`;
          })
          .filter(Boolean)
          .join("\n");
        const visible = frames.length === 1 ? "inline" : "none";
        const animation =
          frames.length === 1
            ? ""
            : `<set attributeName="display" to="inline" begin="${frameIndex * frameDurationMs}ms; animation.end+${frameIndex * frameDurationMs}ms" dur="${frameDurationMs}ms" />`;
        return `<g display="${visible}">
${animation}
${rects}
</g>`;
      })
      .join("\n");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">
${frames.length > 1 ? `<animate id="animation" attributeName="visibility" from="visible" to="visible" dur="${durationMs}ms" repeatCount="indefinite" />` : ""}
${groups}
</svg>
`;
  }

  private editorFramesToLottie(
    frames: EditorDocument["frames"],
    scale: number,
    fps: number
  ): Record<string, unknown> {
    const [firstFrame] = frames;
    return {
      assets: [],
      ddd: 0,
      fr: fps,
      h: (firstFrame?.grid.size.height ?? 1) * scale,
      ip: 0,
      layers: frames.map((frame, frameIndex) => ({
        ddd: 0,
        ind: frameIndex + 1,
        ip: frameIndex,
        ks: {
          a: { k: [0, 0, 0] },
          o: { k: 100 },
          p: { k: [0, 0, 0] },
          r: { k: 0 },
          s: { k: [100, 100, 100] },
        },
        nm: frame.name,
        op: frameIndex + 1,
        shapes: this.editorFrameToLottieShapes(frame, scale),
        sr: 1,
        st: 0,
        ty: 4,
      })),
      meta: { generator: "retrodex-api-preview" },
      nm: "Retrodex Preview",
      op: Math.max(frames.length, 1),
      v: "5.12.0",
      w: (firstFrame?.grid.size.width ?? 1) * scale,
    };
  }

  private editorFrameToLottieShapes(
    frame: EditorDocument["frames"][number],
    scale: number
  ): Record<string, unknown>[] {
    const shapes: Record<string, unknown>[] = [];
    for (const [index, cell] of frame.grid.cells.entries()) {
      if (!cell) {
        continue;
      }
      const fill = this.pixelCellToLottieFill(cell);
      const x = (index % frame.grid.size.width) * scale;
      const y = Math.floor(index / frame.grid.size.width) * scale;
      shapes.push({
        it: [
          {
            p: { k: [x + scale / 2, y + scale / 2] },
            r: { k: 0 },
            s: { k: [scale, scale] },
            ty: "rc",
          },
          { c: { k: fill.color }, o: { k: fill.opacity }, ty: "fl" },
          { p: { k: [0, 0] }, ty: "tr" },
        ],
        ty: "gr",
      });
    }
    return shapes;
  }

  private editorFramesToReact(
    frames: EditorDocument["frames"],
    scale: number
  ): string {
    return `export const frames = ${JSON.stringify(
      frames.map((frame) => ({
        cells: frame.grid.cells,
        id: frame.frameId,
        size: frame.grid.size,
      }))
    )};

export function RetrodexPixelPreview() {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(${frames[0]?.grid.size.width ?? 1}, ${scale}px)" }}>{frames[0].cells.map((cell, index) => <span key={index} style={{ width: ${scale}, height: ${scale}, background: cell ?? "transparent" }} />)}</div>;
}
`;
  }

  private editorFramesToCss(
    frames: EditorDocument["frames"],
    scale: number,
    fps: number
  ): string {
    return `.retrodex-pixel-preview {
  image-rendering: pixelated;
  width: ${(frames[0]?.grid.size.width ?? 1) * scale}px;
  height: ${(frames[0]?.grid.size.height ?? 1) * scale}px;
  animation: retrodex-preview ${frames.length / Math.max(1, fps)}s steps(${Math.max(1, frames.length)}) infinite;
}
`;
  }

  private pixelCellToLottieFill(cell: string): {
    color: number[];
    opacity: number;
  } {
    const parsed = parsePixelCell(cell);
    if (!parsed) {
      return { color: [0, 0, 0], opacity: 0 };
    }
    return {
      color: [parsed.red / 255, parsed.green / 255, parsed.blue / 255],
      opacity: (parsed.alpha / 255) * 100,
    };
  }

  private assertExpectedEditorRevision(
    document: EditorDocument,
    expectedRevision?: number
  ): void {
    if (
      expectedRevision !== undefined &&
      expectedRevision !== document.saveState.revision
    ) {
      throw new ApiError(
        "editor-revision-conflict",
        "Editor document changed since the agent read it. Re-read the editor document, selection, and relevant pixel map before applying another edit.",
        409,
        true,
        {
          actualRevision: document.saveState.revision,
          expectedRevision,
          runId: document.runId,
        }
      );
    }
  }

  private pixelCellToPaletteHex(cell: null | string): null | string {
    if (!cell) {
      return null;
    }
    if (/^#[0-9a-f]{6}$/iu.test(cell)) {
      return cell.toLowerCase();
    }
    const rgba = cell.match(
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
  }

  private async readPartReferencePackage(
    runId: string,
    referenceId: string
  ): Promise<PartReferencePackage> {
    const run = await this.readRun(runId);
    return partReferencePackageSchema.parse(
      await readJsonFile(
        safeResolveInside(
          this.editorDir(run),
          "references",
          `${referenceId}.json`
        )
      )
    );
  }

  private async readPartRegenerationDraft(
    runId: string,
    regenerationId: string
  ): Promise<PartRegenerationDraft> {
    const run = await this.readRun(runId);
    return partRegenerationDraftSchema.parse(
      await readJsonFile(
        safeResolveInside(
          this.editorDir(run),
          "regeneration",
          `${regenerationId}.json`
        )
      )
    );
  }

  private async readImagegenRequest(
    runId: string,
    requestId: string
  ): Promise<ImagegenRequestArtifact> {
    const run = await this.readRun(runId);
    return imagegenRequestArtifactSchema.parse(
      await readJsonFile(
        safeResolveInside(this.editorDir(run), "imagegen", `${requestId}.json`)
      )
    );
  }

  private async readImagegenResult(
    runId: string,
    resultId: string
  ): Promise<ImagegenResultArtifact> {
    const run = await this.readRun(runId);
    return imagegenResultArtifactSchema.parse(
      await readJsonFile(
        safeResolveInside(this.editorDir(run), "imagegen", `${resultId}.json`)
      )
    );
  }

  private async readEditorCheckpoint(
    run: Run,
    checkpointId: string
  ): Promise<EditorCheckpoint> {
    return editorCheckpointSchema.parse(
      await readJsonFile(this.editorCheckpointPath(run, checkpointId))
    );
  }

  private async readEditorOperation(
    run: Run,
    operationId: string
  ): Promise<EditorOperationLogEntry> {
    return editorOperationLogEntrySchema.parse(
      await readJsonFile(this.editorOperationPath(run, operationId))
    );
  }

  private recordEditorOperationFromDocuments(
    runId: string,
    input: {
      afterDocument: EditorDocument;
      beforeDocument: EditorDocument;
      checkpointId?: string | null;
      label: string;
      operationType: EditorOperationLogEntry["operationType"];
      reason?: string;
      source: EditorOperationLogEntry["source"];
    }
  ): Promise<EditorOperationLogEntry | null> {
    const patches = this.diffEditorDocuments(
      input.beforeDocument,
      input.afterDocument
    );
    const maskPatches = this.diffEditorDocumentMasks(
      input.beforeDocument,
      input.afterDocument
    );
    if (!patches.length && !maskPatches.length) {
      return Promise.resolve(null);
    }
    return this.recordEditorOperation(runId, {
      ...input,
      maskPatches,
      patches,
    });
  }

  private async recordEditorOperation(
    runId: string,
    input: {
      afterDocument: EditorDocument;
      beforeDocument: EditorDocument;
      checkpointId?: string | null;
      label: string;
      operationType: EditorOperationLogEntry["operationType"];
      maskPatches?: EditorOperationLogEntry["maskPatches"];
      patches: EditorOperationLogEntry["patches"];
      reason?: string;
      source: EditorOperationLogEntry["source"];
    }
  ): Promise<EditorOperationLogEntry> {
    const run = await this.readRun(runId);
    const operation = editorOperationLogEntrySchema.parse({
      afterRevision: input.afterDocument.saveState.revision,
      beforeRevision: input.beforeDocument.saveState.revision,
      checkpointId: input.checkpointId ?? null,
      createdAt: nowIso(),
      id: `operation_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      label: input.label,
      maskPatches: input.maskPatches ?? [],
      operationType: input.operationType,
      patches: input.patches,
      reason: input.reason ?? "",
      runId,
      schemaVersion,
      source: input.source,
    });
    await mkdir(this.editorOperationsDir(run), { recursive: true });
    await writeJsonAtomic(
      this.editorOperationPath(run, operation.id),
      operation
    );
    return operation;
  }

  private diffEditorDocuments(
    beforeDocument: EditorDocument,
    afterDocument: EditorDocument
  ): EditorOperationLogEntry["patches"] {
    const patches: EditorOperationLogEntry["patches"] = [];
    const beforeFrames = new Map(
      beforeDocument.frames.map((frame) => [frame.frameId, frame])
    );
    for (const afterFrame of afterDocument.frames) {
      const beforeFrame = beforeFrames.get(afterFrame.frameId);
      if (!beforeFrame) {
        continue;
      }
      const cellCount = Math.max(
        beforeFrame.grid.cells.length,
        afterFrame.grid.cells.length
      );
      for (let index = 0; index < cellCount; index += 1) {
        const before = beforeFrame.grid.cells[index] ?? null;
        const after = afterFrame.grid.cells[index] ?? null;
        if (before !== after) {
          patches.push({
            after,
            before,
            frameId: afterFrame.frameId,
            x: index % afterFrame.grid.size.width,
            y: Math.floor(index / afterFrame.grid.size.width),
          });
        }
      }
    }
    return patches;
  }

  private diffEditorDocumentMasks(
    beforeDocument: EditorDocument,
    afterDocument: EditorDocument
  ): EditorOperationLogEntry["maskPatches"] {
    const patches: EditorOperationLogEntry["maskPatches"] = [];
    const beforeLayers = new Map(
      beforeDocument.masks.map((layer) => [layer.id, layer])
    );
    for (const afterLayer of afterDocument.masks) {
      const beforeLayer = beforeLayers.get(afterLayer.id);
      if (!beforeLayer) {
        continue;
      }
      const maskLength = Math.max(
        beforeLayer.mask.length,
        afterLayer.mask.length
      );
      for (let index = 0; index < maskLength; index += 1) {
        const before = beforeLayer.mask[index] ?? false;
        const after = afterLayer.mask[index] ?? false;
        if (before !== after) {
          patches.push({
            after,
            before,
            layerId: afterLayer.id,
            x: index % afterDocument.canvas.width,
            y: Math.floor(index / afterDocument.canvas.width),
          });
        }
      }
    }
    return patches;
  }

  private applyOperationPatchesToDocument(
    document: EditorDocument,
    patches: EditorOperationLogEntry["patches"],
    maskPatches: EditorOperationLogEntry["maskPatches"] = []
  ): EditorDocument {
    const patchesByFrame = new Map<
      string,
      EditorOperationLogEntry["patches"]
    >();
    for (const patch of patches) {
      const framePatches = patchesByFrame.get(patch.frameId) ?? [];
      framePatches.push(patch);
      patchesByFrame.set(patch.frameId, framePatches);
    }
    return {
      ...document,
      frames: document.frames.map((frame) => {
        const framePatches = patchesByFrame.get(frame.frameId);
        if (!framePatches) {
          return frame;
        }
        const cells = [...frame.grid.cells];
        for (const patch of framePatches) {
          cells[patch.y * frame.grid.size.width + patch.x] = patch.after;
        }
        return {
          ...frame,
          grid: this.normalizePixelGrid({ ...frame.grid, cells }),
        };
      }),
      masks: document.masks.map((layer) => {
        const layerPatches = maskPatches.filter(
          (patch) => patch.layerId === layer.id
        );
        if (!layerPatches.length) {
          return layer;
        }
        const mask = [...layer.mask];
        for (const patch of layerPatches) {
          mask[cellIndex(document.canvas, patch.x, patch.y)] = patch.after;
        }
        return { ...layer, mask };
      }),
      updatedAt: nowIso(),
    };
  }

  private diffCheckpointFrames(
    leftDocument: EditorDocument,
    rightDocument: EditorDocument
  ): CheckpointComparison["frameDiffs"] {
    const rightFrames = new Map(
      rightDocument.frames.map((frame) => [frame.frameId, frame])
    );
    const diffs: CheckpointComparison["frameDiffs"] = [];
    for (const leftFrame of leftDocument.frames) {
      const rightFrame = rightFrames.get(leftFrame.frameId);
      if (!rightFrame) {
        continue;
      }
      const points: { x: number; y: number }[] = [];
      const cellCount = Math.max(
        leftFrame.grid.cells.length,
        rightFrame.grid.cells.length
      );
      for (let index = 0; index < cellCount; index += 1) {
        const left = leftFrame.grid.cells[index] ?? null;
        const right = rightFrame.grid.cells[index] ?? null;
        if (left !== right) {
          points.push({
            x: index % rightFrame.grid.size.width,
            y: Math.floor(index / rightFrame.grid.size.width),
          });
        }
      }
      diffs.push({
        bbox: bboxFromPoints(points),
        changedPixels: points.length,
        frameId: leftFrame.frameId,
      });
    }
    return diffs;
  }

  private diffCheckpointMasks(
    leftDocument: EditorDocument,
    rightDocument: EditorDocument
  ): CheckpointComparison["maskDiffs"] {
    const rightMasks = new Map(
      rightDocument.masks.map((layer) => [layer.id, layer])
    );
    const diffs: CheckpointComparison["maskDiffs"] = [];
    for (const leftLayer of leftDocument.masks) {
      const rightLayer = rightMasks.get(leftLayer.id);
      if (!rightLayer) {
        continue;
      }
      const points: { x: number; y: number }[] = [];
      const maskLength = Math.max(
        leftLayer.mask.length,
        rightLayer.mask.length
      );
      for (let index = 0; index < maskLength; index += 1) {
        const left = leftLayer.mask[index] ?? false;
        const right = rightLayer.mask[index] ?? false;
        if (left !== right) {
          points.push({
            x: index % rightDocument.canvas.width,
            y: Math.floor(index / rightDocument.canvas.width),
          });
        }
      }
      diffs.push({
        bbox: bboxFromPoints(points),
        changedPixels: points.length,
        layerId: leftLayer.id,
      });
    }
    return diffs;
  }

  private buildImagegenApplyPatches(
    frame: EditorDocument["frames"][number],
    layer: EditorMaskLayer,
    request: ImagegenRequestArtifact,
    candidateGrid: PixelGrid
  ): Pick<ImagegenApplyPreview, "ignoredOutsideMaskPixels" | "patches"> {
    const maskPixels = new Set(
      request.reference.exactMaskPixels.map((point) => `${point.x},${point.y}`)
    );
    const patches: ImagegenApplyPreview["patches"] = [];
    const ignoredOutsideMaskPixels: ImagegenApplyPreview["ignoredOutsideMaskPixels"] =
      [];
    const { bbox } = request.reference;
    for (const [index, cell] of candidateGrid.cells.entries()) {
      if (!cell) {
        continue;
      }
      const x =
        candidateGrid.size.width === bbox.width
          ? bbox.x + (index % candidateGrid.size.width)
          : index % candidateGrid.size.width;
      const y =
        candidateGrid.size.width === bbox.width
          ? bbox.y + Math.floor(index / candidateGrid.size.width)
          : Math.floor(index / candidateGrid.size.width);
      if (!maskPixels.has(`${x},${y}`)) {
        ignoredOutsideMaskPixels.push({ color: cell, x, y });
      }
    }
    for (const [index, enabled] of layer.mask.entries()) {
      if (!enabled) {
        continue;
      }
      const x = index % frame.grid.size.width;
      const y = Math.floor(index / frame.grid.size.width);
      const candidateIndex =
        candidateGrid.size.width === frame.grid.size.width &&
        candidateGrid.size.height === frame.grid.size.height
          ? index
          : (y - bbox.y) * candidateGrid.size.width + (x - bbox.x);
      if (candidateIndex >= 0 && candidateIndex < candidateGrid.cells.length) {
        const before = frame.grid.cells[index] ?? null;
        const after = candidateGrid.cells[candidateIndex] ?? null;
        if (before !== after) {
          patches.push({
            after,
            before,
            frameId: frame.frameId,
            x,
            y,
          });
        }
      }
    }
    return { ignoredOutsideMaskPixels, patches };
  }

  private applyImagegenPatchesToDocument(
    document: EditorDocument,
    frameId: string,
    patches: ImagegenApplyPreview["patches"]
  ): EditorDocument {
    return {
      ...document,
      frames: document.frames.map((frame) => {
        if (frame.frameId !== frameId) {
          return frame;
        }
        const cells = [...frame.grid.cells];
        for (const patch of patches) {
          cells[patch.y * frame.grid.size.width + patch.x] = patch.after;
        }
        return {
          ...frame,
          grid: this.normalizePixelGrid({ ...frame.grid, cells }),
        };
      }),
      updatedAt: nowIso(),
    };
  }

  private inspectImagegenCandidate(
    document: EditorDocument,
    request: ImagegenRequestArtifact,
    result: ImagegenResultArtifact,
    candidate: ImagegenResultArtifact["candidates"][number]
  ): ImagegenResultInspection["candidates"][number] {
    const sourceFrame = this.imagegenSourceFrame(document, candidate.frameId);
    const layer = this.imagegenMaskLayer(document, request.maskLayerId);
    const candidateGrid = candidate.grid;
    const diffSummary = candidateGrid
      ? this.diffCandidateAgainstMask(request, candidateGrid)
      : { changedInsideMask: 0, outsideMaskChangesIgnored: 0 };
    const appliedGrid = candidateGrid
      ? this.applyCandidateGridToFrame(
          sourceFrame,
          layer,
          request,
          candidateGrid
        )
      : sourceFrame.grid;
    const maskPixelCount = Math.max(1, layer.mask.filter(Boolean).length);
    const maskCoverageRatio = Math.min(
      1,
      diffSummary.changedInsideMask / maskPixelCount
    );
    const paletteDriftColors = this.paletteDriftColors(
      sourceFrame.grid,
      candidateGrid
    );
    const alphaBBoxDriftPixels = this.alphaBBoxDriftPixels(
      sourceFrame.grid,
      appliedGrid
    );
    const diagnostics: ImagegenResultInspection["candidates"][number]["diagnostics"] =
      [];
    if (!candidateGrid) {
      diagnostics.push({
        code: "empty-candidate",
        details: {},
        message: "Candidate has no pixel grid to inspect.",
        severity: "error",
      });
    }
    if (diffSummary.outsideMaskChangesIgnored > 0) {
      diagnostics.push({
        code: "outside-mask-change",
        details: {
          outsideMaskChangesIgnored: diffSummary.outsideMaskChangesIgnored,
        },
        message: "Candidate contains pixels outside the target mask.",
        severity: "warning",
      });
    }
    if (paletteDriftColors.length > 0) {
      diagnostics.push({
        code: "palette-drift",
        details: { colors: paletteDriftColors },
        message: "Candidate introduces colors outside the source palette.",
        severity: "warning",
      });
    }
    if (maskCoverageRatio < 0.05) {
      diagnostics.push({
        code: "low-mask-change",
        details: { maskCoverageRatio },
        message: "Candidate changes very little inside the selected mask.",
        severity: "info",
      });
    }
    if (alphaBBoxDriftPixels > 8) {
      diagnostics.push({
        code: "large-alpha-drift",
        details: { alphaBBoxDriftPixels },
        message: "Candidate changes the visible alpha bbox substantially.",
        severity: "warning",
      });
    }
    const outsidePenalty = Math.min(
      0.35,
      diffSummary.outsideMaskChangesIgnored / maskPixelCount
    );
    const palettePenalty = Math.min(0.25, paletteDriftColors.length * 0.05);
    const bboxPenalty = Math.min(0.2, alphaBBoxDriftPixels / 64);
    const lowChangePenalty = maskCoverageRatio < 0.05 ? 0.2 : 0;
    const modelScore = candidate.score ?? 1;
    const score = Math.max(
      0,
      Math.min(
        1,
        modelScore * (1 - outsidePenalty - palettePenalty - bboxPenalty) -
          lowChangePenalty
      )
    );
    return {
      alphaBBoxDriftPixels,
      candidateId: candidate.id,
      comparePreviewUrl: `/runs/${document.runId}/editor/imagegen-results/${result.id}/compare/${candidate.id}/image`,
      diagnostics,
      diffSummary,
      frameId: candidate.frameId,
      maskCoverageRatio,
      outsideMaskIgnoredPixels: diffSummary.outsideMaskChangesIgnored,
      paletteDriftColors,
      recommendations:
        diagnostics.length > 0
          ? [
              "Review comparePreviewUrl before applying this candidate.",
              "Prefer candidates with low outside-mask and palette drift.",
            ]
          : ["Candidate passes deterministic mask and palette checks."],
      score,
    };
  }

  private imagegenSourceFrame(
    document: EditorDocument,
    frameId: string
  ): EditorDocument["frames"][number] {
    const frame = document.frames.find((item) => item.frameId === frameId);
    if (!frame) {
      throw new Error(`Editor frame not found: ${frameId}`);
    }
    return frame;
  }

  private imagegenMaskLayer(
    document: EditorDocument,
    maskLayerId: string
  ): EditorMaskLayer {
    const layer = document.masks.find((item) => item.id === maskLayerId);
    if (!layer) {
      throw new Error(`Mask layer not found: ${maskLayerId}`);
    }
    return layer;
  }

  private applyCandidateGridToFrame(
    frame: EditorDocument["frames"][number],
    layer: EditorMaskLayer,
    request: ImagegenRequestArtifact,
    candidateGrid: PixelGrid
  ): PixelGrid {
    const cells = [...frame.grid.cells];
    const { bbox } = request.reference;
    for (const [index, enabled] of layer.mask.entries()) {
      if (!enabled) {
        continue;
      }
      const x = index % frame.grid.size.width;
      const y = Math.floor(index / frame.grid.size.width);
      const candidateIndex =
        candidateGrid.size.width === frame.grid.size.width &&
        candidateGrid.size.height === frame.grid.size.height
          ? index
          : (y - bbox.y) * candidateGrid.size.width + (x - bbox.x);
      if (candidateIndex >= 0 && candidateIndex < candidateGrid.cells.length) {
        cells[index] = candidateGrid.cells[candidateIndex] ?? null;
      }
    }
    return this.normalizePixelGrid({ ...frame.grid, cells });
  }

  private buildImagegenCompareGrid(
    before: PixelGrid,
    after: PixelGrid,
    candidateGrid: PixelGrid | undefined,
    request: ImagegenRequestArtifact
  ): PixelGrid {
    const gap = 2;
    const width = before.size.width * 3 + gap * 2;
    const { height } = before.size;
    const cells: PixelCell[] = Array.from(
      { length: width * height },
      () => null
    );
    const setPanelCell = (
      panel: number,
      x: number,
      y: number,
      color: PixelCell
    ) => {
      const panelX = panel * (before.size.width + gap) + x;
      cells[y * width + panelX] = color;
    };
    const maskPixels = new Set(
      request.reference.exactMaskPixels.map((point) => `${point.x},${point.y}`)
    );
    for (let index = 0; index < before.cells.length; index += 1) {
      const x = index % before.size.width;
      const y = Math.floor(index / before.size.width);
      setPanelCell(0, x, y, before.cells[index] ?? null);
      setPanelCell(1, x, y, after.cells[index] ?? null);
      if ((before.cells[index] ?? null) !== (after.cells[index] ?? null)) {
        setPanelCell(2, x, y, "#4aa3ff");
      }
    }
    if (candidateGrid) {
      const { bbox } = request.reference;
      for (const [index, cell] of candidateGrid.cells.entries()) {
        if (!cell) {
          continue;
        }
        const x =
          candidateGrid.size.width === bbox.width
            ? bbox.x + (index % candidateGrid.size.width)
            : index % candidateGrid.size.width;
        const y =
          candidateGrid.size.width === bbox.width
            ? bbox.y + Math.floor(index / candidateGrid.size.width)
            : Math.floor(index / candidateGrid.size.width);
        if (!maskPixels.has(`${x},${y}`) && x >= 0 && y >= 0 && y < height) {
          setPanelCell(2, x, y, "#ff4b4b");
        }
      }
    }
    return this.normalizePixelGrid({
      cells,
      palette: [],
      size: { height, width },
    });
  }

  private paletteDriftColors(
    sourceGrid: PixelGrid,
    candidateGrid: PixelGrid | undefined
  ): string[] {
    if (!candidateGrid) {
      return [];
    }
    const sourcePalette = new Set(
      sourceGrid.palette.map((color) => color.toLowerCase())
    );
    return [
      ...new Set(
        candidateGrid.cells.flatMap((cell) =>
          cell && !sourcePalette.has(cell.slice(0, 7).toLowerCase())
            ? [cell.slice(0, 7).toLowerCase()]
            : []
        )
      ),
    ].slice(0, 16);
  }

  private alphaBBoxDriftPixels(
    sourceGrid: PixelGrid,
    nextGrid: PixelGrid
  ): number {
    const bboxForGrid = (grid: PixelGrid) =>
      bboxFromPoints(
        grid.cells.flatMap((cell, index) =>
          cell
            ? [
                {
                  x: index % grid.size.width,
                  y: Math.floor(index / grid.size.width),
                },
              ]
            : []
        )
      );
    const before = bboxForGrid(sourceGrid);
    const after = bboxForGrid(nextGrid);
    if (!(before && after)) {
      return before === after
        ? 0
        : sourceGrid.size.width + sourceGrid.size.height;
    }
    return (
      Math.abs(before.x - after.x) +
      Math.abs(before.y - after.y) +
      Math.abs(before.width - after.width) +
      Math.abs(before.height - after.height)
    );
  }

  private diffCandidateAgainstMask(
    request: ImagegenRequestArtifact,
    candidateGrid: PixelGrid
  ): ImagegenResultArtifact["diffSummary"] {
    const { bbox } = request.reference;
    const maskPixels = new Set(
      request.reference.exactMaskPixels.map((point) => `${point.x},${point.y}`)
    );
    let changedInsideMask = 0;
    let outsideMaskChangesIgnored = 0;
    for (const [index, cell] of candidateGrid.cells.entries()) {
      if (!cell) {
        continue;
      }
      const x =
        candidateGrid.size.width === bbox.width
          ? bbox.x + (index % candidateGrid.size.width)
          : index % candidateGrid.size.width;
      const y =
        candidateGrid.size.width === bbox.width
          ? bbox.y + Math.floor(index / candidateGrid.size.width)
          : Math.floor(index / candidateGrid.size.width);
      if (maskPixels.has(`${x},${y}`)) {
        changedInsideMask += 1;
      } else {
        outsideMaskChangesIgnored += 1;
      }
    }
    return { changedInsideMask, outsideMaskChangesIgnored };
  }

  private detectAnimationMotion(
    document: EditorDocument
  ): VisualSummary["animation"]["movingRegions"] {
    const movingRegions: VisualSummary["animation"]["movingRegions"] = [];
    const orderedFrames = document.timeline.framesList
      .map((frameId) =>
        document.frames.find((frame) => frame.frameId === frameId)
      )
      .filter(Boolean);
    for (let index = 1; index < orderedFrames.length; index += 1) {
      const previous = orderedFrames[index - 1];
      const current = orderedFrames[index];
      if (!previous || !current) {
        continue;
      }
      const changedPixels: { x: number; y: number }[] = [];
      const total = Math.min(
        previous.grid.cells.length,
        current.grid.cells.length
      );
      for (let pixelIndex = 0; pixelIndex < total; pixelIndex += 1) {
        if (
          previous.grid.cells[pixelIndex] !== current.grid.cells[pixelIndex]
        ) {
          changedPixels.push({
            x: pixelIndex % current.grid.size.width,
            y: Math.floor(pixelIndex / current.grid.size.width),
          });
        }
      }
      const bbox = bboxFromPoints(changedPixels);
      if (bbox) {
        movingRegions.push({
          bbox,
          confidence: Math.min(1, changedPixels.length / Math.max(1, total)),
          description: `Frame ${index} changes ${changedPixels.length} pixel(s) from previous frame.`,
          id: `motion_${index}`,
          kind: "motion-region",
          pixels: changedPixels.slice(0, 64),
        });
      }
    }
    return movingRegions;
  }

  private diffOrderedFrames(
    frames: EditorDocument["frames"]
  ): AnimationInspection["frameDiffs"] {
    const diffs: AnimationInspection["frameDiffs"] = [];
    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1];
      const current = frames[index];
      if (previous && current) {
        diffs.push(this.diffFrames(previous, current));
      }
    }
    return diffs;
  }

  private orderedEditorFrames(
    document: EditorDocument
  ): EditorDocument["frames"] {
    return document.timeline.framesList
      .map((frameId) =>
        document.frames.find((frame) => frame.frameId === frameId)
      )
      .filter((frame) => frame !== undefined);
  }

  private buildFlickerFixPatches(
    document: EditorDocument,
    frames: EditorDocument["frames"]
  ): AnimationFixResult["appliedPatches"] {
    if (frames.length < 3) {
      return [];
    }
    const patches: AnimationFixResult["appliedPatches"] = [];
    const size = frames[0]?.grid.size;
    if (!size) {
      return patches;
    }
    const selectedFrameIds = new Set(frames.map((frame) => frame.frameId));
    for (const region of this.detectFlickerRegions(
      this.orderedEditorFrames(document)
    )) {
      for (const point of region.pixels) {
        const index = point.y * size.width + point.x;
        for (
          let frameIndex = 1;
          frameIndex < frames.length - 1;
          frameIndex += 1
        ) {
          const previous = frames[frameIndex - 1];
          const current = frames[frameIndex];
          const next = frames[frameIndex + 1];
          if (!(previous && current && next)) {
            continue;
          }
          if (!selectedFrameIds.has(current.frameId)) {
            continue;
          }
          const before = current.grid.cells[index] ?? null;
          const stable = this.stableNeighborCell(
            previous.grid.cells[index] ?? null,
            next.grid.cells[index] ?? null
          );
          if (stable !== undefined && before !== stable) {
            patches.push({
              after: stable,
              before,
              frameId: current.frameId,
              reason:
                "flicker pixel replaced with matching neighboring frame value",
              x: point.x,
              y: point.y,
            });
          }
        }
      }
    }
    return patches;
  }

  private animationFixPatchKey(
    patch: AnimationFixResult["appliedPatches"][number]
  ): string {
    return `${patch.frameId}:${patch.x}:${patch.y}`;
  }

  private buildLoopRepairPatches(
    frames: EditorDocument["frames"]
  ): AnimationFixResult["appliedPatches"] {
    if (frames.length < 2) {
      return [];
    }
    const [first] = frames;
    const last = frames.at(-1);
    if (!(first && last)) {
      return [];
    }
    const patches: AnimationFixResult["appliedPatches"] = [];
    const total = Math.min(first.grid.cells.length, last.grid.cells.length);
    for (let index = 0; index < total; index += 1) {
      const before = last.grid.cells[index] ?? null;
      const after = first.grid.cells[index] ?? null;
      if (before !== after) {
        patches.push({
          after,
          before,
          frameId: last.frameId,
          reason: "last frame repaired to match first frame for loop closure",
          x: index % last.grid.size.width,
          y: Math.floor(index / last.grid.size.width),
        });
      }
    }
    return patches;
  }

  private buildMaskMotionSmoothingPatches(
    document: EditorDocument,
    frames: EditorDocument["frames"],
    maskLayerId: string | undefined
  ): AnimationFixResult["appliedPatches"] {
    if (frames.length < 3) {
      return [];
    }
    const layers = maskLayerId
      ? document.masks.filter((layer) => layer.id === maskLayerId)
      : document.masks;
    const patches: AnimationFixResult["appliedPatches"] = [];
    for (const layer of layers) {
      const maskIndexes = layer.mask.flatMap((enabled, index) =>
        enabled ? [index] : []
      );
      for (const index of maskIndexes) {
        for (
          let frameIndex = 1;
          frameIndex < frames.length - 1;
          frameIndex += 1
        ) {
          const previous = frames[frameIndex - 1];
          const current = frames[frameIndex];
          const next = frames[frameIndex + 1];
          if (!(previous && current && next)) {
            continue;
          }
          const before = current.grid.cells[index] ?? null;
          const stable = this.stableNeighborCell(
            previous.grid.cells[index] ?? null,
            next.grid.cells[index] ?? null
          );
          if (stable !== undefined && before !== stable) {
            patches.push({
              after: stable,
              before,
              frameId: current.frameId,
              reason: `mask ${layer.id} smoothed to neighboring frame value`,
              x: index % current.grid.size.width,
              y: Math.floor(index / current.grid.size.width),
            });
          }
        }
      }
    }
    return patches;
  }

  private stableNeighborCell(
    previous: PixelCell,
    next: PixelCell
  ): PixelCell | undefined {
    return previous === next ? previous : undefined;
  }

  private diffFrames(
    previous: EditorDocument["frames"][number],
    current: EditorDocument["frames"][number]
  ): AnimationInspection["frameDiffs"][number] {
    const changedPixels: { x: number; y: number }[] = [];
    let silhouetteChangedPixels = 0;
    const total = Math.min(
      previous.grid.cells.length,
      current.grid.cells.length
    );
    for (let index = 0; index < total; index += 1) {
      const before = previous.grid.cells[index];
      const after = current.grid.cells[index];
      if (before === after) {
        continue;
      }
      const x = index % current.grid.size.width;
      const y = Math.floor(index / current.grid.size.width);
      changedPixels.push({ x, y });
      if (Boolean(before) !== Boolean(after)) {
        silhouetteChangedPixels += 1;
      }
    }
    const changedRatio = changedPixels.length / Math.max(1, total);
    return {
      changedPixels: changedPixels.length,
      changedRatio,
      fromFrameId: previous.frameId,
      motionBBox: bboxFromPoints(changedPixels),
      silhouetteChangedPixels,
      silhouetteWarning:
        silhouetteChangedPixels / Math.max(1, total) > 0.08
          ? `${previous.frameId} -> ${current.frameId} changes silhouette by ${silhouetteChangedPixels} pixel(s).`
          : null,
      toFrameId: current.frameId,
    };
  }

  private detectFlickerRegions(
    frames: EditorDocument["frames"]
  ): AnimationInspection["flickerRegions"] {
    if (frames.length < 3) {
      return [];
    }
    const flickerPixels: { x: number; y: number }[] = [];
    const size = frames[0]?.grid.size;
    if (!size) {
      return [];
    }
    for (let index = 0; index < size.width * size.height; index += 1) {
      let toggles = 0;
      for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
        if (
          Boolean(frames[frameIndex - 1]?.grid.cells[index]) !==
          Boolean(frames[frameIndex]?.grid.cells[index])
        ) {
          toggles += 1;
        }
      }
      if (toggles >= 2) {
        flickerPixels.push({
          x: index % size.width,
          y: Math.floor(index / size.width),
        });
      }
    }
    const bbox = bboxFromPoints(flickerPixels);
    return bbox
      ? [
          {
            bbox,
            confidence: Math.min(1, flickerPixels.length / 16),
            description: `${flickerPixels.length} pixel(s) toggle repeatedly across the timeline.`,
            pixels: flickerPixels.slice(0, 128),
          },
        ]
      : [];
  }

  private trackMaskMotion(
    layer: EditorMaskLayer,
    frames: EditorDocument["frames"]
  ): AnimationInspection["maskMotionTracks"][number] {
    const keyframes: AnimationInspection["maskMotionTracks"][number]["keyframes"] =
      [];
    const maskIndexes = layer.mask.flatMap((enabled, index) =>
      enabled ? [index] : []
    );
    for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
      const previous = frames[frameIndex - 1];
      const current = frames[frameIndex];
      if (previous && current) {
        const changedPoints = maskIndexes.flatMap((index) =>
          previous.grid.cells[index] === current.grid.cells[index]
            ? []
            : [
                {
                  x: index % current.grid.size.width,
                  y: Math.floor(index / current.grid.size.width),
                },
              ]
        );
        keyframes.push({
          changedPixels: changedPoints.length,
          frameId: current.frameId,
          motionBBox: bboxFromPoints(changedPoints),
        });
      }
    }
    const averageChangedPixels =
      keyframes.reduce((sum, item) => sum + item.changedPixels, 0) /
      Math.max(1, keyframes.length);
    return {
      averageChangedPixels,
      keyframes,
      maskLayerId: layer.id,
      partKind: layer.partKind,
      semanticLabel: layer.semanticLabel || layer.name,
      semanticRole: layer.semanticRole,
      stability: Math.max(
        0,
        Math.min(1, 1 - averageChangedPixels / Math.max(1, maskIndexes.length))
      ),
    };
  }

  private inspectFrameDocument(
    document: EditorDocument,
    frame: EditorDocument["frames"][number]
  ): FrameVisualInspection {
    const visiblePixels = frame.grid.cells.flatMap((color, index) =>
      color
        ? [
            {
              color,
              x: index % frame.grid.size.width,
              y: Math.floor(index / frame.grid.size.width),
            },
          ]
        : []
    );
    const alphaBBox = frame.alphaBBox ?? bboxFromPoints(visiblePixels);
    const features: FrameVisualInspection["features"] = [];
    if (alphaBBox) {
      features.push({
        bbox: alphaBBox,
        confidence: 1,
        description: "Visible sprite silhouette.",
        id: "alpha_bbox",
        kind: "alpha-bbox",
        pixels: [],
      });
      const faceBBox = {
        height: Math.max(1, Math.round(alphaBBox.height * 0.36)),
        width: Math.max(1, Math.round(alphaBBox.width * 0.72)),
        x: alphaBBox.x + Math.max(0, Math.round(alphaBBox.width * 0.14)),
        y: alphaBBox.y,
      };
      features.push({
        bbox: faceBBox,
        confidence: 0.54,
        description:
          "Likely face/head detail zone based on upper visible silhouette.",
        id: "face_candidate",
        kind: "face-candidate",
        pixels: [],
      });
      const eyePixels = visiblePixels
        .filter(
          (pixel) =>
            pixel.x >= faceBBox.x &&
            pixel.x < faceBBox.x + faceBBox.width &&
            pixel.y >= faceBBox.y &&
            pixel.y < faceBBox.y + faceBBox.height &&
            luminance(pixel.color) < 80
        )
        .slice(0, 16);
      if (eyePixels.length) {
        features.push({
          bbox: bboxFromPoints(eyePixels),
          confidence: Math.min(0.92, 0.45 + eyePixels.length / 24),
          description:
            "Likely eye or facial contrast pixels; inspect before recoloring.",
          id: "eye_candidate",
          kind: "eye-candidate",
          pixels: eyePixels.map(({ x, y }) => ({ x, y })),
        });
      }
    }
    for (const layer of document.masks) {
      const pixels = layer.mask.flatMap((enabled, index) =>
        enabled
          ? [
              {
                x: index % document.canvas.width,
                y: Math.floor(index / document.canvas.width),
              },
            ]
          : []
      );
      const bbox = bboxFromPoints(pixels);
      if (bbox) {
        features.push({
          bbox,
          confidence: layer.semanticRole === "unknown" ? 0.6 : 0.95,
          description:
            layer.promptHint ||
            `${layer.semanticLabel || layer.partKind || layer.name} mask for targeted animation or regeneration.`,
          id: `mask_${layer.id}`,
          kind: "mask-part",
          maskLayerId: layer.id,
          pixels: pixels.slice(0, 64),
        });
      }
    }
    const eyeFeature = features.find(
      (feature) => feature.id === "eye_candidate"
    );
    const zoomHints = [
      ...(alphaBBox
        ? [
            {
              bbox: alphaBBox,
              label: "sprite-silhouette",
              reason: "Full visible sprite bounds.",
            },
          ]
        : []),
      ...(eyeFeature?.bbox
        ? [
            {
              bbox: eyeFeature.bbox,
              label: "face-detail",
              reason: "Likely tiny facial details such as eyes or mouth.",
            },
          ]
        : []),
    ];
    return {
      alphaBBox,
      dominantColors: frame.grid.palette.slice(0, 8),
      features,
      frameId: frame.frameId,
      fullPreviewUrl: `/runs/${document.runId}/frames/${frame.frameId}/image`,
      humanSummary: `${frame.name}: ${visiblePixels.length} visible pixel(s), ${frame.grid.palette.length} palette color(s), ${document.masks.length} mask layer(s).`,
      pixelMapUrl: `/runs/${document.runId}/editor/frames/${frame.frameId}/pixels`,
      recommendations: [
        "Use pixelMapUrl for exact edits and fullPreviewUrl for human-scale review.",
        "Use mask-part features for targeted imagegen/regeneration boundaries.",
        "Confirm eye-candidate pixels with a zoom crop before recoloring facial details.",
      ],
      zoomHints,
    };
  }

  private async readJobByPath(path: string): Promise<PersistentJob> {
    return jobSchema.parse(await readJsonFile(path));
  }
}
