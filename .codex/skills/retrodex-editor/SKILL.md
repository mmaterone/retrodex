---
name: "retrodex-editor"
description: "Use when the user asks Codex to create, inspect, edit, mask, animate, clean up, regenerate, or export pixel art through Retrodex. Enforces API/CLI-first editor work: read the run/editor/pixels/selection before edits, mutate via Retrodex operations with expected revisions, verify by re-reading, and use the browser only for visual review or manual user work."
---

# Retrodex Editor

Retrodex is the local pixel-art editor/run engine. Treat it as the source of truth for pixel art work instead of editing files from memory or trying to click the browser like a user.

Default services:

- API: `http://127.0.0.1:5175`
- Web editor: `http://127.0.0.1:5174`
- CLI: `npm --workspace @retrodex/cli run dev -- --api http://127.0.0.1:5175 ...`

## API-First Rule

Prefer Retrodex API/CLI mutations over browser-click automation.

Use the browser for:

- opening the editor for the user;
- visual verification after API/CLI edits;
- manual user editing.

Do not use browser automation as the primary way to paint pixels, reorder frames, change masks, or export.

## User Intent Clarification

Use Codex's UI `askuser` / `request_user_input` prompt when the user's intent
is underspecified and the choice changes the artifact, cleanup, or export:

- asset type: `character`, `icon`, `background`, `fx`, `prop`, `tile`;
- intended canvas or aspect ratio;
- single frame vs animation;
- transparent sprite vs scene/background;
- whether to open the editor after cleanup.

Ask the smallest useful question. Do not ask for routine deterministic reads,
inspections, or safe previews.

## Imagegen Requires Cleanup

Treat every imagegen result as raw source, even if it already looks like good
pixel art. Before opening it in the editor or exporting it:

1. create/import a Retrodex run;
2. choose asset/action so the preset is explicit or auto-selected from
   contracts;
3. run cleanup and poll the job until it finishes;
4. inspect cleanup diagnostics and preview;
5. ask the user whether to approve/open the cleaned result.

Use this cleanup matrix:

- `character` / idle, walk, run, attack, hurt, cast:
  `character.fighter.control-grid.v1` when a control grid exists, otherwise
  `character.utya.prompt-sheet.v1` for prompt-only sheets or animation strips.
- `icon`, `prop`, `item`, `projectile`, `background` single subject:
  `item.control-grid.v1`; use `gridStrategy: "infer-hidden-grid"` unless the
  user explicitly gave the final canvas size.
- `fx`, impact, slash, projectile, burst sheets: `fx.sheet.v1`.
- large scene/background where imagegen already implies a hidden pixel grid:
  still import through Retrodex and prefer hidden-grid inference over blind
  downsampling.

Always let `detect-backdrop` classify magenta/green/checkerboard/solid/
transparent/none before choosing background removal or matte cleanup. Never
silently choose `preserve-source`, `resize-to-run-canvas`, or matte cleanup from
memory.

After cleanup, use the Codex UI `askuser` prompt:

- show/describe the cleaned preview and relevant diagnostics;
- ask whether to open in the Retrodex browser editor;
- on approval, call frame approval, import approved frames into editor, then
  open the editor URL.

## Always Read Before Editing

Before any agent edit, read the current workspace state:

1. `editor status <runId>` for linked run, active frame, revision, dirty/saved state.
2. `editor show <runId>` for frames, timeline, masks, anchors, parenting, and style context.
3. `selection show <runId>` for selected frame/pixels/masks/transform target.
4. `pixels map <runId> <frameId>` or `inspect target ...` for exact pixels and visual summaries.

Never assume the current frame, mask, selection, or revision from memory.

## Revision Discipline

Every mutation that supports it must include `--expected-revision <revision>` from the latest `editor status` or `editor show`.

If the API returns `editor-revision-conflict` or HTTP `409`:

1. Stop the stale mutation.
2. Re-read status, document, selection, and relevant pixels.
3. Recompute the operation against the new state.
4. Retry only with the new revision.

Do not blindly replay stale pixel operations.

## Selection Contract

Use selection endpoints when acting like the user:

- `GET /runs/:id/editor/selection`
- `PUT /runs/:id/editor/selection`

Selection state includes:

- selected frame;
- selected pixel mask/bounds;
- selected mask layers;
- active mask layer;
- transform target.

Use selection-aware operations for delete, transform, brush, erase, fill, gradient, and masked regeneration. Do not edit pixels outside the active selection or protected mask unless the user asked for it.

## Visible Staged Mutations

For creative tasks, work in visible stages:

1. create/import a rough sprite or animation;
2. open it in the editor;
3. add masks/anchors/parenting where useful;
4. show the user;
5. apply focused edits or regeneration;
6. verify and export.

Avoid one silent batch of hundreds of operations unless the task is purely mechanical and easy to verify.

## Export Preview Before Save

Use raw export preview for agent inspection before final output:

```bash
npm --workspace @retrodex/cli run dev -- \
  --api http://127.0.0.1:5175 \
  exports preview <runId> \
  --expected-revision <revision> \
  --json '{"formats":["svg","lottie","css"],"scope":"animation","scale":1}'
```

Use final export only after preview size/format/content is acceptable.

## Object Order APIs

Prefer targeted order operations:

- timeline reorder/select/add/duplicate;
- mask layer reorder/parent/anchor;
- selection set/delete/transform.

Do not rewrite the whole editor document just to move one frame or mask layer.

## Validation Block

Minimal smoke workflow:

```bash
npm run dev:api
npm run dev:web
npm --workspace @retrodex/cli run dev -- runs list
npm --workspace @retrodex/cli run dev -- editor status <runId>
npm --workspace @retrodex/cli run dev -- selection show <runId>
npm --workspace @retrodex/cli run dev -- pixels map <runId> <frameId>
npm --workspace @retrodex/cli run dev -- tools brush <runId> <frameId> --x 0 --y 0 --color '#ffffff' --expected-revision <revision>
npm --workspace @retrodex/cli run dev -- exports preview <runId> --expected-revision <revision> --json '{"formats":["svg"],"scope":"frame"}'
```
