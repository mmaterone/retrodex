# Retrodex

Use Codex as an agent-powered pixel art editor.

<video
  src="./docs/assets/retrodex-codex-morph.webm"
  autoplay
  loop
  muted
  playsinline
  controls
  width="100%"
></video>

[Watch the Retrodex morph demo](./docs/assets/retrodex-codex-morph.webm)

Retrodex is a local desktop run engine, browser editor, and agent CLI for
creating, cleaning, inspecting, editing, animating, and exporting pixel art with
Codex in the loop. The goal is simple: Codex can generate or modify sprites like
an assistant, while the user can open the exact same run in a canvas editor and
finish the work by hand.

Retrodex keeps the deterministic Python image-processing core, but moves the
product shell into TypeScript: shared contracts, a local API, persistent run
storage, a React editor, and a CLI surface that lets Codex do the same actions a
human can do in the editor.

## What It Does

- Generate/import pixel art sources into local run folders.
- Run deterministic cleanup pipelines before editor handoff.
- Infer hidden pixel grids instead of blindly downsampling generated art.
- Detect backdrop types before background removal or matte cleanup.
- Open approved sprites and animations in a dark Procreate/Rive-style editor.
- Edit pixels with brush, eraser, fill, gradient, shapes, selections, transform,
  masks, timeline frames, references, and export controls.
- Let Codex inspect exact pixel maps, visual summaries, masks, selections,
  animation motion, and operation history.
- Export frames and animations as PNG/GIF/WebP/WebM/SVG/Lottie/TGS/React/CSS
  and saved animation metadata.

## Product Flow

Retrodex is designed for this Codex workflow:

1. The user asks Codex for pixel art.
2. Codex clarifies intent when the asset type, canvas, transparency, or
   animation scope is ambiguous.
3. Codex creates a Retrodex run and imports the generated/source image.
4. Cleanup runs through a typed deterministic pipeline.
5. Codex inspects the cleaned result and asks the user whether to approve/open
   it in the editor.
6. On approval, the run opens in the browser editor.
7. The user edits manually; Codex can also apply API/CLI pixel operations.
8. The final state is exported locally or as a saved run snapshot.

Imagegen output is treated as raw source. Even if a generated image already
looks like pixel art, Retrodex should run cleanup before opening it in the
editor or exporting it.

## Editor

The web editor is a canvas-first pixel art workspace:

- brush, eraser, picker, bucket fill, pixel gradients, and shape tools;
- transform and selection tools with box, ellipse, lasso, polygon, and magic
  wand selection modes;
- selection-constrained draw/erase/fill/gradient/transform/delete;
- mask mode for semantic rig parts, anchors, parenting, and targeted
  regeneration references;
- frame timeline with fps controls, play/pause, drag reorder, duplicate, delete,
  and export inclusion toggles;
- local reference window with zoom, color picking, and palette extraction;
- browser-side export fallback for quick manual downloads.

Run-linked editor documents autosave into `runs/{runId}/editor/`.

## Agent CLI

The CLI is the agent-facing way to work with Retrodex. It talks to the local API
and returns JSON.

```bash
npm --workspace @retrodex/cli run dev -- runs list
npm --workspace @retrodex/cli run dev -- editor status <runId>
npm --workspace @retrodex/cli run dev -- pixels map <runId> <frameId>
npm --workspace @retrodex/cli run dev -- tools brush <runId> <frameId> --x 12 --y 20 --color "#ffffff"
npm --workspace @retrodex/cli run dev -- exports preview <runId> --json '{"formats":["svg"],"scope":"frame"}'
```

Codex should prefer CLI/API edits over browser clicking. Before editing, it
should read the editor document, selected frame, selection state, masks, and
pixel map. Mutations support `--expected-revision` so user edits and agent edits
do not silently overwrite each other.

## Local API

Default API URL:

```txt
http://127.0.0.1:5175
```

Key endpoint groups:

- runs: create, list, inspect, add frames;
- cleanup jobs: persistent local queue with recovery;
- editor: import approved frames, read/write documents, selection, operations,
  pixel grids, visual inspection, memory, masks, checkpoints;
- exports: create jobs, list snapshots, fetch artifacts;
- OpenAPI: `/openapi.json`.

Run storage defaults to:

```txt
./runs
```

Override it with:

```bash
RUNS_DIR=/path/to/runs npm run dev:api
```

## Cleanup And Presets

Cleanup is described as typed pipeline steps in
`packages/contracts/src/pipeline/cleanup-steps.ts`.

Current step vocabulary includes:

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

Deterministic presets live in
`packages/contracts/src/presets/deterministic-rules.ts`.

Examples:

- `character.fighter.control-grid.v1`
- `character.utya.prompt-sheet.v1`
- `item.control-grid.v1`
- `fx.sheet.v1`

These contracts are intentionally agent-facing: if Codex forgets the rules after
context compaction, it can read the tool contracts and recover the intended
workflow.

## Repository Layout

```txt
apps/
  api/        Local TypeScript API and run/job orchestration
  cli/        JSON CLI for Codex and scripts
  web/        React pixel editor

packages/
  contracts/  Shared Zod schemas, OpenAPI-aligned contracts, cleanup presets

python/
  pixel_character_core/  Deterministic image cleanup and ingest core

docs/
  agent-playbook.md      Codex workflow and behavior rules
  backend.md             API, storage, jobs, editor, export contracts
  contracts.md           Schema and contract overview
```

## Quick Start

Install dependencies:

```bash
npm install
```

Start API and web editor:

```bash
npm run dev
```

Or start them separately:

```bash
npm run dev:api
npm run dev:web
```

Web editor:

```txt
http://127.0.0.1:5174
```

API:

```txt
http://127.0.0.1:5175
```

Open a specific run:

```txt
http://127.0.0.1:5174/?runId=<runId>&frameId=<frameId>
```

## Checks

```bash
npm run typecheck
npm run build
npm --workspace @retrodex/api run test
npm --workspace @retrodex/cli run test
npm --workspace @retrodex/web run test
npm run test:py
```

Linting:

```bash
npm run lint:ts
npm run lint:py
```

Note: the current TypeScript lint pass may still report known web formatting and
refactor debt while typecheck, build, and tests pass.

## Codex Skill

The repo includes a local Codex skill:

```txt
.codex/skills/retrodex-editor/SKILL.md
```

It tells Codex how to use Retrodex:

- always read before editing;
- prefer API/CLI operations over browser automation;
- run cleanup after generation;
- ask the user before opening cleaned output in the editor;
- use revision guards;
- verify by re-reading pixels and inspections.

## Status

Retrodex is an active local-first prototype. It is already useful for Codex-led
pixel art experiments, editor handoff, manual cleanup, and export testing. The
next hardening work is mostly around UI refactor debt, lint cleanup, more golden
cleanup fixtures, and deeper end-to-end generation runs.
