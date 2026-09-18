import { join } from "node:path";
import { z } from "zod";
import {
  applyVoxelOperation,
  buildVoxelModel,
  voxelModelSchema,
  voxelOperationSchema,
  inspectVoxelModel,
  renderVoxelDirections,
  exportVoxelOBJ,
  exportVoxelTexturedOBJ,
  projectVoxelModel,
} from "@retrodex/contracts";
import type { VoxelModel } from "@retrodex/contracts";
import { RunRepository } from "./run-repository.js";
import { readJsonFile, writeJsonAtomic } from "./json.js";
import { ApiError } from "./errors.js";

const stateSchema = z.object({
  revision: z.number().int().nonnegative(),
  model: voxelModelSchema.nullable(),
  history: z.array(voxelModelSchema.nullable()).max(12),
  future: z.array(voxelModelSchema.nullable()).max(12).default([]),
});
type State = z.infer<typeof stateSchema>;
function boundedHistory(history: (VoxelModel | null)[]) {
  const result: (VoxelModel | null)[] = [];
  let cells = 0;
  for (const m of history.slice(-12).reverse()) {
    if (result.length && cells + (m?.voxels.length ?? 0) > 2_097_152) break;
    result.unshift(m);
    cells += m?.voxels.length ?? 0;
  }
  return result;
}
const revisionSchema = z.number().int().nonnegative();
export class VoxelRepository {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private runs: RunRepository) {}
  private async path(runId: string) {
    const run = await this.runs.readRun(runId);
    return join(run.paths.root, "voxel", "document.json");
  }
  private async read(runId: string): Promise<State> {
    const path = await this.path(runId);
    try {
      return stateSchema.parse(await readJsonFile(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { revision: 0, model: null, history: [], future: [] };
      throw e;
    }
  }
  async get(runId: string) {
    const s = await this.read(runId);
    return {
      revision: s.revision,
      model: s.model,
      canUndo: s.history.length > 0,
      canRedo: s.future.length > 0,
      inspection: s.model ? inspectVoxelModel(s.model) : null,
    };
  }
  async change(
    runId: string,
    expectedRevision: unknown,
    action: (m: VoxelModel | null) => VoxelModel | null,
    direction: "undo" | "redo" | null = null,
  ) {
    const expected = revisionSchema.parse(expectedRevision);
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        const s = await this.read(runId);
        if (s.revision !== expected)
          throw new ApiError(
            "voxel-revision-conflict",
            "3D model changed. Reload before editing.",
            409,
            true,
          );
        const undo = direction === "undo",
          redo = direction === "redo";
        if (redo && !s.future.length)
          throw new ApiError("voxel-no-redo", "No next 3D revision.", 400);
        if (undo && !s.history.length)
          throw new ApiError("voxel-no-undo", "No previous 3D revision.", 400);
        const model = undo
          ? s.history[s.history.length - 1]!
          : redo
            ? s.future[s.future.length - 1]!
            : action(s.model);
        const next: State = {
          revision: s.revision + 1,
          model: model ? voxelModelSchema.parse(model) : null,
          future: undo
            ? boundedHistory([...s.future, s.model])
            : redo
              ? s.future.slice(0, -1)
              : [],
          history: undo
            ? s.history.slice(0, -1)
            : boundedHistory([...s.history, s.model]),
        };
        await writeJsonAtomic(await this.path(runId), next);
        return {
          revision: next.revision,
          model: next.model,
          canUndo: next.history.length > 0,
          canRedo: next.future.length > 0,
          inspection: next.model ? inspectVoxelModel(next.model) : null,
        };
      });
    this.locks.set(runId, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(runId) === task) this.locks.delete(runId);
    }
  }
  build(runId: string, body: any) {
    return this.change(runId, body.expectedRevision, () => {
      try {
        return buildVoxelModel(body);
      } catch (e) {
        if (e instanceof z.ZodError) throw e;
        throw new ApiError(
          "voxel-build-invalid",
          (e as Error).message,
          400,
          true,
        );
      }
    });
  }
  replace(runId: string, body: any) {
    return this.change(runId, body.expectedRevision, () =>
      voxelModelSchema.parse(body.model),
    );
  }
  operations(runId: string, body: any) {
    const ops = z
      .array(voxelOperationSchema)
      .min(1)
      .max(64)
      .parse(body.operations);
    return this.change(runId, body.expectedRevision, (m) => {
      if (!m)
        throw new ApiError("voxel-not-found", "Build a 3D model first.", 404);
      try {
        return ops.reduce(applyVoxelOperation, m);
      } catch (e) {
        throw new ApiError(
          "voxel-operation-invalid",
          (e as Error).message,
          400,
          true,
        );
      }
    });
  }
  undo(runId: string, body: any) {
    return this.change(runId, body.expectedRevision, (m) => m, "undo");
  }
  redo(runId: string, body: any) {
    return this.change(runId, body.expectedRevision, (m) => m, "redo");
  }
  async render(runId: string, body: unknown) {
    const s = await this.get(runId);
    if (!s.model)
      throw new ApiError("voxel-not-found", "Build a model first.", 404);
    return {
      revision: s.revision,
      frames: renderVoxelDirections(s.model, body),
    };
  }
  async export(runId: string) {
    const s = await this.get(runId);
    if (!s.model)
      throw new ApiError("voxel-not-found", "Build a model first.", 404);
    return {
      revision: s.revision,
      model: s.model,
      ...exportVoxelOBJ(s.model),
      textured: exportVoxelTexturedOBJ(s.model),
      orthographic: projectVoxelModel(s.model),
    };
  }
}
