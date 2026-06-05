from __future__ import annotations

from pixel_character_core.contracts.models import CleanupStep

CONTROL_GRID_PIPELINE = [
    CleanupStep(id="detect-backdrop"),
    CleanupStep(
        id="validate-control-grid",
        blocking=True,
        params={
            "min_visible_line_ratio": 0.45,
            "max_partial_cell_ratio": 0.28,
            "max_gutter_foreground_ratio": 0.1,
        },
    ),
    CleanupStep(
        id="sample-control-grid",
        blocking=True,
        params={"sample_mode": "median", "sample_margin_ratio": 0.4},
    ),
    CleanupStep(id="remove-service-colors"),
    CleanupStep(id="remove-small-components", params={"min_size": 4}),
    CleanupStep(id="protect-face-details"),
    CleanupStep(id="lock-palette", params={"source": "approved-keyframe"}),
    CleanupStep(id="align-anchor", params={"mode": "feet"}),
    CleanupStep(id="score-frame", params={"preset": "fighter"}),
    CleanupStep(id="write-diagnostics"),
]

PROMPT_ONLY_SHEET_PIPELINE = [
    CleanupStep(id="detect-backdrop"),
    CleanupStep(
        id="remove-background",
        blocking=True,
        params={"autoDetect": True, "mode": "auto"},
    ),
    CleanupStep(
        id="recover-lattice",
        blocking=True,
        params={"grouping": "horizontal-content-runs", "merge_fragments_px": 38},
    ),
    CleanupStep(id="lock-palette", params={"source": "approved-keyframe"}),
    CleanupStep(id="align-anchor", params={"mode": "feet", "bottom_pad": 2}),
    CleanupStep(id="score-frame", params={"preset": "fighter"}),
    CleanupStep(id="write-diagnostics"),
]
