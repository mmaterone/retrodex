from __future__ import annotations

import argparse
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from pixel_character_core.backdrop import detect_backdrop as analyze_backdrop
from pixel_character_core.backdrop import remove_backdrop

SCHEMA_VERSION = "2026-06-04.v1"
SERVICE_COLORS = {
    (0, 255, 255),
    (255, 0, 255),
}
GRID_COLOR = (0, 255, 255)


@dataclass(frozen=True)
class WorkerJob:
    diagnostics_path: Path
    frame_id: str
    input_path: Path
    job_id: str
    output_path: Path
    palette_lock: list[str]
    pipeline: dict[str, Any]
    run: dict[str, Any]


@dataclass
class CleanupContext:
    job: WorkerJob
    image: Image.Image
    warnings: list[str]
    metrics: dict[str, Any]
    blocking_issues: list[str]
    protected_pixels: set[tuple[int, int]]
    retry_hints: list[str]


StepHandler = Callable[[CleanupContext, dict[str, Any]], None]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run deterministic pixel cleanup for one frame.")
    parser.add_argument("--input", required=True, help="Worker request JSON path.")
    parser.add_argument("--output", required=True, help="Worker result JSON path.")
    return parser.parse_args()


def read_job(path: Path) -> WorkerJob:
    payload = json.loads(path.read_text())
    return WorkerJob(
        diagnostics_path=Path(payload["diagnosticsPath"]),
        frame_id=payload["frameId"],
        input_path=Path(payload["inputPath"]),
        job_id=payload.get("jobId", "unknown"),
        output_path=Path(payload["outputPath"]),
        palette_lock=payload.get("paletteLock", []),
        pipeline=payload["pipeline"],
        run=payload["run"],
    )


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.{id(payload)}.tmp")
    temp_path.write_text(json.dumps(payload, indent=2) + "\n")
    temp_path.replace(path)


def alpha_bbox(image: Image.Image) -> dict[str, int] | None:
    alpha = image.getchannel("A")
    box = alpha.getbbox()
    if box is None:
        return None
    left, top, right, bottom = box
    return {
        "height": bottom - top,
        "width": right - left,
        "x": left,
        "y": top,
    }


def palette_colors(image: Image.Image, limit: int = 32) -> list[str]:
    counts: dict[tuple[int, int, int], int] = {}
    rgba = image.convert("RGBA")
    pixels = (
        rgba.get_flattened_data()
        if hasattr(rgba, "get_flattened_data")
        else rgba.getdata()
    )
    for red, green, blue, alpha in pixels:
        if not alpha:
            continue
        key = (red, green, blue)
        if key in SERVICE_COLORS:
            continue
        counts[key] = counts.get(key, 0) + 1

    sorted_colors = sorted(counts.items(), key=lambda item: item[1], reverse=True)
    return [f"#{red:02x}{green:02x}{blue:02x}" for (red, green, blue), _ in sorted_colors[:limit]]


def parse_rgb(value: str) -> tuple[int, int, int]:
    return tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))


def nearest_color(
    color: tuple[int, int, int], palette: list[tuple[int, int, int]]
) -> tuple[int, int, int]:
    return min(
        palette,
        key=lambda item: (color[0] - item[0]) ** 2
        + (color[1] - item[1]) ** 2
        + (color[2] - item[2]) ** 2,
    )


def luminance(red: int, green: int, blue: int) -> float:
    return red * 0.2126 + green * 0.7152 + blue * 0.0722


def anchor_for(run: dict[str, Any], box: dict[str, int] | None) -> dict[str, float | str]:
    canvas = run["canvas"]
    preset_id = run["presetId"]
    mode = "center"
    if "character" in preset_id or "utya" in preset_id:
        mode = "feet"

    if box is None:
        return {
            "mode": mode,
            "x": canvas["width"] / 2,
            "y": canvas["height"],
        }

    if mode == "feet":
        return {
            "mode": mode,
            "x": box["x"] + box["width"] / 2,
            "y": box["y"] + box["height"],
        }

    return {
        "mode": mode,
        "x": box["x"] + box["width"] / 2,
        "y": box["y"] + box["height"] / 2,
    }


def frame_qc(
    image: Image.Image,
    box: dict[str, int] | None,
    colors: list[str],
    context: CleanupContext,
) -> dict[str, Any]:
    blocking_issues = list(context.blocking_issues)
    warnings = list(context.warnings)
    retry_hints = list(context.retry_hints)

    if box is None:
        blocking_issues.append("Frame has no visible foreground pixels.")
        retry_hints.append("Regenerate or import a frame with a visible subject.")

    if not colors:
        blocking_issues.append("Frame palette is empty after cleanup.")
        retry_hints.append("Avoid service colors as subject colors.")

    if len(colors) > 24:
        warnings.append("Palette has more than 24 visible colors.")
        retry_hints.append("Use stricter palette lock or reduce noisy antialiasing.")

    width, height = image.size
    if width != height:
        warnings.append("Frame canvas is not square.")

    return {
        "blockingIssues": blocking_issues,
        "passes": not blocking_issues,
        "retryHints": retry_hints,
        "warnings": warnings,
    }


def warn_noop(step_id: str) -> StepHandler:
    def handler(context: CleanupContext, params: dict[str, Any]) -> None:
        context.warnings.append(f"{step_id} is not fully implemented yet; deterministic no-op used.")
        context.metrics[f"{step_id}.params"] = params

    return handler


def fit_to_canvas(image: Image.Image, canvas: dict[str, int]) -> Image.Image:
    target_width = int(canvas["width"])
    target_height = int(canvas["height"])
    fitted = Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0))
    source = image
    if source.width > target_width or source.height > target_height:
        source = source.crop((0, 0, min(source.width, target_width), min(source.height, target_height)))
    x = max(0, (target_width - source.width) // 2)
    y = max(0, target_height - source.height)
    fitted.alpha_composite(source, (x, y))
    return fitted


def validate_control_grid(context: CleanupContext, params: dict[str, Any]) -> None:
    rgba = context.image.convert("RGBA")
    pixels = rgba.load()
    grid_pixels = 0
    visible_pixels = 0
    gutter_foreground_pixels = 0

    for y in range(rgba.height):
        for x in range(rgba.width):
            red, green, blue, alpha = pixels[x, y]
            if not alpha:
                continue
            visible_pixels += 1
            is_grid = (red, green, blue) == GRID_COLOR
            if is_grid:
                grid_pixels += 1
            elif x in {0, rgba.width - 1} or y in {0, rgba.height - 1}:
                gutter_foreground_pixels += 1

    visible_ratio = grid_pixels / max(1, visible_pixels)
    gutter_ratio = gutter_foreground_pixels / max(1, visible_pixels)
    context.metrics["gridVisibleLineRatio"] = round(visible_ratio, 4)
    context.metrics["gutterForegroundRatio"] = round(gutter_ratio, 4)

    min_visible = float(params.get("minVisibleLineRatio", 0))
    max_gutter = float(params.get("maxGutterForegroundRatio", 1))
    if grid_pixels and visible_ratio < min_visible:
        context.warnings.append("Control grid is visible but below configured coverage ratio.")
    if gutter_ratio > max_gutter:
        context.warnings.append("Foreground touches outer gutter more than expected.")


def sample_control_grid(context: CleanupContext, params: dict[str, Any]) -> None:
    context.metrics["sampleMode"] = params.get("sampleMode", "median")
    context.metrics["sampleMarginRatio"] = params.get("sampleMarginRatio", 0.4)


def remove_service_colors(context: CleanupContext, _params: dict[str, Any]) -> None:
    rgba = context.image.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    removed = 0

    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if alpha and (red, green, blue) in SERVICE_COLORS:
                pixels[x, y] = (red, green, blue, 0)
                removed += 1

    context.image = rgba
    context.metrics["removedServicePixels"] = removed


def remove_background(context: CleanupContext, params: dict[str, Any]) -> None:
    mode = params.get("mode", "auto")
    if mode == "auto" or params.get("autoDetect", True):
        analysis = analyze_backdrop(context.image)
        context.image, metrics = remove_backdrop(context.image, analysis)
        context.metrics.update(metrics)
        if analysis.kind == "none":
            context.warnings.append(
                "Backdrop detector found no confident backdrop; used conservative border matte."
            )
        return

    chroma_key = params.get("chromaKey", "#ff00ff")
    tolerance = int(params.get("tolerance", 0))
    target = tuple(int(chroma_key[index : index + 2], 16) for index in (1, 3, 5))
    rgba = context.image.convert("RGBA")
    pixels = rgba.load()
    removed = 0
    for y in range(rgba.height):
        for x in range(rgba.width):
            red, green, blue, alpha = pixels[x, y]
            if not alpha:
                continue
            distance = abs(red - target[0]) + abs(green - target[1]) + abs(blue - target[2])
            if distance <= tolerance:
                pixels[x, y] = (red, green, blue, 0)
                removed += 1
    context.image = rgba
    context.metrics["removedBackgroundPixels"] = removed


def detect_backdrop(context: CleanupContext, _params: dict[str, Any]) -> None:
    analysis = analyze_backdrop(context.image)
    context.metrics["backdropConfidence"] = analysis.confidence
    context.metrics["backdropKind"] = analysis.kind
    context.metrics["backdropLabel"] = analysis.label
    if analysis.kind == "none":
        context.warnings.append(
            "No clear backdrop was detected; cleanup will use conservative border removal."
        )


def protect_face_details(context: CleanupContext, params: dict[str, Any]) -> None:
    box = alpha_bbox(context.image)
    if box is None:
        context.metrics["protectedFaceDetailPixels"] = 0
        return

    max_detail_size = int(params.get("maxDetailSize", 8))
    contrast_threshold = float(params.get("contrastThreshold", 42))
    region_top_ratio = float(params.get("regionTopRatio", 0.62))
    top = box["y"]
    bottom = box["y"] + max(1, round(box["height"] * region_top_ratio))
    left = box["x"]
    right = box["x"] + box["width"]
    rgba = context.image.convert("RGBA")
    pixels = rgba.load()
    region_luminance: list[float] = []
    for y in range(top, min(bottom, rgba.height)):
        for x in range(left, min(right, rgba.width)):
            red, green, blue, alpha = pixels[x, y]
            if alpha and (red, green, blue) not in SERVICE_COLORS:
                region_luminance.append(luminance(red, green, blue))

    if not region_luminance:
        context.metrics["protectedFaceDetailPixels"] = 0
        return

    baseline = sum(region_luminance) / len(region_luminance)
    visited: set[tuple[int, int]] = set()
    protected = 0

    for y in range(top, min(bottom, rgba.height)):
        for x in range(left, min(right, rgba.width)):
            if (x, y) in visited:
                continue
            red, green, blue, alpha = pixels[x, y]
            if not alpha or abs(luminance(red, green, blue) - baseline) < contrast_threshold:
                continue

            stack = [(x, y)]
            component: list[tuple[int, int]] = []
            visited.add((x, y))
            while stack:
                current_x, current_y = stack.pop()
                component.append((current_x, current_y))
                for next_x, next_y in (
                    (current_x - 1, current_y),
                    (current_x + 1, current_y),
                    (current_x, current_y - 1),
                    (current_x, current_y + 1),
                ):
                    if (
                        next_x < left
                        or next_y < top
                        or next_x >= right
                        or next_y >= bottom
                        or (next_x, next_y) in visited
                    ):
                        continue
                    next_red, next_green, next_blue, next_alpha = pixels[next_x, next_y]
                    if not next_alpha:
                        continue
                    next_luma = luminance(next_red, next_green, next_blue)
                    if abs(next_luma - baseline) < contrast_threshold:
                        continue
                    visited.add((next_x, next_y))
                    stack.append((next_x, next_y))

            if len(component) <= max_detail_size:
                context.protected_pixels.update(component)
                protected += len(component)

    context.metrics["faceDetailBaselineLuminance"] = round(baseline, 3)
    context.metrics["protectedFaceDetailPixels"] = protected
    if protected == 0 and "character" in context.job.run.get("presetId", ""):
        context.warnings.append("No small high-contrast face details were detected for protection.")


def recover_lattice(context: CleanupContext, params: dict[str, Any]) -> None:
    box = alpha_bbox(context.image)
    if box is None:
        context.blocking_issues.append("Cannot recover lattice from an empty frame.")
        context.retry_hints.append("Regenerate a sheet with visible foreground content.")
        return

    merge_px = int(params.get("mergeFragmentsPx", 0))
    left = max(0, box["x"] - min(merge_px, box["x"]))
    top = max(0, box["y"] - min(merge_px, box["y"]))
    right = min(context.image.width, box["x"] + box["width"] + merge_px)
    bottom = min(context.image.height, box["y"] + box["height"] + merge_px)
    cropped = context.image.crop((left, top, right, bottom))
    context.image = fit_to_canvas(cropped, context.job.run["canvas"])
    context.metrics["recoveredLatticeBox"] = {
        "height": bottom - top,
        "width": right - left,
        "x": left,
        "y": top,
    }


def remove_small_components(context: CleanupContext, params: dict[str, Any]) -> None:
    min_size = int(params.get("minSize", 4))
    rgba = context.image.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    visited: set[tuple[int, int]] = set()
    removed = 0

    for y in range(height):
        for x in range(width):
            if (x, y) in visited or pixels[x, y][3] == 0:
                continue
            stack = [(x, y)]
            component: list[tuple[int, int]] = []
            visited.add((x, y))
            while stack:
                current_x, current_y = stack.pop()
                component.append((current_x, current_y))
                for next_x, next_y in (
                    (current_x - 1, current_y),
                    (current_x + 1, current_y),
                    (current_x, current_y - 1),
                    (current_x, current_y + 1),
                ):
                    if (
                        next_x < 0
                        or next_y < 0
                        or next_x >= width
                        or next_y >= height
                        or (next_x, next_y) in visited
                        or pixels[next_x, next_y][3] == 0
                    ):
                        continue
                    visited.add((next_x, next_y))
                    stack.append((next_x, next_y))
            if len(component) < min_size:
                if any(point in context.protected_pixels for point in component):
                    continue
                for point_x, point_y in component:
                    red, green, blue, _alpha = pixels[point_x, point_y]
                    pixels[point_x, point_y] = (red, green, blue, 0)
                removed += len(component)

    context.image = rgba
    context.metrics["removedSmallComponentPixels"] = removed


def lock_palette(context: CleanupContext, params: dict[str, Any]) -> None:
    source = params.get("source", "approved-keyframe")
    colors = context.job.palette_lock or palette_colors(context.image, limit=16)
    if not colors:
        context.warnings.append("Palette lock skipped because no palette colors were available.")
        return
    if not context.job.palette_lock:
        context.warnings.append("Palette lock used current frame palette because no approved keyframe palette exists.")

    palette = [parse_rgb(color) for color in colors]
    rgba = context.image.convert("RGBA")
    pixels = rgba.load()
    changed = 0
    for y in range(rgba.height):
        for x in range(rgba.width):
            red, green, blue, alpha = pixels[x, y]
            if not alpha:
                continue
            locked = nearest_color((red, green, blue), palette)
            if locked != (red, green, blue):
                changed += 1
                pixels[x, y] = (*locked, alpha)

    context.image = rgba
    context.metrics["paletteLockColors"] = colors
    context.metrics["paletteLockedPixels"] = changed
    context.metrics["paletteLockSource"] = source


def align_anchor(context: CleanupContext, params: dict[str, Any]) -> None:
    context.metrics["anchorMode"] = params.get("mode", "feet")
    context.metrics["anchorBottomPad"] = params.get("bottomPad", 0)


def score_frame(context: CleanupContext, _params: dict[str, Any]) -> None:
    box = alpha_bbox(context.image)
    colors = palette_colors(context.image)
    context.metrics["alphaBBox"] = box
    context.metrics["paletteSize"] = len(colors)


def write_diagnostics(context: CleanupContext, _params: dict[str, Any]) -> None:
    context.metrics["diagnosticsWritten"] = True


STEP_REGISTRY: dict[str, StepHandler] = {
    "align-anchor": align_anchor,
    "detect-backdrop": detect_backdrop,
    "lock-palette": lock_palette,
    "protect-face-details": protect_face_details,
    "recover-lattice": recover_lattice,
    "remove-background": remove_background,
    "remove-service-colors": remove_service_colors,
    "remove-small-components": remove_small_components,
    "sample-control-grid": sample_control_grid,
    "score-frame": score_frame,
    "validate-control-grid": validate_control_grid,
    "write-diagnostics": write_diagnostics,
}


def execute_steps(job: WorkerJob, context: CleanupContext) -> list[dict[str, Any]]:
    traces: list[dict[str, Any]] = []
    for step in job.pipeline["steps"]:
        if not step.get("enabled", True):
            continue
        step_id = step["id"]
        started = time.perf_counter()
        warnings_before = len(context.warnings)
        handler = STEP_REGISTRY.get(step_id)
        status = "succeeded"
        if handler is None:
            status = "failed"
            context.blocking_issues.append(f"Unknown cleanup step: {step_id}")
            context.retry_hints.append("Update Python step registry before retrying.")
        else:
            handler(context, step.get("params", {}))
        traces.append(
            {
                "elapsedMs": round((time.perf_counter() - started) * 1000, 3),
                "inputPath": str(job.input_path),
                "metrics": context.metrics.copy(),
                "outputPath": str(job.output_path),
                "params": step.get("params", {}),
                "status": status,
                "stepId": step_id,
                "warnings": context.warnings[warnings_before:],
            }
        )
    return traces


def run_cleanup(job: WorkerJob) -> dict[str, Any]:
    image = Image.open(job.input_path).convert("RGBA")
    context = CleanupContext(
        blocking_issues=[],
        image=image,
        job=job,
        metrics={},
        protected_pixels=set(),
        retry_hints=[],
        warnings=[],
    )
    traces = execute_steps(job, context)
    context.image.save(job.output_path)

    box = alpha_bbox(context.image)
    colors = palette_colors(context.image)
    qc = frame_qc(context.image, box, colors, context)
    frame = {
        "alphaBBox": box,
        "anchor": anchor_for(job.run, box),
        "approved": False,
        "approvedAt": None,
        "canvas": {
            "height": context.image.height,
            "width": context.image.width,
        },
        "id": job.frame_id,
        "index": int(job.frame_id.rsplit("_", 1)[-1]) - 1,
        "name": job.frame_id.replace("_", " ").title(),
        "palette": {
            "colors": colors,
            "lockedTo": job.run.get("palettePath"),
        },
        "path": str(job.output_path),
        "qc": qc,
        "schemaVersion": SCHEMA_VERSION,
        "source": {
            "cleanupRunId": job.run["id"],
            "inputPath": str(job.input_path),
            "jobId": job.job_id,
            "kind": "cleanup-output",
        },
    }
    diagnostics = {
        "frameId": job.frame_id,
        "inputPath": str(job.input_path),
        "jobId": job.job_id,
        "outputPath": str(job.output_path),
        "paletteSize": len(colors),
        "pipelineId": job.pipeline["id"],
        "qc": qc,
        "steps": traces,
    }

    write_json_atomic(job.diagnostics_path, diagnostics)
    return {
        "diagnosticsPath": str(job.diagnostics_path),
        "frame": frame,
    }


def main() -> None:
    args = parse_args()
    job = read_job(Path(args.input))
    result = run_cleanup(job)
    write_json_atomic(Path(args.output), result)


if __name__ == "__main__":
    main()
