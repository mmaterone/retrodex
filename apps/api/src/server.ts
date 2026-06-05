import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { URL } from "node:url";

import type { EditorDocument } from "@retrodex/contracts";

import { ApiError, toApiError } from "./errors.js";
import { JobRunner } from "./jobs.js";
import { openApiDocument } from "./openapi.js";
import { RunRepository } from "./run-repository.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "5175", 10);
const webUrl = process.env.WEB_URL ?? "http://127.0.0.1:5174";
const repository = new RunRepository(process.env.RUNS_DIR);
const jobs = new JobRunner(repository);

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown
): void => {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload, null, 2));
};

const contentTypeFor = (path: string): string => {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".css")) {
    return "text/css";
  }
  if (normalized.endsWith(".gif")) {
    return "image/gif";
  }
  if (normalized.endsWith(".json")) {
    return "application/json";
  }
  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  if (normalized.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (normalized.endsWith(".tgs")) {
    return "application/gzip";
  }
  if (normalized.endsWith(".tsx") || normalized.endsWith(".ts")) {
    return "text/plain";
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }
  return "application/octet-stream";
};

const sendFile = async (
  response: ServerResponse,
  path: string
): Promise<void> => {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(path);
  } catch {
    throw new ApiError("artifact-not-found", "Artifact not found.", 404, true);
  }
  if (!fileStat.isFile()) {
    throw new ApiError("artifact-not-found", "Artifact not found.", 404, true);
  }
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Length": String(fileStat.size),
    "Content-Type": contentTypeFor(path),
  });
  response.end(await readFile(path));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
  }
  return body ? JSON.parse(body) : {};
};

const expandLocalPath = (path: string): string => {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
};

const routeLocalExportRequest = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<boolean> => {
  if (request.method !== "POST") {
    return false;
  }
  const body = await readBody(request);
  if (!(typeof body === "object" && body)) {
    throw new ApiError("local-export-invalid", "Request body is required.", 400, true);
  }
  const { directoryPath, files } = body as {
    directoryPath?: unknown;
    files?: unknown;
  };
  if (typeof directoryPath !== "string" || !directoryPath.trim()) {
    throw new ApiError(
      "local-export-directory-required",
      "A local directory path is required.",
      400,
      true
    );
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new ApiError(
      "local-export-files-required",
      "At least one export file is required.",
      400,
      true
    );
  }
  const targetDirectory = resolve(expandLocalPath(directoryPath.trim()));
  if (!isAbsolute(targetDirectory)) {
    throw new ApiError(
      "local-export-directory-invalid",
      "Export directory must be an absolute path or start with ~/.",
      400,
      true
    );
  }
  await mkdir(targetDirectory, { recursive: true });
  const writtenFiles = [];
  for (const file of files) {
    if (!(typeof file === "object" && file)) {
      throw new ApiError("local-export-file-invalid", "Invalid export file.", 400, true);
    }
    const { contentBase64, filename } = file as {
      contentBase64?: unknown;
      filename?: unknown;
    };
    if (
      typeof filename !== "string" ||
      !filename ||
      filename !== basename(filename)
    ) {
      throw new ApiError(
        "local-export-filename-invalid",
        "Export filenames must not contain folders.",
        400,
        true
      );
    }
    if (typeof contentBase64 !== "string") {
      throw new ApiError(
        "local-export-content-invalid",
        "Export file content must be base64 encoded.",
        400,
        true
      );
    }
    const bytes = Buffer.from(contentBase64, "base64");
    const outputPath = resolve(targetDirectory, filename);
    await writeFile(outputPath, bytes);
    writtenFiles.push({
      filename,
      path: outputPath,
      size: bytes.byteLength,
    });
  }
  sendJson(response, 200, {
    directoryPath: targetDirectory,
    files: writtenFiles,
  });
  return true;
};

const routeFrameRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  runId: string,
  frameId: string | undefined,
  action: string | undefined
): Promise<boolean> => {
  const run = await repository.readRun(runId);
  if (request.method === "POST" && !frameId) {
    const updatedRun = await repository.addFrame(
      runId,
      await readBody(request)
    );
    sendJson(response, 201, { run: updatedRun });
    return true;
  }
  if (request.method === "GET" && frameId && !action) {
    const frame = await repository.readFrame(run, frameId);
    sendJson(response, 200, { frame });
    return true;
  }
  if (request.method === "GET" && frameId && action === "image") {
    await sendFile(response, repository.framePngPath(run, frameId));
    return true;
  }
  if (request.method === "POST" && frameId && action === "approve") {
    const result = await repository.setFrameApproval(
      run.id,
      frameId,
      await readBody(request)
    );
    sendJson(response, 200, result);
    return true;
  }
  return false;
};

const routeExportRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  runId: string,
  exportId: string | undefined,
  resource: string | undefined,
  fileParts: string[]
): Promise<boolean> => {
  if (!exportId) {
    return false;
  }
  const run = await repository.readRun(runId);
  if (request.method === "GET" && !resource) {
    sendJson(response, 200, {
      savedAnimation: await repository.readExport(run, exportId),
    });
    return true;
  }
  if (request.method === "GET" && resource === "files") {
    const encodedFilePath = fileParts.join("/");
    if (!encodedFilePath) {
      throw new ApiError(
        "artifact-path-required",
        "Artifact file path is required.",
        400,
        true
      );
    }
    const filePath = decodeURIComponent(encodedFilePath);
    let artifactPath: string;
    try {
      artifactPath = repository.exportArtifactPath(run, exportId, filePath);
    } catch {
      throw new ApiError(
        "artifact-path-unsafe",
        "Artifact file path must stay inside the export snapshot.",
        400,
        true
      );
    }
    await sendFile(response, artifactPath);
    return true;
  }
  return false;
};

// eslint-disable-next-line complexity
const routeRunRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[]
): Promise<boolean> => {
  const [runId, resource, childId, action, ...rest] = parts.slice(2);
  if (request.method === "GET" && !runId) {
    sendJson(response, 200, { runs: await repository.listRuns() });
    return true;
  }
  if (request.method === "POST" && !runId) {
    const run = await repository.createRun(await readBody(request));
    sendJson(response, 201, { run });
    return true;
  }
  if (!runId) {
    return false;
  }
  if (request.method === "GET" && !resource) {
    sendJson(response, 200, { run: await repository.readRun(runId) });
    return true;
  }
  if (request.method === "POST" && resource === "cleanup") {
    const job = await jobs.createCleanupJob(runId);
    sendJson(response, 202, { job });
    return true;
  }
  if (request.method === "POST" && resource === "exports") {
    const job = await jobs.createExportJob(runId, await readBody(request));
    sendJson(response, 202, { job });
    return true;
  }
  if (request.method === "GET" && resource === "exports" && !childId) {
    const run = await repository.readRun(runId);
    sendJson(response, 200, { exports: await repository.listExports(run) });
    return true;
  }
  if (resource === "exports") {
    return routeExportRequest(request, response, runId, childId, action, rest);
  }
  if (resource === "editor") {
    if (request.method === "POST" && childId === "import-approved") {
      const document = await repository.importApprovedFramesToEditor(runId);
      sendJson(response, 201, { document });
      return true;
    }
    if (request.method === "GET" && !childId) {
      const document = await repository.readEditorDocument(runId);
      sendJson(response, 200, { document });
      return true;
    }
    if (request.method === "PUT" && !childId) {
      const writeFrameImages =
        new URL(request.url ?? "/", `http://${host}:${port}`).searchParams.get(
          "writeFrames"
        ) !== "false";
      const body = await readBody(request);
      const documentBody =
        typeof body === "object" && body && "document" in body
          ? body.document
          : body;
      const expectedRevision =
        typeof body === "object" &&
        body &&
        "expectedRevision" in body &&
        typeof body.expectedRevision === "number"
          ? body.expectedRevision
          : undefined;
      const document = await repository.writeEditorDocument(
        {
          ...(typeof documentBody === "object" && documentBody
            ? documentBody
            : {}),
          runId,
        } as EditorDocument,
        { expectedRevision, writeFrameImages }
      );
      sendJson(response, 200, { document });
      return true;
    }
    if (request.method === "GET" && childId === "status") {
      sendJson(response, 200, {
        status: await repository.readEditorStatus(runId),
      });
      return true;
    }
    if (request.method === "GET" && childId === "selection") {
      sendJson(response, 200, {
        selection: await repository.readEditorSelection(runId),
      });
      return true;
    }
    if (request.method === "PUT" && childId === "selection") {
      sendJson(
        response,
        200,
        await repository.writeEditorSelection(runId, await readBody(request))
      );
      return true;
    }
    if (request.method === "PATCH" && childId === "operations") {
      const document = await repository.applyEditorOperations(
        runId,
        await readBody(request)
      );
      sendJson(response, 200, { document });
      return true;
    }
    if (request.method === "POST" && childId === "export-preview") {
      sendJson(response, 200, {
        preview: await repository.previewEditorExport(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (
      request.method === "POST" &&
      childId === "intents" &&
      action === "preview"
    ) {
      sendJson(response, 200, {
        preview: await repository.previewEditIntent(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (
      request.method === "POST" &&
      childId === "intents" &&
      action === "apply"
    ) {
      sendJson(
        response,
        200,
        await repository.applyEditIntent(runId, await readBody(request))
      );
      return true;
    }
    if (request.method === "GET" && childId === "url") {
      const frameId = new URL(
        request.url ?? "/",
        `http://${host}:${port}`
      ).searchParams.get("frameId");
      const params = new URLSearchParams({ runId });
      if (frameId) {
        params.set("frameId", frameId);
      }
      sendJson(response, 200, { url: `${webUrl}/?${params.toString()}` });
      return true;
    }
    if (request.method === "GET" && childId === "visual-summary") {
      sendJson(response, 200, {
        visualSummary: await repository.readVisualSummary(runId),
      });
      return true;
    }
    if (request.method === "GET" && childId === "animation-inspection") {
      sendJson(response, 200, {
        animationInspection: await repository.inspectAnimation(runId),
      });
      return true;
    }
    if (
      request.method === "POST" &&
      childId === "animation-fixes" &&
      action === "preview"
    ) {
      sendJson(response, 200, {
        preview: await repository.previewAnimationFix(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (
      request.method === "POST" &&
      childId === "animation-fixes" &&
      action === "apply"
    ) {
      sendJson(response, 200, {
        animationFix: await repository.applyAnimationFix(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (request.method === "GET" && childId === "memory") {
      sendJson(response, 200, {
        memory: await repository.readAgentProjectMemory(runId),
      });
      return true;
    }
    if (request.method === "PUT" && childId === "memory") {
      sendJson(response, 200, {
        memory: await repository.writeAgentProjectMemory(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (request.method === "GET" && childId === "mask-intelligence") {
      sendJson(response, 200, {
        maskIntelligence: await repository.readMaskIntelligence(runId),
      });
      return true;
    }
    if (
      request.method === "GET" &&
      childId === "checkpoints" &&
      rest[0] === "compare"
    ) {
      if (!action || !rest[1]) {
        return false;
      }
      sendJson(response, 200, {
        comparison: await repository.compareEditorCheckpoints(
          runId,
          action,
          rest[1]
        ),
      });
      return true;
    }
    if (request.method === "GET" && childId === "checkpoints") {
      sendJson(response, 200, {
        checkpoints: await repository.listEditorCheckpoints(runId),
      });
      return true;
    }
    if (
      request.method === "POST" &&
      childId === "checkpoints" &&
      rest[0] === "revert"
    ) {
      if (!action) {
        return false;
      }
      const body = await readBody(request);
      sendJson(
        response,
        200,
        await repository.revertEditorCheckpoint(runId, {
          ...(typeof body === "object" && body ? body : {}),
          checkpointId: action,
        })
      );
      return true;
    }
    if (request.method === "POST" && childId === "checkpoints") {
      sendJson(response, 201, {
        checkpoint: await repository.createEditorCheckpoint(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (request.method === "GET" && childId === "operations-log") {
      sendJson(response, 200, {
        operations: await repository.listEditorOperations(runId),
      });
      return true;
    }
    if (
      request.method === "POST" &&
      childId === "operations-log" &&
      rest[0] === "revert"
    ) {
      if (!action) {
        return false;
      }
      const body = await readBody(request);
      sendJson(
        response,
        200,
        await repository.revertEditorOperation(runId, {
          ...(typeof body === "object" && body ? body : {}),
          operationId: action,
        })
      );
      return true;
    }
    if (request.method === "POST" && childId === "references") {
      sendJson(response, 201, {
        reference: await repository.createPartReferencePackage(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (
      request.method === "GET" &&
      childId === "references" &&
      rest[0] === "image"
    ) {
      if (!action) {
        return false;
      }
      const run = await repository.readRun(runId);
      await sendFile(
        response,
        repository.editorReferenceImagePath(run, action)
      );
      return true;
    }
    if (request.method === "POST" && childId === "regenerate") {
      sendJson(response, 201, {
        regeneration: await repository.createPartRegenerationDraft(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (request.method === "POST" && childId === "imagegen-requests") {
      sendJson(response, 201, {
        imagegenRequest: await repository.createImagegenRequest(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (
      request.method === "POST" &&
      childId === "imagegen-results" &&
      rest[0] === "apply"
    ) {
      if (!action) {
        return false;
      }
      sendJson(
        response,
        200,
        await repository.applyImagegenResult(
          runId,
          action,
          await readBody(request)
        )
      );
      return true;
    }
    if (
      request.method === "POST" &&
      childId === "imagegen-results" &&
      rest[0] === "apply-preview"
    ) {
      if (!action) {
        return false;
      }
      sendJson(response, 200, {
        preview: await repository.previewImagegenApply(
          runId,
          action,
          await readBody(request)
        ),
      });
      return true;
    }
    if (
      request.method === "GET" &&
      childId === "imagegen-results" &&
      rest[0] === "inspect"
    ) {
      if (!action) {
        return false;
      }
      sendJson(response, 200, {
        inspection: await repository.inspectImagegenResult(runId, action),
      });
      return true;
    }
    if (
      request.method === "GET" &&
      childId === "imagegen-results" &&
      rest[0] === "compare" &&
      rest[2] === "image"
    ) {
      if (!(action && rest[1])) {
        return false;
      }
      await sendFile(
        response,
        await repository.createImagegenComparePreview(runId, action, rest[1])
      );
      return true;
    }
    if (request.method === "POST" && childId === "imagegen-results") {
      sendJson(response, 201, {
        imagegenResult: await repository.recordImagegenResult(
          runId,
          await readBody(request)
        ),
      });
      return true;
    }
    if (childId === "frames" && rest[0] === "grid") {
      const frameId = action;
      if (!frameId) {
        return false;
      }
      if (request.method === "PUT") {
        sendJson(
          response,
          200,
          await repository.writeEditorFrameGrid(
            runId,
            frameId,
            await readBody(request)
          )
        );
        return true;
      }
    }
    if (childId === "frames" && rest[0] === "pixels") {
      const frameId = action;
      if (!frameId) {
        return false;
      }
      if (request.method === "GET") {
        sendJson(response, 200, await repository.readPixelGrid(runId, frameId));
        return true;
      }
      if (request.method === "PUT") {
        sendJson(
          response,
          200,
          await repository.writePixelGrid(
            runId,
            frameId,
            await readBody(request)
          )
        );
        return true;
      }
    }
    if (childId === "frames" && rest[0] === "inspect") {
      const frameId = action;
      if (!frameId || request.method !== "GET") {
        return false;
      }
      sendJson(response, 200, {
        inspection: await repository.inspectEditorFrame(runId, frameId),
      });
      return true;
    }
  }
  if (resource === "frames") {
    return routeFrameRequest(request, response, runId, childId, action);
  }
  return false;
};

const routeJobRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string | undefined
): Promise<boolean> => {
  if (!jobId) {
    return false;
  }
  if (request.method === "GET") {
    const job = await jobs.getJob(jobId);
    if (!job) {
      throw new ApiError("job-not-found", "Job not found.", 404, true);
    }
    sendJson(response, 200, { job });
    return true;
  }
  if (request.method === "POST") {
    const body = await readBody(request);
    if (
      typeof body === "object" &&
      body &&
      "action" in body &&
      body.action === "cancel"
    ) {
      const job = await jobs.cancelJob(jobId);
      if (!job) {
        throw new ApiError("job-not-found", "Job not found.", 404, true);
      }
      sendJson(response, 200, { job });
      return true;
    }
  }
  return false;
};

const routeRequest = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const parts = url.pathname.split("/");
  const [, resource, id] = parts;

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      runsDir: repository.runsDir,
      service: "retrodex-api",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/openapi.json") {
    sendJson(response, 200, openApiDocument);
    return;
  }
  if (resource === "local-exports" && (await routeLocalExportRequest(request, response))) {
    return;
  }
  if (
    (resource === "runs" &&
      (await routeRunRequest(request, response, parts))) ||
    (resource === "jobs" && (await routeJobRequest(request, response, id)))
  ) {
    return;
  }

  throw new ApiError("route-not-found", "Route not found.", 404, true);
};

await jobs.recoverQueuedJobs();

createServer(async (request, response) => {
  try {
    await routeRequest(request, response);
  } catch (error: unknown) {
    const apiError = toApiError(error);
    sendJson(response, apiError.statusCode, {
      error: {
        code: apiError.code,
        details: apiError.details,
        message: apiError.message,
        retryable: apiError.retryable,
      },
    });
  }
}).listen(port, host, () => {
  console.log(`Pixel Character API listening on http://${host}:${port}`);
});
