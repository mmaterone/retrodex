# Tooling Notes

Current setup decisions were checked against upstream docs on 2026-06-04.

- Ultracite supports Oxlint + Oxfmt and can be initialized with
  `npx ultracite init --quiet --linter oxlint --pm npm --frameworks react`.
- shadcn/ui supports Vite projects and recommends `shadcn@latest init -t vite`
  for new Vite scaffolds.
- Motion for React installs as `motion` and imports React APIs from
  `motion/react`.
- Fancy Components uses the shadcn registry pattern. This repo registers
  `@fancy` in `apps/web/components.json`.
- Sprite Lab (`boona13/sprite-lab`, MIT, 2026 Sprite Lab contributors)
  informed the backdrop detection, edge matte cleanup, connected-component
  slicing, and padded frame manifest behavior. The Retrodex implementation is
  a Python/Pillow adaptation integrated into the deterministic cleanup worker.
- `codex-draw` (`simonmesmith/agent-skills`) informed the Retrodex
  API-first agent workflow: always read the scene before mutation, guard writes
  with revisions, expose selection state through API, prefer raw export preview
  before final save, and keep a local `.codex/skills/retrodex-editor` playbook
  so Codex can recover the workflow after context compaction.
