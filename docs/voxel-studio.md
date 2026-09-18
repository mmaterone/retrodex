# Retrodex 3D studio

The 3D tab builds editable voxel assets from native pixel projections and renders
those assets back into the existing 2D timeline. It is a separate document; 3D
edits never rewrite the source frames or their approvals.

## Algorithm provenance

The supplied Pixzels demo build (`assets/index-BTj9MVi-.js`, demo v0.00t) was
inspected as a behavioral reference. No bundled application, UI, third-party
library code, images or example projects are vendored into Retrodex.

The reusable algorithms are implemented as explicit typed functions:

| Pixzels reference | Retrodex implementation |
| --- | --- |
| `dn`: alpha intersections, one-view slab, six face colors | `buildVoxelModel` |
| `ET`: neighbor occupancy and outward surface faces | `voxelSurface` |
| `aR`/`lR`: projections plus voxel overrides | `importPixzelsModel`, native model JSON |
| `k2`: surface export | `exportVoxelOBJ` (palette materials instead of texture atlas) |
| `K2`/`Q2`: orthographic direction rendering | `renderVoxelDirections` (shared CPU pixel rasterizer) |

The rasterizer, revision store, schemas, agent operations and UI are Retrodex
implementations. Geometry lives in `packages/contracts/src/voxel` so the browser
and API use exactly the same algorithms. Python remains responsible for existing
image cleanup; geometry does not require a Python worker or a WebGL dependency.

Parity was checked against the isolated occupancy/color loop in the supplied
build using its Z (16³) and PC (64³) example JSONs: respectively 544 and 12,817
occupied cells, with zero occupancy or six-face color differences after the
coordinate conversion. These checks include saved overrides. The third-party
examples and reference loop remain external to the repository. Unit tests use
small independent synthetic fixtures.

## Contract

- Grid sizes 1–64, cubic. Every source is a square native image of that exact
  size. No automatic resizing or grid inference in the 3D builder.
- Six named views: front, back, left, right, top, bottom. Pixel rows run downward.
- Coordinates: +X right, +Y up, +Z front. `projectionUV` documents each mapping.
- One view creates a centered slab of `singleViewDepth` (default 1). Two or more
  views intersect their alpha masks; absent views impose no constraint. Parallel
  views alone do not recover depth, and hidden cavities cannot be inferred.
- Shared palette of at most 256 opaque RGB colors. Projection cells are hex or
  null; the PNG uploader rejects partial alpha. Clean ImageGen output first.
- Each occupied cell has integer x/y/z and six palette indices in
  front/back/left/right/top/bottom order. Coordinates are unique and in bounds.
- Inspection reports missing/extra silhouette pixels per supplied view. An
  empty or mismatching reconstruction is reported, never silently repaired.
- Surface mesh omits internal faces, uses outward CCW winding and per-face
  colors. OBJ references `model.mtl`; both files must stay together.
- Orthographic rasterization uses a depth buffer, pixel-center samples, fixed
  framing across directions, no antialiasing and no added lighting colors.
  Orbit output is a turntable, not skeletal animation.

## Editor

Upload PNG views or use the current 2D frame, then **Build volume**. The demo
robot is an independent built-in fixture. Orbit by dragging or right-drag with
another tool; angle sliders and four view buttons also control the camera.
Paint a face, add/erase a cell, extrude a face, or copy occupied cells from the
left half onto the right. Mirror swaps face colors with the geometry and does
not erase empty destinations. Out-of-bounds operations fail atomically.

**Add views to 2D timeline** appends 1/8/16 rendered grids at the existing canvas
size and returns to the 2D editor. These are editable frames with the existing
save/export flow, not newly approved exports. Existing frames remain intact.
Direct PNG/OBJ/MTL downloads are local previews; use the normal 2D backend export
for approved production sprite artifacts.

Native JSON stores source projections, build recipe, exact voxels and palette.
**Load JSON** accepts native Retrodex JSON and Pixzels v1 projects up to 64³.
The compatibility importer decodes embedded PNGs, reverses X/Z coordinates,
swaps side-face orientation, flips the top image vertically, converts linear
RGB override colors to sRGB and applies saved overrides. Oversized or excessive
palette data is rejected rather than resampled or quantized silently.

Run-linked models save automatically to `runs/<id>/voxel/document.json` with
an independent monotonically increasing revision and up to 12 undo snapshots.
Changes are serialized per run and each write atomically replaces the whole
state, so a rejected batch cannot leave partial geometry. Reload resolves
conflicts; it explicitly loads saved state. Standalone models live in the open
session; download JSON before reloading or closing the page.

## Agent API and CLI

All mutations require `expectedRevision` from `GET /runs/:id/voxel` (0 for a
new model). This revision is independent of the 2D editor revision.

| Method | Path suffix under `/runs/:id/voxel` | Result |
| --- | --- | --- |
| GET | empty | Model, revision, undo availability, silhouette inspection |
| POST | `/build` | `{size, projections, singleViewDepth?, expectedRevision}` |
| PUT | empty | `{model, expectedRevision}` imports native model |
| PATCH | `/operations` | `{operations, expectedRevision}` atomic batch |
| POST | `/undo` | `{expectedRevision}` restores previous state as a new revision |
| POST | `/render` | `{width?, height?, yaw?, pitch?, directions?}` returns pixel grids |
| GET | `/export` | Model, OBJ, MTL, axis/recipe metadata and revision |

Render output supports 8–256 pixels per dimension and 1/8/16 directions. Render
and export are read-only and do not grant approval or modify the 2D timeline.

CLI examples (`--json-file` avoids large shell payloads):

```sh
npm --workspace @retrodex/cli run dev -- voxel show RUN
npm --workspace @retrodex/cli run dev -- voxel build RUN --expected-revision 0 --json-file views.json
npm --workspace @retrodex/cli run dev -- voxel operations RUN --expected-revision 1 --json-file edits.json
npm --workspace @retrodex/cli run dev -- voxel render RUN --json '{"width":64,"height":64,"directions":8,"pitch":20}'
npm --workspace @retrodex/cli run dev -- voxel undo RUN --expected-revision 2
npm --workspace @retrodex/cli run dev -- voxel export RUN
```

Operation example:

```json
{"operations":[{"type":"extrude","points":[{"x":8,"y":12,"z":9}],"face":"front","distance":2}]}
```

Use `set` (color null erases), `paint` (optional named face), `extrude` or
`mirror` (axis and inclusive min/max bounds). Observe at least front, side and
three-quarter views after geometry changes. Do not interpret matching
silhouettes as proof of correct anatomy. Generate missing orthographic views
through the existing ImageGen workflow, clean them, align them in the existing
reference tools, and only then submit their native grids to the builder.

## Current boundaries

This first module has no rig, skeletal motion, automatic multi-view generation,
GLB export, animation interpolation or 128³ support. The native model remains
editable; those features can be added without embedding the Pixzels application.
