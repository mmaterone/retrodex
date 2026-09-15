# Product Contracts

Retrodex uses explicit schemas so the tool itself can guide
agents after context loss.

## `run.json`

Describes one editable production run: identity, canvas, source paths, presets,
active frame order, and status.

Required fields:

- `schemaVersion`
- `id`
- `name`
- `asset`
- `canvas`
- `presetId`
- `paths`
- `status`
- `approval`
- `createdAt`
- `updatedAt`

## Frame Schema

Each frame is a real pixel-art image plus metadata:

- stable id and sequential index
- PNG path
- canvas size
- alpha bbox
- anchor
- palette summary
- source provenance
- QC summary

## Approval Model

`run.json` owns approval state:

- `approval.approvedFrames[]` stores `frameId`, `approvedAt`, `approvedBy`,
  and optional `note`
- `frame.approved` and `frame.approvedAt` are UI compatibility mirrors only
- export reads `run.approval.approvedFrames`, never frame warnings
- an existing `animation-draft.json` must reference only approved frame ids

## Animation Draft Schema

`animation-draft.json` is the editable timeline:

- `framesList` stores timeline order
- `transforms` stores whole-frame or rig-part transforms
- `rigParts` stores masks, bboxes, anchors, parents, and pin state
- `fps` and `canvasSize` control preview/export

## Editor Document Schema

`editor/editor-document.json` is the manual editing source of truth once a run
is opened in the browser editor:

- `frames[]` stores full pixel grids for exact agent inspection/editing
- `masks[]` stores mask layers, anchors, visibility, and parenting
- mask layers can store `semanticRole`, `semanticLabel`, `promptHint`, and
  regeneration policy for targeted animation/imagegen
- `timeline.framesList` stores editable frame order
- `selectedFrameId` and `activeMaskLayerId` store editor context
- `saveState` stores revision and autosave metadata

The backend writes updated frame PNGs from editor pixel grids so cleanup/export
continues to use the existing frame artifact contract.

## Agent Memory Schema

`editor/agent-memory.json` is durable context for agents after compaction:

- `projectBrief` describes the sprite, purpose, and user intent
- `constraints` records hard project rules
- `protectedDetails` names details that require extra care before editing
- `styleGuide` stores palette, outline, shading, and animation rules
- `decisionLog` records user/agent/system decisions with timestamps

Agents should update this whenever a user approval, rejection, or clarification
changes durable behavior.

## Editor Checkpoint Schema

`editor/checkpoints/{checkpointId}.json` stores a full editor document snapshot
with label, reason, source, and timestamp. Backend operations that can make
large changes, such as imagegen apply, should create a checkpoint before
modifying pixels. Revert restores the checkpoint document and can create a
rollback checkpoint for the pre-revert state.

## Editor Operation Log Schema

`editor/operations/{operationId}.json` stores one durable editor write event.
Each entry records:

- `operationType`: `editor-operations`, `edit-intent`, `animation-fix`,
  `imagegen-apply`, `checkpoint-revert`, `operation-revert`, `pixel-write`, or
  `snapshot`
- `beforeRevision` and `afterRevision`
- optional `checkpointId`
- exact pixel `patches` with `frameId`, `x`, `y`, `before`, and `after`
- exact mask `maskPatches` with `layerId`, `x`, `y`, `before`, and `after`
- revert metadata: `revertedAt` and `revertedByOperationId`

Operation revert applies the inverse of those patches only. It does not restore
an entire checkpoint unless `createRollbackCheckpoint` is enabled for safety.

## Editor Operation Schema

`editorOperationsRequest.operations[]` is the shared action surface for web,
backend, and CLI. Agents should use these typed operations instead of inventing
ad hoc pixel maps:

- `set-pixel`, `patch-pixels`, `tool-stroke`
- `bucket-fill`, `gradient-fill`, `shape-pixels`, `transform-pixels`
- `delete-selected-pixels`, `delete-target`
- `patch-mask`, `mask-stroke`, `mask-bucket`, `mask-shape`
- `select-frame`, `reorder-frame`, `upsert-mask-layer`, `delete-mask-layer`

Every write is validated by Zod and then captured in the operation log.
Delete operations can also clear semantic mask layers through
`clearMaskLayerIds`, which keeps pixels and mask overlays synchronized when an
agent deletes a selected rig part or bounded object.

## Checkpoint Comparison Schema

`checkpointComparison` compares two checkpoint documents and reports
`frameDiffs`, `maskDiffs`, changed-pixel totals, and bboxes. Agents should use it
before broad rollback decisions and before/after reports.

## Edit Intent Schema

Edit intents are semantic commands above raw pixel patches. The backend turns an
intent into exact patch coordinates, returns a preview, and creates a checkpoint
before apply.

Supported intents:

- `recolor-target`: recolor a semantic role, mask layer target, or visual feature
- `recolor-mask`: recolor a specific mask layer

Use this for commands like "change the eyes to blue" instead of asking an agent
to hand-write pixel patches from memory.

## Animation Inspection Schema

`animationInspection` is the temporal perception layer for editable animations:

- `frameDiffs` reports changed pixels, motion bbox, and silhouette changes
- `flickerRegions` reports pixels that toggle repeatedly across frames
- `maskMotionTracks` reports per-mask changed pixels and stability
- `loopQualityScore` estimates whether the final frame returns cleanly to the
  first frame
- `diagnostics` flags flicker risk, silhouette breaks, loop breaks, and moving
  masks

Use this before exporting or asking an agent to fix motion.

## Animation Fix Schema

`animationFix` is an undoable deterministic repair result:

- `animationFixPreview` is the dry-run result with exact patches and
  before/estimated-after inspections
- `mode` is one of `fix-flicker`, `repair-loop-pop`, or `smooth-mask-motion`
- `checkpoint` stores the rollback snapshot created before the edit
- `beforeInspection` and `afterInspection` show temporal quality changes
- `appliedPatches` lists exact frame/x/y before/after pixel edits
- `document` is the saved editor document after applying patches

Use preview first after `animationInspection`. If the fix could erase
intentional motion, ask the user before apply.

## Mask Intelligence Schema

`maskIntelligence` is the deterministic mask quality/perception report:

- `diagnostics` flags empty masks, missing semantic roles, outside-alpha pixels,
  missing parents, and overlapping masks
- `suggestions` offers draft masks from alpha bbox and connected components
- `recommendations` explains the next best agent action

Suggestions are deterministic hints. They are not approvals and should be
reviewed before becoming semantic mask layers.

## Targeted Part Reference Schema

Masks can be promoted into agent/imagegen handoff objects:

- `partReferencePackage` stores the exact mask pixels, bbox crop, transparent
  reference PNG path/URL, full preview URL, pixel map URL, semantic role, label,
  and prompt hint
- `partRegenerationDraft` stores the target mask, target frames, prompt,
  reference package, and preservation instructions for "regenerate only this
  part" workflows
- `imagegenRequestArtifact` stores the final model handoff: prompt, negative
  prompt, reference image, full context preview, pixel map URL, target frames,
  and preserve rules
- `imagegenResultArtifact` stores candidates, selected candidate, score/notes,
  diff summary, and applied status
- `imagegenResultInspection` scores each candidate with inside-mask changes,
  outside-mask ignored pixels, palette drift, alpha bbox drift, diagnostics,
  recommendations, and compare preview URLs
- `imagegenApplyPreview` dry-runs one candidate apply and returns exact
  inside-mask patches, ignored outside-mask pixels, before/estimated-after frame
  inspections, and the compare preview URL

These contracts are intentionally explicit so a compacted agent can recover the
right behavior from the tool itself: inspect the semantic mask, create a
reference package, generate or edit only inside the mask, then preserve outside
pixels.

## Visual Inspection Schema

Visual inspection is the agent-facing perception layer:

- `frameVisualInspection` summarizes alpha bbox, palette, preview URL,
  pixel-map URL, zoom hints, and detected features
- features include alpha bbox, likely face/eye details, semantic mask parts, and
  animation motion regions
- `visualSummary` aggregates per-frame inspections and temporal motion so an
  agent can reason about an animation close to how a human sees it

Use this before tiny edits such as "change eye color": inspect the frame, use
the eye/face zoom hints, confirm exact pixels through `pixelMapUrl`, then patch
only those cells.

## Saved Animation / Export Schema

Saved animations are immutable snapshots:

- approval records used for the snapshot
- source run id
- source frame mapping
- frame paths copied into the saved folder
- transparent strip path
- preview path
- GIF path
- WebP, SVG, Lottie JSON, React component, and CSS sprite paths
- manifest, validation, editor diff, and share bundle paths
- export targets
- manifest updates

`manifest.json` is the game/agent-facing artifact map. `validation.json`
records per-file existence checks. `editor-diff.json` reports whether exported
raw frames match the editor document. `share-bundle.zip` packages the saved
animation metadata and generated files for handoff.

## Cleanup Pipeline

Cleanup is represented as typed steps, not ad hoc flags. A run records the
pipeline plan and actual result under `pipeline/`.

Core step categories:

- background removal
- grid or lattice validation
- cell sampling or lattice recovery
- component cleanup
- palette lock
- anchor alignment
- diagnostics
- export assembly

## Deterministic Presets

Presets encode production defaults. Agents should choose a preset by asset type
and action, then write the selected preset id into `run.json`.

Accepted run `asset.type` values are:

- `background`
- `character`
- `fx`
- `icon`
- `projectile`
- `prop`
- `tile`

`icon`, `background`, `prop`, `projectile`, and `item`-style requests use the
single-item control-grid defaults unless a more specific preset is selected.

Source frame ingest defaults to hidden-grid inference. Unless the user supplies
an explicit canvas size, `sourceFrames[].gridStrategy` should stay
`infer-hidden-grid`; this estimates the generated logical pixel grid and
materializes it with nearest-neighbor sampling instead of blind downsampling.

## Vision planner defaults

`VisionToPixelRequest` defaults to contain fitting and nearest-neighbor sampling.
`sampling: smooth` enables Lanczos for continuous-tone references;
`edgeDarkening: true` adds edge contrast before the final quantization.
The output retains source alpha above `alphaThreshold` and uses at most
`maxColors` visible RGB colors. Uncertain background detection preserves pixels
and reports a warning. Applying a plan requires the existing editor canvas size,
checks the revision again after planning, and records a rollback checkpoint.

## Agent drawing operations

The shared `EditorOperation` union also includes:

- `polygon-pixels`: integer `points` (3–256), `color`, `mode` (`fill` by default,
  or `outline`), and inward `thickness` (1–32).
- `mirror-pixels`: in-frame `sourceBounds`, `axis` (`vertical` by default),
  optional integer/half-integer `axisPosition`, and `copyTransparent` (false).
- `paint-mask`: `color` and at least one `targetMaskLayerIds` entry.

All three require `frameId` and support `targetMaskLayerIds` and `respectAlpha`
(false). Explicit target masks form a union; destination writes intersect that
union with pixel selection and exclude locked mask pixels. An explicit empty
pixel selection permits no writes. Pixel selection applies only to its selected
frame. Selection bounds are used only when there is no pixel selection mask.
Locked/target mask and selection geometry must match the frame; missing targets
fail validation instead of falling back to unrestricted painting.

## Generated opaque artwork cleanup

`artwork.imagegen-grid.v1` is for an explicitly declared native canvas enlarged
8x by the generator. Preserve the raw source and run its cleanup before importing
the native result into the editor. The pipeline detects backdrop type for
reporting, sets alpha to opaque by explicit full-bleed artwork policy, samples
cell-interior medians, quantizes to 24 colors using max coverage with refinement,
then scores and writes diagnostics. It does not remove the painted landscape.

`sample-pixel-grid` checks source dimensions against `run.canvas * cellSize`;
nonmatching dimensions fail. Its measurements report how closely the source
matches flat logical cells; the requested grid is not claimed to be inferred.
Already-native run dimensions are preserved on a repeat pass. `set-opaque-alpha`
must only be used for artwork intended to be fully opaque, never transparent
sprites. `quantize-palette` supports `median-cut` and `max-coverage` methods with
an optional refinement count. Keep both initial and refined cleanup artifacts
when choosing a palette by visual review.

### Drawing guide

`EditorDocument.drawingGuide` is optional for compatibility with existing runs.
It contains a persistent visual reference, placement, paired landmarks and
normalized distance measurements; see `schemas/drawing-guide.ts`. Guides do not
modify frame pixels, palette, cleanup or export content. Read derived measurements
at `GET /runs/:id/editor/drawing-guide`, and write with the revision-checked
`set-drawing-guide` editor operation. Coordinates on the reference are normalized
source coordinates, while artwork coordinates use canvas pixels. The UI saves
through the existing document autosave and exposes an explicit retry button.
