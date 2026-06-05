from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from PIL import Image

from pixel_character_core.backdrop import detect_backdrop, find_alpha_components, remove_backdrop


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.{id(payload)}.tmp")
    temp_path.write_text(json.dumps(payload, indent=2) + "\n")
    temp_path.replace(path)


def split_sheet(payload: dict[str, Any]) -> dict[str, Any]:
    sheet = payload["sheet"]
    image = Image.open(sheet["path"]).convert("RGBA")
    frame_width = int(sheet["frameWidth"])
    frame_height = int(sheet["frameHeight"])
    count = int(sheet.get("count") or image.width // frame_width)
    output_dir = Path(payload["framesDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    frame_ids: list[str] = []

    for index in range(count):
        left = index * frame_width
        if left + frame_width > image.width:
            break
        frame_id = f"frame_{payload['startIndex'] + index + 1:02d}"
        frame = image.crop((left, 0, left + frame_width, frame_height))
        frame.save(output_dir / f"{frame_id}.png")
        frame_ids.append(frame_id)

    return {"frameIds": frame_ids}


def auto_slice_components(payload: dict[str, Any]) -> dict[str, Any]:
    sheet = payload["sheet"]
    image = Image.open(sheet["path"]).convert("RGBA")
    analysis = detect_backdrop(image)
    keyed, cleanup_metrics = remove_backdrop(image, analysis)
    frames = find_alpha_components(
        keyed,
        alpha_threshold=int(sheet.get("alphaThreshold", 32)),
        min_area_frac=float(sheet.get("minAreaFrac", 0.0008)),
        pad=int(sheet.get("pad", 4)),
    )
    output_dir = Path(payload["framesDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    frame_ids: list[str] = []
    manifest_frames: list[dict[str, Any]] = []
    strip_x = 0
    max_height = max((frame.image.height for frame in frames), default=0)
    for index, frame in enumerate(frames):
        frame_id = f"frame_{payload['startIndex'] + index + 1:02d}"
        frame_path = output_dir / f"{frame_id}.png"
        frame.image.save(frame_path)
        frame_ids.append(frame_id)
        manifest_frames.append(
            {
                "fileName": frame_path.name,
                "frameId": frame_id,
                "height": frame.image.height,
                "index": index,
                "sourceX": frame.box["x"],
                "sourceY": frame.box["y"],
                "stripX": strip_x,
                "width": frame.image.width,
            }
        )
        strip_x += frame.image.width

    manifest = {
        "backdrop": cleanup_metrics,
        "frameCount": len(frames),
        "frames": manifest_frames,
        "source": {
            "height": image.height,
            "path": sheet["path"],
            "width": image.width,
        },
        "strip": {
            "fileName": "strip-transparent.png",
            "sheetHeight": max_height,
            "sheetWidth": strip_x,
        },
        "version": 1,
    }
    return {
        "backdrop": cleanup_metrics,
        "frameIds": frame_ids,
        "manifest": manifest,
    }


def crop_to_ratio(image: Image.Image, ratio: float) -> tuple[Image.Image, dict[str, int]]:
    width, height = image.size
    if math.isclose(width / height, ratio, rel_tol=0.002, abs_tol=0.002):
        return image, {"height": height, "width": width, "x": 0, "y": 0}
    if width / height > ratio:
        new_width = round(height * ratio)
        left = max(0, (width - new_width) // 2)
        return (
            image.crop((left, 0, left + new_width, height)),
            {"height": height, "width": new_width, "x": left, "y": 0},
        )
    new_height = round(width / ratio)
    top = max(0, (height - new_height) // 2)
    return (
        image.crop((0, top, width, top + new_height)),
        {"height": new_height, "width": width, "x": 0, "y": top},
    )


def estimate_hidden_grid_size(image: Image.Image, asset_type: str) -> dict[str, Any]:
    width, height = image.size
    if width <= 512 and height <= 512:
        return {
            "confidence": 1.0,
            "reason": "source-already-editor-sized",
            "sourceCellSize": {"height": 1.0, "width": 1.0},
            "size": {"height": height, "width": width},
        }

    ratio = width / height
    if asset_type == "icon":
        candidate_widths = [32, 40, 48, 56, 64, 72, 80, 96, 112, 128, 160]
        max_source_cell = 48
        min_source_cell = 8
        target_cell = 20
        target_logical_width = 64
    else:
        candidate_widths = [
            64,
            96,
            128,
            144,
            160,
            192,
            224,
            240,
            256,
            288,
            320,
            384,
            480,
            512,
        ]
        max_source_cell = 18
        min_source_cell = 2.5
        target_cell = 5.5 if asset_type == "background" else 6.0
        target_logical_width = 320
    best: tuple[float, int, int, float] | None = None
    for candidate_width in candidate_widths:
        candidate_height = max(1, round(candidate_width / ratio))
        source_cell = min(width / candidate_width, height / candidate_height)
        if source_cell < min_source_cell or source_cell > max_source_cell:
            continue
        # Asset profiles matter: background images can keep dense detail, while
        # icons should collapse imagegen's internal block texture into the
        # larger logical icon pixels a user can edit.
        cell_score = 1 / (1 + abs(source_cell - target_cell))
        detail_score = 1 / (1 + abs(candidate_width - target_logical_width) / target_logical_width)
        score = cell_score * 0.72 + detail_score * 0.28
        if best is None or score > best[0]:
            best = (score, candidate_width, candidate_height, source_cell)

    if best is None:
        fallback_width = min(512, max(16, round(width / 4)))
        fallback_height = max(1, round(fallback_width / ratio))
        return {
            "confidence": 0.35,
            "reason": "fallback-source-scale",
            "sourceCellSize": {
                "height": height / fallback_height,
                "width": width / fallback_width,
            },
            "size": {"height": fallback_height, "width": fallback_width},
        }

    score, logical_width, logical_height, source_cell = best
    return {
        "confidence": round(min(0.95, max(0.45, score)), 3),
        "reason": "estimated-hidden-imagegen-grid",
        "sourceCellSize": {
            "height": round(height / logical_height, 3),
            "width": round(width / logical_width, 3),
        },
        "size": {"height": logical_height, "width": logical_width},
    }


def materialize_frame(payload: dict[str, Any]) -> dict[str, Any]:
    source = Path(payload["sourcePath"])
    output = Path(payload["outputPath"])
    strategy = payload.get("gridStrategy", "infer-hidden-grid")
    asset_type = payload.get("assetType", "prop")
    requested_canvas = payload.get("canvas")

    image = Image.open(source).convert("RGBA")
    original_size = {"height": image.height, "width": image.width}
    ratio = (
        requested_canvas["width"] / requested_canvas["height"]
        if strategy == "resize-to-run-canvas" and requested_canvas
        else image.width / image.height
    )
    cropped, crop_box = crop_to_ratio(image, ratio)

    if strategy == "preserve-source":
        target_size = {"height": cropped.height, "width": cropped.width}
        inference = {
            "confidence": 1.0,
            "reason": "preserve-source",
            "sourceCellSize": {"height": 1.0, "width": 1.0},
            "size": target_size,
        }
    elif strategy == "resize-to-run-canvas" and requested_canvas:
        target_size = {
            "height": int(requested_canvas["height"]),
            "width": int(requested_canvas["width"]),
        }
        inference = {
            "confidence": 1.0,
            "reason": "explicit-run-canvas",
            "sourceCellSize": {
                "height": cropped.height / target_size["height"],
                "width": cropped.width / target_size["width"],
            },
            "size": target_size,
        }
    else:
        inference = estimate_hidden_grid_size(cropped, asset_type)
        target_size = inference["size"]

    materialized = cropped.resize(
        (int(target_size["width"]), int(target_size["height"])),
        Image.Resampling.NEAREST,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    materialized.save(output)
    return {
        "cropBox": crop_box,
        "gridInference": inference,
        "originalSize": original_size,
        "outputPath": str(output),
        "strategy": strategy,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest pixel-art frame inputs.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.loads(Path(args.input).read_text())
    if payload.get("mode") == "materialize-frame":
        result = materialize_frame(payload)
    elif payload.get("mode") == "auto-slice-components":
        result = auto_slice_components(payload)
    else:
        result = split_sheet(payload)
    write_json_atomic(Path(args.output), result)


if __name__ == "__main__":
    main()
