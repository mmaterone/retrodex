import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupPipelines,
  deterministicPresets,
  savedAnimationSchema,
  schemaVersion,
} from "@retrodex/contracts";
import type {
  CleanupPipeline,
  ExportTarget,
  Frame,
  Run,
  SavedAnimation,
} from "@retrodex/contracts";

import { writeJsonAtomic } from "./json.js";
import {
  cleanupFrameWithPython,
  exportAnimationWithPython,
  readPixelGridWithPython,
} from "./python-worker.js";
import { createExportInputSchema } from "./run-repository.js";
import type {
  CreateExportInput,
  PersistentJob,
  RunRepository,
} from "./run-repository.js";

const nowIso = (): string => new Date().toISOString();

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 64) || "export";

const errorPayload = (
  error: unknown,
  code = "job-failed",
  retryable = true
): NonNullable<PersistentJob["error"]> => ({
  code,
  message: error instanceof Error ? error.message : String(error),
  retryable,
});

const exportTargetPath = (
  target: ExportTarget,
  exportDir: string,
  files: Awaited<ReturnType<typeof exportAnimationWithPython>>
): string => {
  const paths: Record<ExportTarget, string> = {
    aseprite: files.stripTransparent,
    css: files.css,
    "game-strip": files.stripTransparent,
    godot: files.stripTransparent,
    lottie: files.lottie,
    "raw-frames": join(exportDir, "raw-frames"),
    react: files.react,
    svg: files.svg,
    texturepacker: files.stripTransparent,
    tgs: files.tgs,
    webp: files.webp,
  };
  return paths[target];
};

const relativeExportPath = (exportDir: string, path: string): string =>
  path.startsWith(exportDir) ? path.slice(exportDir.length + 1) : path;

const fileExists = async (
  path: string
): Promise<{ bytes: number; exists: boolean }> => {
  try {
    const fileStat = await stat(path);
    return {
      bytes: fileStat.isFile() ? fileStat.size : 0,
      exists: fileStat.isFile() || fileStat.isDirectory(),
    };
  } catch {
    return { bytes: 0, exists: false };
  }
};

/* eslint-disable no-bitwise, unicorn/prefer-math-trunc */
const crcTable = Array.from({ length: 256 }, (_, tableIndex) => {
  let value = tableIndex;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (buffer: Buffer): number => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const dosDateTime = (date: Date): { date: number; time: number } => ({
  date:
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate(),
  time:
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2),
});
/* eslint-enable no-bitwise, unicorn/prefer-math-trunc */

const createStoredZip = async (
  outputPath: string,
  entries: { name: string; path: string }[]
): Promise<void> => {
  const now = dosDateTime(new Date("2026-06-04T00:00:00.000Z"));
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const content = await readFile(entry.path);
    const name = Buffer.from(entry.name, "utf-8");
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await writeFile(
    outputPath,
    Buffer.concat([...localParts, ...centralParts, end])
  );
};

export class JobRunner {
  private readonly activeJobs = new Set<string>();
  private readonly repository: RunRepository;

  constructor(repository: RunRepository) {
    this.repository = repository;
  }

  async cancelJob(jobId: string): Promise<PersistentJob | null> {
    const job = await this.repository.readJob(jobId);
    if (!job) {
      return null;
    }
    if (job.status === "succeeded" || job.status === "failed") {
      return job;
    }
    return this.repository.writeJob({
      ...job,
      cancelledAt: nowIso(),
      error: {
        code: "job-cancelled",
        message: "Job was cancelled by request.",
        retryable: true,
      },
      status: "cancelled",
    });
  }

  async createCleanupJob(runId: string): Promise<PersistentJob> {
    const job = await this.repository.createJob(runId, "cleanup");
    this.schedule(job);
    return job;
  }

  async createExportJob(
    runId: string,
    inputValue: unknown
  ): Promise<PersistentJob> {
    const input = createExportInputSchema.parse(inputValue);
    const job = await this.repository.createJob(runId, "export");
    this.schedule(job, input);
    return job;
  }

  getJob(id: string): Promise<PersistentJob | null> {
    return this.repository.readJob(id);
  }

  async recoverQueuedJobs(): Promise<void> {
    const jobs = await this.repository.recoverJobs();
    for (const job of jobs.filter((item) => item.status === "queued")) {
      this.schedule(job);
    }
  }

  private static materializePipeline(run: Run): CleanupPipeline {
    const preset = Object.values(deterministicPresets).find(
      (item) => item.id === run.presetId
    );
    return preset ? preset.cleanupPipeline : cleanupPipelines[0];
  }

  private schedule(job: PersistentJob, exportInput?: CreateExportInput): void {
    if (this.activeJobs.has(job.id)) {
      return;
    }
    this.activeJobs.add(job.id);
    setTimeout(() => {
      void this.executeScheduled(job, exportInput);
    }, 0);
  }

  private async executeScheduled(
    job: PersistentJob,
    exportInput?: CreateExportInput
  ): Promise<void> {
    await this.execute(job, exportInput);
    this.activeJobs.delete(job.id);
  }

  private async execute(
    job: PersistentJob,
    exportInput?: CreateExportInput
  ): Promise<void> {
    const currentJob = await this.repository.readJob(job.id);
    if (!currentJob || currentJob.status === "cancelled") {
      return;
    }

    const startedJob = await this.repository.writeJob({
      ...currentJob,
      startedAt: currentJob.startedAt ?? nowIso(),
      status: "running",
    });

    try {
      await (startedJob.type === "cleanup"
        ? this.executeCleanup(startedJob)
        : this.executeExport(startedJob, exportInput));
    } catch (error) {
      await this.repository.writeJob({
        ...startedJob,
        completedAt: nowIso(),
        error: errorPayload(error),
        retryHints: ["Inspect job diagnostics and retry after fixing inputs."],
        status: "failed",
      });
    }
  }

  private async executeCleanup(job: PersistentJob): Promise<void> {
    const run = await this.repository.readRun(job.runId);
    const cleaningRun = await this.repository.writeRun({
      ...run,
      status: "cleaning",
    });
    const pipeline = JobRunner.materializePipeline(cleaningRun);
    const paletteLock = await this.readApprovedPalette(cleaningRun);
    const frames: Frame[] = [];

    for (const [index, frameId] of cleaningRun.activeFrameIds.entries()) {
      const refreshedJob = await this.repository.readJob(job.id);
      if (refreshedJob?.status === "cancelled") {
        return;
      }
      await this.repository.writeJob({
        ...(refreshedJob ?? job),
        currentFrameId: frameId,
        currentStepId: pipeline.steps.find((step) => step.enabled)?.id ?? null,
        progress: { done: index, total: cleaningRun.activeFrameIds.length },
        status: "running",
      });
      const result = await cleanupFrameWithPython({
        frameId,
        jobId: job.id,
        paletteLock,
        pipeline,
        run: cleaningRun,
      });
      await this.repository.writeFrame(cleaningRun, result.frame);
      frames.push(result.frame);
      await this.repository.writeJob({
        ...((await this.repository.readJob(job.id)) ?? job),
        currentFrameId: frameId,
        currentStepId: null,
        frames,
        progress: { done: index + 1, total: cleaningRun.activeFrameIds.length },
        retryHints: frames.flatMap((frame) => frame.qc.retryHints),
        status: "running",
      });
    }

    const failedFrames = frames.filter((frame) => !frame.qc.passes);
    await this.repository.writeRun({
      ...cleaningRun,
      approval: {
        approvedFrames: [],
        updatedAt: nowIso(),
      },
      qc: {
        blockingIssues: failedFrames.map(
          (frame) => `${frame.id}: ${frame.qc.blockingIssues.join("; ")}`
        ),
        passes: failedFrames.length === 0,
        retryHints: failedFrames.flatMap((frame) => frame.qc.retryHints),
        warnings: frames.flatMap((frame) => frame.qc.warnings),
      },
      status: failedFrames.length === 0 ? "review" : "rejected",
    });
    await this.repository.writeJob({
      ...((await this.repository.readJob(job.id)) ?? job),
      completedAt: nowIso(),
      currentFrameId: null,
      currentStepId: null,
      error: null,
      frames,
      progress: {
        done: frames.length,
        total: cleaningRun.activeFrameIds.length,
      },
      retryHints: frames.flatMap((frame) => frame.qc.retryHints),
      status: "succeeded",
    });
  }

  private async readApprovedPalette(run: Run): Promise<string[]> {
    const approvedFrameIds = new Set(
      run.approval.approvedFrames.map((item) => item.frameId)
    );
    const frames = await Promise.all(
      [...approvedFrameIds].map(async (frameId) => {
        try {
          return await this.repository.readFrame(run, frameId);
        } catch {
          return null;
        }
      })
    );
    return [...new Set(frames.flatMap((frame) => frame?.palette.colors ?? []))];
  }

  private async buildEditorExportDiff(
    run: Run,
    savedAnimation: SavedAnimation
  ): Promise<unknown> {
    try {
      const document = await this.repository.readEditorDocument(run.id);
      const diffs = await Promise.all(
        savedAnimation.frames.map(async (frame) => {
          const editorFrame = document.frames.find(
            (item) => item.frameId === frame.sourceFrameId
          );
          if (!editorFrame) {
            return {
              changedPixels: 0,
              frameId: frame.sourceFrameId,
              status: "editor-frame-missing",
            };
          }
          const exported = await readPixelGridWithPython(frame.savedPath);
          let changedPixels = 0;
          for (const [index, cell] of editorFrame.grid.cells.entries()) {
            if (cell !== (exported.grid.cells[index] ?? null)) {
              changedPixels += 1;
            }
          }
          return {
            changedPixels,
            frameId: frame.sourceFrameId,
            status: changedPixels === 0 ? "matching" : "changed",
          };
        })
      );
      return {
        checkedAt: nowIso(),
        diffs,
        runId: run.id,
        summary: `${diffs.filter((diff) => diff.status === "changed").length} frame(s) differ from editor state.`,
      };
    } catch (error) {
      return {
        checkedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error),
        runId: run.id,
        summary: "Editor diff could not be computed.",
      };
    }
  }

  private static async validateExportArtifacts(
    exportDir: string,
    savedAnimation: SavedAnimation,
    savedAnimationPath: string
  ): Promise<unknown> {
    const entries = [
      { kind: "metadata", name: "savedAnimation", path: savedAnimationPath },
      ...Object.entries(savedAnimation.files).map(([name, path]) => ({
        kind: "file",
        name,
        path,
      })),
      ...savedAnimation.exports.map((item) => ({
        kind: "target",
        name: item.target,
        path: item.path,
      })),
    ];
    const artifacts = await Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        relativePath: relativeExportPath(exportDir, entry.path),
        ...(await fileExists(entry.path)),
      }))
    );
    const missing = artifacts.filter((artifact) => !artifact.exists);
    return {
      artifacts,
      checkedAt: nowIso(),
      missing: missing.map((artifact) => artifact.name),
      passes: missing.length === 0,
      recommendations:
        missing.length === 0
          ? ["All declared export artifacts exist."]
          : [
              "Regenerate the export; one or more declared artifacts are missing.",
            ],
    };
  }

  private async executeExport(
    job: PersistentJob,
    inputValue?: CreateExportInput
  ): Promise<void> {
    if (!inputValue) {
      throw new Error("Export job is missing export input.");
    }
    const input = createExportInputSchema.parse(inputValue);
    const run = await this.repository.readRun(job.runId);
    const frames = await Promise.all(
      run.activeFrameIds.map((frameId) =>
        this.repository.readFrame(run, frameId)
      )
    );
    const frameById = new Map(frames.map((frame) => [frame.id, frame]));
    const approvedFrameIds = run.approval.approvedFrames.map(
      (item) => item.frameId
    );
    const approvedFrameIdSet = new Set(approvedFrameIds);
    const staleApprovals = approvedFrameIds.filter(
      (frameId) => !frameById.has(frameId)
    );
    if (staleApprovals.length) {
      throw new Error(
        `Export approval references missing frames: ${staleApprovals.join(", ")}.`
      );
    }
    const approvedFrames = approvedFrameIds.map((frameId) => {
      const frame = frameById.get(frameId);
      if (!frame) {
        throw new Error(`Approved frame is missing from run: ${frameId}.`);
      }
      return frame;
    });
    if (!approvedFrames.length) {
      throw new Error("Export requires at least one approved frame.");
    }
    const existingDraft = await this.repository.readDraft(run);
    if (existingDraft) {
      const unapprovedDraftFrames = existingDraft.framesList.filter(
        (frameId) => !approvedFrameIdSet.has(frameId)
      );
      if (unapprovedDraftFrames.length) {
        throw new Error(
          `Export draft references unapproved frames: ${unapprovedDraftFrames.join(", ")}.`
        );
      }
    }
    const draft = existingDraft ?? {
      canvasSize: run.canvas,
      fps: input.fps ?? 8,
      frames: Object.fromEntries(
        approvedFrames.map((frame) => [
          frame.id,
          {
            frameId: frame.id,
            framePath: frame.path,
            transforms: {},
          },
        ])
      ),
      framesList: approvedFrames.map((frame) => frame.id),
      rigParts: [],
      runId: run.id,
      schemaVersion,
      updatedAt: nowIso(),
    };
    await this.repository.writeDraft(run, draft);

    const exportId = `export_${slugify(input.name)}_${Date.now().toString(36)}`;
    const exportDir = this.repository.exportDir(run, exportId);
    await mkdir(exportDir, { recursive: true });
    const frameCopies = await Promise.all(
      draft.framesList.map(async (frameId, index) => {
        const sourcePath = this.repository.framePngPath(run, frameId);
        const savedPath = join(exportDir, "raw-frames", `${frameId}.png`);
        await mkdir(join(exportDir, "raw-frames"), { recursive: true });
        await copyFile(sourcePath, savedPath);
        return { index, savedPath, sourceFrameId: frameId, sourcePath };
      })
    );

    const files = await exportAnimationWithPython({
      draft,
      exportDir,
      fps: input.fps ?? draft.fps,
      frames: frameCopies,
      name: input.name,
    });
    const manifestPath = join(exportDir, "manifest.json");
    const validationPath = join(exportDir, "validation.json");
    const editorDiffPath = join(exportDir, "editor-diff.json");
    const shareBundlePath = join(exportDir, "share-bundle.zip");
    const savedAnimation: SavedAnimation = savedAnimationSchema.parse({
      approval: {
        approvedFrames: run.approval.approvedFrames.filter((item) =>
          draft.framesList.includes(item.frameId)
        ),
      },
      canvas: run.canvas,
      createdAt: nowIso(),
      exports: input.targets.map((target) => ({
        path: exportTargetPath(target, exportDir, files),
        target,
      })),
      files: {
        contactSheet: files.contactSheet,
        css: files.css,
        draft: this.repository.draftPath(run),
        editorDiff: editorDiffPath,
        gif: files.gif,
        lottie: files.lottie,
        manifest: manifestPath,
        preview: files.preview,
        react: files.react,
        shareBundle: shareBundlePath,
        stripTransparent: files.stripTransparent,
        svg: files.svg,
        tgs: files.tgs,
        tgsMetadata: files.tgsMetadata,
        validation: validationPath,
        webp: files.webp,
      },
      fps: input.fps ?? draft.fps,
      frames: frameCopies,
      id: exportId,
      name: input.name,
      runId: run.id,
      schemaVersion,
      slug: slugify(input.name),
    });

    const editorDiff = await this.buildEditorExportDiff(run, savedAnimation);
    await writeJsonAtomic(editorDiffPath, editorDiff);
    const manifest = {
      artifactMap: Object.fromEntries(
        Object.entries(savedAnimation.files).map(([key, path]) => [
          key,
          relativeExportPath(exportDir, path),
        ])
      ),
      canvas: savedAnimation.canvas,
      createdAt: savedAnimation.createdAt,
      engineHints: {
        cssClass: `${savedAnimation.slug}-pixel-animation`,
        fps: savedAnimation.fps,
        frameCount: savedAnimation.frames.length,
        frameHeight: savedAnimation.canvas.height,
        frameWidth: savedAnimation.canvas.width,
      },
      exportId,
      formats: input.targets,
      frames: savedAnimation.frames.map((frame) => ({
        approved: approvedFrameIdSet.has(frame.sourceFrameId),
        index: frame.index,
        path: relativeExportPath(exportDir, frame.savedPath),
        sourceFrameId: frame.sourceFrameId,
        sourceHeight: savedAnimation.canvas.height,
        sourceWidth: savedAnimation.canvas.width,
        sourceX: 0,
        sourceY: 0,
        stripHeight: savedAnimation.canvas.height,
        stripWidth: savedAnimation.canvas.width,
        stripX: frame.index * savedAnimation.canvas.width,
        stripY: 0,
        transforms: draft.frames[frame.sourceFrameId]?.transforms ?? {},
      })),
      logicalCanvas: savedAnimation.canvas,
      masks: draft.rigParts,
      runId: run.id,
      schemaVersion,
      timeline: {
        fps: savedAnimation.fps,
        frameIds: draft.framesList,
      },
    };
    await writeJsonAtomic(manifestPath, manifest);
    await this.repository.writeExport(run, savedAnimation);
    const savedAnimationPath = this.repository.exportJsonPath(run, exportId);
    await writeJsonAtomic(validationPath, {
      checkedAt: nowIso(),
      passes: false,
      pending: true,
    });
    const candidateZipEntries = await Promise.all(
      [
        { name: "saved-animation.json", path: savedAnimationPath },
        { name: "manifest.json", path: manifestPath },
        { name: "editor-diff.json", path: editorDiffPath },
        ...Object.entries(savedAnimation.files)
          .filter(([key]) => key !== "shareBundle")
          .map(([key, path]) => ({
            name: `files/${key}-${relativeExportPath(exportDir, path).replaceAll("/", "-")}`,
            path,
          })),
        ...savedAnimation.frames.map((frame) => ({
          name: `raw-frames/${frame.sourceFrameId}.png`,
          path: frame.savedPath,
        })),
      ].map(async (entry) => {
        const file = await fileExists(entry.path);
        return file.exists ? entry : null;
      })
    );
    const zipEntries = candidateZipEntries.filter(
      (entry): entry is { name: string; path: string } => entry !== null
    );
    await createStoredZip(shareBundlePath, zipEntries);
    await writeJsonAtomic(
      validationPath,
      await JobRunner.validateExportArtifacts(
        exportDir,
        savedAnimation,
        savedAnimationPath
      )
    );
    await copyFile(
      savedAnimationPath,
      join(run.paths.exportsDir, `${exportId}.saved-animation.json`)
    );
    await this.repository.writeRun({ ...run, status: "exported" });
    await this.repository.writeJob({
      ...job,
      completedAt: nowIso(),
      error: null,
      progress: { done: frameCopies.length, total: frameCopies.length },
      retryHints: [],
      status: "succeeded",
    });
  }
}
