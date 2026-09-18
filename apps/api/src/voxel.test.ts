import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyVoxelOperation,
  buildVoxelModel,
  exportVoxelOBJ,
  inspectVoxelModel,
  projectionUV,
  renderVoxelDirections,
  renderVoxelModel,
  voxelModelSchema,
  voxelNormals,
  voxelSurface,
  voxelViews,
} from "@retrodex/contracts";
import type { VoxelModel, VoxelProjection } from "@retrodex/contracts";
import { RunRepository } from "./run-repository.js";
import { VoxelRepository } from "./voxel-repository.js";
const grid = (n: number, c: string | null = "#cc8844"): VoxelProjection => ({
  width: n,
  height: n,
  cells: Array(n * n).fill(c),
});
const cube = (n = 2) =>
  buildVoxelModel({ size: n, projections: { front: grid(n), right: grid(n) } });

test("single view is a centered slab, multiple views intersect alpha, no resampling", () => {
  const front = grid(4, null);
  front.cells[1 + 1 * 4] = "#aa0000";
  const one = buildVoxelModel({ size: 4, projections: { front } });
  assert.deepEqual(
    one.voxels.map((v) => [v.x, v.y, v.z]),
    [[1, 2, 1]],
  );
  assert.equal(
    buildVoxelModel({ size: 4, projections: { front }, singleViewDepth: 3 })
      .voxels.length,
    3,
  );
  const right = grid(4, null);
  right.cells[0 + 1 * 4] = "#00bb00";
  const both = buildVoxelModel({ size: 4, projections: { front, right } });
  assert.deepEqual(
    both.voxels.map((v) => [v.x, v.y, v.z]),
    [[1, 2, 3]],
  );
  assert.equal(both.palette[both.voxels[0]!.colors[3]], "#00bb00");
  assert.equal(inspectVoxelModel(both).projections.front?.missing, 0);
  assert.throws(
    () => buildVoxelModel({ size: 4, projections: { front: grid(3) } }),
    /dimensions/,
  );
  assert.throws(
    () => buildVoxelModel({ size: 4, projections: {} }),
    /at least one/,
  );
});
test("six projections preserve handedness and independent face colors", () => {
  const point = { x: 1, y: 2, z: 3 },
    n = 5;
  const projections: Record<string, VoxelProjection> = {};
  voxelViews.forEach((view, i) => {
    const p = grid(n, null),
      [x, y] = projectionUV(view, point.x, point.y, point.z, n);
    p.cells[x + y * n] = `#${String(i + 1).repeat(6)}`;
    projections[view] = p;
  });
  const m = buildVoxelModel({ size: n, projections });
  assert.equal(m.voxels.length, 1);
  assert.deepEqual(m.voxels[0], { ...point, colors: [0, 1, 2, 3, 4, 5] });
  assert.deepEqual(projectionUV("right", 1, 2, 3, 5), [1, 2]);
  assert.deepEqual(projectionUV("back", 1, 2, 3, 5), [3, 2]);
});
test("surface omits internal faces and all exported face windings point outward", () => {
  const m = cube(2),
    faces = voxelSurface(m);
  assert.equal(m.voxels.length, 8);
  assert.equal(faces.length, 24);
  for (const f of faces) {
    const [a, b, c] = f.vertices as [number[], number[], number[], number[]];
    const u = b.map((v, i) => v - a[i]!),
      v = c.map((v, i) => v - a[i]!);
    const cross = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    assert.ok(
      cross.reduce((sum, c, i) => sum + c * voxelNormals[f.face]![i]!, 0) > 0,
    );
  }
  const output = exportVoxelOBJ(m);
  assert.equal(
    output.obj.split("\n").filter((l) => l.startsWith("f ")).length,
    24,
  );
  assert.match(output.mtl, /newmtl c0/);
});
test("paint, add, erase, extrusion and mirror preserve source model and enforce bounds", () => {
  const front = grid(5, null);
  front.cells[1 + 2 * 5] = "#ff0000";
  const m = buildVoxelModel({ size: 5, projections: { front } }),
    original = JSON.stringify(m),
    v = m.voxels[0]!;
  const painted = applyVoxelOperation(m, {
    type: "paint",
    points: [v],
    face: "front",
    color: "#00ff00",
  });
  assert.equal(painted.palette[painted.voxels[0]!.colors[0]], "#00ff00");
  assert.equal(painted.palette[painted.voxels[0]!.colors[1]], "#ff0000");
  const extruded = applyVoxelOperation(m, {
    type: "extrude",
    points: [v],
    face: "front",
    distance: 2,
  });
  assert.equal(extruded.voxels.length, 3);
  assert.throws(
    () =>
      applyVoxelOperation(m, {
        type: "extrude",
        points: [v],
        face: "front",
        distance: 3,
      }),
    /bounds/,
  );
  const mirrored = applyVoxelOperation(painted, {
    type: "mirror",
    axis: "z",
    min: { x: 0, y: 0, z: 0 },
    max: { x: 4, y: 4, z: 4 },
  });
  assert.equal(mirrored.palette[mirrored.voxels[0]!.colors[1]], "#00ff00");
  assert.equal(
    applyVoxelOperation(m, { type: "set", points: [v], color: null }).voxels
      .length,
    0,
  );
  assert.equal(JSON.stringify(m), original);
});
test("model schema rejects duplicate cells, invalid palettes and oversized models", () => {
  const m = cube();
  assert.equal(
    voxelModelSchema.safeParse({ ...m, voxels: [m.voxels[0], m.voxels[0]] })
      .success,
    false,
  );
  assert.equal(
    voxelModelSchema.safeParse({
      ...m,
      voxels: [{ x: 0, y: 0, z: 0, colors: [255, 0, 0, 0, 0, 0] }],
    }).success,
    false,
  );
  assert.equal(voxelModelSchema.safeParse({ ...m, size: 129 }).success, false);
});
test("rasterizer uses frontmost face, fixed framing, palette-only pixels and a closed orbit", () => {
  const m = cube();
  m.palette.push("#00ff00");
  m.voxels.forEach((v) => {
    v.colors[0] = 1;
  });
  const f = renderVoxelModel(m, { width: 32, height: 32, yaw: 0, pitch: 0 });
  assert.equal(f.cells[16 + 16 * 32], "#00ff00");
  const hit = f.hits[16 + 16 * 32]!;
  assert.equal(hit % 6, 0);
  assert.equal(m.voxels[Math.floor(hit / 6)]!.z, 1);
  assert.deepEqual(
    f.cells,
    renderVoxelModel(m, { width: 32, height: 32, yaw: 360, pitch: 0 }).cells,
  );
  const frames = renderVoxelDirections(m, {
    width: 32,
    height: 32,
    directions: 8,
    pitch: 20,
  });
  assert.equal(frames.length, 8);
  for (const frame of frames) {
    assert.equal(frame.cells.length, 1024);
    assert.ok(frame.cells.some(Boolean));
    assert.ok(frame.cells.every((c) => c === null || m.palette.includes(c)));
  }
});
test("contradictory views produce a measurable silhouette deficit", () => {
  const front = grid(4, null),
    right = grid(4, null);
  front.cells[0] = "#aa0000";
  right.cells[12] = "#00bb00";
  const m = buildVoxelModel({ size: 4, projections: { front, right } });
  assert.equal(m.voxels.length, 0);
  assert.equal(inspectVoxelModel(m).projections.front?.missing, 1);
});
test("run persistence, concurrent revisions, atomic rejection, reload and undo", async () => {
  const root = await mkdtemp(join(tmpdir(), "retrodex-voxel-"));
  try {
    const runs = new RunRepository(root);
    const run = await runs.createRun({
      name: "Voxel test",
      asset: {
        action: "single",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "prop",
        view: "front",
      },
    });
    const repo = new VoxelRepository(runs);
    assert.equal((await repo.get(run.id)).revision, 0);
    const before = await readFile(join(run.paths.root, "run.json"), "utf8");
    const built = await repo.build(run.id, {
      size: 2,
      projections: { front: grid(2) },
      expectedRevision: 0,
    });
    assert.equal(built.revision, 1);
    const outcomes = await Promise.allSettled([
      repo.operations(run.id, {
        expectedRevision: 1,
        operations: [
          { type: "paint", points: [{ x: 0, y: 0, z: 0 }], color: "#0000ff" },
        ],
      }),
      repo.operations(run.id, {
        expectedRevision: 1,
        operations: [
          { type: "paint", points: [{ x: 0, y: 0, z: 0 }], color: "#ff00ff" },
        ],
      }),
    ]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
    await assert.rejects(
      () =>
        repo.operations(run.id, {
          expectedRevision: 2,
          operations: [
            {
              type: "extrude",
              points: [{ x: 0, y: 0, z: 0 }],
              face: "back",
              distance: 2,
            },
          ],
        }),
      /bounds/,
    );
    assert.equal((await repo.get(run.id)).revision, 2);
    const reloaded = new VoxelRepository(new RunRepository(root));
    assert.equal((await reloaded.get(run.id)).revision, 2);
    const undone = await reloaded.undo(run.id, { expectedRevision: 2 });
    assert.deepEqual(undone.model, built.model);
    assert.equal(undone.revision, 3);
    assert.equal(undone.canRedo, true);
    const redone = await reloaded.redo(run.id, { expectedRevision: 3 });
    assert.equal(redone.revision, 4);
    assert.equal(redone.canRedo, false);
    assert.notDeepEqual(redone.model, built.model);
    await reloaded.undo(run.id, { expectedRevision: 4 });
    await reloaded.replace(run.id, { expectedRevision: 5, model: built.model });
    assert.equal((await reloaded.get(run.id)).canRedo, false);
    await assert.rejects(
      () => reloaded.redo(run.id, { expectedRevision: 6 }),
      /No next/,
    );
    assert.equal(
      (await repo.render(run.id, { directions: 8, width: 16, height: 16 }))
        .frames.length,
      8,
    );
    assert.match((await repo.export(run.id)).obj, /mtllib model.mtl/);
    assert.equal(
      await readFile(join(run.paths.root, "run.json"), "utf8"),
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pixzels import reverses coordinates, preserves partial overrides and converts linear color", async () => {
  const { importPixzelsModel } = await import("@retrodex/contracts");
  const source = grid(4, "#ff0000");
  const m = await importPixzelsModel(
    {
      version: 1,
      meta: { activeSize: 4 },
      projections: { front: "data:image/png;base64,AA==" },
      voxelOverrides: [
        ["2,1,2", { present: true, frontColor: { r: 0, g: 1, b: 0 } }],
        [
          "0,0,0",
          {
            present: true,
            color: { r: 0.2158605, g: 0.2158605, b: 0.2158605 },
          },
        ],
      ],
    },
    async () => source,
  );
  const edited = m.voxels.find((v) => v.x === 1 && v.y === 1 && v.z === 1)!;
  assert.equal(m.palette[edited.colors[0]], "#00ff00");
  assert.equal(m.palette[edited.colors[1]], "#ff0000");
  const added = m.voxels.find((v) => v.x === 3 && v.y === 0 && v.z === 3)!;
  assert.equal(m.palette[added.colors[0]], "#808080");
  const top = await importPixzelsModel(
    {
      version: 1,
      meta: { activeSize: 4 },
      projections: { top: "data:image/png;base64,AA==" },
    },
    async () => source,
  );
  assert.ok(top.voxels.every((v) => v.y === 2));
});

test("3D OpenAPI schemas accept real model, build, operation and render responses", async () => {
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const { openApiDocument } = await import("./openapi.js");
  const ajv = new Ajv({ strict: false });
  const examples: Record<string, unknown> = {
    VoxelModel: cube(),
    VoxelBuild: {
      expectedRevision: 0,
      size: 2,
      projections: { front: grid(2) },
    },
    VoxelOperations: {
      expectedRevision: 1,
      operations: [
        { type: "set", points: [{ x: 0, y: 0, z: 0 }], color: null },
      ],
    },
    VoxelRenderedFrames: {
      revision: 1,
      frames: renderVoxelDirections(cube(), { directions: 8 }),
    },
  };
  for (const [schema, value] of Object.entries(examples)) {
    const validate = ajv.compile({
      $ref: `#/components/schemas/${schema}`,
      components: openApiDocument.components,
    });
    assert.ok(validate(value), JSON.stringify(validate.errors));
  }
});

test("rendered frames materialize as unapproved PNG assets on full editor save", async () => {
  const root = await mkdtemp(join(tmpdir(), "retrodex-voxel-frames-"));
  try {
    const runs = new RunRepository(root);
    const run = await runs.createRun({
      name: "Voxel frame materialization",
      asset: {
        action: "single",
        frames: 1,
        sheet: "single",
        style: "pixel-art",
        type: "prop",
        view: "front",
      },
    });
    const { editorDocumentSchema } = await import("@retrodex/contracts");
    // Use the existing editor importer to obtain the complete document defaults.
    const timestamp = new Date().toISOString();
    const document = editorDocumentSchema.parse({
      activeMaskLayerId: null,
      canvas: { width: 32, height: 32 },
      createdAt: timestamp,
      updatedAt: timestamp,
      frames: [],
      masks: [],
      runId: run.id,
      schemaVersion: run.schemaVersion,
      selectedFrameId: null,
      saveState: { dirty: false, lastSavedAt: timestamp, revision: 0 },
      timeline: { fps: 8, framesList: [], isPlaying: false },
    });
    const rendered = renderVoxelDirections(cube(), {
      width: 32,
      height: 32,
      directions: 1,
    })[0]!;
    const frame = {
      frameId: "voxel_frame_1",
      name: "Front",
      grid: {
        size: { width: 32, height: 32 },
        cells: rendered.cells,
        palette: ["#cc8844"],
      },
      alphaBBox: null,
      anchor: { mode: "bottom", x: 16, y: 32 },
      sourcePath: null,
    };
    const next = editorDocumentSchema.parse({
      ...document,
      frames: [frame],
      selectedFrameId: frame.frameId,
      timeline: { ...document.timeline, framesList: [frame.frameId] },
    });
    await runs.writeEditorDocument(next, { writeFrameImages: true });
    const saved = await runs.readFrame(run, frame.frameId);
    assert.equal(saved.approved, false);
    assert.equal((await readFile(saved.path)).subarray(1, 4).toString(), "PNG");
    assert.deepEqual((await runs.readRun(run.id)).activeFrameIds, [
      frame.frameId,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("128 native import allows large palettes without downsampling", () => {
  const front = grid(128, null);
  front.cells[127] = "#123456";
  const m = buildVoxelModel({ size: 128, projections: { front } });
  assert.deepEqual(m.voxels[0], {
    x: 127,
    y: 127,
    z: 63,
    colors: [0, 0, 0, 0, 0, 0],
  });
  const palette = Array.from(
    { length: 300 },
    (_, i) => "#" + i.toString(16).padStart(6, "0"),
  );
  assert.ok(
    voxelModelSchema.safeParse({
      ...m,
      palette,
      voxels: [{ ...m.voxels[0], colors: [299, 299, 299, 299, 299, 299] }],
    }).success,
  );
});
test("fill stays on connected exposed faces of matching color", () => {
  let m = cube(4);
  m = applyVoxelOperation(m, {
    type: "paint",
    points: [
      { x: 2, y: 0, z: 3 },
      { x: 2, y: 1, z: 3 },
      { x: 2, y: 2, z: 3 },
      { x: 2, y: 3, z: 3 },
    ],
    face: "front",
    color: "#000000",
  });
  const f = applyVoxelOperation(m, {
    type: "fill",
    point: { x: 0, y: 0, z: 3 },
    face: "front",
    color: "#00ffff",
    contiguous: true,
  });
  assert.equal(
    f.voxels.filter((v) => f.palette[v.colors[0]] === "#00ffff").length,
    8,
  );
  assert.equal(
    f.voxels.filter((v) => f.palette[v.colors[1]] === "#00ffff").length,
    0,
  );
  assert.equal(m.palette.includes("#00ffff"), false);
});
test("selection transforms copy, move, resize explicitly and reject bounds atomically", () => {
  const base = { ...cube(2), size: 8, projections: {} };
  const before = JSON.stringify(base);
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const copied = applyVoxelOperation(base, {
    type: "transform",
    ...bounds,
    offset: { x: 4, y: 0, z: 0 },
    copy: true,
  });
  assert.equal(copied.voxels.length, 16);
  const moved = applyVoxelOperation(base, {
    type: "transform",
    ...bounds,
    offset: { x: 4, y: 0, z: 0 },
    copy: false,
  });
  assert.equal(moved.voxels.length, 8);
  assert.ok(moved.voxels.every((v) => v.x >= 4));
  const scaled = applyVoxelOperation(base, {
    type: "transform",
    ...bounds,
    offset: { x: 1, y: 1, z: 1 },
    copy: false,
    scale: { x: 4, y: 4, z: 4 },
  });
  assert.equal(scaled.voxels.length, 64);
  assert.throws(
    () =>
      applyVoxelOperation(base, {
        type: "transform",
        ...bounds,
        offset: { x: 7, y: 0, z: 0 },
        copy: false,
      }),
    /bounds/,
  );
  assert.equal(JSON.stringify(base), before);
  assert.equal(
    applyVoxelOperation(copied, { type: "delete", ...bounds }).voxels.length,
    8,
  );
  assert.equal(
    applyVoxelOperation(base, { type: "resize", size: 16, anchor: "center" })
      .voxels[0]!.x,
    4,
  );
  assert.throws(
    () =>
      applyVoxelOperation(base, { type: "resize", size: 1, anchor: "origin" }),
    /crop/,
  );
  assert.equal(applyVoxelOperation(base, { type: "clear" }).voxels.length, 0);
});
test("exact six-view projection and texture export preserve face colors", async () => {
  const { projectVoxelModel, exportVoxelTexturedOBJ } = await import(
    "@retrodex/contracts"
  );
  const m = cube(3);
  m.palette.push("#ff0000");
  m.voxels.forEach((v) => (v.colors[4] = 1));
  const p = projectVoxelModel(m);
  assert.ok(p.top.cells.every((c) => c === "#ff0000"));
  assert.ok(p.front.cells.every((c) => c === "#cc8844"));
  const rebuilt = applyVoxelOperation(m, {
    type: "interpolate",
    views: "front-side-top",
  });
  assert.equal(rebuilt.voxels.length, 27);
  const e = exportVoxelTexturedOBJ(m);
  assert.match(e.mtl, /map_Kd model.png/);
  assert.match(e.obj, /vt /);
  assert.match(e.obj, /f \d+\/\d+/);
  assert.deepEqual(e.texture.cells.filter(Boolean), m.palette);
});
test("render settings preserve picking and support shading, outline, background and camera pan", () => {
  const m = cube(2),
    plain = renderVoxelModel(m, { width: 32, height: 32, pitch: 20, yaw: 30 });
  const lit = renderVoxelModel(m, {
    width: 32,
    height: 32,
    pitch: 20,
    yaw: 30,
    shading: true,
    outline: true,
    outlineColor: "#ff00ff",
    background: "#000000",
  });
  assert.deepEqual(lit.hits, plain.hits);
  assert.ok(lit.cells.includes("#ff00ff"));
  assert.ok(lit.cells.includes("#000000"));
  assert.ok(
    lit.cells.some(
      (c) => c !== "#000000" && c !== "#ff00ff" && !m.palette.includes(c!),
    ),
  );
  const p = renderVoxelModel(m, { width: 32, height: 32, pitch: 0, panX: 4 });
  assert.equal(p.cells[20 + 16 * 32], "#cc8844");
});

test("empty planar bucket fills enclosed holes and honors a selection", () => {
  let m = { ...cube(5), voxels: [], projections: {} } as VoxelModel;
  const points = [];
  for (let y = 1; y < 4; y++)
    for (let x = 1; x < 4; x++)
      if (x === 1 || x === 3 || y === 1 || y === 3) points.push({ x, y, z: 2 });
  m = applyVoxelOperation(m, { type: "set", points, color: "#00ff00" });
  const filled = applyVoxelOperation(m, {
    type: "fill-plane",
    point: { x: 2, y: 2, z: 2 },
    face: "front",
    color: "#ff0000",
    enclosed: true,
  });
  assert.equal(filled.voxels.length, 9);
  assert.throws(
    () =>
      applyVoxelOperation(m, {
        type: "fill-plane",
        point: { x: 0, y: 0, z: 2 },
        face: "front",
        color: "#ff0000",
        enclosed: true,
      }),
    /not enclosed/,
  );
  const selected = applyVoxelOperation(m, {
    type: "fill-plane",
    point: { x: 0, y: 0, z: 2 },
    face: "front",
    color: "#ff0000",
    enclosed: false,
    selection: { min: { x: 0, y: 0, z: 2 }, max: { x: 0, y: 4, z: 2 } },
  });
  assert.equal(selected.voxels.length, 13);
});
