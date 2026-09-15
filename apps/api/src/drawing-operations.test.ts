import { strict as assert } from "node:assert";
import test from "node:test";
import { editorDocumentSchema, editorOperationSchema, editorMaskLayerSchema } from "@retrodex/contracts";
import type { EditorDocument } from "@retrodex/contracts";
import { applyDrawingOperation } from "./drawing-operations.js";

const blank = (): EditorDocument => editorDocumentSchema.parse({
  createdAt: new Date().toISOString(), runId: "drawing", schemaVersion: "2026-06-04.v1", updatedAt: new Date().toISOString(),
  canvas: { width: 8, height: 8 }, activeMaskLayerId: null, masks: [], selectedFrameId: "f1",
  saveState: { revision: 0 }, selection: { selectedFrameId: "f1" }, timeline: { framesList: ["f1"] },
  frames: [{ frameId: "f1", name: "Frame", sourcePath: null, alphaBBox: null,
    anchor: { x: 0, y: 0, mode: "custom" },
    grid: { cells: Array(64).fill(null), size: { width: 8, height: 8 } } }],
});
const draw = (doc: EditorDocument, input: object) => {
  const operation = editorOperationSchema.parse({ frameId: "f1", ...input });
  assert.ok(operation.type === "polygon-pixels" || operation.type === "mirror-pixels" || operation.type === "paint-mask");
  return applyDrawingOperation(doc, operation);
};
const rectangle = [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }, { x: 1, y: 5 }];
const cells = (doc: EditorDocument) => doc.frames[0].grid.cells;
const mask = (id: string, indices: number[], locked = false) => editorMaskLayerSchema.parse({
  id, name: id, color: "#ffffff", anchor: { x: 0, y: 0 }, parentId: null,
  mask: Array.from({ length: 64 }, (_, index) => indices.includes(index)),
  regenerationPolicy: { locked },
});

test("polygon fills concave silhouettes identically in either winding and tracks alpha bounds", () => {
  const points = [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 2 },
    { x: 2, y: 2 }, { x: 2, y: 5 }, { x: 1, y: 5 }];
  const source = blank();
  const forward = draw(source, { type: "polygon-pixels", points, color: "#ff0000" });
  const reverse = draw(source, { type: "polygon-pixels", points: [...points].reverse(), color: "#ff0000" });
  assert.deepEqual(cells(forward), cells(reverse));
  assert.equal(cells(forward).filter(Boolean).length, 16);
  assert.equal(cells(forward)[4 * 8 + 4], null);
  assert.equal(cells(forward)[5 * 8 + 1], "#ff0000");
  assert.deepEqual(forward.frames[0].alphaBBox, { x: 1, y: 1, width: 5, height: 5 });
  assert.ok(cells(source).every((cell) => cell === null));
});

test("polygon outlines have inward thickness and do not outline clipping boundaries", () => {
  for (const [thickness, count] of [[1, 16], [2, 24]]) {
    const result = draw(blank(), { type: "polygon-pixels", points: rectangle, color: "#ffffff", mode: "outline", thickness });
    assert.equal(cells(result).filter(Boolean).length, count);
    assert.equal(cells(result)[3 * 8 + 3], null);
  }
  const clipped = draw(blank(), { type: "polygon-pixels", color: "#ffffff", mode: "outline", points: [
    { x: -10, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 20 }, { x: -10, y: 20 },
  ] });
  assert.ok(cells(clipped).every((cell) => cell === null));
});

test("drawing intersects selection and target masks and protects locked pixels", () => {
  const source = blank();
  source.masks = [mask("body", [9, 10, 11, 12]), mask("eyes", [10], true)];
  source.selection.selectedPixelsMask = Array.from({ length: 64 }, (_, i) => [9, 10, 11, 17].includes(i));
  for (const operation of [
    { type: "paint-mask", color: "#ff0000", targetMaskLayerIds: ["body"] },
    { type: "polygon-pixels", points: rectangle, color: "#ff0000", targetMaskLayerIds: ["body"] },
  ]) {
    const result = draw(source, operation);
    assert.deepEqual(cells(result).flatMap((cell, index) => cell ? [index] : []), [9, 11]);
    assert.deepEqual(result.masks, source.masks);
  }
  source.selection.selectedPixelsMask.fill(false);
  assert.ok(cells(draw(source, { type: "paint-mask", color: "#ff0000", targetMaskLayerIds: ["body"] })).every((cell) => !cell));
});

test("paint-mask can shade only visible cells or erase without touching other regions", () => {
  const source = blank();
  source.masks = [mask("body", [9, 10, 11])];
  cells(source)[9] = "#123456";
  cells(source)[10] = "#12345600";
  cells(source)[20] = "#abcdef";
  const shaded = draw(source, { type: "paint-mask", color: "#654321", targetMaskLayerIds: ["body"], respectAlpha: true });
  assert.equal(cells(shaded)[9], "#654321");
  assert.equal(cells(shaded)[10], "#12345600");
  assert.equal(cells(shaded)[11], null);
  const erased = draw(shaded, { type: "paint-mask", color: null, targetMaskLayerIds: ["body"] });
  assert.equal(cells(erased)[9], null);
  assert.equal(cells(erased)[20], "#abcdef");
});

test("mirror uses immutable source pixels for overlapping bounds and half-pixel axes", () => {
  const source = blank();
  cells(source)[0] = "#ff0000"; cells(source)[1] = "#0000ff";
  const swap = draw(source, { type: "mirror-pixels", sourceBounds: { x: 0, y: 0, width: 2, height: 1 }, axisPosition: 0.5 });
  assert.deepEqual(cells(swap).slice(0, 2), ["#0000ff", "#ff0000"]);
  const across = draw(source, { type: "mirror-pixels", sourceBounds: { x: 0, y: 0, width: 2, height: 1 } });
  assert.deepEqual(cells(across).slice(6, 8), ["#0000ff", "#ff0000"]);
  const down = draw(source, { type: "mirror-pixels", axis: "horizontal", sourceBounds: { x: 0, y: 0, width: 2, height: 1 } });
  assert.deepEqual(cells(down).slice(56, 58), ["#ff0000", "#0000ff"]);
});

test("mirror clips destinations to selection, protects locks and only clears explicitly", () => {
  const source = blank();
  cells(source)[0] = "#ff0000"; cells(source)[1] = "#0000ff"; cells(source)[5] = "#ffffff";
  source.masks = [mask("protected", [6], true)];
  source.selection.selectedBounds = { x: 5, y: 0, width: 2, height: 1 };
  const op = { type: "mirror-pixels", sourceBounds: { x: 0, y: 0, width: 3, height: 1 } };
  const result = draw(source, op);
  assert.equal(cells(result)[7], null);
  assert.equal(cells(result)[6], null);
  assert.equal(cells(result)[5], "#ffffff");
  const clear = draw(source, { ...op, copyTransparent: true });
  assert.equal(cells(clear)[5], null);
});

test("invalid targets and geometry fail instead of painting an unrestricted frame", () => {
  assert.throws(() => draw(blank(), { type: "paint-mask", color: "#ffffff", targetMaskLayerIds: ["typo"] }), /mask does not exist/);
  assert.throws(() => draw(blank(), { type: "paint-mask", color: "#ffffff", targetMaskLayerIds: [] }));
  assert.throws(() => draw(blank(), { type: "polygon-pixels", points: rectangle, frameId: "typo", color: "#ffffff" }), /frame does not exist/);
  assert.throws(() => draw(blank(), { type: "mirror-pixels", sourceBounds: { x: 7, y: 0, width: 2, height: 1 } }), /bounds must fit/);
  assert.throws(() => draw(blank(), { type: "mirror-pixels", sourceBounds: { x: 0, y: 0, width: 2, height: 1 }, axisPosition: 0.25 }));
  const source = blank(); source.masks = [mask("bad", [1])]; source.masks[0].mask = [];
  assert.throws(() => draw(source, { type: "paint-mask", color: "#ffffff", targetMaskLayerIds: ["bad"] }), /geometry/);
});
