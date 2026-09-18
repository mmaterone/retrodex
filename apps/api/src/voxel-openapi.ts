// Public discovery for the 3D module. Cross-field bounds and duplicate voxel
// validation are enforced by the shared Zod schemas at runtime.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const number = { type: "integer", minimum: 0 };
const coordinate = { type: "integer", minimum: 0, maximum: 127 };
const hex = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const point = {
  type: "object",
  required: ["x", "y", "z"],
  properties: { x: coordinate, y: coordinate, z: coordinate },
};
const view = {
  type: "string",
  enum: ["front", "back", "left", "right", "top", "bottom"],
};
const points = { type: "array", minItems: 1, maxItems: 32768, items: point };
const vector = {
  type: "object",
  required: ["x", "y", "z"],
  properties: Object.fromEntries(
    ["x", "y", "z"].map((a) => [
      a,
      { type: "integer", minimum: -128, maximum: 128 },
    ]),
  ),
};
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const operation = (
  type: string,
  required: string[],
  properties: Record<string, unknown>,
) => ({
  type: "object",
  required: ["type", ...required],
  properties: { type: { const: type }, ...properties },
});
export const voxelOpenApiSchemas: Record<string, unknown> = {
  VoxelProjection: {
    type: "object",
    required: ["width", "height", "cells"],
    properties: {
      width: { type: "integer", minimum: 1, maximum: 128 },
      height: { type: "integer", minimum: 1, maximum: 128 },
      cells: { type: "array", maxItems: 16384, items: nullable(hex) },
    },
  },
  VoxelProjections: {
    type: "object",
    properties: Object.fromEntries(
      ["front", "back", "left", "right", "top", "bottom"].map((v) => [
        v,
        ref("VoxelProjection"),
      ]),
    ),
  },
  VoxelModel: {
    type: "object",
    required: ["version", "size", "palette", "voxels", "projections", "recipe"],
    properties: {
      version: { const: 1 },
      size: { type: "integer", minimum: 1, maximum: 128 },
      palette: { type: "array", minItems: 1, maxItems: 65536, items: hex },
      voxels: {
        type: "array",
        maxItems: 2097152,
        items: {
          ...point,
          required: ["x", "y", "z", "colors"],
          properties: {
            ...point.properties,
            colors: {
              type: "array",
              minItems: 6,
              maxItems: 6,
              items: { type: "integer", minimum: 0, maximum: 65535 },
            },
          },
        },
      },
      projections: ref("VoxelProjections"),
      recipe: {
        type: "object",
        required: ["algorithm", "singleViewDepth"],
        properties: {
          algorithm: { const: "silhouette-intersection-v1" },
          singleViewDepth: { type: "integer", minimum: 1, maximum: 128 },
        },
      },
    },
  },
  VoxelBuild: {
    type: "object",
    required: ["expectedRevision", "size", "projections"],
    properties: {
      expectedRevision: number,
      size: { type: "integer", minimum: 1, maximum: 128 },
      projections: ref("VoxelProjections"),
      singleViewDepth: {
        type: "integer",
        minimum: 1,
        maximum: 128,
        default: 1,
      },
    },
  },
  VoxelOperation: {
    oneOf: [
      operation("clear", [], {}),
      operation("fill-plane", ["point", "face", "color"], {
        point,
        face: view,
        color: hex,
        enclosed: { type: "boolean", default: true },
        selection: {
          type: "object",
          required: ["min", "max"],
          properties: { min: point, max: point },
        },
      }),
      operation("fill", ["point", "face", "color"], {
        point,
        face: view,
        color: hex,
        contiguous: { type: "boolean", default: true },
      }),
      operation("delete", ["min", "max"], { min: point, max: point }),
      operation("transform", ["min", "max", "offset"], {
        min: point,
        max: point,
        offset: vector,
        copy: { type: "boolean", default: false },
        scale: {
          type: "object",
          required: ["x", "y", "z"],
          properties: Object.fromEntries(
            ["x", "y", "z"].map((a) => [
              a,
              { type: "integer", minimum: 1, maximum: 128 },
            ]),
          ),
        },
      }),
      operation("resize", ["size"], {
        size: { type: "integer", minimum: 1, maximum: 128 },
        anchor: { enum: ["origin", "center"], default: "center" },
      }),
      operation("interpolate", ["views"], {
        views: { enum: ["front-side", "front-side-top"] },
      }),
      operation("set", ["points", "color"], { points, color: nullable(hex) }),
      operation("paint", ["points", "color"], {
        points,
        color: hex,
        face: view,
      }),
      operation("extrude", ["points", "face", "distance"], {
        points: { ...points, maxItems: 16384 },
        face: view,
        distance: { type: "integer", minimum: 1, maximum: 128 },
      }),
      operation("mirror", ["axis", "min", "max"], {
        axis: { enum: ["x", "y", "z"] },
        min: point,
        max: point,
      }),
    ],
  },
  VoxelOperations: {
    type: "object",
    required: ["expectedRevision", "operations"],
    properties: {
      expectedRevision: number,
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: ref("VoxelOperation"),
      },
    },
  },
  VoxelReplace: {
    type: "object",
    required: ["expectedRevision", "model"],
    properties: { expectedRevision: number, model: ref("VoxelModel") },
  },
  VoxelUndo: {
    type: "object",
    required: ["expectedRevision"],
    properties: { expectedRevision: number },
  },
  VoxelState: {
    type: "object",
    required: ["revision", "model", "canUndo", "inspection"],
    properties: {
      revision: number,
      model: nullable(ref("VoxelModel")),
      canUndo: { type: "boolean" },
      canRedo: { type: "boolean" },
      inspection: nullable({ type: "object" }),
    },
  },
  VoxelRender: {
    type: "object",
    properties: {
      width: { type: "integer", minimum: 8, maximum: 512, default: 64 },
      height: { type: "integer", minimum: 8, maximum: 512, default: 64 },
      yaw: { type: "number", default: 0 },
      pitch: { type: "number", minimum: -90, maximum: 90, default: 20 },
      zoom: { type: "number", minimum: 0.1, maximum: 8, default: 1 },
      panX: { type: "number", minimum: -512, maximum: 512, default: 0 },
      panY: { type: "number", minimum: -512, maximum: 512, default: 0 },
      shading: { type: "boolean", default: false },
      outline: { type: "boolean", default: false },
      edges: { type: "boolean", default: false },
      outlineColor: hex,
      lightYaw: { type: "number", default: -45 },
      lightPitch: { type: "number", minimum: -90, maximum: 90, default: 45 },
      background: nullable(hex),
      directions: { enum: [1, 8, 16], default: 1 },
    },
  },
  VoxelRenderedFrames: {
    type: "object",
    required: ["revision", "frames"],
    properties: {
      revision: number,
      frames: {
        type: "array",
        items: {
          type: "object",
          required: ["width", "height", "cells"],
          properties: {
            width: { type: "integer" },
            height: { type: "integer" },
            cells: { type: "array", items: nullable(hex) },
          },
        },
      },
    },
  },
  VoxelExport: {
    type: "object",
    required: ["revision", "model", "obj", "mtl", "manifest"],
    properties: {
      revision: number,
      model: ref("VoxelModel"),
      obj: { type: "string" },
      mtl: { type: "string" },
      manifest: { type: "object" },
      textured: {
        type: "object",
        description: "OBJ, MTL, palette texture grid and manifest",
      },
      orthographic: ref("VoxelProjections"),
    },
  },
};
const endpoint = (
  operationId: string,
  summary: string,
  output: string,
  input?: string,
) => ({
  operationId,
  summary,
  parameters: [{ $ref: "#/components/parameters/runId" }],
  ...(input
    ? {
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref(input) } },
        },
      }
    : {}),
  responses: {
    "200": {
      description: "3D result",
      content: { "application/json": { schema: ref(output) } },
    },
    "400": { description: "Invalid geometry or input" },
    "409": { description: "Stale expectedRevision; reload before editing" },
  },
});
export const voxelOpenApiPaths = {
  "/runs/{runId}/voxel": {
    get: endpoint(
      "getVoxelModel",
      "Read model, revision and silhouette diagnostics",
      "VoxelState",
    ),
    put: endpoint(
      "replaceVoxelModel",
      "Import a native Retrodex model with an undo snapshot",
      "VoxelState",
      "VoxelReplace",
    ),
  },
  "/runs/{runId}/voxel/build": {
    post: endpoint(
      "buildVoxelModel",
      "Intersect native alpha projections; no implicit resize",
      "VoxelState",
      "VoxelBuild",
    ),
  },
  "/runs/{runId}/voxel/operations": {
    patch: endpoint(
      "editVoxelModel",
      "Apply atomic voxel edits with revision protection",
      "VoxelState",
      "VoxelOperations",
    ),
  },
  "/runs/{runId}/voxel/undo": {
    post: endpoint(
      "undoVoxelModel",
      "Restore previous geometry as a new revision",
      "VoxelState",
      "VoxelUndo",
    ),
  },
  "/runs/{runId}/voxel/redo": {
    post: endpoint(
      "redoVoxelModel",
      "Restore an undone model as a new revision",
      "VoxelState",
      "VoxelUndo",
    ),
  },
  "/runs/{runId}/voxel/render": {
    post: endpoint(
      "renderVoxelViews",
      "Render fixed-frame orthographic pixel grids",
      "VoxelRenderedFrames",
      "VoxelRender",
    ),
  },
  "/runs/{runId}/voxel/export": {
    get: endpoint(
      "exportVoxelModel",
      "Return model JSON, OBJ, MTL and axis metadata",
      "VoxelExport",
    ),
  },
};
