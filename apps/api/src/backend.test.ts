import { strict as assert } from "node:assert";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  animationFixPreviewResponseSchema,
  animationFixRequestSchema,
  animationFixResponseSchema,
  animationInspectionSchema,
  assetPlanSchema,
  editorDocumentSchema,
  editorOperationLogEntrySchema,
  editorOperationsRequestSchema,
  agentProjectMemorySchema,
  editorCheckpointSchema,
  editIntentPreviewSchema,
  frameSchema,
  frameVisualInspectionSchema,
  imagegenRequestArtifactSchema,
  imagegenApplyPreviewResponseSchema,
  imagegenResultArtifactSchema,
  imagegenResultInspectionSchema,
  createPartReferenceRequestSchema,
  maskIntelligenceReportSchema,
  partReferencePackageSchema,
  partRegenerationDraftSchema,
  partRegenerationRequestSchema,
  pixelGridResponseSchema,
  pixelGridWriteRequestSchema,
  runSchema,
  savedAnimationSchema,
  schemaVersion,
  visualSummarySchema,
} from "@retrodex/contracts";
import type {
  Frame,
  Run,
  SavedAnimation,
} from "@retrodex/contracts";
import Ajv2020 from "ajv/dist/2020.js";

import { JobRunner } from "./jobs.js";
import { openApiDocument } from "./openapi.js";
import {
  addFrameInputSchema,
  approveFrameInputSchema,
  createExportInputSchema,
  createRunInputSchema,
  jobSchema,
  RunRepository,
} from "./run-repository.js";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZUlEQVR4nO2XMQrAMAwDFdOHVP9/lPoTl3bq1nQIoqCDLF5yyHYgo9ENI+W8PAJJIAlcbLPrwp2f1kuHsobrXkJJ93mrLROwDOETklO1XyRQEUBaYKYigLTATEUAZkb+hjBjFzgB3VYUd7vSVBQAAAAASUVORK5CYII=";

const createRepositoryFixture = async (): Promise<{
  repository: RunRepository;
  root: string;
  sourcePath: string;
}> => {
  const root = resolve("tmp-unit", `repo-${Date.now().toString(36)}`);
  await rm(root, { force: true, recursive: true });
  await mkdir(root, { recursive: true });
  const sourcePath = join(root, "source.png");
  await writeFile(sourcePath, Buffer.from(pngBase64, "base64"));
  return {
    repository: new RunRepository(join(root, "runs")),
    root,
    sourcePath,
  };
};

const writeFixtureFrame = async (
  repository: RunRepository,
  run: Run,
  frameId = run.activeFrameIds[0] ?? "frame_01",
  index = run.activeFrameIds.indexOf(frameId)
): Promise<Frame> => {
  assert.ok(frameId);
  const frame: Frame = {
    alphaBBox: null,
    anchor: { mode: "bottom", x: run.canvas.width / 2, y: run.canvas.height },
    approved: false,
    approvedAt: null,
    canvas: run.canvas,
    id: frameId,
    index: Math.max(0, index),
    name: `Frame ${String(Math.max(0, index) + 1).padStart(2, "0")}`,
    palette: {
      colors: ["#111111"],
      lockedTo: null,
    },
    path: repository.framePngPath(run, frameId),
    qc: {
      blockingIssues: [],
      passes: true,
      retryHints: [],
      warnings: [],
    },
    schemaVersion,
    source: {
      kind: "imported",
    },
  };
  await repository.writeFrame(run, frame);
  return frame;
};

const createAnimationFixtureCells = (offset: number) =>
  Array.from({ length: 32 * 32 }, (_, index) => {
    const x = index % 32;
    const y = Math.floor(index / 32);
    if (x === 2 && y === 2) {
      return offset === 1 ? "#ffffff" : null;
    }
    return x >= 8 + offset && x < 12 + offset && y >= 8 && y < 12
      ? "#3a180f"
      : null;
  });

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const validateOpenApiSchema = (schemaName: string, value: unknown): void => {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${schemaName}`,
    components: openApiDocument.components,
  });
  assert.equal(
    validate(value),
    true,
    `${schemaName} OpenAPI validation failed: ${ajv.errorsText(validate.errors)}`
  );
};

const makeSavedAnimationFixture = (
  repository: RunRepository,
  run: Run,
  exportId: string,
  exportDir: string
): SavedAnimation => ({
  approval: { approvedFrames: [] },
  canvas: run.canvas,
  createdAt: new Date().toISOString(),
  exports: [{ path: join(exportDir, "preview.png"), target: "game-strip" }],
  files: {
    contactSheet: join(exportDir, "preview.png"),
    css: join(exportDir, "pixel-animation.css"),
    draft: repository.draftPath(run),
    editorDiff: join(exportDir, "editor-diff.json"),
    gif: join(exportDir, "preview.gif"),
    lottie: join(exportDir, "lottie.json"),
    manifest: join(exportDir, "manifest.json"),
    preview: join(exportDir, "preview.png"),
    react: join(exportDir, "PixelAnimation.tsx"),
    shareBundle: join(exportDir, "share-bundle.zip"),
    stripTransparent: join(exportDir, "strip-transparent.png"),
    svg: join(exportDir, "animation.svg"),
    tgs: join(exportDir, "animation.tgs"),
    tgsMetadata: join(exportDir, "tgs-metadata.json"),
    validation: join(exportDir, "validation.json"),
    webp: join(exportDir, "preview.webp"),
  },
  fps: 8,
  frames: [],
  id: exportId,
  name: "Unit Export",
  runId: run.id,
  schemaVersion,
  slug: "unit-export",
});

test("RunRepository writes runs under explicit root and validates PNG inputs", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Unit Run",
      sourceFrames: [{ path: sourcePath }],
    });

    assert.equal(run.status, "raw-ready");
    assert.equal(run.activeFrameIds.length, 1);
    assert.ok(run.paths.root.startsWith(join(root, "runs")));
    const runs = await repository.listRuns();
    assert.deepEqual(
      runs.map((item) => item.id),
      [run.id]
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository recovery marks running jobs failed and keeps queued jobs", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Job Recovery",
      sourceFrames: [{ path: sourcePath }],
    });
    const queued = await repository.createJob(run.id, "cleanup");
    const running = await repository.writeJob({
      ...(await repository.createJob(run.id, "cleanup")),
      startedAt: new Date().toISOString(),
      status: "running",
    });
    const recovered = await repository.recoverJobs();

    assert.ok(
      recovered.some((job) => job.id === queued.id && job.status === "queued")
    );
    assert.ok(
      recovered.some(
        (job) =>
          job.id === running.id &&
          job.status === "failed" &&
          job.error?.code === "api-restart"
      )
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository stores approval metadata on the run contract", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Approval Model",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);

    const approved = await repository.setFrameApproval(
      run.id,
      run.activeFrameIds[0] ?? "",
      { approved: true, approvedBy: "agent", note: "Key pose checked." }
    );

    assert.equal(approved.frame.approved, true);
    assert.equal(approved.run.status, "approved");
    assert.deepEqual(approved.run.approval.approvedFrames, [
      {
        approvedAt: approved.run.approval.approvedFrames[0]?.approvedAt,
        approvedBy: "agent",
        frameId: "frame_01",
        note: "Key pose checked.",
      },
    ]);

    const removed = await repository.setFrameApproval(
      run.id,
      run.activeFrameIds[0] ?? "",
      { approved: false }
    );
    assert.equal(removed.frame.approved, false);
    assert.equal(removed.frame.approvedAt, null);
    assert.deepEqual(removed.run.approval.approvedFrames, []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Export jobs require run approval metadata, not frame-local flags", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Export Approval Guard",
      sourceFrames: [{ path: sourcePath }],
    });
    await repository.writeFrame(run, {
      ...(await writeFixtureFrame(repository, run)),
      approved: true,
      approvedAt: new Date().toISOString(),
    });

    const runner = new JobRunner(repository);
    const job = await runner.createExportJob(run.id, {
      name: "Should Fail Without Run Approval",
    });

    let finished = await runner.getJob(job.id);
    for (
      let attempt = 0;
      attempt < 20 &&
      (finished?.status === "queued" || finished?.status === "running");
      attempt += 1
    ) {
      await delay(50);
      finished = await runner.getJob(job.id);
    }

    assert.equal(finished?.status, "failed");
    assert.match(finished?.error?.message ?? "", /approved frame/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository resolves export artifact paths inside export snapshots only", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Artifact Safety",
      sourceFrames: [{ path: sourcePath }],
    });

    assert.equal(
      repository.exportArtifactPath(run, "export_test", "preview.webp"),
      join(run.paths.root, "saved-animations", "export_test", "preview.webp")
    );
    assert.throws(
      () => repository.exportArtifactPath(run, "export_test", "../run.json"),
      /Path escapes run root/u
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Export jobs write hardened manifest, validation, diff, and share bundle", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Export Hardening",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });

    const runner = new JobRunner(repository);
    const job = await runner.createExportJob(run.id, {
      name: "Hardened Export",
      targets: ["raw-frames", "game-strip", "webp"],
    });

    let finished = await runner.getJob(job.id);
    for (
      let attempt = 0;
      attempt < 20 &&
      (finished?.status === "queued" || finished?.status === "running");
      attempt += 1
    ) {
      await delay(50);
      finished = await runner.getJob(job.id);
    }

    assert.equal(finished?.status, "succeeded");
    const [savedExport] = await repository.listExports(
      await repository.readRun(run.id)
    );
    assert.ok(savedExport);
    for (const path of [
      savedExport.files.manifest,
      savedExport.files.validation,
      savedExport.files.editorDiff,
      savedExport.files.shareBundle,
    ]) {
      const fileStat = await stat(path);
      assert.ok(fileStat.isFile());
    }
    const manifest = JSON.parse(
      await readFile(savedExport.files.manifest, "utf-8")
    ) as { artifactMap: Record<string, string>; engineHints: { fps: number } };
    assert.equal(manifest.engineHints.fps, 8);
    assert.equal(manifest.artifactMap.shareBundle, "share-bundle.zip");
    const validation = JSON.parse(
      await readFile(savedExport.files.validation, "utf-8")
    ) as { passes: boolean };
    assert.equal(validation.passes, true);
    const shareBundle = await readFile(savedExport.files.shareBundle);
    assert.equal(shareBundle.readUInt32LE(0), 0x04_03_4b_50);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository lists saved animation export snapshots", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Export Listing",
      sourceFrames: [{ path: sourcePath }],
    });
    const exportId = "export_unit";
    const exportDir = repository.exportDir(run, exportId);
    await mkdir(exportDir, { recursive: true });
    await copyFile(sourcePath, join(exportDir, "preview.png"));
    const savedAnimation = makeSavedAnimationFixture(
      repository,
      run,
      exportId,
      exportDir
    );
    await repository.writeExport(run, savedAnimation);

    const exports = await repository.listExports(run);
    assert.deepEqual(
      exports.map((item) => item.id),
      [exportId]
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("OpenAPI exposes reusable request and response body schemas", () => {
  assert.ok(openApiDocument.components.schemas.Run);
  assert.ok(openApiDocument.components.schemas.Frame);
  assert.ok(openApiDocument.components.schemas.Job);
  assert.ok(openApiDocument.components.schemas.CreateRunRequest);
  assert.ok(openApiDocument.components.schemas.CreateExportRequest);
  assert.ok(openApiDocument.components.schemas.ApproveFrameRequest);
  assert.ok(openApiDocument.components.schemas.SavedAnimationResponse);
  assert.ok(openApiDocument.components.schemas.SavedAnimationsResponse);
  assert.ok(openApiDocument.components.schemas.EditorDocument);
  assert.ok(openApiDocument.components.schemas.EditorCheckpoint);
  assert.ok(openApiDocument.components.schemas.EditorOperationLogEntry);
  assert.ok(openApiDocument.components.schemas.EditIntentPreview);
  assert.ok(openApiDocument.components.schemas.CheckpointComparison);
  assert.ok(openApiDocument.components.schemas.EditorOperationsRequest);
  assert.ok(openApiDocument.components.schemas.EditorBucketFillOperation);
  assert.ok(openApiDocument.components.schemas.EditorGradientFillOperation);
  assert.ok(openApiDocument.components.schemas.EditorMaskShapeOperation);
  assert.ok(openApiDocument.components.schemas.EditorShapePixelsOperation);
  assert.ok(openApiDocument.components.schemas.EditorTransformPixelsOperation);
  assert.ok(openApiDocument.components.schemas.AgentProjectMemory);
  assert.ok(openApiDocument.components.schemas.AnimationInspection);
  assert.ok(openApiDocument.components.schemas.FrameVisualInspection);
  assert.ok(openApiDocument.components.schemas.ImagegenRequestArtifact);
  assert.ok(openApiDocument.components.schemas.ImagegenResultArtifact);
  assert.ok(openApiDocument.components.schemas.MaskIntelligenceReport);
  assert.ok(openApiDocument.components.schemas.PartReferencePackage);
  assert.ok(openApiDocument.components.schemas.PartRegenerationDraft);
  assert.ok(openApiDocument.components.schemas.PixelGridResponse);
  assert.ok(openApiDocument.components.schemas.VisualSummary);

  const assetTypeEnum = (
    openApiDocument.components.schemas.AssetPlan as {
      properties: { type: { enum: string[] } };
    }
  ).properties.type.enum;
  assert.deepEqual(assetTypeEnum, [
    "background",
    "character",
    "fx",
    "icon",
    "projectile",
    "prop",
    "tile",
  ]);
  for (const type of assetTypeEnum) {
    assetPlanSchema.parse({
      action: "idle",
      frames: 1,
      sheet: "single",
      style: "pixel-art",
      type,
      view: "front",
    });
  }
  const sourceFrameGridStrategy = (
    openApiDocument.components.schemas.SourceFrame as {
      properties: { gridStrategy: { default: string; enum: string[] } };
    }
  ).properties.gridStrategy;
  assert.equal(sourceFrameGridStrategy.default, "infer-hidden-grid");
  assert.deepEqual(sourceFrameGridStrategy.enum, [
    "infer-hidden-grid",
    "preserve-source",
    "resize-to-run-canvas",
  ]);

  assert.deepEqual(
    openApiDocument.paths["/runs"].post.requestBody.content["application/json"]
      .schema,
    { $ref: "#/components/schemas/CreateRunRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/exports"].post.requestBody.content[
      "application/json"
    ].schema,
    { $ref: "#/components/schemas/CreateExportRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/frames/{frameId}/approve"].post
      .requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/ApproveFrameRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}"].get.responses["200"].content[
      "application/json"
    ].schema,
    { $ref: "#/components/schemas/RunResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/exports"].get.responses["200"].content[
      "application/json"
    ].schema,
    { $ref: "#/components/schemas/SavedAnimationsResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/exports/{exportId}"].get.responses[
      "200"
    ].content["application/json"].schema,
    { $ref: "#/components/schemas/SavedAnimationResponse" }
  );
  assert.ok(
    openApiDocument.paths["/runs/{runId}/exports/{exportId}/files/{filePath}"]
      .get.responses["200"].content["image/png"]
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor"].put.requestBody.content[
      "application/json"
    ].schema,
    {
      oneOf: [
        { $ref: "#/components/schemas/EditorDocument" },
        { $ref: "#/components/schemas/EditorDocumentSaveRequest" },
      ],
    }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/status"].get.responses["200"]
      .content["application/json"].schema,
    { $ref: "#/components/schemas/EditorStatusResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/selection"].put.requestBody
      .content["application/json"].schema,
    { $ref: "#/components/schemas/EditorSelectionWriteRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/export-preview"].post
      .requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/EditorExportPreviewRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/operations"].patch.requestBody
      .content["application/json"].schema,
    { $ref: "#/components/schemas/EditorOperationsRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/intents/preview"].post
      .requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/EditIntentRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/intents/apply"].post.requestBody
      .content["application/json"].schema,
    { $ref: "#/components/schemas/EditIntentRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/visual-summary"].get.responses[
      "200"
    ].content["application/json"].schema,
    { $ref: "#/components/schemas/VisualSummaryResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/animation-inspection"].get
      .responses["200"].content["application/json"].schema,
    { $ref: "#/components/schemas/AnimationInspectionResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/animation-fixes/apply"].post
      .requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/AnimationFixRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/animation-fixes/preview"].post
      .requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/AnimationFixRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/animation-fixes/preview"].post
      .responses["200"].content["application/json"].schema,
    { $ref: "#/components/schemas/AnimationFixPreviewResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/animation-fixes/apply"].post
      .responses["200"].content["application/json"].schema,
    { $ref: "#/components/schemas/AnimationFixResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/memory"].put.requestBody
      .content["application/json"].schema,
    { $ref: "#/components/schemas/AgentProjectMemory" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/mask-intelligence"].get
      .responses["200"].content["application/json"].schema,
    { $ref: "#/components/schemas/MaskIntelligenceResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/checkpoints"].post.requestBody
      .content["application/json"].schema,
    { $ref: "#/components/schemas/CreateEditorCheckpointRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths[
      "/runs/{runId}/editor/checkpoints/{checkpointId}/revert"
    ].post.requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/RevertEditorCheckpointRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths[
      "/runs/{runId}/editor/checkpoints/{checkpointId}/compare/{otherCheckpointId}"
    ].get.responses["200"].content["application/json"].schema,
    { $ref: "#/components/schemas/CheckpointComparisonResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/operations-log"].get.responses[
      "200"
    ].content["application/json"].schema,
    { $ref: "#/components/schemas/EditorOperationLogResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths[
      "/runs/{runId}/editor/operations-log/{operationId}/revert"
    ].post.requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/RevertEditorOperationRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/references"].post.requestBody
      .content["application/json"].schema,
    { $ref: "#/components/schemas/CreatePartReferenceRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/regenerate"].post.requestBody
      .content["application/json"].schema,
    { $ref: "#/components/schemas/PartRegenerationRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/imagegen-requests"].post
      .requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/CreateImagegenRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths["/runs/{runId}/editor/imagegen-results"].post
      .requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/RecordImagegenResultRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths[
      "/runs/{runId}/editor/imagegen-results/{resultId}/apply"
    ].post.requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/ApplyImagegenResultRequest" }
  );
  assert.deepEqual(
    openApiDocument.paths[
      "/runs/{runId}/editor/imagegen-results/{resultId}/apply-preview"
    ].post.responses["200"].content["application/json"].schema,
    { $ref: "#/components/schemas/ImagegenApplyPreviewResponse" }
  );
  assert.deepEqual(
    openApiDocument.paths[
      "/runs/{runId}/editor/imagegen-results/{resultId}/inspect"
    ].get.responses["200"].content["application/json"].schema,
    { $ref: "#/components/schemas/ImagegenResultInspectionResponse" }
  );
  assert.ok(
    openApiDocument.paths[
      "/runs/{runId}/editor/imagegen-results/{resultId}/compare/{candidateId}/image"
    ].get.responses["200"].content["image/png"]
  );
});

test("RunRepository imports approved frames into editor and reads/writes pixels", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Editor Import",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });

    const document = await repository.importApprovedFramesToEditor(run.id);
    editorDocumentSchema.parse(document);
    assert.equal(document.frames.length, 1);
    assert.equal(document.selectedFrameId, "frame_01");
    assert.equal(document.frames[0]?.grid.cells.length, 32 * 32);

    const pixels = await repository.readPixelGrid(run.id, "frame_01");
    pixelGridResponseSchema.parse(pixels);
    pixels.grid.cells[0] = "#ff0000";
    const written = await repository.writePixelGrid(run.id, "frame_01", {
      grid: pixels.grid,
    });
    assert.equal(written.grid.cells[0], "#ff0000");

    const patched = await repository.applyEditorOperations(run.id, {
      operations: [
        {
          color: "#00ff00",
          frameId: "frame_01",
          type: "set-pixel",
          x: 1,
          y: 0,
        },
      ],
    });
    assert.equal(patched.frames[0]?.grid.cells[1], "#00ff00");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository exposes agent selection state and revision conflicts", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Editor Selection",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    const saved = await repository.writeEditorSelection(run.id, {
      expectedRevision: document.saveState.revision,
      selection: {
        activeMaskLayerId: null,
        selectedBounds: { height: 2, width: 2, x: 1, y: 1 },
        selectedFrameId: "frame_01",
        selectedMaskLayerIds: [],
        selectedPixelsMask: null,
        transformTarget: "pixels",
      },
    });

    assert.equal(saved.selection.transformTarget, "pixels");
    assert.equal(saved.document.selectedFrameId, "frame_01");
    const status = await repository.readEditorStatus(run.id);
    assert.equal(status.frameCount, 1);
    await assert.rejects(
      () =>
        repository.applyEditorOperations(run.id, {
          expectedRevision: document.saveState.revision,
          operations: [
            {
              color: "#00ff00",
              frameId: "frame_01",
              type: "set-pixel",
              x: 0,
              y: 0,
            },
          ],
        }),
      /Editor document changed/u
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository previews editor export payload without writing snapshot", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Editor Export Preview",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    const preview = await repository.previewEditorExport(run.id, {
      expectedRevision: document.saveState.revision,
      formats: ["json", "svg", "lottie"],
      scale: 2,
      scope: "frame",
    });

    assert.equal(preview.revision, document.saveState.revision);
    assert.deepEqual(preview.frameIds, ["frame_01"]);
    assert.equal(preview.files.length, 3);
    assert.ok(
      Buffer.from(preview.files[1]?.contentBase64 ?? "", "base64")
        .toString("utf-8")
        .includes("<svg")
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository creates and reverts editor checkpoints", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Editor Checkpoints",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    document.frames[0] = {
      ...document.frames[0],
      grid: {
        cells: Array.from({ length: 32 * 32 }, () => null),
        palette: [],
        size: { height: 32, width: 32 },
      },
    };
    await repository.writeEditorDocument(document);
    const checkpoint = await repository.createEditorCheckpoint(run.id, {
      label: "Before recolor",
      reason: "Test rollback.",
      source: "agent",
    });
    editorCheckpointSchema.parse(checkpoint);
    const changed = await repository.readEditorDocument(run.id);
    const [changedFrame] = changed.frames;
    assert.ok(changedFrame);
    changed.frames[0] = {
      ...changedFrame,
      grid: {
        ...changedFrame.grid,
        cells: changedFrame.grid.cells.map((cell, index) =>
          index === 0 ? "#ff0000" : cell
        ),
      },
    };
    await repository.writeEditorDocument(changed);
    const checkpoints = await repository.listEditorCheckpoints(run.id);
    assert.equal(checkpoints.length, 1);
    const reverted = await repository.revertEditorCheckpoint(run.id, {
      checkpointId: checkpoint.id,
    });
    assert.equal(reverted.document.frames[0]?.grid.cells[0], null);
    assert.ok(reverted.rollbackCheckpoint);
    const checkpointsAfterRevert = await repository.listEditorCheckpoints(
      run.id
    );
    assert.equal(checkpointsAfterRevert.length, 2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository logs exact editor operations and reverts one operation", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Editor Operation Log",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    const [frame] = document.frames;
    assert.ok(frame);
    document.frames[0] = {
      ...frame,
      grid: {
        cells: Array.from({ length: 32 * 32 }, () => null),
        palette: [],
        size: { height: 32, width: 32 },
      },
    };
    await repository.writeEditorDocument(document);
    await repository.applyEditorOperations(run.id, {
      operations: [
        {
          color: "#00ff00",
          frameId: "frame_01",
          type: "set-pixel",
          x: 1,
          y: 0,
        },
      ],
    });
    const operations = await repository.listEditorOperations(run.id);
    assert.equal(operations.length, 1);
    const [operation] = operations;
    assert.ok(operation);
    editorOperationLogEntrySchema.parse(operation);
    assert.equal(operation.operationType, "editor-operations");
    assert.deepEqual(operation.patches, [
      {
        after: "#00ff00",
        before: null,
        frameId: "frame_01",
        x: 1,
        y: 0,
      },
    ]);
    const reverted = await repository.revertEditorOperation(run.id, {
      operationId: operation.id,
    });
    assert.equal(reverted.document.frames[0]?.grid.cells[1], null);
    assert.ok(reverted.rollbackCheckpoint);
    assert.equal(
      reverted.operation.revertedByOperationId,
      reverted.revertOperation.id
    );
    assert.equal(reverted.revertOperation.operationType, "operation-revert");
    assert.deepEqual(reverted.revertOperation.patches, [
      {
        after: null,
        before: "#00ff00",
        frameId: "frame_01",
        x: 1,
        y: 0,
      },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository applies agent-level canvas and mask tool operations", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Agent Tool Surface",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    const [frame] = document.frames;
    assert.ok(frame);
    document.frames[0] = {
      ...frame,
      grid: {
        cells: Array.from({ length: 32 * 32 }, () => null),
        palette: [],
        size: { height: 32, width: 32 },
      },
    };
    document.masks = [
      {
        anchor: { x: 16, y: 16 },
        color: "#4aa3ff",
        id: "mask_tool",
        mask: Array.from({ length: 32 * 32 }, () => false),
        name: "Mask 1",
        parentId: null,
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
    document.activeMaskLayerId = "mask_tool";
    await repository.writeEditorDocument(document);
    const operationsRequest = {
      operations: [
        {
          color: "#ff0000",
          endCell: { x: 3, y: 3 },
          frameId: "frame_01",
          mode: "fill",
          radius: 0,
          shape: "rectangle",
          startCell: { x: 1, y: 1 },
          type: "shape-pixels",
        },
        {
          endCell: { x: 2, y: 2 },
          layerId: "mask_tool",
          mode: "fill",
          radius: 0,
          respectAlpha: false,
          shape: "rectangle",
          startCell: { x: 1, y: 1 },
          type: "mask-shape",
          value: true,
        },
        {
          endCell: { x: 2, y: 1 },
          endColor: "#ffffff",
          frameId: "frame_01",
          kind: "linear",
          pattern: "hard",
          startCell: { x: 1, y: 1 },
          startColor: "#000000",
          target: "mask",
          targetMaskLayerIds: ["mask_tool"],
          type: "gradient-fill",
        },
        {
          color: "#00ff00",
          frameId: "frame_01",
          respectMaskLayerIds: [],
          type: "bucket-fill",
          x: 0,
          y: 0,
        },
        {
          bounds: { height: 1, width: 1, x: 0, y: 0 },
          frameId: "frame_01",
          type: "delete-target",
        },
        {
          clearMaskLayerIds: ["mask_tool"],
          frameId: "frame_01",
          maskLayerIds: ["mask_tool"],
          type: "delete-selected-pixels",
        },
        {
          endCell: { x: 4, y: 4 },
          layerId: "mask_tool",
          mode: "fill",
          radius: 0,
          respectAlpha: false,
          shape: "rectangle",
          startCell: { x: 4, y: 4 },
          type: "mask-shape",
          value: true,
        },
      ],
    };
    editorOperationsRequestSchema.parse(operationsRequest);
    const updated = await repository.applyEditorOperations(
      run.id,
      operationsRequest
    );
    assert.equal(updated.frames[0]?.grid.cells[0], null);
    assert.equal(updated.frames[0]?.grid.cells[33], null);
    assert.equal(updated.masks[0]?.mask[33], false);
    assert.equal(updated.masks[0]?.mask[132], true);
    const [operation] = await repository.listEditorOperations(run.id);
    assert.ok(operation);
    assert.ok(operation.patches.length > 0);
    assert.ok(operation.maskPatches.length > 0);
    const reverted = await repository.revertEditorOperation(run.id, {
      operationId: operation.id,
    });
    assert.equal(reverted.document.frames[0]?.grid.cells[0], null);
    assert.equal(reverted.document.frames[0]?.grid.cells[33], null);
    assert.equal(reverted.document.masks[0]?.mask[33], false);
    assert.equal(reverted.document.masks[0]?.mask[132], false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository compares editor checkpoints", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Checkpoint Compare",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    const [frame] = document.frames;
    assert.ok(frame);
    document.frames[0] = {
      ...frame,
      grid: {
        cells: Array.from({ length: 32 * 32 }, () => null),
        palette: [],
        size: { height: 32, width: 32 },
      },
    };
    await repository.writeEditorDocument(document);
    const before = await repository.createEditorCheckpoint(run.id, {
      label: "Before",
      source: "agent",
    });
    await repository.applyEditorOperations(run.id, {
      operations: [
        {
          color: "#ff0000",
          frameId: "frame_01",
          type: "set-pixel",
          x: 2,
          y: 0,
        },
      ],
    });
    const after = await repository.createEditorCheckpoint(run.id, {
      label: "After",
      source: "agent",
    });
    const comparison = await repository.compareEditorCheckpoints(
      run.id,
      before.id,
      after.id
    );
    assert.equal(comparison.summary.changedFrames, 1);
    assert.equal(comparison.summary.changedPixels, 1);
    assert.deepEqual(comparison.frameDiffs[0]?.bbox, {
      height: 1,
      width: 1,
      x: 2,
      y: 0,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository previews and applies semantic edit intents", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Edit Intent",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    document.frames[0] = {
      ...document.frames[0],
      grid: {
        cells: Array.from({ length: 32 * 32 }, (_, index) => {
          const x = index % 32;
          const y = Math.floor(index / 32);
          return x >= 8 && x < 12 && y >= 8 && y < 12 ? "#3a180f" : null;
        }),
        palette: ["#3a180f"],
        size: { height: 32, width: 32 },
      },
    };
    document.masks[0] = {
      ...document.masks[0],
      mask: Array.from({ length: 32 * 32 }, (_, index) => {
        const x = index % 32;
        const y = Math.floor(index / 32);
        return x >= 8 && x < 12 && y >= 8 && y < 12;
      }),
      semanticRole: "hair",
    };
    await repository.writeEditorDocument(document);

    const preview = await repository.previewEditIntent(run.id, {
      intent: {
        color: "#552211",
        intent: "recolor-target",
        preserveOutline: false,
        target: { kind: "semantic-role", role: "hair" },
      },
    });
    editIntentPreviewSchema.parse(preview);
    assert.equal(preview.changedPixels, 16);

    const applied = await repository.applyEditIntent(run.id, {
      intent: {
        color: "#552211",
        intent: "recolor-target",
        preserveOutline: false,
        target: { kind: "semantic-role", role: "hair" },
      },
    });
    assert.equal(applied.document.frames[0]?.grid.cells[8 * 32 + 8], "#552211");
    const checkpoints = await repository.listEditorCheckpoints(run.id);
    assert.equal(checkpoints.length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository builds visual inspections for agent image understanding", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Visual Inspect",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    document.frames[0] = {
      ...document.frames[0],
      alphaBBox: { height: 6, width: 6, x: 8, y: 8 },
      grid: {
        cells: Array.from({ length: 32 * 32 }, (_, index) => {
          const x = index % 32;
          const y = Math.floor(index / 32);
          if (x === 10 && y === 9) {
            return "#101010";
          }
          return x >= 8 && x < 14 && y >= 8 && y < 14 ? "#f0c070" : null;
        }),
        palette: ["#f0c070", "#101010"],
        size: { height: 32, width: 32 },
      },
    };
    await repository.writeEditorDocument(document);

    const inspection = await repository.inspectEditorFrame(run.id, "frame_01");
    frameVisualInspectionSchema.parse(inspection);
    assert.ok(
      inspection.features.some((feature) => feature.kind === "eye-candidate")
    );
    assert.ok(inspection.fullPreviewUrl.includes("/frame_01/image"));

    const visualSummary = await repository.readVisualSummary(run.id);
    visualSummarySchema.parse(visualSummary);
    assert.equal(visualSummary.animation.frameCount, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository inspects animation motion, masks, flicker, and loop quality", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 3,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Animation Inspect",
      sourceFrames: [
        { path: sourcePath },
        { path: sourcePath },
        { path: sourcePath },
      ],
    });
    for (const [index, frameId] of run.activeFrameIds.entries()) {
      await writeFixtureFrame(repository, run, frameId, index);
      await repository.setFrameApproval(run.id, frameId, {
        approved: true,
        approvedBy: "agent",
      });
    }
    const document = await repository.importApprovedFramesToEditor(run.id);
    document.frames = document.frames.map((frame, index) => ({
      ...frame,
      grid: {
        cells: createAnimationFixtureCells(index === 1 ? 1 : 0),
        palette: ["#3a180f", "#ffffff"],
        size: { height: 32, width: 32 },
      },
    }));
    document.masks[0] = {
      ...document.masks[0],
      mask: Array.from({ length: 32 * 32 }, (_, index) => {
        const x = index % 32;
        const y = Math.floor(index / 32);
        return x >= 8 && x < 13 && y >= 8 && y < 12;
      }),
      semanticLabel: "Hair",
      semanticRole: "hair",
    };
    await repository.writeEditorDocument(document);

    const inspection = await repository.inspectAnimation(run.id);
    animationInspectionSchema.parse(inspection);
    assert.equal(inspection.frameDiffs.length, 2);
    assert.ok(inspection.flickerRegions.length > 0);
    assert.ok(
      inspection.maskMotionTracks.some(
        (track) =>
          track.maskLayerId === "mask_1" && track.averageChangedPixels > 0
      )
    );
    assert.ok(inspection.loopQualityScore > 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository applies animation fixes with checkpointed pixel patches", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 3,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Animation Fix",
      sourceFrames: [
        { path: sourcePath },
        { path: sourcePath },
        { path: sourcePath },
      ],
    });
    for (const [index, frameId] of run.activeFrameIds.entries()) {
      await writeFixtureFrame(repository, run, frameId, index);
      await repository.setFrameApproval(run.id, frameId, {
        approved: true,
        approvedBy: "agent",
      });
    }
    const document = await repository.importApprovedFramesToEditor(run.id);
    document.frames = document.frames.map((frame, index) => ({
      ...frame,
      grid: {
        cells: createAnimationFixtureCells(index === 1 ? 1 : 0),
        palette: ["#3a180f", "#ffffff"],
        size: { height: 32, width: 32 },
      },
    }));
    await repository.writeEditorDocument(document);

    const preview = await repository.previewAnimationFix(run.id, {
      mode: "fix-flicker",
    });
    animationFixPreviewResponseSchema.parse({ preview });
    assert.ok(preview.patches.length > 0);
    assert.equal(preview.requiresCheckpoint, true);
    assert.ok(
      preview.estimatedAfterInspection.flickerRegions.length <=
        preview.beforeInspection.flickerRegions.length
    );
    const previewDocument = await repository.readEditorDocument(run.id);
    assert.equal(previewDocument.frames[1]?.grid.cells[2 + 2 * 32], "#ffffff");
    const checkpointsBeforeApply = await repository.listEditorCheckpoints(
      run.id
    );
    assert.equal(checkpointsBeforeApply.length, 0);

    const result = await repository.applyAnimationFix(run.id, {
      mode: "fix-flicker",
    });

    animationFixResponseSchema.parse({ animationFix: result });
    assert.equal(result.mode, "fix-flicker");
    assert.ok(result.appliedPatches.length > 0);
    assert.equal(
      result.appliedPatches[0]?.frameId,
      document.frames[1]?.frameId
    );
    assert.equal(result.appliedPatches[0]?.x, 2);
    assert.equal(result.appliedPatches[0]?.y, 2);
    assert.equal(result.appliedPatches[0]?.after, null);
    const updated = await repository.readEditorDocument(run.id);
    const middleFrame = updated.frames.find(
      (frame) => frame.frameId === document.frames[1]?.frameId
    );
    assert.equal(middleFrame?.grid.cells[2 + 2 * 32], null);
    const checkpoints = await repository.listEditorCheckpoints(run.id);
    assert.equal(checkpoints.length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository stores agent memory and reports mask intelligence", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Agent Memory",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    document.frames[0] = {
      ...document.frames[0],
      grid: {
        cells: Array.from({ length: 32 * 32 }, (_, index) => {
          const x = index % 32;
          const y = Math.floor(index / 32);
          return x >= 4 && x < 10 && y >= 4 && y < 10 ? "#222222" : null;
        }),
        palette: ["#222222"],
        size: { height: 32, width: 32 },
      },
    };
    document.masks = [
      {
        ...document.masks[0],
        id: "mask_1",
        mask: Array.from({ length: 32 * 32 }, (_, index) => {
          const x = index % 32;
          const y = Math.floor(index / 32);
          return x >= 4 && x < 7 && y >= 4 && y < 7;
        }),
        semanticRole: "unknown",
      },
      {
        ...document.masks[0],
        id: "mask_2",
        mask: Array.from({ length: 32 * 32 }, (_, index) => {
          const x = index % 32;
          const y = Math.floor(index / 32);
          return (x >= 6 && x < 9 && y >= 6 && y < 9) || (x === 20 && y === 20);
        }),
        name: "Mask 2",
        parentId: "missing_parent",
      },
    ];
    await repository.writeEditorDocument(document);

    const defaultMemory = await repository.readAgentProjectMemory(run.id);
    agentProjectMemorySchema.parse(defaultMemory);
    assert.match(defaultMemory.projectBrief, /Agent Memory/u);

    const memory = await repository.writeAgentProjectMemory(run.id, {
      memory: {
        ...defaultMemory,
        projectBrief: "Tiny side-view hero sprite.",
        protectedDetails: ["eyes"],
      },
    });
    assert.equal(memory.projectBrief, "Tiny side-view hero sprite.");
    assert.deepEqual(memory.protectedDetails, ["eyes"]);

    const maskIntelligence = await repository.readMaskIntelligence(run.id);
    maskIntelligenceReportSchema.parse(maskIntelligence);
    assert.ok(maskIntelligence.suggestions.length > 0);
    assert.ok(
      maskIntelligence.diagnostics.some(
        (diagnostic) => diagnostic.code === "missing-semantic-role"
      )
    );
    assert.ok(
      maskIntelligence.diagnostics.some(
        (diagnostic) => diagnostic.code === "intersects-other-mask"
      )
    );
    assert.ok(
      maskIntelligence.diagnostics.some(
        (diagnostic) => diagnostic.code === "outside-visible-alpha"
      )
    );
    assert.ok(
      maskIntelligence.diagnostics.some(
        (diagnostic) => diagnostic.code === "parent-not-found"
      )
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository creates masked references and regeneration drafts", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Targeted Regeneration",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    const mask = Array.from({ length: 32 * 32 }, (_, index) => {
      const x = index % 32;
      const y = Math.floor(index / 32);
      return x >= 8 && x < 12 && y >= 8 && y < 12;
    });
    document.masks[0] = {
      ...document.masks[0],
      mask,
      promptHint: "Preserve the crisp hair silhouette.",
      semanticLabel: "Hair",
      semanticRole: "hair",
    };
    document.frames[0] = {
      ...document.frames[0],
      grid: {
        cells: Array.from({ length: 32 * 32 }, (_, index) => {
          const x = index % 32;
          const y = Math.floor(index / 32);
          return x >= 8 && x < 12 && y >= 8 && y < 12 ? "#3a180f" : null;
        }),
        palette: ["#3a180f"],
        size: { height: 32, width: 32 },
      },
    };
    await repository.writeEditorDocument(document);

    const reference = await repository.createPartReferencePackage(run.id, {
      frameId: "frame_01",
      maskLayerId: "mask_1",
    });
    partReferencePackageSchema.parse(reference);
    assert.equal(reference.semanticRole, "hair");
    assert.equal(reference.bbox.width, 4);
    assert.equal(reference.exactMaskPixels.length, 16);
    assert.ok(reference.referenceImageUrl.includes(reference.id));

    const regeneration = await repository.createPartRegenerationDraft(run.id, {
      frameIds: ["frame_01"],
      maskLayerId: "mask_1",
      mode: "animation",
      prompt: "Animate only the hair pixels.",
      referenceId: reference.id,
    });
    partRegenerationDraftSchema.parse(regeneration);
    assert.equal(regeneration.status, "ready-for-imagegen");
    assert.equal(regeneration.reference.id, reference.id);
    assert.ok(
      regeneration.instructions.some((instruction) =>
        instruction.includes("Preserve all pixels outside")
      )
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("RunRepository records and applies imagegen handoff results inside masks", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const run = await repository.createRun({
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Imagegen Handoff",
      sourceFrames: [{ path: sourcePath }],
    });
    await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, "frame_01", {
      approved: true,
      approvedBy: "agent",
    });
    const document = await repository.importApprovedFramesToEditor(run.id);
    document.masks[0] = {
      ...document.masks[0],
      mask: Array.from({ length: 32 * 32 }, (_, index) => {
        const x = index % 32;
        const y = Math.floor(index / 32);
        return x >= 8 && x < 12 && y >= 8 && y < 12;
      }),
      promptHint: "Hair tuft.",
      semanticLabel: "Hair",
      semanticRole: "hair",
    };
    document.frames[0] = {
      ...document.frames[0],
      grid: {
        cells: Array.from({ length: 32 * 32 }, (_, index) => {
          const x = index % 32;
          const y = Math.floor(index / 32);
          return x >= 8 && x < 12 && y >= 8 && y < 12 ? "#3a180f" : null;
        }),
        palette: ["#3a180f"],
        size: { height: 32, width: 32 },
      },
    };
    await repository.writeEditorDocument(document);
    const reference = await repository.createPartReferencePackage(run.id, {
      frameId: "frame_01",
      maskLayerId: "mask_1",
    });
    const regeneration = await repository.createPartRegenerationDraft(run.id, {
      frameIds: ["frame_01"],
      maskLayerId: "mask_1",
      prompt: "Regenerate only hair.",
      referenceId: reference.id,
    });
    const imagegenRequest = await repository.createImagegenRequest(run.id, {
      candidateCount: 1,
      regenerationId: regeneration.id,
    });
    imagegenRequestArtifactSchema.parse(imagegenRequest);
    const candidateGrid = {
      cells: Array.from({ length: 32 * 32 }, (_, index) => {
        const x = index % 32;
        const y = Math.floor(index / 32);
        if (x >= 8 && x < 12 && y >= 8 && y < 12) {
          return "#552211";
        }
        return x === 0 && y === 0 ? "#ff00ff" : null;
      }),
      palette: ["#552211", "#ff00ff"],
      size: { height: 32, width: 32 },
    };
    const imagegenResult = await repository.recordImagegenResult(run.id, {
      candidates: [
        {
          frameId: "frame_01",
          grid: candidateGrid,
          id: "candidate_1",
          notes: "Local fixture candidate.",
          score: 0.8,
        },
      ],
      requestId: imagegenRequest.id,
      selectedCandidateId: "candidate_1",
    });
    imagegenResultArtifactSchema.parse(imagegenResult);
    assert.equal(imagegenResult.diffSummary.changedInsideMask, 16);
    assert.equal(imagegenResult.diffSummary.outsideMaskChangesIgnored, 1);

    const inspection = await repository.inspectImagegenResult(
      run.id,
      imagegenResult.id
    );
    imagegenResultInspectionSchema.parse(inspection);
    assert.equal(inspection.candidates.length, 1);
    assert.equal(inspection.recommendedCandidateId, "candidate_1");
    assert.equal(inspection.candidates[0]?.paletteDriftColors.length, 2);
    assert.ok(
      inspection.candidates[0]?.diagnostics.some(
        (diagnostic) => diagnostic.code === "outside-mask-change"
      )
    );
    const comparePath = await repository.createImagegenComparePreview(
      run.id,
      imagegenResult.id,
      "candidate_1"
    );
    assert.ok(comparePath.endsWith(".compare.png"));
    const compareStat = await stat(comparePath);
    assert.ok(compareStat.isFile());

    const applyPreview = await repository.previewImagegenApply(
      run.id,
      imagegenResult.id,
      {}
    );
    imagegenApplyPreviewResponseSchema.parse({ preview: applyPreview });
    assert.equal(applyPreview.candidateId, "candidate_1");
    assert.equal(applyPreview.patches.length, 16);
    assert.equal(applyPreview.ignoredOutsideMaskPixels.length, 1);
    assert.equal(applyPreview.ignoredOutsideMaskPixels[0]?.x, 0);
    const checkpointsBeforeApply = await repository.listEditorCheckpoints(
      run.id
    );
    assert.equal(checkpointsBeforeApply.length, 0);

    const applied = await repository.applyImagegenResult(
      run.id,
      imagegenResult.id,
      {}
    );
    assert.equal(applied.imagegenResult.status, "applied");
    const [frame] = applied.document.frames;
    assert.equal(frame?.grid.cells[8 * 32 + 8], "#552211");
    assert.equal(frame?.grid.cells[0], null);
    const checkpointsAfterApply = await repository.listEditorCheckpoints(
      run.id
    );
    assert.equal(checkpointsAfterApply.length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("OpenAPI schemas stay in parity with runtime validation examples", async () => {
  const { repository, root, sourcePath } = await createRepositoryFixture();
  try {
    const createRunRequest = {
      asset: {
        action: "run",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "character",
        view: "side",
      },
      name: "Parity Run",
      sourceFrames: [{ path: sourcePath }],
    };
    createRunInputSchema.parse(createRunRequest);
    validateOpenApiSchema("CreateRunRequest", createRunRequest);

    const addFrameRequest = {
      frame: { path: sourcePath },
      mode: "copy-frame",
    };
    addFrameInputSchema.parse(addFrameRequest);
    validateOpenApiSchema("AddFrameRequest", addFrameRequest);

    const approveFrameRequest = {
      approved: true,
      approvedBy: "agent",
      note: "OpenAPI/runtime parity example.",
    };
    approveFrameInputSchema.parse(approveFrameRequest);
    validateOpenApiSchema("ApproveFrameRequest", approveFrameRequest);

    const createExportRequest = {
      fps: 8,
      name: "Parity Export",
      targets: [
        "raw-frames",
        "game-strip",
        "webp",
        "svg",
        "tgs",
        "lottie",
        "react",
        "css",
      ],
    };
    createExportInputSchema.parse(createExportRequest);
    validateOpenApiSchema("CreateExportRequest", createExportRequest);

    const pixelGridWriteRequest = {
      grid: {
        cells: ["#111111", null, "#ffffff", null],
        palette: ["#111111", "#ffffff"],
        size: { height: 2, width: 2 },
      },
    };
    pixelGridWriteRequestSchema.parse(pixelGridWriteRequest);
    validateOpenApiSchema("PixelGridWriteRequest", pixelGridWriteRequest);

    const editorOperationsRequest = {
      operations: [
        {
          color: "#111111",
          frameId: "frame_01",
          type: "set-pixel",
          x: 0,
          y: 0,
        },
        {
          bounds: { height: 1, width: 1, x: 0, y: 0 },
          clearMaskLayerIds: [],
          frameId: "frame_01",
          type: "delete-target",
        },
        {
          bounds: { height: 2, width: 2, x: 2, y: 2 },
          clearMaskLayerIds: ["mask_1"],
          frameId: "frame_01",
          maskLayerIds: ["mask_1"],
          type: "delete-selected-pixels",
        },
      ],
    };
    editorOperationsRequestSchema.parse(editorOperationsRequest);
    validateOpenApiSchema("EditorOperationsRequest", editorOperationsRequest);

    const animationFixRequest = {
      mode: "fix-flicker",
    };
    animationFixRequestSchema.parse(animationFixRequest);
    validateOpenApiSchema("AnimationFixRequest", animationFixRequest);

    const agentProjectMemory = {
      constraints: ["Keep outside-mask pixels unchanged."],
      decisionLog: [
        {
          at: new Date().toISOString(),
          by: "agent",
          decision: "Use masks for targeted generation.",
          reason: "The user wants isolated part regeneration.",
        },
      ],
      projectBrief: "Small pixel-art hero.",
      protectedDetails: ["eyes"],
      schemaVersion,
      styleGuide: {
        animationRules: ["Keep motion readable."],
        outlineRules: ["Preserve one-pixel outlines."],
        palette: ["#111111"],
        shadingRules: ["Avoid anti-aliasing."],
      },
      updatedAt: new Date().toISOString(),
    };
    agentProjectMemorySchema.parse(agentProjectMemory);
    validateOpenApiSchema("AgentProjectMemory", agentProjectMemory);

    const createPartReferenceRequest = {
      frameId: "frame_01",
      maskLayerId: "mask_1",
    };
    createPartReferenceRequestSchema.parse(createPartReferenceRequest);
    validateOpenApiSchema(
      "CreatePartReferenceRequest",
      createPartReferenceRequest
    );

    const partRegenerationRequest = {
      frameIds: ["frame_01"],
      maskLayerId: "mask_1",
      mode: "single-frame",
      prompt: "Regenerate only the eyes.",
    };
    partRegenerationRequestSchema.parse(partRegenerationRequest);
    validateOpenApiSchema("PartRegenerationRequest", partRegenerationRequest);

    const run = await repository.createRun(createRunRequest);
    const frame = await writeFixtureFrame(repository, run);
    await repository.setFrameApproval(run.id, frame.id, {
      approved: true,
      approvedBy: "agent",
    });
    const job = await repository.createJob(run.id, "cleanup");
    const exportDir = repository.exportDir(run, "export_parity");
    const savedAnimation = makeSavedAnimationFixture(
      repository,
      run,
      "export_parity",
      exportDir
    );
    const errorResponse = {
      error: {
        code: "validation-error",
        details: { field: "name" },
        message: "Request or persisted data did not match the expected schema.",
        retryable: true,
      },
    };

    runSchema.parse(run);
    validateOpenApiSchema("Run", run);
    validateOpenApiSchema("RunResponse", { run });

    frameSchema.parse(frame);
    validateOpenApiSchema("Frame", frame);
    validateOpenApiSchema("FrameResponse", { frame });

    jobSchema.parse(job);
    validateOpenApiSchema("Job", job);
    validateOpenApiSchema("JobResponse", { job });

    savedAnimationSchema.parse(savedAnimation);
    validateOpenApiSchema("SavedAnimation", savedAnimation);
    validateOpenApiSchema("SavedAnimationResponse", { savedAnimation });
    validateOpenApiSchema("SavedAnimationsResponse", {
      exports: [savedAnimation],
    });
    const editorDocument = await repository.importApprovedFramesToEditor(
      run.id
    );
    editorDocument.masks[0] = {
      ...editorDocument.masks[0],
      mask: Array.from({ length: 32 * 32 }, (_, index) => {
        const x = index % 32;
        const y = Math.floor(index / 32);
        return x >= 2 && x < 4 && y >= 2 && y < 4;
      }),
    };
    await repository.writeEditorDocument(editorDocument);
    validateOpenApiSchema("EditorDocument", editorDocument);
    validateOpenApiSchema("EditorDocumentResponse", {
      document: editorDocument,
    });
    const checkpointBeforeOperation = await repository.createEditorCheckpoint(
      run.id,
      {
        label: "Before parity operation",
        source: "agent",
      }
    );
    validateOpenApiSchema("EditorCheckpoint", checkpointBeforeOperation);
    validateOpenApiSchema("EditorCheckpointResponse", {
      checkpoint: checkpointBeforeOperation,
    });
    await repository.applyEditorOperations(run.id, editorOperationsRequest);
    const checkpointAfterOperation = await repository.createEditorCheckpoint(
      run.id,
      {
        label: "After parity operation",
        source: "agent",
      }
    );
    const operationLog = await repository.listEditorOperations(run.id);
    validateOpenApiSchema("EditorOperationLogResponse", {
      operations: operationLog,
    });
    assert.ok(operationLog[0]);
    validateOpenApiSchema("EditorOperationLogEntry", operationLog[0]);
    const checkpointComparison = await repository.compareEditorCheckpoints(
      run.id,
      checkpointBeforeOperation.id,
      checkpointAfterOperation.id
    );
    validateOpenApiSchema("CheckpointComparison", checkpointComparison);
    validateOpenApiSchema("CheckpointComparisonResponse", {
      comparison: checkpointComparison,
    });
    const revertOperationRequest = {
      createRollbackCheckpoint: true,
    };
    validateOpenApiSchema(
      "RevertEditorOperationRequest",
      revertOperationRequest
    );
    const revertedOperation = await repository.revertEditorOperation(run.id, {
      ...revertOperationRequest,
      operationId: operationLog[0].id,
    });
    validateOpenApiSchema("RevertEditorOperationResponse", revertedOperation);
    const inspection = await repository.inspectEditorFrame(run.id, frame.id);
    validateOpenApiSchema("FrameVisualInspection", inspection);
    validateOpenApiSchema("FrameVisualInspectionResponse", { inspection });
    const visualSummary = await repository.readVisualSummary(run.id);
    validateOpenApiSchema("VisualSummary", visualSummary);
    validateOpenApiSchema("VisualSummaryResponse", { visualSummary });
    const animationFixPreview = await repository.previewAnimationFix(
      run.id,
      animationFixRequest
    );
    validateOpenApiSchema("AnimationFixPreview", animationFixPreview);
    validateOpenApiSchema("AnimationFixPreviewResponse", {
      preview: animationFixPreview,
    });
    const animationFix = await repository.applyAnimationFix(
      run.id,
      animationFixRequest
    );
    validateOpenApiSchema("AnimationFixResult", animationFix);
    validateOpenApiSchema("AnimationFixResponse", { animationFix });
    const maskIntelligence = await repository.readMaskIntelligence(run.id);
    validateOpenApiSchema("MaskIntelligenceReport", maskIntelligence);
    validateOpenApiSchema("MaskIntelligenceResponse", { maskIntelligence });
    const memory = await repository.writeAgentProjectMemory(run.id, {
      memory: agentProjectMemory,
    });
    validateOpenApiSchema("AgentProjectMemory", memory);
    validateOpenApiSchema("AgentProjectMemoryResponse", { memory });
    const reference = await repository.createPartReferencePackage(run.id, {
      frameId: frame.id,
      maskLayerId: "mask_1",
    });
    validateOpenApiSchema("PartReferencePackage", reference);
    validateOpenApiSchema("PartReferenceResponse", { reference });
    const regeneration = await repository.createPartRegenerationDraft(run.id, {
      maskLayerId: "mask_1",
      prompt: "Regenerate only the selected mask.",
      referenceId: reference.id,
    });
    validateOpenApiSchema("PartRegenerationDraft", regeneration);
    validateOpenApiSchema("PartRegenerationDraftResponse", { regeneration });
    const imagegenRequest = await repository.createImagegenRequest(run.id, {
      regenerationId: regeneration.id,
    });
    validateOpenApiSchema("ImagegenRequestArtifact", imagegenRequest);
    validateOpenApiSchema("ImagegenRequestResponse", { imagegenRequest });
    const imagegenResult = await repository.recordImagegenResult(run.id, {
      candidates: [
        {
          frameId: frame.id,
          grid: {
            cells: Array.from({ length: 32 * 32 }, (_, index) => {
              const x = index % 32;
              const y = Math.floor(index / 32);
              return x >= 2 && x < 4 && y >= 2 && y < 4 ? "#222222" : null;
            }),
            palette: ["#222222"],
            size: { height: 32, width: 32 },
          },
          id: "candidate_parity",
          notes: "Parity candidate.",
          score: 0.7,
        },
      ],
      requestId: imagegenRequest.id,
    });
    validateOpenApiSchema("ImagegenResultArtifact", imagegenResult);
    validateOpenApiSchema("ImagegenResultResponse", { imagegenResult });
    const imagegenInspection = await repository.inspectImagegenResult(
      run.id,
      imagegenResult.id
    );
    validateOpenApiSchema("ImagegenResultInspection", imagegenInspection);
    validateOpenApiSchema("ImagegenResultInspectionResponse", {
      inspection: imagegenInspection,
    });
    const imagegenApplyPreview = await repository.previewImagegenApply(
      run.id,
      imagegenResult.id,
      {}
    );
    validateOpenApiSchema("ImagegenApplyPreview", imagegenApplyPreview);
    validateOpenApiSchema("ImagegenApplyPreviewResponse", {
      preview: imagegenApplyPreview,
    });

    validateOpenApiSchema("ErrorResponse", errorResponse);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
