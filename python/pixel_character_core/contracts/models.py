from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

SCHEMA_VERSION = "2026-06-04.v1"


@dataclass(frozen=True)
class CanvasSize:
    width: int
    height: int


@dataclass(frozen=True)
class BBox:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class Anchor:
    mode: Literal["center", "bottom", "feet", "custom"]
    x: float
    y: float


@dataclass(frozen=True)
class QcSummary:
    passes: bool
    blocking_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    retry_hints: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Frame:
    id: str
    index: int
    name: str
    path: str
    canvas: CanvasSize
    alpha_bbox: BBox | None
    anchor: Anchor
    palette: list[str]
    source_kind: str
    qc: QcSummary
    schema_version: str = SCHEMA_VERSION


@dataclass(frozen=True)
class CleanupStep:
    id: str
    enabled: bool = True
    blocking: bool = False
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Run:
    id: str
    name: str
    asset_type: str
    action: str
    preset_id: str
    status: str
    root: str
    canvas: CanvasSize
    active_frame_ids: list[str]
    qc: QcSummary
    schema_version: str = SCHEMA_VERSION


@dataclass(frozen=True)
class RigPart:
    id: str
    name: str
    color: str
    mask_path: str | None
    bbox: BBox | None
    anchor: Anchor
    parent_id: str | None = None
    pinned: bool = False


@dataclass(frozen=True)
class AnimationDraft:
    run_id: str
    fps: int
    canvas_size: CanvasSize
    frames_list: list[str]
    transforms: dict[str, dict[str, Any]]
    rig_parts: list[RigPart]
    schema_version: str = SCHEMA_VERSION


@dataclass(frozen=True)
class SavedAnimation:
    id: str
    run_id: str
    name: str
    slug: str
    fps: int
    canvas: CanvasSize
    frame_paths: list[str]
    files: dict[str, str]
    schema_version: str = SCHEMA_VERSION
