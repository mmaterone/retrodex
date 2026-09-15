from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter, ImageOps

from .editor_pixels import alpha_bbox, palette, rgba_to_cell
from .backdrop import detect_backdrop, remove_backdrop


def _fit_image(image: Image.Image, width: int, height: int, crop_mode: str, sampling: str = "nearest") -> Image.Image:
    method = Image.Resampling.NEAREST if sampling == "nearest" else Image.Resampling.LANCZOS
    if crop_mode == "contain":
        fitted = ImageOps.contain(image, (width, height), method=method)
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        canvas.alpha_composite(
            fitted,
            ((width - fitted.width) // 2, (height - fitted.height) // 2),
        )
        return canvas
    return ImageOps.fit(image, (width, height), method=method, centering=(0.5, 0.42))


def _quantize(image: Image.Image, max_colors: int, method: Image.Quantize = Image.Quantize.MEDIANCUT, kmeans: int = 0) -> Image.Image:
    # Learn colors only from visible pixels; transparent RGB must not spend
    # the palette budget or influence the foreground colors.
    visible = [pixel[:3] for pixel in image.getdata() if pixel[3] > 0]
    if not visible:
        return Image.new("RGBA", image.size, (0, 0, 0, 0))
    samples = Image.new("RGB", (len(visible), 1))
    samples.putdata(visible)
    reduced = samples.quantize(colors=max_colors, method=method, kmeans=kmeans,
                               dither=Image.Dither.NONE).convert("RGB")
    colors = iter(reduced.getdata())
    result = Image.new("RGBA", image.size)
    result.putdata([(*next(colors), pixel[3]) if pixel[3] else (0, 0, 0, 0)
                    for pixel in image.getdata()])
    return result


def _edge_overlay(base: Image.Image, source: Image.Image) -> Image.Image:
    gray = ImageOps.grayscale(source.convert("RGB"))
    edges = gray.filter(ImageFilter.FIND_EDGES)
    result = base.copy()
    pixels = result.load()
    edge_pixels = edges.load()
    for y in range(result.height):
        for x in range(result.width):
            if edge_pixels[x, y] > 80:
                red, green, blue, alpha = pixels[x, y]
                if alpha:
                    pixels[x, y] = (
                        max(0, int(red * 0.55)),
                        max(0, int(green * 0.55)),
                        max(0, int(blue * 0.55)),
                        alpha,
                    )
    return result


def _cell_luma(cell: str | None) -> float:
    if not cell:
        return 255
    red = int(cell[1:3], 16)
    green = int(cell[3:5], 16)
    blue = int(cell[5:7], 16)
    return red * 0.2126 + green * 0.7152 + blue * 0.0722


def _rgb(cell: str | None) -> tuple[int, int, int] | None:
    if not cell:
        return None
    return (int(cell[1:3], 16), int(cell[3:5], 16), int(cell[5:7], 16))


def _bbox(points: list[dict[str, int]]) -> dict[str, int] | None:
    if not points:
        return None
    xs = [point["x"] for point in points]
    ys = [point["y"] for point in points]
    return {
        "height": max(ys) - min(ys) + 1,
        "width": max(xs) - min(xs) + 1,
        "x": min(xs),
        "y": min(ys),
    }


def _sample(points: list[dict[str, int]], limit: int = 48) -> list[dict[str, int]]:
    if len(points) <= limit:
        return points
    step = max(1, len(points) // limit)
    return points[::step][:limit]


def _is_skin(cell: str | None) -> bool:
    rgb = _rgb(cell)
    if not rgb:
        return False
    red, green, blue = rgb
    return red > 115 and green > 70 and blue > 55 and red > blue * 1.12 and green > blue * 0.82


def _is_dark(cell: str | None) -> bool:
    return bool(cell and _cell_luma(cell) < 68)


def _is_gray_highlight(cell: str | None) -> bool:
    rgb = _rgb(cell)
    if not rgb:
        return False
    red, green, blue = rgb
    return abs(red - green) < 18 and abs(green - blue) < 18 and 130 < red < 230


def _is_blueish_eye(cell: str | None) -> bool:
    rgb = _rgb(cell)
    if not rgb:
        return False
    red, green, blue = rgb
    return blue > red * 1.12 and blue >= green * 0.85 and 45 < blue < 180


def _feature(
    *,
    confidence: float,
    description: str,
    feature_id: str,
    kind: str,
    points: list[dict[str, int]],
) -> dict[str, Any]:
    return {
        "bbox": _bbox(points),
        "confidence": max(0.0, min(1.0, confidence)),
        "description": description,
        "id": feature_id,
        "kind": kind,
        "pixels": _sample(points),
    }


def _features(cells: list[str | None], width: int, height: int) -> list[dict[str, Any]]:
    visible = [
        {"x": x, "y": y}
        for y in range(height)
        for x in range(width)
        if cells[y * width + x] is not None
    ]
    skin = [
        {"x": x, "y": y}
        for y in range(height)
        for x in range(width)
        if _is_skin(cells[y * width + x])
    ]
    dark = [
        {"x": x, "y": y}
        for y in range(height)
        for x in range(width)
        if _is_dark(cells[y * width + x])
    ]
    upper_dark = [point for point in dark if point["y"] < int(height * 0.42)]
    lower_warm_dark = [
        {"x": x, "y": y}
        for y in range(int(height * 0.55), height)
        for x in range(width)
        if _is_dark(cells[y * width + x]) or _is_skin(cells[y * width + x])
    ]
    eye_region = [
        {"x": x, "y": y}
        for y in range(int(height * 0.34), int(height * 0.58))
        for x in range(int(width * 0.18), int(width * 0.82))
        if _is_blueish_eye(cells[y * width + x]) or _cell_luma(cells[y * width + x]) < 45
    ]
    glasses = [
        {"x": x, "y": y}
        for y in range(int(height * 0.34), int(height * 0.6))
        for x in range(int(width * 0.1), int(width * 0.9))
        if _is_gray_highlight(cells[y * width + x])
    ]
    color_counts = Counter(cell[:7].lower() for cell in cells if cell)
    palette_clusters = []
    for index, (color, count) in enumerate(color_counts.most_common(6), start=1):
        points = [
            {"x": x, "y": y}
            for y in range(height)
            for x in range(width)
            if (cells[y * width + x] or "")[:7].lower() == color
        ]
        palette_clusters.append(
            _feature(
                confidence=min(1, count / max(1, len(visible))),
                description=f"Palette cluster {color} with {count} pixels.",
                feature_id=f"palette-{index}",
                kind="palette-cluster",
                points=points,
            )
        )
    return [
        _feature(
            confidence=1 if visible else 0,
            description="Visible sprite silhouette.",
            feature_id="silhouette",
            kind="silhouette",
            points=visible,
        ),
        _feature(
            confidence=min(1, len(skin) / max(1, len(visible)) * 2.8),
            description="Likely face/skin region from warm tones.",
            feature_id="face",
            kind="face-candidate",
            points=skin,
        ),
        _feature(
            confidence=min(1, len(upper_dark) / max(1, len(visible)) * 4),
            description="Likely hair or hood shadow region from upper dark pixels.",
            feature_id="hair-hood",
            kind="hood-candidate",
            points=upper_dark,
        ),
        _feature(
            confidence=min(1, len(eye_region) / max(1, width)),
            description="Likely eye/glasses detail region.",
            feature_id="eyes",
            kind="eye-candidate",
            points=eye_region,
        ),
        _feature(
            confidence=min(1, len(glasses) / max(1, width) * 0.6),
            description="Likely glasses rim/highlight pixels.",
            feature_id="glasses",
            kind="glasses-candidate",
            points=glasses,
        ),
        _feature(
            confidence=min(1, len(lower_warm_dark) / max(1, len(visible)) * 1.2),
            description="Likely beard/lower-face region.",
            feature_id="beard",
            kind="beard-candidate",
            points=lower_warm_dark,
        ),
        *palette_clusters,
    ]


def plan_image(payload: dict[str, Any]) -> dict[str, Any]:
    source_path = Path(payload["sourcePath"]).expanduser().resolve()
    width = int(payload.get("canvas", {}).get("width", 64))
    height = int(payload.get("canvas", {}).get("height", 64))
    max_colors = int(payload.get("maxColors", 18))
    alpha_threshold = int(payload.get("alphaThreshold", 8))
    crop_mode = payload.get("cropMode", "contain")
    preserve_background = bool(payload.get("preserveBackground", False))

    with Image.open(source_path) as opened:
        source = ImageOps.exif_transpose(opened).convert("RGBA")
    diagnostics = []
    if not preserve_background and source.getchannel("A").getextrema()[0] == 255:
        backdrop = detect_backdrop(source)
        if backdrop.kind not in {"none", "transparent"} and backdrop.confidence >= 0.65:
            source, _ = remove_backdrop(source, backdrop)
            diagnostics.append({"code": "backdrop-removed", "severity": "info",
                                "message": f"Removed detected {backdrop.kind} backdrop before sampling."})
        else:
            diagnostics.append({"code": "background-preserved-uncertain", "severity": "warning",
                                "message": "Backdrop is uncertain; preserved the source instead of cropping a guessed subject mask."})
    fitted = _fit_image(source, width, height, crop_mode, payload.get("sampling", "nearest"))
    fitted.putalpha(fitted.getchannel("A").point(lambda value: 0 if value <= alpha_threshold else value))
    if payload.get("edgeDarkening", False):
        fitted = _edge_overlay(fitted, fitted)
    # Quantize last so optional outline processing cannot exceed maxColors.
    image = _quantize(fitted, max_colors)
    data = []
    raw_pixels = image.tobytes()
    for offset in range(0, len(raw_pixels), 4):
        red, green, blue, alpha = raw_pixels[offset : offset + 4]
        if alpha <= alpha_threshold:
            data.append(None)
        else:
            data.append(rgba_to_cell(red, green, blue, alpha))
    result_image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    result_image.putdata(
        [
            (0, 0, 0, 0)
            if cell is None
            else (
                int(cell[1:3], 16),
                int(cell[3:5], 16),
                int(cell[5:7], 16),
                int(cell[7:9], 16) if len(cell) == 9 else 255,
            )
            for cell in data
        ]
    )
    visible_count = sum(1 for cell in data if cell)
    diagnostics.append({
        "code": "deterministic-pixel-planner",
        "message": "Alpha-preserving sampling and visible-color quantization; semantic features are heuristic candidates.",
        "severity": "info",
    })
    if visible_count < width * height * 0.12:
        diagnostics.append(
            {
                "code": "low-visible-pixels",
                "message": "The generated grid has few visible pixels; try preserveBackground=true or contain crop.",
                "severity": "warning",
            }
        )
    return {
        "alphaBBox": alpha_bbox(result_image),
        "canvas": {"height": height, "width": width},
        "diagnostics": diagnostics,
        "features": _features(data, width, height),
        "grid": {
            "cells": data,
            "palette": palette(data),
            "size": {"height": height, "width": width},
        },
        "humanSummary": f"Deterministic {width}x{height} pixel plan with {visible_count} visible cells and {len(palette(data))} palette colors.",
        "palette": palette(data),
        "recommendations": [
            "Use feature bboxes as candidate mask seeds.",
            "For likeness edits, inspect eyes/glasses and beard candidates before applying pixel patches.",
            "Ask user approval before replacing an existing hand-edited frame.",
        ],
        "sourcePath": str(source_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan a pixel grid from a reference image.")
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    payload = json.loads(Path(args.payload).read_text())
    print(json.dumps(plan_image(payload)))


if __name__ == "__main__":
    main()
