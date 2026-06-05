from __future__ import annotations

import argparse
import base64
import gzip
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image

TGS_MAX_BYTES = 64_000
TGS_PALETTE_CANDIDATES = (64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2)


def write_json_atomic(path: Path, payload: dict[str, Any], *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.{id(payload)}.tmp")
    if compact:
        temp_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    else:
        temp_path.write_text(json.dumps(payload, indent=2) + "\n")
    temp_path.replace(path)


def load_frames(payload: dict[str, Any]) -> list[Image.Image]:
    frames = []
    for frame in payload["frames"]:
        frames.append(Image.open(frame["savedPath"]).convert("RGBA"))
    return frames


def make_strip(frames: list[Image.Image]) -> Image.Image:
    width = sum(frame.width for frame in frames)
    height = max(frame.height for frame in frames)
    strip = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    x = 0
    for frame in frames:
        strip.alpha_composite(frame, (x, 0))
        x += frame.width
    return strip


def make_export_manifest(payload: dict[str, Any], frames: list[Image.Image]) -> dict[str, Any]:
    strip_x = 0
    entries = []
    for index, (frame_payload, image) in enumerate(zip(payload["frames"], frames, strict=False)):
        entries.append(
            {
                "anchor": frame_payload.get("anchor"),
                "approved": frame_payload.get("approved", False),
                "fileName": Path(frame_payload["savedPath"]).name,
                "frameId": frame_payload.get("id", f"frame_{index + 1:02d}"),
                "height": image.height,
                "index": index,
                "logicalCanvas": frame_payload.get("canvas", payload.get("canvas")),
                "sourcePath": frame_payload.get("source", {}).get("inputPath"),
                "stripX": strip_x,
                "width": image.width,
            }
        )
        strip_x += image.width
    return {
        "exportId": payload.get("exportId"),
        "fps": int(payload["fps"]),
        "frameCount": len(frames),
        "frames": entries,
        "loop": True,
        "name": payload["name"],
        "schemaVersion": "2026-06-06.retrodex-export-manifest.v1",
        "strip": {
            "fileName": "strip-transparent.png",
            "sheetHeight": max((frame.height for frame in frames), default=0),
            "sheetWidth": strip_x,
        },
    }


def make_contact_sheet(frames: list[Image.Image]) -> Image.Image:
    padding = 4
    width = sum(frame.width + padding for frame in frames) + padding
    height = max(frame.height for frame in frames) + padding * 2
    sheet = Image.new("RGBA", (width, height), (245, 245, 245, 255))
    x = padding
    for frame in frames:
        sheet.alpha_composite(frame, (x, padding))
        x += frame.width + padding
    return sheet


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "pixel-animation"


def image_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def make_svg(payload: dict[str, Any], frame_paths: list[Path], frames: list[Image.Image]) -> str:
    fps = int(payload["fps"])
    duration = len(frames) / fps
    width = frames[0].width
    height = frames[0].height
    images = []
    for index, frame_path in enumerate(frame_paths):
        begin = index / fps
        images.append(
            "\n".join(
                [
                    f'<image width="{width}" height="{height}" href="{image_data_url(frame_path)}" opacity="0" style="image-rendering:pixelated">',
                    f'  <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.001;0.999;1" begin="{begin:.6f}s" dur="{1 / fps:.6f}s" repeatCount="indefinite" />',
                    "</image>",
                ]
            )
        )
    return "\n".join(
        [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" shape-rendering="crispEdges">',
            f"<title>{payload['name']}</title>",
            f'<desc>{len(frames)} frame pixel animation, {fps} fps, {duration:.3f}s loop.</desc>',
            *images,
            "</svg>",
        ]
    )


def color_to_lottie_fill(color: tuple[int, int, int, int]) -> dict[str, Any]:
    red, green, blue, alpha = color
    return {
        "color": [round(red / 255, 4), round(green / 255, 4), round(blue / 255, 4)],
        "opacity": round(alpha / 255 * 100, 4),
    }


def make_rect_runs(frame: Image.Image) -> list[dict[str, Any]]:
    width, height = frame.size
    pixels = frame.load()
    visited: set[tuple[int, int]] = set()
    runs: list[dict[str, Any]] = []
    for y in range(height):
        for x in range(width):
            if (x, y) in visited:
                continue
            color = pixels[x, y]
            if color[3] == 0:
                continue
            run_width = 1
            while x + run_width < width:
                candidate = (x + run_width, y)
                if candidate in visited or pixels[candidate] != color:
                    break
                run_width += 1

            run_height = 1
            can_grow = True
            while y + run_height < height and can_grow:
                for offset in range(run_width):
                    candidate = (x + offset, y + run_height)
                    if candidate in visited or pixels[candidate] != color:
                        can_grow = False
                        break
                if can_grow:
                    run_height += 1

            for row in range(run_height):
                for column in range(run_width):
                    visited.add((x + column, y + row))

            fill = color_to_lottie_fill(color)
            runs.append(
                {
                    "color": fill["color"],
                    "height": run_height,
                    "opacity": fill["opacity"],
                    "width": run_width,
                    "x": x,
                    "y": y,
                }
            )
    return runs


def group_rect_runs_by_fill(runs: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        key = f"{run['color']}:{run['opacity']}"
        groups.setdefault(key, []).append(run)
    return list(groups.values())


def make_vector_lottie(
    payload: dict[str, Any], frame_paths: list[Path], frames: list[Image.Image]
) -> dict[str, Any]:
    fps = int(payload["fps"])
    width = frames[0].width
    height = frames[0].height
    layers = []
    for index, frame in enumerate(frames):
        layers.append(
            {
                "ddd": 0,
                "ind": index + 1,
                "ip": index,
                "ks": {
                    "a": {"k": [0, 0, 0]},
                    "o": {"k": 100},
                    "p": {"k": [0, 0, 0]},
                    "r": {"k": 0},
                    "s": {"k": [100, 100, 100]},
                },
                "nm": f"Frame {index + 1}",
                "op": index + 1,
                "shapes": [
                    {
                        "it": [
                            *[
                                {
                                    "p": {
                                        "k": [
                                            run["x"] + run["width"] / 2,
                                            run["y"] + run["height"] / 2,
                                        ]
                                    },
                                    "r": {"k": 0},
                                    "s": {"k": [run["width"], run["height"]]},
                                    "ty": "rc",
                                }
                                for run in color_runs
                            ],
                            {
                                "c": {"k": color_runs[0]["color"]},
                                "o": {"k": color_runs[0]["opacity"]},
                                "ty": "fl",
                            },
                            {"p": {"k": [0, 0]}, "ty": "tr"},
                        ],
                        "nm": f"color-{index + 1}-{color_index + 1}",
                        "ty": "gr",
                    }
                    for color_index, color_runs in enumerate(
                        group_rect_runs_by_fill(make_rect_runs(frame))
                    )
                ],
                "sr": 1,
                "st": 0,
                "ty": 4,
            }
        )
    return {
        "assets": [],
        "ddd": 0,
        "fr": fps,
        "h": height,
        "ip": 0,
        "layers": layers,
        "meta": {
            "generator": "retrodex-rect-runs",
            "name": payload["name"],
            "note": "Pixel art is encoded as merged vector rectangle runs.",
            "encoding": "vector-rect-runs",
        },
        "nm": payload["name"],
        "op": len(frames),
        "v": "5.12.0",
        "w": width,
    }


def quantize_frames_for_tgs(frames: list[Image.Image], colors: int) -> list[Image.Image]:
    width, height = frames[0].size
    strip = Image.new("RGBA", (width * len(frames), height), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        strip.alpha_composite(frame, (index * width, 0))

    rgb_strip = Image.new("RGB", strip.size, (0, 0, 0))
    rgb_strip.paste(strip.convert("RGB"))
    palette = rgb_strip.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    quantized_rgb = palette.convert("RGB")
    quantized_frames = []
    for index, frame in enumerate(frames):
        quantized = quantized_rgb.crop(
            (index * width, 0, (index + 1) * width, height)
        ).convert("RGBA")
        quantized.putalpha(frame.getchannel("A"))
        quantized_frames.append(quantized)
    return quantized_frames


def make_tgs_lottie(
    payload: dict[str, Any], frame_paths: list[Path], frames: list[Image.Image], colors: int
) -> dict[str, Any]:
    quantized_frames = quantize_frames_for_tgs(frames, colors)
    lottie = make_vector_lottie(payload, frame_paths, quantized_frames)
    scale = 512 / max(frames[0].size)
    lottie["w"] = 512
    lottie["h"] = 512
    lottie["meta"] = {
        **lottie["meta"],
        "encoding": "tgs-quantized-vector-rect-runs",
        "logicalSize": {"h": frames[0].height, "w": frames[0].width},
        "paletteColors": colors,
        "scaleTo512": scale,
        "telegramLimitBytes": TGS_MAX_BYTES,
    }
    for layer in lottie["layers"]:
        layer["ks"]["s"] = {"k": [scale * 100, scale * 100, 100]}
    return lottie


def compressed_tgs_bytes(lottie: dict[str, Any]) -> bytes:
    data = json.dumps(lottie, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return gzip.compress(data, compresslevel=9)


def choose_tgs_lottie(
    payload: dict[str, Any], frame_paths: list[Path], frames: list[Image.Image]
) -> tuple[bytes, dict[str, Any]]:
    fallback: tuple[bytes, dict[str, Any]] | None = None
    for colors in TGS_PALETTE_CANDIDATES:
        lottie = make_tgs_lottie(payload, frame_paths, frames, colors)
        compressed = compressed_tgs_bytes(lottie)
        lottie["meta"]["compressedBytes"] = len(compressed)
        compressed = compressed_tgs_bytes(lottie)
        if fallback is None or len(compressed) < len(fallback[0]):
            fallback = (compressed, lottie)
        if len(compressed) <= TGS_MAX_BYTES:
            return compressed, lottie
    if fallback is None:
        raise ValueError("Cannot create TGS without frames.")
    raise ValueError(
        f"TGS export exceeds {TGS_MAX_BYTES} bytes even after quantization: {len(fallback[0])} bytes."
    )


def write_tgs(path: Path, payload: dict[str, Any], frame_paths: list[Path], frames: list[Image.Image]) -> dict[str, Any]:
    compressed, lottie = choose_tgs_lottie(payload, frame_paths, frames)
    path.write_bytes(compressed)
    return {
        "bytes": len(compressed),
        "encoding": lottie["meta"]["encoding"],
        "paletteColors": lottie["meta"]["paletteColors"],
        "telegramLimitBytes": TGS_MAX_BYTES,
    }


def make_raster_lottie(
    payload: dict[str, Any], frame_paths: list[Path], frames: list[Image.Image]
) -> dict[str, Any]:
    fps = int(payload["fps"])
    width = frames[0].width
    height = frames[0].height
    assets = []
    layers = []
    for index, frame_path in enumerate(frame_paths):
        asset_id = f"frame_{index + 1}"
        assets.append(
            {
                "h": height,
                "id": asset_id,
                "p": image_data_url(frame_path),
                "u": "",
                "w": width,
            }
        )
        layers.append(
            {
                "ddd": 0,
                "h": height,
                "ind": index + 1,
                "ip": index,
                "ks": {
                    "a": {"k": [0, 0, 0]},
                    "o": {"k": 100},
                    "p": {"k": [0, 0, 0]},
                    "r": {"k": 0},
                    "s": {"k": [100, 100, 100]},
                },
                "nm": f"Frame {index + 1}",
                "op": index + 1,
                "refId": asset_id,
                "sr": 1,
                "st": 0,
                "ty": 2,
                "w": width,
            }
        )
    return {
        "assets": assets,
        "ddd": 0,
        "fr": fps,
        "h": height,
        "ip": 0,
        "layers": layers,
        "meta": {
            "encoding": "raster-image-sequence",
            "generator": "retrodex-adaptive",
            "name": payload["name"],
            "note": "Raster image-sequence was smaller than vector rect-runs for this pixel art.",
        },
        "nm": payload["name"],
        "op": len(frames),
        "v": "5.12.0",
        "w": width,
    }


def minified_json_size(payload: dict[str, Any]) -> int:
    return len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))


def make_lottie(payload: dict[str, Any], frame_paths: list[Path], frames: list[Image.Image]) -> dict[str, Any]:
    return make_vector_lottie(payload, frame_paths, frames)


def make_css(slug: str, frame_count: int, width: int, height: int, fps: int) -> str:
    duration = frame_count / fps
    return "\n".join(
        [
            f".{slug} {{",
            f"  --pixel-animation-width: {width}px;",
            f"  --pixel-animation-height: {height}px;",
            f"  --pixel-animation-frames: {frame_count};",
            f"  --pixel-animation-duration: {duration:.6f}s;",
            "  width: var(--pixel-animation-width);",
            "  height: var(--pixel-animation-height);",
            "  background-image: url('./strip-transparent.png');",
            "  background-repeat: no-repeat;",
            "  background-size: calc(var(--pixel-animation-width) * var(--pixel-animation-frames)) var(--pixel-animation-height);",
            "  image-rendering: pixelated;",
            f"  animation: {slug}-play var(--pixel-animation-duration) steps(var(--pixel-animation-frames)) infinite;",
            "}",
            "",
            f"@keyframes {slug}-play {{",
            "  from { background-position-x: 0; }",
            "  to { background-position-x: calc(var(--pixel-animation-width) * var(--pixel-animation-frames) * -1); }",
            "}",
        ]
    )


def make_react_component(component_name: str, css_class: str) -> str:
    return "\n".join(
        [
            'import "./pixel-animation.css";',
            "",
            f"export interface {component_name}Props {{",
            "  className?: string;",
            "  label?: string;",
            "}",
            "",
            f"export function {component_name}({{ className = \"\", label = \"Pixel animation\" }}: {component_name}Props) {{",
            "  return (",
            "    <div",
            "      aria-label={label}",
            f'      className={{["{css_class}", className].filter(Boolean).join(" ")}}',
            "      role=\"img\"",
            "    />",
            "  );",
            "}",
        ]
    )


def export_animation(payload: dict[str, Any]) -> dict[str, str]:
    export_dir = Path(payload["exportDir"])
    export_dir.mkdir(parents=True, exist_ok=True)
    frames = load_frames(payload)
    if not frames:
        raise ValueError("Cannot export animation without frames.")

    strip_path = export_dir / "strip-transparent.png"
    contact_path = export_dir / "contact-sheet.png"
    preview_path = export_dir / "preview.png"
    gif_path = export_dir / "preview.gif"
    webp_path = export_dir / "preview.webp"
    svg_path = export_dir / "animation.svg"
    lottie_path = export_dir / "lottie.json"
    tgs_path = export_dir / "animation.tgs"
    tgs_metadata_path = export_dir / "tgs-metadata.json"
    css_path = export_dir / "pixel-animation.css"
    react_path = export_dir / "PixelAnimation.tsx"
    manifest_path = export_dir / "manifest.json"

    strip = make_strip(frames)
    contact = make_contact_sheet(frames)
    strip.save(strip_path)
    contact.save(contact_path)
    frames[0].save(preview_path)
    frames[0].save(
        gif_path,
        append_images=frames[1:],
        disposal=2,
        duration=max(1, round(1000 / int(payload["fps"]))),
        loop=0,
        save_all=True,
    )
    frames[0].save(
        webp_path,
        append_images=frames[1:],
        duration=max(1, round(1000 / int(payload["fps"]))),
        loop=0,
        lossless=True,
        save_all=True,
    )

    frame_paths = [Path(frame["savedPath"]) for frame in payload["frames"]]
    slug = slugify(payload["name"])
    css_class = f"{slug}-pixel-animation"
    svg_path.write_text(make_svg(payload, frame_paths, frames))
    write_json_atomic(lottie_path, make_lottie(payload, frame_paths, frames), compact=True)
    tgs_metadata = write_tgs(tgs_path, payload, frame_paths, frames)
    write_json_atomic(tgs_metadata_path, tgs_metadata)
    css_path.write_text(make_css(css_class, len(frames), frames[0].width, frames[0].height, int(payload["fps"])))
    react_path.write_text(make_react_component("PixelAnimation", css_class))
    write_json_atomic(manifest_path, make_export_manifest(payload, frames))

    return {
        "contactSheet": str(contact_path),
        "css": str(css_path),
        "gif": str(gif_path),
        "lottie": str(lottie_path),
        "manifest": str(manifest_path),
        "preview": str(preview_path),
        "react": str(react_path),
        "svg": str(svg_path),
        "tgs": str(tgs_path),
        "tgsMetadata": str(tgs_metadata_path),
        "stripTransparent": str(strip_path),
        "webp": str(webp_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export cleaned animation assets.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.loads(Path(args.input).read_text())
    result = export_animation(payload)
    write_json_atomic(Path(args.output), result)


if __name__ == "__main__":
    main()
