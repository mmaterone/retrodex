from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image


def rgba_to_cell(red: int, green: int, blue: int, alpha: int) -> str | None:
    if alpha == 0:
        return None
    if alpha == 255:
        return f"#{red:02x}{green:02x}{blue:02x}"
    return f"#{red:02x}{green:02x}{blue:02x}{alpha:02x}"


def cell_to_rgba(value: str | None) -> tuple[int, int, int, int]:
    if value is None:
        return (0, 0, 0, 0)
    if value.startswith("#") and len(value) in {7, 9}:
        red = int(value[1:3], 16)
        green = int(value[3:5], 16)
        blue = int(value[5:7], 16)
        alpha = int(value[7:9], 16) if len(value) == 9 else 255
        return (red, green, blue, alpha)
    if value.startswith("rgba(") and value.endswith(")"):
        parts = [part.strip() for part in value[5:-1].split(",")]
        red, green, blue = (max(0, min(255, int(parts[index]))) for index in range(3))
        alpha_float = max(0.0, min(1.0, float(parts[3])))
        return (red, green, blue, round(alpha_float * 255))
    raise ValueError(f"Unsupported pixel color: {value}")


def alpha_bbox(image: Image.Image) -> dict[str, int] | None:
    box = image.getchannel("A").getbbox()
    if box is None:
        return None
    left, top, right, bottom = box
    return {"height": bottom - top, "width": right - left, "x": left, "y": top}


def palette(cells: list[str | None], limit: int = 32) -> list[str]:
    counts: dict[str, int] = {}
    for cell in cells:
        if cell is None:
            continue
        key = cell[:7].lower()
        counts[key] = counts.get(key, 0) + 1
    return [
        color
        for color, _ in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:limit]
    ]


def read_png(path: Path) -> dict[str, Any]:
    image = Image.open(path).convert("RGBA")
    cells = [rgba_to_cell(*pixel) for pixel in image.getdata()]
    return {
        "alphaBBox": alpha_bbox(image),
        "grid": {
            "cells": cells,
            "palette": palette(cells),
            "size": {"height": image.height, "width": image.width},
        },
    }


def write_png(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    grid = payload["grid"]
    size = grid["size"]
    cells = grid["cells"]
    width = int(size["width"])
    height = int(size["height"])
    if len(cells) != width * height:
        raise ValueError("Pixel grid length does not match canvas size.")
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image.putdata([cell_to_rgba(cell) for cell in cells])
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    return read_png(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read or write editor pixel grids.")
    parser.add_argument("mode", choices=["read", "write"])
    parser.add_argument("--path", required=True)
    parser.add_argument("--payload")
    args = parser.parse_args()

    path = Path(args.path)
    if args.mode == "read":
        result = read_png(path)
    else:
        if not args.payload:
            raise ValueError("--payload is required for write mode.")
        result = write_png(path, json.loads(Path(args.payload).read_text()))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
