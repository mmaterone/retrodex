from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    pipeline_id: str
    background: str
    grid: str | None
    fps: int
    canvas_size: int
    anchor: Literal["center", "bottom", "feet"]
    reject_grid_mismatch: bool
    reject_face_feature_loss: bool


PRESETS = {
    "character.fighter.control-grid.v1": Preset(
        id="character.fighter.control-grid.v1",
        label="Character fighter on real control grid",
        pipeline_id="control-grid-v1",
        background="#ff00ff",
        grid="#00ffff",
        fps=8,
        canvas_size=32,
        anchor="feet",
        reject_grid_mismatch=True,
        reject_face_feature_loss=True,
    ),
    "character.utya.prompt-sheet.v1": Preset(
        id="character.utya.prompt-sheet.v1",
        label="Utya prompt-only action sheet",
        pipeline_id="prompt-only-horizontal-sheet-v1",
        background="#ff00ff",
        grid=None,
        fps=8,
        canvas_size=32,
        anchor="feet",
        reject_grid_mismatch=False,
        reject_face_feature_loss=True,
    ),
}
