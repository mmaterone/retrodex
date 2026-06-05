# Retrodex Agent Contract

This repository is designed so an agent can recover the production rules from
files after context compaction. Do not depend on chat memory.

## Read First

Before generating, cleaning, editing, exporting, or reviewing a character:

1. Read `packages/contracts/src/presets/deterministic-rules.ts`.
2. Read `packages/contracts/src/pipeline/cleanup-steps.ts`.
3. Read `docs/contracts.md`.
4. Read `docs/backend.md` when touching orchestration, workers, or run folders.
5. Read the active run's `run.json` and `animation-draft.json` if present.

## Product Goal

Turn imagegen output into production pixel-art character assets.

The product loop is:

`brief -> asset plan -> generation contract -> raw output -> deterministic cleanup -> QC -> user review -> export`

## Non-Negotiable Rules

- One action family per generation.
- One editable target canvas per generation.
- References are visual context, not editable pasted panels.
- Validate grid or lattice assumptions before cleanup.
- Never treat normal downscaling as production cleanup.
- Store every production decision in typed config, metadata, or presets.
- Preserve user-approved frames and exports with backups.
- Use `frames/` plus `animation-draft.json` as the source of truth for the
  editable timeline.

## Run Folder Contract

Every run must include `run.json`. Production runs should also include:

- `frames/frame_XX.png`
- `animation-draft.json`
- `pipeline/pipeline-run.json`
- `diagnostics/qc-report.json`
- `exports/`
- `saved-animations/`

## Agent Output Rule

When an agent creates work, it must write:

- the exact preset id used
- the cleanup steps used
- retry hints when QC fails
- export metadata when saving a named animation

If a rule seems missing, add it to contracts or presets before relying on it.

## Backend Rule

The TypeScript API owns orchestration and validation. The Python worker owns
deterministic image processing only. Worker output must be validated against
the shared schemas before being written into a run folder.
