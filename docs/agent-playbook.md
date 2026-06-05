# Agent Playbook

Retrodex should feel like a native Codex tool. The backend is
the source of truth for runs, the browser editor is the user's manual canvas,
and the CLI/API are the agent's hands.

Default local API: `http://127.0.0.1:5175`

## Golden Flow

1. Clarify intent with Codex's UI `askuser` prompt when asset type, canvas,
   animation scope, background transparency, or open-in-editor behavior is
   ambiguous.
2. Create or load a run with source frames or a horizontal sheet.
3. Start cleanup and poll the persistent job until it finishes.
4. Inspect cleaned output with `inspect frame` or `inspect animation`.
5. Show the user the cleaned result and ask through `askuser` whether to approve
   and open it in the browser editor.
6. On approval, call `frames approve`, then `editor import-approved`.
7. Open the URL from `editor open` or `GET /runs/:id/editor/url` in Codex's
   in-app browser.
8. Let the user refine manually while the web editor autosaves into the run.
9. For agent edits, use CLI/API editor operations against the same run.
10. Export only after the editor document is synced and approved frame order is
   clear.

Never rely on chat memory as project state. Read run contracts, editor
document, visual inspection, mask intelligence, operation log, and project
memory from the tool.

Before any agent-side editor mutation, read:

- `editor status <runId>` for active run, frame, revision, dirty/saved state,
  canvas, timeline, and mask counts.
- `editor show <runId>` for frames, masks, anchors, parenting, and timeline.
- `selection show <runId>` for selected pixels, selected mask layers, active
  mask layer, and transform target.
- `pixels map <runId> <frameId>` or `inspect frame <runId> <frameId>` for exact
  pixel data and human-oriented visual context.

Use `--expected-revision` on editor mutations whenever supported. If the API
returns `editor-revision-conflict` or HTTP `409`, do not replay the stale
operation. Re-read status/document/selection/pixels, recompute the edit, and
retry with the new revision.

## Askuser Gates

Use Codex's UI clarification prompt (`askuser` / `request_user_input`) when the
answer changes what Retrodex should generate, clean, or open:

- choosing between `character`, `icon`, `background`, `fx`, `prop`, or `tile`;
- choosing a final canvas size or aspect ratio;
- choosing single frame vs animation;
- choosing transparent sprite vs full background scene;
- asking whether the cleaned result should be opened in the browser editor;
- approving a generated/cleaned result before it becomes editor input.

Keep the question short and concrete. Do not interrupt for routine deterministic
reads, previews, or diagnostics.

## Generation Cleanup Gate

Every imagegen output is raw source, even if it visually looks like pixel art.
Before opening it in the editor or exporting it, Codex must run it through the
Retrodex run lifecycle:

1. Create a run with the right `asset.type`, action, sheet mode, and source
   frame/sheet.
2. Let the preset auto-selector choose from the contracts or pass an explicit
   `presetId` when context demands it.
3. Start cleanup, poll the persistent job, and inspect diagnostics.
4. Show the cleaned result to the user and ask whether to approve/open it.

Cleanup selection guide:

- Characters and creatures: use `character.fighter.control-grid.v1` when the
  generated image follows the control-grid contract. Use
  `character.utya.prompt-sheet.v1` for prompt-only horizontal animation sheets.
- Icons, props, items, projectiles, and single-subject backgrounds: use
  `item.control-grid.v1` unless a more specific contract is added.
- FX sheets: use `fx.sheet.v1`.
- Large backgrounds/scenes: create a `background` run and prefer
  `gridStrategy: "infer-hidden-grid"` unless the user explicitly provided the
  final canvas size.

Let the pipeline's `detect-backdrop` step classify magenta, green,
checkerboard, solid, transparent, or none before choosing background removal or
matte cleanup. Do not blindly downsample, preserve source, or force run canvas
unless the user or source contract explicitly requires it.

## Run And Editor Handoff

Use the run lifecycle as the product boundary:

- `runs create` or `POST /runs`
- `frames add` or `POST /runs/:id/frames`
- `cleanup start` or `POST /runs/:id/cleanup`
- `cleanup status` or `GET /jobs/:jobId`
- `frames approve` or `POST /runs/:id/frames/:frameId/approve`
- `editor import-approved` or `POST /runs/:id/editor/import-approved`
- `editor open` or `GET /runs/:id/editor/url`

The editor URL uses `?runId=...&frameId=...`. In run-linked mode, the browser
loads `editor/editor-document.json` from the API and autosaves debounced
snapshots with `PUT /runs/:id/editor`. Blank local canvases are only a fallback;
agent workflows should prefer run-linked mode.

When importing an imagegen or reference-derived pixel-art PNG, do not choose a
canvas size by eye. If the user did not explicitly provide a grid/canvas size,
send the source through `sourceFrames` with the default
`gridStrategy: "infer-hidden-grid"` and let the backend estimate the hidden
logical pixel grid. Use `resize-to-run-canvas` only for an explicit user-given
size, and use `preserve-source` only when the source is already the desired
editor canvas.

Before picking a cleanup strategy, let the pipeline classify the backdrop.
The default prompt-only cleanup starts with `detect-backdrop` and distinguishes
magenta, green, checkerboard, solid, transparent, and none. Use the detector's
metrics to decide whether background removal, matte cleanup, or preserve-source
is appropriate; do not choose hidden-grid/preserve-source/matte-clean by memory.

For generated sheets or atlases with unknown frame dimensions, use
`auto-slice-components` instead of blind grid slicing. It removes the detected
backdrop, finds alpha connected components, extracts padded frames, and records
their original source boxes for later export manifests.

Approval source of truth is `run.approval.approvedFrames`. Frame-local
`approved` fields are UI mirrors. If cleanup reruns, approval must be requested
again.

## Seeing The Sprite

For any visual request, combine human-level inspection with exact pixels:

- `inspect frame <runId> <frameId>` for preview URL, zoom hints, palette,
  alpha bbox, and feature candidates.
- `inspect animation <runId>` for frame diffs, flicker regions, mask motion,
  silhouette warnings, and loop score.
- `pixels map <runId> <frameId>` for canvas size, full RGBA/null grid, palette
  summary, alpha bbox, and preview artifact.
- `pixels get <runId> <frameId> --x ... --y ...` for exact cells.

Never infer exact coordinates from a preview alone. Use previews to understand
the picture and pixel maps to make edits.

For tiny edits such as "change eye color":

1. Read `memory show`.
2. Read `inspect frame`.
3. Use feature candidates and `zoomHints` to find likely detail zones.
4. Read `pixels map` or `pixels get` for exact RGBA/null values.
5. Prefer `edit preview` or `edit recolor` before manual pixel patches.
6. Apply only if the preview targets the correct pixels.
7. Re-inspect and summarize changed coordinates or bbox.

## Agent Canvas Actions

When a user asks for something they could do in the editor, use the same typed
operation surface instead of writing a full editor snapshot.

Common CLI commands:

- Status: `editor status <runId>`
- Selection: `selection show <runId>` / `selection set <runId> --json '{...}'`
- Brush: `tools brush <runId> <frameId> --x ... --y ... --color "#rrggbb"`
- Erase: `tools eraser <runId> <frameId> --x ... --y ...`
- Bucket: `tools bucket <runId> <frameId> --x ... --y ... --color "#rrggbb"`
- Gradient: `tools gradient <runId> <frameId> --x1 ... --y1 ... --x2 ... --y2 ...`
- Shape: `tools shape <runId> <frameId> --shape rectangle --mode fill ...`
- Transform: `tools transform <runId> <frameId> --json '{...}'`
- Delete selection: `tools delete-selection <runId> <frameId> --masks mask_1`
- Delete object/bounds: `tools delete-target <runId> <frameId> --x ... --y ... --width ... --height ...`

Use `--clear-masks mask_1,mask_2` when deletion should remove both pixels and
the semantic mask overlay. This matches the editor's "delete selected/object"
behavior for masked parts.

Backend API equivalent:

- `GET /runs/:id/editor/status`
- `GET /runs/:id/editor/selection`
- `PUT /runs/:id/editor/selection`
- `PATCH /runs/:id/editor/operations`
- `GET /runs/:id/editor/frames/:frameId/pixels`
- `PUT /runs/:id/editor/frames/:frameId/pixels`

Supported typed operations include raw pixels, brush/erase strokes, bucket
fills, pixel gradients, shape pixels, transforms, mask strokes, mask fills,
mask shapes, frame selection, timeline reorder, mask upsert/delete,
`delete-selected-pixels`, and `delete-target`.

After any manual-style edit, run `operations list`. The entry should contain
exact `patches` and, for masks, `maskPatches`. If the edit is wrong, revert the
exact operation instead of restoring a whole checkpoint.

## Selection And Delete Rules

Selection constrains edits. Brush, erase, fill, gradient, shapes, transforms,
and deletes should respect the selected mask or selected pixel region unless
the user explicitly asks for a global edit.

Use `delete-selection` when the target is already expressed as a mask or
selection mask. Use `delete-target` when the target is a known bbox/object
region. If deleting a rig part, include `--clear-masks` so the mask does not
remain as a stale overlay.

Do not delete pixels outside a mask/selection to "clean up" unless the user
asked for that broader change.

## Masks And Rig Parts

Masks are semantic rig parts, not decoration. They drive animation, reference
crops, targeted regeneration, protected details, anchors, parenting, and
agent-visible object identity.

Before targeted animation or regeneration:

1. Run `masks validate`.
2. Ensure the target mask has `semanticRole`, `semanticLabel`, and `promptHint`.
3. If no suitable mask exists, run `masks suggest` and ask for review before
   promoting a suggestion.
4. Use `masks anchor` and `masks parent` when the part needs rig behavior.
5. Use `references create` for imagegen/reference handoff.

Mask commands:

- `masks list/create/update/delete`
- `masks paint/fill/shape`
- `masks anchor/parent`
- `masks label`
- `masks inspect/suggest/validate`

Mask quality diagnostics matter. Empty masks, masks outside visible alpha,
missing semantic labels, accidental overlaps, and broken parent hierarchy
should be fixed before using masks for imagegen or animation.

## Targeted Imagegen

For requests like "regenerate only hair" or "animate only the weapon":

1. Validate the target mask.
2. Create a reference package with `references create`.
3. Create a regeneration draft with `regenerate part`.
4. Create model handoff with `imagegen request`.
5. Record generated candidates with `imagegen result`.
6. Inspect candidates with `imagegen inspect`.
7. Compare promising candidates with `imagegen compare`.
8. Dry-run apply with `imagegen apply-preview`.
9. Ask the user before applying meaningful generated changes.
10. Apply with `imagegen apply`.

The apply step is deterministic: candidate pixels outside the target mask are
ignored. Palette lock and preserve rules should be explicit in the request
artifact. Imagegen apply creates an automatic checkpoint before writing.

## Semantic Edit Intents

Prefer edit intents when the user describes a high-level change:

- `edit preview <runId> --json '{ "intent": "recolor-target", ... }'`
- `edit apply <runId> --json '{ "intent": "recolor-target", ... }'`
- `edit recolor <runId> --target eyes --color "#4aa3ff"`

Intent preview must return exact pixel patches before apply. If the target is
ambiguous or confidence is low, ask the user or create a mask first.

## Undo, Revert, And Checkpoints

Backend and CLI writes are undoable through the operation log. Use exact
operation revert for surgical recovery:

1. Run `operations list <runId>`.
2. Inspect the target entry's `patches` and `maskPatches`.
3. Run `operations revert <runId> <operationId>`.
4. Verify the original entry has `revertedAt` and the new entry is
   `operation-revert`.

Use checkpoints for broad or risky edits:

1. Run `checkpoints create <runId>`.
2. Apply the risky edit.
3. Inspect the result.
4. If needed, run `checkpoints compare <runId> <left> <right>`.
5. Revert with `checkpoints revert <runId> <checkpointId>`.

Create checkpoints before broad pixel operations, generated candidate applies,
multi-frame transforms, and animation repairs. Use the rollback checkpoint
created during revert if the revert itself must be undone.

## Animation Work

Before exporting multi-frame work, run `animation inspect`:

1. Review `frameDiffs` for large jumps.
2. Review `maskMotionTracks` to confirm rig parts move intentionally.
3. Check `flickerRegions` for tiny pixels toggling repeatedly.
4. Check silhouette warnings.
5. Check `loopQualityScore`.
6. Preview fixes before applying them.

Commands:

- `animation inspect`
- `animation preview`
- `animation fix-flicker`
- `animation repair-loop-pop`
- `animation smooth-mask-motion`

Animation preview commands do not write files. Apply commands create automatic
checkpoints and return exact `appliedPatches`. Ask the user before repairing
broad motion that may be stylistic.

## Durable Project Memory

Use `memory save` when a rule should survive context compaction:

- user approvals or rejections
- protected details like eyes, logos, weapons, outline, or face features
- palette, shading, and outline rules
- animation constraints
- model/regeneration decisions
- "do not touch outside this mask" instructions

Read `memory show` before targeted edits. Do not rely on chat history for
durable project rules.

## Export Rules

Exports are immutable snapshots. Export only approved frame order and synced
editor state.

There are two export surfaces:

- Backend snapshot: canonical for run-linked projects. It saves the editor
  document, queues `POST /runs/:id/exports`, and produces a saved animation
  bundle with manifest, validation, editor diff, artifacts, and share bundle.
- Local browser download: quick fallback for blank canvases or one-off manual
  downloads. It does not write run metadata and must not be treated as the
  product export source of truth.

Use:

- `exports preview <runId> --expected-revision <revision> --json '{"formats":["svg","lottie"],"scope":"animation"}'`
- `exports create <runId>`
- `exports list <runId>`
- `exports show <runId> <exportId>`
- `exports artifact <runId> <exportId> <filePath>`

Use `exports preview` before final export when Codex needs to inspect raw SVG,
Lottie, React, CSS, or saved-animation JSON without writing a snapshot.

Supported export targets include raw frames, game strip, texturepacker,
aseprite, godot, WebP, SVG, TGS, Lottie JSON, React, and CSS.

Use `tgs` when the user needs a Telegram-style gzipped Lottie. The backend
enforces a sub-64,000-byte output by quantizing the TGS vector export palette and
records the chosen palette in `tgs-metadata.json`.

After export, inspect:

- `validation.json` for per-file checks
- `manifest.json` for game-engine artifact map
- `editor-diff.json` to confirm exported raw frames match editor state
- `share-bundle.zip` for portable handoff

The web export dialog may still provide browser-side downloads as a fast
fallback, but backend exports are the source of truth for product runs.

## Ask The User When

Ask before:

- accepting cleaned frames into the editor
- applying generated candidates
- deleting broad regions or multiple masks
- changing protected details
- repairing animation motion that may be intentional
- promoting auto-suggested masks into semantic rig parts

Do not ask for routine deterministic reads, previews, inspections, operation
log checks, or narrow CLI edits that exactly match the user's instruction.
