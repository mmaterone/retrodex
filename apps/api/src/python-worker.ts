import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  AnimationDraft,
  CleanupPipeline,
  Frame,
  PixelGrid,
  Run,
} from "@retrodex/contracts";
import {
  frameSchema,
  pixelGridResponseSchema,
} from "@retrodex/contracts";

import { readJsonFile, writeJsonAtomic } from "./json.js";
import { repoRoot } from "./paths.js";

export interface CleanupFrameRequest {
  frameId: string;
  jobId: string;
  paletteLock: string[];
  pipeline: CleanupPipeline;
  run: Run;
}

export interface CleanupFrameResult {
  diagnosticsPath: string;
  frame: Frame;
}

export interface SheetSplitRequest {
  mode?: "auto-slice-components" | "split-sheet";
  run: Run;
  sheet: {
    alphaThreshold?: number;
    count?: number;
    frameHeight: number;
    frameWidth: number;
    minAreaFrac?: number;
    pad?: number;
    path: string;
  };
  startIndex: number;
}

export interface MaterializeFrameRequest {
  assetType: string;
  canvas: Run["canvas"];
  gridStrategy:
    | "infer-hidden-grid"
    | "preserve-source"
    | "resize-to-run-canvas";
  outputPath: string;
  sourcePath: string;
}

export interface MaterializeFrameResult {
  cropBox: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  gridInference: {
    confidence: number;
    reason: string;
    size: Run["canvas"];
    sourceCellSize: {
      height: number;
      width: number;
    };
  };
  originalSize: Run["canvas"];
  outputPath: string;
  strategy: string;
}

export interface ExportRequest {
  draft: AnimationDraft;
  exportDir: string;
  fps: number;
  frames: {
    index: number;
    savedPath: string;
    sourceFrameId: string;
    sourcePath: string;
  }[];
  name: string;
}

export interface ExportResult {
  contactSheet: string;
  css: string;
  gif: string;
  lottie: string;
  preview: string;
  react: string;
  svg: string;
  tgs: string;
  tgsMetadata: string;
  stripTransparent: string;
  webp: string;
}

export interface PixelGridResult {
  alphaBBox: Frame["alphaBBox"];
  grid: PixelGrid;
}

const defaultPython = join(repoRoot, ".venv", "bin", "python");

const runProcess = async (
  args: string[],
  timeoutMs = 120_000
): Promise<void> => {
  const child = spawn(
    process.env.PIXEL_CHARACTER_PYTHON ?? defaultPython,
    args,
    {
      env: {
        ...process.env,
        PYTHONPATH: join(repoRoot, "python"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2500);
  }, timeoutMs);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  const [code] = (await once(child, "close")) as [number | null];
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(
      stderr || `Python worker exited with code ${code ?? "unknown"}`
    );
  }
};

const runProcessJson = async (
  args: string[],
  timeoutMs = 30_000
): Promise<unknown> => {
  const child = spawn(
    process.env.PIXEL_CHARACTER_PYTHON ?? defaultPython,
    args,
    {
      env: {
        ...process.env,
        PYTHONPATH: join(repoRoot, "python"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2500);
  }, timeoutMs);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  const [code] = (await once(child, "close")) as [number | null];
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(
      stderr || `Python worker exited with code ${code ?? "unknown"}`
    );
  }
  return JSON.parse(stdout);
};

export const readPixelGridWithPython = async (
  path: string
): Promise<PixelGridResult> => {
  const result = pixelGridResponseSchema
    .omit({ frameId: true, previewUrl: true })
    .parse(
      await runProcessJson([
        "-m",
        "pixel_character_core.editor_pixels",
        "read",
        "--path",
        path,
      ])
    );
  return result;
};

export const writePixelGridWithPython = async ({
  grid,
  path,
  payloadPath,
}: {
  grid: PixelGrid;
  path: string;
  payloadPath: string;
}): Promise<PixelGridResult> => {
  await writeJsonAtomic(payloadPath, { grid });
  const result = pixelGridResponseSchema
    .omit({ frameId: true, previewUrl: true })
    .parse(
      await runProcessJson([
        "-m",
        "pixel_character_core.editor_pixels",
        "write",
        "--path",
        path,
        "--payload",
        payloadPath,
      ])
    );
  return result;
};

export const cleanupFrameWithPython = async ({
  frameId,
  jobId,
  paletteLock,
  pipeline,
  run,
}: CleanupFrameRequest): Promise<CleanupFrameResult> => {
  await mkdir(run.paths.pipelineDir, { recursive: true });
  const requestId = `cleanup_${frameId}_${Date.now().toString(36)}`;
  const inputPath = join(run.paths.pipelineDir, `${requestId}.request.json`);
  const outputPath = join(run.paths.pipelineDir, `${requestId}.result.json`);
  const diagnosticsPath = join(run.paths.diagnosticsDir, `${frameId}.qc.json`);

  await writeJsonAtomic(inputPath, {
    diagnosticsPath,
    frameId,
    inputPath: join(run.paths.framesDir, `${frameId}.png`),
    jobId,
    outputPath: join(run.paths.framesDir, `${frameId}.png`),
    paletteLock,
    pipeline,
    run,
  });

  await runProcess([
    "-m",
    "pixel_character_core.worker",
    "--input",
    inputPath,
    "--output",
    outputPath,
  ]);

  const result = await readJsonFile<{
    diagnosticsPath: string;
    frame: unknown;
  }>(outputPath);

  return {
    diagnosticsPath: result.diagnosticsPath,
    frame: frameSchema.parse(result.frame),
  };
};

export const splitSheetWithPython = async ({
  mode,
  run,
  sheet,
  startIndex,
}: SheetSplitRequest): Promise<string[]> => {
  const requestId = `split_sheet_${Date.now().toString(36)}`;
  const inputPath = join(run.paths.pipelineDir, `${requestId}.request.json`);
  const outputPath = join(run.paths.pipelineDir, `${requestId}.result.json`);
  await writeJsonAtomic(inputPath, {
    framesDir: run.paths.framesDir,
    mode:
      mode ??
      (sheet.frameWidth > 0 && sheet.frameHeight > 0
        ? "split-sheet"
        : "auto-slice-components"),
    outputPath,
    sheet,
    startIndex,
  });
  await runProcess([
    "-m",
    "pixel_character_core.ingest",
    "--input",
    inputPath,
    "--output",
    outputPath,
  ]);
  const result = await readJsonFile<{ frameIds: string[]; manifest?: unknown }>(outputPath);
  return result.frameIds;
};

export const materializeFrameWithPython = async (
  request: MaterializeFrameRequest,
  pipelineDir: string
): Promise<MaterializeFrameResult> => {
  const requestId = `materialize-frame-${Date.now().toString(36)}`;
  const inputPath = join(pipelineDir, `${requestId}.request.json`);
  const outputPath = join(pipelineDir, `${requestId}.result.json`);
  await writeJsonAtomic(inputPath, {
    ...request,
    mode: "materialize-frame",
  });
  await runProcess([
    "-m",
    "pixel_character_core.ingest",
    "--input",
    inputPath,
    "--output",
    outputPath,
  ]);
  return readJsonFile<MaterializeFrameResult>(outputPath);
};

export const exportAnimationWithPython = async (
  request: ExportRequest
): Promise<ExportResult> => {
  const inputPath = join(request.exportDir, "export.request.json");
  const outputPath = join(request.exportDir, "export.result.json");
  await writeJsonAtomic(inputPath, { ...request, outputPath });
  await runProcess([
    "-m",
    "pixel_character_core.exporter",
    "--input",
    inputPath,
    "--output",
    outputPath,
  ]);
  return readJsonFile<ExportResult>(outputPath);
};
