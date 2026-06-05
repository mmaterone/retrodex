# Backend Run Engine

The backend owns local run lifecycle orchestration. It reads contracts and
presets from code, writes recoverable run folders, then delegates deterministic
image processing to Python workers.

## Local API

Default URL: `http://127.0.0.1:5175`

- `GET /health`
- `GET /openapi.json`
- `GET /runs`
- `POST /runs`
- `GET /runs/:id`
- `POST /runs/:id/frames`
- `GET /runs/:id/frames/:frameId`
- `GET /runs/:id/frames/:frameId/image`
- `POST /runs/:id/frames/:frameId/approve`
- `POST /runs/:id/cleanup`
- `POST /runs/:id/exports`
- `GET /runs/:id/exports`
- `GET /runs/:id/exports/:exportId`
- `GET /runs/:id/exports/:exportId/files/:filePath`
- `POST /runs/:id/editor/import-approved`
- `GET /runs/:id/editor`
- `PUT /runs/:id/editor`
- `GET /runs/:id/editor/status`
- `GET /runs/:id/editor/selection`
- `PUT /runs/:id/editor/selection`
- `PATCH /runs/:id/editor/operations`
- `POST /runs/:id/editor/export-preview`
- `POST /runs/:id/editor/intents/preview`
- `POST /runs/:id/editor/intents/apply`
- `GET /runs/:id/editor/url`
- `GET /runs/:id/editor/visual-summary`
- `GET /runs/:id/editor/animation-inspection`
- `POST /runs/:id/editor/animation-fixes/preview`
- `POST /runs/:id/editor/animation-fixes/apply`
- `GET /runs/:id/editor/memory`
- `PUT /runs/:id/editor/memory`
- `GET /runs/:id/editor/mask-intelligence`
- `GET /runs/:id/editor/checkpoints`
- `POST /runs/:id/editor/checkpoints`
- `GET /runs/:id/editor/checkpoints/:checkpointId/compare/:otherCheckpointId`
- `POST /runs/:id/editor/checkpoints/:checkpointId/revert`
- `GET /runs/:id/editor/operations-log`
- `POST /runs/:id/editor/operations-log/:operationId/revert`
- `GET /runs/:id/editor/frames/:frameId/inspect`
- `POST /runs/:id/editor/references`
- `GET /runs/:id/editor/references/:referenceId/image`
- `POST /runs/:id/editor/regenerate`
- `POST /runs/:id/editor/imagegen-requests`
- `POST /runs/:id/editor/imagegen-results`
- `GET /runs/:id/editor/imagegen-results/:resultId/inspect`
- `GET /runs/:id/editor/imagegen-results/:resultId/compare/:candidateId/image`
- `POST /runs/:id/editor/imagegen-results/:resultId/apply-preview`
- `POST /runs/:id/editor/imagegen-results/:resultId/apply`
- `GET /runs/:id/editor/frames/:frameId/pixels`
- `PUT /runs/:id/editor/frames/:frameId/pixels`
- `GET /jobs/:jobId`
- `POST /jobs/:jobId` with `{ "action": "cancel" }`

All API errors use:

```json
{
  "error": {
    "code": "validation-error",
    "message": "Human-readable message",
    "retryable": true,
    "details": {}
  }
}
```

`/openapi.json` exposes reusable request and response body schemas under
`components.schemas`, including `Run`, `Frame`, `Job`, `CreateRunRequest`,
`CreateExportRequest`, `ApproveFrameRequest`, and normalized error payloads.
API tests validate representative runtime Zod payloads against the matching
OpenAPI schemas to prevent contract drift.

## Storage

Default storage root is `${repoRoot}/runs`; override with `RUNS_DIR`.

Each run folder contains:

- `run.json`
- `editor/editor-document.json`
- `frames/{frameId}.png`
- `frames/{frameId}.frame.json`
- approval source of truth in `run.json` via `approval.approvedFrames`
- mirrored frame approval state in `frame.json` via `approved` and `approvedAt`
- `animation-draft.json`
- `diagnostics/{frameId}.qc.json`
- `pipeline/*.request.json`
- `pipeline/*.result.json`
- `jobs/{jobId}.json`
- `saved-animations/{exportId}/saved-animation.json`
- `exports/{exportId}.saved-animation.json`

JSON writes use atomic temp-file replacement. Run paths are resolved inside the
run root to prevent traversal.

## Ingest

`POST /runs` and `POST /runs/:id/frames` support:

- copied PNG frames via `sourceFrames` or `{ "mode": "copy-frame" }`
- horizontal sheet split via `sourceSheet` or `{ "mode": "split-sheet" }`
- connected-component atlas split via `{ "mode": "auto-slice-components" }`
- existing run import via `importRunPath`

PNG inputs are checked for existence and PNG signature before they are copied or
split.

`sourceFrames[].gridStrategy` controls how large imagegen/style-reference PNGs
become editor canvases:

- `infer-hidden-grid` (default): estimate the generated image's logical pixel
  grid and materialize that grid with nearest-neighbor sampling. Use this when
  the user did not explicitly specify a canvas size.
- `preserve-source`: keep the source PNG dimensions exactly.
- `resize-to-run-canvas`: force the frame to the run canvas. Use only when the
  user explicitly provided the intended canvas/grid size.

Agents must not blindly downsample imagegen pixel art. If the user did not
provide a grid size, let `infer-hidden-grid` choose the editor size.

For imagegen sheets/atlases where frame dimensions are unknown, prefer
`auto-slice-components`. The ingest worker first detects/removes the backdrop,
then slices visible alpha components with padding and writes a source manifest
with each component's original source box.

Run `asset.type` accepts `background`, `character`, `fx`, `icon`, `projectile`,
`prop`, and `tile`. `icon` and `background` are first-class asset types for
single-subject icon/background generation and export flows.

## Jobs

Cleanup and export endpoints return `202` with a persistent job. Jobs live in
`runs/{runId}/jobs/{jobId}.json` and include status, progress, current
frame/step, retry hints, timestamps, and normalized error payloads.

Statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

On API startup, `running` jobs are marked `failed` with reason `api-restart`;
`queued` jobs are resumed by the same-process local worker.

## Cleanup Worker

Cleanup requests pass the selected preset's concrete typed pipeline to
`python -m pixel_character_core.worker`. The Python registry executes:

- `detect-backdrop`
- `validate-control-grid`
- `sample-control-grid`
- `remove-background`
- `recover-lattice`
- `remove-service-colors`
- `remove-small-components`
- `protect-face-details`
- `lock-palette`
- `align-anchor`
- `score-frame`
- `write-diagnostics`

Heavy steps that are not fully implemented yet emit explicit deterministic
no-op warnings in diagnostics; there are no silent placeholders.

Implemented deterministic steps currently include:

- backdrop detection for magenta, green, checkerboard, solid, transparent, and
  none
- backdrop-aware alpha removal plus multi-pass edge matte decontamination
- service/background color removal
- control-grid visibility/gutter metrics
- control-grid sampling metadata
- horizontal lattice recovery by content bbox and canvas fitting
- small connected-component removal
- face-detail protection for small high-contrast upper-silhouette pixels
- approved/current palette locking by nearest-color remap
- alpha bbox and palette scoring
- anchor metadata
- diagnostics trace writing

No cleanup step is silently skipped. Experimental heuristics write metrics and
warnings when confidence is low.

Each step trace records step id, params, status, elapsed ms, input/output path,
metrics, and warnings. Frame QC and run QC are aggregated from worker output.

## Approval

`run.approval.approvedFrames` is the source of truth for export eligibility.
Each entry stores `frameId`, `approvedAt`, `approvedBy`, and optional `note`.
`frame.approved` and `frame.approvedAt` are compatibility mirrors for UI
display and must not be used as the export authority.

Cleanup output resets frame-local approval fields and clears
`run.approval.approvedFrames`, because cleaned frames need explicit review.
`POST /runs/:id/frames/:frameId/approve` updates both the run-level approval
contract and the mirrored frame fields.

Exports require at least one run-level approved frame. If an existing
`animation-draft.json` references a frame not listed in
`run.approval.approvedFrames`, the export job fails instead of silently
including an unreviewed frame. When all active frames are approved, the run
status becomes `approved`.

## Editor Handoff

The editor is a run-linked local tool. After an agent and user approve cleaned
frames, call `POST /runs/:id/editor/import-approved`. The backend creates
`editor/editor-document.json` from `run.approval.approvedFrames`, reads full
pixel grids from the approved PNGs, and mirrors mask/rig metadata into
`animation-draft.json`.

`GET /runs/:id/editor/url` returns the Codex browser handoff URL. The web editor
loads `?runId=...&frameId=...`, hydrates the canvas from
`editor-document.json`, and autosaves debounced snapshots with
`PUT /runs/:id/editor`. Blank local canvases still work without a run id.

`GET /runs/:id/editor/status` returns the agent-visible active workspace path:
run id, active frame id, revision, dirty/saved state, canvas, timeline, frame
count, and mask count. The web editor shows the same linked run/frame/revision
state in the top bar so the user and Codex can confirm they are editing the
same run folder.

Editor mutations support optimistic revision guards through `expectedRevision`.
Use it with full document saves, editor operations, selection writes, and pixel
grid writes. If the current document revision differs, the API returns
`editor-revision-conflict` with HTTP `409`; agents must re-read status,
document, selection, and relevant pixels before retrying.

Agents can inspect and modify exact pixels through:

- `GET /runs/:id/editor/frames/:frameId/pixels`
- `PUT /runs/:id/editor/frames/:frameId/pixels`
- `PATCH /runs/:id/editor/operations`
- `GET /runs/:id/editor/selection`
- `PUT /runs/:id/editor/selection`

Pixel maps include canvas size, full cell array, palette summary, alpha bbox,
and preview URL.

`GET/PUT /runs/:id/editor/selection` exposes the same active selection model
that the UI uses: selected frame, selected pixel bounds/mask, selected mask
layers, active mask layer, and transform target. Use it for agent actions that
should behave like the editor's selection-aware brush, erase, fill, transform,
delete, or masked regeneration tools.

`PATCH /runs/:id/editor/operations` is the universal editor action bridge for
agents. Supported typed operations include:

- raw pixel edits: `set-pixel`, `patch-pixels`, `tool-stroke`
- canvas tools: `bucket-fill`, `gradient-fill`, `shape-pixels`,
  `transform-pixels`
- object deletion: `delete-selected-pixels`, `delete-target`
- mask tools: `patch-mask`, `mask-stroke`, `mask-bucket`, `mask-shape`
- document tools: `select-frame`, `reorder-frame`, `upsert-mask-layer`,
  `delete-mask-layer`

These operations are the backend equivalent of drawing in the canvas UI. They
write through the same editor document and create operation log entries with
exact pixel and mask patches.

`POST /runs/:id/editor/export-preview` returns raw export payloads as base64
without writing a snapshot. Use it when Codex needs to inspect SVG, Lottie,
CSS, React, or saved-animation JSON before creating a final export bundle.

`POST /runs/:id/editor/checkpoints` stores a full editor document snapshot.
`POST /runs/:id/editor/checkpoints/:checkpointId/revert` restores that snapshot
and, by default, creates a rollback checkpoint for the pre-revert state.
Imagegen apply automatically creates a checkpoint before modifying pixels.

`GET /runs/:id/editor/operations-log` returns exact editor write history stored
under `editor/operations/{operationId}.json`. Each entry includes source,
operation type, before/after revisions, optional checkpoint id, and per-pixel
`before`/`after` patches. `POST /runs/:id/editor/operations-log/:operationId/revert`
applies the inverse patches for that one operation, marks the original operation
as reverted, writes a new `operation-revert` entry, and can create a rollback
checkpoint first.

`GET /runs/:id/editor/checkpoints/:leftId/compare/:rightId` compares two full
editor snapshots and returns changed frame/mask counts plus per-frame/per-mask
bboxes. Use checkpoint compare when deciding whether to revert a broad edit;
use operation revert when only one exact operation should be undone.

`POST /runs/:id/editor/intents/preview` converts semantic edit intent into exact
pixel patches without writing them. `POST /runs/:id/editor/intents/apply`
creates a checkpoint, applies the patch, and returns the updated document. The
first supported intents are `recolor-target` and `recolor-mask`.

`GET /runs/:id/editor/animation-inspection` returns temporal quality diagnostics:
frame diffs, flicker regions, per-mask motion tracks, silhouette warnings, loop
quality score, and recommendations.

`POST /runs/:id/editor/animation-fixes/preview` dry-runs deterministic animation
repairs and returns exact patches plus before/estimated-after inspection without
writing files. `POST /runs/:id/editor/animation-fixes/apply` applies the same
repair with an automatic checkpoint. Supported modes are `fix-flicker`,
`repair-loop-pop`, and `smooth-mask-motion`.

`GET /runs/:id/editor/memory` returns persistent agent-facing project memory:
project brief, constraints, protected details, style guide, and decision log.
Agents should update this with `PUT /runs/:id/editor/memory` whenever the user
approves, rejects, or clarifies a durable rule.

Mask layers are semantic rig parts, not just paint overlays. Each mask can store
`semanticRole`, `semanticLabel`, `promptHint`, parent/anchor metadata, and a
regeneration policy. Use this for targeted animation and targeted imagegen:
"animate only hair", "regenerate only weapon", or "use eyes as a locked
reference".

`GET /runs/:id/editor/mask-intelligence` returns mask diagnostics and
deterministic suggestions. Diagnostics include empty masks, missing semantic
roles, pixels outside visible alpha, missing parents, and overlaps with other
masks. Suggestions are draft masks from alpha/connected components and must be
reviewed before use.

`POST /runs/:id/editor/references` creates a masked part reference package from
a mask layer. The package includes exact mask pixels, bbox crop, masked
transparent PNG URL, full preview URL, pixel map URL, semantic role, label, and
prompt hint.

`POST /runs/:id/editor/regenerate` creates a targeted regeneration draft. It
does not call an image model by itself. It records the selected mask, reference
package, target frames, prompt, and hard instruction to preserve pixels outside
the mask. This is the handoff object for a Codex/imagegen step like "regenerate
only hair" or "animate only eyes".

`POST /runs/:id/editor/imagegen-requests` turns a regeneration draft into an
imagegen handoff artifact. `POST /runs/:id/editor/imagegen-results` records
candidates returned by a model or agent. `GET
/runs/:id/editor/imagegen-results/:resultId/inspect` scores each candidate with
deterministic mask, palette, bbox, and outside-mask diagnostics. `GET
/runs/:id/editor/imagegen-results/:resultId/compare/:candidateId/image` returns
a before/after/diff PNG. `POST
/runs/:id/editor/imagegen-results/:resultId/apply-preview` returns exact
inside-mask patches, ignored outside-mask pixels, and before/estimated-after
frame inspections without writing files. `POST
/runs/:id/editor/imagegen-results/:resultId/apply` deterministically applies the
selected candidate only through the referenced mask, preserving all outside-mask
pixels.

`GET /runs/:id/editor/visual-summary` gives an agent a human-oriented view of
the sprite or animation: per-frame summaries, dominant colors, candidate face
and eye detail zones, mask parts, motion regions, preview URLs, pixel-map URLs,
and zoom hints. `GET /runs/:id/editor/frames/:frameId/inspect` returns the same
inspection for one frame.

## CLI

The `retrodex` CLI is an HTTP client for the local API. It returns JSON
by default and is intended for agents that need to perform the same actions as a
user-facing editor session.

Core commands:

- `runs list/create/show`
- `frames add/show/approve/image`
- `cleanup start/status/cancel`
- `editor import-approved/open/show/save`
- `memory show/save`
- `pixels get/set/patch/map/preview`
- `tools brush/eraser/bucket/gradient/shape/transform`
- `tools delete-selection/delete-target`
- `edit preview/apply/recolor`
- `masks list/create/update/delete/paint/fill/shape/anchor/parent`
- `masks label`
- `masks inspect/suggest/validate`
- `inspect frame/animation`
- `animation inspect/preview/fix-flicker/repair-loop-pop/smooth-mask-motion`
- `references create/image`
- `regenerate part`
- `imagegen request/result/inspect/compare/apply-preview/apply`
- `checkpoints list/create/revert/compare`
- `operations list/revert`
- `timeline list/reorder/select`
- `exports create/list/show/artifact`

## Export

`POST /runs/:id/exports` creates an immutable saved animation snapshot. Export
uses `animation-draft.json` when present; otherwise it creates a default draft
from approved frame order.

`saved-animation.json` includes the approval records used for that immutable
snapshot.

Browser-side export in the web editor is only a quick local fallback for blank
canvases and one-off downloads. For run-linked projects, the export dialog
should default to backend export, save the editor document first, enqueue
`POST /runs/:id/exports`, and treat the resulting saved animation as the
canonical artifact. Local browser downloads do not create approval metadata,
operation history, validation, manifests, or share bundles.

Every export also writes hardening artifacts:

- `manifest.json` with deterministic artifact map and game-engine hints
- `validation.json` with per-file existence/size checks
- `editor-diff.json` comparing exported raw frames against editor state
- `share-bundle.zip` containing saved animation metadata, manifest, diff, and
  generated files

Export artifacts are read-only through the API. `GET /runs/:id/exports` lists
saved animation snapshots. `GET /runs/:id/exports/:exportId` returns one
immutable saved animation JSON. `GET
/runs/:id/exports/:exportId/files/:filePath` streams a generated file from inside
that export snapshot only; path traversal outside `saved-animations/{exportId}`
is rejected.

Generated files include:

- raw copied frames
- `strip-transparent.png`
- `preview.png`
- `preview.gif`
- `preview.webp`
- `contact-sheet.png`
- `animation.svg`
- `lottie.json`
- `animation.tgs`
- `tgs-metadata.json`
- `PixelAnimation.tsx`
- `pixel-animation.css`
- `manifest.json`
- `validation.json`
- `editor-diff.json`
- `share-bundle.zip`
- `saved-animation.json`

Supported export targets are `raw-frames`, `game-strip`, `texturepacker`,
`aseprite`, `godot`, `webp`, `svg`, `tgs`, `lottie`, `react`, and `css`.

TGS export is gzipped Lottie and must stay below 64,000 bytes. The exporter uses a
Telegram-oriented vector path with palette quantization, choosing the largest
palette that fits under the limit and writing the chosen palette/count to
`tgs-metadata.json`.

Validate the backend with:

```bash
npm run typecheck
npm run build
npm run smoke:api
```
