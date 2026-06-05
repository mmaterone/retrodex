from __future__ import annotations

import argparse
import json
import shutil
import shlex
import subprocess
import sys
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from statistics import median

from PIL import Image, ImageDraw, ImageFilter


RGB = tuple[int, int, int]
PRESETS = {"fighter", "item", "portrait", "tile", "generic"}
HEX_DIGITS = set("0123456789abcdefABCDEF")
ACTION_SHEET_DEFAULTS: dict[str, tuple[int, int, int]] = {
    "idle": (2, 2, 4),
    "attack": (2, 2, 4),
    "hurt": (2, 2, 4),
    "impact": (2, 2, 4),
    "projectile": (1, 4, 4),
    "cast": (2, 3, 6),
    "death": (2, 3, 6),
    "walk": (2, 2, 4),
    "run": (2, 2, 4),
    "single": (1, 1, 1),
}
CONTROL_GRID_PROFILES: dict[str, tuple[RGB, RGB]] = {
    "magenta-cyan": ((255, 0, 255), (0, 255, 255)),
    "magenta-green": ((255, 0, 255), (0, 255, 0)),
    "green-cyan": ((0, 255, 0), (0, 255, 255)),
    "green-magenta": ((0, 255, 0), (255, 0, 255)),
    "blue-yellow": ((0, 64, 255), (255, 255, 0)),
    "red-cyan": ((255, 0, 51), (0, 255, 255)),
    "yellow-blue": ((255, 255, 0), (0, 64, 255)),
    "white-red": ((255, 255, 255), (255, 0, 51)),
}


def parse_rgb(value: str) -> RGB:
    value = value.strip()
    if value.startswith("#") and len(value) == 7:
        return (int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16))

    parts = [part.strip() for part in value.split(",")]
    if len(parts) == 3:
        rgb = tuple(int(part) for part in parts)
        if all(0 <= channel <= 255 for channel in rgb):
            return rgb  # type: ignore[return-value]

    raise ValueError("color must be #rrggbb or r,g,b")


def parse_palette_color(value: str) -> RGB | None:
    value = value.strip()
    if not value or value.startswith(";"):
        return None
    if value.startswith("#"):
        value = value[1:]
    if len(value) == 6 and all(char in HEX_DIGITS for char in value):
        return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))
    return None


def rgb_to_hex(color: RGB) -> str:
    return f"#{color[0]:02x}{color[1]:02x}{color[2]:02x}"


def load_palette_file(path: Path) -> tuple[RGB, ...]:
    text = path.read_text(encoding="utf-8")
    suffix = path.suffix.lower()
    colors: list[RGB] = []

    if suffix == ".json":
        payload = json.loads(text)
        if isinstance(payload, dict):
            payload = payload.get("colors", [])
        if not isinstance(payload, list):
            raise ValueError("JSON palette must be a list or an object with a colors list")
        for item in payload:
            if isinstance(item, str):
                color = parse_palette_color(item)
            elif isinstance(item, list) and len(item) >= 3:
                color = tuple(int(channel) for channel in item[:3])  # type: ignore[assignment]
                if not all(0 <= channel <= 255 for channel in color):
                    raise ValueError(f"invalid RGB palette color: {item}")
            else:
                raise ValueError(f"invalid JSON palette color: {item}")
            if color is None:
                raise ValueError(f"invalid JSON palette color: {item}")
            colors.append(color)
    else:
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") and parse_palette_color(line) is None:
                continue
            if line.upper() in {"GIMP PALETTE", "JASC-PAL"} or line.lower().startswith(("name:", "columns:")):
                continue

            color = parse_palette_color(line.split()[0])
            if color is None:
                parts = line.split()
                if len(parts) >= 3 and all(part.lstrip("-").isdigit() for part in parts[:3]):
                    candidate = tuple(int(part) for part in parts[:3])
                    if all(0 <= channel <= 255 for channel in candidate):
                        color = candidate  # type: ignore[assignment]
            if color is not None:
                colors.append(color)

    deduped = tuple(dict.fromkeys(colors))
    if not deduped:
        raise ValueError(f"palette file contains no colors: {path}")
    if len(deduped) > 256:
        raise ValueError("palette files may contain at most 256 colors")
    return deduped


def write_palette_file(colors: tuple[RGB, ...], output_path: Path, fmt: str = "hex") -> None:
    if fmt not in {"hex", "json", "gpl"}:
        raise ValueError("palette format must be hex, json, or gpl")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "json":
        output_path.write_text(json.dumps({"colors": [rgb_to_hex(color) for color in colors]}, indent=2), encoding="utf-8")
        return
    if fmt == "gpl":
        lines = ["GIMP Palette", "Name: Sprite Forge", "Columns: 8", "#"]
        lines.extend(f"{color[0]:3d} {color[1]:3d} {color[2]:3d}\t{rgb_to_hex(color)}" for color in colors)
        output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return

    output_path.write_text("\n".join(rgb_to_hex(color) for color in colors) + "\n", encoding="utf-8")


def write_retry_hints_file(hints: list[str], output_path: Path) -> None:
    unique_hints = list(dict.fromkeys(hint for hint in hints if hint.strip()))
    if not unique_hints:
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(f"- {hint}" for hint in unique_hints) + "\n", encoding="utf-8")


def read_retry_hints_file(path: Path) -> list[str]:
    hints: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(("-", "*")):
            line = line[1:].strip()
        if line:
            hints.append(line)
    return list(dict.fromkeys(hints))


def save_heatmap(image: Image.Image, points: set[tuple[int, int]], output_path: Path, color: tuple[int, int, int, int]) -> None:
    heatmap = Image.new("RGBA", image.size, (0, 0, 0, 0))
    pixels = heatmap.load()
    for x, y in points:
        if 0 <= x < image.width and 0 <= y < image.height:
            pixels[x, y] = color
    output_path.parent.mkdir(parents=True, exist_ok=True)
    heatmap.save(output_path)


def parse_crop(value: str) -> tuple[int, int, int, int]:
    parts = [int(part.strip()) for part in value.split(",")]
    if len(parts) != 4:
        raise ValueError("crop must be x,y,w,h")
    x, y, width, height = parts
    if width <= 0 or height <= 0:
        raise ValueError("crop width and height must be positive")
    return x, y, width, height


def has_any(text: str, words: tuple[str, ...]) -> bool:
    return any(word in text for word in words)


def infer_art_style(text: str) -> str:
    if has_any(text, ("clean hd", "hand painted", "map style", "painted prop")):
        return "clean_hd"
    if has_any(text, ("retro", "16-bit", "nes", "snes", "gba")):
        return "retro_pixel"
    if has_any(text, ("pixel inspired", "pixel-adjacent")):
        return "pixel_inspired"
    return "pixel_art"


def infer_view(text: str, asset_type: str) -> str:
    if "side" in text or "side-view" in text or "platformer" in text:
        return "side"
    if "topdown" in text or "top-down" in text or "overworld" in text:
        return "topdown"
    if asset_type in {"player", "npc", "prop"}:
        return "topdown"
    return "3/4"


def sheet_name(rows: int, cols: int) -> str:
    return f"{rows}x{cols}"


def infer_asset_plan(prompt: str) -> AssetPlan:
    text = prompt.lower()
    notes: list[str] = []
    subassets: list[str] = []

    prompt_mode = "reference" if has_any(text, ("reference", "same as", "from image", "based on", "attached")) else "scratch"
    art_style = infer_art_style(text)

    if has_any(text, ("hero", "player", "controllable", "main character", "protagonist")):
        asset_type = "player"
    elif "npc" in text or has_any(text, ("healer", "merchant", "villager", "guard")):
        asset_type = "npc"
    elif has_any(text, ("projectile", "fireball", "orb", "bullet", "arrow", "missile")):
        asset_type = "projectile"
    elif has_any(text, ("impact", "explosion", "burst", "hit spark")):
        asset_type = "impact"
    elif has_any(text, ("prop", "item", "inventory", "pickup", "chest", "barrel", "crate", "potion")):
        asset_type = "prop"
    elif has_any(text, ("monster", "creature", "boss", "beast", "enemy")):
        asset_type = "creature"
    elif has_any(text, ("spell", "magic", "summon")):
        asset_type = "spell"
    else:
        asset_type = "character"

    requested_actions = [
        action
        for action in ("idle", "run", "walk", "attack", "shoot", "jump", "hurt", "cast", "death")
        if action in text
    ]
    if asset_type == "player" and len(set(requested_actions)) >= 2:
        subassets = ["idle", "run" if "run" in requested_actions else "walk", "attack-body"]
        if "shoot" in requested_actions:
            subassets.extend(["projectile", "impact"])
        if "attack" in requested_actions:
            subassets.extend(["slash-fx", "impact"])
        notes.append("Generate one raw sheet per hero action; assemble an atlas only after QC.")
        notes.append("Keep attack body separate from wide slash/projectile/impact FX.")
        return AssetPlan(
            prompt=prompt,
            asset_type="player",
            action="bundle",
            view=infer_view(text, "player"),
            sheet="per-action",
            rows=0,
            cols=0,
            frames=0,
            bundle="hero_action_bundle",
            anchor="feet",
            margin="safe",
            art_style=art_style,
            component_mode="largest",
            prompt_mode=prompt_mode,
            notes=notes,
            subassets=list(dict.fromkeys(subassets)),
        )

    if asset_type == "player" and has_any(text, ("4-direction", "four direction", "4 direction", "walk sheet")):
        notes.append("Canonical topdown four-direction walk sheet.")
        return AssetPlan(prompt, "player", "walk", "topdown", "4x4", 4, 4, 16, "single_asset", "feet", "safe", art_style, "largest", prompt_mode, notes, [])

    if asset_type == "projectile":
        rows, cols, frames = ACTION_SHEET_DEFAULTS["projectile"]
        return AssetPlan(prompt, asset_type, "projectile", infer_view(text, asset_type), sheet_name(rows, cols), rows, cols, frames, "single_asset", "center", "normal", art_style, "all", prompt_mode, notes, [])

    if asset_type == "impact":
        rows, cols, frames = ACTION_SHEET_DEFAULTS["impact"]
        return AssetPlan(prompt, asset_type, "impact", infer_view(text, asset_type), sheet_name(rows, cols), rows, cols, frames, "single_asset", "center", "normal", art_style, "all", prompt_mode, notes, [])

    if "cast" in text or (asset_type == "spell" and "projectile" not in text):
        rows, cols, frames = ACTION_SHEET_DEFAULTS["cast"]
        return AssetPlan(prompt, asset_type, "cast", infer_view(text, asset_type), sheet_name(rows, cols), rows, cols, frames, "single_asset", "center", "safe", art_style, "all", prompt_mode, notes, [])

    if "death" in text:
        rows, cols, frames = ACTION_SHEET_DEFAULTS["death"]
        return AssetPlan(prompt, asset_type, "death", infer_view(text, asset_type), sheet_name(rows, cols), rows, cols, frames, "single_asset", "bottom", "safe", art_style, "largest", prompt_mode, notes, [])

    if "idle" in text:
        rows, cols, frames = (3, 3, 9) if asset_type == "creature" and has_any(text, ("boss", "large", "showcase")) else ACTION_SHEET_DEFAULTS["idle"]
        return AssetPlan(prompt, asset_type, "idle", infer_view(text, asset_type), sheet_name(rows, cols), rows, cols, frames, "single_asset", "feet" if asset_type in {"player", "npc", "character", "creature"} else "center", "safe", art_style, "largest", prompt_mode, notes, [])

    if "attack" in text:
        rows, cols, frames = ACTION_SHEET_DEFAULTS["attack"]
        if asset_type == "player":
            notes.append("Use body-only attack sheet; generate slash/impact FX separately if needed.")
        return AssetPlan(prompt, asset_type, "attack", infer_view(text, asset_type), sheet_name(rows, cols), rows, cols, frames, "single_asset", "feet", "safe", art_style, "largest", prompt_mode, notes, [])

    if "run" in text or "walk" in text:
        action = "run" if "run" in text else "walk"
        rows, cols, frames = ACTION_SHEET_DEFAULTS[action]
        return AssetPlan(prompt, asset_type, action, infer_view(text, asset_type), sheet_name(rows, cols), rows, cols, frames, "single_asset", "feet", "safe", art_style, "largest", prompt_mode, notes, [])

    rows, cols, frames = ACTION_SHEET_DEFAULTS["single"]
    return AssetPlan(prompt, asset_type, "single", infer_view(text, asset_type), sheet_name(rows, cols), rows, cols, frames, "single_asset", "center", "normal", art_style, "largest" if asset_type != "projectile" else "all", prompt_mode, notes, [])


def asset_plan_to_dict(plan: AssetPlan) -> dict[str, object]:
    return {
        "prompt": plan.prompt,
        "asset_type": plan.asset_type,
        "action": plan.action,
        "view": plan.view,
        "sheet": plan.sheet,
        "rows": plan.rows,
        "cols": plan.cols,
        "frames": plan.frames,
        "bundle": plan.bundle,
        "anchor": plan.anchor,
        "margin": plan.margin,
        "art_style": plan.art_style,
        "component_mode": plan.component_mode,
        "prompt_mode": plan.prompt_mode,
        "notes": plan.notes,
        "subassets": plan.subassets,
    }


def subasset_action(subasset: str) -> str:
    if subasset == "attack-body":
        return "attack"
    if subasset == "slash-fx":
        return "impact"
    return subasset


def subasset_component_mode(subasset: str) -> str:
    return "all" if subasset in {"projectile", "impact", "slash-fx"} else "largest"


def subasset_anchor(subasset: str) -> str:
    return "center" if subasset in {"projectile", "impact", "slash-fx"} else "feet"


def subasset_prompt(base_prompt: str, subasset: str, view: str, art_style: str) -> str:
    common = (
        "Solid #FF00FF background. No text, labels, UI, borders, or frame lines. "
        "Same identity, palette, pixel scale, and bounding box in every cell. "
        "Nothing may cross a cell edge; leave safe magenta padding."
    )
    if subasset == "idle":
        detail = "Create a 2x2 idle animation sheet: neutral, subtle motion, weight shift, strongest idle accent."
    elif subasset == "run":
        detail = "Create a 2x2 run animation sheet with a stable feet line and consistent body height."
    elif subasset == "walk":
        detail = "Create a 2x2 walk animation sheet with a stable feet line and consistent body height."
    elif subasset == "attack-body":
        detail = "Create a 2x2 body-only attack sheet: wind-up, strike, follow-through, recovery. No slash arc, projectile, impact burst, muzzle flash, dust cloud, or wide detached FX."
    elif subasset == "projectile":
        detail = "Create a 1x4 projectile loop. The projectile keeps the same size and direction; only internal energy/shape pulse changes."
    elif subasset == "impact":
        detail = "Create a 2x2 compact impact burst: contact, expansion, peak, fade. Keep all FX inside each cell."
    elif subasset == "slash-fx":
        detail = "Create a 2x2 separate slash/trail FX sheet. This is detached runtime FX, not the character body."
    else:
        detail = f"Create a sprite sheet for {subasset}."
    return f"{detail}\nSubject/request: {base_prompt}\nView: {view}. Art style: {art_style}.\n{common}\n"


def subasset_sheet_settings(subasset: str) -> dict[str, object]:
    action = subasset_action(subasset)
    rows, cols, frames = ACTION_SHEET_DEFAULTS.get(action, ACTION_SHEET_DEFAULTS["idle"])
    return {
        "action": action,
        "sheet": sheet_name(rows, cols),
        "rows": rows,
        "cols": cols,
        "frames": frames,
        "cell_size": 64,
        "fit_scale": 0.86,
        "align": subasset_anchor(subasset),
        "shared_scale": True,
        "component_mode": subasset_component_mode(subasset),
        "chroma_key": "#ff00ff",
        "chroma_tolerance": 64,
        "reject_edge_touch": True,
    }


def scaffold_hero_bundle(prompt: str, output_dir: Path) -> dict[str, object]:
    plan = infer_asset_plan(prompt)
    if plan.bundle != "hero_action_bundle":
        raise ValueError("request does not infer a hero_action_bundle")

    output_dir.mkdir(parents=True, exist_ok=True)
    bundle_payload = asset_plan_to_dict(plan)
    bundle_payload["subasset_dirs"] = {}

    for subasset in plan.subassets:
        subdir = output_dir / subasset
        subdir.mkdir(parents=True, exist_ok=True)
        settings = subasset_sheet_settings(subasset)
        prompt_text = subasset_prompt(prompt, subasset, plan.view, plan.art_style)
        sub_plan = {
            "bundle": "hero_action_bundle",
            "subasset": subasset,
            "base_prompt": prompt,
            "prompt": prompt_text,
            "asset_type": "player" if subasset not in {"projectile", "impact", "slash-fx"} else ("projectile" if subasset == "projectile" else "fx"),
            "view": plan.view,
            "art_style": plan.art_style,
            **settings,
        }
        (subdir / "asset-plan.json").write_text(json.dumps(sub_plan, indent=2), encoding="utf-8")
        (subdir / "process-settings.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")
        (subdir / "prompt-used.txt").write_text(prompt_text, encoding="utf-8")
        (subdir / "README.md").write_text(
            "\n".join(
                [
                    f"# {subasset}",
                    "",
                    "Generate this raw sheet with imagegen using `prompt-used.txt`.",
                    "Then process the raw image with:",
                    "",
                    "```bash",
                    (
                        "python3 sprite_forge.py process-sheet raw-sheet.png . "
                        f"--rows {settings['rows']} --cols {settings['cols']} --cell-size {settings['cell_size']} "
                        f"--align {settings['align']} --component-mode {settings['component_mode']} --reject-edge-touch"
                    ),
                    "```",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        bundle_payload["subasset_dirs"][subasset] = str(subdir)

    (output_dir / "bundle-plan.json").write_text(json.dumps(bundle_payload, indent=2), encoding="utf-8")
    return bundle_payload


def imagegen_worker_instructions(job: dict[str, object]) -> str:
    prompt_path = Path(str(job["prompt_path"]))
    raw_path = Path(str(job["raw_path"]))
    prompt_abs = prompt_path.resolve()
    raw_abs = raw_path.resolve()
    guide_path = job.get("layout_guide")
    guide_line = (
        f"- First call `view_image` on this layout/pose guide image for target placement and bbox only; do not reproduce guide lines: `{Path(str(guide_path)).resolve()}`."
        if guide_path
        else "- No guide image is required for this job."
    )
    control_path = job.get("control_grid")
    control_line = f"- First call `view_image` on this control-grid image and use it as the edit target: `{Path(str(control_path)).resolve()}`." if control_path else "- No control-grid image is required for this job."
    reference_path = job.get("reference_image")
    reference_line = (
        f"- First call `view_image` on this reference image for visual comparison only, never as the edit target: `{Path(str(reference_path)).resolve()}`."
        if reference_path
        else "- No reference image is required for this job."
    )
    reference_grid_path = job.get("reference_grid")
    reference_grid_line = (
        f"- First call `view_image` on this reference-keyframe grid image for exact approved scale, feet baseline, silhouette size, and cell placement; use it as visual reference only, never as the edit target: `{Path(str(reference_grid_path)).resolve()}`."
        if reference_grid_path
        else "- No reference-keyframe grid image is required for this job."
    )
    sequence_path = job.get("sequence_context")
    sequence_line = (
        f"- First call `view_image` on this full-animation storyboard/context image. It defines the timing arc and neighboring poses; use it for sequence continuity only, never as the edit target: `{Path(str(sequence_path)).resolve()}`."
        if sequence_path
        else "- No full-animation storyboard/context image is required for this job."
    )
    motion_path = job.get("motion_thumbnail")
    motion_line = (
        f"- First call `view_image` on this frame-specific motion thumbnail. It defines the intended body mass, punch hand target, smear/arc direction, and settle/anticipation role; do not reproduce its guide colors or marks: `{Path(str(motion_path)).resolve()}`."
        if motion_path
        else "- No frame-specific motion thumbnail is required for this job."
    )
    pose_reference_path = job.get("pose_reference")
    pose_reference_line = (
        f"- First call `view_image` on this frame-specific pose reference. Copy its pose/timing/silhouette logic, but not its simple mannequin design or colors: `{Path(str(pose_reference_path)).resolve()}`."
        if pose_reference_path
        else "- No frame-specific pose reference is required for this job."
    )
    underlay_line = (
        "- The control-grid may contain a cyan ghost silhouette/bbox underlay. Treat it as the required scale and placement target, paint the sprite over it, and do not leave it visible as artwork."
        if job.get("motion_control_underlay")
        else "- The control-grid has no interior motion underlay."
    )
    return "\n".join(
        [
            "# Sprite Forge Imagegen Worker",
            "",
            "You are one isolated Codex/imagegen worker. Generate exactly one raw image for this job.",
            "",
            "Rules:",
            "- Do not edit Sprite Forge code.",
            "- Do not run cleanup, ranking, or export commands.",
            "- Do not use unrelated images from the current chat or previous jobs.",
            "- Use imagegen once for this job, unless the generation tool itself fails.",
            "- The clean control-grid image is the only edit target and output canvas.",
            "- Reference images are visual references only: do not edit, copy, transform, crop, upscale, or paste them.",
            "- Draw a fresh frame into the clean grid while matching the reference identity, palette, outline thickness, and scale.",
            underlay_line,
            "- If a layout/pose guide is present, use it only for target bbox, placement, and safe padding.",
            "- Generate exactly one square frame, not a sheet, not variants, not a contact sheet.",
            "- After imagegen finishes, copy the newest generated image from `${CODEX_HOME:-$HOME/.codex}/generated_images` to the required raw output path.",
            "- Verify the raw output exists with `test -s` before saying the job is complete.",
            "- If the raw file is missing, the job is not complete.",
            "- Keep the output as the raw generated image; the coordinator will process it later.",
            guide_line,
            control_line,
            reference_grid_line,
            sequence_line,
            motion_line,
            pose_reference_line,
            reference_line,
            "",
            f"Prompt file: `{prompt_abs}`",
            f"Required raw output path: `{raw_abs}`",
            "",
            "Required finalization command after imagegen:",
            "",
            "```bash",
            "latest=$(find \"${CODEX_HOME:-$HOME/.codex}/generated_images\" -type f \\( -name '*.png' -o -name '*.webp' -o -name '*.jpg' -o -name '*.jpeg' \\) -print0 | xargs -0 ls -t | head -n 1)",
            f"cp \"$latest\" {shlex.quote(str(raw_abs))}",
            f"test -s {shlex.quote(str(raw_abs))}",
            "```",
            "",
            "Prompt to use:",
            "",
            "```text",
            prompt_path.read_text(encoding="utf-8"),
            "```",
            "",
        ]
    )


def write_codex_dispatch_script(run_dir: Path, jobs: list[dict[str, object]], workers: int, codex_bin: str) -> Path:
    script_path = run_dir / "run-codex-workers.sh"
    quoted_jobs = " ".join(shlex.quote(str(Path(str(job["dir"])) / "worker-instructions.md")) for job in jobs)
    jobs_json = shlex.quote(json.dumps(jobs))
    script = f"""#!/usr/bin/env bash
set -euo pipefail

ROOT={shlex.quote(str(Path.cwd()))}
RUN_DIR={shlex.quote(str(run_dir))}
CODEX_BIN="${{CODEX_BIN:-{shlex.quote(codex_bin)}}}"
WORKERS="${{SPRITE_FORGE_WORKERS:-{workers}}}"
BASE_CODEX_HOME="${{CODEX_HOME:-$HOME/.codex}}"
JOBS_JSON={jobs_json}

jobs=({quoted_jobs})

prepare_worker_home() {{
  local worker_home="$1"
  rm -rf "$worker_home/generated_images"
  mkdir -p "$worker_home/generated_images"
  for entry in auth.json config.toml AGENTS.md RTK.md skills cache plugins vendor_imports tools; do
    if [ -e "$BASE_CODEX_HOME/$entry" ] && [ ! -e "$worker_home/$entry" ]; then
      ln -s "$BASE_CODEX_HOME/$entry" "$worker_home/$entry"
    fi
  done
}}

image_args_for_job() {{
  local job_dir="$1"
  python3 - "$job_dir" "$JOBS_JSON" <<'PY'
import json, shlex, sys
job_dir = sys.argv[1]
for job in json.loads(sys.argv[2]):
    if job.get("dir") != job_dir:
        continue
    for key in ("control_grid", "reference_grid", "sequence_context", "motion_thumbnail", "pose_reference", "reference_image", "layout_guide"):
        path = job.get(key)
        if path:
            print("--image " + shlex.quote(str(path)), end=" ")
    break
PY
}}

for instruction in "${{jobs[@]}}"; do
  job_dir="$(dirname "$instruction")"
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$WORKERS" ]; do
    sleep 2
  done
  worker_home="$job_dir/.codex-worker-home"
  prepare_worker_home "$worker_home"
  image_args="$(image_args_for_job "$job_dir")"
  CODEX_HOME="$worker_home" "$CODEX_BIN" exec -C "$ROOT" $image_args --dangerously-bypass-approvals-and-sandbox "$(cat "$instruction")" > "$job_dir/codex-worker.log" 2>&1 &
done

wait
python3 "$ROOT/sprite_forge.py" production-ingest "$RUN_DIR"
"""
    script_path.write_text(script, encoding="utf-8")
    script_path.chmod(0o755)
    return script_path


def write_animation_dispatch_script(run_dir: Path, jobs: list[dict[str, object]], workers: int, codex_bin: str) -> Path:
    script_path = run_dir / "run-animation-workers.sh"
    worker_jobs = [job for job in jobs if job.get("worker_required", True)]
    quoted_jobs = " ".join(shlex.quote(str(Path(str(job["dir"])) / "worker-instructions.md")) for job in worker_jobs)
    jobs_json = shlex.quote(json.dumps(jobs))
    script = f"""#!/usr/bin/env bash
set -euo pipefail

ROOT={shlex.quote(str(Path.cwd()))}
RUN_DIR={shlex.quote(str(run_dir))}
CODEX_BIN="${{CODEX_BIN:-{shlex.quote(codex_bin)}}}"
WORKERS="${{SPRITE_FORGE_WORKERS:-{workers}}}"
BASE_CODEX_HOME="${{CODEX_HOME:-$HOME/.codex}}"
JOBS_JSON={jobs_json}

jobs=({quoted_jobs})

prepare_worker_home() {{
  local worker_home="$1"
  rm -rf "$worker_home/generated_images"
  mkdir -p "$worker_home/generated_images"
  for entry in auth.json config.toml AGENTS.md RTK.md skills cache plugins vendor_imports tools; do
    if [ -e "$BASE_CODEX_HOME/$entry" ] && [ ! -e "$worker_home/$entry" ]; then
      ln -s "$BASE_CODEX_HOME/$entry" "$worker_home/$entry"
    fi
  done
}}

image_args_for_job() {{
  local job_dir="$1"
  python3 - "$job_dir" "$JOBS_JSON" <<'PY'
import json, shlex, sys
job_dir = sys.argv[1]
for job in json.loads(sys.argv[2]):
    if job.get("dir") != job_dir:
        continue
    for key in ("control_grid", "reference_grid", "sequence_context", "motion_thumbnail", "pose_reference", "reference_image", "layout_guide"):
        path = job.get(key)
        if path:
            print("--image " + shlex.quote(str(path)), end=" ")
    break
PY
}}

for instruction in "${{jobs[@]}}"; do
  job_dir="$(dirname "$instruction")"
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$WORKERS" ]; do
    sleep 2
  done
  worker_home="$job_dir/.codex-worker-home"
  prepare_worker_home "$worker_home"
  image_args="$(image_args_for_job "$job_dir")"
  CODEX_HOME="$worker_home" "$CODEX_BIN" exec -C "$ROOT" $image_args --dangerously-bypass-approvals-and-sandbox "$(cat "$instruction")" > "$job_dir/codex-worker.log" 2>&1 &
done

wait
python3 "$ROOT/sprite_forge.py" animation-ingest "$RUN_DIR"
"""
    script_path.write_text(script, encoding="utf-8")
    script_path.chmod(0o755)
    return script_path


def production_process_command(job: dict[str, object]) -> str:
    processed_dir = Path(str(job["processed_dir"]))
    raw_path = Path(str(job["raw_path"]))
    if job["kind"] == "sheet":
        settings = job["process_settings"]
        return (
            "python3 sprite_forge.py process-sheet "
            f"{shlex.quote(str(raw_path))} {shlex.quote(str(processed_dir))} "
            f"--rows {settings['rows']} --cols {settings['cols']} --cell-size {settings['cell_size']} "
            f"--align {settings['align']} --component-mode {settings['component_mode']} "
            f"--chroma-key {shlex.quote(str(settings['chroma_key']))} --reject-edge-touch "
            f"--prompt-file {shlex.quote(str(job['prompt_path']))} --preset {shlex.quote(str(job['preset']))}"
        )
    return (
        "python3 sprite_forge.py process-sprite "
        f"{shlex.quote(str(raw_path))} {shlex.quote(str(processed_dir))} "
        f"--prompt-file {shlex.quote(str(job['prompt_path']))} --preset {shlex.quote(str(job['preset']))} "
        "--chroma-key '#ff00ff' --grid-key '#ff00ff'"
    )


def create_production_loop(
    request: str,
    output_dir: Path,
    *,
    attempts: int = 3,
    workers: int = 4,
    mode: str = "auto",
    preset: str = "fighter",
    cells: int = 64,
    codex_bin: str = "codex",
    dispatch_script: bool = True,
) -> dict[str, object]:
    if attempts <= 0 or workers <= 0:
        raise ValueError("attempts and workers must be positive")
    if mode not in {"auto", "hero", "single"}:
        raise ValueError("mode must be auto, hero, or single")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")

    output_dir.mkdir(parents=True, exist_ok=True)
    jobs_dir = output_dir / "jobs"
    jobs_dir.mkdir(exist_ok=True)
    plan = infer_asset_plan(request)
    selected_mode = "hero" if mode == "hero" or (mode == "auto" and plan.bundle == "hero_action_bundle") else "single"

    jobs: list[dict[str, object]] = []
    subassets = plan.subassets if selected_mode == "hero" else ["single"]
    for subasset in subassets:
        if selected_mode == "hero":
            settings = subasset_sheet_settings(subasset)
            prompt_text = subasset_prompt(request, subasset, plan.view, plan.art_style)
            kind = "sheet"
            raw_name = "raw-sheet.png"
            layout_rows = int(settings["rows"])
            layout_cols = int(settings["cols"])
            job_preset = "fighter" if subasset not in {"projectile", "impact", "slash-fx"} else "generic"
        else:
            settings = {
                "cells": cells,
                "preset": preset,
                "chroma_key": "#ff00ff",
                "grid_key": "#ff00ff",
                "palette": 24,
                "sample_mode": "median",
            }
            prompt_text = build_imagegen_prompt(request, cells, "#FF00FF", "scratch", preset)
            kind = "single"
            raw_name = "raw.png"
            layout_rows = 0
            layout_cols = 0
            job_preset = preset

        for attempt in range(1, attempts + 1):
            job_id = f"{sanitize_asset_name(subasset)}_a{attempt:02d}"
            job_dir = jobs_dir / job_id
            job_dir.mkdir(parents=True, exist_ok=True)
            prompt_path = job_dir / "prompt-used.txt"
            prompt_path.write_text(prompt_text, encoding="utf-8")
            layout_guide: str | None = None
            if kind == "sheet":
                guide_path = job_dir / "layout-guide.png"
                create_layout_guide(guide_path, rows=layout_rows, cols=layout_cols)
                layout_guide = str(guide_path)
            raw_path = job_dir / raw_name
            processed_dir = job_dir / "processed"
            job: dict[str, object] = {
                "id": job_id,
                "subasset": subasset,
                "attempt": attempt,
                "kind": kind,
                "preset": job_preset,
                "dir": str(job_dir),
                "prompt_path": str(prompt_path),
                "raw_path": str(raw_path),
                "processed_dir": str(processed_dir),
                "layout_guide": layout_guide,
                "process_settings": settings,
                "status": "pending_generation",
            }
            (job_dir / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
            (job_dir / "worker-instructions.md").write_text(imagegen_worker_instructions(job), encoding="utf-8")
            (job_dir / "process-command.txt").write_text(production_process_command(job) + "\n", encoding="utf-8")
            jobs.append(job)

    payload: dict[str, object] = {
        "type": "sprite_forge_production_loop",
        "request": request,
        "mode": selected_mode,
        "attempts": attempts,
        "workers": workers,
        "asset_plan": asset_plan_to_dict(plan),
        "jobs": jobs,
        "run_dir": str(output_dir),
        "queue": str(output_dir / "generation-queue.jsonl"),
    }
    (output_dir / "production-plan.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    with (output_dir / "generation-queue.jsonl").open("w", encoding="utf-8") as file:
        for job in jobs:
            file.write(json.dumps(job) + "\n")
    if dispatch_script:
        payload["dispatch_script"] = str(write_codex_dispatch_script(output_dir, jobs, workers, codex_bin))
        (output_dir / "production-plan.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def split_frame_descriptions(frames: str | None, count: int) -> list[str]:
    parts = [part.strip() for part in frames.split("|")] if frames else []
    defaults = [
        "idle pose, stable identity",
        "anticipation/squash pose",
        "airborne/action peak pose",
        "landing/recovery pose",
    ]
    while len(parts) < count:
        parts.append(defaults[len(parts)] if len(parts) < len(defaults) else f"frame {len(parts) + 1}")
    return parts[:count]


def animation_motion_contract(description: str, reference_bbox: tuple[int, int, int, int] | None) -> str:
    if reference_bbox is None:
        return "Keep the same object scale across frames; motion changes pose/position, not pixel density or sprite size."
    left, top, right, bottom = reference_bbox
    width = right - left
    height = bottom - top
    text = description.lower()
    width_min = max(1, width - 2)
    width_max = min(64, width + 2)
    height_min = max(1, height - 4)
    height_max = min(64, height + 4)
    bottom_rule = f"keep bottom anchor near y={bottom} within 2 cells"
    if any(word in text for word in ["squash", "crouch", "anticipation"]):
        width_max = min(64, width + 4)
        height_min = max(1, round(height * 0.75))
        height_max = height
        bottom_rule = f"keep bottom anchor near y={bottom} within 1 cell"
    elif any(word in text for word in ["airborne", "jump", "upward", "higher", "peak"]):
        height_min = max(1, height - 3)
        height_max = min(64, height + 3)
        bottom_rule = "move the whole bottle upward if needed, but do not shrink or simplify the silhouette"
    elif any(word in text for word in ["land", "stretch", "settling", "recovery"]):
        height_min = max(1, height - 3)
        height_max = min(64, height + 5)
        bottom_rule = f"keep bottom anchor near y={bottom} within 2 cells"
    return (
        f"Reference cell bbox is x={left}..{right - 1}, y={top}..{bottom - 1} "
        f"({width} cells wide, {height} cells tall). Required scale contract: final sprite bbox must stay "
        f"{width_min}..{width_max} cells wide and {height_min}..{height_max} cells tall; {bottom_rule}. "
        "Do not redraw it as a miniature, icon, side-view sliver, or simplified silhouette. "
        "Preserve label width, cap width, glass body width, highlight clusters, and black outline thickness from the keyframe."
    )


def animation_contract_bounds(description: str, reference_bbox: tuple[int, int, int, int] | None) -> dict[str, object]:
    if reference_bbox is None:
        return {}
    left, top, right, bottom = reference_bbox
    width = right - left
    height = bottom - top
    text = description.lower()
    bounds: dict[str, object] = {
        "reference_bbox": [left, top, right, bottom],
        "width": [max(1, width - 2), min(64, width + 2)],
        "height": [max(1, height - 4), min(64, height + 4)],
        "bottom": [max(0, bottom - 2), min(64, bottom + 2)],
        "allow_bottom_motion": False,
    }
    if any(word in text for word in ["squash", "crouch", "anticipation"]):
        bounds["width"] = [max(1, width - 2), min(64, width + 4)]
        bounds["height"] = [max(1, round(height * 0.75)), height]
        bounds["bottom"] = [max(0, bottom - 1), min(64, bottom + 1)]
    elif any(word in text for word in ["airborne", "jump", "upward", "higher", "peak"]):
        bounds["height"] = [max(1, height - 3), min(64, height + 3)]
        bounds["bottom"] = [0, 64]
        bounds["allow_bottom_motion"] = True
    elif any(word in text for word in ["land", "stretch", "settling", "recovery"]):
        bounds["height"] = [max(1, height - 3), min(64, height + 5)]
        bounds["bottom"] = [max(0, bottom - 2), min(64, bottom + 2)]
    return bounds


def direct_action_contract_bounds(reference_bbox: tuple[int, int, int, int]) -> dict[str, object]:
    left, top, right, bottom = reference_bbox
    width = right - left
    height = bottom - top
    return {
        "reference_bbox": [left, top, right, bottom],
        "width": [max(1, round(width * 0.72)), min(96, width + 18)],
        "height": [max(1, round(height * 0.68)), min(96, height + 10)],
        "bottom": [max(0, bottom - 10), min(96, bottom + 5)],
        "allow_bottom_motion": False,
    }


def animation_frame_contract_qc(job: dict[str, object], cleaned_path: Path) -> dict[str, object]:
    reference_bbox_raw = job.get("reference_bbox")
    if not isinstance(reference_bbox_raw, list) or len(reference_bbox_raw) != 4:
        return {"passes": True, "blocking_issues": [], "warnings": [], "issues": [], "bounds": {}, "bbox": None}
    reference_bbox = tuple(int(value) for value in reference_bbox_raw)
    description = str(job.get("description", ""))
    bounds = direct_action_contract_bounds(reference_bbox) if job.get("mode") == "direct_action_frame" else animation_contract_bounds(description, reference_bbox)
    bbox = alpha_bbox(Image.open(cleaned_path).convert("RGBA"))
    blocking_issues: list[str] = []
    warnings: list[str] = []
    if bbox is None:
        blocking_issues.append("empty_frame")
    else:
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        bottom = bbox[3]
        min_w, max_w = [int(value) for value in bounds.get("width", [0, 10**9])]
        min_h, max_h = [int(value) for value in bounds.get("height", [0, 10**9])]
        min_b, max_b = [int(value) for value in bounds.get("bottom", [0, 10**9])]
        if width < min_w or width > max_w:
            warnings.append(f"scale_width:{width} not {min_w}..{max_w}")
        if height < min_h or height > max_h:
            warnings.append(f"scale_height:{height} not {min_h}..{max_h}")
        if not bool(bounds.get("allow_bottom_motion")) and (bottom < min_b or bottom > max_b):
            warnings.append(f"anchor_bottom:{bottom} not {min_b}..{max_b}")
    return {
        "passes": not blocking_issues,
        "blocking_issues": blocking_issues,
        "warnings": warnings,
        "issues": blocking_issues + warnings,
        "bounds": bounds,
        "bbox": list(bbox) if bbox is not None else None,
    }


def animation_pose_score(job: dict[str, object], cleaned_path: Path) -> dict[str, object]:
    reference_bbox_raw = job.get("reference_bbox")
    bbox = alpha_bbox(Image.open(cleaned_path).convert("RGBA"))
    if bbox is None:
        return {"score": 0.0, "kind": "empty", "bbox": None, "penalties": ["empty_frame"]}
    if not isinstance(reference_bbox_raw, list) or len(reference_bbox_raw) != 4:
        return {"score": 1000.0, "kind": "keyframe", "bbox": list(bbox), "penalties": []}

    ref = tuple(int(value) for value in reference_bbox_raw)
    ref_w = ref[2] - ref[0]
    ref_h = ref[3] - ref[1]
    ref_bottom = ref[3]
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    top = bbox[1]
    bottom = bbox[3]
    if job.get("mode") == "direct_action_frame":
        penalties: list[str] = []
        penalty = 0.0
        min_width = round(ref_w * 0.72)
        min_height = round(ref_h * 0.68)
        if width < min_width:
            value = (min_width - width) * 16
            penalty += value
            penalties.append(f"too_narrow:{round(value, 3)}")
        else:
            value = abs(width - ref_w) * 4
            penalty += value
            if value:
                penalties.append(f"width_drift:{round(value, 3)}")
        if height < min_height:
            value = (min_height - height) * 14
            penalty += value
            penalties.append(f"too_short:{round(value, 3)}")
        else:
            value = abs(height - ref_h) * 3
            penalty += value
            if value:
                penalties.append(f"height_drift:{round(value, 3)}")
        anchor_drift = abs(bottom - ref_bottom)
        if anchor_drift > 10:
            value = (anchor_drift - 10) * 10
            penalty += value
            penalties.append(f"anchor_drift:{round(value, 3)}")
        return {
            "score": max(0.0, round(1000.0 - penalty, 3)),
            "kind": "direct_action",
            "bbox": list(bbox),
            "reference_bbox": list(ref),
            "metrics": {
                "width": width,
                "height": height,
                "top": top,
                "bottom": bottom,
                "reference_width": ref_w,
                "reference_height": ref_h,
                "reference_bottom": ref_bottom,
            },
            "penalties": penalties,
        }
    text = str(job.get("description", "")).lower()
    penalties: list[str] = []
    penalty = 0.0

    def add(name: str, value: float) -> None:
        nonlocal penalty
        if value <= 0:
            return
        penalty += value
        penalties.append(f"{name}:{round(value, 3)}")

    if any(word in text for word in ["squash", "crouch", "anticipation"]):
        kind = "squash"
        target_w = round(ref_w * 1.22)
        target_h = round(ref_h * 0.78)
        add("not_wide_enough", max(0, target_w - width) * 26)
        add("too_tall_for_squash", max(0, height - target_h) * 58)
        add("anchor_drift", abs(bottom - ref_bottom) * 18)
        add("too_thin", max(0, ref_w - width) * 20)
    elif any(word in text for word in ["airborne", "jump", "upward", "higher", "peak"]):
        kind = "airborne"
        target_top = max(0, ref[1] - 5)
        target_bottom = max(0, ref_bottom - 4)
        add("not_high_enough", max(0, top - target_top) * 32)
        add("bottom_not_lifted", max(0, bottom - target_bottom) * 18)
        add("width_drift", abs(width - ref_w) * 18)
        add("height_drift", abs(height - ref_h) * 14)
    elif any(word in text for word in ["land", "stretch", "settling", "recovery"]):
        kind = "landing"
        target_h = round(ref_h * 1.04)
        add("anchor_drift", abs(bottom - ref_bottom) * 34)
        add("height_drift", abs(height - target_h) * 16)
        add("width_drift", abs(width - ref_w) * 14)
    else:
        kind = "steady"
        add("anchor_drift", abs(bottom - ref_bottom) * 24)
        add("width_drift", abs(width - ref_w) * 18)
        add("height_drift", abs(height - ref_h) * 14)

    score = max(0.0, round(1000.0 - penalty, 3))
    return {
        "score": score,
        "kind": kind,
        "bbox": list(bbox),
        "reference_bbox": list(ref),
        "metrics": {
            "width": width,
            "height": height,
            "top": top,
            "bottom": bottom,
            "reference_width": ref_w,
            "reference_height": ref_h,
            "reference_bottom": ref_bottom,
        },
        "penalties": penalties,
    }


def direct_action_motion_qc(job: dict[str, object], cleaned_path: Path) -> dict[str, object]:
    reference_bbox_raw = job.get("reference_bbox")
    if job.get("mode") != "direct_action_frame" or not isinstance(reference_bbox_raw, list) or len(reference_bbox_raw) != 4:
        return {"score": 100.0, "kind": "not_direct_action", "issues": []}
    image = Image.open(cleaned_path).convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha_bbox(image)
    if bbox is None:
        return {
            "score": 0.0,
            "kind": "direct_action_motion",
            "issues": ["empty_frame"],
            "arc_score": 0.0,
            "hand_extension_score": 0.0,
            "smear_score": 0.0,
        }
    settings = job.get("process_settings", {})
    cells = int(settings.get("cells", image.width)) if isinstance(settings, dict) else image.width
    ref = tuple(int(value) for value in reference_bbox_raw)
    profile = direct_action_motion_profile(
        str(job.get("description", "")),
        frame_index=int(job.get("frame_index", 1)),
        frame_count=int(job.get("frame_count", 1)),
        reference_bbox=ref,
        cells=cells,
    )
    expected_bbox = profile["bbox"]  # type: ignore[assignment]
    exp_left, exp_top, exp_right, exp_bottom = expected_bbox  # type: ignore[misc]
    act_left, act_top, act_right, act_bottom = bbox
    exp_cx = (exp_left + exp_right) / 2
    exp_cy = (exp_top + exp_bottom) / 2
    act_cx = (act_left + act_right) / 2
    act_cy = (act_top + act_bottom) / 2
    arc_error = abs(act_cx - exp_cx) * 1.3 + abs(act_cy - exp_cy) * 1.0 + abs(act_bottom - exp_bottom) * 0.8
    arc_score = max(0.0, min(100.0, 100.0 - arc_error * 5.0))

    phase = str(profile.get("phase", "neutral"))
    ref_right = ref[2]
    ref_left = ref[0]
    expected_fist = profile["fist"]  # type: ignore[assignment]
    expected_fist_x = float(expected_fist[0])  # type: ignore[index]
    if phase in {"contact", "overshoot"}:
        target_right = max(ref_right + 4, expected_fist_x - 1)
        extension_error = max(0.0, target_right - act_right) * 2.5 + max(0.0, act_right - (target_right + 8)) * 1.3
    elif phase == "anticipation":
        target_right = ref_right + 2
        extension_error = max(0.0, act_right - target_right) * 2.2 + max(0.0, (ref_left - 3) - act_left) * 0.7
    else:
        target_right = ref_right + (2 if phase in {"launch", "recoil"} else 0)
        extension_error = abs(act_right - target_right) * 1.4
    hand_extension_score = max(0.0, min(100.0, 100.0 - extension_error * 7.0))

    fist_y = int(round(float(expected_fist[1])))  # type: ignore[index]
    band = max(3, round((ref[3] - ref[1]) * 0.12))
    y0 = max(0, fist_y - band)
    y1 = min(alpha.height, fist_y + band + 1)
    x_start = max(0, min(ref_right - 10, int(round((ref_left + ref_right) * 0.48))))
    x_end = min(alpha.width, max(act_right, ref_right + 12))
    max_run = 0
    band_coverage = 0
    pixels = alpha.load()
    for y in range(y0, y1):
        run = 0
        for x in range(x_start, x_end):
            if pixels[x, y] > 0:
                band_coverage += 1
                run += 1
                max_run = max(max_run, run)
            else:
                run = 0
    expected_smear = bool(profile.get("smear"))
    if expected_smear:
        target_run = max(8, round((ref[2] - ref[0]) * 0.32))
        run_score = min(100.0, max_run / target_run * 100.0)
        coverage_score = min(100.0, band_coverage / max(1, target_run * max(2, band)) * 100.0)
        smear_score = round(run_score * 0.7 + coverage_score * 0.3, 3)
    else:
        excess = max(0, max_run - round((ref[2] - ref[0]) * 0.42))
        smear_score = max(0.0, 100.0 - excess * 8.0)

    score = round(arc_score * 0.40 + hand_extension_score * 0.42 + smear_score * 0.18, 3)
    issues: list[str] = []
    if arc_score < 55:
        issues.append(f"arc_off:{round(arc_score, 1)}")
    if hand_extension_score < 55:
        issues.append(f"hand_extension_off:{round(hand_extension_score, 1)}")
    if expected_smear and smear_score < 45:
        issues.append(f"smear_missing:{round(smear_score, 1)}")
    return {
        "score": score,
        "kind": "direct_action_motion",
        "phase": phase,
        "bbox": list(bbox),
        "reference_bbox": list(ref),
        "expected_bbox": [int(exp_left), int(exp_top), int(exp_right), int(exp_bottom)],
        "expected_fist": [int(round(float(expected_fist[0]))), int(round(float(expected_fist[1])))],  # type: ignore[index]
        "arc_score": round(arc_score, 3),
        "hand_extension_score": round(hand_extension_score, 3),
        "smear_score": round(smear_score, 3),
        "smear_expected": expected_smear,
        "max_band_run": max_run,
        "band_coverage": band_coverage,
        "issues": issues,
    }


def animation_pose_kind(description: str) -> str:
    text = description.lower()
    if any(word in text for word in ["squash", "crouch", "anticipation"]):
        return "squash"
    if any(word in text for word in ["airborne", "jump", "upward", "higher", "peak"]):
        return "airborne"
    if any(word in text for word in ["land", "stretch", "settling", "recovery"]):
        return "landing"
    return "steady"


def animation_grid_fidelity_qc(job: dict[str, object], raw_path: Path) -> dict[str, object]:
    settings = job.get("process_settings", {})
    if not isinstance(settings, dict):
        return {"passes": True, "blocking_issues": [], "warnings": [], "issues": [], "grid_detection": None}
    grid_key_raw = settings.get("grid_key")
    if not grid_key_raw:
        return {"passes": True, "blocking_issues": [], "warnings": [], "issues": [], "grid_detection": None}
    try:
        raw = Image.open(raw_path).convert("RGB")
        cells = int(settings.get("cells", 64))
        grid_key = parse_rgb(str(grid_key_raw))
        tolerance = int(settings.get("grid_tolerance", 48))
        x_lines, x_report = axis_grid_line_positions(raw, grid_key, tolerance, cells, "x")
        y_lines, y_report = axis_grid_line_positions(raw, grid_key, tolerance, cells, "y")
    except Exception as exc:  # noqa: BLE001 - keep QC actionable.
        return {"passes": False, "blocking_issues": [f"grid_detection_failed:{exc}"], "warnings": [], "issues": [f"grid_detection_failed:{exc}"], "grid_detection": None}

    expected = cells + 1
    min_visible_lines = max(8, int(round(expected * 0.45)))
    x_groups = int(x_report.get("groups", 0))
    y_groups = int(y_report.get("groups", 0))
    blocking_issues: list[str] = []
    if x_groups < min_visible_lines:
        blocking_issues.append(f"grid_x_lines:{x_groups} below {min_visible_lines}")
    if y_groups < min_visible_lines:
        blocking_issues.append(f"grid_y_lines:{y_groups} below {min_visible_lines}")
    detection = {
        "x": {**x_report, "selected_lines": len(x_lines)},
        "y": {**y_report, "selected_lines": len(y_lines)},
        "expected_lines": expected,
        "min_visible_lines": min_visible_lines,
    }
    return {
        "passes": not blocking_issues,
        "blocking_issues": blocking_issues,
        "warnings": [],
        "issues": blocking_issues,
        "grid_detection": detection,
    }


def animation_pose_guide_bbox(description: str, reference_bbox: tuple[int, int, int, int], cells: int) -> tuple[int, int, int, int]:
    bounds = animation_contract_bounds(description, reference_bbox)
    width_range = [int(value) for value in bounds.get("width", [reference_bbox[2] - reference_bbox[0], reference_bbox[2] - reference_bbox[0]])]
    height_range = [int(value) for value in bounds.get("height", [reference_bbox[3] - reference_bbox[1], reference_bbox[3] - reference_bbox[1]])]
    text = description.lower()
    if any(word in text for word in ["squash", "crouch", "anticipation"]):
        target_w = max(1, width_range[1])
        target_h = max(1, height_range[0])
    elif any(word in text for word in ["land", "stretch", "settling", "recovery"]):
        target_w = max(1, width_range[0])
        target_h = max(1, height_range[1])
    else:
        target_w = max(1, round(sum(width_range) / 2))
        target_h = max(1, round(sum(height_range) / 2))
    ref_cx = (reference_bbox[0] + reference_bbox[2]) // 2
    left = max(1, min(cells - target_w - 1, ref_cx - target_w // 2))
    if bool(bounds.get("allow_bottom_motion")):
        top = max(2, reference_bbox[1] - 6)
    else:
        bottom_range = [int(value) for value in bounds.get("bottom", [reference_bbox[3], reference_bbox[3]])]
        bottom = round(sum(bottom_range) / 2)
        top = bottom - target_h
    top = max(1, min(cells - target_h - 1, top))
    if any(word in text for word in ["squash", "crouch", "anticipation"]):
        top = max(1, min(cells - target_h - 1, reference_bbox[3] - target_h))
    return (left, top, left + target_w, top + target_h)


def create_animation_pose_guide(
    output_path: Path,
    *,
    cells: int,
    target_side: int,
    description: str,
    reference_bbox: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    guide_bbox = animation_pose_guide_bbox(description, reference_bbox, cells)
    cell_size = target_side // cells
    if cell_size <= 0:
        raise ValueError("target_side must be at least the number of cells")
    image = Image.new("RGB", (target_side, target_side), (28, 28, 32))
    pixels = image.load()
    grid_color = (70, 70, 78)
    for i in range(cells + 1):
        pos = min(target_side - 1, i * cell_size)
        for n in range(target_side):
            pixels[pos, n] = grid_color
            pixels[n, pos] = grid_color
    left, top, right, bottom = guide_bbox
    x0 = left * cell_size
    y0 = top * cell_size
    x1 = right * cell_size - 1
    y1 = bottom * cell_size - 1
    fill = (44, 70, 92)
    outline = (255, 230, 64)
    center = (255, 80, 80)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            image.putpixel((x, y), fill)
    stroke = max(1, cell_size // 5)
    for offset in range(stroke):
        for x in range(x0, x1 + 1):
            image.putpixel((x, y0 + offset), outline)
            image.putpixel((x, y1 - offset), outline)
        for y in range(y0, y1 + 1):
            image.putpixel((x0 + offset, y), outline)
            image.putpixel((x1 - offset, y), outline)
    cx = ((left + right) * cell_size) // 2
    for y in range(y0, y1 + 1):
        image.putpixel((cx, y), center)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return guide_bbox


def direct_action_pose_guide_bbox(description: str, reference_bbox: tuple[int, int, int, int], cells: int) -> tuple[int, int, int, int]:
    left, top, right, bottom = reference_bbox
    text = description.lower()
    pad_left = 4
    pad_right = 4
    pad_top = 3
    pad_bottom = 3
    if any(word in text for word in ["punch", "strike", "impact", "slash", "kick"]):
        pad_left = 6
        pad_right = 10
        pad_top = 4
        pad_bottom = 4
    if any(word in text for word in ["pulls back", "windup", "anticipation", "retract"]):
        pad_left = max(pad_left, 8)
        pad_right = max(pad_right, 6)
    return (
        max(1, left - pad_left),
        max(1, top - pad_top),
        min(cells - 1, right + pad_right),
        min(cells - 1, bottom + pad_bottom),
    )


def create_direct_action_pose_guide(
    output_path: Path,
    *,
    cells: int,
    target_side: int,
    description: str,
    reference_bbox: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    guide_bbox = direct_action_pose_guide_bbox(description, reference_bbox, cells)
    cell_size = target_side // cells
    if cell_size <= 0:
        raise ValueError("target_side must be at least the number of cells")
    image = Image.new("RGB", (target_side, target_side), (28, 28, 32))
    pixels = image.load()
    grid_color = (70, 70, 78)
    for i in range(cells + 1):
        pos = min(target_side - 1, i * cell_size)
        for n in range(target_side):
            pixels[pos, n] = grid_color
            pixels[n, pos] = grid_color
    left, top, right, bottom = guide_bbox
    x0 = left * cell_size
    y0 = top * cell_size
    x1 = right * cell_size - 1
    y1 = bottom * cell_size - 1
    fill = (44, 70, 92)
    outline = (255, 220, 80)
    center = (120, 255, 255)
    feet = (255, 150, 70)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            pixels[x, y] = fill
    stroke = max(1, cell_size // 5)
    for offset in range(stroke):
        for x in range(x0, x1 + 1):
            pixels[x, y0 + offset] = outline
            pixels[x, y1 - offset] = outline
        for y in range(y0, y1 + 1):
            pixels[x0 + offset, y] = outline
            pixels[x1 - offset, y] = outline
    cx = ((left + right) * cell_size) // 2
    feet_y = reference_bbox[3] * cell_size
    for y in range(y0, y1 + 1):
        pixels[cx, y] = center
    if 0 <= feet_y < target_side:
        for x in range(x0, x1 + 1):
            pixels[x, feet_y] = feet
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return guide_bbox


def direct_action_motion_profile(
    description: str,
    *,
    frame_index: int,
    frame_count: int,
    reference_bbox: tuple[int, int, int, int],
    cells: int,
) -> dict[str, object]:
    left, top, right, bottom = reference_bbox
    width = right - left
    height = bottom - top
    text = description.lower()
    phase = "neutral"
    if any(word in text for word in ["anticipation", "wind-up", "windup", "pulls back", "cocked"]):
        phase = "anticipation"
    if any(word in text for word in ["launch", "starts fast", "springs"]):
        phase = "launch"
    if any(word in text for word in ["smear", "contact", "fastest"]):
        phase = "contact"
    if any(word in text for word in ["impact", "overshoot", "farthest", "follow through"]):
        phase = "overshoot"
    if any(word in text for word in ["recoil", "retract"]):
        phase = "recoil"
    if any(word in text for word in ["settle", "returns", "recovery"]):
        phase = "settle"

    base_fist_y = top + int(round(height * 0.45))
    body_dx = 0
    body_dy = 0
    bbox_scale_x = 1.0
    bbox_scale_y = 1.0
    fist_x = left + int(round(width * 0.18))
    fist_y = base_fist_y
    smear = False
    arc_strength = 0

    if phase == "anticipation":
        body_dx = -2
        body_dy = 2
        bbox_scale_x = 0.95
        bbox_scale_y = 0.92
        fist_x = max(2, left - 4)
        fist_y = base_fist_y + 2
        arc_strength = -2
    elif phase == "launch":
        body_dx = 1
        body_dy = 1
        bbox_scale_x = 1.03
        bbox_scale_y = 0.96
        fist_x = left + int(round(width * 0.38))
        fist_y = base_fist_y
        arc_strength = 2
    elif phase == "contact":
        body_dx = 2
        body_dy = 0
        bbox_scale_x = 1.14
        bbox_scale_y = 0.95
        fist_x = min(cells - 3, right + 9)
        fist_y = base_fist_y - 1
        smear = True
        arc_strength = 7
    elif phase == "overshoot":
        body_dx = 3
        body_dy = 0
        bbox_scale_x = 1.10
        bbox_scale_y = 0.94
        fist_x = min(cells - 3, right + 6)
        fist_y = base_fist_y
        smear = True
        arc_strength = 5
    elif phase == "recoil":
        body_dx = 1
        body_dy = 1
        bbox_scale_x = 1.02
        bbox_scale_y = 0.97
        fist_x = left + int(round(width * 0.45))
        fist_y = base_fist_y + 1
        arc_strength = -3
    elif phase == "settle":
        body_dx = 0
        body_dy = 1
        bbox_scale_x = 0.98
        bbox_scale_y = 0.98
        fist_x = left + int(round(width * 0.24))
        fist_y = base_fist_y + 1

    target_w = max(1, int(round(width * bbox_scale_x)))
    target_h = max(1, int(round(height * bbox_scale_y)))
    center_x = (left + right) // 2 + body_dx
    new_left = max(1, min(cells - target_w - 1, center_x - target_w // 2))
    new_bottom = max(target_h + 1, min(cells - 1, bottom + body_dy))
    new_top = max(1, new_bottom - target_h)
    if phase == "contact":
        new_left = max(1, min(new_left, left - 2))
    bbox = (new_left, new_top, min(cells - 1, new_left + target_w), new_bottom)
    shoulder = (left + int(round(width * 0.24)) + body_dx, top + int(round(height * 0.43)) + body_dy)
    fist = (max(1, min(cells - 2, fist_x)), max(1, min(cells - 2, fist_y + body_dy)))
    return {
        "phase": phase,
        "bbox": bbox,
        "shoulder": shoulder,
        "fist": fist,
        "smear": smear,
        "arc_strength": arc_strength,
        "frame_index": frame_index,
        "frame_count": frame_count,
    }


def draw_direct_action_motion_panel(
    image: Image.Image,
    *,
    origin: tuple[int, int],
    panel_side: int,
    cells: int,
    profile: dict[str, object],
    grid: bool = True,
) -> None:
    draw = ImageDraw.Draw(image, "RGBA")
    ox, oy = origin
    cell = panel_side / cells
    if grid:
        grid_color = (58, 64, 72, 180)
        for index in range(cells + 1):
            pos = int(round(index * cell))
            draw.line((ox + pos, oy, ox + pos, oy + panel_side), fill=grid_color)
            draw.line((ox, oy + pos, ox + panel_side, oy + pos), fill=grid_color)

    bbox = profile["bbox"]  # type: ignore[assignment]
    left, top, right, bottom = bbox  # type: ignore[misc]
    x0 = ox + int(round(left * cell))
    y0 = oy + int(round(top * cell))
    x1 = ox + int(round(right * cell))
    y1 = oy + int(round(bottom * cell))
    draw.rectangle((x0, y0, x1, y1), fill=(46, 78, 110, 110), outline=(255, 220, 80, 230), width=max(1, int(panel_side / 96)))

    shoulder = profile["shoulder"]  # type: ignore[assignment]
    fist = profile["fist"]  # type: ignore[assignment]
    sx = ox + int(round(shoulder[0] * cell))  # type: ignore[index]
    sy = oy + int(round(shoulder[1] * cell))  # type: ignore[index]
    fx = ox + int(round(fist[0] * cell))  # type: ignore[index]
    fy = oy + int(round(fist[1] * cell))  # type: ignore[index]
    line_width = max(2, int(panel_side / 48))
    draw.line((sx, sy, fx, fy), fill=(255, 236, 130, 235), width=line_width)
    radius = max(3, int(panel_side / 28))
    draw.ellipse((fx - radius, fy - radius, fx + radius, fy + radius), fill=(255, 95, 60, 240), outline=(255, 245, 170, 255), width=max(1, line_width // 2))
    if profile.get("smear"):
        smear_width = max(2, int(panel_side / 32))
        draw.line((sx, sy - smear_width, fx, fy - smear_width), fill=(255, 245, 160, 180), width=smear_width)
        draw.line((sx, sy + smear_width, fx, fy + smear_width), fill=(255, 150, 80, 150), width=smear_width)
    feet_y = y1
    draw.line((x0, feet_y, x1, feet_y), fill=(255, 130, 80, 160), width=max(1, line_width // 2))


def draw_direct_action_pose_reference(
    image: Image.Image,
    *,
    origin: tuple[int, int],
    panel_side: int,
    cells: int,
    profile: dict[str, object],
    grid: bool = True,
) -> None:
    draw = ImageDraw.Draw(image, "RGBA")
    ox, oy = origin
    cell = panel_side / cells
    if grid:
        for index in range(cells + 1):
            pos = int(round(index * cell))
            draw.line((ox + pos, oy, ox + pos, oy + panel_side), fill=(58, 64, 72, 150))
            draw.line((ox, oy + pos, ox + panel_side, oy + pos), fill=(58, 64, 72, 150))

    bbox = profile["bbox"]  # type: ignore[assignment]
    left, top, right, bottom = bbox  # type: ignore[misc]
    phase = str(profile.get("phase", "neutral"))
    shoulder = profile["shoulder"]  # type: ignore[assignment]
    fist = profile["fist"]  # type: ignore[assignment]

    def px(point: tuple[float, float]) -> tuple[int, int]:
        return (ox + int(round(point[0] * cell)), oy + int(round(point[1] * cell)))

    width = right - left
    height = bottom - top
    head_c = (left + width * 0.52, top + height * 0.16)
    neck = (left + width * 0.50, top + height * 0.29)
    hip = (left + width * 0.47, top + height * 0.61)
    far_shoulder = (left + width * 0.67, top + height * 0.35)
    guard_fist = (left + width * 0.76, top + height * 0.46)
    if phase in {"contact", "overshoot"}:
        neck = (neck[0] + 1.5, neck[1])
        hip = (hip[0] + 1.0, hip[1])
    if phase == "anticipation":
        neck = (neck[0] - 1.5, neck[1] + 1.5)
        hip = (hip[0] - 1.0, hip[1] + 2.0)

    left_foot = (left + width * 0.23, bottom - 1)
    right_foot = (right - width * 0.12, bottom - 1)
    left_knee = (left + width * 0.34, top + height * 0.78)
    right_knee = (right - width * 0.25, top + height * 0.78)
    line_w = max(2, int(panel_side / 34))
    outline_w = max(1, line_w + 1)
    for a, b in ((neck, hip), (hip, left_knee), (left_knee, left_foot), (hip, right_knee), (right_knee, right_foot), (neck, shoulder), (shoulder, fist), (neck, far_shoulder), (far_shoulder, guard_fist)):
        draw.line((*px(a), *px(b)), fill=(44, 39, 86, 230), width=outline_w)
        draw.line((*px(a), *px(b)), fill=(98, 160, 230, 245), width=line_w)
    if profile.get("smear"):
        sx, sy = px(shoulder)  # type: ignore[arg-type]
        fx, fy = px(fist)  # type: ignore[arg-type]
        smear_w = max(3, int(panel_side / 28))
        draw.line((sx, sy - smear_w, fx, fy - smear_w), fill=(255, 236, 128, 190), width=smear_w)
        draw.line((sx, sy + smear_w, fx, fy + smear_w), fill=(255, 150, 68, 160), width=smear_w)
    head_r = max(4, int(panel_side / 18))
    hx, hy = px(head_c)
    draw.rectangle((hx - head_r, hy - head_r, hx + head_r, hy + head_r), fill=(255, 218, 122, 245), outline=(44, 39, 86, 240), width=max(1, line_w // 2))
    fist_r = max(3, int(panel_side / 24))
    fx, fy = px(fist)  # type: ignore[arg-type]
    draw.rectangle((fx - fist_r, fy - fist_r, fx + fist_r, fy + fist_r), fill=(255, 216, 128, 250), outline=(255, 120, 64, 250), width=max(1, line_w // 2))
    gx, gy = px(guard_fist)
    draw.rectangle((gx - fist_r, gy - fist_r, gx + fist_r, gy + fist_r), fill=(255, 216, 128, 230), outline=(44, 39, 86, 220), width=max(1, line_w // 2))


def create_direct_action_pose_reference(
    output_path: Path,
    *,
    cells: int,
    target_side: int,
    description: str,
    frame_index: int,
    frame_count: int,
    reference_bbox: tuple[int, int, int, int],
) -> Path:
    profile = direct_action_motion_profile(
        description,
        frame_index=frame_index,
        frame_count=frame_count,
        reference_bbox=reference_bbox,
        cells=cells,
    )
    image = Image.new("RGB", (target_side, target_side), (100, 130, 145))
    draw_direct_action_pose_reference(image, origin=(0, 0), panel_side=target_side, cells=cells, profile=profile, grid=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return output_path


def create_direct_action_motion_thumbnail(
    output_path: Path,
    *,
    cells: int,
    target_side: int,
    description: str,
    frame_index: int,
    frame_count: int,
    reference_bbox: tuple[int, int, int, int],
) -> Path:
    profile = direct_action_motion_profile(
        description,
        frame_index=frame_index,
        frame_count=frame_count,
        reference_bbox=reference_bbox,
        cells=cells,
    )
    image = Image.new("RGB", (target_side, target_side), (26, 30, 35))
    draw_direct_action_motion_panel(image, origin=(0, 0), panel_side=target_side, cells=cells, profile=profile, grid=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return output_path


def create_direct_action_sequence_context(
    output_path: Path,
    *,
    descriptions: list[str],
    cells: int,
    reference_bbox: tuple[int, int, int, int],
    panel_side: int = 192,
) -> Path:
    frame_count = len(descriptions)
    if frame_count <= 0:
        raise ValueError("sequence context needs at least one frame")
    gap = max(4, panel_side // 24)
    width = frame_count * panel_side + (frame_count + 1) * gap
    height = panel_side + gap * 2
    image = Image.new("RGB", (width, height), (22, 24, 28))
    draw = ImageDraw.Draw(image, "RGBA")
    for index, description in enumerate(descriptions, start=1):
        ox = gap + (index - 1) * (panel_side + gap)
        oy = gap
        profile = direct_action_motion_profile(
            description,
            frame_index=index,
            frame_count=frame_count,
            reference_bbox=reference_bbox,
            cells=cells,
        )
        draw.rectangle((ox, oy, ox + panel_side, oy + panel_side), fill=(28, 32, 38, 255))
        draw_direct_action_pose_reference(image, origin=(ox, oy), panel_side=panel_side, cells=cells, profile=profile, grid=False)
        phase = str(profile.get("phase", "neutral"))
        color = {
            "anticipation": (80, 180, 255, 255),
            "launch": (255, 220, 80, 255),
            "contact": (255, 70, 70, 255),
            "overshoot": (255, 130, 60, 255),
            "recoil": (180, 120, 255, 255),
            "settle": (100, 255, 150, 255),
        }.get(phase, (230, 238, 245, 255))
        dot = max(4, panel_side // 18)
        draw.ellipse((ox + dot, oy + dot, ox + dot * 2, oy + dot * 2), fill=color)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return output_path


def create_squash_pose_mask(alpha: Image.Image, target_size: tuple[int, int]) -> Image.Image:
    target_w, target_h = target_size
    if target_w <= 0 or target_h <= 0:
        return Image.new("L", (max(1, target_w), max(1, target_h)), 0)

    source_w, source_h = alpha.size
    if source_w <= 0 or source_h <= 0:
        return Image.new("L", target_size, 0)

    base = alpha.resize((max(1, round(target_w * 0.78)), target_h), Image.Resampling.NEAREST)
    out = Image.new("L", target_size, 0)
    base_pixels = base.load()
    out_pixels = out.load()
    center = (target_w - 1) / 2

    for y in range(target_h):
        t = y / max(1, target_h - 1)
        if t < 0.24:
            row_scale = 0.58
        elif t < 0.42:
            row_scale = 0.82
        else:
            row_scale = 1.18
        row_w = max(1, min(target_w, round(base.width * row_scale)))
        for sx in range(base.width):
            value = base_pixels[sx, y]
            if value <= 0:
                continue
            nx = (sx + 0.5) / base.width - 0.5
            ox = int(round(center + nx * row_w))
            if 0 <= ox < target_w:
                out_pixels[ox, y] = max(out_pixels[ox, y], value)
                if row_scale > 1.05:
                    if ox > 0:
                        out_pixels[ox - 1, y] = max(out_pixels[ox - 1, y], value)
                    if ox + 1 < target_w:
                        out_pixels[ox + 1, y] = max(out_pixels[ox + 1, y], value)
    return out


def create_animation_motion_control_grid(
    output_path: Path,
    *,
    cells: int,
    target_side: int,
    description: str,
    reference_bbox: tuple[int, int, int, int],
    silhouette_image: Path | None = None,
    profile: str = "magenta-cyan",
    settings_output: Path | None = None,
    subject: str = "a clean production-ready pixel art animation frame",
) -> tuple[int, int, int, int]:
    guide_bbox = animation_pose_guide_bbox(description, reference_bbox, cells)
    cell_size = resolve_cell_size(cells, None, target_side)
    background, grid_color, _selected_profile = pick_control_grid_colors(
        profile=profile,
        subject=subject,
        background_override=None,
        grid_override=None,
    )
    side = cells * cell_size
    image = Image.new("RGB", (side, side), background)
    pixels = image.load()

    fill = (64, 220, 235)
    outline = grid_color
    center = (120, 255, 255)
    left, top, right, bottom = guide_bbox
    pose_kind = animation_pose_kind(description)

    source_mask: Image.Image | None = None
    if silhouette_image is not None and silhouette_image.exists():
        sprite = Image.open(silhouette_image).convert("RGBA")
        source_bbox = alpha_bbox(sprite)
        if source_bbox is not None:
            cropped_alpha = sprite.crop(source_bbox).getchannel("A")
            target_size = (max(1, right - left), max(1, bottom - top))
            if pose_kind == "squash":
                source_mask = create_squash_pose_mask(cropped_alpha, target_size)
            else:
                source_mask = cropped_alpha.resize(target_size, Image.Resampling.NEAREST)

    for cell_y in range(top, bottom):
        for cell_x in range(left, right):
            if source_mask is not None:
                alpha = source_mask.getpixel((cell_x - left, cell_y - top))
                if alpha <= 0:
                    continue
            x0 = cell_x * cell_size
            y0 = cell_y * cell_size
            x1 = min(side, x0 + cell_size)
            y1 = min(side, y0 + cell_size)
            for y in range(y0, y1):
                for x in range(x0, x1):
                    pixels[x, y] = fill

    x0 = left * cell_size
    y0 = top * cell_size
    x1 = right * cell_size - 1
    y1 = bottom * cell_size - 1
    stroke = max(1, cell_size // 5)
    for offset in range(stroke):
        for x in range(x0, x1 + 1):
            pixels[x, y0 + offset] = outline
            pixels[x, y1 - offset] = outline
        for y in range(y0, y1 + 1):
            pixels[x0 + offset, y] = outline
            pixels[x1 - offset, y] = outline
    cx = ((left + right) * cell_size) // 2
    for y in range(y0, y1 + 1):
        pixels[cx, y] = center

    if pose_kind == "squash":
        label_y = y0 + max(cell_size, (y1 - y0) // 2)
        for y in range(label_y, min(y1 + 1, label_y + max(1, cell_size // 2))):
            for x in range(x0 + cell_size, max(x0 + cell_size, x1 - cell_size)):
                pixels[x, y] = outline
    elif pose_kind == "airborne":
        lift_y = max(0, y1 - cell_size)
        for x in range(x0, x1 + 1):
            pixels[x, lift_y] = outline

    image = draw_real_grid(image, cells, grid_color, 1)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    if settings_output is not None:
        write_control_process_settings(settings_output, cells=cells, background=background, grid_color=grid_color)
    return guide_bbox


def animation_frame_prompt(
    subject: str,
    frame_index: int,
    frame_count: int,
    description: str,
    cells: int,
    *,
    keyframe: bool,
    reference_bbox: tuple[int, int, int, int] | None = None,
) -> str:
    prefix = (
        f"Create the keyframe for a {frame_count}-frame pixel art animation: {subject}. "
        if keyframe
        else f"Create frame {frame_index} of {frame_count} for the same pixel art animation: {subject}. "
    )
    anchor = (
        "This is the identity/style anchor for all later frames."
        if keyframe
        else (
            "Draw this frame onto the clean control-grid canvas. "
            "Use the provided keyframe/reference image only as a visual reference for identity, palette, outline, label placement, and pixel-scale; "
            "do not edit, copy, transform, crop, or paste the reference image itself."
        )
    )
    motion_contract = "" if keyframe else " " + animation_motion_contract(description, reference_bbox)
    underlay_contract = (
        ""
        if keyframe
        else " If the edit target contains a cyan ghost silhouette or bbox underlay, use it only as the required size/placement target and paint the sprite over it; do not leave cyan guide pixels as artwork."
    )
    pose_kind = animation_pose_kind(description)
    pose_contract = ""
    if not keyframe and pose_kind == "squash":
        pose_contract = " This is a squash/anticipation frame: keep the same bottle identity but make the body visibly shorter, wider, and lower than the keyframe with a compressed label and stable bottom contact."
    elif not keyframe and pose_kind == "airborne":
        pose_contract = " This is an airborne frame: keep the bottle full-size and readable, moved upward from the ground pose, not a tiny icon or shortened miniature."
    elif not keyframe and pose_kind == "landing":
        pose_contract = " This is a landing/recovery frame: keep the bottom anchor stable and make the bottle settled/readable, not shrunken."
    return build_scratch_control_grid_prompt(
        f"{prefix}{description}. {anchor} Keep the same object identity, same palette, same outline style, and same pixel density. Animate only the requested motion.{pose_contract}{motion_contract}{underlay_contract}",
        cells=cells,
        background=(255, 0, 255),
        grid_color=(0, 255, 255),
    )


def create_animation_job(
    run_dir: Path,
    *,
    job_id: str,
    frame_index: int,
    frame_count: int,
    subject: str,
    description: str,
    cells: int,
    target_side: int,
    preset: str,
    keyframe: bool,
    reference_image: Path | None = None,
    reference_bbox: tuple[int, int, int, int] | None = None,
    control_silhouette_image: Path | None = None,
    retry_notes: str | None = None,
) -> dict[str, object]:
    job_dir = run_dir / "jobs" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    control_path = job_dir / "control-grid.png"
    settings_path = job_dir / "process-settings.json"
    prompt_path = job_dir / "prompt-used.txt"
    if reference_bbox is None and reference_image and Path(reference_image).exists():
        reference_bbox = alpha_bbox(Image.open(reference_image).convert("RGBA"))
    layout_guide: str | None = None
    pose_guide_bbox: tuple[int, int, int, int] | None = None
    motion_control_bbox: tuple[int, int, int, int] | None = None
    if not keyframe and reference_bbox is not None:
        motion_control_bbox = create_animation_motion_control_grid(
            control_path,
            cells=cells,
            target_side=target_side,
            description=description,
            reference_bbox=reference_bbox,
            silhouette_image=control_silhouette_image,
            settings_output=settings_path,
            subject=f"{subject}, {description}",
        )
        guide_path = job_dir / "pose-guide.png"
        pose_guide_bbox = create_animation_pose_guide(
            guide_path,
            cells=cells,
            target_side=target_side,
            description=description,
            reference_bbox=reference_bbox,
        )
        layout_guide = str(guide_path)
    else:
        create_scratch_control_grid(
            control_path,
            cells=cells,
            target_side=target_side,
            profile="magenta-cyan",
            subject=f"{subject}, {description}",
            settings_output=settings_path,
        )
    prompt_text = animation_frame_prompt(
        subject,
        frame_index,
        frame_count,
        description,
        cells,
        keyframe=keyframe,
        reference_bbox=reference_bbox,
    )
    if retry_notes:
        prompt_text += (
            "\n\nRetry correction:\n"
            f"- Previous candidate failed: {retry_notes}.\n"
            "- Fix those failures directly. The new frame must satisfy the reference bbox contract before style details matter.\n"
        )
    prompt_path.write_text(prompt_text, encoding="utf-8")
    raw_path = job_dir / "raw.png"
    processed_dir = job_dir / "processed"
    job: dict[str, object] = {
        "id": job_id,
        "frame_index": frame_index,
        "frame_count": frame_count,
        "kind": "animation_keyframe" if keyframe else "animation_frame",
        "preset": preset,
        "dir": str(job_dir),
        "control_grid": str(control_path),
        "settings_path": str(settings_path),
        "prompt_path": str(prompt_path),
        "raw_path": str(raw_path),
        "processed_dir": str(processed_dir),
        "layout_guide": layout_guide,
        "pose_guide_bbox": list(pose_guide_bbox) if pose_guide_bbox is not None else None,
        "motion_control_bbox": list(motion_control_bbox) if motion_control_bbox is not None else None,
        "motion_control_underlay": bool(motion_control_bbox is not None),
        "reference_image": str(reference_image) if reference_image else None,
        "reference_bbox": list(reference_bbox) if reference_bbox is not None else None,
        "description": description,
        "retry_notes": retry_notes,
        "process_settings": {
            "cells": cells,
            "chroma_key": "#ff00ff",
            "grid_key": "#00ffff",
            "palette": 24 if preset != "item" else 18,
            "sample_mode": "median",
            "sample_margin_ratio": 0.40,
            "min_component_size": 4,
        },
        "status": "pending_generation",
    }
    (job_dir / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    (job_dir / "worker-instructions.md").write_text(imagegen_worker_instructions(job), encoding="utf-8")
    return job



def direct_action_frame_prompt(
    subject: str,
    frame_index: int,
    frame_count: int,
    description: str,
    cells: int,
    *,
    reference_bbox: tuple[int, int, int, int] | None = None,
    background: RGB = (255, 0, 255),
    grid_color: RGB = (0, 255, 255),
) -> str:
    bbox_note = ""
    if reference_bbox is not None:
        left, top, right, bottom = reference_bbox
        bbox_note = (
            f" Reference sprite occupies roughly cells x={left}..{right}, y={top}..{bottom}; "
            "use this as a continuity envelope: keep the same pixel density, same camera, same feet baseline, and same overall proportions unless the action specifically requires extension."
        )
    continuity_contract = (
        " Continuity contract: this frame belongs to one animation, not a standalone redesign. "
        "Keep the same character identity, hair shape/color clusters, face orientation, costume layout, shoe colors, outline thickness, and palette temperature as the reference. "
        "Do not change the art style, body proportions, camera angle, or handedness between frames. "
        "Only the described action pose should change."
    )
    handedness_contract = (
        " Handedness contract: anatomical RIGHT arm means the character's own right arm, which appears on image-left for this front-facing/three-quarter sprite. "
        "If the action says right-hand punch, move the image-left arm/fist. Keep the image-right arm as guard/support unless explicitly told otherwise."
    )
    first_frame_contract = (
        " Frame 1 must be a neutral approved key pose, not an attack. Keep both arms in the reference fighting stance and do not throw a punch."
        if frame_index == 1
        else ""
    )
    sequence_contract = (
        " Attached context contract: the full-animation storyboard shows all frames left-to-right and is the timing source of truth. "
        f"Your output must match panel {frame_index} of that storyboard, while staying stylistically close to the keyframe. "
        "The frame-specific motion thumbnail is a pose/arc guide for body mass, punch-hand target, smear direction, anticipation, overshoot, recoil, or settle. "
        "Use those guides to constrain the animation arc, but redraw the character creatively as pixel art and do not reproduce guide colors, dots, boxes, or marks."
    )
    return build_scratch_control_grid_prompt(
        (
            f"single expressive action animation frame {frame_index} of {frame_count}: {subject}. "
            f"Frame action: {description}. "
            "Use the provided reference image only as identity/style reference: same character design, palette family, face/hair/costume/outline style, and pixel density. "
            "Do not paste, crop, warp, upscale, trace, or directly transform the reference; redraw a fresh pose. "
            "Prioritize a clear dynamic silhouette, readable line of action, strong pose expression, and animation appeal over exact geometric matching. "
            "This is one isolated frame, not a sprite sheet. Keep the sprite centered enough for later code alignment."
            f"{continuity_contract}{handedness_contract}{first_frame_contract}"
            f"{sequence_contract}"
            f"{bbox_note}"
        ),
        cells=cells,
        background=background,
        grid_color=grid_color,
    )


def create_reference_keyframe_grid(
    reference_image: Path,
    output_path: Path,
    *,
    cells: int,
    target_side: int,
    background: RGB,
    grid_color: RGB,
) -> Path:
    cell_size = resolve_cell_size(cells, None, target_side)
    canvas = Image.new("RGB", (target_side, target_side), background)
    canvas = draw_real_grid(canvas, cells, grid_color, 1).convert("RGBA")
    reference = Image.open(reference_image).convert("RGBA")
    if reference.size != (target_side, target_side):
        if reference.size == (cells, cells):
            reference = reference.resize((target_side, target_side), Image.Resampling.NEAREST)
        else:
            bbox = alpha_bbox(reference)
            fitted = Image.new("RGBA", (cells, cells), (0, 0, 0, 0))
            if bbox is not None:
                cropped = reference.crop(bbox)
                max_side = max(cropped.size)
                scale = max(1, min(cells, cells) // max(1, max_side))
                new_size = (max(1, cropped.width * scale), max(1, cropped.height * scale))
                cropped = cropped.resize(new_size, Image.Resampling.NEAREST)
                fitted.alpha_composite(cropped, ((cells - new_size[0]) // 2, (cells - new_size[1]) // 2))
            reference = fitted.resize((target_side, target_side), Image.Resampling.NEAREST)
    canvas.alpha_composite(reference)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path)
    return output_path


def create_direct_action_job(
    run_dir: Path,
    *,
    job_id: str,
    frame_index: int,
    frame_count: int,
    attempt: int,
    subject: str,
    description: str,
    cells: int,
    target_side: int,
    preset: str,
    reference_image: Path,
    reference_bbox: tuple[int, int, int, int] | None,
    relaxed_grid_qc: bool = True,
    control_profile: str = "green-cyan",
    sequence_context: Path | None = None,
) -> dict[str, object]:
    job_dir = run_dir / "jobs" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    control_path = job_dir / "control-grid.png"
    settings_path = job_dir / "process-settings.json"
    prompt_path = job_dir / "prompt-used.txt"
    reference_rgba = Image.open(reference_image).convert("RGBA")
    _control_image = create_scratch_control_grid(
        control_path,
        cells=cells,
        target_side=target_side,
        profile=control_profile,
        reference_image=reference_rgba,
        subject=f"{subject}, {description}",
        settings_output=settings_path,
    )
    process_settings = json.loads(settings_path.read_text(encoding="utf-8"))
    reference_grid_path = create_reference_keyframe_grid(
        reference_image,
        job_dir / "reference-keyframe-grid.png",
        cells=cells,
        target_side=target_side,
        background=parse_rgb(str(process_settings["chroma_key"])),
        grid_color=parse_rgb(str(process_settings["grid_key"])),
    )
    layout_guide: str | None = None
    pose_guide_bbox: tuple[int, int, int, int] | None = None
    motion_thumbnail: Path | None = None
    pose_reference: Path | None = None
    if reference_bbox is not None:
        guide_path = job_dir / "loose-bbox-guide.png"
        pose_guide_bbox = create_direct_action_pose_guide(
            guide_path,
            cells=cells,
            target_side=target_side,
            description=description,
            reference_bbox=reference_bbox,
        )
        layout_guide = str(guide_path)
        motion_thumbnail = create_direct_action_motion_thumbnail(
            job_dir / "motion-thumbnail.png",
            cells=cells,
            target_side=target_side,
            description=description,
            frame_index=frame_index,
            frame_count=frame_count,
            reference_bbox=reference_bbox,
        )
        pose_reference = create_direct_action_pose_reference(
            job_dir / "pose-reference.png",
            cells=cells,
            target_side=target_side,
            description=description,
            frame_index=frame_index,
            frame_count=frame_count,
            reference_bbox=reference_bbox,
        )
    prompt_path.write_text(
        direct_action_frame_prompt(
            subject,
            frame_index,
            frame_count,
            description,
            cells,
            reference_bbox=reference_bbox,
            background=parse_rgb(str(process_settings["chroma_key"])),
            grid_color=parse_rgb(str(process_settings["grid_key"])),
        ),
        encoding="utf-8",
    )
    raw_path = job_dir / "raw.png"
    processed_dir = job_dir / "processed"
    job: dict[str, object] = {
        "id": job_id,
        "frame_index": frame_index,
        "frame_count": frame_count,
        "attempt": attempt,
        "kind": "animation_frame",
        "mode": "direct_action_frame",
        "preset": preset,
        "dir": str(job_dir),
        "control_grid": str(control_path),
        "settings_path": str(settings_path),
        "prompt_path": str(prompt_path),
        "raw_path": str(raw_path),
        "processed_dir": str(processed_dir),
        "layout_guide": layout_guide,
        "pose_guide_bbox": list(pose_guide_bbox) if pose_guide_bbox is not None else None,
        "motion_control_bbox": None,
        "motion_control_underlay": False,
        "reference_image": str(reference_image),
        "reference_grid": str(reference_grid_path),
        "sequence_context": str(sequence_context) if sequence_context else None,
        "motion_thumbnail": str(motion_thumbnail) if motion_thumbnail else None,
        "pose_reference": str(pose_reference) if pose_reference else None,
        "reference_bbox": list(reference_bbox) if reference_bbox is not None else None,
        "description": description,
        "relaxed_grid_qc": relaxed_grid_qc,
        "control_profile": control_profile,
        "process_settings": {
            "cells": cells,
            "chroma_key": process_settings["chroma_key"],
            "grid_key": process_settings["grid_key"],
            "palette": 0,
            "palette_mode": "reference_lock",
            "sample_mode": process_settings["sample_mode"],
            "sample_margin_ratio": process_settings["sample_margin_ratio"],
            "min_component_size": 4,
        },
        "status": "pending_generation",
    }
    (job_dir / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    (job_dir / "worker-instructions.md").write_text(imagegen_worker_instructions(job), encoding="utf-8")
    return job


def create_locked_direct_action_keyframe_job(
    run_dir: Path,
    *,
    job_id: str,
    frame_count: int,
    subject: str,
    description: str,
    cells: int,
    preset: str,
    reference_image: Path,
    reference_bbox: tuple[int, int, int, int] | None,
    control_profile: str,
) -> dict[str, object]:
    job_dir = run_dir / "jobs" / job_id
    processed_dir = job_dir / "processed"
    processed_dir.mkdir(parents=True, exist_ok=True)
    raw_path = job_dir / "raw.png"
    cleaned_path = processed_dir / f"cleaned_{cells}.png"
    reference_rgba = Image.open(reference_image).convert("RGBA")
    shutil.copy2(reference_image, raw_path)
    if reference_rgba.size == (cells, cells):
        reference_rgba.save(cleaned_path)
    else:
        fit_image_into_square(reference_rgba.convert("RGB"), cells, 0, (0, 255, 0)).convert("RGBA").save(cleaned_path)
    prompt_path = job_dir / "prompt-used.txt"
    prompt_path.write_text(
        "\n".join(
            [
                f"Locked direct-action keyframe for {subject}.",
                f"Frame 1 of {frame_count}: {description}.",
                "This frame is copied from the approved reference and is not sent to imagegen.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    job: dict[str, object] = {
        "id": job_id,
        "frame_index": 1,
        "frame_count": frame_count,
        "kind": "animation_locked_keyframe",
        "mode": "direct_action_locked_keyframe",
        "preset": preset,
        "dir": str(job_dir),
        "control_grid": None,
        "settings_path": str(job_dir / "process-settings.json"),
        "prompt_path": str(prompt_path),
        "raw_path": str(raw_path),
        "processed_dir": str(processed_dir),
        "layout_guide": None,
        "pose_guide_bbox": list(reference_bbox) if reference_bbox is not None else None,
        "motion_control_bbox": None,
        "motion_control_underlay": False,
        "reference_image": str(reference_image),
        "reference_bbox": list(reference_bbox) if reference_bbox is not None else None,
        "description": description,
        "relaxed_grid_qc": True,
        "control_profile": control_profile,
        "worker_required": False,
        "process_settings": {
            "cells": cells,
            "chroma_key": "#00ff00",
            "grid_key": "#00ffff",
            "palette": 0,
            "palette_mode": "reference_lock",
            "sample_mode": "median",
            "sample_margin_ratio": 0.40,
            "min_component_size": 4,
        },
        "status": "locked_reference",
    }
    (job_dir / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    (processed_dir / "pipeline-meta.json").write_text(
        json.dumps(
            {
                "input": str(reference_image),
                "output": str(cleaned_path),
                "mode": "locked_direct_action_keyframe",
                "score": {"score": 0.0, "quality_issues": [], "retry_hints": [], "preset": preset},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return job


def create_direct_action_plan(
    reference_image: Path,
    subject: str,
    output_dir: Path,
    *,
    frames: int = 4,
    frame_descriptions: str | None = None,
    cells: int = 64,
    target_side: int = 1024,
    workers: int = 4,
    preset: str = "fighter",
    codex_bin: str = "codex",
    relaxed_grid_qc: bool = True,
    dispatch_script: bool = True,
    control_profile: str = "green-cyan",
    lock_first_frame: bool = True,
    attempts: int = 1,
) -> dict[str, object]:
    if frames < 2:
        raise ValueError("direct action animation needs at least two frames")
    if workers <= 0:
        raise ValueError("workers must be positive")
    if attempts <= 0:
        raise ValueError("attempts must be positive")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    reference_image = reference_image.expanduser().resolve()
    if not reference_image.exists():
        raise ValueError(f"missing reference image: {reference_image}")
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "jobs").mkdir(exist_ok=True)
    descriptions = split_frame_descriptions(frame_descriptions, frames)
    ref_rgba = Image.open(reference_image).convert("RGBA")
    reference_bbox = alpha_bbox(ref_rgba)
    sequence_context: Path | None = None
    if reference_bbox is not None:
        sequence_context = create_direct_action_sequence_context(
            output_dir / "sequence-context.png",
            descriptions=descriptions,
            cells=cells,
            reference_bbox=reference_bbox,
        )
    jobs: list[dict[str, object]] = []
    start_index = 1
    if lock_first_frame:
        jobs.append(
            create_locked_direct_action_keyframe_job(
                output_dir,
                job_id="frame_01_locked",
                frame_count=frames,
                subject=subject,
                description=descriptions[0],
                cells=cells,
                preset=preset,
                reference_image=reference_image,
                reference_bbox=reference_bbox,
                control_profile=control_profile,
            )
        )
        start_index = 2
    for index in range(start_index, frames + 1):
        for attempt in range(1, attempts + 1):
            suffix = f"_a{attempt:02d}" if attempts > 1 else ""
            jobs.append(
                create_direct_action_job(
                    output_dir,
                    job_id=f"frame_{index:02d}{suffix}",
                    frame_index=index,
                    frame_count=frames,
                    attempt=attempt,
                    subject=subject,
                    description=descriptions[index - 1],
                    cells=cells,
                    target_side=target_side,
                    preset=preset,
                    reference_image=reference_image,
                    reference_bbox=reference_bbox,
                    relaxed_grid_qc=relaxed_grid_qc,
                    control_profile=control_profile,
                    sequence_context=sequence_context,
                )
            )
    plan: dict[str, object] = {
        "type": "sprite_forge_direct_action_animation",
        "subject": subject,
        "reference_image": str(reference_image),
        "reference_bbox": list(reference_bbox) if reference_bbox is not None else None,
        "sequence_context": str(sequence_context) if sequence_context else None,
        "frames": frames,
        "frame_descriptions": descriptions,
        "cells": cells,
        "target_side": target_side,
        "workers": workers,
        "attempts": attempts,
        "preset": preset,
        "relaxed_grid_qc": relaxed_grid_qc,
        "control_profile": control_profile,
        "lock_first_frame": lock_first_frame,
        "jobs": jobs,
        "stage": "frames",
        "run_dir": str(output_dir),
    }
    if dispatch_script:
        plan["dispatch_script"] = str(write_animation_dispatch_script(output_dir, jobs, workers, codex_bin))
    (output_dir / "animation-plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    return plan

def create_animation_plan(
    subject: str,
    output_dir: Path,
    *,
    frames: int = 4,
    frame_descriptions: str | None = None,
    cells: int = 32,
    target_side: int = 1024,
    workers: int = 4,
    preset: str = "item",
    codex_bin: str = "codex",
    dispatch_script: bool = True,
) -> dict[str, object]:
    if frames < 2:
        raise ValueError("animation needs at least two frames")
    if workers <= 0:
        raise ValueError("workers must be positive")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "jobs").mkdir(exist_ok=True)
    descriptions = split_frame_descriptions(frame_descriptions, frames)
    keyframe_job = create_animation_job(
        output_dir,
        job_id="frame_01_keyframe",
        frame_index=1,
        frame_count=frames,
        subject=subject,
        description=descriptions[0],
        cells=cells,
        target_side=target_side,
        preset=preset,
        keyframe=True,
    )
    plan: dict[str, object] = {
        "type": "sprite_forge_animation_loop",
        "subject": subject,
        "frames": frames,
        "frame_descriptions": descriptions,
        "cells": cells,
        "target_side": target_side,
        "workers": workers,
        "preset": preset,
        "jobs": [keyframe_job],
        "stage": "keyframe",
        "run_dir": str(output_dir),
    }
    (output_dir / "animation-plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    if dispatch_script:
        plan["dispatch_script"] = str(write_animation_dispatch_script(output_dir, [keyframe_job], 1, codex_bin))
        (output_dir / "animation-plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    return plan


def animation_cleaned_frame_path(job: dict[str, object]) -> Path:
    processed_dir = Path(str(job["processed_dir"]))
    cells = int(job["process_settings"].get("cells", 64)) if isinstance(job.get("process_settings"), dict) else 64
    candidate = processed_dir / f"cleaned_{cells}.png"
    if candidate.exists():
        return candidate
    cleaned = sorted(processed_dir.glob("cleaned_*.png"))
    return cleaned[0] if cleaned else candidate


def animation_reference_preview_path(job: dict[str, object]) -> Path:
    processed_dir = Path(str(job["processed_dir"]))
    preview = processed_dir / "preview.png"
    if preview.exists():
        return preview
    return animation_cleaned_frame_path(job)


def create_animation_followup_jobs(run_dir: Path, *, codex_bin: str = "codex") -> dict[str, object]:
    plan_path = run_dir / "animation-plan.json"
    if not plan_path.exists():
        raise ValueError(f"missing animation plan: {plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    jobs = plan.get("jobs", [])
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("animation plan has no jobs")
    keyframe_job = next((job for job in jobs if isinstance(job, dict) and job.get("kind") == "animation_keyframe"), None)
    if keyframe_job is None:
        raise ValueError("animation plan has no keyframe job")
    keyframe_path = animation_cleaned_frame_path(keyframe_job)
    if not keyframe_path.exists():
        raise ValueError(f"keyframe is not processed yet: {keyframe_path}")
    keyframe_reference_path = animation_reference_preview_path(keyframe_job)

    existing_ids = {str(job.get("id")) for job in jobs if isinstance(job, dict)}
    descriptions = [str(item) for item in plan["frame_descriptions"]]
    new_jobs: list[dict[str, object]] = []
    for index in range(2, int(plan["frames"]) + 1):
        job_id = f"frame_{index:02d}"
        if job_id in existing_ids:
            continue
        new_jobs.append(
            create_animation_job(
                run_dir,
                job_id=job_id,
                frame_index=index,
                frame_count=int(plan["frames"]),
                subject=str(plan["subject"]),
                description=descriptions[index - 1],
                cells=int(plan["cells"]),
                target_side=int(plan["target_side"]),
                preset=str(plan["preset"]),
                keyframe=False,
                reference_image=keyframe_reference_path,
                reference_bbox=alpha_bbox(Image.open(keyframe_path).convert("RGBA")),
                control_silhouette_image=keyframe_path,
            )
        )
    jobs.extend(new_jobs)
    frame_jobs = [job for job in jobs if isinstance(job, dict) and job.get("kind") == "animation_frame"]
    for job in frame_jobs:
        frame_index = int(job.get("frame_index", 1))
        reference_bbox = alpha_bbox(Image.open(keyframe_path).convert("RGBA"))
        job["reference_image"] = str(keyframe_reference_path)
        job["reference_bbox"] = list(reference_bbox) if reference_bbox is not None else None
        job["description"] = descriptions[frame_index - 1]
        if reference_bbox is not None:
            motion_bbox = create_animation_motion_control_grid(
                Path(str(job["control_grid"])),
                cells=int(plan["cells"]),
                target_side=int(plan["target_side"]),
                description=descriptions[frame_index - 1],
                reference_bbox=reference_bbox,
                silhouette_image=keyframe_path,
                settings_output=Path(str(job["settings_path"])),
                subject=f"{plan['subject']}, {descriptions[frame_index - 1]}",
            )
            job["motion_control_bbox"] = list(motion_bbox)
            job["motion_control_underlay"] = True
            guide_path = Path(str(job["dir"])) / "pose-guide.png"
            pose_bbox = create_animation_pose_guide(
                guide_path,
                cells=int(plan["cells"]),
                target_side=int(plan["target_side"]),
                description=descriptions[frame_index - 1],
                reference_bbox=reference_bbox,
            )
            job["layout_guide"] = str(guide_path)
            job["pose_guide_bbox"] = list(pose_bbox)
        prompt_path = Path(str(job["prompt_path"]))
        prompt_path.write_text(
            animation_frame_prompt(
                str(plan["subject"]),
                frame_index,
                int(plan["frames"]),
                descriptions[frame_index - 1],
                int(plan["cells"]),
                keyframe=False,
                reference_bbox=reference_bbox,
            ),
            encoding="utf-8",
        )
        Path(str(job["dir"]), "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        Path(str(job["dir"]), "worker-instructions.md").write_text(imagegen_worker_instructions(job), encoding="utf-8")
    plan["jobs"] = jobs
    plan["stage"] = "frames"
    if frame_jobs:
        plan["dispatch_script"] = str(write_animation_dispatch_script(run_dir, frame_jobs, int(plan.get("workers", 4)), codex_bin))
    plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
    return {
        "run_dir": str(run_dir),
        "created": len(new_jobs),
        "refreshed": len(frame_jobs),
        "jobs": new_jobs,
        "keyframe": str(keyframe_path),
        "reference_image": str(keyframe_reference_path),
    }


def create_animation_retry_jobs(
    run_dir: Path,
    *,
    max_retries: int = 1,
    codex_bin: str = "codex",
    pose_threshold: float | None = None,
) -> dict[str, object]:
    if max_retries <= 0:
        raise ValueError("max_retries must be positive")
    plan_path = run_dir / "animation-plan.json"
    status_path = run_dir / "animation-status.json"
    if not plan_path.exists():
        raise ValueError(f"missing animation plan: {plan_path}")
    if not status_path.exists():
        ingest_animation_plan(run_dir)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    status = json.loads(status_path.read_text(encoding="utf-8"))
    jobs = plan.get("jobs", [])
    if not isinstance(jobs, list):
        raise ValueError("animation plan jobs must be a list")
    keyframe_job = next((job for job in jobs if isinstance(job, dict) and job.get("kind") == "animation_keyframe"), None)
    if keyframe_job is None:
        raise ValueError("animation plan has no keyframe job")
    keyframe_path = animation_cleaned_frame_path(keyframe_job)
    if not keyframe_path.exists():
        raise ValueError(f"keyframe is not processed yet: {keyframe_path}")
    keyframe_reference_path = animation_reference_preview_path(keyframe_job)
    descriptions = [str(item) for item in plan["frame_descriptions"]]
    by_frame: dict[int, list[dict[str, object]]] = {}
    for job in jobs:
        if isinstance(job, dict):
            by_frame.setdefault(int(job.get("frame_index", 0)), []).append(job)
    summaries = status.get("jobs", [])
    failed_by_frame: dict[int, list[str]] = {}
    for summary in summaries if isinstance(summaries, list) else []:
        if not isinstance(summary, dict):
            continue
        frame_index = int(summary.get("frame_index", 0))
        grid_qc = summary.get("grid_qc", {})
        if isinstance(grid_qc, dict) and not bool(grid_qc.get("passes", True)):
            blocking = grid_qc.get("blocking_issues", grid_qc.get("issues", []))
            failed_by_frame.setdefault(frame_index, []).extend(str(issue) for issue in blocking)
        frame_qc = summary.get("frame_qc", {})
        if isinstance(frame_qc, dict) and not bool(frame_qc.get("passes", True)):
            blocking = frame_qc.get("blocking_issues", frame_qc.get("issues", []))
            failed_by_frame.setdefault(frame_index, []).extend(str(issue) for issue in blocking)
        if pose_threshold is not None and frame_index > 1 and bool(summary.get("accepted", False)):
            pose_score = summary.get("pose_score", {})
            pose_value = float(pose_score.get("score", 1000.0)) if isinstance(pose_score, dict) else 1000.0
            if pose_value < pose_threshold:
                kind = str(pose_score.get("kind", "pose")) if isinstance(pose_score, dict) else "pose"
                failed_by_frame.setdefault(frame_index, []).append(f"pose_score:{pose_value:.1f} below {pose_threshold:.1f} ({kind})")
    new_jobs: list[dict[str, object]] = []
    for frame_index, issues in sorted(failed_by_frame.items()):
        if frame_index <= 1:
            continue
        existing = by_frame.get(frame_index, [])
        retry_count = sum(1 for job in existing if "_retry" in str(job.get("id", "")))
        if retry_count >= max_retries:
            continue
        retry_index = retry_count + 1
        job = create_animation_job(
            run_dir,
            job_id=f"frame_{frame_index:02d}_retry{retry_index:02d}",
            frame_index=frame_index,
            frame_count=int(plan["frames"]),
            subject=str(plan["subject"]),
            description=descriptions[frame_index - 1],
            cells=int(plan["cells"]),
            target_side=int(plan["target_side"]),
            preset=str(plan["preset"]),
            keyframe=False,
            reference_image=keyframe_reference_path,
            reference_bbox=alpha_bbox(Image.open(keyframe_path).convert("RGBA")),
            control_silhouette_image=keyframe_path,
            retry_notes="; ".join(sorted(set(issues))),
        )
        new_jobs.append(job)
        jobs.append(job)
    plan["jobs"] = jobs
    if new_jobs:
        plan["stage"] = "retry"
        plan["dispatch_script"] = str(write_animation_dispatch_script(run_dir, new_jobs, int(plan.get("workers", 4)), codex_bin))
    plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
    return {"run_dir": str(run_dir), "created": len(new_jobs), "jobs": new_jobs}


def ingest_animation_plan(run_dir: Path) -> dict[str, object]:
    plan_path = run_dir / "animation-plan.json"
    if not plan_path.exists():
        raise ValueError(f"missing animation plan: {plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    jobs = plan.get("jobs", [])
    if not isinstance(jobs, list):
        raise ValueError("animation plan jobs must be a list")
    reference_palette: tuple[RGB, ...] = ()
    reference_frame: Image.Image | None = None
    reference_image = plan.get("reference_image")
    if reference_image:
        reference_path = Path(str(reference_image))
        if reference_path.exists():
            reference_frame = Image.open(reference_path).convert("RGBA")
            reference_palette = extract_full_palette(reference_frame)
    summaries: list[dict[str, object]] = []
    accepted_by_frame: dict[int, tuple[float, Path, dict[str, object]]] = {}
    for job in jobs:
        if not isinstance(job, dict):
            continue
        raw_path = Path(str(job["raw_path"]))
        processed_dir = Path(str(job["processed_dir"]))
        summary: dict[str, object] = {"id": job["id"], "frame_index": job["frame_index"], "raw_path": str(raw_path), "processed_dir": str(processed_dir)}
        if not raw_path.exists():
            summary["status"] = "waiting_for_raw"
            summaries.append(summary)
            continue
        cleaned_path = animation_cleaned_frame_path(job)
        if not cleaned_path.exists():
            settings = job["process_settings"]
            try:
                job_mode = str(job.get("mode", ""))
                cleanup_palette = 0 if reference_palette and job_mode.startswith("direct_action") else int(settings.get("palette", 18))
                process_single_sprite(
                    raw_path,
                    processed_dir,
                    ForgeOptions(
                        cells=int(settings.get("cells", 32)),
                        palette=cleanup_palette,
                        transparent=True,
                        chroma_key=parse_rgb(str(settings.get("chroma_key", "#ff00ff"))),
                        grid_key=parse_rgb(str(settings.get("grid_key", "#00ffff"))),
                        sample_mode=str(settings.get("sample_mode", "median")),
                        sample_margin_ratio=float(settings.get("sample_margin_ratio", 0.40)),
                        min_component_size=int(settings.get("min_component_size", 4)),
                        preset=str(job.get("preset", "item")),
                        strip_edge_background=True,
                        palette_colors=(
                            reference_palette
                            if str(job.get("mode", "")).startswith("direct_action") and len(reference_palette) <= 256
                            else ()
                        ),
                    ),
                    prompt_file=Path(str(job["prompt_path"])),
                )
            except Exception as exc:  # noqa: BLE001
                summary.update({"status": "processing_failed", "error": str(exc)})
                summaries.append(summary)
                continue
        cleaned_path = animation_cleaned_frame_path(job)
        if cleaned_path.exists():
            if job.get("mode") == "direct_action_locked_keyframe" and reference_image:
                reference_path = Path(str(reference_image))
                if reference_path.exists():
                    Image.open(reference_path).convert("RGBA").save(cleaned_path)
            if reference_palette and str(job.get("mode", "")).startswith("direct_action"):
                cleaned_image = Image.open(cleaned_path).convert("RGBA")
                if reference_frame is not None and job.get("mode") != "direct_action_locked_keyframe":
                    cleaned_image = apply_reference_color_transfer(cleaned_image, reference_frame)
                apply_palette_lock(cleaned_image, reference_palette).save(cleaned_path)
            meta_path = processed_dir / "pipeline-meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
            score_payload = meta.get("score", {}) if isinstance(meta, dict) else {}
            issues = score_payload.get("quality_issues", []) if isinstance(score_payload, dict) else []
            frame_qc = {"passes": True, "issues": [], "bounds": {}, "bbox": None}
            if job.get("kind") == "animation_frame" and not bool(job.get("relaxed_grid_qc", False)):
                grid_qc = animation_grid_fidelity_qc(job, raw_path)
            elif job.get("kind") == "animation_frame" and bool(job.get("relaxed_grid_qc", False)):
                detected_grid_qc = animation_grid_fidelity_qc(job, raw_path)
                grid_qc = {
                    **detected_grid_qc,
                    "passes": True,
                    "relaxed": True,
                    "warnings": detected_grid_qc.get("issues", []),
                    "blocking_issues": [],
                    "issues": detected_grid_qc.get("issues", []),
                }
            else:
                grid_qc = {"passes": True, "blocking_issues": [], "warnings": [], "issues": [], "grid_detection": None}
            if job.get("kind") == "animation_frame":
                frame_qc = animation_frame_contract_qc(job, cleaned_path)
            pose_score = animation_pose_score(job, cleaned_path)
            motion_qc = direct_action_motion_qc(job, cleaned_path)
            frame_passes = bool(frame_qc.get("passes", True)) and bool(grid_qc.get("passes", True))
            quality_score = float(score_payload.get("score", 0.0)) if isinstance(score_payload, dict) else 0.0
            pose_value = float(pose_score.get("score", 0.0)) if isinstance(pose_score, dict) else 0.0
            motion_value = float(motion_qc.get("score", 100.0)) if isinstance(motion_qc, dict) else 100.0
            if job.get("mode") == "direct_action_frame":
                selection_score = round(pose_value * 1.25 + motion_value * 18.0 + quality_score * 0.18, 3)
            else:
                selection_score = round(pose_value * 2.0 + quality_score * 0.25, 3)
            summary.update(
                {
                    "status": "processed",
                    "cleaned": str(cleaned_path),
                    "passes": frame_passes and not issues,
                    "accepted": frame_passes,
                    "score": score_payload,
                    "pose_score": pose_score,
                    "motion_qc": motion_qc,
                    "selection_score": selection_score,
                    "grid_qc": grid_qc,
                    "frame_qc": frame_qc,
                }
            )
            if frame_passes:
                frame_index = int(job["frame_index"])
                current = accepted_by_frame.get(frame_index)
                if current is None or selection_score > current[0]:
                    accepted_by_frame[frame_index] = (selection_score, cleaned_path, summary)
        summaries.append(summary)

    expected = int(plan["frames"])
    final_payload: dict[str, object] | None = None
    if all(index in accepted_by_frame for index in range(1, expected + 1)):
        cleaned_paths = [accepted_by_frame[index][1] for index in range(1, expected + 1)]
        final_payload = assemble_animation_frames(
            cleaned_paths,
            run_dir / "final",
            cols=expected,
            gif_duration=140,
            palette_colors=reference_palette,
            palette_source=reference_image,
        )

    status = {
        "run_dir": str(run_dir),
        "total_jobs": len(summaries),
        "waiting": sum(1 for item in summaries if item.get("status") == "waiting_for_raw"),
        "processed": sum(1 for item in summaries if item.get("status") == "processed"),
        "accepted": sum(1 for item in summaries if item.get("accepted")),
        "failed": sum(1 for item in summaries if item.get("status") == "processing_failed"),
        "missing_accepted_frames": [index for index in range(1, expected + 1) if index not in accepted_by_frame],
        "selected_frames": {
            str(index): {
                "score": accepted_by_frame[index][0],
                "cleaned": str(accepted_by_frame[index][1]),
                "job_id": accepted_by_frame[index][2].get("id"),
                "pose_score": accepted_by_frame[index][2].get("pose_score"),
                "motion_qc": accepted_by_frame[index][2].get("motion_qc"),
            }
            for index in sorted(accepted_by_frame)
        },
        "jobs": summaries,
        "final": final_payload,
    }
    (run_dir / "animation-status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    return status


def animation_render_worker_instructions(job: dict[str, object]) -> str:
    prompt_path = Path(str(job["prompt_path"]))
    raw_path = Path(str(job["raw_path"]))
    image_lines = []
    if job.get("rough_frame_ref"):
        image_lines.append(f"- Rough pose/reference control-grid frame: `{Path(str(job['rough_frame_ref'])).resolve()}`")
    if job.get("current_frame_ref"):
        image_lines.append(f"- Latest edited identity keyframe control-grid reference: `{Path(str(job['current_frame_ref'])).resolve()}`")
    if job.get("rig_composite_ref"):
        image_lines.append(f"- Rig composite mask/reference control-grid frame: `{Path(str(job['rig_composite_ref'])).resolve()}`")
    image_block = "\n".join(image_lines) if image_lines else "- No images were attached."
    return "\n".join(
        [
            "# Sprite Forge Animation Render Worker",
            "",
            "You are one isolated Codex/imagegen worker. Generate exactly one final rendered animation frame for this approved rough rig pass.",
            "",
            "Rules:",
            "- Do not edit Sprite Forge code.",
            "- Use imagegen once for this frame, unless the generation tool itself fails.",
            "- Use the rough pose frame for pose/timing/composition.",
            "- Use the edited keyframe for identity, palette family, outline style, and pixel scale.",
            "- Use rig metadata/mask only as structural context for part relationships.",
            "- Attached references are normalized control-grid images: magenta is the removable background, cyan grid lines are construction guides.",
            "- Align the final silhouette, limbs, and pixel clusters to the same grid-cell positions as the rough/control references.",
            "- Do not copy cyan grid lines into the character; the final sprite should be clean pixel art on flat #FF00FF.",
            "- Treat rough-frame holes, seams, transparent gaps, duplicated edges, and layer-transform artifacts as temporary rig draft defects.",
            "- Fill those draft gaps in the final rendered sprite so the character is solid, readable, and clean.",
            "- Return one frame, not a sheet, not variants, not a contact sheet.",
            "- Keep clean real pixel art: hard square pixels, no anti-aliasing, no blur, no UI labels, no grid lines.",
            "- Output on a perfectly flat solid #FF00FF chroma-key background. Do not output white/gray/checkerboard/paper/texture backgrounds.",
            "- Keep visible #FF00FF padding on all four sides; no body, hair, shoes, or clothing may touch the canvas edge.",
            "- Preserve the edited keyframe palette and contrast; do not wash the sprite out into mostly white/highlight colors.",
            "- Keep the character/object centered in the same camera and preserve the rough animation intent.",
            "- After imagegen finishes, copy the newest generated image from `${CODEX_HOME:-$HOME/.codex}/generated_images` to the required raw output path.",
            "- Verify the raw output exists with `test -s` before saying the job is complete.",
            "",
            "Attached/available context:",
            image_block,
            "",
            f"Prompt file: `{prompt_path.resolve()}`",
            f"Required raw output path: `{raw_path.resolve()}`",
            "",
            "Required finalization command after imagegen:",
            "",
            "```bash",
            "latest=$(find \"${CODEX_HOME:-$HOME/.codex}/generated_images\" -type f \\( -name '*.png' -o -name '*.webp' -o -name '*.jpg' -o -name '*.jpeg' \\) -print0 | xargs -0 ls -t | head -n 1)",
            f"cp \"$latest\" {shlex.quote(str(raw_path.resolve()))}",
            f"test -s {shlex.quote(str(raw_path.resolve()))}",
            "```",
            "",
            "Prompt to use:",
            "",
            "```text",
            prompt_path.read_text(encoding="utf-8"),
            "```",
            "",
        ]
    )


def write_animation_render_dispatch_script(job_dir: Path, jobs: list[dict[str, object]], workers: int, codex_bin: str) -> Path:
    script_path = job_dir / "run-render-workers.sh"
    quoted_jobs = " ".join(shlex.quote(str(Path(str(job["dir"])) / "worker-instructions.md")) for job in jobs)
    jobs_json = shlex.quote(json.dumps(jobs))
    script = f"""#!/usr/bin/env bash
set -euo pipefail

ROOT={shlex.quote(str(Path.cwd()))}
JOB_DIR={shlex.quote(str(job_dir))}
CODEX_BIN="${{CODEX_BIN:-{shlex.quote(codex_bin)}}}"
WORKERS="${{SPRITE_FORGE_WORKERS:-{workers}}}"
BASE_CODEX_HOME="${{CODEX_HOME:-$HOME/.codex}}"
JOBS_JSON={jobs_json}

jobs=({quoted_jobs})

prepare_worker_home() {{
  local worker_home="$1"
  rm -rf "$worker_home/generated_images"
  mkdir -p "$worker_home/generated_images"
  for entry in auth.json config.toml AGENTS.md RTK.md skills cache plugins vendor_imports tools; do
    if [ -e "$BASE_CODEX_HOME/$entry" ] && [ ! -e "$worker_home/$entry" ]; then
      ln -s "$BASE_CODEX_HOME/$entry" "$worker_home/$entry"
    fi
  done
}}

image_args_for_job() {{
  local job_dir="$1"
  python3 - "$job_dir" "$JOBS_JSON" <<'PY'
import json, shlex, sys
job_dir = sys.argv[1]
for job in json.loads(sys.argv[2]):
    if job.get("dir") != job_dir:
        continue
    for key in ("rough_frame_ref", "current_frame_ref", "rig_composite_ref"):
        path = job.get(key)
        if path:
            print("--image " + shlex.quote(str(path)), end=" ")
    break
PY
}}

for instruction in "${{jobs[@]}}"; do
  frame_job_dir="$(dirname "$instruction")"
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$WORKERS" ]; do
    sleep 2
  done
  worker_home="$frame_job_dir/.codex-worker-home"
  prepare_worker_home "$worker_home"
  image_args="$(image_args_for_job "$frame_job_dir")"
  CODEX_HOME="$worker_home" "$CODEX_BIN" exec -C "$ROOT" $image_args --dangerously-bypass-approvals-and-sandbox "$(cat "$instruction")" > "$frame_job_dir/codex-worker.log" 2>&1 &
done

wait
python3 "$ROOT/sprite_forge.py" animation-render-ingest "$JOB_DIR"
"""
    script_path.write_text(script, encoding="utf-8")
    script_path.chmod(0o755)
    return script_path


def render_sheet_layout(frame_count: int) -> tuple[int, int]:
    if frame_count <= 0:
        raise ValueError("frame_count must be positive")
    if frame_count <= 1:
        return 1, 1
    if frame_count <= 4:
        return 2, 2
    if frame_count <= 6:
        return 2, 3
    if frame_count <= 9:
        return 3, 3
    if frame_count <= 12:
        return 3, 4
    return 4, 4


def compose_render_control_sheet(
    frame_paths: list[Path],
    output_path: Path,
    *,
    rows: int,
    cols: int,
    cells: int,
    target_side: int,
    background: RGB = (255, 0, 255),
    grid_color: RGB = (0, 255, 255),
) -> Path:
    if rows <= 0 or cols <= 0:
        raise ValueError("rows and cols must be positive")
    if len(frame_paths) > rows * cols:
        raise ValueError("too many frames for sheet layout")
    sheet = Image.new("RGB", (cols * target_side, rows * target_side), background)
    for index in range(rows * cols):
        row, col = divmod(index, cols)
        if index < len(frame_paths):
            source = frame_paths[index]
            tile_path = output_path.parent / f".{output_path.stem}-tile-{index + 1:02d}.png"
            tile = Image.open(
                flatten_render_reference(
                    source,
                    tile_path,
                    cells=cells,
                    target_side=target_side,
                    background=background,
                    grid_color=grid_color,
                )
            ).convert("RGB")
            try:
                tile_path.unlink()
            except FileNotFoundError:
                pass
        else:
            tile = draw_real_grid(Image.new("RGB", (target_side, target_side), background), cells, grid_color, 1)
        sheet.paste(tile, (col * target_side, row * target_side))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)
    return output_path


def animation_render_sheet_worker_instructions(job: dict[str, object]) -> str:
    prompt_path = Path(str(job["prompt_path"]))
    raw_path = Path(str(job["raw_path"]))
    image_lines = []
    if job.get("rough_sheet_ref"):
        image_lines.append(f"- User-approved rough animation control sheet: `{Path(str(job['rough_sheet_ref'])).resolve()}`")
    if job.get("current_frame_ref"):
        image_lines.append(f"- Edited identity keyframe control-grid reference: `{Path(str(job['current_frame_ref'])).resolve()}`")
    if job.get("rig_composite_ref"):
        image_lines.append(f"- Rig composite control-grid reference: `{Path(str(job['rig_composite_ref'])).resolve()}`")
    image_block = "\n".join(image_lines) if image_lines else "- No images were attached."
    return "\n".join(
        [
            "# Sprite Forge Animation Sheet Render Worker",
            "",
            "You are one isolated Codex/imagegen worker. Generate exactly one full animation sheet candidate, not separate frames.",
            "",
            "Rules:",
            "- Do not edit Sprite Forge code.",
            "- Use imagegen once for the full sheet candidate.",
            "- Keep the exact 2D sheet layout from the rough control sheet: same rows, same columns, same frame order.",
            "- Treat the rough sheet as the source of truth for pose, timing, silhouette placement, bbox, and per-frame motion.",
            "- Treat the edited keyframe as the source of truth for identity, palette, outline weight, and pixel-art style.",
            "- This is a style-preserving refinement pass, not a redraw-from-scratch pass.",
            "- Preserve the rough animation: frame-to-frame body height, squash/lift, hand/leg placement, head offset, and feet anchors must follow the rough sheet.",
            "- Only fix draft defects: transparent holes, seams, pasted-layer gaps, duplicated edges, broken pixels, and mask cut artifacts.",
            "- Keep all frames in one coherent style with one camera, one palette, and one pixel scale.",
            "- Use the cyan grid in the references only as a construction guide; do not paint cyan grid lines into the character.",
            "- Output a clean full sheet on a flat solid #FF00FF background, with no labels, borders, gutters, checkerboard, paper, scenery, shadows, or glow.",
            "- Do not change action, pose sequence, costume, face style, or character proportions.",
            "- After imagegen finishes, copy the newest generated image from `${CODEX_HOME:-$HOME/.codex}/generated_images` to the required raw output path.",
            "- Verify the raw output exists with `test -s` before saying the job is complete.",
            "",
            "Attached/available context:",
            image_block,
            "",
            f"Prompt file: `{prompt_path.resolve()}`",
            f"Required raw sheet output path: `{raw_path.resolve()}`",
            "",
            "Required finalization command after imagegen:",
            "",
            "```bash",
            "latest=$(find \"${CODEX_HOME:-$HOME/.codex}/generated_images\" -type f \\( -name '*.png' -o -name '*.webp' -o -name '*.jpg' -o -name '*.jpeg' \\) -print0 | xargs -0 ls -t | head -n 1)",
            f"cp \"$latest\" {shlex.quote(str(raw_path.resolve()))}",
            f"test -s {shlex.quote(str(raw_path.resolve()))}",
            "```",
            "",
            "Prompt to use:",
            "",
            "```text",
            prompt_path.read_text(encoding="utf-8"),
            "```",
            "",
        ]
    )


def write_animation_render_sheet_dispatch_script(job_dir: Path, jobs: list[dict[str, object]], workers: int, codex_bin: str) -> Path:
    script_path = job_dir / "run-render-workers.sh"
    quoted_jobs = " ".join(shlex.quote(str(Path(str(job["dir"])) / "worker-instructions.md")) for job in jobs)
    jobs_json = shlex.quote(json.dumps(jobs))
    python_bin = shlex.quote(sys.executable)
    script = f"""#!/usr/bin/env bash
set -euo pipefail

ROOT={shlex.quote(str(Path.cwd()))}
JOB_DIR={shlex.quote(str(job_dir))}
CODEX_BIN="${{CODEX_BIN:-{shlex.quote(codex_bin)}}}"
WORKERS="${{SPRITE_FORGE_WORKERS:-{workers}}}"
BASE_CODEX_HOME="${{CODEX_HOME:-$HOME/.codex}}"
PYTHON_BIN="${{PYTHON_BIN:-{python_bin}}}"
JOBS_JSON={jobs_json}

jobs=({quoted_jobs})

prepare_worker_home() {{
  local worker_home="$1"
  rm -rf "$worker_home/generated_images"
  mkdir -p "$worker_home/generated_images"
  for entry in auth.json config.toml AGENTS.md RTK.md skills cache plugins vendor_imports tools; do
    if [ -e "$BASE_CODEX_HOME/$entry" ] && [ ! -e "$worker_home/$entry" ]; then
      ln -s "$BASE_CODEX_HOME/$entry" "$worker_home/$entry"
    fi
  done
}}

image_args_for_job() {{
  local job_dir="$1"
  "$PYTHON_BIN" - "$job_dir" "$JOBS_JSON" <<'PY'
import json, shlex, sys
job_dir = sys.argv[1]
for job in json.loads(sys.argv[2]):
    if job.get("dir") != job_dir:
        continue
    for key in ("rough_sheet_ref", "current_frame_ref", "rig_composite_ref"):
        path = job.get(key)
        if path:
            print("--image " + shlex.quote(str(path)), end=" ")
    break
PY
}}

for instruction in "${{jobs[@]}}"; do
  frame_job_dir="$(dirname "$instruction")"
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$WORKERS" ]; do
    sleep 2
  done
  worker_home="$frame_job_dir/.codex-worker-home"
  prepare_worker_home "$worker_home"
  image_args="$(image_args_for_job "$frame_job_dir")"
  CODEX_HOME="$worker_home" "$CODEX_BIN" exec -C "$ROOT" $image_args --dangerously-bypass-approvals-and-sandbox "$(cat "$instruction")" > "$frame_job_dir/codex-worker.log" 2>&1 &
done

wait
"$PYTHON_BIN" "$ROOT/sprite_forge.py" animation-render-ingest "$JOB_DIR"
"""
    script_path.write_text(script, encoding="utf-8")
    script_path.chmod(0o755)
    return script_path


def infer_render_job_cells(job_dir: Path, requested: int | None = None) -> int:
    if requested and requested > 0:
        return requested
    for candidate in (job_dir / "current-frame.png", *(sorted((job_dir / "frames").glob("*.png")) if (job_dir / "frames").is_dir() else [])):
        if candidate.exists():
            image = Image.open(candidate)
            return max(image.size)
    return 64


def flatten_render_reference(
    input_path: Path,
    output_path: Path,
    *,
    cells: int,
    target_side: int,
    background: RGB = (255, 0, 255),
    grid_color: RGB = (0, 255, 255),
    grid_line_width: int = 1,
) -> Path:
    source = Image.open(input_path).convert("RGBA")
    if cells <= 0:
        raise ValueError("cells must be positive")
    if target_side <= 0:
        raise ValueError("target_side must be positive")
    if target_side % cells:
        target_side = ((target_side + cells - 1) // cells) * cells

    normalized = source
    if source.size != (cells, cells):
        normalized = source.resize((cells, cells), Image.Resampling.NEAREST)

    flattened = Image.new("RGBA", (cells, cells), (*background, 255))
    flattened.alpha_composite(normalized)
    enlarged = flattened.resize((target_side, target_side), Image.Resampling.NEAREST).convert("RGB")
    enlarged = draw_real_grid(enlarged, cells, grid_color, grid_line_width)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    enlarged.save(output_path)
    return output_path


def describe_approved_keyframe_palette(keyframe_path: Path | None, *, max_colors: int = 18) -> str:
    if keyframe_path is None or not keyframe_path.exists():
        return "Approved keyframe palette: use the attached edited keyframe as the source of truth for palette, outline weight, contrast, and color temperature."

    palette = tuple(
        color
        for color in extract_palette(Image.open(keyframe_path).convert("RGBA"), max_colors=max_colors)
        if color not in {(255, 0, 255), (0, 255, 255)}
    )
    if not palette:
        return "Approved keyframe palette: use the attached edited keyframe as the source of truth for palette, outline weight, contrast, and color temperature."

    def hex_list(colors: tuple[RGB, ...], limit: int = 6) -> str:
        return ", ".join(rgb_to_hex(color) for color in colors[:limit])

    by_luma = tuple(sorted(palette, key=color_luma))
    darkest = tuple(color for color in by_luma if color_luma(color) < 110)[:3] or by_luma[:1]
    highlights = tuple(color for color in palette if color_luma(color) >= 185)
    shadows = tuple(color for color in palette if color_luma(color) < 105)
    accents = tuple(color for color in palette if color_chroma(color) >= 70 and color not in darkest)
    midtones = tuple(color for color in palette if color not in darkest and color not in highlights and color not in accents)

    parts = [f"Approved keyframe palette ({len(palette)} visible colors): {hex_list(palette, 10)}."]
    if darkest:
        parts.append(f"Outline/dark clusters: {hex_list(darkest, 3)}.")
    if shadows:
        parts.append(f"Shadows: {hex_list(shadows, 5)}.")
    if midtones:
        parts.append(f"Midtones/material colors: {hex_list(midtones, 6)}.")
    if highlights:
        parts.append(f"Highlights: {hex_list(highlights, 5)}.")
    if accents:
        parts.append(f"Accent colors to preserve when they appear locally: {hex_list(accents, 6)}.")
    parts.append("Sample from these approved colors and their close neighbors; do not invent a washed-out, white-heavy, or unrelated palette.")
    return " ".join(parts)


def strip_render_edge_background(input_path: Path, output_path: Path) -> Path:
    raw = Image.open(input_path).convert("RGBA")
    stripped = strip_edge_background(
        raw,
        ForgeOptions(
            cells=max(raw.size),
            transparent=True,
            chroma_key=(255, 0, 255),
            chroma_tolerance=128,
            grid_key=(0, 255, 255),
            grid_tolerance=128,
            strip_edge_background=True,
            strip_edge_tolerance=92,
            preset="fighter",
        ),
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    stripped.save(output_path)
    return output_path


def prepare_animation_render_sheet_job(
    job_dir: Path,
    *,
    cells: int | None = None,
    workers: int = 4,
    candidates: int | None = None,
    preset: str = "fighter",
    codex_bin: str = "codex",
    dispatch_script: bool = True,
) -> dict[str, object]:
    manifest_path = job_dir / "job.json"
    if not manifest_path.exists():
        raise ValueError(f"missing render job manifest: {manifest_path}")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    prompt_base = (job_dir / "prompt-used.txt").read_text(encoding="utf-8") if (job_dir / "prompt-used.txt").exists() else ""
    target_cells = infer_render_job_cells(job_dir, cells)
    render_ref_side = max(512, min(1024, target_cells * 8))
    if render_ref_side % target_cells:
        render_ref_side = ((render_ref_side + target_cells - 1) // target_cells) * target_cells
    frames_dir = job_dir / "frames"
    rough_frames = sorted(frames_dir.glob("*.png")) if frames_dir.is_dir() else []
    if not rough_frames:
        raise ValueError(f"render job has no rough frames: {frames_dir}")
    rows, cols = render_sheet_layout(len(rough_frames))
    refs_dir = job_dir / "sheet-references"
    refs_dir.mkdir(exist_ok=True)
    rough_sheet_ref = compose_render_control_sheet(
        rough_frames,
        refs_dir / f"rough-animation-{rows}x{cols}-control-grid.png",
        rows=rows,
        cols=cols,
        cells=target_cells,
        target_side=render_ref_side,
    )
    current_frame = job_dir / "current-frame.png"
    rig_composite = job_dir / "rig-composite.png"
    static_part_masks = sorted(
        path.resolve()
        for path in (job_dir / "masks").glob("*.mask.png")
        if any(token in path.name for token in ("lower_leg", "foot"))
    )
    current_ref = (
        flatten_render_reference(
            current_frame,
            refs_dir / "current-frame-control-grid.png",
            cells=target_cells,
            target_side=render_ref_side,
        )
        if current_frame.exists()
        else None
    )
    rig_ref = (
        flatten_render_reference(
            rig_composite,
            refs_dir / "rig-composite-control-grid.png",
            cells=target_cells,
            target_side=render_ref_side,
        )
        if rig_composite.exists()
        else None
    )
    palette_description = describe_approved_keyframe_palette(current_frame if current_frame.exists() else None)

    candidate_count = max(1, candidates if candidates is not None else workers)
    jobs_dir = job_dir / "sheet-jobs"
    jobs_dir.mkdir(exist_ok=True)
    render_jobs: list[dict[str, object]] = []
    prompt = "\n".join(
        [
            prompt_base.strip(),
            "",
            f"Render one complete {rows}x{cols} animation sheet with {len(rough_frames)} frames.",
            "Frame order is row-major: frame 1 top-left, frame 2 top-right, then next row.",
            "The rough animation control sheet is the source of truth. Preserve its exact motion, bbox rhythm, feet anchors, and per-frame silhouette placement.",
            "This is not a new animation. This is a style-preserving cleanup/refinement pass over the approved rough animation.",
            "Keep the same pose in every cell as the corresponding rough cell. Do not average frames, do not invent new poses, do not redraw the character into a different stance.",
            "Repair only draft defects: holes, seams, broken pixels, mask gaps, and duplicated layer edges.",
            "Keep one consistent sprite style, one camera, one outline weight, one palette, and one pixel scale across all cells.",
            "Use the edited keyframe for identity/style and the rough sheet for pose/timing.",
            "Use the cyan grid only as a construction guide. The final sheet must have clean sprites on flat #FF00FF only.",
            "Do not output labels, text, borders, gutters, checkerboard, scenery, shadows, glow, or a changed background.",
            "Keep every frame inside its cell safe area with visible #FF00FF padding.",
            palette_description,
            "",
        ]
    )
    for index in range(1, candidate_count + 1):
        candidate_dir = jobs_dir / f"sheet_candidate_{index:02d}"
        candidate_dir.mkdir(parents=True, exist_ok=True)
        prompt_path = candidate_dir / "prompt-used.txt"
        raw_path = candidate_dir / "raw-sheet.png"
        processed_dir = candidate_dir / "processed"
        prompt_path.write_text(prompt + f"Candidate {index}: prioritize pose preservation over beautification.\n", encoding="utf-8")
        job: dict[str, object] = {
            "id": f"sheet_candidate_{index:02d}",
            "candidate_index": index,
            "kind": "animation_render_sheet",
            "dir": str(candidate_dir),
            "rough_frames": [str(path.resolve()) for path in rough_frames],
            "current_frame": str(current_frame.resolve()) if current_frame.exists() else None,
            "rig_composite": str(rig_composite.resolve()) if rig_composite.exists() else None,
            "static_part_masks": [str(path) for path in static_part_masks],
            "rough_sheet_ref": str(rough_sheet_ref.resolve()),
            "current_frame_ref": str(current_ref.resolve()) if current_ref else None,
            "rig_composite_ref": str(rig_ref.resolve()) if rig_ref else None,
            "prompt_path": str(prompt_path.resolve()),
            "raw_path": str(raw_path.resolve()),
            "processed_dir": str(processed_dir.resolve()),
            "rows": rows,
            "cols": cols,
            "frame_count": len(rough_frames),
            "cells": target_cells,
            "render_reference_side": render_ref_side,
            "render_reference_background": "#FF00FF",
            "render_reference_grid": "#00FFFF",
            "preset": preset,
            "status": "pending_generation",
        }
        (candidate_dir / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        (candidate_dir / "worker-instructions.md").write_text(animation_render_sheet_worker_instructions(job), encoding="utf-8")
        render_jobs.append(job)

    plan: dict[str, object] = {
        "type": "sprite_forge_animation_render_pass",
        "render_mode": "sheet",
        "source_manifest": manifest,
        "job_dir": str(job_dir.resolve()),
        "cells": target_cells,
        "rows": rows,
        "cols": cols,
        "frame_count": len(rough_frames),
        "render_reference_side": render_ref_side,
        "render_reference_background": "#FF00FF",
        "render_reference_grid": "#00FFFF",
        "rough_sheet_ref": str(rough_sheet_ref.resolve()),
        "preset": preset,
        "workers": workers,
        "candidates": candidate_count,
        "jobs": render_jobs,
        "stage": "prepared",
    }
    if dispatch_script:
        plan["dispatch_script"] = str(write_animation_render_sheet_dispatch_script(job_dir, render_jobs, workers, codex_bin))
    (job_dir / "render-plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    return plan


def prepare_animation_render_job(
    job_dir: Path,
    *,
    cells: int | None = None,
    workers: int = 4,
    candidates: int | None = None,
    mode: str = "sheet",
    preset: str = "fighter",
    codex_bin: str = "codex",
    dispatch_script: bool = True,
) -> dict[str, object]:
    if mode == "sheet":
        return prepare_animation_render_sheet_job(
            job_dir,
            cells=cells,
            workers=workers,
            candidates=candidates,
            preset=preset,
            codex_bin=codex_bin,
            dispatch_script=dispatch_script,
        )
    if mode != "frames":
        raise ValueError("mode must be sheet or frames")
    manifest_path = job_dir / "job.json"
    if not manifest_path.exists():
        raise ValueError(f"missing render job manifest: {manifest_path}")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    prompt_base = (job_dir / "prompt-used.txt").read_text(encoding="utf-8") if (job_dir / "prompt-used.txt").exists() else ""
    draft_path = job_dir / "animation-draft.json"
    draft = json.loads(draft_path.read_text(encoding="utf-8")) if draft_path.exists() else {"frames": {}}
    target_cells = infer_render_job_cells(job_dir, cells)
    render_ref_side = max(768, min(1536, target_cells * 10))
    if render_ref_side % target_cells:
        render_ref_side = ((render_ref_side + target_cells - 1) // target_cells) * target_cells
    frames_dir = job_dir / "frames"
    rough_frames = sorted(frames_dir.glob("*.png")) if frames_dir.is_dir() else []
    if not rough_frames:
        raise ValueError(f"render job has no rough frames: {frames_dir}")
    jobs_dir = job_dir / "jobs"
    jobs_dir.mkdir(exist_ok=True)
    current_frame = job_dir / "current-frame.png"
    rig_composite = job_dir / "rig-composite.png"
    palette_description = describe_approved_keyframe_palette(current_frame if current_frame.exists() else None)
    frame_drafts = draft.get("frames", {}) if isinstance(draft, dict) else {}
    render_jobs: list[dict[str, object]] = []
    total = len(rough_frames)
    for index, rough_frame in enumerate(rough_frames, start=1):
        frame_job_dir = jobs_dir / f"frame_{index:02d}"
        frame_job_dir.mkdir(parents=True, exist_ok=True)
        refs_dir = frame_job_dir / "references"
        prompt_path = frame_job_dir / "prompt-used.txt"
        raw_path = frame_job_dir / "raw.png"
        processed_dir = frame_job_dir / "processed"
        rough_ref = flatten_render_reference(
            rough_frame,
            refs_dir / "rough-frame-control-grid.png",
            cells=target_cells,
            target_side=render_ref_side,
        )
        current_ref = (
            flatten_render_reference(
                current_frame,
                refs_dir / "current-frame-control-grid.png",
                cells=target_cells,
                target_side=render_ref_side,
            )
            if current_frame.exists()
            else None
        )
        rig_ref = (
            flatten_render_reference(
                rig_composite,
                refs_dir / "rig-composite-control-grid.png",
                cells=target_cells,
                target_side=render_ref_side,
            )
            if rig_composite.exists()
            else None
        )
        source_frame_key = next(
            (
                key
                for key in frame_drafts
                if Path(str(key)).name == rough_frame.name
            ),
            rough_frame.name,
        )
        transform_payload = frame_drafts.get(source_frame_key, {}) if isinstance(frame_drafts, dict) else {}
        prompt = "\n".join(
            [
                prompt_base.strip(),
                "",
                f"Frame {index} of {total}.",
                f"Rough frame file: {rough_frame.name}.",
                "Use this frame's rough pose exactly as the motion guide, while improving the final drawing quality.",
                "The rough frame may contain transparent holes, seams, pasted-layer gaps, duplicated edges, or broken pixels from rig transforms.",
                "Do not preserve those defects. Fill missing body/clothing/hair pixels naturally using the edited keyframe, adjacent colors, and the rig part intent.",
                "Output a clean continuous sprite silhouette for this pose.",
                "Attached references are control-grid images: magenta is the removable background, cyan grid lines are only construction guides.",
                "Use the grid to match the rough frame's cell positions, pixel scale, silhouette placement, and limb placement.",
                "Do not render cyan grid lines as part of the final character.",
                "Render the final frame on a perfectly flat solid #FF00FF chroma-key background only.",
                "Do not generate white, gray, checkerboard, paper, texture, grid, shadow, glow, or scenery in the background.",
                "Keep the whole character inside the safe area with visible #FF00FF padding on every side; do not touch the canvas edge.",
                "Keep colors close to the edited keyframe; sample the same palette family instead of inventing a washed-out or white-heavy palette.",
                palette_description,
                "Do not invent a different action or timing.",
                "",
                "Frame transform metadata:",
                json.dumps(transform_payload, indent=2),
                "",
            ]
        )
        prompt_path.write_text(prompt, encoding="utf-8")
        job: dict[str, object] = {
            "id": f"frame_{index:02d}",
            "frame_index": index,
            "frame_count": total,
            "kind": "animation_render_frame",
            "dir": str(frame_job_dir),
            "rough_frame": str(rough_frame.resolve()),
            "current_frame": str(current_frame.resolve()) if current_frame.exists() else None,
            "rig_composite": str(rig_composite.resolve()) if rig_composite.exists() else None,
            "rough_frame_ref": str(rough_ref.resolve()),
            "current_frame_ref": str(current_ref.resolve()) if current_ref else None,
            "rig_composite_ref": str(rig_ref.resolve()) if rig_ref else None,
            "prompt_path": str(prompt_path.resolve()),
            "raw_path": str(raw_path.resolve()),
            "processed_dir": str(processed_dir.resolve()),
            "cells": target_cells,
            "render_reference_side": render_ref_side,
            "render_reference_background": "#FF00FF",
            "render_reference_grid": "#00FFFF",
            "preset": preset,
            "status": "pending_generation",
        }
        (frame_job_dir / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        (frame_job_dir / "worker-instructions.md").write_text(animation_render_worker_instructions(job), encoding="utf-8")
        render_jobs.append(job)
    plan: dict[str, object] = {
        "type": "sprite_forge_animation_render_pass",
        "source_manifest": manifest,
        "job_dir": str(job_dir.resolve()),
        "cells": target_cells,
        "render_reference_side": render_ref_side,
        "render_reference_background": "#FF00FF",
        "render_reference_grid": "#00FFFF",
        "preset": preset,
        "workers": workers,
        "jobs": render_jobs,
        "stage": "prepared",
    }
    if dispatch_script:
        plan["dispatch_script"] = str(write_animation_render_dispatch_script(job_dir, render_jobs, workers, codex_bin))
    (job_dir / "render-plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    return plan


def bbox_delta(a: tuple[int, int, int, int] | None, b: tuple[int, int, int, int] | None) -> int:
    if a is None or b is None:
        return 999
    return max(abs(a[index] - b[index]) for index in range(4))


def rough_pose_qc(rough_paths: list[Path], cleaned_paths: list[Path]) -> dict[str, object]:
    frame_reports: list[dict[str, object]] = []
    max_delta = 0
    max_bottom_delta = 0
    max_height_delta = 0
    for index, (rough_path, cleaned_path) in enumerate(zip(rough_paths, cleaned_paths), start=1):
        rough = Image.open(rough_path).convert("RGBA")
        cleaned = Image.open(cleaned_path).convert("RGBA")
        rough_bbox = alpha_bbox(rough)
        cleaned_bbox = alpha_bbox(cleaned)
        delta = bbox_delta(rough_bbox, cleaned_bbox)
        if rough_bbox is not None and cleaned_bbox is not None:
            bottom_delta = abs(rough_bbox[3] - cleaned_bbox[3])
            rough_height = rough_bbox[3] - rough_bbox[1]
            cleaned_height = cleaned_bbox[3] - cleaned_bbox[1]
            height_delta = abs(rough_height - cleaned_height)
        else:
            bottom_delta = 999
            height_delta = 999
        max_delta = max(max_delta, delta)
        max_bottom_delta = max(max_bottom_delta, bottom_delta)
        max_height_delta = max(max_height_delta, height_delta)
        frame_reports.append(
            {
                "frame": index,
                "rough_bbox": list(rough_bbox) if rough_bbox else None,
                "cleaned_bbox": list(cleaned_bbox) if cleaned_bbox else None,
                "bbox_delta": delta,
                "bottom_delta": bottom_delta,
                "height_delta": height_delta,
            }
        )
    issues: list[str] = []
    retry_hints: list[str] = []
    if max_delta > 8:
        issues.append(f"rough_bbox_drift:{max_delta}px")
        retry_hints.append("Preserve the rough sheet bbox and silhouette placement in every cell; do not zoom, recrop, or redraw into a new camera.")
    if max_bottom_delta > 4:
        issues.append(f"rough_anchor_drift:{max_bottom_delta}px")
        retry_hints.append("Keep the feet/bottom anchor in each generated cell aligned to the corresponding rough cell.")
    if max_height_delta > 8:
        issues.append(f"rough_scale_drift:{max_height_delta}px")
        retry_hints.append("Keep the character height and squash/lift rhythm from the rough animation sheet.")
    return {
        "passes": not issues,
        "issues": issues,
        "retry_hints": retry_hints,
        "max_bbox_delta": max_delta,
        "max_bottom_delta": max_bottom_delta,
        "max_height_delta": max_height_delta,
        "frames": frame_reports,
    }


def fit_frame_to_reference_bbox(frame: Image.Image, reference: Image.Image) -> Image.Image:
    source = frame.convert("RGBA")
    ref = reference.convert("RGBA")
    source_bbox = alpha_bbox(source)
    ref_bbox = alpha_bbox(ref)
    if source_bbox is None or ref_bbox is None:
        return source
    target_w = ref_bbox[2] - ref_bbox[0]
    target_h = ref_bbox[3] - ref_bbox[1]
    source_w = source_bbox[2] - source_bbox[0]
    source_h = source_bbox[3] - source_bbox[1]
    if target_w <= 0 or target_h <= 0 or source_w <= 0 or source_h <= 0:
        return source
    crop = source.crop(source_bbox)
    scale = min(target_w / source_w, target_h / source_h)
    if scale <= 0:
        return source
    new_w = max(1, int(round(source_w * scale)))
    new_h = max(1, int(round(source_h * scale)))
    fitted = crop.resize((new_w, new_h), Image.Resampling.NEAREST)
    out = Image.new("RGBA", source.size, (0, 0, 0, 0))
    paste_x = ref_bbox[0] + max(0, (target_w - new_w) // 2)
    paste_y = ref_bbox[3] - new_h
    out.alpha_composite(fitted, (paste_x, paste_y))
    return out


def load_static_idle_part_mask(job: dict[str, object], size: tuple[int, int]) -> Image.Image | None:
    raw_paths = job.get("static_part_masks")
    paths: list[Path] = []
    if isinstance(raw_paths, list):
        paths = [Path(str(path)) for path in raw_paths]
    else:
        raw_current = job.get("current_frame")
        if raw_current:
            masks_dir = Path(str(raw_current)).parent / "masks"
            if masks_dir.is_dir():
                paths = sorted(
                    path
                    for path in masks_dir.glob("*.mask.png")
                    if any(token in path.name for token in ("lower_leg", "foot"))
                )
    if not paths:
        return None
    mask = Image.new("L", size, 0)
    for path in paths:
        if not path.exists():
            continue
        part = Image.open(path).convert("RGBA")
        if part.size != size:
            part = part.resize(size, Image.Resampling.NEAREST)
        mask = Image.composite(Image.new("L", size, 255), mask, part.getchannel("A"))
    if mask.getbbox() is None:
        return None
    return mask.filter(ImageFilter.MaxFilter(3))


def apply_static_part_lock(frame: Image.Image, canonical: Image.Image | None, mask: Image.Image | None) -> Image.Image:
    if canonical is None or mask is None:
        return frame.convert("RGBA")
    target = frame.convert("RGBA")
    source = canonical.convert("RGBA")
    if source.size != target.size:
        source = source.resize(target.size, Image.Resampling.NEAREST)
    if mask.size != target.size:
        mask = mask.resize(target.size, Image.Resampling.NEAREST)
    out = target.copy()
    out.paste(source, (0, 0), mask)
    return out


def remove_lower_small_detached_components(image: Image.Image, *, min_size: int = 12, preserve_top: int = 24) -> Image.Image:
    rgba = image.convert("RGBA")
    components = opaque_components(rgba)
    if not components:
        return rgba
    pixels = rgba.load()
    for component in components:
        if len(component) >= min_size:
            continue
        bbox = bbox_from_points(component)
        if bbox is None or bbox[1] < preserve_top:
            continue
        for x, y in component:
            pixels[x, y] = (0, 0, 0, 0)
    return rgba


def process_animation_render_sheet_candidate(
    job: dict[str, object],
    *,
    cells: int,
    preset: str,
    gif_duration: int,
) -> dict[str, object]:
    raw_path = Path(str(job["raw_path"]))
    processed_dir = Path(str(job["processed_dir"]))
    rows = int(job.get("rows", 2))
    cols = int(job.get("cols", 2))
    frame_count = int(job.get("frame_count", rows * cols))
    processed_dir.mkdir(parents=True, exist_ok=True)
    raw = Image.open(raw_path).convert("RGBA")
    raw.save(processed_dir / "raw-sheet.png")
    cell_width = raw.width // cols
    cell_height = raw.height // rows
    if cell_width <= 0 or cell_height <= 0:
        raise ValueError("sheet rows/cols produce empty cells")
    source_dir = processed_dir / "source-frames"
    frames_dir = processed_dir / "frames"
    source_dir.mkdir(exist_ok=True)
    frames_dir.mkdir(exist_ok=True)
    rough_paths = [Path(str(path)) for path in job.get("rough_frames", []) if path]
    canonical_static = Image.open(Path(str(job["current_frame"]))).convert("RGBA") if job.get("current_frame") and Path(str(job["current_frame"])).exists() else None
    reference_palette = extract_full_palette(canonical_static) if canonical_static is not None else ()
    static_mask = load_static_idle_part_mask(job, (cells, cells))
    cleaned_paths: list[Path] = []
    frame_meta: list[dict[str, object]] = []
    for index in range(frame_count):
        row, col = divmod(index, cols)
        source_box = (col * cell_width, row * cell_height, (col + 1) * cell_width, (row + 1) * cell_height)
        raw_frame_path = source_dir / f"frame_{index + 1:02d}_raw.png"
        raw.crop(source_box).save(raw_frame_path)
        frame_dir = processed_dir / f"frame_{index + 1:02d}_process"
        cleanup_input = strip_render_edge_background(raw_frame_path, frame_dir / "raw-edge-stripped.png")
        cleaned_path = frames_dir / f"frame_{index + 1:02d}.png"
        try:
            reconstruct_generated_sprite(
                cleanup_input,
                cleaned_path,
                cells=cells,
                chroma_key=(255, 0, 255),
                chroma_tolerance=128,
                phase_mode="edge",
                sample_mode="median",
                palette=32,
                preset=preset,
                candidate_radius=1,
                cleanup=True,
                min_component_size=4,
                min_color_component_size=2,
                dark_speck_size=0,
                output_dir=frame_dir,
            )
        except Exception:
            process_single_sprite(
                cleanup_input,
                frame_dir,
                ForgeOptions(
                    cells=cells,
                    palette=32,
                    transparent=True,
                    chroma_key=(255, 0, 255),
                    chroma_tolerance=128,
                    background_tolerance=48,
                    sample_mode="median",
                    min_component_size=4,
                    preset=preset,
                    strip_edge_background=True,
                    strip_edge_tolerance=92,
                    protect_face_details=True,
                ),
                prompt_file=Path(str(job["prompt_path"])) if job.get("prompt_path") else None,
            )
            fallback = frame_dir / f"cleaned_{cells}.png"
            if fallback.exists():
                shutil.copy2(fallback, cleaned_path)
        if not cleaned_path.exists():
            raise ValueError(f"failed to clean sheet frame {index + 1}")
        if index < len(rough_paths) and rough_paths[index].exists():
            fitted = fit_frame_to_reference_bbox(Image.open(cleaned_path).convert("RGBA"), Image.open(rough_paths[index]).convert("RGBA"))
            fitted = apply_static_part_lock(fitted, canonical_static, static_mask)
            fitted = remove_lower_small_detached_components(fitted)
            fitted = apply_palette_lock(fitted, reference_palette)
            fitted.save(cleaned_path)
        cleaned_paths.append(cleaned_path)
        frame = Image.open(cleaned_path).convert("RGBA")
        bbox = alpha_bbox(frame)
        frame_meta.append(
            {
                "grid": [row, col],
                "source_box": list(source_box),
                "output_frame": str(cleaned_path),
                "crop_bbox": list(bbox) if bbox else None,
                "component_count": len(opaque_components(frame)),
                "edge_touch": bbox_touches_edge(bbox, frame.width, frame.height, 0),
            }
        )
    final_meta = assemble_animation_frames(cleaned_paths, processed_dir / "final", cols=cols, gif_duration=gif_duration)
    pose_qc = rough_pose_qc(rough_paths, cleaned_paths) if len(rough_paths) == len(cleaned_paths) else {"passes": False, "issues": ["missing_rough_frames"], "retry_hints": []}
    qc = final_meta.get("qc", {}) if isinstance(final_meta, dict) else {}
    if isinstance(qc, dict):
        issues = list(qc.get("issues", []))
        retry_hints = list(qc.get("retry_hints", []))
        issues.extend(pose_qc.get("issues", []))
        retry_hints.extend(pose_qc.get("retry_hints", []))
        qc["issues"] = sorted(set(str(issue) for issue in issues))
        qc["retry_hints"] = sorted(set(str(hint) for hint in retry_hints))
        qc["rough_pose"] = pose_qc
        qc["passes"] = bool(qc.get("passes", True)) and bool(pose_qc.get("passes", False)) and not qc["issues"]
    metadata: dict[str, object] = {
        "type": "animation_render_sheet_candidate",
        "job": job.get("id"),
        "raw_path": str(raw_path),
        "rows": rows,
        "cols": cols,
        "frame_count": frame_count,
        "cells": cells,
        "files": {
            "raw_sheet": str(processed_dir / "raw-sheet.png"),
            "sheet_transparent": str(processed_dir / "final" / "sheet-transparent.png"),
            "animation": str(processed_dir / "final" / "animation.gif"),
            "contact_sheet": str(processed_dir / "final" / "contact_sheet.png"),
            "frames": [str(path) for path in cleaned_paths],
        },
        "qc": qc,
        "frames": frame_meta,
        "final": final_meta,
    }
    (processed_dir / "pipeline-meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def ingest_animation_render_sheet_job(job_dir: Path, *, review_dir: Path | None = None, gif_duration: int = 140) -> dict[str, object]:
    plan_path = job_dir / "render-plan.json"
    if not plan_path.exists():
        raise ValueError(f"missing render plan: {plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    jobs = plan.get("jobs", [])
    if not isinstance(jobs, list):
        raise ValueError("render plan jobs must be a list")
    cells = int(plan.get("cells", 64))
    preset = str(plan.get("preset", "fighter"))
    if preset not in PRESETS:
        preset = "fighter"
    summaries: list[dict[str, object]] = []
    accepted: list[tuple[float, dict[str, object], dict[str, object]]] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        raw_path = Path(str(job["raw_path"]))
        processed_dir = Path(str(job["processed_dir"]))
        summary: dict[str, object] = {"id": job.get("id"), "raw_path": str(raw_path), "processed_dir": str(processed_dir)}
        if not raw_path.exists():
            summary["status"] = "waiting_for_raw"
            summaries.append(summary)
            continue
        meta_path = processed_dir / "pipeline-meta.json"
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else process_animation_render_sheet_candidate(job, cells=cells, preset=preset, gif_duration=gif_duration)
        except Exception as exc:  # noqa: BLE001
            summary.update({"status": "processing_failed", "error": str(exc)})
            summaries.append(summary)
            continue
        qc = meta.get("qc", {}) if isinstance(meta, dict) else {}
        issues = qc.get("issues", []) if isinstance(qc, dict) else []
        rough_pose = qc.get("rough_pose", {}) if isinstance(qc, dict) else {}
        rough_delta = float(rough_pose.get("max_bbox_delta", 999.0)) if isinstance(rough_pose, dict) else 999.0
        bottom_delta = float(rough_pose.get("max_bottom_delta", 999.0)) if isinstance(rough_pose, dict) else 999.0
        height_delta = float(rough_pose.get("max_height_delta", 999.0)) if isinstance(rough_pose, dict) else 999.0
        issue_penalty = len(issues) * 5.0 if isinstance(issues, list) else 20.0
        score = 1000.0 - rough_delta * 20.0 - bottom_delta * 10.0 - height_delta * 8.0 - issue_penalty
        summary.update(
            {
                "status": "processed",
                "passes": bool(qc.get("passes", False)) if isinstance(qc, dict) else False,
                "selection_score": score,
                "qc": qc,
                "processed": str(processed_dir),
                "contact_sheet": str(processed_dir / "final" / "contact_sheet.png"),
                "animation": str(processed_dir / "final" / "animation.gif"),
            }
        )
        accepted.append((score, job, meta))
        summaries.append(summary)
    final_payload: dict[str, object] | None = None
    selected_summary: dict[str, object] | None = None
    target_review_dir = review_dir or (job_dir / "review-run")
    if accepted:
        accepted.sort(key=lambda item: item[0], reverse=True)
        score, selected_job, selected_meta = accepted[0]
        frame_paths = [Path(str(path)) for path in selected_meta.get("files", {}).get("frames", [])]
        frames_dir = target_review_dir / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        review_frames: list[Path] = []
        for index, frame_path in enumerate(frame_paths, start=1):
            target = frames_dir / f"frame_{index:02d}.png"
            shutil.copy2(frame_path, target)
            review_frames.append(target)
        final_payload = assemble_animation_frames(review_frames, target_review_dir / "final", cols=int(plan.get("cols", len(review_frames))), gif_duration=gif_duration)
        (target_review_dir / "selected-render-candidate.json").write_text(
            json.dumps({"score": score, "job": selected_job, "candidate_meta": selected_meta}, indent=2),
            encoding="utf-8",
        )
        selected_summary = {"id": selected_job.get("id"), "score": score, "passes": selected_meta.get("qc", {}).get("passes") if isinstance(selected_meta.get("qc"), dict) else None}
    status = {
        "job_dir": str(job_dir),
        "review_dir": str(target_review_dir),
        "render_mode": "sheet",
        "total_jobs": len(summaries),
        "waiting": sum(1 for item in summaries if item.get("status") == "waiting_for_raw"),
        "processed": sum(1 for item in summaries if item.get("status") == "processed"),
        "failed": sum(1 for item in summaries if item.get("status") == "processing_failed"),
        "selected": selected_summary,
        "jobs": summaries,
        "final": final_payload,
    }
    (job_dir / "render-status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    return status



def sanitize_job_token(value: str, fallback: str = "job") -> str:
    token = "".join(char if char.isalnum() or char in "_.-" else "-" for char in value.strip()).strip("-._")
    return token or fallback


def load_animation_run_frames(run_dir: Path) -> list[Path]:
    for frame_dir in (run_dir / "frames", run_dir / "final" / "frames", run_dir / "processed" / "frames"):
        if frame_dir.is_dir():
            frames = sorted(frame_dir.glob("*.png"))
            if frames:
                return frames
    raise ValueError(f"no animation frames found in {run_dir}")


def load_run_rig_parts(run_dir: Path) -> list[dict[str, object]]:
    for path in (run_dir / "rig-parts.json", run_dir / "masks" / "rig-parts.json"):
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
            parts = payload.get("parts") if isinstance(payload, dict) else None
            if isinstance(parts, list):
                return [part for part in parts if isinstance(part, dict)]
    draft_path = run_dir / "animation-draft.json"
    if draft_path.exists():
        payload = json.loads(draft_path.read_text(encoding="utf-8"))
        parts = payload.get("rigParts") if isinstance(payload, dict) else None
        if isinstance(parts, list):
            return [part for part in parts if isinstance(part, dict)]
    raise ValueError(f"no rig-parts.json or animation-draft rigParts found in {run_dir}")


def load_run_animation_draft(run_dir: Path) -> dict[str, object]:
    path = run_dir / "animation-draft.json"
    if path.exists():
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return payload
    return {"frames": {}}


def draft_frame_transforms(draft: dict[str, object], frame_path: Path) -> dict[str, object]:
    frames = draft.get("frames", {}) if isinstance(draft, dict) else {}
    if not isinstance(frames, dict):
        return {}
    for key in (str(frame_path), frame_path.name):
        payload = frames.get(key)
        if isinstance(payload, dict) and isinstance(payload.get("transforms"), dict):
            return payload["transforms"]  # type: ignore[return-value]
    return {}


def part_anchor(part: dict[str, object]) -> tuple[float, float]:
    anchor = part.get("anchor")
    if isinstance(anchor, dict) and "x" in anchor and "y" in anchor:
        return float(anchor.get("x", 0)), float(anchor.get("y", 0))
    bbox = part.get("bbox")
    if isinstance(bbox, list) and len(bbox) >= 4:
        return float(bbox[0]) + float(bbox[2]) / 2, float(bbox[1]) + float(bbox[3]) / 2
    return 0.0, 0.0


def alpha_center_anchor(image: Image.Image) -> tuple[float, float]:
    bbox = alpha_bbox(image.convert("RGBA"))
    if bbox is None:
        return image.width / 2, image.height / 2
    return (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2


def affine_transform_around(image: Image.Image, anchor: tuple[float, float], transform: dict[str, object]) -> Image.Image:
    scale = max(0.1, float(transform.get("scale", 100) or 100) / 100.0)
    rotate = float(transform.get("rotate", 0) or 0) * 3.141592653589793 / 180.0
    tx = float(transform.get("x", 0) or 0)
    ty = float(transform.get("y", 0) or 0)
    if abs(scale - 1.0) < 1e-6 and abs(rotate) < 1e-6 and abs(tx) < 1e-6 and abs(ty) < 1e-6:
        return image.copy()
    import math

    ax, ay = anchor
    cos_v = math.cos(rotate)
    sin_v = math.sin(rotate)
    a = cos_v / scale
    b = sin_v / scale
    d = -sin_v / scale
    e = cos_v / scale
    c = ax - a * (ax + tx) - b * (ay + ty)
    f = ay - d * (ax + tx) - e * (ay + ty)
    return image.transform(image.size, Image.Transform.AFFINE, (a, b, c, d, e, f), resample=Image.Resampling.NEAREST)


def part_chain_for(parts_by_name: dict[str, dict[str, object]], part: dict[str, object]) -> list[dict[str, object]]:
    if part.get("pinned"):
        return [part]
    chain: list[dict[str, object]] = []
    seen: set[str] = set()
    current: dict[str, object] | None = part
    while current is not None:
        name = str(current.get("name", ""))
        if not name or name in seen:
            break
        chain.insert(0, current)
        seen.add(name)
        if current.get("pinned"):
            break
        parent = current.get("parent")
        current = parts_by_name.get(str(parent)) if parent else None
    return chain


def transformed_selected_part_mask(
    *,
    parts: list[dict[str, object]],
    selected_names: set[str],
    frame_path: Path,
    draft: dict[str, object],
    size: tuple[int, int],
    padding: int = 0,
) -> Image.Image:
    parts_by_name = {str(part.get("name")): part for part in parts}
    transforms = draft_frame_transforms(draft, frame_path)
    mask = Image.new("L", size, 0)
    for name in selected_names:
        part = parts_by_name.get(name)
        if part is None:
            continue
        mask_path_value = part.get("mask")
        if not mask_path_value:
            continue
        mask_path = Path(str(mask_path_value))
        if not mask_path.exists():
            continue
        part_mask = Image.open(mask_path).convert("RGBA")
        part_l = part_mask.getchannel("A")
        if part_l.size != size:
            part_l = part_l.resize(size, Image.Resampling.NEAREST)
        transformed = part_l
        whole_transform = transforms.get("whole") if isinstance(transforms, dict) else None
        if isinstance(whole_transform, dict):
            transformed = affine_transform_around(transformed, alpha_center_anchor(Image.open(frame_path).convert("RGBA")), whole_transform)
        for chain_part in part_chain_for(parts_by_name, part):
            chain_name = str(chain_part.get("name", ""))
            raw_transform = transforms.get(chain_name) if isinstance(transforms, dict) else None
            if isinstance(raw_transform, dict):
                transformed = affine_transform_around(transformed, part_anchor(chain_part), raw_transform)
        mask = Image.composite(Image.new("L", size, 255), mask, transformed)
    if padding > 0:
        filter_size = max(3, min(31, padding * 2 + 1))
        if filter_size % 2 == 0:
            filter_size += 1
        mask = mask.filter(ImageFilter.MaxFilter(filter_size))
    return mask


def apply_mask_to_reference(frame: Image.Image, mask: Image.Image, *, background: RGB = (255, 0, 255)) -> Image.Image:
    out = Image.new("RGBA", frame.size, (*background, 255))
    rgba = frame.convert("RGBA")
    out.paste(rgba, (0, 0), mask)
    return out


def compose_mask_sheet(masks: list[Image.Image], rows: int, cols: int, cell_size: int, output_path: Path) -> Path:
    sheet = Image.new("RGBA", (cols * cell_size, rows * cell_size), (255, 0, 255, 255))
    for index, mask in enumerate(masks):
        row, col = divmod(index, cols)
        rgba = Image.new("RGBA", (cell_size, cell_size), (255, 0, 255, 255))
        pixels = rgba.load()
        mp = mask.resize((cell_size, cell_size), Image.Resampling.NEAREST).load()
        for y in range(cell_size):
            for x in range(cell_size):
                if mp[x, y]:
                    pixels[x, y] = (255, 255, 255, 255)
        sheet.alpha_composite(rgba, (col * cell_size, row * cell_size))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(output_path)
    return output_path


def compose_rgba_sheet(frames: list[Image.Image], rows: int, cols: int, cell_size: int, output_path: Path, *, background: RGB = (255, 0, 255)) -> Path:
    sheet = Image.new("RGBA", (cols * cell_size, rows * cell_size), (*background, 255))
    for index, frame in enumerate(frames):
        row, col = divmod(index, cols)
        tile = Image.new("RGBA", (cell_size, cell_size), (*background, 255))
        normalized = frame.convert("RGBA")
        if normalized.size != (cell_size, cell_size):
            normalized = normalized.resize((cell_size, cell_size), Image.Resampling.NEAREST)
        tile.alpha_composite(normalized)
        sheet.alpha_composite(tile, (col * cell_size, row * cell_size))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(output_path)
    return output_path


def animation_part_render_worker_instructions(job: dict[str, object]) -> str:
    prompt_path = Path(str(job["prompt_path"]))
    raw_path = Path(str(job["raw_path"]))
    image_lines = []
    for label, key in (
        ("Base accepted animation sheet", "base_sheet_ref"),
        ("Editable part mask sheet", "part_mask_ref"),
        ("Selected part isolated sheet", "part_isolated_ref"),
        ("Original identity/current frame", "current_frame_ref"),
    ):
        if job.get(key):
            image_lines.append(f"- {label}: `{Path(str(job[key])).resolve()}`")
    image_block = "\n".join(image_lines) if image_lines else "- No images were attached."
    return "\n".join(
        [
            "# Sprite Forge Selective Rig-Part Render Worker",
            "",
            "You are one isolated Codex/imagegen worker. Generate exactly one full animation sheet candidate for a selective rig-part edit.",
            "",
            "Rules:",
            "- Do not edit Sprite Forge code.",
            "- Use imagegen once for the full sheet candidate.",
            "- Preserve the base animation, camera, canvas size, frame order, body pose, feet anchors, costume, face, outline weight, palette family, and pixel scale.",
            "- Change only the selected rig part named in the prompt. Treat the white mask sheet as the editable envelope; everything outside it must remain visually unchanged.",
            "- The output may be a normal full sheet; Sprite Forge will later composite only the selected envelope back over the accepted animation.",
            "- Keep the exact sheet layout and flat solid #FF00FF background. No labels, borders, gutters, scenery, glow, shadows, or checkerboard.",
            "- Use crisp square pixel art only; no antialiasing, blur, painterly textures, or non-pixel edges.",
            "- After imagegen finishes, copy the newest generated image from `${CODEX_HOME:-$HOME/.codex}/generated_images` to the required raw output path.",
            "- Verify the raw output exists with `test -s` before saying the job is complete.",
            "",
            "Attached/available context:",
            image_block,
            "",
            f"Prompt file: `{prompt_path.resolve()}`",
            f"Required raw sheet output path: `{raw_path.resolve()}`",
            "",
            "Required finalization command after imagegen:",
            "",
            "```bash",
            "latest=$(find \"${CODEX_HOME:-$HOME/.codex}/generated_images\" -type f \\( -name '*.png' -o -name '*.webp' -o -name '*.jpg' -o -name '*.jpeg' \\) -print0 | xargs -0 ls -t | head -n 1)",
            f"cp \"$latest\" {shlex.quote(str(raw_path.resolve()))}",
            f"test -s {shlex.quote(str(raw_path.resolve()))}",
            "```",
            "",
            "Prompt to use:",
            "",
            "```text",
            prompt_path.read_text(encoding="utf-8"),
            "```",
            "",
        ]
    )


def write_animation_part_render_dispatch_script(part_job_dir: Path, jobs: list[dict[str, object]], workers: int, codex_bin: str) -> Path:
    script_path = part_job_dir / "run-part-render-workers.sh"
    quoted_jobs = " ".join(shlex.quote(str(Path(str(job["dir"])) / "worker-instructions.md")) for job in jobs)
    jobs_json = shlex.quote(json.dumps(jobs))
    python_bin = shlex.quote(sys.executable)
    script = f"""#!/usr/bin/env bash
set -euo pipefail

ROOT={shlex.quote(str(Path.cwd()))}
PART_JOB_DIR={shlex.quote(str(part_job_dir))}
CODEX_BIN="${{CODEX_BIN:-{shlex.quote(codex_bin)}}}"
WORKERS="${{SPRITE_FORGE_WORKERS:-{workers}}}"
BASE_CODEX_HOME="${{CODEX_HOME:-$HOME/.codex}}"
PYTHON_BIN="${{PYTHON_BIN:-{python_bin}}}"
JOBS_JSON={jobs_json}

jobs=({quoted_jobs})

prepare_worker_home() {{
  local worker_home="$1"
  rm -rf "$worker_home/generated_images"
  mkdir -p "$worker_home/generated_images"
  for entry in auth.json config.toml AGENTS.md RTK.md skills cache plugins vendor_imports tools; do
    if [ -e "$BASE_CODEX_HOME/$entry" ] && [ ! -e "$worker_home/$entry" ]; then
      ln -s "$BASE_CODEX_HOME/$entry" "$worker_home/$entry"
    fi
  done
}}

image_args_for_job() {{
  local job_dir="$1"
  "$PYTHON_BIN" - "$job_dir" "$JOBS_JSON" <<'PYCODE'
import json, shlex, sys
job_dir = sys.argv[1]
for job in json.loads(sys.argv[2]):
    if job.get("dir") != job_dir:
        continue
    for key in ("base_sheet_ref", "part_mask_ref", "part_isolated_ref", "current_frame_ref"):
        path = job.get(key)
        if path:
            print("--image " + shlex.quote(str(path)), end=" ")
    break
PYCODE
}}

for instruction in "${{jobs[@]}}"; do
  candidate_dir="$(dirname "$instruction")"
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$WORKERS" ]; do
    sleep 2
  done
  worker_home="$candidate_dir/.codex-worker-home"
  prepare_worker_home "$worker_home"
  image_args="$(image_args_for_job "$candidate_dir")"
  CODEX_HOME="$worker_home" "$CODEX_BIN" exec -C "$ROOT" $image_args --dangerously-bypass-approvals-and-sandbox "$(cat "$instruction")" > "$candidate_dir/codex-worker.log" 2>&1 &
done

wait
"$PYTHON_BIN" "$ROOT/sprite_forge.py" animation-part-render-ingest "$PART_JOB_DIR"
"""
    script_path.write_text(script, encoding="utf-8")
    script_path.chmod(0o755)
    return script_path


def prepare_animation_part_render_job(
    run_dir: Path,
    *,
    parts: list[str],
    instruction: str,
    cells: int | None = None,
    mask_padding: int = 6,
    workers: int = 2,
    candidates: int | None = None,
    preset: str = "fighter",
    codex_bin: str = "codex",
    dispatch_script: bool = True,
) -> dict[str, object]:
    if not parts:
        raise ValueError("at least one --part is required")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    frame_paths = load_animation_run_frames(run_dir)
    target_cells = cells or max(Image.open(frame_paths[0]).size)
    base_frames = []
    for path in frame_paths:
        frame = Image.open(path).convert("RGBA")
        if frame.size != (target_cells, target_cells):
            frame = frame.resize((target_cells, target_cells), Image.Resampling.NEAREST)
        base_frames.append(frame)
    rows, cols = render_sheet_layout(len(base_frames))
    rig_parts = load_run_rig_parts(run_dir)
    selected = {part.strip() for raw in parts for part in raw.split(",") if part.strip()}
    known = {str(part.get("name")) for part in rig_parts}
    missing = sorted(selected - known)
    if missing:
        raise ValueError(f"unknown rig part(s): {', '.join(missing)}")
    draft = load_run_animation_draft(run_dir)

    token = sanitize_job_token("-".join(sorted(selected)), "part")
    jobs_root = run_dir / "part-render-jobs"
    index = 1
    while (jobs_root / f"{token}_{index:02d}").exists():
        index += 1
    part_job_dir = jobs_root / f"{token}_{index:02d}"
    refs_dir = part_job_dir / "references"
    masks_dir = part_job_dir / "part-masks"
    base_frames_dir = part_job_dir / "base-frames"
    jobs_dir = part_job_dir / "candidates"
    refs_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)
    base_frames_dir.mkdir(parents=True, exist_ok=True)
    jobs_dir.mkdir(parents=True, exist_ok=True)

    immutable_frame_paths: list[Path] = []
    for index, frame in enumerate(base_frames, start=1):
        target = base_frames_dir / f"frame_{index:02d}.png"
        frame.save(target)
        immutable_frame_paths.append(target.resolve())

    masks: list[Image.Image] = []
    isolated_frames: list[Image.Image] = []
    for frame_path, frame in zip(immutable_frame_paths, base_frames):
        mask = transformed_selected_part_mask(parts=rig_parts, selected_names=selected, frame_path=frame_path, draft=draft, size=(target_cells, target_cells), padding=mask_padding)
        masks.append(mask)
        mask.save(masks_dir / f"{frame_path.stem}.mask.png")
        isolated_frames.append(apply_mask_to_reference(frame, mask))

    base_sheet_ref = compose_rgba_sheet(base_frames, rows, cols, target_cells, refs_dir / "base-animation-sheet.png")
    part_mask_ref = compose_mask_sheet(masks, rows, cols, target_cells, refs_dir / "editable-part-mask-sheet.png")
    part_isolated_ref = compose_rgba_sheet(isolated_frames, rows, cols, target_cells, refs_dir / "selected-part-isolated-sheet.png")
    current_frame_ref = str((run_dir / "current-frame.png").resolve()) if (run_dir / "current-frame.png").exists() else str(frame_paths[0].resolve())

    candidate_count = max(1, candidates if candidates is not None else workers)
    prompt_base = (run_dir / "prompt-used.txt").read_text(encoding="utf-8") if (run_dir / "prompt-used.txt").exists() else ""
    prompt = "\n".join(
        [
            prompt_base.strip(),
            "",
            f"Selective rig-part regeneration for part(s): {', '.join(sorted(selected))}.",
            f"User change request: {instruction.strip()}",
            "",
            f"Render one complete {rows}x{cols} animation sheet with {len(base_frames)} frames in row-major order.",
            "The base animation is already approved. Preserve every non-selected body part exactly: pose, silhouette, palette, outline, feet anchors, face, clothes, and camera.",
            "Modify only the selected part inside the white editable mask/envelope reference.",
            "If the request asks for secondary motion, add it as subtle frame-to-frame offset, squash, delay, or follow-through of the selected part only.",
            "Do not redesign the character. Do not change timing or action. Do not change any non-selected limb, torso, head, face, shoes, or clothing.",
            "Use the selected-part isolated sheet to understand existing colors and shape; keep palette locked to the approved sprite family.",
            "Output clean pixel art on flat solid #FF00FF background only.",
            "No labels, borders, gutters, text, glow, shadows, scenery, checkerboard, or anti-aliased/painterly edges.",
            "",
        ]
    )

    render_jobs: list[dict[str, object]] = []
    for candidate_index in range(1, candidate_count + 1):
        candidate_dir = jobs_dir / f"candidate_{candidate_index:02d}"
        candidate_dir.mkdir(parents=True, exist_ok=True)
        prompt_path = candidate_dir / "prompt-used.txt"
        raw_path = candidate_dir / "raw-sheet.png"
        processed_dir = candidate_dir / "processed"
        prompt_path.write_text(prompt + f"Candidate {candidate_index}: keep the edit localized; prioritize unchanged non-selected pixels.\n", encoding="utf-8")
        job: dict[str, object] = {
            "id": f"candidate_{candidate_index:02d}",
            "candidate_index": candidate_index,
            "kind": "animation_part_render_sheet",
            "dir": str(candidate_dir.resolve()),
            "run_dir": str(run_dir.resolve()),
            "part_job_dir": str(part_job_dir.resolve()),
            "parts": sorted(selected),
            "instruction": instruction,
            "rough_frames": [str(path.resolve()) for path in immutable_frame_paths],
            "current_frame": current_frame_ref,
            "static_part_masks": [],
            "base_sheet_ref": str(base_sheet_ref.resolve()),
            "part_mask_ref": str(part_mask_ref.resolve()),
            "part_isolated_ref": str(part_isolated_ref.resolve()),
            "current_frame_ref": current_frame_ref,
            "prompt_path": str(prompt_path.resolve()),
            "raw_path": str(raw_path.resolve()),
            "processed_dir": str(processed_dir.resolve()),
            "rows": rows,
            "cols": cols,
            "frame_count": len(base_frames),
            "cells": target_cells,
            "mask_padding": mask_padding,
            "preset": preset,
            "status": "pending_generation",
        }
        (candidate_dir / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        (candidate_dir / "worker-instructions.md").write_text(animation_part_render_worker_instructions(job), encoding="utf-8")
        render_jobs.append(job)

    manifest = {
        "type": "sprite_forge_animation_part_render_job",
        "run_dir": str(run_dir.resolve()),
        "part_job_dir": str(part_job_dir.resolve()),
        "parts": sorted(selected),
        "instruction": instruction,
        "cells": target_cells,
        "rows": rows,
        "cols": cols,
        "frame_count": len(base_frames),
        "mask_padding": mask_padding,
        "preset": preset,
        "frames": [str(path.resolve()) for path in immutable_frame_paths],
        "rig_parts": rig_parts,
        "references": {
            "base_sheet": str(base_sheet_ref.resolve()),
            "part_mask_sheet": str(part_mask_ref.resolve()),
            "part_isolated_sheet": str(part_isolated_ref.resolve()),
            "current_frame": current_frame_ref,
        },
        "workers": workers,
        "candidates": candidate_count,
        "jobs": render_jobs,
        "stage": "prepared",
    }
    if dispatch_script:
        manifest["dispatch_script"] = str(write_animation_part_render_dispatch_script(part_job_dir, render_jobs, workers, codex_bin))
    (part_job_dir / "part-render-plan.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def composite_part_frames(base_paths: list[Path], generated_paths: list[Path], mask_paths: list[Path], output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    out_paths: list[Path] = []
    for index, (base_path, gen_path, mask_path) in enumerate(zip(base_paths, generated_paths, mask_paths), start=1):
        base = Image.open(base_path).convert("RGBA")
        gen = Image.open(gen_path).convert("RGBA")
        if gen.size != base.size:
            gen = gen.resize(base.size, Image.Resampling.NEAREST)
        mask = Image.open(mask_path).convert("L")
        if mask.size != base.size:
            mask = mask.resize(base.size, Image.Resampling.NEAREST)
        gen_alpha = gen.getchannel("A")
        paste_mask = Image.composite(mask, Image.new("L", mask.size, 0), gen_alpha)
        out = base.copy()
        out.paste(gen, (0, 0), paste_mask)
        out_path = output_dir / f"frame_{index:02d}.png"
        out.save(out_path)
        out_paths.append(out_path)
    return out_paths


def ingest_animation_part_render_job(part_job_dir: Path, *, review_dir: Path | None = None, gif_duration: int = 140) -> dict[str, object]:
    plan_path = part_job_dir / "part-render-plan.json"
    if not plan_path.exists():
        raise ValueError(f"missing part render plan: {plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    jobs = plan.get("jobs", [])
    if not isinstance(jobs, list):
        raise ValueError("part render plan jobs must be a list")
    cells = int(plan.get("cells", 64))
    preset = str(plan.get("preset", "fighter"))
    if preset not in PRESETS:
        preset = "fighter"
    base_paths = [Path(str(path)) for path in plan.get("frames", [])]
    mask_paths = sorted((part_job_dir / "part-masks").glob("*.mask.png"))
    summaries: list[dict[str, object]] = []
    accepted: list[tuple[float, dict[str, object], dict[str, object], list[Path]]] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        raw_path = Path(str(job["raw_path"]))
        processed_dir = Path(str(job["processed_dir"]))
        summary: dict[str, object] = {"id": job.get("id"), "raw_path": str(raw_path), "processed_dir": str(processed_dir)}
        if not raw_path.exists():
            summary["status"] = "waiting_for_raw"
            summaries.append(summary)
            continue
        meta_path = processed_dir / "pipeline-meta.json"
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else process_animation_render_sheet_candidate(job, cells=cells, preset=preset, gif_duration=gif_duration)
            gen_paths = [Path(str(path)) for path in meta.get("files", {}).get("frames", [])]
            composite_dir = processed_dir / "composited" / "frames"
            composited = composite_part_frames(base_paths, gen_paths, mask_paths, composite_dir)
            final_meta = assemble_animation_frames(composited, processed_dir / "composited" / "final", cols=int(plan.get("cols", len(composited))), gif_duration=gif_duration)
            qc = final_meta.get("qc", {}) if isinstance(final_meta, dict) else {}
            issues = qc.get("issues", []) if isinstance(qc, dict) else []
            score = 1000.0 - (len(issues) * 5.0 if isinstance(issues, list) else 50.0)
            summary.update(
                {
                    "status": "processed",
                    "selection_score": score,
                    "qc": qc,
                    "processed": str(processed_dir),
                    "contact_sheet": str(processed_dir / "composited" / "final" / "contact_sheet.png"),
                    "animation": str(processed_dir / "composited" / "final" / "animation.gif"),
                }
            )
            accepted.append((score, job, meta, composited))
        except Exception as exc:  # noqa: BLE001
            summary.update({"status": "processing_failed", "error": str(exc)})
        summaries.append(summary)

    target_review_dir = review_dir or (part_job_dir / "review-run")
    final_payload: dict[str, object] | None = None
    selected_summary: dict[str, object] | None = None
    if accepted:
        accepted.sort(key=lambda item: item[0], reverse=True)
        score, selected_job, selected_meta, composited_paths = accepted[0]
        frames_dir = target_review_dir / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        review_frames: list[Path] = []
        for index, path in enumerate(composited_paths, start=1):
            target = frames_dir / f"frame_{index:02d}.png"
            shutil.copy2(path, target)
            review_frames.append(target)
        final_payload = assemble_animation_frames(review_frames, target_review_dir / "final", cols=int(plan.get("cols", len(review_frames))), gif_duration=gif_duration)
        if (part_job_dir / "part-render-plan.json").exists():
            shutil.copy2(part_job_dir / "part-render-plan.json", target_review_dir / "part-render-plan.json")
        (target_review_dir / "selected-part-render-candidate.json").write_text(
            json.dumps({"score": score, "job": selected_job, "candidate_meta": selected_meta, "parts": plan.get("parts"), "instruction": plan.get("instruction")}, indent=2),
            encoding="utf-8",
        )
        selected_summary = {"id": selected_job.get("id"), "score": score}

    status = {
        "part_job_dir": str(part_job_dir.resolve()),
        "review_dir": str(target_review_dir.resolve()),
        "parts": plan.get("parts"),
        "instruction": plan.get("instruction"),
        "total_jobs": len(summaries),
        "waiting": sum(1 for item in summaries if item.get("status") == "waiting_for_raw"),
        "processed": sum(1 for item in summaries if item.get("status") == "processed"),
        "failed": sum(1 for item in summaries if item.get("status") == "processing_failed"),
        "selected": selected_summary,
        "jobs": summaries,
        "final": final_payload,
    }
    (part_job_dir / "part-render-status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    return status


def ingest_animation_render_job(job_dir: Path, *, review_dir: Path | None = None, gif_duration: int = 140) -> dict[str, object]:
    plan_path = job_dir / "render-plan.json"
    if not plan_path.exists():
        raise ValueError(f"missing render plan: {plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("render_mode") == "sheet":
        return ingest_animation_render_sheet_job(job_dir, review_dir=review_dir, gif_duration=gif_duration)
    jobs = plan.get("jobs", [])
    if not isinstance(jobs, list):
        raise ValueError("render plan jobs must be a list")
    cells = int(plan.get("cells", 64))
    preset = str(plan.get("preset", "fighter"))
    if preset not in PRESETS:
        preset = "fighter"
    summaries: list[dict[str, object]] = []
    cleaned_paths: list[Path] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        raw_path = Path(str(job["raw_path"]))
        processed_dir = Path(str(job["processed_dir"]))
        summary: dict[str, object] = {"id": job.get("id"), "frame_index": job.get("frame_index"), "raw_path": str(raw_path)}
        if not raw_path.exists():
            summary["status"] = "waiting_for_raw"
            summaries.append(summary)
            continue
        cleaned_path = processed_dir / f"cleaned_{cells}.png"
        if not cleaned_path.exists():
            processed_dir.mkdir(parents=True, exist_ok=True)
            cleanup_input = strip_render_edge_background(raw_path, processed_dir / "raw-edge-stripped.png")
            try:
                reconstruct_generated_sprite(
                    cleanup_input,
                    cleaned_path,
                    cells=cells,
                    chroma_key=(255, 0, 255),
                    chroma_tolerance=128,
                    phase_mode="edge",
                    sample_mode="median",
                    palette=32,
                    preset=preset,
                    candidate_radius=1,
                    cleanup=True,
                    min_component_size=4,
                    min_color_component_size=2,
                    dark_speck_size=0,
                    output_dir=processed_dir,
                )
            except Exception:
                process_single_sprite(
                    cleanup_input,
                    processed_dir,
                    ForgeOptions(
                        cells=cells,
                        palette=32,
                        transparent=True,
                        chroma_key=(255, 0, 255),
                        chroma_tolerance=128,
                        background_tolerance=48,
                        sample_mode="median",
                        min_component_size=4,
                        preset=preset,
                        strip_edge_background=True,
                        strip_edge_tolerance=92,
                        protect_face_details=True,
                    ),
                    prompt_file=Path(str(job["prompt_path"])) if job.get("prompt_path") else None,
                )
        if cleaned_path.exists():
            cleaned_paths.append(cleaned_path)
            summary.update({"status": "processed", "cleaned": str(cleaned_path)})
        else:
            summary["status"] = "processing_failed"
        summaries.append(summary)

    final_payload: dict[str, object] | None = None
    target_review_dir = review_dir or (job_dir / "review-run")
    if len(cleaned_paths) == len(jobs) and cleaned_paths:
        frames_dir = target_review_dir / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        review_frames: list[Path] = []
        for index, cleaned_path in enumerate(cleaned_paths, start=1):
            target = frames_dir / f"frame_{index:02d}.png"
            shutil.copy2(cleaned_path, target)
            review_frames.append(target)
        for name in ("rig-parts.json", "animation-draft.json", "prompt-used.txt", "job.json", "render-plan.json"):
            source = job_dir / name
            if source.exists():
                shutil.copy2(source, target_review_dir / name)
        final_payload = assemble_animation_frames(review_frames, target_review_dir / "final", cols=len(review_frames), gif_duration=gif_duration)

    status = {
        "job_dir": str(job_dir.resolve()),
        "review_dir": str(target_review_dir.resolve()),
        "total_jobs": len(jobs),
        "waiting": sum(1 for item in summaries if item.get("status") == "waiting_for_raw"),
        "processed": sum(1 for item in summaries if item.get("status") == "processed"),
        "failed": sum(1 for item in summaries if item.get("status") == "processing_failed"),
        "jobs": summaries,
        "final": final_payload,
    }
    (job_dir / "render-status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    return status


def process_production_loop(run_dir: Path) -> dict[str, object]:
    plan_path = run_dir / "production-plan.json"
    if not plan_path.exists():
        raise ValueError(f"missing production plan: {plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    jobs = plan.get("jobs", [])
    if not isinstance(jobs, list):
        raise ValueError("production plan jobs must be a list")

    summaries: list[dict[str, object]] = []
    accepted: dict[str, dict[str, object]] = {}
    for job in jobs:
        raw_path = Path(str(job["raw_path"]))
        processed_dir = Path(str(job["processed_dir"]))
        summary: dict[str, object] = {
            "id": job["id"],
            "subasset": job["subasset"],
            "attempt": job["attempt"],
            "kind": job["kind"],
            "raw_path": str(raw_path),
            "processed_dir": str(processed_dir),
        }
        if not raw_path.exists():
            summary["status"] = "waiting_for_raw"
            summaries.append(summary)
            continue

        try:
            if job["kind"] == "sheet":
                settings = job["process_settings"]
                meta = process_sheet(
                    raw_path,
                    processed_dir,
                    rows=int(settings["rows"]),
                    cols=int(settings["cols"]),
                    cell_size=int(settings["cell_size"]),
                    chroma_key=parse_rgb(str(settings.get("chroma_key", "#ff00ff"))),
                    chroma_tolerance=int(settings.get("chroma_tolerance", 64)),
                    fit_scale=float(settings.get("fit_scale", 0.86)),
                    align=str(settings.get("align", "center")),
                    shared_scale=bool(settings.get("shared_scale", True)),
                    component_mode=str(settings.get("component_mode", "all")),
                    reject_edge_touch=bool(settings.get("reject_edge_touch", True)),
                    preset=str(job.get("preset", "generic")),
                    prompt_file=Path(str(job["prompt_path"])),
                )
                qc = meta.get("qc", {})
                passes = bool(qc.get("passes", False)) if isinstance(qc, dict) else False
                score = 1000 - len(qc.get("issues", [])) * 50 if isinstance(qc, dict) else 0
                summary.update({"status": "processed", "passes": passes, "score": score, "qc": qc})
            else:
                meta = process_single_sprite(
                    raw_path,
                    processed_dir,
                    ForgeOptions(
                        cells=int(job["process_settings"].get("cells", 64)),
                        palette=int(job["process_settings"].get("palette", 24)),
                        transparent=True,
                        chroma_key=parse_rgb(str(job["process_settings"].get("chroma_key", "#ff00ff"))),
                        grid_key=parse_rgb(str(job["process_settings"].get("grid_key", "#ff00ff"))),
                        preset=str(job.get("preset", "fighter")),
                        strip_edge_background=True,
                    ),
                    prompt_file=Path(str(job["prompt_path"])),
                )
                score_payload = meta.get("score", {})
                score = float(score_payload.get("score", 0)) if isinstance(score_payload, dict) else 0
                issues = score_payload.get("quality_issues", []) if isinstance(score_payload, dict) else []
                passes = not issues
                summary.update({"status": "processed", "passes": passes, "score": score, "score_report": score_payload})
        except Exception as exc:  # noqa: BLE001 - keep production status useful for the next retry.
            summary.update({"status": "processing_failed", "error": str(exc)})

        current = accepted.get(str(job["subasset"]))
        if summary.get("status") == "processed" and (current is None or float(summary.get("score", -1)) > float(current.get("score", -1))):
            accepted[str(job["subasset"])] = summary
        summaries.append(summary)

    status = {
        "run_dir": str(run_dir),
        "total_jobs": len(summaries),
        "waiting": sum(1 for item in summaries if item.get("status") == "waiting_for_raw"),
        "processed": sum(1 for item in summaries if item.get("status") == "processed"),
        "failed": sum(1 for item in summaries if item.get("status") == "processing_failed"),
        "accepted": accepted,
        "jobs": summaries,
    }
    (run_dir / "production-status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    return status


def retry_hints_from_summary(summary: dict[str, object]) -> list[str]:
    hints: list[str] = []
    for key in ("score_report", "qc"):
        payload = summary.get(key)
        if isinstance(payload, dict):
            hints.extend(str(hint) for hint in payload.get("retry_hints", []) if str(hint).strip())
    if summary.get("status") == "processing_failed":
        hints.append("Regenerate a cleaner candidate that respects the prompt, safe area, and output layout exactly.")
    return sorted(set(hints))


def append_production_jobs(run_dir: Path, plan: dict[str, object], jobs: list[dict[str, object]], codex_bin: str = "codex") -> None:
    existing_jobs = plan.get("jobs", [])
    if not isinstance(existing_jobs, list):
        raise ValueError("production plan jobs must be a list")
    existing_jobs.extend(jobs)
    plan["jobs"] = existing_jobs
    (run_dir / "production-plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    with (run_dir / "generation-queue.jsonl").open("a", encoding="utf-8") as file:
        for job in jobs:
            file.write(json.dumps(job) + "\n")
    write_codex_dispatch_script(run_dir, existing_jobs, int(plan.get("workers", 4)), codex_bin)


def create_production_retry_jobs(
    run_dir: Path,
    *,
    max_retries: int = 1,
    only_failed: bool = True,
    codex_bin: str = "codex",
) -> dict[str, object]:
    if max_retries <= 0:
        raise ValueError("max retries must be positive")
    plan_path = run_dir / "production-plan.json"
    status_path = run_dir / "production-status.json"
    if not plan_path.exists() or not status_path.exists():
        raise ValueError("production-plan.json and production-status.json are required; run production-ingest first")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    status = json.loads(status_path.read_text(encoding="utf-8"))
    existing_jobs = plan.get("jobs", [])
    if not isinstance(existing_jobs, list):
        raise ValueError("production plan jobs must be a list")

    jobs_by_id = {str(job["id"]): job for job in existing_jobs if isinstance(job, dict) and "id" in job}
    retry_counts: Counter[str] = Counter()
    for job in existing_jobs:
        if isinstance(job, dict) and str(job.get("id", "")).endswith("_retry"):
            retry_counts[str(job.get("subasset", ""))] += 1
        elif isinstance(job, dict) and "_r" in str(job.get("id", "")):
            retry_counts[str(job.get("subasset", ""))] += 1

    candidates: list[dict[str, object]] = []
    accepted = status.get("accepted", {})
    if isinstance(accepted, dict):
        for summary in accepted.values():
            if isinstance(summary, dict) and (not only_failed or not bool(summary.get("passes", False))):
                candidates.append(summary)
    if not only_failed:
        for summary in status.get("jobs", []):
            if isinstance(summary, dict) and summary.get("status") == "processing_failed":
                candidates.append(summary)
    if only_failed:
        for summary in status.get("jobs", []):
            if isinstance(summary, dict) and summary.get("status") == "processing_failed":
                candidates.append(summary)

    new_jobs: list[dict[str, object]] = []
    jobs_dir = run_dir / "jobs"
    for summary in candidates:
        subasset = str(summary.get("subasset", "single"))
        if retry_counts[subasset] >= max_retries:
            continue
        source_job = jobs_by_id.get(str(summary.get("id")))
        if source_job is None:
            continue
        hints = retry_hints_from_summary(summary)
        if not hints:
            hints = ["Improve the candidate while preserving the asset identity, layout, safe padding, and pixel-art constraints."]
        retry_index = retry_counts[subasset] + 1
        retry_counts[subasset] += 1
        job_id = f"{sanitize_asset_name(subasset)}_r{retry_index:02d}"
        job_dir = jobs_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        prompt_path = job_dir / "prompt-used.txt"
        original_prompt = Path(str(source_job["prompt_path"])).read_text(encoding="utf-8")
        settings = source_job["process_settings"]
        is_sheet = source_job["kind"] == "sheet"
        cells = int(settings.get("cell_size", settings.get("cells", 64))) if isinstance(settings, dict) else 64
        prompt_text = build_retry_prompt(
            original_prompt,
            hints,
            cells=cells,
            background="#FF00FF",
            preset=str(source_job.get("preset", "generic")),
            sheet=is_sheet,
        )
        prompt_path.write_text(prompt_text, encoding="utf-8")
        raw_path = job_dir / ("raw-sheet.png" if is_sheet else "raw.png")
        processed_dir = job_dir / "processed"
        layout_guide = None
        if is_sheet and isinstance(settings, dict):
            guide_path = job_dir / "layout-guide.png"
            create_layout_guide(guide_path, rows=int(settings["rows"]), cols=int(settings["cols"]))
            layout_guide = str(guide_path)
        job = {
            **source_job,
            "id": job_id,
            "attempt": retry_index,
            "dir": str(job_dir),
            "prompt_path": str(prompt_path),
            "raw_path": str(raw_path),
            "processed_dir": str(processed_dir),
            "layout_guide": layout_guide,
            "retry_of": source_job["id"],
            "retry_hints": hints,
            "status": "pending_generation",
        }
        (job_dir / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        (job_dir / "retry-hints.txt").write_text("\n".join(hints) + "\n", encoding="utf-8")
        (job_dir / "worker-instructions.md").write_text(imagegen_worker_instructions(job), encoding="utf-8")
        (job_dir / "process-command.txt").write_text(production_process_command(job) + "\n", encoding="utf-8")
        new_jobs.append(job)

    append_production_jobs(run_dir, plan, new_jobs, codex_bin=codex_bin)
    payload = {"run_dir": str(run_dir), "created": len(new_jobs), "jobs": new_jobs}
    (run_dir / "production-retry.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def finalize_production_loop(
    run_dir: Path,
    output_dir: Path | None = None,
    *,
    formats: list[str] | None = None,
    sheet_name: str = "spriteforge_final",
) -> dict[str, object]:
    status_path = run_dir / "production-status.json"
    if not status_path.exists():
        raise ValueError("production-status.json is required; run production-ingest first")
    status = json.loads(status_path.read_text(encoding="utf-8"))
    accepted = status.get("accepted", {})
    if not isinstance(accepted, dict) or not accepted:
        raise ValueError("no accepted production attempts found")
    final_dir = output_dir or (run_dir / "final")
    final_dir.mkdir(parents=True, exist_ok=True)

    export_inputs: list[Path] = []
    accepted_entries: list[dict[str, object]] = []
    for subasset, summary in sorted(accepted.items()):
        if not isinstance(summary, dict):
            continue
        processed_dir = Path(str(summary["processed_dir"]))
        if summary.get("kind") == "sheet":
            source = processed_dir
        else:
            source = processed_dir / "cleaned_64.png"
            if not source.exists():
                cleaned = sorted(processed_dir.glob("cleaned_*.png"))
                source = cleaned[0] if cleaned else source
        if source.exists():
            export_inputs.append(source)
        accepted_entries.append({"subasset": subasset, **summary, "export_input": str(source)})

    export_payload = None
    if export_inputs:
        export_payload = export_spritebrew_formats(
            export_inputs,
            final_dir / "exports",
            formats=formats or ["texturepacker", "aseprite", "gamemaker", "godot", "raw"],
            sheet_name=sheet_name,
        )

    manifest = {
        "run_dir": str(run_dir),
        "output_dir": str(final_dir),
        "accepted": accepted_entries,
        "exports": export_payload,
    }
    (final_dir / "final-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def fit_frame_to_cell(image: Image.Image, cell_size: int) -> Image.Image:
    if cell_size <= 0:
        raise ValueError("cell size must be positive")
    frame = image.convert("RGBA")
    out = Image.new("RGBA", (cell_size, cell_size), (0, 0, 0, 0))
    if frame.width == 0 or frame.height == 0:
        return out
    scale = min(cell_size / frame.width, cell_size / frame.height)
    new_width = max(1, int(round(frame.width * scale)))
    new_height = max(1, int(round(frame.height * scale)))
    fitted = frame.resize((new_width, new_height), Image.Resampling.NEAREST)
    out.alpha_composite(fitted, ((cell_size - new_width) // 2, (cell_size - new_height) // 2))
    return out


def assemble_atlas(
    input_paths: list[Path],
    output_path: Path,
    *,
    cols: int,
    cell_size: int = 64,
    labels: list[str] | None = None,
) -> dict[str, object]:
    if not input_paths:
        raise ValueError("at least one input image is required")
    if cols <= 0:
        raise ValueError("cols must be positive")
    if cell_size <= 0:
        raise ValueError("cell size must be positive")
    if labels is not None and len(labels) != len(input_paths):
        raise ValueError("labels count must match input count")

    rows = (len(input_paths) + cols - 1) // cols
    frames = [fit_frame_to_cell(Image.open(path), cell_size) for path in input_paths]
    atlas = Image.new("RGBA", (cols * cell_size, rows * cell_size), (0, 0, 0, 0))
    frame_meta: list[dict[str, object]] = []
    for index, (path, frame) in enumerate(zip(input_paths, frames)):
        row, col = divmod(index, cols)
        x = col * cell_size
        y = row * cell_size
        atlas.alpha_composite(frame, (x, y))
        frame_meta.append(
            {
                "index": index,
                "label": labels[index] if labels else path.stem,
                "input": str(path),
                "grid": [row, col],
                "atlas_box": [x, y, x + cell_size, y + cell_size],
            }
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output_path)
    metadata = {
        "output": str(output_path),
        "rows": rows,
        "cols": cols,
        "cell_size": cell_size,
        "frames": frame_meta,
    }
    meta_path = output_path.with_name(f"{output_path.stem}-meta.json")
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def sanitize_asset_name(value: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in value.strip())
    cleaned = "_".join(part for part in cleaned.split("_") if part)
    return cleaned or "sprite"


def next_power_of_two(value: int) -> int:
    if value <= 1:
        return 1
    return 1 << (value - 1).bit_length()


def resize_export_frame(frame: Image.Image, width: int, height: int) -> Image.Image:
    rgba = frame.convert("RGBA")
    if rgba.size == (width, height):
        return rgba
    return rgba.resize((width, height), Image.Resampling.NEAREST)


def load_export_groups(input_paths: list[Path], *, default_fps: int = 12) -> list[dict[str, object]]:
    groups: list[dict[str, object]] = []
    for input_path in input_paths:
        path = input_path
        if path.is_dir():
            frames_dir = path / "frames"
            if frames_dir.is_dir():
                frame_paths = sorted(frames_dir.glob("*.png"))
            else:
                frame_paths = sorted(path.glob("*.png"))
            if not frame_paths:
                raise ValueError(f"no frame PNGs found in: {path}")
            meta_path = path / "bundle-meta.json"
            fps = default_fps
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    fps = int(meta.get("fps", default_fps))
                except (ValueError, TypeError, json.JSONDecodeError):
                    fps = default_fps
            groups.append(
                {
                    "name": sanitize_asset_name(path.name),
                    "fps": fps,
                    "loop": True,
                    "paths": frame_paths,
                    "frames": [Image.open(frame_path).convert("RGBA") for frame_path in frame_paths],
                }
            )
        else:
            groups.append(
                {
                    "name": sanitize_asset_name(path.stem),
                    "fps": default_fps,
                    "loop": True,
                    "paths": [path],
                    "frames": [Image.open(path).convert("RGBA")],
                }
            )
    if not groups:
        raise ValueError("at least one export input is required")
    return groups


def normalize_export_groups(
    groups: list[dict[str, object]],
    *,
    frame_width: int | None,
    frame_height: int | None,
) -> tuple[list[dict[str, object]], int, int]:
    all_frames = [frame for group in groups for frame in group["frames"]]  # type: ignore[index]
    if not all_frames:
        raise ValueError("no frames to export")
    width = frame_width or max(frame.width for frame in all_frames)
    height = frame_height or max(frame.height for frame in all_frames)
    if width <= 0 or height <= 0:
        raise ValueError("frame dimensions must be positive")

    normalized: list[dict[str, object]] = []
    for group in groups:
        frames = [resize_export_frame(frame, width, height) for frame in group["frames"]]  # type: ignore[index]
        normalized.append({**group, "frames": frames})
    return normalized, width, height


def flatten_export_frames(groups: list[dict[str, object]]) -> list[dict[str, object]]:
    frames: list[dict[str, object]] = []
    global_index = 0
    for group in groups:
        name = str(group["name"])
        for local_index, frame in enumerate(group["frames"]):  # type: ignore[index]
            frames.append(
                {
                    "global_index": global_index,
                    "animation": name,
                    "local_index": local_index,
                    "name": f"{name}_{local_index}",
                    "frame": frame,
                    "fps": int(group["fps"]),
                }
            )
            global_index += 1
    return frames


def optimal_columns(total_frames: int) -> int:
    return max(1, min(total_frames, int(total_frames**0.5 + 0.999)))


def compose_export_grid(
    frame_records: list[dict[str, object]],
    *,
    cols: int | None,
    frame_width: int,
    frame_height: int,
    padding: int,
    power_of_two: bool,
) -> tuple[Image.Image, list[dict[str, object]], int, int]:
    if padding < 0:
        raise ValueError("padding must be zero or positive")
    if not frame_records:
        raise ValueError("no frames to compose")
    columns = cols or optimal_columns(len(frame_records))
    if columns <= 0:
        raise ValueError("cols must be positive")
    rows = (len(frame_records) + columns - 1) // columns
    sheet_width = columns * frame_width + max(0, columns - 1) * padding
    sheet_height = rows * frame_height + max(0, rows - 1) * padding
    canvas_width = next_power_of_two(sheet_width) if power_of_two else sheet_width
    canvas_height = next_power_of_two(sheet_height) if power_of_two else sheet_height
    sheet = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
    meta_frames: list[dict[str, object]] = []
    for index, record in enumerate(frame_records):
        row, col = divmod(index, columns)
        x = col * (frame_width + padding)
        y = row * (frame_height + padding)
        frame = record["frame"]
        sheet.alpha_composite(frame, (x, y))  # type: ignore[arg-type]
        meta_frames.append(
            {
                "index": index,
                "name": record["name"],
                "animation": record["animation"],
                "local_index": record["local_index"],
                "x": x,
                "y": y,
                "w": frame_width,
                "h": frame_height,
            }
        )
    return sheet, meta_frames, columns, rows


def frame_tags_from_groups(groups: list[dict[str, object]]) -> list[dict[str, object]]:
    tags: list[dict[str, object]] = []
    offset = 0
    colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#ff8800", "#88ff00"]
    for index, group in enumerate(groups):
        count = len(group["frames"])  # type: ignore[arg-type]
        if count:
            tags.append(
                {
                    "name": str(group["name"]),
                    "from": offset,
                    "to": offset + count - 1,
                    "direction": "forward",
                    "color": colors[index % len(colors)],
                    "fps": int(group["fps"]),
                    "loop": bool(group["loop"]),
                }
            )
        offset += count
    return tags


def write_texturepacker_json(
    output_path: Path,
    *,
    image_name: str,
    sheet_size: tuple[int, int],
    frames: list[dict[str, object]],
    frame_tags: list[dict[str, object]],
) -> dict[str, object]:
    frames_obj = {}
    for frame in frames:
        filename = f"{frame['name']}.png"
        frames_obj[filename] = {
            "frame": {"x": frame["x"], "y": frame["y"], "w": frame["w"], "h": frame["h"]},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": frame["w"], "h": frame["h"]},
            "sourceSize": {"w": frame["w"], "h": frame["h"]},
        }
    payload = {
        "frames": frames_obj,
        "meta": {
            "app": "Sprite Forge",
            "version": "1.0",
            "image": image_name,
            "format": "RGBA8888",
            "size": {"w": sheet_size[0], "h": sheet_size[1]},
            "scale": "1",
            "frameTags": [
                {key: tag[key] for key in ("name", "from", "to", "direction") if key in tag}
                for tag in frame_tags
            ],
        },
    }
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def write_aseprite_json(
    output_path: Path,
    *,
    image_name: str,
    sheet_size: tuple[int, int],
    frames: list[dict[str, object]],
    frame_tags: list[dict[str, object]],
) -> dict[str, object]:
    duration_by_animation = {str(tag["name"]): round(1000 / max(1, int(tag.get("fps", 12)))) for tag in frame_tags}
    payload = {
        "frames": [
            {
                "filename": f"{frame['name']}.png",
                "frame": {"x": frame["x"], "y": frame["y"], "w": frame["w"], "h": frame["h"]},
                "rotated": False,
                "trimmed": False,
                "spriteSourceSize": {"x": 0, "y": 0, "w": frame["w"], "h": frame["h"]},
                "sourceSize": {"w": frame["w"], "h": frame["h"]},
                "duration": duration_by_animation.get(str(frame["animation"]), 83),
            }
            for frame in frames
        ],
        "meta": {
            "app": "Sprite Forge",
            "version": "1.0",
            "image": image_name,
            "format": "RGBA8888",
            "size": {"w": sheet_size[0], "h": sheet_size[1]},
            "scale": "1",
            "frameTags": [
                {key: tag[key] for key in ("name", "from", "to", "direction", "color") if key in tag}
                for tag in frame_tags
            ],
            "layers": [{"name": "Layer 1", "opacity": 255, "blendMode": "normal"}],
        },
    }
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def write_godot_tres(
    output_path: Path,
    *,
    image_name: str,
    frames: list[dict[str, object]],
    frame_tags: list[dict[str, object]],
) -> str:
    sub_resources: list[str] = []
    for frame in frames:
        sub_resources.append(
            "\n".join(
                [
                    f"[sub_resource type=\"AtlasTexture\" id=\"atlas_{frame['index']}\"]",
                    'atlas = ExtResource("1")',
                    f"region = Rect2({frame['x']}, {frame['y']}, {frame['w']}, {frame['h']})",
                ]
            )
        )

    animations: list[str] = []
    for tag in frame_tags:
        frame_entries = []
        for frame_index in range(int(tag["from"]), int(tag["to"]) + 1):
            frame_entries.append(
                "{\n"
                "      \"duration\": 1.0,\n"
                f"      \"texture\": SubResource(\"atlas_{frame_index}\")\n"
                "    }"
            )
        loop_text = "true" if tag.get("loop", True) else "false"
        animations.append(
            "{\n"
            f"    \"frames\": [{', '.join(frame_entries)}],\n"
            f"    \"loop\": {loop_text},\n"
            f"    \"name\": \"{tag['name']}\",\n"
            f"    \"speed\": {int(tag.get('fps', 12))}.0\n"
            "  }"
        )

    text = (
        f"[gd_resource type=\"SpriteFrames\" load_steps={len(frames) + 2} format=3]\n\n"
        f"[ext_resource type=\"Texture2D\" path=\"res://{image_name}\" id=\"1\"]\n\n"
        f"{chr(10).join(sub_resources)}\n\n"
        "[resource]\n"
        f"animations = [{', '.join(animations)}]\n"
    )
    output_path.write_text(text, encoding="utf-8")
    return text


def write_gamemaker_strips(groups: list[dict[str, object]], output_dir: Path) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []
    for group in groups:
        frames = group["frames"]  # type: ignore[assignment]
        if not frames:
            continue
        width = frames[0].width * len(frames)
        height = frames[0].height
        strip = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for index, frame in enumerate(frames):
            strip.alpha_composite(frame, (index * frame.width, 0))
        path = output_dir / f"{sanitize_asset_name(str(group['name']))}_strip{len(frames)}.png"
        strip.save(path)
        outputs.append(str(path))
    return outputs


def write_raw_frames(groups: list[dict[str, object]], output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    animations: list[dict[str, object]] = []
    for group in groups:
        name = sanitize_asset_name(str(group["name"]))
        files: list[str] = []
        for index, frame in enumerate(group["frames"]):  # type: ignore[index]
            path = output_dir / f"{name}_{index:02d}.png"
            frame.save(path)
            files.append(str(path))
        animations.append(
            {
                "name": str(group["name"]),
                "fps": int(group["fps"]),
                "loop": bool(group["loop"]),
                "frameCount": len(files),
                "files": files,
            }
        )
    manifest = {
        "generator": "Sprite Forge",
        "version": "1.0",
        "animations": animations,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def write_rpgmaker_sheet(
    groups: list[dict[str, object]],
    output_path: Path,
    *,
    frame_width: int,
    frame_height: int,
    direction_map: list[str],
) -> dict[str, object]:
    if len(direction_map) != 4:
        raise ValueError("RPG Maker direction map must contain exactly four animation names: down,left,right,up")
    group_by_name = {str(group["name"]): group for group in groups}
    canvas = Image.new("RGBA", (frame_width * 3, frame_height * 4), (0, 0, 0, 0))
    warnings: list[str] = []
    for row, name in enumerate(direction_map):
        if name in {"", "none", "-"}:
            continue
        group = group_by_name.get(sanitize_asset_name(name)) or group_by_name.get(name)
        if group is None:
            warnings.append(f"missing_direction:{name}")
            continue
        frames = group["frames"]  # type: ignore[assignment]
        if len(frames) > 3:
            warnings.append(f"{name}:uses_first_3_of_{len(frames)}")
        for col in range(3):
            frame = frames[col % len(frames)]
            canvas.alpha_composite(frame, (col * frame_width, row * frame_height))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)
    return {"output": str(output_path), "warnings": warnings, "direction_map": direction_map}


def export_spritebrew_formats(
    input_paths: list[Path],
    output_dir: Path,
    *,
    formats: list[str],
    sheet_name: str = "spriteforge_export",
    cols: int | None = None,
    padding: int = 0,
    power_of_two: bool = False,
    frame_width: int | None = None,
    frame_height: int | None = None,
    fps: int = 12,
    rpg_direction_map: list[str] | None = None,
) -> dict[str, object]:
    selected = set(formats)
    if "all" in selected:
        selected = {"texturepacker", "aseprite", "gamemaker", "godot", "raw", "rpgmaker"}
    allowed = {"texturepacker", "aseprite", "gamemaker", "godot", "raw", "rpgmaker"}
    unknown = selected - allowed
    if unknown:
        raise ValueError(f"unknown export format(s): {', '.join(sorted(unknown))}")
    if fps <= 0:
        raise ValueError("fps must be positive")

    output_dir.mkdir(parents=True, exist_ok=True)
    sheet_base = sanitize_asset_name(sheet_name)
    groups = load_export_groups(input_paths, default_fps=fps)
    groups, width, height = normalize_export_groups(groups, frame_width=frame_width, frame_height=frame_height)
    frame_records = flatten_export_frames(groups)
    sheet, frame_meta, used_cols, used_rows = compose_export_grid(
        frame_records,
        cols=cols,
        frame_width=width,
        frame_height=height,
        padding=padding,
        power_of_two=power_of_two,
    )
    sheet_path = output_dir / f"{sheet_base}.png"
    sheet.save(sheet_path)
    tags = frame_tags_from_groups(groups)

    files: dict[str, object] = {"sheet": str(sheet_path)}
    if "texturepacker" in selected:
        path = output_dir / f"{sheet_base}.texturepacker.json"
        write_texturepacker_json(path, image_name=sheet_path.name, sheet_size=sheet.size, frames=frame_meta, frame_tags=tags)
        files["texturepacker"] = str(path)
    if "aseprite" in selected:
        path = output_dir / f"{sheet_base}.aseprite.json"
        write_aseprite_json(path, image_name=sheet_path.name, sheet_size=sheet.size, frames=frame_meta, frame_tags=tags)
        files["aseprite"] = str(path)
    if "godot" in selected:
        path = output_dir / f"{sheet_base}.tres"
        write_godot_tres(path, image_name=sheet_path.name, frames=frame_meta, frame_tags=tags)
        files["godot"] = str(path)
    if "gamemaker" in selected:
        files["gamemaker"] = write_gamemaker_strips(groups, output_dir / "gamemaker")
    if "raw" in selected:
        files["raw"] = write_raw_frames(groups, output_dir / "raw-frames")
    if "rpgmaker" in selected:
        direction_map = rpg_direction_map or ["down", "left", "right", "up"]
        files["rpgmaker"] = write_rpgmaker_sheet(
            groups,
            output_dir / f"${sheet_base}.png",
            frame_width=width,
            frame_height=height,
            direction_map=[sanitize_asset_name(name) for name in direction_map],
        )

    manifest = {
        "generator": "Sprite Forge",
        "inspired_by": "SpriteBrew export contracts",
        "sheet": {
            "name": sheet_base,
            "path": str(sheet_path),
            "width": sheet.width,
            "height": sheet.height,
            "cols": used_cols,
            "rows": used_rows,
            "frame_width": width,
            "frame_height": height,
            "padding": padding,
            "power_of_two": power_of_two,
        },
        "formats": sorted(selected),
        "files": files,
        "animations": [
            {
                "name": str(group["name"]),
                "fps": int(group["fps"]),
                "loop": bool(group["loop"]),
                "frame_count": len(group["frames"]),  # type: ignore[arg-type]
            }
            for group in groups
        ],
        "frames": frame_meta,
    }
    (output_dir / "export-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def load_frame_images(sheet_dir: Path) -> list[Image.Image]:
    frames_dir = sheet_dir / "frames"
    if not frames_dir.is_dir():
        raise ValueError(f"missing frames directory: {frames_dir}")
    frame_paths = sorted(frames_dir.glob("*.png"))
    if not frame_paths:
        raise ValueError(f"no frame PNGs found in: {frames_dir}")
    return [Image.open(path).convert("RGBA") for path in frame_paths]


def frame_body_metrics(frames: list[Image.Image]) -> dict[str, object]:
    bboxes = [alpha_bbox(frame) for frame in frames]
    heights = [bbox[3] - bbox[1] for bbox in bboxes if bbox is not None]
    bottoms = [bbox[3] for bbox in bboxes if bbox is not None]
    widths = [bbox[2] - bbox[0] for bbox in bboxes if bbox is not None]
    return {
        "frame_count": len(frames),
        "nonempty_frames": len(heights),
        "bbox_heights": heights,
        "bbox_widths": widths,
        "bbox_bottoms": bottoms,
        "mean_height": round(sum(heights) / len(heights), 3) if heights else 0,
        "min_height": min(heights) if heights else 0,
        "max_height": max(heights) if heights else 0,
        "anchor_drift": (max(bottoms) - min(bottoms)) if bottoms else 0,
    }


def hero_qc(
    sheet_dirs: list[Path],
    *,
    baseline: str = "idle",
    max_body_shrink: float = 0.15,
    max_anchor_drift: int = 3,
) -> dict[str, object]:
    if not sheet_dirs:
        raise ValueError("at least one processed sheet directory is required")
    if not 0 <= max_body_shrink < 1:
        raise ValueError("max body shrink must be in [0, 1)")
    if max_anchor_drift < 0:
        raise ValueError("max anchor drift must be zero or positive")

    sheets: dict[str, dict[str, object]] = {}
    for sheet_dir in sheet_dirs:
        metrics = frame_body_metrics(load_frame_images(sheet_dir))
        sheets[sheet_dir.name] = {"path": str(sheet_dir), **metrics}

    baseline_metrics = sheets.get(baseline)
    if baseline_metrics is None:
        baseline_name = next(iter(sheets))
        baseline_metrics = sheets[baseline_name]
    else:
        baseline_name = baseline
    baseline_height = float(baseline_metrics["mean_height"])

    issues: list[str] = []
    for name, metrics in sheets.items():
        mean_height = float(metrics["mean_height"])
        shrink = 0.0 if baseline_height <= 0 else max(0.0, (baseline_height - mean_height) / baseline_height)
        metrics["body_shrink"] = round(shrink, 3)
        metrics["passes_body_shrink"] = shrink <= max_body_shrink
        metrics["passes_anchor_drift"] = int(metrics["anchor_drift"]) <= max_anchor_drift
        if not metrics["passes_body_shrink"]:
            issues.append(f"{name}:body_shrink:{shrink:.3f}>{max_body_shrink:.3f}")
        if not metrics["passes_anchor_drift"]:
            issues.append(f"{name}:anchor_drift:{metrics['anchor_drift']}>{max_anchor_drift}")

    return {
        "baseline": baseline_name,
        "max_body_shrink": max_body_shrink,
        "max_anchor_drift": max_anchor_drift,
        "passes": not issues,
        "issues": issues,
        "retry_hints": retry_hints_for_issues(issues, context="sheet"),
        "sheets": sheets,
    }


@dataclass(frozen=True)
class ForgeOptions:
    cells: int = 64
    scale: int = 1
    sample_margin_ratio: float = 0.28
    palette: int = 0
    transparent: bool = False
    background_tolerance: int = 36
    square_crop: str = "center"
    sample_mode: str = "median"
    prequantize_palette: int = 0
    chroma_key: RGB | None = None
    chroma_tolerance: int = 64
    grid_key: RGB | None = None
    grid_tolerance: int = 48
    min_component_size: int = 0
    keep_largest_component: bool = False
    center_alpha: bool = False
    trim_alpha: bool = False
    outline_color: RGB | None = None
    despeckle: int = 0
    min_color_component_size: int = 0
    dark_speck_size: int = 0
    dark_threshold: int = 80
    strip_edge_background: bool = False
    strip_edge_tolerance: int = 54
    palette_colors: tuple[RGB, ...] = ()
    preset: str = "generic"
    protect_face_details: bool = True


@dataclass(frozen=True)
class ContentCropResult:
    image: Image.Image
    bbox: tuple[int, int, int, int] | None
    content_bbox: tuple[int, int, int, int] | None
    mode: str
    padded_to_square: bool


@dataclass(frozen=True)
class SpriteScore:
    path: str
    score: float
    alpha_pixels: int
    bbox_area: int
    visible_colors: int
    fill_ratio: float
    opaque_components: int
    small_opaque_components: int
    small_color_components: int
    dark_specks: int
    dark_feature_components: int
    orange_feature_pixels: int
    palette_ramp: dict[str, object]
    quality_issues: list[str]
    retry_hints: list[str]
    preset: str = "generic"


@dataclass(frozen=True)
class AssetPlan:
    prompt: str
    asset_type: str
    action: str
    view: str
    sheet: str
    rows: int
    cols: int
    frames: int
    bundle: str
    anchor: str
    margin: str
    art_style: str
    component_mode: str
    prompt_mode: str
    notes: list[str]
    subassets: list[str]


def _validate_options(options: ForgeOptions) -> None:
    if options.cells <= 0:
        raise ValueError("cells must be positive")
    if options.scale <= 0:
        raise ValueError("scale must be positive")
    if not 0 <= options.sample_margin_ratio < 0.5:
        raise ValueError("sample margin ratio must be in [0, 0.5)")
    if options.palette < 0:
        raise ValueError("palette must be zero or positive")
    if options.background_tolerance < 0:
        raise ValueError("background tolerance must be zero or positive")
    if options.square_crop not in {"center", "none"}:
        raise ValueError("square crop must be 'center' or 'none'")
    if options.sample_mode not in {"median", "mode"}:
        raise ValueError("sample mode must be 'median' or 'mode'")
    if options.prequantize_palette < 0:
        raise ValueError("prequantize palette must be zero or positive")
    if options.chroma_tolerance < 0:
        raise ValueError("chroma tolerance must be zero or positive")
    if options.grid_tolerance < 0:
        raise ValueError("grid tolerance must be zero or positive")
    if options.min_component_size < 0:
        raise ValueError("minimum component size must be zero or positive")
    if options.despeckle < 0:
        raise ValueError("despeckle iterations must be zero or positive")
    if options.min_color_component_size < 0:
        raise ValueError("minimum color component size must be zero or positive")
    if options.dark_speck_size < 0:
        raise ValueError("dark speck size must be zero or positive")
    if not 0 <= options.dark_threshold <= 765:
        raise ValueError("dark threshold must be in [0, 765]")
    if options.strip_edge_tolerance < 0:
        raise ValueError("strip edge tolerance must be zero or positive")
    if len(options.palette_colors) > 256:
        raise ValueError("palette files may contain at most 256 colors")
    if options.preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")


def center_square_crop(image: Image.Image) -> Image.Image:
    width, height = image.size
    if width == height:
        return image

    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def fit_image_into_square(image: Image.Image, side: int, padding: int, background: RGB) -> Image.Image:
    if padding < 0 or padding * 2 >= side:
        raise ValueError("padding must leave visible room for the reference")

    target = Image.new("RGB", (side, side), background)
    max_size = side - padding * 2
    work = image.convert("RGB")
    work.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    x = (side - work.width) // 2
    y = (side - work.height) // 2
    target.paste(work, (x, y))
    return target


def replace_reference_background(image: Image.Image, background: RGB, tolerance: int) -> Image.Image:
    if tolerance < 0:
        raise ValueError("background removal tolerance must be zero or positive")

    work = image.convert("RGB")
    source_background = estimate_border_background(work)
    pixels = work.load()
    width, height = work.size
    visited: set[tuple[int, int]] = set()
    queue: deque[tuple[int, int]] = deque()

    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        if (x, y) in visited:
            continue
        visited.add((x, y))

        if color_distance(pixels[x, y], source_background) > tolerance:
            continue

        pixels[x, y] = background
        if x > 0:
            queue.append((x - 1, y))
        if x < width - 1:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y < height - 1:
            queue.append((x, y + 1))
    return work


def draw_real_grid(image: Image.Image, cells: int, line_color: RGB, line_width: int) -> Image.Image:
    if cells <= 0:
        raise ValueError("cells must be positive")
    if line_width <= 0:
        raise ValueError("line width must be positive")

    out = image.copy()
    draw = ImageDraw.Draw(out)
    side = out.width
    if out.width != out.height:
        raise ValueError("grid image must be square")

    step = side / cells
    for index in range(cells + 1):
        pos = min(side - 1, int(round(index * step)))
        draw.line((pos, 0, pos, side - 1), fill=line_color, width=line_width)
        draw.line((0, pos, side - 1, pos), fill=line_color, width=line_width)
    return out


def draw_dashed_line(
    draw: ImageDraw.ImageDraw,
    start: tuple[int, int],
    end: tuple[int, int],
    *,
    fill: RGB,
    width: int,
    dash: int,
    gap: int,
) -> None:
    x1, y1 = start
    x2, y2 = end
    if x1 == x2:
        for y in range(min(y1, y2), max(y1, y2), dash + gap):
            draw.line((x1, y, x2, min(y + dash, max(y1, y2))), fill=fill, width=width)
        return
    if y1 == y2:
        for x in range(min(x1, x2), max(x1, x2), dash + gap):
            draw.line((x, y1, min(x + dash, max(x1, x2)), y2), fill=fill, width=width)
        return
    raise ValueError("dashed guide lines must be horizontal or vertical")


def create_layout_guide(
    output_path: Path,
    *,
    rows: int,
    cols: int,
    cell_width: int = 384,
    cell_height: int = 384,
    safe_margin_x: int = 52,
    safe_margin_y: int = 52,
    background: RGB = (248, 248, 248),
    slot_color: RGB = (17, 17, 17),
    safe_color: RGB = (47, 128, 237),
    center_color: RGB = (184, 184, 184),
    label_cells: bool = False,
) -> Image.Image:
    if rows <= 0 or cols <= 0:
        raise ValueError("rows and cols must be positive")
    if cell_width <= 0 or cell_height <= 0:
        raise ValueError("cell dimensions must be positive")
    if safe_margin_x < 0 or safe_margin_y < 0:
        raise ValueError("safe margins must be zero or positive")
    if safe_margin_x * 2 >= cell_width or safe_margin_y * 2 >= cell_height:
        raise ValueError("safe margins must leave visible room inside each cell")

    image = Image.new("RGB", (cols * cell_width, rows * cell_height), background)
    draw = ImageDraw.Draw(image)
    for row in range(rows):
        for col in range(cols):
            left = col * cell_width
            top = row * cell_height
            right = left + cell_width - 1
            bottom = top + cell_height - 1
            safe_left = left + safe_margin_x
            safe_top = top + safe_margin_y
            safe_right = right - safe_margin_x
            safe_bottom = bottom - safe_margin_y
            center_x = left + cell_width // 2
            center_y = top + cell_height // 2

            draw.rectangle((left, top, right, bottom), outline=slot_color, width=4)
            draw.rectangle((safe_left, safe_top, safe_right, safe_bottom), outline=safe_color, width=3)
            draw_dashed_line(
                draw,
                (center_x, safe_top),
                (center_x, safe_bottom),
                fill=center_color,
                width=2,
                dash=14,
                gap=16,
            )
            draw_dashed_line(
                draw,
                (safe_left, center_y),
                (safe_right, center_y),
                fill=center_color,
                width=2,
                dash=14,
                gap=16,
            )
            if label_cells:
                draw.text((left + 12, top + 10), f"{row + 1},{col + 1}", fill=(119, 119, 119))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return image


def sample_image_colors(image: Image.Image, max_samples: int = 4096) -> list[RGB]:
    rgb = image.convert("RGB")
    width, height = rgb.size
    if width == 0 or height == 0:
        return []
    stride = max(1, int(((width * height) / max_samples) ** 0.5))
    pixels = rgb.load()
    return [pixels[x, y] for y in range(0, height, stride) for x in range(0, width, stride)]


def subject_color_penalty(color: RGB, subject: str) -> int:
    text = subject.lower()
    penalties = (
        (("green", "lime", "grass", "leaf", "toxic"), (0, 255, 0)),
        (("magenta", "pink", "purple", "violet"), (255, 0, 255)),
        (("blue", "cyan", "water", "ice"), (0, 255, 255)),
        (("yellow", "gold", "duck", "banana"), (255, 255, 0)),
        (("orange", "beak", "feet", "shoe", "boot"), (255, 128, 0)),
        (("red", "cola", "blood", "fire"), (255, 0, 51)),
        (("white", "egg", "snow", "glass"), (255, 255, 255)),
        (("black", "outline", "shadow", "night"), (0, 0, 0)),
    )
    penalty = 0
    for words, anchor in penalties:
        if any(word in text for word in words):
            penalty += max(0, 255 - color_distance(color, anchor))
    return penalty


def pick_control_grid_colors(
    *,
    profile: str = "auto",
    reference_image: Image.Image | None = None,
    subject: str = "",
    background_override: RGB | None = None,
    grid_override: RGB | None = None,
) -> tuple[RGB, RGB, str]:
    if profile != "auto":
        if profile not in CONTROL_GRID_PROFILES:
            choices = ", ".join(["auto", *sorted(CONTROL_GRID_PROFILES)])
            raise ValueError(f"unknown control-grid profile {profile!r}; choose one of: {choices}")
        background, grid = CONTROL_GRID_PROFILES[profile]
        return (background_override or background, grid_override or grid, profile)

    samples = sample_image_colors(reference_image) if reference_image is not None else []

    def profile_score(item: tuple[str, tuple[RGB, RGB]]) -> tuple[int, str]:
        name, (background, grid) = item
        score = color_distance(background, grid)
        if samples:
            bg_min = min(color_distance(background, pixel) for pixel in samples)
            grid_min = min(color_distance(grid, pixel) for pixel in samples)
            score += bg_min * 4 + grid_min * 3
        score -= subject_color_penalty(background, subject) * 4
        score -= subject_color_penalty(grid, subject) * 4
        return (score, name)

    selected_name, selected_pair = max(CONTROL_GRID_PROFILES.items(), key=profile_score)
    background, grid = selected_pair
    return (background_override or background, grid_override or grid, f"auto:{selected_name}")


def resolve_cell_size(cells: int, cell_size: int | None, target_side: int | None) -> int:
    if cells <= 0:
        raise ValueError("cells must be positive")
    if target_side is not None:
        if target_side <= 0:
            raise ValueError("target side must be positive")
        if target_side % cells != 0:
            raise ValueError("target side must be divisible by cells")
        return target_side // cells
    if cell_size is None or cell_size <= 0:
        raise ValueError("cell size must be positive")
    return cell_size


def write_control_process_settings(
    settings_output: Path,
    *,
    cells: int,
    background: RGB,
    grid_color: RGB,
    sample_margin_ratio: float = 0.40,
    sample_mode: str = "median",
) -> None:
    payload = {
        "cells": cells,
        "chroma_key": rgb_to_hex(background),
        "grid_key": rgb_to_hex(grid_color),
        "sample_mode": sample_mode,
        "sample_margin_ratio": sample_margin_ratio,
        "recommended_command_fragment": (
            f'--cells {cells} --chroma-key "{rgb_to_hex(background)}" '
            f'--grid-key "{rgb_to_hex(grid_color)}" --sample-mode {sample_mode} '
            f"--sample-margin-ratio {sample_margin_ratio:.2f}"
        ),
    }
    settings_output.parent.mkdir(parents=True, exist_ok=True)
    settings_output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def create_control_grid(
    input_path: Path,
    output_path: Path,
    *,
    cells: int = 64,
    cell_size: int | None = 16,
    target_side: int | None = None,
    crop: tuple[int, int, int, int] | None = None,
    background: RGB | None = None,
    padding_ratio: float = 0.06,
    grid_color: RGB | None = None,
    grid_line_width: int = 1,
    profile: str = "auto",
    remove_reference_bg: bool = False,
    reference_bg_tolerance: int = 70,
    settings_output: Path | None = None,
) -> Image.Image:
    cell_size = resolve_cell_size(cells, cell_size, target_side)
    if grid_line_width <= 0:
        raise ValueError("grid line width must be positive")
    if not 0 <= padding_ratio < 0.5:
        raise ValueError("padding ratio must be in [0, 0.5)")

    src = Image.open(input_path).convert("RGB")
    if crop is not None:
        x, y, width, height = crop
        src = src.crop((x, y, x + width, y + height))
    background, grid_color, _selected_profile = pick_control_grid_colors(
        profile=profile,
        reference_image=src,
        background_override=background,
        grid_override=grid_color,
    )
    if remove_reference_bg:
        src = replace_reference_background(src, background, reference_bg_tolerance)

    side = cells * cell_size
    padding = int(round(side * padding_ratio))
    canvas = fit_image_into_square(src, side, padding, background)
    canvas = draw_real_grid(canvas, cells, grid_color, grid_line_width)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)
    if settings_output is not None:
        write_control_process_settings(settings_output, cells=cells, background=background, grid_color=grid_color)
    return canvas


def build_scratch_control_grid_prompt(
    subject: str,
    *,
    cells: int = 64,
    background: RGB = (255, 0, 255),
    grid_color: RGB = (0, 255, 255),
) -> str:
    return "\n".join(
        [
            f"Edit the provided {cells}x{cells} pixel control-grid image into this asset: {subject}.",
            "",
            "Hard contract:",
            "- The provided canvas is the control grid; each visible cell is one final pixel.",
            "- Keep the exact canvas size, grid spacing, and cell alignment.",
            f"- Keep the flat {rgb_to_hex(background)} background outside the sprite.",
            f"- Keep the {rgb_to_hex(grid_color)} grid as a removable guide; do not turn grid lines into artwork.",
            "- Place every sprite color decision inside the existing cells; no half-cell edges.",
            "- Use crisp square pixel blocks only: no antialiasing, soft blur, subpixel strokes, gradients that ignore the grid, or painterly texture.",
            "- Preserve readable silhouette, outline, highlights, shadows, and small details as deliberate pixel clusters.",
            "- No UI, text, labels, borders, watermark, floor shadow, cast shadow, or extra props.",
            "- Keep generous padding so no part touches the image edge.",
            "",
            "After generation this will be sampled by code from the center of each grid cell, so the visual identity must live in the cells, not between them.",
        ]
    )


def create_scratch_control_grid(
    output_path: Path,
    *,
    cells: int = 64,
    cell_size: int | None = 16,
    target_side: int | None = None,
    background: RGB | None = None,
    grid_color: RGB | None = None,
    grid_line_width: int = 1,
    profile: str = "auto",
    reference_image: Image.Image | None = None,
    prompt_output: Path | None = None,
    settings_output: Path | None = None,
    subject: str = "a clean production-ready pixel art sprite",
) -> Image.Image:
    cell_size = resolve_cell_size(cells, cell_size, target_side)
    if grid_line_width <= 0:
        raise ValueError("grid line width must be positive")
    background, grid_color, _selected_profile = pick_control_grid_colors(
        profile=profile,
        reference_image=reference_image,
        subject=subject,
        background_override=background,
        grid_override=grid_color,
    )

    side = cells * cell_size
    canvas = Image.new("RGB", (side, side), background)
    canvas = draw_real_grid(canvas, cells, grid_color, grid_line_width)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)

    if prompt_output is not None:
        prompt_output.parent.mkdir(parents=True, exist_ok=True)
        prompt_output.write_text(
            build_scratch_control_grid_prompt(subject, cells=cells, background=background, grid_color=grid_color),
            encoding="utf-8",
        )
    if settings_output is not None:
        write_control_process_settings(settings_output, cells=cells, background=background, grid_color=grid_color)

    return canvas


def build_sheet_control_grid_prompt(
    subject: str,
    *,
    rows: int,
    cols: int,
    frame_cells: int,
    background: RGB,
    grid_color: RGB,
    frames: tuple[str, ...] = (),
) -> str:
    frame_lines = []
    total = rows * cols
    for index in range(total):
        label = frames[index] if index < len(frames) else f"animation frame {index + 1}"
        row, col = divmod(index, cols)
        frame_lines.append(f"- Frame {index + 1} at row {row + 1}, column {col + 1}: {label}.")

    return "\n".join(
        [
            f"Edit the provided {rows}x{cols} animation control-grid sheet into this asset: {subject}.",
            "",
            "Frame plan:",
            *frame_lines,
            "",
            "Hard contract:",
            f"- Each sheet slot contains a real {frame_cells}x{frame_cells} pixel control grid; each visible cell is one final pixel.",
            "- Keep the exact canvas size, slot positions, grid spacing, and cell alignment.",
            f"- Keep the flat {rgb_to_hex(background)} background outside the sprite in every frame.",
            f"- Keep the {rgb_to_hex(grid_color)} grid as a removable guide; do not turn grid lines into artwork.",
            "- Keep the same object identity, palette, outline style, and pixel scale across all frames.",
            "- Animate only the intended motion; do not redesign the asset between frames.",
            "- No part crosses a frame edge. No UI, text, labels, borders, watermark, floor shadow, cast shadow, or extra props.",
            "- Use crisp square pixel blocks only: no antialiasing, soft blur, subpixel strokes, or painterly texture.",
            "",
            "After generation, code will split the sheet and sample the center of every cell in each frame.",
        ]
    )


def create_sheet_control_grid(
    output_path: Path,
    *,
    rows: int,
    cols: int,
    frame_cells: int = 64,
    cell_size: int | None = 16,
    frame_side: int | None = None,
    background: RGB | None = None,
    grid_color: RGB | None = None,
    grid_line_width: int = 1,
    profile: str = "auto",
    prompt_output: Path | None = None,
    settings_output: Path | None = None,
    subject: str = "a clean production-ready pixel art animation",
    frames: tuple[str, ...] = (),
) -> Image.Image:
    if rows <= 0 or cols <= 0:
        raise ValueError("rows and cols must be positive")
    cell_size = resolve_cell_size(frame_cells, cell_size, frame_side)
    if grid_line_width <= 0:
        raise ValueError("grid line width must be positive")

    background, grid_color, _selected_profile = pick_control_grid_colors(
        profile=profile,
        subject=subject,
        background_override=background,
        grid_override=grid_color,
    )
    tile_side = frame_cells * cell_size
    tile = draw_real_grid(Image.new("RGB", (tile_side, tile_side), background), frame_cells, grid_color, grid_line_width)
    sheet = Image.new("RGB", (cols * tile_side, rows * tile_side), background)
    for row in range(rows):
        for col in range(cols):
            sheet.paste(tile, (col * tile_side, row * tile_side))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)

    if prompt_output is not None:
        prompt_output.parent.mkdir(parents=True, exist_ok=True)
        prompt_output.write_text(
            build_sheet_control_grid_prompt(
                subject,
                rows=rows,
                cols=cols,
                frame_cells=frame_cells,
                background=background,
                grid_color=grid_color,
                frames=frames,
            ),
            encoding="utf-8",
        )
    if settings_output is not None:
        write_control_process_settings(settings_output, cells=frame_cells, background=background, grid_color=grid_color)

    return sheet


def channel_median(values: list[RGB]) -> RGB:
    return tuple(int(median(pixel[i] for pixel in values)) for i in range(3))  # type: ignore[return-value]


def color_distance(a: RGB, b: RGB) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])


def clamp_channel(value: float) -> int:
    return max(0, min(255, int(round(value))))


def is_chroma_like(pixel: RGB, key: RGB, tolerance: int) -> bool:
    if color_distance(pixel, key) <= tolerance:
        return True

    # Generated grid images often turn #00ff00 into dark green edge variants.
    if key[1] > key[0] * 2 and key[1] > key[2] * 2:
        r, g, b = pixel
        return g >= 45 and ((g > r * 2 and g > b * 2) or (g >= int(r * 1.2) and g > int(b * 1.5)))

    # Blue chroma backgrounds often drift toward saturated cyan-blue.
    if key[2] > 180 and key[0] < 90:
        r, g, b = pixel
        return b >= 120 and r <= 90 and b > int(g * 1.05)

    return False


def is_grid_like(pixel: RGB, key: RGB, tolerance: int) -> bool:
    if color_distance(pixel, key) <= tolerance:
        return True

    # Magenta service grids can be softened by imagegen into purple edge echoes.
    if key[0] > 180 and key[2] > 180 and key[1] < 90:
        r, g, b = pixel
        return r >= 100 and b >= 100 and g * 2 < min(r, b)

    if key[0] > 180 and key[1] > 180 and key[2] < 90:
        r, g, b = pixel
        return r >= 120 and g >= 120 and b <= 140

    if key[1] > 180 and key[2] > 180 and key[0] < 90:
        r, g, b = pixel
        return g >= 120 and b >= 120 and r <= 140

    if key[2] > 180 and key[0] < 90:
        r, g, b = pixel
        return b >= 120 and r <= 100 and b > int(g * 1.05)

    return False


def estimate_background(samples: list[RGB]) -> RGB:
    return channel_median(samples)


def estimate_border_background(image: Image.Image) -> RGB:
    width, height = image.size
    pixels = image.load()
    border = max(2, min(width, height) // 16)
    buckets: dict[RGB, list[RGB]] = {}

    for y in range(height):
        for x in range(width):
            if border <= x < width - border and border <= y < height - border:
                continue

            pixel = pixels[x, y]
            if sum(pixel) <= 60:
                continue

            bucket: RGB = (pixel[0] // 16, pixel[1] // 16, pixel[2] // 16)
            buckets.setdefault(bucket, []).append(pixel)

    if not buckets:
        return estimate_background([pixels[0, 0], pixels[width - 1, 0], pixels[0, height - 1], pixels[width - 1, height - 1]])

    dominant = max(buckets.values(), key=len)
    return channel_median(dominant)


def quantize_rgb(image: Image.Image, colors: int) -> Image.Image:
    if colors <= 0:
        return image
    return image.convert("RGB").quantize(colors=colors, method=Image.Quantize.MEDIANCUT).convert("RGB")


def quantize_rgba(image: Image.Image, colors: int) -> Image.Image:
    if colors <= 0:
        return image

    alpha = image.getchannel("A")
    rgb = Image.new("RGB", image.size, (0, 0, 0))
    rgb.paste(image.convert("RGB"), mask=alpha)
    rgb = quantize_rgb(rgb, colors)
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def nearest_palette_color(color: RGB, palette: tuple[RGB, ...]) -> RGB:
    return min(
        palette,
        key=lambda candidate: (
            (color[0] - candidate[0]) ** 2 + (color[1] - candidate[1]) ** 2 + (color[2] - candidate[2]) ** 2,
            candidate,
        ),
    )


def apply_palette_lock(image: Image.Image, palette: tuple[RGB, ...]) -> Image.Image:
    if not palette:
        return image

    if image.mode == "RGBA":
        out = image.copy()
        pixels = out.load()
        cache: dict[RGB, RGB] = {}
        for y in range(out.height):
            for x in range(out.width):
                r, g, b, a = pixels[x, y]
                if a == 0:
                    continue
                rgb = (r, g, b)
                locked = cache.get(rgb)
                if locked is None:
                    locked = nearest_palette_color(rgb, palette)
                    cache[rgb] = locked
                pixels[x, y] = (locked[0], locked[1], locked[2], a)
        return out

    out = image.convert("RGB")
    pixels = out.load()
    cache: dict[RGB, RGB] = {}
    for y in range(out.height):
        for x in range(out.width):
            rgb = pixels[x, y]
            locked = cache.get(rgb)
            if locked is None:
                locked = nearest_palette_color(rgb, palette)
                cache[rgb] = locked
            pixels[x, y] = locked
    return out


def extract_clustered_palette(image: Image.Image, max_colors: int, merge_tolerance: int = 28) -> tuple[RGB, ...]:
    if max_colors <= 0:
        return ()
    if merge_tolerance < 0:
        raise ValueError("merge tolerance must be zero or positive")

    rgba = image.convert("RGBA")
    pixels = rgba.load()
    counts: Counter[RGB] = Counter()
    first_seen: dict[RGB, int] = {}
    order = 0
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            color = (r, g, b)
            if color not in first_seen:
                first_seen[color] = order
                order += 1
            counts[color] += 1
    if not counts:
        return ()

    tolerance_sq = merge_tolerance * merge_tolerance
    clusters: list[dict[str, object]] = []
    for color in sorted(counts, key=lambda item: (-counts[item], first_seen[item], item)):
        best_index: int | None = None
        best_distance: int | None = None
        for index, cluster in enumerate(clusters):
            rep = cluster["rep"]  # type: ignore[assignment]
            distance = (color[0] - rep[0]) ** 2 + (color[1] - rep[1]) ** 2 + (color[2] - rep[2]) ** 2
            if distance <= tolerance_sq and (best_distance is None or distance < best_distance):
                best_index = index
                best_distance = distance
        if best_index is None:
            clusters.append({"rep": color, "colors": Counter({color: counts[color]}), "total": counts[color]})
        else:
            cluster = clusters[best_index]
            cluster_colors = cluster["colors"]  # type: ignore[assignment]
            cluster_colors[color] += counts[color]
            cluster["total"] = int(cluster["total"]) + counts[color]

    def cluster_rep(cluster: dict[str, object]) -> RGB:
        cluster_colors = cluster["colors"]  # type: ignore[assignment]
        return min(cluster_colors, key=lambda color: (-cluster_colors[color], first_seen[color], color))

    def cluster_rank(cluster: dict[str, object]) -> tuple[float, int, RGB]:
        rep = cluster_rep(cluster)
        total = int(cluster["total"])
        rare_bonus = 0.0
        if is_rare_palette_worthy(rep):
            rare_bonus += total * 0.35 + 2.0
        if color_luma(rep) < 80 or color_chroma(rep) > 70:
            rare_bonus += 1.0
        return (-(total + rare_bonus), first_seen[rep], rep)

    selected = [cluster_rep(cluster) for cluster in sorted(clusters, key=cluster_rank)[:max_colors]]
    return tuple(dict.fromkeys(selected))


def style_reference_artifact_cleanup(
    image: Image.Image,
    *,
    palette: int = 18,
    merge_tolerance: int = 28,
    island_size: int = 2,
    preset: str = "fighter",
) -> tuple[Image.Image, tuple[RGB, ...]]:
    if palette < 0:
        raise ValueError("palette must be zero or positive")
    if island_size < 0:
        raise ValueError("island size must be zero or positive")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")

    rgba = image.convert("RGBA")
    locked_palette = extract_clustered_palette(rgba, palette, merge_tolerance) if palette > 0 else ()
    out = apply_palette_lock(rgba, locked_palette) if locked_palette else rgba
    protected = protected_face_detail_pixels(out, preset)
    if island_size > 0:
        out = remove_small_color_components(out, island_size + 1, protected)
    return out, locked_palette


def apply_reference_color_transfer(image: Image.Image, reference: Image.Image, *, radius: int = 3) -> Image.Image:
    source = image.convert("RGBA")
    ref = reference.convert("RGBA")
    source_bbox = alpha_bbox(source)
    ref_bbox = alpha_bbox(ref)
    if source_bbox is None or ref_bbox is None:
        return source

    sx0, sy0, sx1, sy1 = source_bbox
    rx0, ry0, rx1, ry1 = ref_bbox
    source_w = max(1, sx1 - sx0 - 1)
    source_h = max(1, sy1 - sy0 - 1)
    ref_w = max(1, rx1 - rx0 - 1)
    ref_h = max(1, ry1 - ry0 - 1)
    ref_pixels = ref.load()
    dark_palette = tuple(color for color in extract_full_palette(ref) if color_luma(color) < 70)
    out = source.copy()
    out_pixels = out.load()
    cache: dict[tuple[RGB, int, int], RGB] = {}

    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = out_pixels[x, y]
            if a == 0:
                continue
            nx = (x - sx0) / source_w
            ny = (y - sy0) / source_h
            ref_x = int(round(rx0 + max(0.0, min(1.0, nx)) * ref_w))
            ref_y = int(round(ry0 + max(0.0, min(1.0, ny)) * ref_h))
            key = ((r, g, b), ref_x, ref_y)
            locked = cache.get(key)
            if locked is None:
                local: list[RGB] = []
                for yy in range(max(0, ref_y - radius), min(ref.height, ref_y + radius + 1)):
                    for xx in range(max(0, ref_x - radius), min(ref.width, ref_x + radius + 1)):
                        rr, gg, bb, aa = ref_pixels[xx, yy]
                        if aa:
                            local.append((rr, gg, bb))
                if color_luma((r, g, b)) < 70:
                    candidates = tuple(color for color in local if color_luma(color) < 90) or dark_palette or tuple(local)
                else:
                    candidates = tuple(color for color in local if color_luma(color) >= 45) or tuple(local)
                locked = nearest_palette_color((r, g, b), tuple(candidates)) if candidates else (r, g, b)
                cache[key] = locked
            out_pixels[x, y] = (locked[0], locked[1], locked[2], a)
    return out


def dominant_color(values: list[RGB]) -> RGB:
    counts = Counter(values)
    return min(counts.items(), key=lambda item: (-item[1], item[0]))[0]


def sample_color(values: list[RGB], mode: str) -> RGB:
    if mode == "mode":
        return dominant_color(values)
    return channel_median(values)


def rgba_channel_median(values: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    return tuple(int(median(pixel[i] for pixel in values)) for i in range(4))  # type: ignore[return-value]


def block_color(values: list[tuple[int, int, int, int]], sample_mode: str) -> tuple[int, int, int, int]:
    if not values:
        return (0, 0, 0, 0)
    if sample_mode == "mode":
        return min(Counter(values).items(), key=lambda item: (-item[1], item[0]))[0]
    return rgba_channel_median(values)


def block_deviation(values: list[tuple[int, int, int, int]], color: tuple[int, int, int, int]) -> float:
    if not values:
        return 0.0
    total = 0
    for pixel in values:
        total += abs(pixel[0] - color[0]) + abs(pixel[1] - color[1]) + abs(pixel[2] - color[2]) + abs(pixel[3] - color[3])
    return total / len(values)


def rgba_luma(pixel: tuple[int, int, int, int]) -> float:
    if pixel[3] == 0:
        return 255.0
    return 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]


def dark_stroke_block_color(
    values: list[tuple[int, int, int, int]],
    *,
    dark_threshold: float = 38.0,
    max_dark_share: float = 0.42,
) -> tuple[int, int, int, int]:
    if not values:
        return (0, 0, 0, 0)
    opaque = [pixel for pixel in values if pixel[3] > 0]
    if not opaque:
        return (0, 0, 0, 0)

    mode = min(Counter(opaque).items(), key=lambda item: (-item[1], item[0]))[0]
    mode_luma = rgba_luma(mode)
    min_luma = min(rgba_luma(pixel) for pixel in opaque)
    if mode_luma - min_luma < dark_threshold:
        return mode

    dark_limit = min_luma + max(8.0, dark_threshold * 0.35)
    dark_pixels = [pixel for pixel in opaque if rgba_luma(pixel) <= dark_limit]
    if not dark_pixels or len(dark_pixels) > max(1, int(round(len(opaque) * max_dark_share))):
        return mode
    return min(Counter(dark_pixels).items(), key=lambda item: (-item[1], item[0]))[0]


def block_center_color(
    pixels,
    left: int,
    top: int,
    width: int,
    height: int,
    image_width: int,
    image_height: int,
) -> tuple[int, int, int, int]:
    x = min(image_width - 1, max(0, left + width // 2))
    y = min(image_height - 1, max(0, top + height // 2))
    return pixels[x, y]


def sample_lattice(
    image: Image.Image,
    pixel_size: int,
    *,
    phase_x: int = 0,
    phase_y: int = 0,
    sample_mode: str = "median",
    dark_threshold: float = 38.0,
) -> tuple[Image.Image, dict[str, object]]:
    if pixel_size <= 0:
        raise ValueError("pixel size must be positive")
    if sample_mode not in {"median", "mode", "center", "dark-stroke"}:
        raise ValueError("sample mode must be median, mode, center, or dark-stroke")

    rgba = image.convert("RGBA")
    if phase_x < 0 or phase_y < 0 or phase_x >= pixel_size or phase_y >= pixel_size:
        raise ValueError("phase must be inside one pixel-size period")

    cols = (rgba.width - phase_x) // pixel_size
    rows = (rgba.height - phase_y) // pixel_size
    if cols <= 0 or rows <= 0:
        raise ValueError("pixel size and phase produce no output cells")

    pixels = rgba.load()
    out = Image.new("RGBA", (cols, rows), (0, 0, 0, 0))
    out_pixels = out.load()
    deviations: list[float] = []
    for row in range(rows):
        for col in range(cols):
            left = phase_x + col * pixel_size
            top = phase_y + row * pixel_size
            values = [
                pixels[x, y]
                for y in range(top, top + pixel_size)
                for x in range(left, left + pixel_size)
            ]
            if sample_mode == "center":
                color = block_center_color(pixels, left, top, pixel_size, pixel_size, rgba.width, rgba.height)
            elif sample_mode == "dark-stroke":
                color = dark_stroke_block_color(values, dark_threshold=dark_threshold)
            else:
                color = block_color(values, sample_mode)
            deviations.append(block_deviation(values, color))
            out_pixels[col, row] = color

    meta = {
        "pixel_size": pixel_size,
        "phase": [phase_x, phase_y],
        "output_size": [cols, rows],
        "sample_mode": sample_mode,
        "mean_block_deviation": round(sum(deviations) / len(deviations), 3) if deviations else 0,
    }
    return out, meta


def rgba_edge_delta(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> int:
    if a[3] == 0 and b[3] == 0:
        return 0
    if a[3] == 0 or b[3] == 0:
        return abs(a[3] - b[3])
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2]) + abs(a[3] - b[3])


def axis_edge_profile(image: Image.Image, axis: str) -> list[float]:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    if axis == "x":
        profile = [0.0] * rgba.width
        for x in range(1, rgba.width):
            total = 0
            for y in range(rgba.height):
                total += rgba_edge_delta(pixels[x - 1, y], pixels[x, y])
            profile[x] = total / max(1, rgba.height)
        return profile
    if axis == "y":
        profile = [0.0] * rgba.height
        for y in range(1, rgba.height):
            total = 0
            for x in range(rgba.width):
                total += rgba_edge_delta(pixels[x, y - 1], pixels[x, y])
            profile[y] = total / max(1, rgba.width)
        return profile
    raise ValueError("axis must be x or y")


def periodic_boundary_score(profile: list[float], pixel_size: int, phase: int) -> float:
    if pixel_size <= 0:
        raise ValueError("pixel size must be positive")
    positions = []
    pos = phase if phase > 0 else pixel_size
    while pos < len(profile):
        positions.append(pos)
        pos += pixel_size
    if not positions:
        return 0.0
    return sum(profile[pos] for pos in positions) / len(positions)


def infer_axis_phase_from_edges(profile: list[float], pixel_size: int) -> tuple[int, float]:
    if pixel_size <= 0:
        raise ValueError("pixel size must be positive")
    best_phase = 0
    best_score = -1.0
    for phase in range(pixel_size):
        score = periodic_boundary_score(profile, pixel_size, phase)
        if score > best_score:
            best_phase = phase
            best_score = score
    return best_phase, best_score


def infer_fake_pixel_lattice_from_edges(
    image: Image.Image,
    *,
    cells: int = 64,
    max_pixel_size: int = 32,
    sample_mode: str = "median",
) -> dict[str, object]:
    if cells <= 0:
        raise ValueError("cells must be positive")
    if max_pixel_size < 2:
        raise ValueError("max pixel size must be at least 2")

    rgba = image.convert("RGBA")
    x_profile = axis_edge_profile(rgba, "x")
    y_profile = axis_edge_profile(rgba, "y")
    target_subject_pixels = max(8, int(round(cells * 0.9)))
    expected = max(2, min(max_pixel_size, int(round(max(rgba.width, rgba.height) / target_subject_pixels))))
    sizes = range(max(2, expected - 5), min(max_pixel_size, expected + 5) + 1)
    candidates: list[dict[str, object]] = []
    for size in sizes:
        phase_x, edge_x = infer_axis_phase_from_edges(x_profile, size)
        phase_y, edge_y = infer_axis_phase_from_edges(y_profile, size)
        try:
            sampled, meta = sample_lattice(rgba, size, phase_x=phase_x, phase_y=phase_y, sample_mode=sample_mode)
        except ValueError:
            continue
        bbox = alpha_bbox(sampled)
        if bbox is None:
            continue
        bbox_w = bbox[2] - bbox[0]
        bbox_h = bbox[3] - bbox[1]
        target_penalty = abs(max(bbox_w, bbox_h) - target_subject_pixels)
        deviation = float(meta["mean_block_deviation"])
        edge_score = edge_x + edge_y
        score = edge_score - deviation * 0.08 - target_penalty * 0.4
        candidates.append(
            {
                "pixel_size": size,
                "phase": [phase_x, phase_y],
                "edge_score": round(edge_score, 3),
                "edge_x": round(edge_x, 3),
                "edge_y": round(edge_y, 3),
                "mean_block_deviation": deviation,
                "output_size": [sampled.width, sampled.height],
                "bbox_size": [bbox_w, bbox_h],
                "target_penalty": target_penalty,
                "score": round(score, 6),
            }
        )
    if not candidates:
        raise ValueError("could not infer fake pixel lattice from edges")
    best = max(candidates, key=lambda item: float(item["score"]))
    return {
        "best": best,
        "expected_pixel_size": expected,
        "candidates": sorted(candidates, key=lambda item: float(item["score"]), reverse=True),
    }


def profile_spread(profile: list[float]) -> float:
    if not profile:
        return 0.0
    mean = sum(profile) / len(profile)
    return (sum((value - mean) ** 2 for value in profile) / len(profile)) ** 0.5


def profile_interp(profile: list[float], position: float) -> float:
    if not profile:
        return 0.0
    if position <= 0:
        return profile[0]
    if position >= len(profile) - 1:
        return profile[-1]
    left = int(position)
    frac = position - left
    return profile[left] * (1.0 - frac) + profile[left + 1] * frac


def grid_axis_score_and_origin(profile: list[float], period: float) -> tuple[float, float]:
    if len(profile) < 4 or period < 1.5:
        return 0.0, 0.0
    spread = profile_spread(profile)
    if spread <= 1e-6:
        return 0.0, 0.0

    best_score = -1.0
    best_origin = 0.0
    phase_count = 12
    for phase_index in range(phase_count):
        origin = ((phase_index / phase_count) - 0.5) * period
        positions: list[float] = []
        index = 1
        while True:
            position = origin + index * period
            if position > len(profile) - 1:
                break
            if position >= 0:
                positions.append(position)
            index += 1
        if len(positions) < 4:
            continue

        interiors = [position + period * 0.5 for position in positions if position + period * 0.5 <= len(profile) - 1]
        if len(interiors) < 4:
            continue
        boundaries = [profile_interp(profile, position) for position in positions]
        interior_values = [profile_interp(profile, position) for position in interiors]
        boundary_mean = sum(boundaries) / len(boundaries)
        interior_mean = sum(interior_values) / len(interior_values)
        boundary_peak = sorted(boundaries)[min(len(boundaries) - 1, int(round((len(boundaries) - 1) * 0.78)))]
        score = ((0.65 * boundary_mean + 0.35 * boundary_peak) - interior_mean) / spread
        score *= len(positions) ** 0.18
        if score > best_score:
            best_score = score
            best_origin = origin
    return max(0.0, best_score), best_origin


def detect_hidden_grid_variants(
    image: Image.Image,
    *,
    max_output_width: int = 4096,
    max_output_height: int = 1024,
    min_output_size: int = 16,
    max_variants: int = 9,
) -> list[dict[str, float | int]]:
    rgba = image.convert("RGBA")
    x_profile = axis_edge_profile(rgba, "x")
    y_profile = axis_edge_profile(rgba, "y")
    min_height = max(min_output_size, int((rgba.height + 23) // 24))
    max_height = min(max_output_height, max(min_output_size, rgba.height // 2))
    scored: list[dict[str, float | int]] = []
    for height in range(min_height, max_height + 1):
        cell_h = rgba.height / height
        if cell_h < 1.75 or cell_h > 32.0:
            continue
        width = max(min_output_size, int(round(rgba.width / cell_h)))
        if width > max_output_width:
            continue
        cell_w = rgba.width / width
        score_y, origin_y = grid_axis_score_and_origin(y_profile, cell_h)
        score_x, origin_x = grid_axis_score_and_origin(x_profile, cell_w)
        square_penalty = abs(cell_w - cell_h) / max(cell_h, 1e-6)
        score = score_y * 0.58 + score_x * 0.42 - square_penalty * 0.6
        if score <= 0:
            continue
        scored.append(
            {
                "width": width,
                "height": height,
                "cellSize": round((cell_w + cell_h) * 0.5, 3),
                "cellWidth": round(cell_w, 3),
                "cellHeight": round(cell_h, 3),
                "score": round(score, 4),
                "originX": round(origin_x, 3),
                "originY": round(origin_y, 3),
            }
        )

    ranked = sorted(scored, key=lambda item: float(item["score"]), reverse=True)
    variants: list[dict[str, float | int]] = []
    for item in ranked:
        if any(abs(int(item["height"]) - int(existing["height"])) < 4 for existing in variants):
            continue
        variants.append(item)
        if len(variants) >= max_variants:
            break
    return variants


def hidden_grid_cell_values(
    image: Image.Image,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
) -> list[tuple[int, int, int, int]]:
    pixels = image.load()
    values: list[tuple[int, int, int, int]] = []
    for y in range(max(0, y0), min(image.height, y1)):
        for x in range(max(0, x0), min(image.width, x1)):
            values.append(pixels[x, y])
    return values


def sample_hidden_grid(
    image: Image.Image,
    variant: dict[str, float | int],
    *,
    sample_mode: str = "center",
    dark_threshold: float = 38.0,
) -> tuple[Image.Image, dict[str, object]]:
    if sample_mode not in {"median", "mode", "center", "dark-stroke"}:
        raise ValueError("sample mode must be median, mode, center, or dark-stroke")
    rgba = image.convert("RGBA")
    width = int(variant["width"])
    height = int(variant["height"])
    origin_x = float(variant.get("originX", 0.0))
    origin_y = float(variant.get("originY", 0.0))
    cell_w = rgba.width / max(1, width)
    cell_h = rgba.height / max(1, height)
    pixels = rgba.load()
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    out_pixels = out.load()
    deviations: list[float] = []
    for row in range(height):
        for col in range(width):
            left = int(origin_x + col * cell_w)
            top = int(origin_y + row * cell_h)
            right = int(origin_x + (col + 1) * cell_w + 0.999999)
            bottom = int(origin_y + (row + 1) * cell_h + 0.999999)
            values = hidden_grid_cell_values(rgba, left, top, right, bottom)
            if sample_mode == "center":
                sample_x = min(rgba.width - 1, max(0, int(origin_x + (col + 0.5) * cell_w)))
                sample_y = min(rgba.height - 1, max(0, int(origin_y + (row + 0.5) * cell_h)))
                color = pixels[sample_x, sample_y]
            elif sample_mode == "dark-stroke":
                color = dark_stroke_block_color(values, dark_threshold=dark_threshold)
            else:
                color = block_color(values, sample_mode)
            deviations.append(block_deviation(values, color))
            out_pixels[col, row] = color
    return out, {
        "variant": variant,
        "output_size": [width, height],
        "sample_mode": sample_mode,
        "mean_block_deviation": round(sum(deviations) / len(deviations), 3) if deviations else 0,
    }


def lattice_contrast(image: Image.Image) -> float:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    total = 0
    count = 0
    for y in range(rgba.height):
        for x in range(rgba.width):
            current = pixels[x, y]
            if x + 1 < rgba.width:
                other = pixels[x + 1, y]
                total += abs(current[0] - other[0]) + abs(current[1] - other[1]) + abs(current[2] - other[2]) + abs(current[3] - other[3])
                count += 1
            if y + 1 < rgba.height:
                other = pixels[x, y + 1]
                total += abs(current[0] - other[0]) + abs(current[1] - other[1]) + abs(current[2] - other[2]) + abs(current[3] - other[3])
                count += 1
    return total / count if count else 0.0


def infer_lattice(image: Image.Image, *, max_pixel_size: int = 32, sample_mode: str = "median") -> dict[str, object]:
    if max_pixel_size < 2:
        raise ValueError("max pixel size must be at least 2")
    if sample_mode not in {"median", "mode"}:
        raise ValueError("sample mode must be median or mode")

    rgba = image.convert("RGBA")
    candidates: list[dict[str, object]] = []
    max_size = min(max_pixel_size, rgba.width, rgba.height)
    for pixel_size in range(2, max_size + 1):
        phase_limit = min(pixel_size, 8)
        best_for_size: dict[str, object] | None = None
        for phase_y in range(phase_limit):
            for phase_x in range(phase_limit):
                try:
                    sampled, meta = sample_lattice(rgba, pixel_size, phase_x=phase_x, phase_y=phase_y, sample_mode=sample_mode)
                except ValueError:
                    continue
                cols, rows = sampled.size
                if cols < 2 or rows < 2:
                    continue
                contrast = lattice_contrast(sampled)
                deviation = float(meta["mean_block_deviation"])
                score = contrast * (pixel_size ** 0.35) / (deviation + 1.0)
                candidate = {
                    "pixel_size": pixel_size,
                    "phase": [phase_x, phase_y],
                    "output_size": [cols, rows],
                    "mean_block_deviation": deviation,
                    "contrast": round(contrast, 3),
                    "score": round(score, 6),
                }
                if best_for_size is None or float(candidate["score"]) > float(best_for_size["score"]):
                    best_for_size = candidate
        if best_for_size is not None:
            candidates.append(best_for_size)

    if not candidates:
        raise ValueError("could not infer a pixel lattice")
    best = max(candidates, key=lambda item: (float(item["score"]), int(item["pixel_size"])))
    return {
        "best": best,
        "candidates": sorted(candidates, key=lambda item: float(item["score"]), reverse=True)[:12],
    }


def repixelize_image(
    input_path: Path,
    output_path: Path,
    *,
    pixel_size: int | None = None,
    max_pixel_size: int = 32,
    phase_x: int | None = None,
    phase_y: int | None = None,
    sample_mode: str = "median",
    palette: int = 0,
    transparent: bool = False,
    chroma_key: RGB | None = None,
    chroma_tolerance: int = 64,
    scale: int = 1,
) -> dict[str, object]:
    if scale <= 0:
        raise ValueError("scale must be positive")
    image = Image.open(input_path).convert("RGBA")
    if chroma_key is not None:
        image = remove_keyed_background(image, chroma_key, chroma_tolerance)

    inference: dict[str, object] | None = None
    if pixel_size is None:
        inference = infer_lattice(image, max_pixel_size=max_pixel_size, sample_mode=sample_mode)
        best = inference["best"]
        pixel_size = int(best["pixel_size"])  # type: ignore[index]
        inferred_phase = best["phase"]  # type: ignore[index]
        phase_x = int(inferred_phase[0]) if phase_x is None else phase_x
        phase_y = int(inferred_phase[1]) if phase_y is None else phase_y
    phase_x = 0 if phase_x is None else phase_x
    phase_y = 0 if phase_y is None else phase_y

    repixelized, lattice_meta = sample_lattice(image, pixel_size, phase_x=phase_x, phase_y=phase_y, sample_mode=sample_mode)
    if not transparent:
        background = estimate_border_background(repixelized.convert("RGB"))
        rgb = Image.new("RGB", repixelized.size, background)
        rgb.paste(repixelized.convert("RGB"), mask=repixelized.getchannel("A"))
        repixelized = rgb.convert("RGBA")
    if palette > 0:
        repixelized = quantize_rgba(repixelized, palette)
    output_image = repixelized
    if scale != 1:
        output_image = repixelized.resize((repixelized.width * scale, repixelized.height * scale), Image.Resampling.NEAREST)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_image.save(output_path)
    metadata = {
        "input": str(input_path),
        "output": str(output_path),
        "pixel_size": pixel_size,
        "phase": [phase_x, phase_y],
        "sample_mode": sample_mode,
        "palette": palette,
        "transparent": transparent,
        "scale": scale,
        "output_size": [repixelized.width, repixelized.height],
        "saved_size": [output_image.width, output_image.height],
        "lattice": lattice_meta,
        "inference": inference,
    }
    output_path.with_name(f"{output_path.stem}-repixelize-meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def repixelizer_backend_path(repo_or_src_path: Path) -> Path:
    src_path = repo_or_src_path / "src"
    if src_path.is_dir():
        return src_path
    return repo_or_src_path


def run_repixelizer_backend(
    input_path: Path,
    output_path: Path,
    *,
    repixelizer_path: Path | None = None,
    target_size: int | None = None,
    target_width: int | None = None,
    target_height: int | None = None,
    palette_path: Path | None = None,
    palette_mode: str = "off",
    diagnostics_dir: Path | None = None,
    seed: int = 7,
    steps: int = 200,
    device: str = "auto",
    strip_background: bool = False,
    skip_candidate_rerank: bool = False,
) -> dict[str, object]:
    if repixelizer_path is not None:
        sys.path.insert(0, str(repixelizer_backend_path(repixelizer_path)))
    try:
        from repixelizer.pipeline import run_pipeline  # type: ignore[import-not-found]
    except Exception as error:
        raise RuntimeError(
            "repixelizer backend is not importable. Install GameCult/repixelizer or pass --repixelizer-path /path/to/repixelizer."
        ) from error

    result = run_pipeline(
        input_path,
        output_path,
        target_size=target_size,
        target_width=target_width,
        target_height=target_height,
        palette_path=palette_path,
        palette_mode=palette_mode,
        diagnostics_dir=diagnostics_dir,
        seed=seed,
        steps=steps,
        device=device,
        strip_background=strip_background,
        enable_candidate_rerank=not skip_candidate_rerank,
    )
    inference = result.inference
    metadata = {
        "backend": "repixelizer",
        "input": str(input_path),
        "output": str(output_path),
        "target_width": inference.target_width,
        "target_height": inference.target_height,
        "confidence": round(float(inference.confidence), 6),
        "top_candidates": [
            {
                "target_width": candidate.target_width,
                "target_height": candidate.target_height,
                "score": round(float(candidate.score), 6),
                "breakdown": {key: round(float(value), 6) for key, value in candidate.breakdown.items()},
            }
            for candidate in inference.top_candidates[:12]
        ],
        "steps": steps,
        "device": device,
        "strip_background": strip_background,
        "palette_mode": palette_mode,
        "diagnostics_dir": str(diagnostics_dir) if diagnostics_dir else None,
    }
    output_path.with_name(f"{output_path.stem}-repixelizer-meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


TRANSPARENT_PIXEL = "transparent"


def normalize_pixel_color(value: object, fallback: str = TRANSPARENT_PIXEL) -> tuple[str, bool]:
    if isinstance(value, str):
        color = value.strip()
        lower = color.lower()
        if lower == TRANSPARENT_PIXEL:
            return TRANSPARENT_PIXEL, False
        if color.startswith("#") and len(color) in {4, 7, 9} and all(char in HEX_DIGITS for char in color[1:]):
            if len(color) == 4:
                return f"#{color[1] * 2}{color[2] * 2}{color[3] * 2}".lower(), True
            return f"#{color[1:]}".lower(), color != f"#{color[1:]}".lower()
    return fallback, True


def parse_jsonish_text(text: str) -> object:
    cleaned = text.replace("</think>", "")
    while "<think>" in cleaned.lower():
        lower = cleaned.lower()
        start = lower.find("<think>")
        end = lower.find("</think>", start)
        if end < 0:
            cleaned = cleaned[:start]
            break
        cleaned = cleaned[:start] + cleaned[end + len("</think>") :]
    cleaned = cleaned.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    if "```" in cleaned:
        parts = cleaned.split("```")
        for part in parts:
            candidate = part.strip()
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue
    object_start = cleaned.find("{")
    object_end = cleaned.rfind("}")
    if object_start >= 0 and object_end > object_start:
        try:
            return json.loads(cleaned[object_start : object_end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError("input does not contain a JSON object")


def extract_sprite_payload(value: object) -> object:
    if isinstance(value, str):
        return extract_sprite_payload(parse_jsonish_text(value))
    if not isinstance(value, dict):
        return value
    if {"width", "height", "pixels"}.issubset(value):
        return value
    for key in ("sprite", "pixelData", "pixel_data", "data", "result", "output"):
        nested = value.get(key)
        if nested is not None:
            return extract_sprite_payload(nested)
    content = value.get("content")
    if isinstance(content, str):
        return extract_sprite_payload(content)
    if isinstance(content, list):
        text = "\n".join(
            part
            if isinstance(part, str)
            else str(part.get("text", part.get("content", "")))
            if isinstance(part, dict)
            else ""
            for part in content
        )
        return extract_sprite_payload(text)
    choices = value.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                return extract_sprite_payload(message.get("content") or message.get("reasoning_content") or message)
            return extract_sprite_payload(first.get("text") or first.get("content") or first.get("delta") or first)
    return value


def validate_pixel_sprite(payload: object, *, fallback_color: str = TRANSPARENT_PIXEL, repair: bool = False) -> dict[str, object]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(payload, dict):
        return {"ok": False, "errors": ["Sprite data must be a JSON object."], "warnings": warnings}

    width = payload.get("width")
    height = payload.get("height")
    pixels = payload.get("pixels")
    if not isinstance(width, int) or width <= 0 or width > 128:
        errors.append("Width must be an integer between 1 and 128.")
    if not isinstance(height, int) or height <= 0 or height > 128:
        errors.append("Height must be an integer between 1 and 128.")
    if not isinstance(pixels, list):
        errors.append("Pixels must be a two-dimensional array.")
    if errors and not repair:
        return {"ok": False, "errors": errors, "warnings": warnings}
    if not isinstance(width, int) or not isinstance(height, int) or not isinstance(pixels, list):
        return {"ok": False, "errors": errors, "warnings": warnings}

    normalized: list[list[str]] = []
    invalid_colors = 0
    repaired_rows = 0
    repaired_cells = 0
    for y in range(height if repair else len(pixels)):
        row = pixels[y] if y < len(pixels) and isinstance(pixels[y], list) else []
        if y >= len(pixels) or not isinstance(pixels[y], list):
            repaired_rows += 1
            if not repair:
                errors.append(f"Row {y} must be an array.")
        if not repair and len(row) != width:
            errors.append(f"Width mismatch on row {y}: expected {width} colors, received {len(row)}.")
        out_row: list[str] = []
        for x in range(width if repair else len(row)):
            if x >= len(row):
                repaired_cells += 1
                out_row.append(fallback_color)
                continue
            color, changed = normalize_pixel_color(row[x], fallback_color)
            invalid_colors += 1 if changed else 0
            out_row.append(color)
        normalized.append(out_row)

    if not repair and len(pixels) != height:
        errors.append(f"Height mismatch: expected {height} pixel rows, received {len(pixels)}.")
    if invalid_colors:
        warnings.append(f"{invalid_colors} invalid color value{' was' if invalid_colors == 1 else 's were'} replaced with {fallback_color}.")
    if repair and (repaired_rows or repaired_cells or len(pixels) != height):
        warnings.append(f"AI returned an incomplete {width}x{height} grid, so missing pixels were filled with {fallback_color}.")
    if errors:
        return {"ok": False, "errors": errors, "warnings": warnings}
    return {"ok": True, "sprite": {"width": width, "height": height, "pixels": normalized}, "warnings": warnings}


def parse_pixel_color(color: str) -> tuple[int, int, int, int]:
    if color.lower() == TRANSPARENT_PIXEL:
        return (0, 0, 0, 0)
    hex_value = color[1:]
    if len(hex_value) == 6:
        return (int(hex_value[0:2], 16), int(hex_value[2:4], 16), int(hex_value[4:6], 16), 255)
    if len(hex_value) == 8:
        return (int(hex_value[0:2], 16), int(hex_value[2:4], 16), int(hex_value[4:6], 16), int(hex_value[6:8], 16))
    raise ValueError(f"invalid pixel color: {color}")


def render_pixel_sprite(sprite: dict[str, object], output_path: Path, *, scale: int = 1) -> Image.Image:
    if scale <= 0 or scale > 64:
        raise ValueError("scale must be between 1 and 64")
    width = int(sprite["width"])
    height = int(sprite["height"])
    pixels = sprite["pixels"]
    if not isinstance(pixels, list):
        raise ValueError("sprite pixels must be a list")
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    out = image.load()
    for y, row in enumerate(pixels):
        if not isinstance(row, list):
            continue
        for x, color in enumerate(row[:width]):
            out[x, y] = parse_pixel_color(str(color))
    saved = image.resize((width * scale, height * scale), Image.Resampling.NEAREST) if scale != 1 else image
    output_path.parent.mkdir(parents=True, exist_ok=True)
    saved.save(output_path)
    return image


def set_pixel_in_sprite(sprite: dict[str, object], x: int, y: int, color: str) -> dict[str, object]:
    width = int(sprite["width"])
    height = int(sprite["height"])
    if x < 0 or y < 0 or x >= width or y >= height:
        raise ValueError("pixel coordinates are outside the sprite canvas")
    normalized, _ = normalize_pixel_color(color)
    pixels = [list(row) for row in sprite["pixels"]]  # type: ignore[union-attr]
    pixels[y][x] = normalized
    return {"width": width, "height": height, "pixels": pixels}


def replace_color_in_sprite(sprite: dict[str, object], source_color: str, target_color: str) -> dict[str, object]:
    source, _ = normalize_pixel_color(source_color)
    target, _ = normalize_pixel_color(target_color)
    width = int(sprite["width"])
    height = int(sprite["height"])
    pixels = [
        [target if color == source else color for color in row]
        for row in sprite["pixels"]  # type: ignore[union-attr]
    ]
    return {"width": width, "height": height, "pixels": pixels}


def apply_pixel_patch(sprite: dict[str, object], patch_payload: object) -> dict[str, object]:
    if isinstance(patch_payload, dict):
        edits = patch_payload.get("pixels", patch_payload.get("edits", patch_payload.get("patch")))
    else:
        edits = patch_payload
    if not isinstance(edits, list):
        raise ValueError("patch must be a list or an object with pixels/edits/patch")
    next_sprite = sprite
    for index, edit in enumerate(edits):
        if isinstance(edit, dict):
            x = edit.get("x")
            y = edit.get("y")
            color = edit.get("color")
        elif isinstance(edit, list) and len(edit) >= 3:
            x, y, color = edit[0], edit[1], edit[2]
        else:
            raise ValueError(f"patch entry {index} must be {{x,y,color}} or [x,y,color]")
        if not isinstance(x, int) or not isinstance(y, int) or not isinstance(color, str):
            raise ValueError(f"patch entry {index} has invalid x/y/color")
        next_sprite = set_pixel_in_sprite(next_sprite, x, y, color)
    return next_sprite


def load_json_sprite(path: Path, *, repair: bool = True) -> dict[str, object]:
    payload = extract_sprite_payload(path.read_text(encoding="utf-8"))
    validation = validate_pixel_sprite(payload, repair=repair)
    if not validation["ok"]:
        raise ValueError("; ".join(validation["errors"]))  # type: ignore[index]
    return validation["sprite"]  # type: ignore[return-value]


def extract_frames_payload(value: object) -> list[object] | None:
    payload = extract_sprite_payload(value)
    if isinstance(payload, dict):
        frames = payload.get("frames")
        if isinstance(frames, list):
            return frames
        for key in ("animation", "spriteSheet", "sprite_sheet", "data", "result", "output"):
            nested = payload.get(key)
            if nested is not None:
                found = extract_frames_payload(nested)
                if found is not None:
                    return found
    return None


def validate_json_frames(payload: object, *, repair: bool = True) -> dict[str, object]:
    frames_payload = extract_frames_payload(payload)
    if frames_payload is None:
        if isinstance(payload, list):
            frames_payload = payload
        else:
            return {"ok": False, "errors": ['JSON must include a non-empty "frames" array.'], "warnings": []}
    if not frames_payload:
        return {"ok": False, "errors": ['JSON must include a non-empty "frames" array.'], "warnings": []}
    frames: list[dict[str, object]] = []
    warnings: list[str] = []
    errors: list[str] = []
    for index, frame in enumerate(frames_payload):
        validation = validate_pixel_sprite(frame, repair=repair)
        warnings.extend(f"Frame {index + 1}: {warning}" for warning in validation["warnings"])  # type: ignore[index]
        if not validation["ok"]:
            errors.append(f"Frame {index + 1} failed validation: {' '.join(validation['errors'])}")  # type: ignore[index]
        else:
            frames.append(validation["sprite"])  # type: ignore[arg-type]
    if errors:
        return {"ok": False, "errors": errors, "warnings": warnings}
    first_width = int(frames[0]["width"])
    first_height = int(frames[0]["height"])
    for index, frame in enumerate(frames, start=1):
        if int(frame["width"]) != first_width or int(frame["height"]) != first_height:
            errors.append(f"Frame {index} size mismatch: expected {first_width}x{first_height}, received {frame['width']}x{frame['height']}.")
    if errors:
        return {"ok": False, "errors": errors, "warnings": warnings}
    return {"ok": True, "frames": frames, "warnings": warnings, "width": first_width, "height": first_height}


def render_json_frames_sheet(frames: list[dict[str, object]], output_path: Path, *, scale: int = 1) -> Image.Image:
    if not frames:
        raise ValueError("no frames to render")
    rendered = []
    for frame in frames:
        temp = Image.new("RGBA", (int(frame["width"]), int(frame["height"])), (0, 0, 0, 0))
        pixels = temp.load()
        for y, row in enumerate(frame["pixels"]):  # type: ignore[union-attr]
            for x, color in enumerate(row):
                pixels[x, y] = parse_pixel_color(str(color))
        rendered.append(temp)
    sheet = compose_frame_sheet(rendered, 1, len(rendered), rendered[0].width)
    if scale != 1:
        sheet = sheet.resize((sheet.width * scale, sheet.height * scale), Image.Resampling.NEAREST)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)
    return sheet


def render_json_frames_gif(frames: list[dict[str, object]], output_path: Path, *, scale: int = 1, duration: int = 120) -> None:
    rendered: list[Image.Image] = []
    for frame in frames:
        image = Image.new("RGBA", (int(frame["width"]), int(frame["height"])), (0, 0, 0, 0))
        pixels = image.load()
        for y, row in enumerate(frame["pixels"]):  # type: ignore[union-attr]
            for x, color in enumerate(row):
                pixels[x, y] = parse_pixel_color(str(color))
        if scale != 1:
            image = image.resize((image.width * scale, image.height * scale), Image.Resampling.NEAREST)
        rendered.append(image)
    save_transparent_gif(rendered, output_path, duration)


def pixel_sprite_quality(sprite: dict[str, object]) -> dict[str, object]:
    pixels = sprite["pixels"]
    flat = [color for row in pixels for color in row]  # type: ignore[union-attr]
    visible = [color for color in flat if color != TRANSPARENT_PIXEL]
    total = int(sprite["width"]) * int(sprite["height"])
    longest = max(int(sprite["width"]), int(sprite["height"]))
    min_colors = 8 if longest >= 32 else 6 if longest >= 16 else 4
    min_visible = max(8, round(total * (0.22 if longest <= 8 else 0.18 if longest <= 16 else 0.12 if longest <= 32 else 0.08)))
    max_visible = round(total * 0.82)
    issues: list[str] = []
    colors = len(set(visible))
    visible_count = len(visible)
    if colors < min_colors:
        issues.append(f"too_few_colors:{colors}<{min_colors}")
    if visible_count < min_visible:
        issues.append(f"too_few_visible_pixels:{visible_count}<{min_visible}")
    if visible_count > max_visible:
        issues.append(f"too_many_visible_pixels:{visible_count}>{max_visible}")
    return {"passes": not issues, "issues": issues, "visible_colors": colors, "visible_pixels": visible_count}


def build_json_sprite_prompt(subject: str, *, width: int, height: int, mode: str = "generate", style: str = "modern game sprite") -> str:
    if width <= 0 or height <= 0 or width > 128 or height > 128:
        raise ValueError("width and height must be between 1 and 128")
    return "\n".join(
        [
            "Create one polished production-ready pixel-art game sprite as strict JSON.",
            f"Canvas and JSON size: {width}x{height}.",
            f"Mode: {mode}.",
            f"Style: {style}.",
            f"Request: {subject}",
            f"Return exactly width={width}, height={height}.",
            f"pixels must contain exactly {height} rows, and every row must contain exactly {width} strings.",
            "Every cell is one pixel color. Do not compress rows, omit trailing transparent cells, use ellipses, or return a smaller sprite.",
            "Use only #RRGGBB or transparent. No color names except transparent.",
            'Output only JSON with exactly these keys: {"width":number,"height":number,"pixels":[["#RRGGBB","transparent"]]}',
            "No markdown, no comments, no explanations, no extra keys.",
            "Quality: readable silhouette, crisp outline where useful, top-left highlights, lower-right shadows, controlled palette ramps, no random noise.",
        ]
    )


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    if image.mode != "RGBA":
        return None

    pixels = image.load()
    width, height = image.size
    xs: list[int] = []
    ys: list[int] = []
    for y in range(height):
        for x in range(width):
            if pixels[x, y][3] > 0:
                xs.append(x)
                ys.append(y)

    if not xs:
        return None
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def opaque_components(image: Image.Image) -> list[list[tuple[int, int]]]:
    if image.mode != "RGBA":
        return []

    pixels = image.load()
    width, height = image.size
    visited: set[tuple[int, int]] = set()
    components: list[list[tuple[int, int]]] = []
    neighbors = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]

    for y in range(height):
        for x in range(width):
            if (x, y) in visited or pixels[x, y][3] == 0:
                continue

            component: list[tuple[int, int]] = []
            queue: deque[tuple[int, int]] = deque([(x, y)])
            visited.add((x, y))
            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                for dx, dy in neighbors:
                    nx = cx + dx
                    ny = cy + dy
                    if nx < 0 or nx >= width or ny < 0 or ny >= height or (nx, ny) in visited:
                        continue
                    visited.add((nx, ny))
                    if pixels[nx, ny][3] > 0:
                        queue.append((nx, ny))
            components.append(component)

    return components


def remove_small_components(image: Image.Image, min_size: int, keep_largest: bool) -> Image.Image:
    if image.mode != "RGBA" or (min_size <= 0 and not keep_largest):
        return image

    components = opaque_components(image)
    if not components:
        return image

    largest = max(components, key=len)
    remove: set[tuple[int, int]] = set()
    for component in components:
        if keep_largest and component is not largest:
            remove.update(component)
        elif min_size > 0 and len(component) < min_size:
            remove.update(component)

    if not remove:
        return image

    out = image.copy()
    pixels = out.load()
    for x, y in remove:
        pixels[x, y] = (0, 0, 0, 0)
    return out


def center_alpha_image(image: Image.Image) -> Image.Image:
    bbox = alpha_bbox(image)
    if image.mode != "RGBA" or bbox is None:
        return image

    left, top, right, bottom = bbox
    width, height = image.size
    bbox_width = right - left
    bbox_height = bottom - top
    target_left = (width - bbox_width) // 2
    target_top = (height - bbox_height) // 2
    dx = target_left - left
    dy = target_top - top
    if dx == 0 and dy == 0:
        return image

    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    out.alpha_composite(image, (dx, dy))
    return out


def trim_alpha_image(image: Image.Image) -> Image.Image:
    bbox = alpha_bbox(image)
    if image.mode != "RGBA" or bbox is None:
        return image
    return image.crop(bbox)


def bbox_from_points(points: list[tuple[int, int]]) -> tuple[int, int, int, int] | None:
    if not points:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def pad_bbox(bbox: tuple[int, int, int, int], padding: int, width: int, height: int) -> tuple[int, int, int, int]:
    left, top, right, bottom = bbox
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )


def bbox_touches_edge(bbox: tuple[int, int, int, int] | None, width: int, height: int, margin: int) -> bool:
    if bbox is None:
        return False
    left, top, right, bottom = bbox
    return left <= margin or top <= margin or right >= width - margin or bottom >= height - margin


def split_bbox_grid(bbox: tuple[int, int, int, int], rows: int, cols: int) -> list[tuple[int, int, int, int]]:
    left, top, right, bottom = bbox
    boxes: list[tuple[int, int, int, int]] = []
    for row in range(rows):
        y0 = top + round((bottom - top) * row / rows)
        y1 = top + round((bottom - top) * (row + 1) / rows)
        for col in range(cols):
            x0 = left + round((right - left) * col / cols)
            x1 = left + round((right - left) * (col + 1) / cols)
            boxes.append((x0, y0, x1, y1))
    return boxes


def sort_region_boxes(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    if not boxes:
        return []
    heights = [bottom - top for _, top, _, bottom in boxes]
    row_threshold = max(4, int(round(median(heights) * 0.55))) if heights else 4
    rows: list[list[tuple[int, int, int, int]]] = []
    for box in sorted(boxes, key=lambda item: (item[1], item[0])):
        center_y = (box[1] + box[3]) / 2
        for row in rows:
            row_center = sum((candidate[1] + candidate[3]) / 2 for candidate in row) / len(row)
            if abs(center_y - row_center) <= row_threshold:
                row.append(box)
                break
        else:
            rows.append([box])
    return [box for row in rows for box in sorted(row, key=lambda item: item[0])]


def detect_sheet_regions(
    image: Image.Image,
    *,
    rows: int | None = None,
    cols: int | None = None,
    mode: str = "components",
    padding: int = 0,
    min_component_size: int = 16,
) -> dict[str, object]:
    if mode not in {"content", "components"}:
        raise ValueError("region detection mode must be content or components")
    if padding < 0 or min_component_size < 0:
        raise ValueError("region padding and min component size must be zero or positive")
    if (rows is None) != (cols is None):
        raise ValueError("rows and cols must be provided together")
    if rows is not None and (rows <= 0 or cols is None or cols <= 0):
        raise ValueError("rows and cols must be positive")

    rgba = image.convert("RGBA")
    content_bbox = alpha_bbox(rgba)
    boxes: list[tuple[int, int, int, int]] = []
    method = mode

    if content_bbox is None:
        return {
            "method": method,
            "size": [rgba.width, rgba.height],
            "content_bbox": None,
            "boxes": [],
            "expected_frames": rows * cols if rows is not None and cols is not None else None,
        }

    if mode == "content":
        if rows is None or cols is None:
            boxes = [content_bbox]
        else:
            boxes = split_bbox_grid(content_bbox, rows, cols)
    else:
        component_boxes = [
            pad_bbox(bbox, padding, rgba.width, rgba.height)
            for component in opaque_components(rgba)
            if len(component) >= min_component_size
            for bbox in [bbox_from_points(component)]
            if bbox is not None
        ]
        component_boxes = sort_region_boxes(component_boxes)
        expected = rows * cols if rows is not None and cols is not None else None
        if expected is not None and len(component_boxes) < expected:
            method = "content_fallback"
            boxes = split_bbox_grid(content_bbox, rows, cols)
        elif expected is not None:
            boxes = component_boxes[:expected]
        else:
            boxes = component_boxes

    return {
        "method": method,
        "size": [rgba.width, rgba.height],
        "content_bbox": list(content_bbox),
        "boxes": [
            {
                "index": index,
                "box": list(box),
                "width": box[2] - box[0],
                "height": box[3] - box[1],
            }
            for index, box in enumerate(boxes)
        ],
        "expected_frames": rows * cols if rows is not None and cols is not None else None,
    }


def add_outline(image: Image.Image, color: RGB) -> Image.Image:
    if image.mode != "RGBA":
        return image

    pixels = image.load()
    width, height = image.size
    out = image.copy()
    out_pixels = out.load()
    neighbors = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]

    for y in range(height):
        for x in range(width):
            if pixels[x, y][3] > 0:
                continue
            if any(0 <= x + dx < width and 0 <= y + dy < height and pixels[x + dx, y + dy][3] > 0 for dx, dy in neighbors):
                out_pixels[x, y] = (color[0], color[1], color[2], 255)

    return out


def neighbor_colors(image: Image.Image, x: int, y: int) -> list[tuple[int, int, int, int]]:
    pixels = image.load()
    width, height = image.size
    colors: list[tuple[int, int, int, int]] = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx = x + dx
            ny = y + dy
            if 0 <= nx < width and 0 <= ny < height:
                color = pixels[nx, ny]
                if color[3] > 0:
                    colors.append(color)
    return colors


def dominant_neighbor_color(image: Image.Image, pixels_to_ignore: set[tuple[int, int]], x: int, y: int) -> tuple[int, int, int, int] | None:
    pixels = image.load()
    width, height = image.size
    colors: list[tuple[int, int, int, int]] = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx = x + dx
            ny = y + dy
            if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in pixels_to_ignore:
                color = pixels[nx, ny]
                if color[3] > 0:
                    colors.append(color)
    if not colors:
        return None
    return min(Counter(colors).items(), key=lambda item: (-item[1], item[0]))[0]


def despeckle_image(image: Image.Image, iterations: int, protected_pixels: set[tuple[int, int]] | None = None) -> Image.Image:
    if image.mode != "RGBA" or iterations <= 0:
        return image

    protected_pixels = protected_pixels or set()
    out = image.copy()
    for _ in range(iterations):
        pixels = out.load()
        replacements: dict[tuple[int, int], tuple[int, int, int, int]] = {}
        width, height = out.size
        for y in range(height):
            for x in range(width):
                if (x, y) in protected_pixels:
                    continue
                current = pixels[x, y]
                if current[3] == 0:
                    continue
                neighbors = neighbor_colors(out, x, y)
                if len(neighbors) < 4:
                    continue
                counts = Counter(neighbors)
                winner, count = min(counts.items(), key=lambda item: (-item[1], item[0]))
                current_count = counts.get(current, 0)
                if winner != current and count >= 5 and current_count <= 1:
                    replacements[(x, y)] = winner
        if not replacements:
            break
        for (x, y), color in replacements.items():
            pixels[x, y] = color
    return out


def color_components(image: Image.Image) -> list[list[tuple[int, int]]]:
    if image.mode != "RGBA":
        return []

    pixels = image.load()
    width, height = image.size
    visited: set[tuple[int, int]] = set()
    components: list[list[tuple[int, int]]] = []
    neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1)]

    for y in range(height):
        for x in range(width):
            if (x, y) in visited or pixels[x, y][3] == 0:
                continue

            color = pixels[x, y]
            component: list[tuple[int, int]] = []
            queue: deque[tuple[int, int]] = deque([(x, y)])
            visited.add((x, y))
            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                for dx, dy in neighbors:
                    nx = cx + dx
                    ny = cy + dy
                    if nx < 0 or nx >= width or ny < 0 or ny >= height or (nx, ny) in visited:
                        continue
                    if pixels[nx, ny] == color:
                        visited.add((nx, ny))
                        queue.append((nx, ny))
            components.append(component)

    return components


def remove_small_color_components(image: Image.Image, min_size: int, protected_pixels: set[tuple[int, int]] | None = None) -> Image.Image:
    if image.mode != "RGBA" or min_size <= 0:
        return image

    protected_pixels = protected_pixels or set()
    out = image.copy()
    pixels = out.load()
    for component in color_components(out):
        if len(component) >= min_size:
            continue
        if any(point in protected_pixels for point in component):
            continue
        component_set = set(component)
        replacement_counts: Counter[tuple[int, int, int, int]] = Counter()
        for x, y in component:
            replacement = dominant_neighbor_color(out, component_set, x, y)
            if replacement is not None:
                replacement_counts[replacement] += 1
        if not replacement_counts:
            continue
        replacement = min(replacement_counts.items(), key=lambda item: (-item[1], item[0]))[0]
        for x, y in component:
            pixels[x, y] = replacement
    return out


def luma_sum(color: tuple[int, int, int, int]) -> int:
    return color[0] + color[1] + color[2]


def remove_dark_specks(
    image: Image.Image,
    max_size: int,
    dark_threshold: int,
    protected_pixels: set[tuple[int, int]] | None = None,
) -> Image.Image:
    if image.mode != "RGBA" or max_size <= 0:
        return image

    protected_pixels = protected_pixels or set()
    out = image.copy()
    pixels = out.load()
    for component in color_components(out):
        if any(point in protected_pixels for point in component):
            continue
        first = pixels[component[0][0], component[0][1]]
        if first[3] == 0 or luma_sum(first) > dark_threshold or len(component) > max_size:
            continue

        component_set = set(component)
        boundary_colors: list[tuple[int, int, int, int]] = []
        touches_alpha = False
        for x, y in component:
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx = x + dx
                    ny = y + dy
                    if nx < 0 or nx >= out.width or ny < 0 or ny >= out.height or (nx, ny) in component_set:
                        continue
                    color = pixels[nx, ny]
                    if color[3] == 0:
                        touches_alpha = True
                    elif luma_sum(color) > dark_threshold:
                        boundary_colors.append(color)

        if touches_alpha or len(boundary_colors) < max(3, len(component) * 2):
            continue

        replacement = min(Counter(boundary_colors).items(), key=lambda item: (-item[1], item[0]))[0]
        for x, y in component:
            pixels[x, y] = replacement

    return out


def service_color_like(rgb: RGB, options: ForgeOptions) -> bool:
    if options.chroma_key is not None and is_chroma_like(rgb, options.chroma_key, options.chroma_tolerance):
        return True
    if options.grid_key is not None and is_grid_like(rgb, options.grid_key, options.grid_tolerance):
        return True
    return False


def remove_service_color_pixels(
    image: Image.Image,
    options: ForgeOptions,
    protected_pixels: set[tuple[int, int]] | None = None,
) -> Image.Image:
    if image.mode != "RGBA":
        return image

    protected_pixels = protected_pixels or set()
    out = image.copy()
    pixels = out.load()
    for component in color_components(out):
        if any(point in protected_pixels for point in component):
            continue
        first = pixels[component[0][0], component[0][1]]
        if first[3] == 0 or not service_color_like((first[0], first[1], first[2]), options):
            continue

        component_set = set(component)
        replacement_counts: Counter[tuple[int, int, int, int]] = Counter()
        touches_alpha = False
        for x, y in component:
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx = x + dx
                    ny = y + dy
                    if nx < 0 or nx >= out.width or ny < 0 or ny >= out.height or (nx, ny) in component_set:
                        continue
                    neighbor = pixels[nx, ny]
                    if neighbor[3] == 0:
                        touches_alpha = True
                        continue
                    nr, ng, nb, _na = neighbor
                    if service_color_like((nr, ng, nb), options):
                        continue
                    replacement_counts[neighbor] += 1

        if replacement_counts:
            replacement = min(replacement_counts.items(), key=lambda item: (-item[1], item[0]))[0]
        elif touches_alpha:
            replacement = (0, 0, 0, 0)
        else:
            continue
        for x, y in component:
            pixels[x, y] = replacement
    return out


def dark_speck_points(image: Image.Image, max_size: int = 3, dark_threshold: int = 80) -> set[tuple[int, int]]:
    if image.mode != "RGBA":
        return set()

    pixels = image.load()
    points: set[tuple[int, int]] = set()
    for component in color_components(image):
        first = pixels[component[0][0], component[0][1]]
        if first[3] == 0 or luma_sum(first) > dark_threshold or len(component) > max_size:
            continue
        component_set = set(component)
        touches_alpha = False
        bright_neighbors = 0
        for x, y in component:
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx = x + dx
                    ny = y + dy
                    if nx < 0 or nx >= image.width or ny < 0 or ny >= image.height or (nx, ny) in component_set:
                        continue
                    color = pixels[nx, ny]
                    if color[3] == 0:
                        touches_alpha = True
                    elif luma_sum(color) > dark_threshold:
                        bright_neighbors += 1
        if not touches_alpha and bright_neighbors >= max(3, len(component) * 2):
            points.update(component)
    return points


def tiny_island_points(image: Image.Image, min_opaque_size: int = 4, min_color_size: int = 3) -> set[tuple[int, int]]:
    if image.mode != "RGBA":
        return set()

    points: set[tuple[int, int]] = set()
    for component in opaque_components(image):
        if len(component) < min_opaque_size:
            points.update(component)
    for component in color_components(image):
        if len(component) < min_color_size:
            points.update(component)
    return points


def keyed_color_points(image: Image.Image, key: RGB | None, tolerance: int, kind: str) -> set[tuple[int, int]]:
    if image.mode != "RGBA" or key is None:
        return set()

    pixels = image.load()
    points: set[tuple[int, int]] = set()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            rgb = (r, g, b)
            if kind == "grid" and is_grid_like(rgb, key, tolerance):
                points.add((x, y))
            elif kind == "chroma" and is_chroma_like(rgb, key, tolerance):
                points.add((x, y))
    return points


def save_artifact_heatmaps(
    image: Image.Image,
    output_dir: Path,
    *,
    chroma_key: RGB | None = None,
    chroma_tolerance: int = 64,
    grid_key: RGB | None = None,
    grid_tolerance: int = 48,
    dark_threshold: int = 80,
) -> dict[str, object]:
    rgba = image.convert("RGBA")
    layers = {
        "grid_echo": keyed_color_points(rgba, grid_key, grid_tolerance, "grid"),
        "chroma_remnants": keyed_color_points(rgba, chroma_key, chroma_tolerance, "chroma"),
        "tiny_islands": tiny_island_points(rgba),
        "dark_specks": dark_speck_points(rgba, dark_threshold=dark_threshold),
    }
    colors = {
        "grid_echo": (255, 0, 255, 220),
        "chroma_remnants": (0, 255, 0, 220),
        "tiny_islands": (255, 180, 0, 220),
        "dark_specks": (255, 32, 32, 220),
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, object] = {"size": [rgba.width, rgba.height], "layers": {}}
    for name, points in layers.items():
        path = output_dir / f"{name}.png"
        save_heatmap(rgba, points, path, colors[name])
        manifest["layers"][name] = {"pixels": len(points), "path": str(path)}

    manifest_path = output_dir / "artifact-heatmaps.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def save_alpha_mask(image: Image.Image, output_path: Path) -> None:
    rgba = image.convert("RGBA")
    mask = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
    mask_pixels = mask.load()
    alpha = rgba.getchannel("A")
    alpha_pixels = alpha.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            value = alpha_pixels[x, y]
            mask_pixels[x, y] = (value, value, value, 255)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    mask.save(output_path)


def checkerboard(size: tuple[int, int], cell: int = 8) -> Image.Image:
    width, height = size
    image = Image.new("RGBA", size, (44, 48, 54, 255))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            shade = 34 if ((x // cell) + (y // cell)) % 2 == 0 else 46
            pixels[x, y] = (shade, shade + 4, shade + 10, 255)
    return image


def save_sprite_contact_sheet(
    *,
    raw: Image.Image,
    cleaned: Image.Image,
    alpha_mask_path: Path,
    output_path: Path,
    preview_scale: int,
    score: SpriteScore,
) -> None:
    if preview_scale <= 0:
        raise ValueError("preview scale must be positive")

    tile_size = cleaned.width * preview_scale
    label_height = 34
    gap = 14
    labels = ["raw", "cleaned", "alpha", "checker"]
    width = len(labels) * tile_size + (len(labels) + 1) * gap
    height = tile_size + label_height + gap * 2
    sheet = Image.new("RGBA", (width, height), (30, 32, 36, 255))
    draw = ImageDraw.Draw(sheet)

    raw_preview = raw.convert("RGBA")
    raw_preview.thumbnail((tile_size, tile_size), Image.Resampling.NEAREST)
    raw_tile = Image.new("RGBA", (tile_size, tile_size), (0, 0, 0, 0))
    raw_tile.alpha_composite(raw_preview, ((tile_size - raw_preview.width) // 2, (tile_size - raw_preview.height) // 2))
    cleaned_tile = cleaned.resize((tile_size, tile_size), Image.Resampling.NEAREST)
    alpha_tile = Image.open(alpha_mask_path).convert("RGBA").resize((tile_size, tile_size), Image.Resampling.NEAREST)
    checker = checkerboard((tile_size, tile_size), max(4, preview_scale * 2))
    checker.alpha_composite(cleaned_tile, (0, 0))
    tiles = [raw_tile, cleaned_tile, alpha_tile, checker]

    for index, (label, tile) in enumerate(zip(labels, tiles)):
        x = gap + index * (tile_size + gap)
        y = gap
        sheet.alpha_composite(tile, (x, y))
        draw.text((x, y + tile_size + 6), label, fill=(235, 238, 242, 255))
    issues = ",".join(score.quality_issues) if score.quality_issues else "ok"
    draw.text((gap, height - 16), f"score {score.score} colors {score.visible_colors} issues {issues}", fill=(180, 186, 196, 255))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def edge_opaque_colors(image: Image.Image) -> list[RGB]:
    if image.mode != "RGBA":
        return []

    pixels = image.load()
    colors: list[RGB] = []
    for x in range(image.width):
        for y in (0, image.height - 1):
            r, g, b, a = pixels[x, y]
            if a > 0:
                colors.append((r, g, b))
    for y in range(1, max(1, image.height - 1)):
        for x in (0, image.width - 1):
            r, g, b, a = pixels[x, y]
            if a > 0:
                colors.append((r, g, b))
    return colors


def strip_edge_background(image: Image.Image, options: ForgeOptions) -> Image.Image:
    if image.mode != "RGBA" or not options.strip_edge_background:
        return image

    edge_colors = edge_opaque_colors(image)
    edge_background = dominant_color(edge_colors) if edge_colors else None
    out = image.copy()
    pixels = out.load()
    width, height = out.size
    visited: set[tuple[int, int]] = set()
    queue: deque[tuple[int, int]] = deque()

    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    def removable(rgb: RGB) -> bool:
        if options.chroma_key is not None and is_chroma_like(rgb, options.chroma_key, options.chroma_tolerance):
            return True
        if options.grid_key is not None and is_grid_like(rgb, options.grid_key, options.grid_tolerance):
            return True
        if edge_background is not None and color_distance(rgb, edge_background) <= options.strip_edge_tolerance:
            return True
        return False

    while queue:
        x, y = queue.popleft()
        if x < 0 or x >= width or y < 0 or y >= height or (x, y) in visited:
            continue
        visited.add((x, y))

        r, g, b, a = pixels[x, y]
        if a == 0:
            pass
        elif removable((r, g, b)):
            pixels[x, y] = (0, 0, 0, 0)
        else:
            continue

        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            nx = x + dx
            ny = y + dy
            if (nx, ny) not in visited:
                queue.append((nx, ny))

    return out


def remove_keyed_background(image: Image.Image, chroma_key: RGB, tolerance: int) -> Image.Image:
    out = image.convert("RGBA")
    pixels = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pixels[x, y]
            if a > 0 and is_chroma_like((r, g, b), chroma_key, tolerance):
                pixels[x, y] = (0, 0, 0, 0)
    return out


def compose_frame_sheet(frames: list[Image.Image], rows: int, cols: int, cell_size: int) -> Image.Image:
    sheet = Image.new("RGBA", (cols * cell_size, rows * cell_size), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        row, col = divmod(index, cols)
        sheet.alpha_composite(frame.convert("RGBA"), (col * cell_size, row * cell_size))
    return sheet


def shift_frame_alpha(image: Image.Image, dx: int, dy: int) -> Image.Image:
    rgba = image.convert("RGBA")
    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    src_left = max(0, -dx)
    src_top = max(0, -dy)
    src_right = min(rgba.width, rgba.width - dx) if dx >= 0 else rgba.width
    src_bottom = min(rgba.height, rgba.height - dy) if dy >= 0 else rgba.height
    if src_right <= src_left or src_bottom <= src_top:
        return out
    dest = (max(0, dx), max(0, dy))
    out.alpha_composite(rgba.crop((src_left, src_top, src_right, src_bottom)), dest)
    return out


def align_animation_anchors(frames: list[Image.Image], *, mode: str = "bottom") -> tuple[list[Image.Image], dict[str, object]]:
    if mode == "none" or not frames:
        return frames, {"mode": "none", "shifts": []}
    bboxes = [alpha_bbox(frame.convert("RGBA")) for frame in frames]
    anchors = [bbox[3] if bbox is not None else None for bbox in bboxes]
    target = next((anchor for anchor in anchors if anchor is not None), None)
    if target is None:
        return frames, {"mode": mode, "target": None, "shifts": []}
    aligned: list[Image.Image] = []
    shifts: list[dict[str, object]] = []
    for index, frame in enumerate(frames, start=1):
        bbox = bboxes[index - 1]
        if bbox is None:
            aligned.append(frame)
            shifts.append({"frame": index, "dx": 0, "dy": 0, "bbox": None})
            continue
        dy = int(target) - bbox[3]
        shifted = shift_frame_alpha(frame, 0, dy)
        shifted_bbox = alpha_bbox(shifted)
        aligned.append(shifted)
        shifts.append(
            {
                "frame": index,
                "dx": 0,
                "dy": dy,
                "bbox_before": list(bbox),
                "bbox_after": list(shifted_bbox) if shifted_bbox is not None else None,
            }
        )
    return aligned, {"mode": mode, "target_bottom": target, "shifts": shifts}


def save_transparent_gif(frames: list[Image.Image], output_path: Path, duration: int) -> None:
    if not frames:
        raise ValueError("no frames to export")
    output_frames = [frame.convert("RGBA") for frame in frames]
    output_frames[0].save(
        output_path,
        format="GIF",
        save_all=True,
        append_images=output_frames[1:],
        duration=duration,
        loop=0,
        disposal=2,
    )


def save_sheet_contact_sheet(frames: list[Image.Image], frame_meta: list[dict[str, object]], output_path: Path, preview_scale: int) -> None:
    if not frames:
        return
    if preview_scale <= 0:
        raise ValueError("preview scale must be positive")

    tile = frames[0].width * preview_scale
    label_height = 28
    gap = 12
    width = len(frames) * tile + (len(frames) + 1) * gap
    height = tile + label_height + gap * 2
    sheet = Image.new("RGBA", (width, height), (30, 32, 36, 255))
    draw = ImageDraw.Draw(sheet)

    for index, frame in enumerate(frames):
        x = gap + index * (tile + gap)
        y = gap
        preview = frame.resize((tile, tile), Image.Resampling.NEAREST)
        sheet.alpha_composite(preview, (x, y))
        meta = frame_meta[index]
        edge = " edge" if meta.get("edge_touch") else ""
        draw.text((x, y + tile + 6), f"#{index + 1} {meta['grid']}{edge}", fill=(235, 238, 242, 255))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def sheet_qc_summary(
    frames: list[Image.Image],
    frame_meta: list[dict[str, object]],
    expression_report: dict[str, object] | None,
    preset: str,
) -> dict[str, object]:
    metrics = frame_body_metrics(frames)
    edge_touch_frames = [meta["grid"] for meta in frame_meta if meta["edge_touch"]]
    empty_frames = [meta["grid"] for meta in frame_meta if meta.get("crop_bbox") is None]
    component_counts = [int(meta["component_count"]) for meta in frame_meta]
    output_sizes = [meta.get("output_size", [0, 0]) for meta in frame_meta]
    nonzero_heights = [size[1] for size in output_sizes if isinstance(size, list) and len(size) == 2 and size[1] > 0]
    output_height_drift = max(nonzero_heights) - min(nonzero_heights) if nonzero_heights else 0
    issues: list[str] = []
    retry_hints: list[str] = []

    if edge_touch_frames:
        issues.append(f"edge_touch:{len(edge_touch_frames)}")
        retry_hints.append("Ask imagegen to keep every frame inside the safe area with visible padding; no part may touch a cell edge.")
    if empty_frames:
        issues.append(f"empty_frames:{len(empty_frames)}")
        retry_hints.append("Ask imagegen to fill every requested frame slot with the same asset identity, not blank cells.")
    if output_height_drift > 3:
        issues.append(f"scale_drift:{output_height_drift}px")
        retry_hints.append("Ask imagegen to keep the same bounding box and pixel scale in every frame.")
    if metrics["anchor_drift"] > 3:
        issues.append(f"anchor_drift:{metrics['anchor_drift']}px")
        retry_hints.append("Ask imagegen to keep the feet/bottom anchor stable across all frames.")
    if expression_report is not None and not expression_report.get("passes", True):
        issues.extend(str(issue) for issue in expression_report.get("issues", []))
        retry_hints.extend(str(hint) for hint in expression_report.get("retry_hints", []))
    palette_ramp = palette_ramp_diagnostics(compose_frame_sheet(frames, 1, len(frames), frames[0].width), preset) if frames else None
    if palette_ramp is not None and not palette_ramp["passes"]:
        palette_issues = list(palette_ramp["issues"])
        issues.extend(palette_issues)
        retry_hints.extend(retry_hints_for_issues(palette_issues, preset, context="sheet"))

    return {
        "passes": not issues,
        "issues": sorted(set(issues)),
        "retry_hints": sorted(set(retry_hints)),
        "edge_touch_frames": edge_touch_frames,
        "empty_frames": empty_frames,
        "component_counts": component_counts,
        "max_component_count": max(component_counts) if component_counts else 0,
        "output_height_drift": output_height_drift,
        "body_metrics": metrics,
        "expression_passes": expression_report.get("passes") if expression_report is not None else None,
        "palette_ramp": palette_ramp,
    }


def write_sheet_bundle_meta(
    output_dir: Path,
    *,
    input_path: Path,
    rows: int,
    cols: int,
    cell_size: int,
    frames: list[Image.Image],
    frame_meta: list[dict[str, object]],
    qc: dict[str, object],
    directions: list[str],
    palette: tuple[RGB, ...],
    contact_sheet: bool,
) -> dict[str, object]:
    frame_files = [str(output_dir / "frames" / f"frame_{index:02d}.png") for index in range(1, len(frames) + 1)]
    strip_files: list[str] = []
    if directions:
        for direction in directions:
            strip_files.append(str(output_dir / "strips" / f"{direction}-strip.png"))
            strip_files.append(str(output_dir / "strips" / f"{direction}.gif"))

    bundle_meta: dict[str, object] = {
        "type": "sprite_sheet_run",
        "input": str(input_path),
        "layout": {
            "rows": rows,
            "cols": cols,
            "frames": len(frames),
            "cell_size": cell_size,
        },
        "files": {
            "raw_sheet": str(output_dir / "raw-sheet.png"),
            "raw_sheet_clean": str(output_dir / "raw-sheet-clean.png"),
            "sheet_transparent": str(output_dir / "sheet-transparent.png"),
            "animation": str(output_dir / "animation.gif"),
            "contact_sheet": str(output_dir / "contact_sheet.png") if contact_sheet else None,
            "pipeline_meta": str(output_dir / "pipeline-meta.json"),
            "bundle_meta": str(output_dir / "bundle-meta.json"),
            "palette": str(output_dir / "palette.hex"),
            "frames": frame_files,
            "strips": strip_files,
        },
        "qc": qc,
        "palette": [rgb_to_hex(color) for color in palette],
        "frames": frame_meta,
    }
    (output_dir / "bundle-meta.json").write_text(json.dumps(bundle_meta, indent=2), encoding="utf-8")
    return bundle_meta


def process_sheet(
    input_path: Path,
    output_dir: Path,
    *,
    rows: int,
    cols: int,
    cell_size: int = 64,
    chroma_key: RGB = (255, 0, 255),
    chroma_tolerance: int = 64,
    fit_scale: float = 0.86,
    align: str = "center",
    shared_scale: bool = True,
    component_mode: str = "all",
    component_padding: int = 0,
    min_component_size: int = 1,
    edge_touch_margin: int = 0,
    reject_edge_touch: bool = False,
    gif_duration: int = 200,
    contact_sheet: bool = True,
    preview_scale: int = 4,
    direction_strips: bool = False,
    palette_colors: tuple[RGB, ...] = (),
    preset: str = "generic",
    expression_qc: bool = True,
    max_expression_drift: float = 6.0,
    prompt_file: Path | None = None,
    region_mode: str = "grid",
    region_padding: int = 0,
) -> dict[str, object]:
    if rows <= 0 or cols <= 0:
        raise ValueError("rows and cols must be positive")
    if cell_size <= 0:
        raise ValueError("cell size must be positive")
    if not 0 < fit_scale <= 1:
        raise ValueError("fit scale must be in (0, 1]")
    if align not in {"center", "bottom", "feet"}:
        raise ValueError("align must be center, bottom, or feet")
    if component_mode not in {"all", "largest"}:
        raise ValueError("component mode must be all or largest")
    if component_padding < 0 or min_component_size < 0 or edge_touch_margin < 0:
        raise ValueError("component padding, min component size, and edge touch margin must be zero or positive")
    if region_mode not in {"grid", "content", "components"}:
        raise ValueError("region mode must be grid, content, or components")
    if region_padding < 0:
        raise ValueError("region padding must be zero or positive")
    if gif_duration <= 0:
        raise ValueError("GIF duration must be positive")
    if preview_scale <= 0:
        raise ValueError("preview scale must be positive")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    if max_expression_drift < 0:
        raise ValueError("max expression drift must be zero or positive")

    output_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = output_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    if prompt_file is not None:
        (output_dir / "prompt-used.txt").write_text(prompt_file.read_text(encoding="utf-8"), encoding="utf-8")

    raw = Image.open(input_path).convert("RGBA")
    raw.save(output_dir / "raw-sheet.png")
    cleaned = remove_keyed_background(raw, chroma_key, chroma_tolerance)
    cleaned.save(output_dir / "raw-sheet-clean.png")

    region_report: dict[str, object] | None = None
    if region_mode == "grid":
        cell_width = cleaned.width // cols
        cell_height = cleaned.height // rows
        if cell_width <= 0 or cell_height <= 0:
            raise ValueError("rows and cols produce empty cells")
        source_boxes = [
            (col * cell_width, row * cell_height, (col + 1) * cell_width, (row + 1) * cell_height)
            for row in range(rows)
            for col in range(cols)
        ]
    else:
        region_report = detect_sheet_regions(
            cleaned,
            rows=rows,
            cols=cols,
            mode=region_mode,
            padding=region_padding,
            min_component_size=min_component_size,
        )
        source_boxes = [tuple(region["box"]) for region in region_report["boxes"]]  # type: ignore[index]
        if len(source_boxes) != rows * cols:
            raise ValueError(f"region detection found {len(source_boxes)} boxes, expected {rows * cols}")
        cell_width = max((box[2] - box[0] for box in source_boxes), default=0)
        cell_height = max((box[3] - box[1] for box in source_boxes), default=0)
        if cell_width <= 0 or cell_height <= 0:
            raise ValueError("region detection produced empty cells")

    cropped_frames: list[Image.Image] = []
    frame_meta: list[dict[str, object]] = []
    for index, source_box in enumerate(source_boxes):
        row, col = divmod(index, cols)
        frame = cleaned.crop(source_box)
        components = [component for component in opaque_components(frame) if len(component) >= min_component_size]
        selected_component = max(components, key=len) if components and component_mode == "largest" else None

        if selected_component is not None:
            bbox = bbox_from_points(selected_component)
            if bbox is not None:
                keep = Image.new("RGBA", frame.size, (0, 0, 0, 0))
                keep_pixels = keep.load()
                frame_pixels = frame.load()
                for x, y in selected_component:
                    keep_pixels[x, y] = frame_pixels[x, y]
                frame = keep
                bbox = pad_bbox(bbox, component_padding, frame.width, frame.height)
        else:
            bbox = alpha_bbox(frame)

        edge_touch = bbox_touches_edge(bbox, frame.width, frame.height, edge_touch_margin)
        crop_bbox = bbox
        if crop_bbox is not None:
            frame = frame.crop(crop_bbox)

        cropped_frames.append(frame)
        frame_meta.append(
            {
                "grid": [row, col],
                "source_box": list(source_box),
                "component_mode": component_mode,
                "component_count": len(components),
                "selected_component_area": len(selected_component) if selected_component is not None else None,
                "selected_component_bbox": list(bbox_from_points(selected_component)) if selected_component is not None else None,
                "crop_bbox": list(crop_bbox) if crop_bbox is not None else None,
                "edge_touch": edge_touch,
            }
        )

    if reject_edge_touch:
        touching = [meta["grid"] for meta in frame_meta if meta["edge_touch"]]
        if touching:
            raise ValueError(f"frames touch a cell edge: {touching}")

    common_scale: float | None = None
    if shared_scale:
        max_width = max((frame.width for frame in cropped_frames), default=0)
        max_height = max((frame.height for frame in cropped_frames), default=0)
        if max_width > 0 and max_height > 0:
            common_scale = min(cell_size / max_width, cell_size / max_height) * fit_scale

    frames: list[Image.Image] = []
    for index, frame in enumerate(cropped_frames):
        out = Image.new("RGBA", (cell_size, cell_size), (0, 0, 0, 0))
        if frame.width > 0 and frame.height > 0:
            scale = common_scale if common_scale is not None else min(cell_size / frame.width, cell_size / frame.height) * fit_scale
            new_width = max(1, int(round(frame.width * scale)))
            new_height = max(1, int(round(frame.height * scale)))
            fitted = frame.resize((new_width, new_height), Image.Resampling.NEAREST)
            fitted = apply_palette_lock(fitted, palette_colors)
            paste_x = (cell_size - new_width) // 2
            if align in {"bottom", "feet"}:
                bottom_pad = max(0, int(round(cell_size * (1 - fit_scale) * 0.5)))
                paste_y = cell_size - new_height - bottom_pad
            else:
                paste_y = (cell_size - new_height) // 2
            out.alpha_composite(fitted, (paste_x, paste_y))
            frame_meta[index]["output_size"] = [new_width, new_height]
            frame_meta[index]["paste_position"] = [paste_x, paste_y]
        else:
            frame_meta[index]["output_size"] = [0, 0]
            frame_meta[index]["paste_position"] = [0, 0]
        frames.append(out)

    expression_report = sheet_expression_qc(frames, preset, max_expression_drift) if expression_qc and preset in {"fighter", "portrait"} else None
    if expression_report is not None:
        for index, metrics in enumerate(expression_report["frames"]):
            frame_meta[index]["feature_diagnostics"] = metrics

    for index, frame in enumerate(frames, start=1):
        frame.save(frames_dir / f"frame_{index:02d}.png")

    compose_frame_sheet(frames, rows, cols, cell_size).save(output_dir / "sheet-transparent.png")
    save_transparent_gif(frames, output_dir / "animation.gif", gif_duration)
    if contact_sheet:
        save_sheet_contact_sheet(frames, frame_meta, output_dir / "contact_sheet.png", preview_scale)
    palette = extract_palette(compose_frame_sheet(frames, rows, cols, cell_size), 32)
    write_palette_file(palette, output_dir / "palette.hex", "hex")

    directions: list[str] = []
    if direction_strips:
        if rows != 4 or cols != 4:
            raise ValueError("direction strips require a 4x4 sheet")
        directions = ["down", "left", "right", "up"]
        strips_dir = output_dir / "strips"
        strips_dir.mkdir(parents=True, exist_ok=True)
        for row_index, direction in enumerate(directions):
            row_frames = frames[row_index * cols : (row_index + 1) * cols]
            compose_frame_sheet(row_frames, 1, cols, cell_size).save(strips_dir / f"{direction}-strip.png")
            save_transparent_gif(row_frames, strips_dir / f"{direction}.gif", gif_duration)

    qc = sheet_qc_summary(frames, frame_meta, expression_report, preset)
    metadata: dict[str, object] = {
        "input": str(input_path),
        "files": {
            "raw_sheet": str(output_dir / "raw-sheet.png"),
            "raw_sheet_clean": str(output_dir / "raw-sheet-clean.png"),
            "sheet_transparent": str(output_dir / "sheet-transparent.png"),
            "animation": str(output_dir / "animation.gif"),
            "contact_sheet": str(output_dir / "contact_sheet.png") if contact_sheet else None,
            "palette": str(output_dir / "palette.hex"),
            "bundle_meta": str(output_dir / "bundle-meta.json"),
        },
        "rows": rows,
        "cols": cols,
        "cell_width": cell_width,
        "cell_height": cell_height,
        "cell_size": cell_size,
        "chroma_key": chroma_key,
        "chroma_tolerance": chroma_tolerance,
        "fit_scale": fit_scale,
        "align": align,
        "shared_scale": shared_scale,
        "component_mode": component_mode,
        "component_padding": component_padding,
        "min_component_size": min_component_size,
        "edge_touch_margin": edge_touch_margin,
        "region_mode": region_mode,
        "region_padding": region_padding,
        "region_detection": region_report,
        "gif_duration": gif_duration,
        "contact_sheet": contact_sheet,
        "preview_scale": preview_scale,
        "preset": preset,
        "expression_qc": expression_report,
        "direction_strips": directions,
        "edge_touch_frames": [meta["grid"] for meta in frame_meta if meta["edge_touch"]],
        "qc": qc,
        "palette": [rgb_to_hex(color) for color in palette],
        "frames": frame_meta,
    }
    (output_dir / "pipeline-meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    write_sheet_bundle_meta(
        output_dir,
        input_path=input_path,
        rows=rows,
        cols=cols,
        cell_size=cell_size,
        frames=frames,
        frame_meta=frame_meta,
        qc=qc,
        directions=directions,
        palette=palette,
        contact_sheet=contact_sheet,
    )
    if qc["retry_hints"]:
        write_retry_hints_file(list(qc["retry_hints"]), output_dir / "retry-hints.txt")
        maybe_write_retry_prompt_from_run(
            output_dir,
            list(qc["retry_hints"]),
            cells=cell_size,
            background=rgb_to_hex(chroma_key),
            preset=preset,
            sheet=True,
        )
    return metadata


def axis_grid_line_positions(image: Image.Image, grid_key: RGB, tolerance: int, cells: int, axis: str) -> tuple[list[int], dict[str, object]]:
    rgb = image.convert("RGB")
    pixels = rgb.load()
    if axis == "x":
        length = rgb.width
        perp = rgb.height
        profile = [
            sum(1 for y in range(rgb.height) if is_grid_like(pixels[x, y], grid_key, tolerance))
            for x in range(rgb.width)
        ]
    elif axis == "y":
        length = rgb.height
        perp = rgb.width
        profile = [
            sum(1 for x in range(rgb.width) if is_grid_like(pixels[x, y], grid_key, tolerance))
            for y in range(rgb.height)
        ]
    else:
        raise ValueError("axis must be x or y")

    threshold = max(3, int(round(perp * 0.16)))
    groups: list[tuple[int, int, int]] = []
    start: int | None = None
    total = 0
    for pos, count in enumerate(profile):
        if count >= threshold:
            if start is None:
                start = pos
                total = count
            else:
                total += count
        elif start is not None:
            groups.append((start, pos - 1, total))
            start = None
            total = 0
    if start is not None:
        groups.append((start, length - 1, total))

    centers = [int(round((left + right) / 2)) for left, right, _weight in groups]
    if len(centers) >= 2:
        first = centers[0]
        last = centers[-1]
        expected = [first + (last - first) * i / cells for i in range(cells + 1)]
        selected: list[int] = []
        cursor = 0
        for value in expected:
            best_index = cursor
            best_distance = float("inf")
            for idx in range(cursor, len(centers)):
                distance = abs(centers[idx] - value)
                if distance < best_distance:
                    best_index = idx
                    best_distance = distance
                elif centers[idx] > value and distance > best_distance:
                    break
            selected.append(centers[best_index])
            cursor = best_index

        # If imagegen merged or skipped guide lines, keep the detected extent but use an even lattice.
        if len(set(selected)) != cells + 1:
            selected = [int(round(first + (last - first) * i / cells)) for i in range(cells + 1)]
        selected[0] = max(0, selected[0])
        selected[-1] = min(length - 1, selected[-1])
        return selected, {"axis": axis, "mode": "detected", "threshold": threshold, "groups": len(groups), "first": first, "last": last}

    fallback = [int(round(i * (length - 1) / cells)) for i in range(cells + 1)]
    return fallback, {"axis": axis, "mode": "fallback-even", "threshold": threshold, "groups": len(groups), "first": 0, "last": length - 1}


def axis_grid_line_groups(image: Image.Image, grid_key: RGB, tolerance: int, axis: str) -> tuple[list[tuple[int, int]], dict[str, object]]:
    rgb = image.convert("RGB")
    pixels = rgb.load()
    if axis == "x":
        length = rgb.width
        perp = rgb.height
        profile = [
            sum(1 for y in range(rgb.height) if is_grid_like(pixels[x, y], grid_key, tolerance))
            for x in range(rgb.width)
        ]
    elif axis == "y":
        length = rgb.height
        perp = rgb.width
        profile = [
            sum(1 for x in range(rgb.width) if is_grid_like(pixels[x, y], grid_key, tolerance))
            for y in range(rgb.height)
        ]
    else:
        raise ValueError("axis must be x or y")

    threshold = max(3, int(round(perp * 0.16)))
    groups: list[tuple[int, int]] = []
    start: int | None = None
    for pos, count in enumerate(profile):
        if count >= threshold:
            if start is None:
                start = pos
        elif start is not None:
            groups.append((start, pos - 1))
            start = None
    if start is not None:
        groups.append((start, length - 1))

    return groups, {"axis": axis, "threshold": threshold, "groups": len(groups)}


def selected_grid_line_groups(
    groups: list[tuple[int, int]],
    *,
    cells: int,
    length: int,
) -> tuple[list[tuple[int, int]], str]:
    if len(groups) >= 2:
        centers = [int(round((left + right) / 2)) for left, right in groups]
        first = centers[0]
        last = centers[-1]
        expected = [first + (last - first) * i / cells for i in range(cells + 1)]
        selected: list[tuple[int, int]] = []
        cursor = 0
        for value in expected:
            best_index = cursor
            best_distance = float("inf")
            for idx in range(cursor, len(groups)):
                center = centers[idx]
                distance = abs(center - value)
                if distance < best_distance:
                    best_index = idx
                    best_distance = distance
                elif center > value and distance > best_distance:
                    break
            selected.append(groups[best_index])
            cursor = best_index
        if len(set(selected)) == cells + 1:
            return selected, "detected"

    pitch = max(1.0, (length - 1) / cells)
    half_width = max(0, int(round(pitch * 0.015)))
    fallback = []
    for index in range(cells + 1):
        center = int(round(index * (length - 1) / cells))
        fallback.append((max(0, center - half_width), min(length - 1, center + half_width)))
    return fallback, "fallback-even"


def control_grid_fidelity_qc(
    image: Image.Image,
    options: ForgeOptions,
    *,
    rectify_grid: bool = True,
    min_cell_fill_ratio: float = 0.62,
    max_partial_cell_ratio: float = 0.28,
    max_gutter_foreground_ratio: float = 0.10,
) -> dict[str, object]:
    if options.grid_key is None:
        return {"passes": True, "blocking_issues": [], "warnings": ["grid_key_missing"], "issues": [], "skipped": True}

    src = image.convert("RGB")
    if options.square_crop == "center":
        src = center_square_crop(src)
    width, height = src.size
    background = options.chroma_key if options.chroma_key is not None else estimate_border_background(src)

    if rectify_grid:
        x_groups_raw, x_report = axis_grid_line_groups(src, options.grid_key, options.grid_tolerance, "x")
        y_groups_raw, y_report = axis_grid_line_groups(src, options.grid_key, options.grid_tolerance, "y")
        x_groups, x_mode = selected_grid_line_groups(x_groups_raw, cells=options.cells, length=width)
        y_groups, y_mode = selected_grid_line_groups(y_groups_raw, cells=options.cells, length=height)
    else:
        x_groups, x_mode = selected_grid_line_groups([], cells=options.cells, length=width)
        y_groups, y_mode = selected_grid_line_groups([], cells=options.cells, length=height)
        x_report = {"axis": "x", "threshold": None, "groups": 0}
        y_report = {"axis": "y", "threshold": None, "groups": 0}

    pixels = src.load()

    def is_bg_or_grid(color: RGB) -> bool:
        if is_grid_like(color, options.grid_key, options.grid_tolerance):
            return True
        if options.chroma_key is not None and is_chroma_like(color, options.chroma_key, options.chroma_tolerance):
            return True
        return color_distance(color, background) <= options.background_tolerance

    gutter_total = 0
    gutter_foreground = 0
    x_gutter_points = set()
    for left, right in x_groups:
        for x in range(max(0, left), min(width - 1, right) + 1):
            x_gutter_points.add(x)
    y_gutter_points = set()
    for top, bottom in y_groups:
        for y in range(max(0, top), min(height - 1, bottom) + 1):
            y_gutter_points.add(y)

    for y in range(height):
        in_y = y in y_gutter_points
        for x in range(width):
            if x not in x_gutter_points and not in_y:
                continue
            gutter_total += 1
            if not is_bg_or_grid(pixels[x, y]):
                gutter_foreground += 1

    partial_cells = 0
    foreground_cells = 0
    sampled_cells = 0
    worst_fill_ratio = 1.0
    for gy in range(options.cells):
        y0 = y_groups[gy][1] + 1
        y1 = y_groups[gy + 1][0]
        if y1 <= y0:
            continue
        for gx in range(options.cells):
            x0 = x_groups[gx][1] + 1
            x1 = x_groups[gx + 1][0]
            if x1 <= x0:
                continue
            sampled_cells += 1
            colors: list[RGB] = []
            bg_like = 0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    color = pixels[x, y]
                    if is_bg_or_grid(color):
                        bg_like += 1
                    else:
                        colors.append(color)
            total = len(colors) + bg_like
            if not total:
                continue
            if not colors or len(colors) / total < 0.12:
                continue
            dominant, dominant_count = Counter(colors).most_common(1)[0]
            similar = sum(1 for color in colors if color_distance(color, dominant) <= 34)
            fill_ratio = similar / total
            foreground_cells += 1
            worst_fill_ratio = min(worst_fill_ratio, fill_ratio)
            if fill_ratio < min_cell_fill_ratio:
                partial_cells += 1

    gutter_ratio = gutter_foreground / gutter_total if gutter_total else 0.0
    partial_ratio = partial_cells / foreground_cells if foreground_cells else 0.0
    expected_lines = options.cells + 1
    min_visible_lines = max(8, int(round(expected_lines * 0.45)))
    blocking_issues: list[str] = []
    if int(x_report.get("groups", 0) or 0) < min_visible_lines:
        blocking_issues.append(f"grid_x_lines:{x_report.get('groups', 0)} below {min_visible_lines}")
    if int(y_report.get("groups", 0) or 0) < min_visible_lines:
        blocking_issues.append(f"grid_y_lines:{y_report.get('groups', 0)} below {min_visible_lines}")
    if gutter_ratio > max_gutter_foreground_ratio:
        blocking_issues.append(f"painted_gutters:{gutter_ratio:.3f}>{max_gutter_foreground_ratio:.3f}")
    if foreground_cells and partial_ratio > max_partial_cell_ratio:
        blocking_issues.append(f"partial_cell_fill:{partial_ratio:.3f}>{max_partial_cell_ratio:.3f}")

    warnings: list[str] = []
    if x_mode != "detected" or y_mode != "detected":
        warnings.append(f"grid_group_selection:{x_mode}/{y_mode}")

    return {
        "passes": not blocking_issues,
        "blocking_issues": blocking_issues,
        "warnings": warnings,
        "issues": blocking_issues + warnings,
        "skipped": False,
        "metrics": {
            "gutter_foreground_pixels": gutter_foreground,
            "gutter_total_pixels": gutter_total,
            "gutter_foreground_ratio": round(gutter_ratio, 4),
            "foreground_cells": foreground_cells,
            "partial_cells": partial_cells,
            "partial_cell_ratio": round(partial_ratio, 4),
            "worst_cell_fill_ratio": round(worst_fill_ratio, 4) if foreground_cells else None,
            "sampled_cells": sampled_cells,
        },
        "grid_detection": {
            "x": {**x_report, "selected_lines": len(x_groups), "selection_mode": x_mode},
            "y": {**y_report, "selected_lines": len(y_groups), "selection_mode": y_mode},
            "expected_lines": expected_lines,
            "min_visible_lines": min_visible_lines,
        },
    }


def retry_hints_for_grid_fidelity(report: dict[str, object]) -> list[str]:
    hints: list[str] = []
    for raw_issue in report.get("blocking_issues", []):
        issue = str(raw_issue)
        if issue.startswith("painted_gutters:"):
            hints.append("Regenerate on a tile-board control grid and explicitly keep every cyan gutter clean and continuous.")
        elif issue.startswith("partial_cell_fill:"):
            hints.append("Ask imagegen to fill whole cell squares only, with no normal illustration edges, gradients, or sub-cell silhouettes.")
        elif issue.startswith("grid_x_lines:") or issue.startswith("grid_y_lines:"):
            hints.append("Regenerate with a clearer control grid; the service grid must remain visible across the full canvas.")
    return list(dict.fromkeys(hints))


def crop_control_grid_to_content(
    image: Image.Image,
    options: ForgeOptions,
    *,
    padding_cells: int = 1,
    rectify_grid: bool = True,
) -> ContentCropResult:
    src = image.convert("RGB")
    if options.square_crop == "center":
        src = center_square_crop(src)
    width, height = src.size
    background = options.chroma_key if options.chroma_key is not None else estimate_border_background(src)
    pixels = src.load()
    service_grid_tolerance = max(options.grid_tolerance, 96)
    service_chroma_tolerance = max(options.chroma_tolerance, 96)
    service_background_tolerance = max(options.background_tolerance, 96)

    def is_service_pixel(color: RGB) -> bool:
        if options.grid_key is not None and is_grid_like(color, options.grid_key, service_grid_tolerance):
            return True
        if options.chroma_key is not None and is_chroma_like(color, options.chroma_key, service_chroma_tolerance):
            return True
        return color_distance(color, background) <= service_background_tolerance

    foreground: set[tuple[int, int]] = set()
    for y in range(height):
        for x in range(width):
            if not is_service_pixel(pixels[x, y]):
                foreground.add((x, y))

    if not foreground:
        return ContentCropResult(src, None, None, "empty", False)

    seen: set[tuple[int, int]] = set()
    components: list[list[tuple[int, int]]] = []
    for point in foreground:
        if point in seen:
            continue
        stack = [point]
        seen.add(point)
        component: list[tuple[int, int]] = []
        while stack:
            x, y = stack.pop()
            component.append((x, y))
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                neighbor = (nx, ny)
                if 0 <= nx < width and 0 <= ny < height and neighbor in foreground and neighbor not in seen:
                    seen.add(neighbor)
                    stack.append(neighbor)
        components.append(component)

    largest = max(len(component) for component in components)
    min_component = max(16, int(round(largest * 0.03)))
    content_points = [point for component in components if len(component) >= min_component for point in component]
    if not content_points:
        content_points = max(components, key=len)

    min_x = min(x for x, _y in content_points)
    min_y = min(y for _x, y in content_points)
    max_x = max(x for x, _y in content_points) + 1
    max_y = max(y for _x, y in content_points) + 1
    content_bbox = (min_x, min_y, max_x, max_y)

    crop_box: tuple[int, int, int, int]
    mode = "pixel-content"
    if rectify_grid and options.grid_key is not None:
        x_groups_raw, _x_report = axis_grid_line_groups(src, options.grid_key, options.grid_tolerance, "x")
        y_groups_raw, _y_report = axis_grid_line_groups(src, options.grid_key, options.grid_tolerance, "y")
        x_groups, x_mode = selected_grid_line_groups(x_groups_raw, cells=options.cells, length=width)
        y_groups, y_mode = selected_grid_line_groups(y_groups_raw, cells=options.cells, length=height)
        if len(x_groups) == options.cells + 1 and len(y_groups) == options.cells + 1:
            occupied_x: list[int] = []
            occupied_y: list[int] = []
            for index in range(options.cells):
                cell_left = x_groups[index][1] + 1
                cell_right = x_groups[index + 1][0]
                if cell_right > min_x and cell_left < max_x:
                    occupied_x.append(index)
                cell_top = y_groups[index][1] + 1
                cell_bottom = y_groups[index + 1][0]
                if cell_bottom > min_y and cell_top < max_y:
                    occupied_y.append(index)
            if occupied_x and occupied_y:
                x0 = max(0, min(occupied_x) - max(0, padding_cells))
                x1 = min(options.cells - 1, max(occupied_x) + max(0, padding_cells))
                y0 = max(0, min(occupied_y) - max(0, padding_cells))
                y1 = min(options.cells - 1, max(occupied_y) + max(0, padding_cells))
                crop_box = (
                    max(0, x_groups[x0][0]),
                    max(0, y_groups[y0][0]),
                    min(width, x_groups[x1 + 1][1] + 1),
                    min(height, y_groups[y1 + 1][1] + 1),
                )
                mode = f"grid-cell-content:{x_mode}/{y_mode}"
            else:
                crop_box = content_bbox
        else:
            crop_box = content_bbox
    else:
        crop_box = content_bbox

    crop_box = (
        max(0, min(width - 1, crop_box[0])),
        max(0, min(height - 1, crop_box[1])),
        max(1, min(width, crop_box[2])),
        max(1, min(height, crop_box[3])),
    )
    if crop_box[2] <= crop_box[0] or crop_box[3] <= crop_box[1]:
        return ContentCropResult(src, None, content_bbox, "invalid", False)

    cropped = src.crop(crop_box)
    if cropped.width == cropped.height:
        return ContentCropResult(cropped, crop_box, content_bbox, mode, False)

    side = max(cropped.width, cropped.height)
    square = Image.new("RGB", (side, side), background)
    square.paste(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2))
    return ContentCropResult(square, crop_box, content_bbox, mode, True)


def sample_control_grid_image(
    image: Image.Image,
    options: ForgeOptions,
    *,
    rectify_grid: bool = True,
) -> tuple[Image.Image, dict[str, object]]:
    _validate_options(options)
    src = image.convert("RGB")
    if options.square_crop == "center":
        src = center_square_crop(src)
    if options.prequantize_palette:
        src = quantize_rgb(src, options.prequantize_palette)

    width, height = src.size
    background = options.chroma_key if options.chroma_key is not None else estimate_border_background(src)
    if rectify_grid and options.grid_key is not None:
        x_lines, x_report = axis_grid_line_positions(src, options.grid_key, options.grid_tolerance, options.cells, "x")
        y_lines, y_report = axis_grid_line_positions(src, options.grid_key, options.grid_tolerance, options.cells, "y")
    else:
        x_lines = [int(round(i * width / options.cells)) for i in range(options.cells)] + [width - 1]
        y_lines = [int(round(i * height / options.cells)) for i in range(options.cells)] + [height - 1]
        x_report = {"axis": "x", "mode": "even", "groups": 0, "first": 0, "last": width - 1}
        y_report = {"axis": "y", "mode": "even", "groups": 0, "first": 0, "last": height - 1}

    mode = "RGBA" if options.transparent else "RGB"
    pixel_map = Image.new(mode, (options.cells, options.cells), (0, 0, 0, 0) if options.transparent else (0, 0, 0))
    source_pixels = src.load()
    output_pixels = pixel_map.load()

    for gy in range(options.cells):
        y0, y1 = sorted((y_lines[gy], y_lines[gy + 1]))
        cell_height = max(1, y1 - y0)
        margin_y = max(0, int(round(cell_height * options.sample_margin_ratio)))
        sample_y0 = min(max(y0 + margin_y, 0), height - 1)
        sample_y1 = min(max(y1 - margin_y, sample_y0 + 1), height)
        for gx in range(options.cells):
            x0, x1 = sorted((x_lines[gx], x_lines[gx + 1]))
            cell_width = max(1, x1 - x0)
            margin_x = max(0, int(round(cell_width * options.sample_margin_ratio)))
            sample_x0 = min(max(x0 + margin_x, 0), width - 1)
            sample_x1 = min(max(x1 - margin_x, sample_x0 + 1), width)

            samples: list[RGB] = []
            bg_like = 0
            total = 0
            for y in range(sample_y0, sample_y1):
                for x in range(sample_x0, sample_x1):
                    pixel = source_pixels[x, y]
                    if options.grid_key is not None and is_grid_like(pixel, options.grid_key, options.grid_tolerance):
                        continue
                    total += 1
                    if options.chroma_key is not None and is_chroma_like(pixel, options.chroma_key, options.chroma_tolerance):
                        bg_like += 1
                    elif color_distance(pixel, background) <= options.background_tolerance:
                        bg_like += 1
                    if sum(pixel) > 60:
                        samples.append(pixel)

            if not samples:
                cx = min(width - 1, max(0, int(round((x0 + x1) / 2))))
                cy = min(height - 1, max(0, int(round((y0 + y1) / 2))))
                fallback = source_pixels[cx, cy]
                samples.append(background if options.grid_key is not None and is_grid_like(fallback, options.grid_key, options.grid_tolerance) else fallback)

            color = sample_color(samples, options.sample_mode)
            is_background_cell = total and bg_like / total >= 0.72
            is_background_color = color_distance(color, background) <= options.background_tolerance * 2
            is_chroma_color = options.chroma_key is not None and is_chroma_like(color, options.chroma_key, options.chroma_tolerance)

            if options.transparent and (is_background_cell or is_background_color or is_chroma_color):
                output_pixels[gx, gy] = (0, 0, 0, 0)
            elif options.transparent:
                output_pixels[gx, gy] = (color[0], color[1], color[2], 255)
            else:
                output_pixels[gx, gy] = color

    if options.transparent:
        pixel_map = quantize_rgba(pixel_map, options.palette)
        pixel_map = postprocess_rgba(pixel_map, options)
        pixel_map = apply_palette_lock(pixel_map, options.palette_colors)
    else:
        pixel_map = quantize_rgb(pixel_map, options.palette)
        pixel_map = apply_palette_lock(pixel_map, options.palette_colors)

    return pixel_map, {"rectify_grid": rectify_grid, "x": x_report, "y": y_report}


def process_grid_sheet(
    input_path: Path,
    output_dir: Path,
    *,
    rows: int,
    cols: int,
    frame_cells: int = 64,
    chroma_key: RGB = (255, 0, 255),
    chroma_tolerance: int = 64,
    grid_key: RGB | None = None,
    grid_tolerance: int = 48,
    sample_margin_ratio: float = 0.40,
    sample_mode: str = "median",
    palette: int = 24,
    min_component_size: int = 0,
    center_alpha: bool = False,
    strip_edge_background: bool = True,
    gif_duration: int = 160,
    preview_scale: int = 4,
    prompt_file: Path | None = None,
    preset: str = "generic",
    rectify_grid: bool = True,
) -> dict[str, object]:
    if rows <= 0 or cols <= 0:
        raise ValueError("rows and cols must be positive")
    if frame_cells <= 0:
        raise ValueError("frame cells must be positive")
    if gif_duration <= 0 or preview_scale <= 0:
        raise ValueError("GIF duration and preview scale must be positive")

    output_dir.mkdir(parents=True, exist_ok=True)
    source_dir = output_dir / "source-frames"
    frames_dir = output_dir / "frames"
    source_dir.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)
    if prompt_file is not None:
        (output_dir / "prompt-used.txt").write_text(prompt_file.read_text(encoding="utf-8"), encoding="utf-8")

    raw = Image.open(input_path).convert("RGB")
    raw.save(output_dir / "raw-sheet.png")
    cell_width = raw.width // cols
    cell_height = raw.height // rows
    if cell_width <= 0 or cell_height <= 0:
        raise ValueError("rows and cols produce empty source cells")

    options = ForgeOptions(
        cells=frame_cells,
        scale=1,
        sample_margin_ratio=sample_margin_ratio,
        palette=palette,
        transparent=True,
        square_crop="center",
        sample_mode=sample_mode,
        chroma_key=chroma_key,
        chroma_tolerance=chroma_tolerance,
        grid_key=grid_key,
        grid_tolerance=grid_tolerance,
        min_component_size=min_component_size,
        center_alpha=center_alpha,
        strip_edge_background=strip_edge_background,
        preset=preset,
    )

    frames: list[Image.Image] = []
    frame_meta: list[dict[str, object]] = []
    for index in range(rows * cols):
        row, col = divmod(index, cols)
        source_box = (col * cell_width, row * cell_height, (col + 1) * cell_width, (row + 1) * cell_height)
        raw_frame_path = source_dir / f"frame_{index + 1:02d}_raw.png"
        clean_frame_path = frames_dir / f"frame_{index + 1:02d}.png"
        raw_frame = raw.crop(source_box)
        raw_frame.save(raw_frame_path)
        frame, grid_report = sample_control_grid_image(raw_frame, options, rectify_grid=rectify_grid)
        frame = frame.convert("RGBA")
        clean_frame_path.parent.mkdir(parents=True, exist_ok=True)
        frame.save(clean_frame_path)
        bbox = alpha_bbox(frame)
        frames.append(frame)
        frame_meta.append(
            {
                "grid": [row, col],
                "source_box": list(source_box),
                "raw_frame": str(raw_frame_path),
                "output_frame": str(clean_frame_path),
                "grid_detection": grid_report,
                "component_count": len(opaque_components(frame)),
                "crop_bbox": list(bbox) if bbox is not None else None,
                "output_size": [bbox[2] - bbox[0], bbox[3] - bbox[1]] if bbox is not None else [0, 0],
                "paste_position": [0, 0],
                "edge_touch": bbox_touches_edge(bbox, frame.width, frame.height, 0),
            }
        )

    sheet = compose_frame_sheet(frames, rows, cols, frame_cells)
    sheet.save(output_dir / "sheet-transparent.png")
    save_transparent_gif(frames, output_dir / "animation.gif", gif_duration)
    save_sheet_contact_sheet(frames, frame_meta, output_dir / "contact_sheet.png", preview_scale)
    palette_colors = extract_palette(sheet, 32)
    write_palette_file(palette_colors, output_dir / "palette.hex", "hex")

    qc = sheet_qc_summary(frames, frame_meta, None, preset)
    if rectify_grid:
        target_lines = frame_cells + 1
        weak_frames: list[object] = []
        for meta in frame_meta:
            grid_detection = meta.get("grid_detection", {})
            if not isinstance(grid_detection, dict):
                continue
            x_report = grid_detection.get("x", {})
            y_report = grid_detection.get("y", {})
            if not isinstance(x_report, dict) or not isinstance(y_report, dict):
                continue
            x_groups = int(x_report.get("groups", 0))
            y_groups = int(y_report.get("groups", 0))
            allowed_drift = max(2, int(round(target_lines * 0.1)))
            if abs(x_groups - target_lines) > allowed_drift or abs(y_groups - target_lines) > allowed_drift:
                weak_frames.append({"grid": meta["grid"], "x_lines": x_groups, "y_lines": y_groups, "expected": target_lines})
        if weak_frames:
            qc["passes"] = False
            qc["grid_fidelity_issues"] = weak_frames
            qc["issues"].append(f"grid_line_loss:{len(weak_frames)}")
            qc["retry_hints"].append(
                f"Ask imagegen to preserve exactly {target_lines} visible vertical and horizontal service grid lines inside every frame; use a lower-density grid if it cannot hold that line count."
            )
    metadata: dict[str, object] = {
        "input": str(input_path),
        "files": {
            "raw_sheet": str(output_dir / "raw-sheet.png"),
            "sheet_transparent": str(output_dir / "sheet-transparent.png"),
            "animation": str(output_dir / "animation.gif"),
            "contact_sheet": str(output_dir / "contact_sheet.png"),
            "palette": str(output_dir / "palette.hex"),
        },
        "rows": rows,
        "cols": cols,
        "source_cell_width": cell_width,
        "source_cell_height": cell_height,
        "frame_cells": frame_cells,
        "chroma_key": rgb_to_hex(chroma_key),
        "grid_key": rgb_to_hex(grid_key) if grid_key else None,
        "sample_margin_ratio": sample_margin_ratio,
        "sample_mode": sample_mode,
        "rectify_grid": rectify_grid,
        "palette_limit": palette,
        "gif_duration": gif_duration,
        "preview_scale": preview_scale,
        "preset": preset,
        "qc": qc,
        "palette": [rgb_to_hex(color) for color in palette_colors],
        "frames": frame_meta,
    }
    (output_dir / "pipeline-meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    if qc["retry_hints"]:
        write_retry_hints_file(list(qc["retry_hints"]), output_dir / "retry-hints.txt")
        maybe_write_retry_prompt_from_run(
            output_dir,
            list(qc["retry_hints"]),
            cells=frame_cells,
            background=rgb_to_hex(chroma_key),
            preset=preset,
            sheet=True,
        )
    return metadata


def assemble_animation_frames(
    inputs: list[Path],
    output_dir: Path,
    *,
    cols: int = 4,
    gif_duration: int = 140,
    preview_scale: int = 6,
    anchor_align: str = "bottom",
    palette_colors: tuple[RGB, ...] = (),
    palette_source: str | None = None,
) -> dict[str, object]:
    if not inputs:
        raise ValueError("at least one frame is required")
    if cols <= 0:
        raise ValueError("cols must be positive")
    if gif_duration <= 0 or preview_scale <= 0:
        raise ValueError("GIF duration and preview scale must be positive")

    output_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = output_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    frames = [Image.open(path).convert("RGBA") for path in inputs]
    width = max(frame.width for frame in frames)
    height = max(frame.height for frame in frames)
    if width != height:
        raise ValueError("animation frames must fit square cells")
    normalized: list[Image.Image] = []
    frame_meta: list[dict[str, object]] = []
    for index, frame in enumerate(frames, start=1):
        out = Image.new("RGBA", (width, width), (0, 0, 0, 0))
        out.alpha_composite(frame, ((width - frame.width) // 2, (width - frame.height) // 2))
        out = apply_palette_lock(out, palette_colors)
        bbox = alpha_bbox(out)
        row, col = divmod(index - 1, cols)
        normalized.append(out)
        frame_meta.append(
            {
                "grid": [row, col],
                "source": str(inputs[index - 1]),
                "output_frame": str(frames_dir / f"frame_{index:02d}.png"),
                "crop_bbox_before_anchor_align": list(bbox) if bbox is not None else None,
                "component_count": len(opaque_components(out)),
                "edge_touch": bbox_touches_edge(bbox, out.width, out.height, 0),
            }
        )
    normalized, anchor_report = align_animation_anchors(normalized, mode=anchor_align)
    for index, out in enumerate(normalized, start=1):
        output_path = frames_dir / f"frame_{index:02d}.png"
        out.save(output_path)
        bbox = alpha_bbox(out)
        frame_meta[index - 1]["crop_bbox"] = list(bbox) if bbox is not None else None
        frame_meta[index - 1]["edge_touch"] = bbox_touches_edge(bbox, out.width, out.height, 0)
        if index - 1 < len(anchor_report.get("shifts", [])):
            frame_meta[index - 1]["anchor_align"] = anchor_report["shifts"][index - 1]

    rows = (len(normalized) + cols - 1) // cols
    padded = normalized + [Image.new("RGBA", (width, width), (0, 0, 0, 0)) for _ in range(rows * cols - len(normalized))]
    sheet = compose_frame_sheet(padded, rows, cols, width)
    sheet.save(output_dir / "sheet-transparent.png")
    save_transparent_gif(normalized, output_dir / "animation.gif", gif_duration)
    save_sheet_contact_sheet(normalized, frame_meta, output_dir / "contact_sheet.png", preview_scale)
    palette = palette_colors or extract_palette(sheet, 32)
    write_palette_file(palette, output_dir / "palette.hex", "hex")
    qc = sheet_qc_summary(normalized, frame_meta, None, "item")
    metadata: dict[str, object] = {
        "inputs": [str(path) for path in inputs],
        "files": {
            "sheet_transparent": str(output_dir / "sheet-transparent.png"),
            "animation": str(output_dir / "animation.gif"),
            "contact_sheet": str(output_dir / "contact_sheet.png"),
            "palette": str(output_dir / "palette.hex"),
        },
        "rows": rows,
        "cols": cols,
        "cell_size": width,
        "gif_duration": gif_duration,
        "anchor_align": anchor_report,
        "palette_lock": {
            "enabled": bool(palette_colors),
            "source": str(palette_source) if palette_source else None,
            "colors": len(palette_colors),
        },
        "qc": qc,
        "frames": frame_meta,
    }
    (output_dir / "pipeline-meta.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def protected_face_detail_pixels(image: Image.Image, preset: str) -> set[tuple[int, int]]:
    if image.mode != "RGBA" or preset not in {"fighter", "portrait"}:
        return set()

    bbox = alpha_bbox(image)
    if bbox is None:
        return set()

    region = feature_region_from_bbox(bbox, image.size, preset)
    protected: set[tuple[int, int]] = set()
    for component in predicate_components(image, region, is_dark_feature_pixel):
        component_bbox = bbox_from_points(component)
        if component_bbox is None:
            continue
        comp_width = component_bbox[2] - component_bbox[0]
        comp_height = component_bbox[3] - component_bbox[1]
        if 1 <= len(component) <= 36 and comp_width <= 9 and comp_height <= 9:
            protected.update(component)

    pixels = image.load()
    left, top, right, bottom = region
    for y in range(top, bottom):
        for x in range(left, right):
            r, g, b, a = pixels[x, y]
            if a > 0 and is_orange_feature_pixel((r, g, b)):
                protected.add((x, y))

    return protected


def postprocess_rgba(image: Image.Image, options: ForgeOptions) -> Image.Image:
    if image.mode != "RGBA":
        return image

    image = strip_edge_background(image, options)
    image = remove_small_components(image, options.min_component_size, options.keep_largest_component)
    protected_pixels = protected_face_detail_pixels(image, options.preset) if options.protect_face_details else set()
    image = remove_service_color_pixels(image, options, protected_pixels)
    image = remove_dark_specks(image, options.dark_speck_size, options.dark_threshold, protected_pixels)
    image = remove_small_color_components(image, options.min_color_component_size, protected_pixels)
    image = despeckle_image(image, options.despeckle, protected_pixels)
    if options.center_alpha:
        image = center_alpha_image(image)
    if options.outline_color is not None:
        image = add_outline(image, options.outline_color)
    if options.trim_alpha:
        image = trim_alpha_image(image)
    return image


def count_dark_specks(image: Image.Image, max_size: int = 3, dark_threshold: int = 80) -> int:
    return len(dark_speck_points(image, max_size, dark_threshold))


def count_visible_colors(image: Image.Image) -> int:
    if image.mode != "RGBA":
        return 0

    pixels = image.load()
    colors: set[tuple[int, int, int]] = set()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if a > 0:
                colors.add((r, g, b))
    return len(colors)


def feature_region_from_bbox(bbox: tuple[int, int, int, int], image_size: tuple[int, int], preset: str) -> tuple[int, int, int, int]:
    left, top, right, bottom = bbox
    width = right - left
    height = bottom - top
    x_pad = max(0, int(round(width * 0.08)))
    y_ratio = 0.72 if preset == "portrait" else 0.68
    region = (
        left + x_pad,
        top,
        right - x_pad,
        top + max(1, int(round(height * y_ratio))),
    )
    return (
        max(0, region[0]),
        max(0, region[1]),
        min(image_size[0], max(region[0] + 1, region[2])),
        min(image_size[1], max(region[1] + 1, region[3])),
    )


def is_dark_feature_pixel(color: RGB) -> bool:
    r, g, b = color
    return r + g + b <= 150 and max(r, g, b) <= 90


def is_orange_feature_pixel(color: RGB) -> bool:
    r, g, b = color
    return r >= 170 and 45 <= g <= 175 and b <= 95 and r > g > b


def is_yellow_body_pixel(color: RGB) -> bool:
    r, g, b = color
    return r >= 170 and g >= 120 and b <= 110 and r >= g >= b


def predicate_components(
    image: Image.Image,
    region: tuple[int, int, int, int],
    predicate,
) -> list[list[tuple[int, int]]]:
    if image.mode != "RGBA":
        return []

    pixels = image.load()
    left, top, right, bottom = region
    visited: set[tuple[int, int]] = set()
    components: list[list[tuple[int, int]]] = []

    for y in range(top, bottom):
        for x in range(left, right):
            if (x, y) in visited:
                continue
            r, g, b, a = pixels[x, y]
            if a == 0 or not predicate((r, g, b)):
                continue

            component: list[tuple[int, int]] = []
            queue: deque[tuple[int, int]] = deque([(x, y)])
            visited.add((x, y))
            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx = cx + dx
                    ny = cy + dy
                    if nx < left or nx >= right or ny < top or ny >= bottom or (nx, ny) in visited:
                        continue
                    nr, ng, nb, na = pixels[nx, ny]
                    if na > 0 and predicate((nr, ng, nb)):
                        visited.add((nx, ny))
                        queue.append((nx, ny))
            components.append(component)

    return components


def count_predicate_pixels(image: Image.Image, predicate, region: tuple[int, int, int, int] | None = None) -> int:
    if image.mode != "RGBA":
        return 0

    left, top, right, bottom = region or (0, 0, image.width, image.height)
    pixels = image.load()
    count = 0
    for y in range(top, bottom):
        for x in range(left, right):
            r, g, b, a = pixels[x, y]
            if a > 0 and predicate((r, g, b)):
                count += 1
    return count


def predicate_points(image: Image.Image, predicate, region: tuple[int, int, int, int] | None = None) -> list[tuple[int, int]]:
    if image.mode != "RGBA":
        return []

    left, top, right, bottom = region or (0, 0, image.width, image.height)
    pixels = image.load()
    points: list[tuple[int, int]] = []
    for y in range(top, bottom):
        for x in range(left, right):
            r, g, b, a = pixels[x, y]
            if a > 0 and predicate((r, g, b)):
                points.append((x, y))
    return points


def point_centroid(points: list[tuple[int, int]]) -> list[float] | None:
    if not points:
        return None
    return [round(sum(point[0] for point in points) / len(points), 3), round(sum(point[1] for point in points) / len(points), 3)]


def sprite_feature_diagnostics(image: Image.Image, preset: str = "generic") -> dict[str, object]:
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")

    rgba = image.convert("RGBA")
    bbox = alpha_bbox(rgba)
    if bbox is None:
        return {
            "head_region": None,
            "dark_feature_components": 0,
            "orange_feature_pixels": 0,
            "yellow_body_pixels": 0,
            "duck_like": False,
            "issues": ["empty_sprite"],
        }

    region = feature_region_from_bbox(bbox, rgba.size, preset)
    dark_components = []
    for component in predicate_components(rgba, region, is_dark_feature_pixel):
        component_bbox = bbox_from_points(component)
        if component_bbox is None:
            continue
        comp_width = component_bbox[2] - component_bbox[0]
        comp_height = component_bbox[3] - component_bbox[1]
        if 1 <= len(component) <= 36 and comp_width <= 9 and comp_height <= 9:
            dark_components.append(component)

    orange_pixels = count_predicate_pixels(rgba, is_orange_feature_pixel, region)
    yellow_pixels = count_predicate_pixels(rgba, is_yellow_body_pixel)
    alpha_pixels = sum(1 for value in rgba.getchannel("A").tobytes() if value > 0)
    duck_like = yellow_pixels >= max(80, int(alpha_pixels * 0.12)) and preset in {"fighter", "portrait", "generic"}

    issues: list[str] = []
    if preset in {"fighter", "portrait", "generic"} and alpha_pixels >= 180 and len(dark_components) == 0:
        issues.append("lost_eyes")
    if duck_like and orange_pixels < 4:
        issues.append("missing_beak")

    return {
        "head_region": list(region),
        "dark_feature_components": len(dark_components),
        "orange_feature_pixels": orange_pixels,
        "yellow_body_pixels": yellow_pixels,
        "duck_like": duck_like,
        "issues": issues,
    }


def same_color_run_metrics(image: Image.Image) -> dict[str, object]:
    rgba = image.convert("RGBA")
    bbox = alpha_bbox(rgba)
    if bbox is None:
        return {"runs": 0, "two_pixel_runs": 0, "two_pixel_share": 0.0}

    pixels = rgba.load()
    left, top, right, bottom = bbox
    runs = 0
    two_pixel_runs = 0

    def consume_line(colors: list[tuple[int, int, int, int]]) -> None:
        nonlocal runs, two_pixel_runs
        index = 0
        while index < len(colors):
            color = colors[index]
            if color[3] == 0:
                index += 1
                continue
            length = 1
            while index + length < len(colors) and colors[index + length] == color:
                length += 1
            runs += 1
            if length == 2:
                two_pixel_runs += 1
            index += length

    for y in range(top, bottom):
        consume_line([pixels[x, y] for x in range(left, right)])
    for x in range(left, right):
        consume_line([pixels[x, y] for y in range(top, bottom)])

    share = round(two_pixel_runs / runs, 3) if runs else 0.0
    return {"runs": runs, "two_pixel_runs": two_pixel_runs, "two_pixel_share": share}


def style_reference_selection_score(
    image: Image.Image,
    *,
    preset: str,
    reconstruction_score: float,
    lattice_detection_score: float,
    phase_mode: str,
    pixel_size: int | None = None,
    phase: tuple[int, int] | None = None,
    low_size: tuple[int, int] | None = None,
    target_reference: Image.Image | None = None,
) -> tuple[float, dict[str, object]]:
    rgba = image.convert("RGBA")
    bbox = alpha_bbox(rgba)
    feature = sprite_feature_diagnostics(rgba, preset)
    runs = same_color_run_metrics(rgba)
    edge_pixels = edge_alpha_pixels(rgba)
    components = opaque_components(rgba)
    small_components = sum(1 for component in components if len(component) < 4)
    bbox_width = bbox[2] - bbox[0] if bbox else 0
    bbox_height = bbox[3] - bbox[1] if bbox else 0
    bbox_area = bbox_width * bbox_height
    alpha_pixels = sum(1 for value in rgba.getchannel("A").tobytes() if value > 0)
    fill_ratio = alpha_pixels / bbox_area if bbox_area else 0.0

    base = -lattice_detection_score * 0.2 if phase_mode == "hidden-grid" else reconstruction_score * 0.45
    penalty = 0.0
    penalty += edge_pixels * 28
    penalty += small_components * 45

    dark_components = int(feature.get("dark_feature_components", 0))
    if preset in {"fighter", "portrait", "generic"}:
        if dark_components == 0:
            penalty += 900
        elif dark_components > 8:
            penalty += (dark_components - 8) * 86

    two_pixel_share = float(runs["two_pixel_share"])
    if two_pixel_share > 0.34:
        penalty += (two_pixel_share - 0.34) * 850

    if bbox:
        min_height = rgba.height * (0.82 if preset in {"fighter", "portrait"} else 0.42)
        min_width = rgba.width * (0.50 if preset in {"fighter", "portrait"} else 0.28)
        if bbox_height < min_height:
            penalty += (min_height - bbox_height) * 62
        if bbox_width < min_width:
            penalty += (min_width - bbox_width) * 46
        if preset in {"fighter", "portrait"}:
            penalty -= min(2.8, max(0.0, bbox_height - min_height) * 0.34)
            penalty -= min(2.4, max(0.0, bbox_width - min_width) * 0.28)
        if bbox_width >= rgba.width - 1:
            penalty += 120
        if bbox_height >= rgba.height - 1:
            penalty += 90
        if fill_ratio > 0.82:
            penalty += (fill_ratio - 0.82) * 220
        if fill_ratio < 0.18:
            penalty += 140

    if preset in {"fighter", "portrait"} and low_size is not None:
        low_width, low_height = low_size
        if low_height < rgba.height * 0.78:
            penalty += (rgba.height * 0.78 - low_height) * 55
        if low_width < rgba.width * 0.46:
            penalty += (rgba.width * 0.46 - low_width) * 42

    if preset in {"fighter", "portrait"} and pixel_size is not None:
        # Screenshot refs for tiny/chibi pixel art often have compressed
        # source pixels. Very large inferred cells look clean but erase
        # one-pixel details, so keep them as fallback-only candidates.
        if target_reference is None and pixel_size > 10:
            penalty += (pixel_size - 10) * 120
        if phase is not None and pixel_size > 0:
            half = pixel_size / 2
            phase_y = phase[1] % pixel_size
            penalty += abs(phase_y - half) * 0.09

    target_metrics: dict[str, object] | None = None
    if target_reference is not None:
        target_metrics = style_reference_target_match_metrics(rgba, target_reference)
        penalty += float(target_metrics["penalty"])

    metrics = {
        "base": round(base, 3),
        "penalty": round(penalty, 3),
        "edge_pixels": edge_pixels,
        "small_opaque_components": small_components,
        "bbox": list(bbox or ()),
        "fill_ratio": round(fill_ratio, 3),
        "dark_feature_components": dark_components,
        "two_pixel_run_metrics": runs,
        "pixel_size": pixel_size,
        "phase": list(phase) if phase is not None else None,
        "low_size": list(low_size) if low_size is not None else None,
        "target_match": target_metrics,
    }
    return base + penalty, metrics


def style_reference_target_match_metrics(candidate: Image.Image, target: Image.Image) -> dict[str, object]:
    candidate_rgba = candidate.convert("RGBA")
    target_rgba = target.convert("RGBA")
    if candidate_rgba.size != target_rgba.size:
        target_rgba = fit_sprite_to_canvas(target_rgba, candidate_rgba.width)

    candidate_pixels = candidate_rgba.load()
    target_pixels = target_rgba.load()
    alpha_false_positive = 0
    alpha_false_negative = 0
    overlap = 0
    color_distance_total = 0
    candidate_dark: set[tuple[int, int]] = set()
    target_dark: set[tuple[int, int]] = set()
    candidate_accent: set[tuple[int, int]] = set()
    target_accent: set[tuple[int, int]] = set()
    for y in range(candidate_rgba.height):
        for x in range(candidate_rgba.width):
            cr, cg, cb, ca = candidate_pixels[x, y]
            tr, tg, tb, ta = target_pixels[x, y]
            c_on = ca > 0
            t_on = ta > 0
            if c_on and is_dark_feature_pixel((cr, cg, cb)):
                candidate_dark.add((x, y))
            if t_on and is_dark_feature_pixel((tr, tg, tb)):
                target_dark.add((x, y))
            if c_on and is_orange_feature_pixel((cr, cg, cb)):
                candidate_accent.add((x, y))
            if t_on and is_orange_feature_pixel((tr, tg, tb)):
                target_accent.add((x, y))
            if c_on and not t_on:
                alpha_false_positive += 1
            elif t_on and not c_on:
                alpha_false_negative += 1
            elif c_on and t_on:
                overlap += 1
                color_distance_total += color_distance((cr, cg, cb), (tr, tg, tb))

    candidate_bbox = alpha_bbox(candidate_rgba)
    target_bbox = alpha_bbox(target_rgba)
    bbox_delta = 0
    if candidate_bbox and target_bbox:
        bbox_delta = sum(abs(candidate_bbox[index] - target_bbox[index]) for index in range(4))
    elif candidate_bbox or target_bbox:
        bbox_delta = candidate_rgba.width + candidate_rgba.height

    target_area = sum(1 for value in target_rgba.getchannel("A").tobytes() if value > 0)
    alpha_miss = alpha_false_positive + alpha_false_negative
    alpha_miss_share = alpha_miss / max(1, target_area)
    mean_color_distance = color_distance_total / max(1, overlap)
    dark_missed = count_feature_misses(target_dark, candidate_dark)
    dark_extra = count_feature_misses(candidate_dark, target_dark)
    accent_missed = count_feature_misses(target_accent, candidate_accent)
    accent_extra = count_feature_misses(candidate_accent, target_accent)
    penalty = (
        alpha_miss * 5.5
        + bbox_delta * 28
        + mean_color_distance * 0.42
        + dark_missed * 18
        + dark_extra * 5
        + accent_missed * 16
        + accent_extra * 4
    )
    return {
        "penalty": round(penalty, 3),
        "alpha_false_positive": alpha_false_positive,
        "alpha_false_negative": alpha_false_negative,
        "alpha_miss_share": round(alpha_miss_share, 3),
        "overlap": overlap,
        "mean_color_distance": round(mean_color_distance, 3),
        "candidate_bbox": list(candidate_bbox or ()),
        "target_bbox": list(target_bbox or ()),
        "bbox_delta": bbox_delta,
        "dark_missed": dark_missed,
        "dark_extra": dark_extra,
        "accent_missed": accent_missed,
        "accent_extra": accent_extra,
    }


def count_feature_misses(reference_points: set[tuple[int, int]], candidate_points: set[tuple[int, int]], radius: int = 1) -> int:
    misses = 0
    for x, y in reference_points:
        found = False
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                if (x + dx, y + dy) in candidate_points:
                    found = True
                    break
            if found:
                break
        if not found:
            misses += 1
    return misses


def target_guided_phase_pairs(cropped_source: Image.Image, target_reference: Image.Image, pixel_size: int, radius: int = 2) -> set[tuple[int, int]]:
    source_bbox = alpha_bbox(cropped_source.convert("RGBA"))
    target_bbox = alpha_bbox(target_reference.convert("RGBA"))
    if source_bbox is None or target_bbox is None or pixel_size <= 0:
        return {(pixel_size // 2, pixel_size // 2)}
    phase_x = int(round(source_bbox[0] - target_bbox[0] * pixel_size)) % pixel_size
    phase_y = int(round(source_bbox[1] - target_bbox[1] * pixel_size)) % pixel_size
    pairs: set[tuple[int, int]] = set()
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            pairs.add(((phase_x + dx) % pixel_size, (phase_y + dy) % pixel_size))
    half = pixel_size // 2
    pairs.update({(phase_x, phase_y), (half, half), (half, phase_y), (phase_x, half)})
    return pairs


def frame_expression_metrics(image: Image.Image, preset: str) -> dict[str, object]:
    rgba = image.convert("RGBA")
    diagnostics = sprite_feature_diagnostics(rgba, preset)
    region_value = diagnostics["head_region"]
    region = tuple(region_value) if isinstance(region_value, list) else None
    dark_points = predicate_points(rgba, is_dark_feature_pixel, region) if region is not None else []
    orange_points = predicate_points(rgba, is_orange_feature_pixel, region) if region is not None else []
    return {
        **diagnostics,
        "dark_feature_centroid": point_centroid(dark_points),
        "orange_feature_centroid": point_centroid(orange_points),
    }


def centroid_drift(centroids: list[list[float] | None]) -> float:
    points = [point for point in centroids if point is not None]
    if len(points) < 2:
        return 0.0
    max_drift = 0.0
    for index, point in enumerate(points):
        for other in points[index + 1 :]:
            drift = ((point[0] - other[0]) ** 2 + (point[1] - other[1]) ** 2) ** 0.5
            max_drift = max(max_drift, drift)
    return round(max_drift, 3)


def sheet_expression_qc(frames: list[Image.Image], preset: str = "generic", max_feature_drift: float = 6.0) -> dict[str, object]:
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    if max_feature_drift < 0:
        raise ValueError("max feature drift must be zero or positive")

    frame_metrics = [frame_expression_metrics(frame, preset) for frame in frames]
    dark_counts = [int(metrics["dark_feature_components"]) for metrics in frame_metrics]
    orange_counts = [int(metrics["orange_feature_pixels"]) for metrics in frame_metrics]
    dark_drift = centroid_drift([metrics["dark_feature_centroid"] for metrics in frame_metrics])  # type: ignore[list-item]
    orange_drift = centroid_drift([metrics["orange_feature_centroid"] for metrics in frame_metrics])  # type: ignore[list-item]

    issues: list[str] = []
    for index, metrics in enumerate(frame_metrics, start=1):
        for issue in metrics["issues"]:
            if issue != "empty_sprite":
                issues.append(f"frame_{index:02d}:{issue}")

    if dark_counts and max(dark_counts) > 0 and min(dark_counts) == 0:
        issues.append(f"dark_feature_count_drift:{min(dark_counts)}-{max(dark_counts)}")
    if orange_counts and max(orange_counts) >= 4 and min(orange_counts) < 4:
        issues.append(f"orange_feature_count_drift:{min(orange_counts)}-{max(orange_counts)}")
    if dark_drift > max_feature_drift:
        issues.append(f"dark_feature_position_drift:{dark_drift}>{max_feature_drift}")
    if orange_drift > max_feature_drift:
        issues.append(f"orange_feature_position_drift:{orange_drift}>{max_feature_drift}")

    return {
        "preset": preset,
        "max_feature_drift": max_feature_drift,
        "passes": not issues,
        "issues": issues,
        "retry_hints": retry_hints_for_issues(issues, preset, context="sheet"),
        "dark_feature_counts": dark_counts,
        "orange_feature_pixels": orange_counts,
        "dark_feature_position_drift": dark_drift,
        "orange_feature_position_drift": orange_drift,
        "frames": frame_metrics,
    }


def extract_palette(image: Image.Image, max_colors: int = 24) -> tuple[RGB, ...]:
    if max_colors <= 0:
        raise ValueError("max colors must be positive")

    rgba = image.convert("RGBA")
    pixels = rgba.load()
    counts: Counter[RGB] = Counter()
    first_seen: dict[RGB, int] = {}
    order = 0
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            color = (r, g, b)
            if color not in first_seen:
                first_seen[color] = order
                order += 1
            counts[color] += 1

    ranked = sorted(counts, key=lambda color: (-counts[color], first_seen[color], color))
    return tuple(ranked[:max_colors])


def extract_full_palette(image: Image.Image) -> tuple[RGB, ...]:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    colors: set[RGB] = set()
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = pixels[x, y]
            if a:
                colors.add((r, g, b))
    return tuple(sorted(colors, key=lambda color: (color_luma(color), color)))


def color_luma(color: RGB) -> float:
    return color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722


def color_chroma(color: RGB) -> int:
    return max(color) - min(color)


def is_rare_palette_worthy(color: RGB) -> bool:
    luma = color_luma(color)
    chroma = color_chroma(color)
    if chroma >= 80 and 45 <= luma <= 230:
        return True
    if chroma <= 34 and luma >= 92:
        return True
    return False


def extract_palette_rare_preserving(image: Image.Image, max_colors: int = 24) -> tuple[RGB, ...]:
    if max_colors <= 0:
        raise ValueError("max colors must be positive")
    rgba = image.convert("RGBA")
    counts: Counter[RGB] = Counter()
    order: dict[RGB, int] = {}
    pixels = rgba.load()
    index = 0
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            color = (r, g, b)
            if color not in order:
                order[color] = index
                index += 1
            counts[color] += 1
    if not counts:
        return ()

    total = sum(counts.values())
    selected: list[RGB] = []

    rare_candidates = sorted(
        (color for color in counts if is_rare_palette_worthy(color)),
        key=lambda color: (
            -min(1.0, (color_chroma(color) / 255.0) + (color_luma(color) / 255.0) * 0.35),
            counts[color],
            order[color],
            color,
        ),
    )
    rare_slots = min(max_colors // 3, len(rare_candidates))
    for color in rare_candidates[:rare_slots]:
        if color not in selected:
            selected.append(color)

    frequent = sorted(counts, key=lambda color: (-counts[color], order[color], color))
    for color in frequent:
        if color not in selected:
            selected.append(color)
        if len(selected) >= max_colors:
            break

    if len(selected) < max_colors:
        tonal = sorted(
            counts,
            key=lambda color: (
                abs((counts[color] / total) - (1.0 / max_colors)),
                color_luma(color),
                order[color],
            ),
        )
        for color in tonal:
            if color not in selected:
                selected.append(color)
            if len(selected) >= max_colors:
                break
    return tuple(selected[:max_colors])


def extract_palette_for_lock(image: Image.Image, max_colors: int = 96) -> tuple[RGB, ...]:
    if max_colors <= 0:
        raise ValueError("max colors must be positive")
    full_palette = extract_full_palette(image)
    if len(full_palette) <= max_colors:
        return full_palette
    return extract_palette_rare_preserving(image, max_colors)


BAYER_4X4 = (
    (0, 8, 2, 10),
    (12, 4, 14, 6),
    (3, 11, 1, 9),
    (15, 7, 13, 5),
)


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge0 == edge1:
        return 1.0 if value >= edge1 else 0.0
    x = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return x * x * (3.0 - 2.0 * x)


def build_edge_mask_values(image: Image.Image, mode: str = "sobel") -> list[list[float]]:
    if mode not in {"sobel", "laplacian", "high-pass", "contour", "none"}:
        raise ValueError("edge mask mode must be sobel, laplacian, high-pass, contour, or none")
    gray = image.convert("L")
    if mode == "none":
        return [[0.0 for _x in range(gray.width)] for _y in range(gray.height)]
    if mode == "contour":
        edge = gray.filter(ImageFilter.CONTOUR)
    elif mode == "high-pass":
        blur = gray.filter(ImageFilter.GaussianBlur(radius=1.2))
        edge = Image.new("L", gray.size)
        gp = gray.load()
        bp = blur.load()
        ep = edge.load()
        for y in range(gray.height):
            for x in range(gray.width):
                ep[x, y] = min(255, abs(gp[x, y] - bp[x, y]) * 3)
    else:
        src = gray.load()
        edge = Image.new("L", gray.size)
        dst = edge.load()
        for y in range(gray.height):
            for x in range(gray.width):
                def at(dx: int, dy: int) -> int:
                    return src[min(gray.width - 1, max(0, x + dx)), min(gray.height - 1, max(0, y + dy))]

                if mode == "laplacian":
                    value = abs(4 * at(0, 0) - at(-1, 0) - at(1, 0) - at(0, -1) - at(0, 1))
                else:
                    gx = -at(-1, -1) - 2 * at(-1, 0) - at(-1, 1) + at(1, -1) + 2 * at(1, 0) + at(1, 1)
                    gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1)
                    value = int((gx * gx + gy * gy) ** 0.5)
                dst[x, y] = min(255, value)
    pix = edge.load()
    return [[pix[x, y] / 255.0 for x in range(edge.width)] for y in range(edge.height)]


def local_luma_range_rgb(pixels, width: int, height: int, x: int, y: int) -> float:
    values: list[float] = []
    for yy in range(max(0, y - 1), min(height, y + 2)):
        for xx in range(max(0, x - 1), min(width, x + 2)):
            color = pixels[xx, yy]
            values.append(color_luma((color[0], color[1], color[2])))
    return max(values) - min(values) if values else 0.0


def apply_ordered_dither_rgba(
    image: Image.Image,
    palette: tuple[RGB, ...],
    *,
    strength: float = 14.0,
    scope: str = "adaptive",
    edge_mask_mode: str = "sobel",
    edge_threshold: float = 0.28,
    luma_range_threshold: float = 45.0,
    error_threshold: float = 3.0,
) -> Image.Image:
    if not palette:
        return image
    if scope not in {"global", "adaptive"}:
        raise ValueError("dither scope must be global or adaptive")
    rgba = image.convert("RGBA")
    rgb = rgba.convert("RGB")
    source = rgba.load()
    rgb_pixels = rgb.load()
    edges = build_edge_mask_values(rgb, edge_mask_mode)
    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    target = out.load()
    cache: dict[RGB, RGB] = {}
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = source[x, y]
            if a == 0:
                continue
            scale = 1.0
            if scope == "adaptive":
                edge_factor = 1.0 - smoothstep(edge_threshold * 0.5, edge_threshold, edges[y][x])
                detail = local_luma_range_rgb(rgb_pixels, rgba.width, rgba.height, x, y)
                detail_factor = 1.0 - smoothstep(luma_range_threshold * 0.65, luma_range_threshold, detail)
                nearest = cache.get((r, g, b))
                if nearest is None:
                    nearest = nearest_palette_color((r, g, b), palette)
                    cache[(r, g, b)] = nearest
                error = color_distance((r, g, b), nearest)
                error_factor = smoothstep(error_threshold * error_threshold, (error_threshold * 2.0) ** 2, error)
                scale = max(0.0, min(1.0, edge_factor * detail_factor * error_factor))
            threshold = ((BAYER_4X4[y % 4][x % 4] + 0.5) / 16.0 - 0.5) * strength * scale
            shifted = (
                clamp_channel(r + threshold),
                clamp_channel(g + threshold),
                clamp_channel(b + threshold),
            )
            target[x, y] = (*nearest_palette_color(shifted, palette), a)
    return out


def apply_floyd_steinberg_dither_rgba(image: Image.Image, palette: tuple[RGB, ...]) -> Image.Image:
    if not palette:
        return image
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    work = [
        [[float(channel) for channel in rgba.getpixel((x, y))[:3]] for x in range(rgba.width)]
        for y in range(rgba.height)
    ]
    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    target = out.load()
    alpha_pixels = alpha.load()

    def add_error(x: int, y: int, error: tuple[float, float, float], weight: float) -> None:
        if x < 0 or x >= rgba.width or y < 0 or y >= rgba.height or alpha_pixels[x, y] == 0:
            return
        work[y][x][0] = min(255.0, max(0.0, work[y][x][0] + error[0] * weight))
        work[y][x][1] = min(255.0, max(0.0, work[y][x][1] + error[1] * weight))
        work[y][x][2] = min(255.0, max(0.0, work[y][x][2] + error[2] * weight))

    for y in range(rgba.height):
        for x in range(rgba.width):
            a = alpha_pixels[x, y]
            if a == 0:
                continue
            old = (clamp_channel(work[y][x][0]), clamp_channel(work[y][x][1]), clamp_channel(work[y][x][2]))
            new = nearest_palette_color(old, palette)
            target[x, y] = (*new, a)
            error = (float(old[0] - new[0]), float(old[1] - new[1]), float(old[2] - new[2]))
            add_error(x + 1, y, error, 7.0 / 16.0)
            add_error(x - 1, y + 1, error, 3.0 / 16.0)
            add_error(x, y + 1, error, 5.0 / 16.0)
            add_error(x + 1, y + 1, error, 1.0 / 16.0)
    return out


def apply_dither_rgba(
    image: Image.Image,
    palette: tuple[RGB, ...],
    *,
    mode: str,
    strength: float,
    scope: str,
    edge_mask_mode: str,
    edge_threshold: float,
    luma_range_threshold: float,
    error_threshold: float,
) -> Image.Image:
    if mode == "none":
        return image
    if mode == "ordered":
        return apply_ordered_dither_rgba(
            image,
            palette,
            strength=strength,
            scope=scope,
            edge_mask_mode=edge_mask_mode,
            edge_threshold=edge_threshold,
            luma_range_threshold=luma_range_threshold,
            error_threshold=error_threshold,
        )
    if mode == "floyd":
        return apply_floyd_steinberg_dither_rgba(image, palette)
    raise ValueError("dither must be none, ordered, or floyd")


def palette_role(color: RGB, share: float) -> str:
    luma = color_luma(color)
    chroma = color_chroma(color)
    if luma <= 70:
        return "outline"
    if chroma >= 105 and share <= 0.35 and 85 <= luma <= 190:
        return "accent"
    if luma <= 125:
        return "shadow"
    if luma >= 214:
        return "highlight"
    return "midtone"


def palette_ramp_diagnostics(image: Image.Image, preset: str = "generic") -> dict[str, object]:
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")

    rgba = image.convert("RGBA")
    pixels = rgba.load()
    counts: Counter[RGB] = Counter()
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = pixels[x, y]
            if a > 0:
                counts[(r, g, b)] += 1

    total = sum(counts.values())
    roles: dict[str, dict[str, object]] = {
        role: {"pixels": 0, "colors": 0, "share": 0.0, "palette": []}
        for role in ("outline", "shadow", "midtone", "highlight", "accent")
    }
    if total == 0:
        return {"passes": False, "issues": ["palette_empty"], "roles": roles, "total_pixels": 0, "total_colors": 0}

    for color, count in counts.items():
        role = palette_role(color, count / total)
        role_payload = roles[role]
        role_payload["pixels"] = int(role_payload["pixels"]) + count
        role_payload["colors"] = int(role_payload["colors"]) + 1
        role_payload["palette"].append(rgb_to_hex(color))  # type: ignore[union-attr]

    for payload in roles.values():
        payload["share"] = round(int(payload["pixels"]) / total, 3)
        payload["palette"] = sorted(payload["palette"])  # type: ignore[arg-type]

    required = {
        "fighter": ("outline", "shadow", "midtone", "highlight", "accent"),
        "portrait": ("outline", "shadow", "midtone", "highlight", "accent"),
        "item": ("outline", "shadow", "midtone", "highlight"),
        "tile": ("shadow", "midtone", "highlight"),
        "generic": (),
    }[preset]
    issues: list[str] = []
    for role in required:
        if int(roles[role]["pixels"]) == 0:
            issues.append(f"missing_{role}")

    if preset in {"fighter", "portrait", "item"} and float(roles["outline"]["share"]) > 0.45:
        issues.append(f"outline_overuse:{roles['outline']['share']}")
    if float(roles["highlight"]["share"]) > 0.45 and preset != "tile":
        issues.append(f"highlight_overuse:{roles['highlight']['share']}")

    return {
        "passes": not issues,
        "issues": issues,
        "roles": roles,
        "total_pixels": total,
        "total_colors": len(counts),
    }


def preset_targets(preset: str) -> tuple[int, int, float]:
    if preset == "fighter":
        return 850, 1900, 0.46
    if preset == "portrait":
        return 1200, 2800, 0.62
    if preset == "item":
        return 180, 950, 0.42
    if preset == "tile":
        return 2600, 4096, 0.92
    return 600, 1800, 0.46


def preset_color_targets(preset: str) -> tuple[int, int]:
    if preset == "fighter":
        return 8, 32
    if preset == "portrait":
        return 9, 40
    if preset == "item":
        return 5, 24
    if preset == "tile":
        return 6, 48
    return 7, 32


def edge_alpha_pixels(image: Image.Image) -> int:
    if image.mode != "RGBA":
        return 0

    pixels = image.load()
    total = 0
    for x in range(image.width):
        if pixels[x, 0][3] > 0:
            total += 1
        if image.height > 1 and pixels[x, image.height - 1][3] > 0:
            total += 1
    for y in range(1, max(1, image.height - 1)):
        if pixels[0, y][3] > 0:
            total += 1
        if image.width > 1 and pixels[image.width - 1, y][3] > 0:
            total += 1
    return total


def assess_quality(
    *,
    preset: str,
    alpha_pixels: int,
    visible_colors: int,
    bbox_area: int,
    fill_ratio: float,
    edge_pixels: int,
) -> tuple[list[str], float]:
    min_alpha, max_alpha, ideal_fill = preset_targets(preset)
    min_colors, max_colors = preset_color_targets(preset)
    issues: list[str] = []
    penalty = 0.0

    if alpha_pixels == 0:
        return ["empty_sprite"], 10000.0
    if alpha_pixels < min_alpha:
        issues.append(f"too_small:{alpha_pixels}<{min_alpha}")
    if alpha_pixels > max_alpha:
        issues.append(f"too_large:{alpha_pixels}>{max_alpha}")
    if visible_colors < min_colors:
        issues.append(f"too_few_colors:{visible_colors}<{min_colors}")
        penalty += (min_colors - visible_colors) * 35
    if visible_colors > max_colors:
        issues.append(f"too_many_colors:{visible_colors}>{max_colors}")
        penalty += (visible_colors - max_colors) * 4
    if bbox_area and fill_ratio < max(0.08, ideal_fill * 0.45):
        issues.append(f"sparse_bbox:{fill_ratio:.2f}")
        penalty += 80
    if bbox_area and fill_ratio > min(0.96, ideal_fill * 1.65):
        issues.append(f"overfilled_bbox:{fill_ratio:.2f}")
        penalty += 55
    if preset in {"fighter", "portrait", "item"} and edge_pixels > 0:
        issues.append(f"touches_edge:{edge_pixels}")
        penalty += min(120, edge_pixels * 8)

    return issues, penalty


def retry_hints_for_issues(issues: list[str], preset: str = "generic", context: str = "sprite") -> list[str]:
    hints: list[str] = []

    def add(text: str) -> None:
        if text not in hints:
            hints.append(text)

    for issue in issues:
        if issue.startswith("empty_sprite"):
            add("Regenerate the asset with a clearly visible centered subject on the removable background.")
        elif issue.startswith("too_small"):
            add("Ask imagegen to make the subject larger, filling more of the safe area while keeping padding.")
        elif issue.startswith("too_large") or issue.startswith("touches_edge"):
            add("Ask imagegen to shrink the subject slightly and keep all parts inside the cell safe area.")
        elif issue.startswith("too_few_colors"):
            add("Ask for a richer but still limited palette with distinct outline, shadow, midtone, highlight, and accent colors.")
        elif issue.startswith("too_many_colors"):
            add("Ask for flatter color clusters, fewer shades, and no painterly texture or antialiasing.")
        elif issue.startswith("missing_outline"):
            add("Ask for a deliberate dark outline or darkest silhouette pixels around the sprite.")
        elif issue.startswith("missing_shadow"):
            add("Ask for a clear shadow ramp color that separates the form from the midtone.")
        elif issue.startswith("missing_midtone"):
            add("Ask for a stable midtone/base color for the main material instead of only extreme dark and light pixels.")
        elif issue.startswith("missing_highlight"):
            add("Ask for a small readable highlight ramp color on the lit side of the asset.")
        elif issue.startswith("missing_accent"):
            add("Ask for one intentional accent color for identity-critical details such as beak, eyes, weapon, trim, or item liquid.")
        elif issue.startswith("outline_overuse"):
            add("Ask for less black/dark coverage and more readable interior color ramps.")
        elif issue.startswith("highlight_overuse"):
            add("Ask for fewer bright pixels and more midtone/shadow structure.")
        elif issue.startswith("sparse_bbox"):
            add("Ask for a stronger continuous silhouette with fewer detached islands or thin stray marks.")
        elif issue.startswith("overfilled_bbox"):
            add("Ask for clearer negative space inside the silhouette and fewer filled-in interior regions.")
        elif "lost_eyes" in issue:
            add("Ask imagegen to keep readable dark eye pixels in every character frame, using compact 1-4 pixel clusters.")
        elif "missing_beak" in issue:
            add("Ask imagegen to keep the orange beak/mouth shape readable and inside the head safe area.")
        elif "dark_feature_count_drift" in issue:
            add("Regenerate the sheet with the same eye count and expression readability in every frame.")
        elif "orange_feature_count_drift" in issue:
            add("Regenerate the sheet with the beak/mouth present and similarly sized in every frame.")
        elif "dark_feature_position_drift" in issue:
            add("Ask for the eyes to stay anchored to the same head position across frames.")
        elif "orange_feature_position_drift" in issue:
            add("Ask for the beak/mouth to stay anchored to the same head position across frames.")
        elif "body_shrink" in issue:
            add("Regenerate that action as body-only and keep the same body height as idle/run; move wide FX to a separate sheet.")
        elif "anchor_drift" in issue:
            add("Ask imagegen to keep the feet/bottom anchor line fixed across frames.")
        elif "edge" in issue:
            add("Ask for more magenta padding and no part crossing or touching a cell edge.")

    if context == "sheet" and any("frame_" in issue for issue in issues):
        add("Generate one coherent action family only; do not mix poses, scales, or expressions from different actions.")
    if preset in {"fighter", "portrait"} and any("lost_eyes" in issue or "dark_feature" in issue for issue in issues):
        add("Mention that facial features are gameplay-critical and must remain visible at the final pixel size.")
    return hints


def score_sprite(image: Image.Image, path: str = "", preset: str = "generic") -> SpriteScore:
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")

    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    alpha_pixels = sum(1 for value in alpha.tobytes() if value > 0)
    bbox = alpha_bbox(rgba)
    bbox_area = 0 if bbox is None else (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    components = opaque_components(rgba)
    small_opaque = sum(1 for component in components if len(component) < 4)
    small_color = sum(1 for component in color_components(rgba) if len(component) < 3)
    dark_specks = count_dark_specks(rgba)
    visible_colors = count_visible_colors(rgba)
    feature_diagnostics = sprite_feature_diagnostics(rgba, preset)
    dark_feature_components = int(feature_diagnostics["dark_feature_components"])
    orange_feature_pixels = int(feature_diagnostics["orange_feature_pixels"])
    palette_ramp = palette_ramp_diagnostics(rgba, preset)

    fill_ratio = alpha_pixels / bbox_area if bbox_area else 0.0
    min_alpha, max_alpha, ideal_fill = preset_targets(preset)
    quality_issues, quality_penalty = assess_quality(
        preset=preset,
        alpha_pixels=alpha_pixels,
        visible_colors=visible_colors,
        bbox_area=bbox_area,
        fill_ratio=fill_ratio,
        edge_pixels=edge_alpha_pixels(rgba),
    )
    feature_issues = list(feature_diagnostics["issues"])
    if feature_issues != ["empty_sprite"]:
        quality_issues.extend(feature_issues)
        quality_penalty += len(feature_issues) * 120
    ramp_issues = list(palette_ramp["issues"])
    if ramp_issues != ["palette_empty"]:
        quality_issues.extend(ramp_issues)
        quality_penalty += len(ramp_issues) * 45
    fill_penalty = abs(fill_ratio - ideal_fill) * 80
    if alpha_pixels < min_alpha:
        size_penalty = (min_alpha - alpha_pixels) * 3
    elif alpha_pixels > max_alpha:
        size_penalty = (alpha_pixels - max_alpha) / 8
    else:
        size_penalty = 0
    score = (
        small_opaque * 20
        + max(0, len(components) - 1) * 30
        + small_color * 2.0
        + dark_specks * 12
        + fill_penalty
        + size_penalty
        + quality_penalty
    )

    return SpriteScore(
        path=path,
        score=round(score, 3),
        alpha_pixels=alpha_pixels,
        bbox_area=bbox_area,
        visible_colors=visible_colors,
        fill_ratio=round(fill_ratio, 3),
        opaque_components=len(components),
        small_opaque_components=small_opaque,
        small_color_components=small_color,
        dark_specks=dark_specks,
        dark_feature_components=dark_feature_components,
        orange_feature_pixels=orange_feature_pixels,
        palette_ramp=palette_ramp,
        quality_issues=quality_issues,
        retry_hints=retry_hints_for_issues(quality_issues, preset, context="sprite"),
        preset=preset,
    )


def save_rank_contact_sheet(scored: list[tuple[SpriteScore, Path]], output_path: Path, scale: int) -> None:
    if not scored:
        return

    tile = 64 * scale
    label_height = 44
    gap = 16
    width = len(scored) * tile + (len(scored) + 1) * gap
    height = tile + label_height + gap * 2
    sheet = Image.new("RGBA", (width, height), (30, 32, 36, 255))
    draw = ImageDraw.Draw(sheet)
    for index, (score, path) in enumerate(scored):
        x = gap + index * (tile + gap)
        y = gap
        sprite = Image.open(path).convert("RGBA").resize((tile, tile), Image.Resampling.NEAREST)
        sheet.alpha_composite(sprite, (x, y))
        label = f"#{index + 1} score {score.score}"
        draw.text((x, y + tile + 6), label, fill=(235, 238, 242, 255))
        draw.text((x, y + tile + 22), f"clr{score.visible_colors} d{score.dark_specks} c{score.small_color_components}", fill=(180, 186, 196, 255))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def rank_sprite_candidates(input_paths: list[Path], output_dir: Path, options: ForgeOptions, preview_scale: int = 6) -> list[SpriteScore]:
    output_dir.mkdir(parents=True, exist_ok=True)
    cleaned: list[tuple[SpriteScore, Path]] = []

    clean_options = ForgeOptions(**{**options.__dict__, "scale": 1})
    for index, input_path in enumerate(input_paths, start=1):
        output_path = output_dir / f"candidate_{index:02d}_{input_path.stem}_64.png"
        image = forge_sprite(input_path, output_path, clean_options)
        score = score_sprite(image, str(output_path), clean_options.preset)
        cleaned.append((score, output_path))

    cleaned.sort(key=lambda item: item[0].score)
    if cleaned:
        best_image = Image.open(cleaned[0][1]).convert("RGBA")
        best_image.save(output_dir / "best_64.png")
        best_image.resize((64 * preview_scale, 64 * preview_scale), Image.Resampling.NEAREST).save(output_dir / "best_preview.png")
        write_palette_file(extract_palette(best_image, 24), output_dir / "best_palette.hex", "hex")
        save_artifact_heatmaps(
            best_image,
            output_dir / "artifact_heatmaps",
            chroma_key=clean_options.chroma_key,
            chroma_tolerance=clean_options.chroma_tolerance,
            grid_key=clean_options.grid_key,
            grid_tolerance=clean_options.grid_tolerance,
            dark_threshold=clean_options.dark_threshold,
        )
        save_rank_contact_sheet(cleaned, output_dir / "rank_contact_sheet.png", preview_scale)
        with (output_dir / "rank_scores.json").open("w", encoding="utf-8") as file:
            json.dump([score.__dict__ for score, _ in cleaned], file, indent=2)
        write_retry_hints_file(
            [hint for score, _ in cleaned for hint in score.retry_hints],
            output_dir / "retry-hints.txt",
        )
        maybe_write_retry_prompt_from_run(
            output_dir,
            [hint for score, _ in cleaned for hint in score.retry_hints],
            cells=clean_options.cells,
            background=rgb_to_hex(clean_options.chroma_key) if clean_options.chroma_key else "#FF00FF",
            preset=clean_options.preset,
        )

    return [score for score, _ in cleaned]


def process_single_sprite(
    input_path: Path,
    output_dir: Path,
    options: ForgeOptions,
    *,
    preview_scale: int = 6,
    prompt_file: Path | None = None,
    grid_qc: bool = True,
    reject_grid_violations: bool = False,
    content_crop_before_sampling: bool = False,
    content_crop_padding_cells: int = 1,
) -> dict[str, object]:
    if preview_scale <= 0:
        raise ValueError("preview scale must be positive")

    output_dir.mkdir(parents=True, exist_ok=True)
    raw = Image.open(input_path).convert("RGBA")
    raw_path = output_dir / "raw.png"
    raw.save(raw_path)

    clean_options = ForgeOptions(**{**options.__dict__, "scale": 1, "transparent": True})
    has_distinct_grid_key = clean_options.grid_key is not None and clean_options.grid_key != clean_options.chroma_key
    grid_fidelity = (
        control_grid_fidelity_qc(raw, clean_options)
        if grid_qc and has_distinct_grid_key
        else {"passes": True, "blocking_issues": [], "warnings": [], "issues": [], "skipped": True}
    )
    (output_dir / "grid-fidelity.json").write_text(json.dumps(grid_fidelity, indent=2), encoding="utf-8")
    grid_retry_hints = retry_hints_for_grid_fidelity(grid_fidelity)
    if grid_retry_hints:
        write_retry_hints_file(grid_retry_hints, output_dir / "retry-hints.txt")
    if reject_grid_violations and not bool(grid_fidelity.get("passes", True)):
        raise ValueError("control grid fidelity failed: " + "; ".join(str(issue) for issue in grid_fidelity.get("blocking_issues", [])))

    sampling_input_path = input_path
    content_crop_meta: dict[str, object] = {"enabled": False}
    content_crop_path: Path | None = None
    if content_crop_before_sampling:
        crop = crop_control_grid_to_content(
            raw,
            clean_options,
            padding_cells=content_crop_padding_cells,
        )
        content_crop_path = output_dir / "raw-content-crop.png"
        crop.image.save(content_crop_path)
        sampling_input_path = content_crop_path
        content_crop_meta = {
            "enabled": True,
            "path": str(content_crop_path),
            "bbox": list(crop.bbox) if crop.bbox is not None else None,
            "content_bbox": list(crop.content_bbox) if crop.content_bbox is not None else None,
            "mode": crop.mode,
            "padding_cells": content_crop_padding_cells,
            "padded_to_square": crop.padded_to_square,
            "size": [crop.image.width, crop.image.height],
        }

    cleaned_path = output_dir / f"cleaned_{clean_options.cells}.png"
    cleaned = forge_sprite(sampling_input_path, cleaned_path, clean_options)
    preview_path = output_dir / "preview.png"
    cleaned.resize((cleaned.width * preview_scale, cleaned.height * preview_scale), Image.Resampling.NEAREST).save(preview_path)

    alpha_mask_path = output_dir / "alpha_mask.png"
    save_alpha_mask(cleaned, alpha_mask_path)

    score = score_sprite(cleaned, str(cleaned_path), clean_options.preset)
    contact_sheet_path = output_dir / "contact_sheet.png"
    save_sprite_contact_sheet(
        raw=raw,
        cleaned=cleaned,
        alpha_mask_path=alpha_mask_path,
        output_path=contact_sheet_path,
        preview_scale=preview_scale,
        score=score,
    )
    heatmaps = save_artifact_heatmaps(
        cleaned,
        output_dir / "artifact_heatmaps",
        chroma_key=clean_options.chroma_key,
        chroma_tolerance=clean_options.chroma_tolerance,
        grid_key=clean_options.grid_key,
        grid_tolerance=clean_options.grid_tolerance,
        dark_threshold=clean_options.dark_threshold,
    )
    palette = extract_palette(cleaned, 24)
    write_palette_file(palette, output_dir / "palette.hex", "hex")
    combined_retry_hints = list(dict.fromkeys([*grid_retry_hints, *score.retry_hints]))
    if combined_retry_hints:
        write_retry_hints_file(combined_retry_hints, output_dir / "retry-hints.txt")

    prompt_used: str | None = None
    if prompt_file is not None:
        prompt_used = prompt_file.read_text(encoding="utf-8")
        (output_dir / "prompt-used.txt").write_text(prompt_used, encoding="utf-8")
        maybe_write_retry_prompt_from_run(
            output_dir,
            combined_retry_hints,
            cells=clean_options.cells,
            background=rgb_to_hex(clean_options.chroma_key) if clean_options.chroma_key else "#FF00FF",
            preset=clean_options.preset,
            sheet=False,
        )

    metadata: dict[str, object] = {
        "input": str(input_path),
        "files": {
            "raw": str(raw_path),
            "cleaned": str(cleaned_path),
            "preview": str(preview_path),
            "alpha_mask": str(alpha_mask_path),
            "contact_sheet": str(contact_sheet_path),
            "palette": str(output_dir / "palette.hex"),
            "raw_content_crop": str(content_crop_path) if content_crop_path else None,
        },
        "options": {
            **clean_options.__dict__,
            "chroma_key": rgb_to_hex(clean_options.chroma_key) if clean_options.chroma_key else None,
            "grid_key": rgb_to_hex(clean_options.grid_key) if clean_options.grid_key else None,
            "outline_color": rgb_to_hex(clean_options.outline_color) if clean_options.outline_color else None,
            "palette_colors": [rgb_to_hex(color) for color in clean_options.palette_colors],
        },
        "preview_scale": preview_scale,
        "score": score.__dict__,
        "features": sprite_feature_diagnostics(cleaned, clean_options.preset),
        "grid_fidelity": grid_fidelity,
        "content_crop": content_crop_meta,
        "palette_ramp": score.palette_ramp,
        "artifact_heatmaps": heatmaps,
        "palette": [rgb_to_hex(color) for color in palette],
        "prompt_used": prompt_used,
    }
    (output_dir / "pipeline-meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def reconstruct_generated_sprite(
    input_path: Path,
    output_path: Path,
    *,
    cells: int = 64,
    chroma_key: RGB = (255, 0, 255),
    chroma_tolerance: int = 128,
    pixel_size: int | None = None,
    max_pixel_size: int = 32,
    phase_mode: str = "center",
    sample_mode: str = "median",
    palette: int = 24,
    palette_colors: tuple[RGB, ...] = (),
    palette_strategy: str = "rare",
    grid_quantize_first: bool = False,
    dither: str = "none",
    dither_strength: float = 14.0,
    dither_scope: str = "adaptive",
    dither_edge_mask: str = "sobel",
    dither_edge_threshold: float = 0.28,
    dither_luma_range: float = 45.0,
    dither_error_threshold: float = 3.0,
    hidden_grid_variant_limit: int = 5,
    dark_stroke_threshold: float = 38.0,
    pad: int = 2,
    preview_scale: int = 8,
    preset: str = "item",
    candidate_radius: int = 0,
    phase_sweep: bool = False,
    selection_mode: str = "lattice",
    target_reference: Image.Image | None = None,
    cleanup: bool = False,
    min_component_size: int = 0,
    min_color_component_size: int = 0,
    dark_speck_size: int = 0,
    despeckle: int = 0,
    output_dir: Path | None = None,
) -> dict[str, object]:
    if cells <= 0:
        raise ValueError("cells must be positive")
    if pad < 0:
        raise ValueError("pad must be zero or positive")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    if candidate_radius < 0:
        raise ValueError("candidate radius must be zero or positive")
    if phase_mode not in {"center", "edge", "hidden-grid"}:
        raise ValueError("phase mode must be center, edge, or hidden-grid")
    if sample_mode not in {"median", "mode", "center", "dark-stroke"}:
        raise ValueError("sample mode must be median, mode, center, or dark-stroke")
    if palette_strategy not in {"frequent", "rare"}:
        raise ValueError("palette strategy must be frequent or rare")
    if selection_mode not in {"lattice", "style-reference"}:
        raise ValueError("selection mode must be lattice or style-reference")
    if dither not in {"none", "ordered", "floyd"}:
        raise ValueError("dither must be none, ordered, or floyd")
    if dither_scope not in {"global", "adaptive"}:
        raise ValueError("dither scope must be global or adaptive")
    if hidden_grid_variant_limit <= 0:
        raise ValueError("hidden grid variant limit must be positive")

    raw = Image.open(input_path).convert("RGBA")
    keyed = remove_keyed_background(raw, chroma_key, chroma_tolerance)
    bbox = alpha_bbox(keyed)
    if bbox is None:
        raise ValueError("no foreground found after chroma removal")
    left, top, right, bottom = bbox
    crop_box = (max(0, left - pad), max(0, top - pad), min(keyed.width, right + pad), min(keyed.height, bottom + pad))
    cropped = keyed.crop(crop_box)
    vote_cropped = quantize_rgba(cropped, palette) if grid_quantize_first and palette > 0 else cropped
    effective_dither = "none" if grid_quantize_first and dither != "none" else dither
    dither_disabled_reason = "grid_quantize_first" if effective_dither == "none" and dither != "none" else None

    inference: dict[str, object] | None = None
    inferred_phases: dict[int, tuple[int, int]] = {}
    hidden_variants: list[dict[str, float | int]] = []
    base_pixel_size = pixel_size
    max_pixel_size = max(max_pixel_size, pixel_size or 0)
    if phase_mode == "hidden-grid":
        hidden_variants = detect_hidden_grid_variants(
            cropped,
            max_output_width=max(cells * 2, cropped.width),
            max_output_height=max(cells * 2, cropped.height),
            min_output_size=max(8, cells // 4),
            max_variants=hidden_grid_variant_limit,
        )
        if not hidden_variants:
            raise ValueError("could not detect hidden mixel grid variants")
        best_variant = hidden_variants[0]
        base_pixel_size = max(2, min(max_pixel_size, int(round(float(best_variant["cellSize"])))))
        inference = {"hidden_grid_variants": hidden_variants}
    elif pixel_size is None and phase_mode == "edge":
        inference = infer_fake_pixel_lattice_from_edges(vote_cropped, cells=cells, max_pixel_size=max_pixel_size, sample_mode=sample_mode)
        best = inference["best"]  # type: ignore[index]
        base_pixel_size = int(best["pixel_size"])  # type: ignore[index]
        phase = best["phase"]  # type: ignore[index]
        inferred_phases[base_pixel_size] = (int(phase[0]), int(phase[1]))
    elif pixel_size is None:
        target_subject_pixels = max(8, int(round(cells * 0.9)))
        base_pixel_size = max(2, min(max_pixel_size, int(round(max(cropped.width, cropped.height) / target_subject_pixels))))

    assert base_pixel_size is not None
    sizes = sorted(
        {
            size
            for size in range(base_pixel_size - candidate_radius, base_pixel_size + candidate_radius + 1)
            if 2 <= size <= max_pixel_size
        }
    )
    run_dir = output_dir or output_path.with_name(f"{output_path.stem}_reconstruct_run")
    candidates_dir = run_dir / "candidates"
    candidates_dir.mkdir(parents=True, exist_ok=True)

    cleanup_options = ForgeOptions(
        cells=cells,
        transparent=True,
        chroma_key=chroma_key,
        grid_key=chroma_key,
        min_component_size=min_component_size,
        min_color_component_size=min_color_component_size,
        dark_speck_size=dark_speck_size,
        despeckle=despeckle,
        palette_colors=palette_colors,
        preset=preset,
        protect_face_details=True,
    )
    scored: list[tuple[float, SpriteScore, Path, dict[str, object], Image.Image]] = []
    candidate_index = 0
    sample_jobs: list[dict[str, object]] = []
    if phase_mode == "hidden-grid":
        for variant_index, variant in enumerate(hidden_variants, start=1):
            sample_jobs.append({"kind": "hidden-grid", "variant_index": variant_index, "variant": variant})
    else:
        x_profile = axis_edge_profile(vote_cropped, "x")
        y_profile = axis_edge_profile(vote_cropped, "y")
        for size in sizes:
            if size not in inferred_phases and phase_mode == "edge":
                phase_x, _ = infer_axis_phase_from_edges(x_profile, size)
                phase_y, _ = infer_axis_phase_from_edges(y_profile, size)
                inferred_phases[size] = (phase_x, phase_y)
            inferred_phase = inferred_phases.get(size, (size // 2, size // 2))
            phase_pairs = {inferred_phase}
            if phase_sweep:
                if target_reference is not None and size >= 12:
                    phase_pairs = target_guided_phase_pairs(vote_cropped, target_reference, size)
                else:
                    phase_pairs = {(phase_x, phase_y) for phase_x in range(size) for phase_y in range(size)}
            if candidate_radius > 0:
                half = size // 2
                phase_pairs.update({(0, 0), (half, half), (half, 0), (0, half)})
            for phase_x, phase_y in sorted(phase_pairs):
                sample_jobs.append({"kind": "lattice", "size": size, "phase_x": phase_x, "phase_y": phase_y})

    for sample_job in sample_jobs:
        try:
            if sample_job["kind"] == "hidden-grid":
                variant = sample_job["variant"]  # type: ignore[assignment]
                low, lattice_meta = sample_hidden_grid(
                    vote_cropped,
                    variant,  # type: ignore[arg-type]
                    sample_mode=sample_mode,
                    dark_threshold=dark_stroke_threshold,
                )
                size = max(2, int(round(float(variant["cellSize"]))))  # type: ignore[index]
                phase_x = int(round(float(variant.get("originX", 0))))  # type: ignore[union-attr]
                phase_y = int(round(float(variant.get("originY", 0))))  # type: ignore[union-attr]
            else:
                size = int(sample_job["size"])
                phase_x = int(sample_job["phase_x"])
                phase_y = int(sample_job["phase_y"])
                low, lattice_meta = sample_lattice(
                    vote_cropped,
                    size,
                    phase_x=phase_x,
                    phase_y=phase_y,
                    sample_mode=sample_mode,
                    dark_threshold=dark_stroke_threshold,
                )
        except ValueError:
            continue
        low = trim_alpha_image(low)
        raw_low = low.copy()
        output_palette: tuple[RGB, ...] = palette_colors
        if not output_palette and palette > 0:
            output_palette = (
                extract_palette_rare_preserving(low, palette)
                if palette_strategy == "rare"
                else extract_palette(low, palette)
            )
        if effective_dither != "none" and output_palette:
            low = apply_dither_rgba(
                low,
                output_palette,
                mode=effective_dither,
                strength=dither_strength,
                scope=dither_scope,
                edge_mask_mode=dither_edge_mask,
                edge_threshold=dither_edge_threshold,
                luma_range_threshold=dither_luma_range,
                error_threshold=dither_error_threshold,
            )
        elif palette > 0 and not grid_quantize_first:
            low = quantize_rgba(low, palette)
        low = apply_palette_lock(low, palette_colors)
        if low.width > cells or low.height > cells:
            scale = min(cells / low.width, cells / low.height)
            low = low.resize((max(1, int(round(low.width * scale))), max(1, int(round(low.height * scale)))), Image.Resampling.NEAREST)
        out = Image.new("RGBA", (cells, cells), (0, 0, 0, 0))
        paste = ((cells - low.width) // 2, (cells - low.height) // 2)
        out.alpha_composite(low, paste)
        if cleanup:
            out = postprocess_rgba(out, cleanup_options)
        candidate_index += 1
        candidate_path = candidates_dir / f"candidate_{candidate_index:02d}_ps{size}_px{phase_x}_py{phase_y}.png"
        raw_candidate_path = candidates_dir / f"candidate_{candidate_index:02d}_raw_grid-fit.png"
        raw_low.save(raw_candidate_path)
        out.save(candidate_path)
        score = score_sprite(out, str(candidate_path), preset)
        reconstruction_score = float(lattice_meta["mean_block_deviation"])
        lattice_detection_score = 0.0
        if sample_job["kind"] == "hidden-grid":
            variant_for_score = sample_job["variant"]  # type: ignore[index]
            lattice_detection_score = float(variant_for_score.get("score", 0.0))  # type: ignore[union-attr]
        style_selection_metrics: dict[str, object] | None = None
        if selection_mode == "style-reference":
            selection_score, style_selection_metrics = style_reference_selection_score(
                out,
                preset=preset,
                reconstruction_score=reconstruction_score,
                lattice_detection_score=lattice_detection_score,
                phase_mode=phase_mode,
                pixel_size=size,
                phase=(phase_x, phase_y),
                low_size=(low.width, low.height),
                target_reference=target_reference,
            )
        else:
            selection_score = -lattice_detection_score if phase_mode == "hidden-grid" else reconstruction_score
        candidate_meta = {
            "path": str(candidate_path),
            "raw_grid_fit": str(raw_candidate_path),
            "pixel_size": size,
            "phase": [phase_x, phase_y],
            "lattice": lattice_meta,
            "sample_job": sample_job,
            "low_size": [low.width, low.height],
            "paste_position": list(paste),
            "cleanup": cleanup,
            "palette_strategy": palette_strategy,
            "grid_quantize_first": grid_quantize_first,
            "dither": effective_dither,
            "dither_requested": dither,
            "dither_disabled_reason": dither_disabled_reason,
            "edge_mask": dither_edge_mask if effective_dither == "ordered" else None,
            "reconstruction_score": round(reconstruction_score, 3),
            "lattice_detection_score": round(lattice_detection_score, 4),
            "selection_score": round(selection_score, 4),
            "selection_mode": selection_mode,
            "style_reference_selection": style_selection_metrics,
            "score": score.__dict__,
        }
        scored.append((selection_score, score, candidate_path, candidate_meta, out))
    if not scored:
        raise ValueError("no reconstruction candidates were produced")

    scored.sort(key=lambda item: item[0])
    _, best_score, best_path, best_candidate_meta, best_image = scored[0]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    best_image.save(output_path)
    preview_path = None
    if preview_scale > 0:
        preview_path = output_path.with_name(f"{output_path.stem}_preview.png")
        best_image.resize((cells * preview_scale, cells * preview_scale), Image.Resampling.NEAREST).save(preview_path)

    alpha_mask_path = run_dir / "alpha_mask.png"
    save_alpha_mask(best_image, alpha_mask_path)
    save_sprite_contact_sheet(
        raw=raw,
        cleaned=best_image,
        alpha_mask_path=alpha_mask_path,
        output_path=run_dir / "contact_sheet.png",
        preview_scale=max(1, preview_scale),
        score=best_score,
    )
    save_rank_contact_sheet([(score, path) for _, score, path, _, _ in scored], run_dir / "candidate_contact_sheet.png", max(1, preview_scale))
    heatmaps = save_artifact_heatmaps(
        best_image,
        run_dir / "artifact_heatmaps",
        chroma_key=chroma_key,
        chroma_tolerance=chroma_tolerance,
        grid_key=chroma_key,
        grid_tolerance=48,
    )
    extracted_palette = extract_palette(best_image, 32)
    write_palette_file(extracted_palette, run_dir / "palette.hex", "hex")
    if best_score.retry_hints:
        write_retry_hints_file(best_score.retry_hints, run_dir / "retry-hints.txt")

    inference = {
        "base_pixel_size": base_pixel_size,
        "candidate_sizes": sizes,
        "hidden_grid_variants": hidden_variants,
        "candidate_count": len(scored),
        "mode": "pure_grid_recovery" if not cleanup else "grid_recovery_with_cleanup",
        "phase_mode": phase_mode,
    }

    meta = {
        "input": str(input_path),
        "output": str(output_path),
        "preview": str(preview_path) if preview_path else None,
        "run_dir": str(run_dir),
        "cells": cells,
        "chroma_key": rgb_to_hex(chroma_key),
        "chroma_tolerance": chroma_tolerance,
        "source_bbox": list(crop_box),
        "pixel_size": best_candidate_meta["pixel_size"],
        "phase": best_candidate_meta["phase"],
        "lattice": best_candidate_meta["lattice"],
        "inference": inference,
        "low_size": best_candidate_meta["low_size"],
        "paste_position": best_candidate_meta["paste_position"],
        "palette": palette,
        "palette_strategy": palette_strategy,
        "grid_quantize_first": grid_quantize_first,
        "dither": effective_dither,
        "dither_requested": dither,
        "dither_disabled_reason": dither_disabled_reason,
        "dither_settings": {
            "strength": dither_strength,
            "scope": dither_scope,
            "edge_mask": dither_edge_mask,
            "edge_threshold": dither_edge_threshold,
            "luma_range": dither_luma_range,
            "error_threshold": dither_error_threshold,
        },
        "dark_stroke_threshold": dark_stroke_threshold,
        "phase_sweep": phase_sweep,
        "selection_mode": selection_mode,
        "cleanup": cleanup,
        "palette_file": str(run_dir / "palette.hex"),
        "artifact_heatmaps": heatmaps,
        "best_candidate": best_candidate_meta,
        "candidates": [candidate_meta for _, _, _, candidate_meta, _ in scored],
        "score": best_score.__dict__,
    }
    (run_dir / "pipeline-meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    output_path.with_name(f"{output_path.stem}-reconstruct-meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def fit_sprite_to_canvas(sprite: Image.Image, cells: int) -> Image.Image:
    source = sprite.convert("RGBA")
    bbox = alpha_bbox(source)
    if bbox is None:
        return Image.new("RGBA", (cells, cells), (0, 0, 0, 0))
    cropped = source.crop(bbox)
    scale = min(cells / cropped.width, cells / cropped.height)
    target_size = (
        max(1, min(cells, int(round(cropped.width * scale)))),
        max(1, min(cells, int(round(cropped.height * scale)))),
    )
    fitted = cropped.resize(target_size, Image.Resampling.NEAREST)
    out = Image.new("RGBA", (cells, cells), (0, 0, 0, 0))
    out.alpha_composite(fitted, ((cells - fitted.width) // 2, (cells - fitted.height) // 2))
    return out


def infer_style_reference_pixel_sizes(source: Image.Image, cells: int, preset: str) -> list[int]:
    bbox = alpha_bbox(source.convert("RGBA"))
    if bbox is None:
        return []
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    if width <= 0 or height <= 0:
        return []

    target_height_share = 0.88 if preset in {"fighter", "portrait"} else 0.62
    target_width_share = 0.62 if preset in {"fighter", "portrait"} else 0.50
    height_size = height / max(1.0, cells * target_height_share)
    width_size = width / max(1.0, cells * target_width_share)
    base = int(round(max(2.0, min(height_size, width_size) if width_size > 0 else height_size)))

    sizes: set[int] = set()
    for offset in (-2, -1, 0, 1, 2):
        size = base + offset
        if 3 <= size <= 14:
            sizes.add(size)
    for ratio in (0.78, 0.86, 0.94):
        size = int(round(height / max(1.0, cells * ratio)))
        if 3 <= size <= 14:
            sizes.add(size)
    return sorted(sizes)


def infer_style_reference_pixel_sizes_from_target(source: Image.Image, target: Image.Image) -> list[int]:
    source_bbox = alpha_bbox(source.convert("RGBA"))
    target_bbox = alpha_bbox(target.convert("RGBA"))
    if source_bbox is None or target_bbox is None:
        return []
    source_width = source_bbox[2] - source_bbox[0]
    source_height = source_bbox[3] - source_bbox[1]
    target_width = target_bbox[2] - target_bbox[0]
    target_height = target_bbox[3] - target_bbox[1]
    if min(source_width, source_height, target_width, target_height) <= 0:
        return []

    width_size = source_width / target_width
    height_size = source_height / target_height
    base = int(round((width_size + height_size) / 2))
    sizes: set[int] = set()
    for value in (width_size, height_size, base):
        rounded = int(round(value))
        for offset in (-1, 0, 1):
            size = rounded + offset
            if 2 <= size <= 96:
                sizes.add(size)
    return sorted(sizes)


def prepare_style_reference_target(input_path: Path, output_path: Path, cells: int, edge_tolerance: int) -> Image.Image:
    image = Image.open(input_path).convert("RGBA")
    stripped = strip_edge_background(
        image,
        ForgeOptions(
            cells=max(image.width, image.height),
            transparent=True,
            strip_edge_background=True,
            strip_edge_tolerance=edge_tolerance,
        ),
    )
    if stripped.size != (cells, cells):
        stripped = fit_sprite_to_canvas(stripped, cells)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    stripped.save(output_path)
    return stripped


def prepare_style_reference_source(input_path: Path, output_path: Path, edge_tolerance: int) -> Image.Image:
    image = Image.open(input_path).convert("RGBA")
    stripped = strip_edge_background(
        image,
        ForgeOptions(
            cells=max(image.width, image.height),
            transparent=True,
            strip_edge_background=True,
            strip_edge_tolerance=edge_tolerance,
        ),
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    stripped.save(output_path)
    return stripped


def fallback_style_reference_reconstruct(source: Image.Image, output_path: Path, cells: int, palette: int, preset: str) -> dict[str, object]:
    fitted = fit_sprite_to_canvas(source, cells)
    if palette > 0:
        fitted = quantize_rgba(fitted, palette)
    options = ForgeOptions(
        cells=cells,
        transparent=True,
        min_component_size=2,
        min_color_component_size=2,
        dark_speck_size=1,
        despeckle=1,
        preset=preset,
        protect_face_details=True,
    )
    fitted = postprocess_rgba(fitted, options)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fitted.save(output_path)
    score = score_sprite(fitted, str(output_path), preset)
    return {
        "output": str(output_path),
        "method": "fallback_fit_canvas",
        "score": score.__dict__,
    }


def build_style_reference_sheet(
    input_paths: list[Path],
    output_dir: Path,
    *,
    cells: int = 32,
    palette: int = 14,
    sample_mode: str = "center",
    pixel_size: int | None = None,
    target_ref: Path | None = None,
    phase_sweep: bool = False,
    preview_scale: int = 10,
    preset: str = "fighter",
    edge_tolerance: int = 18,
    artifact_clean: bool = True,
    artifact_palette: int = 18,
    artifact_merge_tolerance: int = 28,
    artifact_island_size: int = 2,
) -> dict[str, object]:
    if not input_paths:
        raise ValueError("at least one input screenshot is required")
    if cells <= 0 or palette < 0 or preview_scale <= 0:
        raise ValueError("cells and preview scale must be positive, palette must be non-negative")
    if pixel_size is not None and pixel_size < 2:
        raise ValueError("pixel size must be at least 2")
    if sample_mode not in {"center", "mode", "median", "dark-stroke"}:
        raise ValueError("sample mode must be center, mode, median, or dark-stroke")
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")

    output_dir.mkdir(parents=True, exist_ok=True)
    sources_dir = output_dir / "sources"
    refs_dir = output_dir / "refs"
    refs_dir.mkdir(parents=True, exist_ok=True)

    refs: list[Image.Image] = []
    ref_meta: list[dict[str, object]] = []
    target_reference: Image.Image | None = None
    target_reference_path: Path | None = None
    if target_ref is not None:
        target_reference_path = output_dir / "target-reference.png"
        target_reference = prepare_style_reference_target(target_ref, target_reference_path, cells, edge_tolerance)
    for index, input_path in enumerate(input_paths, start=1):
        source_path = sources_dir / f"source_{index:02d}{input_path.suffix.lower() or '.png'}"
        prepared = prepare_style_reference_source(input_path, source_path, edge_tolerance)
        ref_path = refs_dir / f"ref_{index:02d}_{cells}.png"
        run_dir = refs_dir / f"ref_{index:02d}_reconstruct"

        if pixel_size is not None:
            configs = [{"phase_mode": "center", "sample_mode": sample_mode, "pixel_size": pixel_size, "phase_sweep": phase_sweep}]
            for mode in ("center", "mode", "median", "dark-stroke"):
                if mode != sample_mode:
                    configs.append({"phase_mode": "center", "sample_mode": mode, "pixel_size": pixel_size, "phase_sweep": phase_sweep})
        else:
            configs = []
            inferred_sizes = []
            if target_reference is not None:
                inferred_sizes.extend(infer_style_reference_pixel_sizes_from_target(prepared, target_reference))
            inferred_sizes.extend(infer_style_reference_pixel_sizes(prepared, cells, preset))
            for inferred_size in sorted(set(inferred_sizes)):
                modes = [sample_mode]
                if target_reference is not None:
                    modes.extend(mode for mode in ("mode", "median", "center") if mode not in modes)
                for mode in modes:
                    configs.append({"phase_mode": "center", "sample_mode": mode, "pixel_size": inferred_size, "phase_sweep": True})
            configs.append({"phase_mode": "hidden-grid", "sample_mode": sample_mode, "pixel_size": None, "phase_sweep": False})
            for mode in ("center", "mode", "median", "dark-stroke"):
                if mode != sample_mode:
                    configs.append({"phase_mode": "hidden-grid", "sample_mode": mode, "pixel_size": None, "phase_sweep": False})
            configs.append({"phase_mode": "edge", "sample_mode": "median", "pixel_size": None, "phase_sweep": False})
        meta: dict[str, object] | None = None
        last_error: str | None = None
        attempts: list[dict[str, object]] = []
        best_attempt_score: float | None = None
        for config_index, config in enumerate(configs, start=1):
            config_ref_path = ref_path.with_name(f"{ref_path.stem}_attempt_{config_index:02d}.png")
            config_run_dir = run_dir / f"attempt_{config_index:02d}"
            try:
                attempt_meta = reconstruct_generated_sprite(
                    source_path,
                    config_ref_path,
                    cells=cells,
                    chroma_key=(255, 0, 255),
                    chroma_tolerance=1,
                    pixel_size=config["pixel_size"],  # type: ignore[arg-type]
                    max_pixel_size=96,
                    phase_mode=str(config["phase_mode"]),
                    sample_mode=str(config["sample_mode"]),
                    palette=palette,
                    palette_strategy="rare",
                    cleanup=True,
                    min_component_size=2,
                    min_color_component_size=2,
                    dark_speck_size=1,
                    despeckle=1,
                    output_dir=config_run_dir,
                    preview_scale=preview_scale,
                    preset=preset,
                    candidate_radius=0 if pixel_size is not None else 1,
                    phase_sweep=bool(config["phase_sweep"]),
                    selection_mode="style-reference",
                    target_reference=target_reference,
                )
                attempt_meta["method"] = f"reconstruct:{config['phase_mode']}:{config['sample_mode']}"
                best_candidate = attempt_meta.get("best_candidate", {})
                attempt_score = float(best_candidate.get("selection_score", 999999.0)) if isinstance(best_candidate, dict) else 999999.0
                attempts.append(
                    {
                        "config": config,
                        "score": round(attempt_score, 4),
                        "output": str(config_ref_path),
                        "run_dir": str(config_run_dir),
                        "best_candidate": best_candidate,
                    }
                )
                if best_attempt_score is None or attempt_score < best_attempt_score:
                    best_attempt_score = attempt_score
                    meta = attempt_meta
                    shutil.copyfile(config_ref_path, ref_path)
            except Exception as exc:  # keep trying safer reconstruction modes
                last_error = str(exc)

        if meta is None:
            meta = fallback_style_reference_reconstruct(prepared, ref_path, cells, palette, preset)
            meta["reconstruct_error"] = last_error
        else:
            meta["attempts"] = attempts
            meta["attempt_count"] = len(attempts)

        pre_artifact_ref_path: Path | None = None
        artifact_palette_colors: tuple[RGB, ...] = ()
        if artifact_clean:
            pre_artifact_ref_path = ref_path.with_name(f"{ref_path.stem}_pre_artifact_clean.png")
            shutil.copyfile(ref_path, pre_artifact_ref_path)
            cleaned_ref, artifact_palette_colors = style_reference_artifact_cleanup(
                Image.open(ref_path),
                palette=artifact_palette,
                merge_tolerance=artifact_merge_tolerance,
                island_size=artifact_island_size,
                preset=preset,
            )
            cleaned_ref.save(ref_path)

        ref_image = Image.open(ref_path).convert("RGBA")
        refs.append(ref_image)
        ref_meta.append(
            {
                "input": str(input_path),
                "prepared_source": str(source_path),
                "ref": str(ref_path),
                "pre_artifact_clean_ref": str(pre_artifact_ref_path) if pre_artifact_ref_path else None,
                "target_reference": str(target_reference_path) if target_reference_path else None,
                "bbox": list(alpha_bbox(ref_image) or ()),
                "colors": len(extract_palette(ref_image, 256)),
                "artifact_clean": {
                    "enabled": artifact_clean,
                    "palette": artifact_palette,
                    "merge_tolerance": artifact_merge_tolerance,
                    "island_size": artifact_island_size,
                    "colors": [rgb_to_hex(color) for color in artifact_palette_colors],
                },
                "meta": meta,
            }
        )

    tile = cells * preview_scale
    gap = max(2, preview_scale)
    sheet_width = len(refs) * tile + max(0, len(refs) - 1) * gap
    sheet = Image.new("RGBA", (sheet_width, tile), (0, 0, 0, 0))
    for index, ref in enumerate(refs):
        preview = ref.resize((tile, tile), Image.Resampling.NEAREST)
        panel = checkerboard((tile, tile), max(4, preview_scale))
        panel.alpha_composite(preview, (0, 0))
        sheet.alpha_composite(panel, (index * (tile + gap), 0))

    sheet_path = output_dir / "style-reference-sheet.png"
    sheet.save(sheet_path)
    metadata = {
        "type": "sprite_forge_style_reference_sheet",
        "sheet": str(sheet_path),
        "cells": cells,
        "palette": palette,
        "sample_mode": sample_mode,
        "pixel_size": pixel_size,
        "target_ref": str(target_ref) if target_ref else None,
        "prepared_target_ref": str(target_reference_path) if target_reference_path else None,
        "phase_sweep": phase_sweep,
        "preview_scale": preview_scale,
        "artifact_clean": {
            "enabled": artifact_clean,
            "palette": artifact_palette,
            "merge_tolerance": artifact_merge_tolerance,
            "island_size": artifact_island_size,
        },
        "refs": ref_meta,
        "usage": "Attach this sheet as a style reference only; attach the clean control-grid separately as the edit target.",
    }
    (output_dir / "style-reference-meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def clean_style_reference_artifacts(
    input_path: Path,
    output_path: Path,
    *,
    palette: int = 18,
    merge_tolerance: int = 28,
    island_size: int = 2,
    preview_scale: int = 10,
    preset: str = "fighter",
) -> dict[str, object]:
    if preview_scale < 0:
        raise ValueError("preview scale must be zero or positive")

    source = Image.open(input_path).convert("RGBA")
    cleaned, locked_palette = style_reference_artifact_cleanup(
        source,
        palette=palette,
        merge_tolerance=merge_tolerance,
        island_size=island_size,
        preset=preset,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cleaned.save(output_path)

    preview_path: Path | None = None
    if preview_scale > 0:
        preview_path = output_path.with_name(f"{output_path.stem}_preview.png")
        cleaned.resize((cleaned.width * preview_scale, cleaned.height * preview_scale), Image.Resampling.NEAREST).save(preview_path)

    palette_path = output_path.with_name(f"{output_path.stem}_palette.hex")
    write_palette_file(locked_palette or extract_palette(cleaned, min(32, max(1, count_visible_colors(cleaned)))), palette_path, "hex")
    meta = {
        "type": "sprite_forge_style_reference_artifact_clean",
        "input": str(input_path),
        "output": str(output_path),
        "preview": str(preview_path) if preview_path else None,
        "palette_file": str(palette_path),
        "size": [cleaned.width, cleaned.height],
        "settings": {
            "palette": palette,
            "merge_tolerance": merge_tolerance,
            "island_size": island_size,
            "preview_scale": preview_scale,
            "preset": preset,
        },
        "palette_colors": [rgb_to_hex(color) for color in locked_palette],
    }
    output_path.with_name(f"{output_path.stem}-artifact-clean-meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def forge_sprite(input_path: Path, output_path: Path, options: ForgeOptions) -> Image.Image:
    _validate_options(options)

    src = Image.open(input_path).convert("RGB")
    if options.square_crop == "center":
        src = center_square_crop(src)
    if options.prequantize_palette:
        src = quantize_rgb(src, options.prequantize_palette)

    width, height = src.size
    if width != height:
        raise ValueError(f"expected a square image, got {width}x{height}")

    cell_size = width / options.cells
    margin = max(0, int(cell_size * options.sample_margin_ratio))
    source_pixels = src.load()

    background = options.chroma_key if options.chroma_key is not None else estimate_border_background(src)

    mode = "RGBA" if options.transparent else "RGB"
    pixel_map = Image.new(mode, (options.cells, options.cells), (0, 0, 0, 0) if options.transparent else (0, 0, 0))
    output_pixels = pixel_map.load()

    for gy in range(options.cells):
        y0 = int(round(gy * cell_size))
        y1 = int(round((gy + 1) * cell_size))
        sample_y0 = min(max(y0 + margin, 0), height - 1)
        sample_y1 = min(max(y1 - margin, sample_y0 + 1), height)

        for gx in range(options.cells):
            x0 = int(round(gx * cell_size))
            x1 = int(round((gx + 1) * cell_size))
            sample_x0 = min(max(x0 + margin, 0), width - 1)
            sample_x1 = min(max(x1 - margin, sample_x0 + 1), width)

            samples: list[RGB] = []
            bg_like = 0
            total = 0

            for y in range(sample_y0, sample_y1):
                for x in range(sample_x0, sample_x1):
                    pixel = source_pixels[x, y]
                    if options.grid_key is not None and is_grid_like(pixel, options.grid_key, options.grid_tolerance):
                        continue
                    total += 1
                    if options.chroma_key is not None and is_chroma_like(pixel, options.chroma_key, options.chroma_tolerance):
                        bg_like += 1
                    elif color_distance(pixel, background) <= options.background_tolerance:
                        bg_like += 1
                    # Ignore near-black grid remnants inside the sampled area.
                    if sum(pixel) > 60:
                        samples.append(pixel)

            if not samples:
                cx = min(width - 1, int(round((gx + 0.5) * cell_size)))
                cy = min(height - 1, int(round((gy + 0.5) * cell_size)))
                fallback = source_pixels[cx, cy]
                if options.grid_key is not None and is_grid_like(fallback, options.grid_key, options.grid_tolerance):
                    samples.append(background)
                else:
                    samples.append(fallback)

            color = sample_color(samples, options.sample_mode)
            is_background_cell = total and bg_like / total >= 0.72
            is_background_color = color_distance(color, background) <= options.background_tolerance * 2
            is_chroma_color = options.chroma_key is not None and is_chroma_like(color, options.chroma_key, options.chroma_tolerance)

            if options.transparent and (is_background_cell or is_background_color or is_chroma_color):
                output_pixels[gx, gy] = (0, 0, 0, 0)
            elif options.transparent:
                output_pixels[gx, gy] = (color[0], color[1], color[2], 255)
            else:
                output_pixels[gx, gy] = color

    if options.transparent:
        pixel_map = quantize_rgba(pixel_map, options.palette)
        pixel_map = postprocess_rgba(pixel_map, options)
        pixel_map = apply_palette_lock(pixel_map, options.palette_colors)
    else:
        pixel_map = quantize_rgb(pixel_map, options.palette)
        pixel_map = apply_palette_lock(pixel_map, options.palette_colors)

    if options.scale != 1:
        resample = getattr(Image.Resampling, "NEAREST", Image.NEAREST)
        pixel_map = pixel_map.resize((options.cells * options.scale, options.cells * options.scale), resample=resample)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    pixel_map.save(output_path)
    return pixel_map


def preset_prompt_guidance(preset: str) -> str:
    if preset == "fighter":
        return "Asset preset: fighter sprite. Full body visible, action pose, strong silhouette, readable eyes/weapon/hands, good padding for animation, not a tiny icon."
    if preset == "item":
        return "Asset preset: item icon. Single object, centered, compact, clean silhouette, readable at small size, no character body."
    if preset == "portrait":
        return "Asset preset: portrait/bust. Large head and shoulders, expressive face, readable eyes, centered composition."
    if preset == "tile":
        return "Asset preset: tile. Fill the square, seamless-looking game tile, no transparent empty margins unless requested."
    return "Asset preset: generic game sprite. Clean silhouette, readable shape, centered composition."


def preset_quality_guidance(preset: str) -> str:
    min_colors, max_colors = preset_color_targets(preset)
    min_alpha, max_alpha, ideal_fill = preset_targets(preset)
    return (
        f"Quality target: roughly {min_colors}-{max_colors} visible colors, "
        f"{min_alpha}-{max_alpha} visible sprite cells after cleanup, "
        f"about {int(ideal_fill * 100)}% fill inside the subject bounding box. "
        "Use deliberate pixel clusters, outer silhouette, shadow side, highlight side, and at least one internal feature cluster that identifies the subject. "
        "Every visible cell should be intentional; do not make a smaller sprite and upscale it into repeated blocks."
    )


def build_imagegen_prompt(subject: str, cells: int, background: str, mode: str, preset: str = "generic") -> str:
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")
    preset_line = preset_prompt_guidance(preset)
    quality_line = preset_quality_guidance(preset)

    if mode == "reference":
        return f"""Edit the provided control-grid image.
Keep the exact canvas size, exact {cells} by {cells} grid geometry, exact grid line positions, and exact removable background color {background}.
Redraw only the subject as clean game-ready pixel art: {subject}
{preset_line}
{quality_line}
The character must be readable at {cells}x{cells}, centered, with a strong silhouette and no unnecessary tiny details.
Every visible sprite area must snap to the existing square cells as flat color blocks. Use a small intentional palette, crisp edges, and clear clusters.
Remove all non-character background, reference-card remnants, lighting effects, motion streaks, text, UI, shadows, glow, blur, antialiasing, soft gradients, painterly texture, and subpixel edges.
Do not invent a new grid. Do not move or resize the grid. Do not draw outside the sprite except for the {background} background.
"""

    if mode == "scratch":
        return f"""Create a clean game-ready pixel art sprite.
Subject: {subject}
{preset_line}
{quality_line}
Canvas: one centered sprite on a flat solid {background} background for later removal.
Target result after cleanup: true {cells}x{cells} pixel art with strong readable silhouette, orthographic/front three-quarter game asset, generous padding, and no crop.
Use big deliberate pixel clusters, limited palette, crisp hard edges, and readable facial/features at {cells}x{cells}.
Avoid tiny random specks, noisy texture, excessive internal black marks, antialiasing, blur, soft gradients, painterly texture, text, UI, watermark, drop shadow, glow, and background objects.
If a visible grid is used, it must be an exact {cells} by {cells} square grid with color regions aligned to cells.
"""

    raise ValueError("prompt mode must be 'reference' or 'scratch'")


def retry_guardrails(cells: int, background: str, preset: str, sheet: bool = False) -> list[str]:
    guardrails = [
        f"Keep the exact {cells} by {cells} final pixel-grid target.",
        f"Use a flat solid removable background color {background}; do not use that color inside the subject.",
        "Use hard-edged flat color clusters only: no blur, glow, antialiasing, soft gradients, painterly texture, text, UI, watermark, or drop shadow.",
        "Keep the subject centered with safe padding; no visible part may touch or cross the cell edge.",
        "Keep a readable silhouette, deliberate outline/shadow/midtone/highlight/accent colors, and no random isolated specks.",
    ]
    if preset in {"fighter", "portrait"}:
        guardrails.append("Keep facial details readable at final pixel size: eyes, mouth, beak, or expression marks must remain compact and intentional.")
    if sheet:
        guardrails.extend(
            [
                "Generate one coherent action family only, with the same identity, palette, pixel scale, and bounding box in every frame.",
                "Keep feet/bottom anchor and head/face feature positions stable across frames.",
                "Do not include borders, labels, frame numbers, UI, or cell divider lines in the artwork.",
            ]
        )
    return guardrails


def build_retry_prompt(
    original_prompt: str,
    retry_hints: list[str],
    *,
    cells: int = 64,
    background: str = "#FF00FF",
    preset: str = "generic",
    sheet: bool = False,
) -> str:
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of: {', '.join(sorted(PRESETS))}")

    unique_hints = list(dict.fromkeys(hint.strip() for hint in retry_hints if hint.strip()))
    hints_block = "\n".join(f"- {hint}" for hint in unique_hints) if unique_hints else "- No specific QC failure was provided; improve cleanliness and preserve the original intent."
    guardrails_block = "\n".join(f"- {guardrail}" for guardrail in retry_guardrails(cells, background, preset, sheet))
    preset_block = f"{preset_prompt_guidance(preset)}\n{preset_quality_guidance(preset)}"
    return f"""Retry this imagegen attempt using the same subject and identity as the original request.

Original request/prompt:
{original_prompt.strip()}

QC retry fixes to apply:
{hints_block}

Hard generation guardrails:
{guardrails_block}

Preset guidance:
{preset_block}

Return a cleaner candidate for the same asset. Preserve the intended pose/action unless a retry fix explicitly asks for scale, padding, anchor, or feature stability changes.
"""


def write_retry_prompt(
    output_path: Path,
    original_prompt: str,
    retry_hints: list[str],
    *,
    cells: int = 64,
    background: str = "#FF00FF",
    preset: str = "generic",
    sheet: bool = False,
) -> str:
    prompt = build_retry_prompt(original_prompt, retry_hints, cells=cells, background=background, preset=preset, sheet=sheet)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(prompt, encoding="utf-8")
    return prompt


def maybe_write_retry_prompt_from_run(
    run_dir: Path,
    retry_hints: list[str],
    *,
    cells: int = 64,
    background: str = "#FF00FF",
    preset: str = "generic",
    sheet: bool = False,
) -> None:
    prompt_path = run_dir / "prompt-used.txt"
    if not prompt_path.exists() or not retry_hints:
        return
    write_retry_prompt(
        run_dir / "retry-prompt.txt",
        prompt_path.read_text(encoding="utf-8"),
        retry_hints,
        cells=cells,
        background=background,
        preset=preset,
        sheet=sheet,
    )


def write_imagegen_prompt(path: Path, subject: str, cells: int, background: str, mode: str, preset: str) -> None:
    prompt = build_imagegen_prompt(subject, cells, background, mode, preset)
    path.write_text(prompt, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Turn grid-guided AI pixel art into a real pixel sprite.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    clean = subparsers.add_parser("clean", help="Clean a generated grid image into a true pixel sprite")
    clean.add_argument("input", help="Input generated image")
    clean.add_argument("output", help="Output PNG path")
    clean.add_argument("--cells", type=int, default=64, help="Number of grid cells per side")
    clean.add_argument("--scale", type=int, default=1, help="Nearest-neighbor upscale factor")
    clean.add_argument("--sample-margin-ratio", type=float, default=0.28, help="How much of each cell edge to ignore")
    clean.add_argument("--palette", type=int, default=0, help="Limit output to this many colors; 0 disables quantization")
    clean.add_argument("--transparent", action="store_true", help="Turn corner-like background cells into alpha")
    clean.add_argument("--background-tolerance", type=int, default=36, help="Manhattan RGB tolerance for background alpha")
    clean.add_argument("--square-crop", choices=["center", "none"], default="center", help="How to handle non-square inputs")
    clean.add_argument("--sample-mode", choices=["median", "mode"], default="median", help="How to choose each output pixel color")
    clean.add_argument("--prequantize-palette", type=int, default=0, help="Quantize the source before cell sampling; useful with mode sampling")
    clean.add_argument("--chroma-key", help="Force this color to transparent, e.g. #00ff00")
    clean.add_argument("--chroma-tolerance", type=int, default=64, help="RGB tolerance for chroma-key transparency")
    clean.add_argument("--grid-key", help="Ignore this service grid color during cell sampling, e.g. #ff00ff")
    clean.add_argument("--grid-tolerance", type=int, default=48, help="RGB tolerance for service grid removal")
    clean.add_argument("--min-component-size", type=int, default=0, help="Remove transparent-sprite islands smaller than this many pixels")
    clean.add_argument("--keep-largest-component", action="store_true", help="Keep only the largest opaque connected component")
    clean.add_argument("--center-alpha", action="store_true", help="Center the opaque sprite inside the output canvas")
    clean.add_argument("--trim-alpha", action="store_true", help="Crop the output canvas to the opaque sprite bounds")
    clean.add_argument("--outline-color", help="Add a 1-pixel outline around the transparent sprite, e.g. #2b1807")
    clean.add_argument("--despeckle", type=int, default=0, help="Replace isolated pixels with the local dominant neighbor color")
    clean.add_argument("--min-color-component-size", type=int, default=0, help="Replace tiny same-color islands inside the sprite")
    clean.add_argument("--dark-speck-size", type=int, default=0, help="Replace tiny dark islands enclosed by brighter sprite colors")
    clean.add_argument("--dark-threshold", type=int, default=80, help="RGB channel-sum threshold used by --dark-speck-size")
    clean.add_argument("--strip-edge-background", action=argparse.BooleanOptionalAction, default=False, help="Flood-fill removable background remnants connected to the output edge")
    clean.add_argument("--strip-edge-tolerance", type=int, default=54, help="RGB tolerance for edge-connected background stripping")
    clean.add_argument("--palette-file", help="Lock output colors to a .hex, .gpl, .pal, or .json palette file")
    clean.add_argument("--preset", choices=sorted(PRESETS), default="generic", help="Asset preset used by protected cleanup details")
    clean.add_argument("--protect-face-details", action=argparse.BooleanOptionalAction, default=True, help="Protect likely eyes, mouth, and beak pixels from cleanup passes")

    rank = subparsers.add_parser("rank", help="Clean and rank several generated candidates")
    rank.add_argument("output_dir", help="Directory for cleaned candidates, best output, scores, and contact sheet")
    rank.add_argument("inputs", nargs="+", help="Input generated images to rank")
    rank.add_argument("--cells", type=int, default=64, help="Number of grid cells per side")
    rank.add_argument("--sample-margin-ratio", type=float, default=0.40, help="How much of each cell edge to ignore")
    rank.add_argument("--palette", type=int, default=24, help="Limit output to this many colors; 0 disables quantization")
    rank.add_argument("--transparent", action="store_true", default=True, help="Turn background cells into alpha")
    rank.add_argument("--background-tolerance", type=int, default=36, help="Manhattan RGB tolerance for background alpha")
    rank.add_argument("--square-crop", choices=["center", "none"], default="center", help="How to handle non-square inputs")
    rank.add_argument("--sample-mode", choices=["median", "mode"], default="median", help="How to choose each output pixel color")
    rank.add_argument("--prequantize-palette", type=int, default=0, help="Quantize the source before cell sampling")
    rank.add_argument("--chroma-key", default="#00ff00", help="Force this color to transparent")
    rank.add_argument("--chroma-tolerance", type=int, default=64, help="RGB tolerance for chroma-key transparency")
    rank.add_argument("--grid-key", default="#ff00ff", help="Ignore this service grid color during cell sampling")
    rank.add_argument("--grid-tolerance", type=int, default=48, help="RGB tolerance for service grid removal")
    rank.add_argument("--min-component-size", type=int, default=4, help="Remove transparent-sprite islands smaller than this many pixels")
    rank.add_argument("--keep-largest-component", action="store_true", help="Keep only the largest opaque connected component")
    rank.add_argument("--center-alpha", action="store_true", default=True, help="Center the opaque sprite inside the output canvas")
    rank.add_argument("--trim-alpha", action="store_true", help="Crop the output canvas to the opaque sprite bounds")
    rank.add_argument("--outline-color", help="Add a 1-pixel outline around the transparent sprite")
    rank.add_argument("--despeckle", type=int, default=0, help="Replace isolated pixels with the local dominant neighbor color")
    rank.add_argument("--min-color-component-size", type=int, default=0, help="Replace tiny same-color islands inside the sprite")
    rank.add_argument("--dark-speck-size", type=int, default=0, help="Replace tiny dark islands enclosed by brighter sprite colors")
    rank.add_argument("--dark-threshold", type=int, default=80, help="RGB channel-sum threshold used by --dark-speck-size")
    rank.add_argument("--strip-edge-background", action=argparse.BooleanOptionalAction, default=True, help="Flood-fill removable background remnants connected to the output edge")
    rank.add_argument("--strip-edge-tolerance", type=int, default=54, help="RGB tolerance for edge-connected background stripping")
    rank.add_argument("--palette-file", help="Lock output colors to a .hex, .gpl, .pal, or .json palette file")
    rank.add_argument("--preview-scale", type=int, default=6, help="Nearest-neighbor scale for best preview and contact sheet")
    rank.add_argument("--preset", choices=sorted(PRESETS), default="fighter", help="Asset preset used by ranking metrics")
    rank.add_argument("--protect-face-details", action=argparse.BooleanOptionalAction, default=True, help="Protect likely eyes, mouth, and beak pixels from cleanup passes")

    single = subparsers.add_parser("process-sprite", help="Create a full single-sprite production run folder")
    single.add_argument("input", help="Input generated image")
    single.add_argument("output_dir", help="Output run directory")
    single.add_argument("--prompt-file", help="Optional prompt-used.txt to copy into the run folder")
    single.add_argument("--cells", type=int, default=64, help="Number of grid cells per side")
    single.add_argument("--sample-margin-ratio", type=float, default=0.40, help="How much of each cell edge to ignore")
    single.add_argument("--palette", type=int, default=24, help="Limit output to this many colors; 0 disables quantization")
    single.add_argument("--background-tolerance", type=int, default=36, help="Manhattan RGB tolerance for background alpha")
    single.add_argument("--square-crop", choices=["center", "none"], default="center", help="How to handle non-square inputs")
    single.add_argument("--sample-mode", choices=["median", "mode"], default="median", help="How to choose each output pixel color")
    single.add_argument("--prequantize-palette", type=int, default=0, help="Quantize the source before cell sampling")
    single.add_argument("--chroma-key", default="#ff00ff", help="Force this color to transparent")
    single.add_argument("--chroma-tolerance", type=int, default=64, help="RGB tolerance for chroma-key transparency")
    single.add_argument("--grid-key", default="#ff00ff", help="Ignore this service grid color during cell sampling")
    single.add_argument("--grid-tolerance", type=int, default=48, help="RGB tolerance for service grid removal")
    single.add_argument("--min-component-size", type=int, default=4, help="Remove transparent-sprite islands smaller than this many pixels")
    single.add_argument("--keep-largest-component", action="store_true", help="Keep only the largest opaque connected component")
    single.add_argument("--center-alpha", action="store_true", default=True, help="Center the opaque sprite inside the output canvas")
    single.add_argument("--trim-alpha", action="store_true", help="Crop the output canvas to the opaque sprite bounds")
    single.add_argument("--outline-color", help="Add a 1-pixel outline around the transparent sprite")
    single.add_argument("--despeckle", type=int, default=0, help="Replace isolated pixels with the local dominant neighbor color")
    single.add_argument("--min-color-component-size", type=int, default=0, help="Replace tiny same-color islands inside the sprite")
    single.add_argument("--dark-speck-size", type=int, default=0, help="Replace tiny dark islands enclosed by brighter sprite colors")
    single.add_argument("--dark-threshold", type=int, default=80, help="RGB channel-sum threshold used by --dark-speck-size")
    single.add_argument("--strip-edge-background", action=argparse.BooleanOptionalAction, default=True, help="Flood-fill removable background remnants connected to the output edge")
    single.add_argument("--strip-edge-tolerance", type=int, default=54, help="RGB tolerance for edge-connected background stripping")
    single.add_argument("--palette-file", help="Lock output colors to a .hex, .gpl, .pal, or .json palette file")
    single.add_argument("--preview-scale", type=int, default=6, help="Nearest-neighbor scale for preview and contact sheet")
    single.add_argument("--preset", choices=sorted(PRESETS), default="fighter", help="Asset preset used by diagnostics")
    single.add_argument("--protect-face-details", action=argparse.BooleanOptionalAction, default=True, help="Protect likely eyes, mouth, and beak pixels from cleanup passes")
    single.add_argument("--grid-qc", action=argparse.BooleanOptionalAction, default=True, help="Check raw control-grid fidelity before cleanup")
    single.add_argument("--reject-grid-violations", action="store_true", help="Fail before cleanup when raw control-grid fidelity has blocking issues")
    single.add_argument("--content-crop-before-sampling", action="store_true", help="Crop generated control-grid raw to the character/content bbox before cell sampling")
    single.add_argument("--content-crop-padding-cells", type=int, default=1, help="Whole grid cells of padding around detected content for --content-crop-before-sampling")

    reconstruct = subparsers.add_parser("reconstruct-sprite", help="Recover true low-res pixel art from fake generated pixel art")
    reconstruct.add_argument("input", help="Input fake/generated pixel-art image")
    reconstruct.add_argument("output", help="Output true pixel PNG path")
    reconstruct.add_argument("--cells", type=int, default=64, help="Output canvas size in pixels")
    reconstruct.add_argument("--chroma-key", default="#ff00ff", help="Solid background color to remove")
    reconstruct.add_argument("--chroma-tolerance", type=int, default=128, help="RGB tolerance for background removal")
    reconstruct.add_argument("--pixel-size", type=int, help="Known fake pixel block size; omit to infer")
    reconstruct.add_argument("--max-pixel-size", type=int, default=32, help="Largest fake pixel block size to consider")
    reconstruct.add_argument("--phase-mode", choices=["center", "edge", "hidden-grid"], default="center", help="Use block centers by default, edge-profile phase detection, or hidden-grid mixel variants")
    reconstruct.add_argument("--sample-mode", choices=["median", "mode", "center", "dark-stroke"], default="median", help="How to choose each reconstructed pixel")
    reconstruct.add_argument("--palette", type=int, default=24, help="Limit output to this many colors; 0 disables quantization")
    reconstruct.add_argument("--palette-file", help="Lock output colors to a .hex, .gpl, .pal, or .json palette file")
    reconstruct.add_argument("--palette-strategy", choices=["frequent", "rare"], default="rare", help="Palette extraction strategy for quantize/dither")
    reconstruct.add_argument("--grid-quantize-first", action="store_true", help="Quantize source crop before grid voting; disables dithering")
    reconstruct.add_argument("--dither", choices=["none", "ordered", "floyd"], default="none", help="Palette dither after grid transfer")
    reconstruct.add_argument("--dither-strength", type=float, default=14.0, help="Ordered dither channel offset strength")
    reconstruct.add_argument("--dither-scope", choices=["global", "adaptive"], default="adaptive", help="Ordered dither placement")
    reconstruct.add_argument("--dither-edge-mask", choices=["sobel", "laplacian", "high-pass", "contour", "none"], default="sobel", help="Edge mask used by adaptive ordered dither")
    reconstruct.add_argument("--dither-edge-threshold", type=float, default=0.28, help="Adaptive dither maximum edge-mask value")
    reconstruct.add_argument("--dither-luma-range", type=float, default=45.0, help="Adaptive dither maximum local luma range")
    reconstruct.add_argument("--dither-error-threshold", type=float, default=3.0, help="Adaptive dither minimum palette mapping error")
    reconstruct.add_argument("--hidden-grid-variant-limit", type=int, default=5, help="Maximum hidden-grid variants to try")
    reconstruct.add_argument("--dark-stroke-threshold", type=float, default=38.0, help="Minimum luma contrast for dark-stroke cell voting")
    reconstruct.add_argument("--pad", type=int, default=2, help="Source pixels of bbox padding before lattice inference")
    reconstruct.add_argument("--preview-scale", type=int, default=8, help="Write a nearest-neighbor preview at this scale; 0 disables")
    reconstruct.add_argument("--preset", choices=sorted(PRESETS), default="item", help="Asset preset used by reconstruction scoring")
    reconstruct.add_argument("--candidate-radius", type=int, default=0, help="Try pixel sizes around the inferred fake-pixel size")
    reconstruct.add_argument("--phase-sweep", action="store_true", help="Try every phase for the selected/inferred pixel size")
    reconstruct.add_argument("--selection-mode", choices=["lattice", "style-reference"], default="lattice", help="Candidate ranking mode")
    reconstruct.add_argument("--cleanup", action="store_true", help="Apply conservative Forge cleanup after pure grid recovery")
    reconstruct.add_argument("--min-component-size", type=int, default=0, help="With --cleanup, remove opaque islands smaller than this many pixels")
    reconstruct.add_argument("--min-color-component-size", type=int, default=0, help="With --cleanup, replace tiny same-color islands inside the sprite")
    reconstruct.add_argument("--dark-speck-size", type=int, default=0, help="With --cleanup, replace tiny dark islands enclosed by brighter sprite colors")
    reconstruct.add_argument("--despeckle", type=int, default=0, help="Replace isolated pixels with local dominant color")
    reconstruct.add_argument("--output-dir", help="Optional reconstruction run folder for candidates, heatmaps, and metadata")

    style_ref = subparsers.add_parser("style-reference-sheet", help="Clean screenshot style refs into a real-pixel style sheet")
    style_ref.add_argument("output_dir", help="Output folder for refs, sheet, and metadata")
    style_ref.add_argument("inputs", nargs="+", help="Style screenshot/image inputs to clean")
    style_ref.add_argument("--cells", type=int, default=32, help="True pixel canvas size per reference")
    style_ref.add_argument("--palette", type=int, default=14, help="Limit each cleaned reference to this many colors; 0 disables")
    style_ref.add_argument("--sample-mode", choices=["center", "mode", "median", "dark-stroke"], default="center", help="How to sample detected original pixel cells")
    style_ref.add_argument("--pixel-size", type=int, help="Known screenshot pixels per real source pixel; use this when auto-detection picks an over-detailed grid")
    style_ref.add_argument("--target-ref", help="Optional hand-cleaned target reference used to rank reconstruction candidates")
    style_ref.add_argument("--phase-sweep", action="store_true", help="With --pixel-size, try every phase so thin source pixels do not split into two cells")
    style_ref.add_argument("--preview-scale", type=int, default=10, help="Nearest-neighbor scale for the assembled style sheet")
    style_ref.add_argument("--preset", choices=sorted(PRESETS), default="fighter", help="Preset used by reconstruction scoring")
    style_ref.add_argument("--edge-tolerance", type=int, default=18, help="Tolerance for stripping edge-connected screenshot background")
    style_ref.add_argument("--artifact-clean", action=argparse.BooleanOptionalAction, default=True, help="Palette-stabilize refs after grid recovery to remove screenshot/JPEG color artifacts")
    style_ref.add_argument("--artifact-palette", type=int, default=18, help="Palette size for style-ref artifact cleanup; 0 disables palette locking")
    style_ref.add_argument("--artifact-merge-tolerance", type=int, default=28, help="RGB distance used to merge near-duplicate compression colors")
    style_ref.add_argument("--artifact-island-size", type=int, default=2, help="Remove same-color islands up to this many pixels after palette locking")

    style_clean = subparsers.add_parser("clean-style-ref-artifacts", help="Remove screenshot/JPEG color artifacts from an already recovered low-res style ref")
    style_clean.add_argument("input", help="Input low-res style-ref PNG")
    style_clean.add_argument("output", help="Output cleaned style-ref PNG")
    style_clean.add_argument("--palette", type=int, default=18, help="Palette size for artifact cleanup; 0 disables palette locking")
    style_clean.add_argument("--merge-tolerance", type=int, default=28, help="RGB distance used to merge near-duplicate compression colors")
    style_clean.add_argument("--island-size", type=int, default=2, help="Remove same-color islands up to this many pixels after palette locking")
    style_clean.add_argument("--preview-scale", type=int, default=10, help="Nearest-neighbor preview scale; 0 disables")
    style_clean.add_argument("--preset", choices=sorted(PRESETS), default="fighter", help="Preset used for protected detail cleanup")

    prompt = subparsers.add_parser("prompt", help="Write an imagegen-ready prompt for a sprite")
    prompt.add_argument("subject", help="Sprite subject description")
    prompt.add_argument("output", nargs="?", default="sprite_prompt.txt", help="Output prompt text file")
    prompt.add_argument("--cells", type=int, default=64, help="Grid cells to request")
    prompt.add_argument("--background", default="#00ff00", help="Flat removable background color")
    prompt.add_argument("--mode", choices=["reference", "scratch"], default="reference", help="Prompt style for control-grid edits or generation from scratch")
    prompt.add_argument("--preset", choices=sorted(PRESETS), default="generic", help="Asset preset guidance")

    retry_prompt = subparsers.add_parser("retry-prompt", help="Build an imagegen retry prompt from an original prompt and retry hints")
    retry_prompt.add_argument("prompt_file", help="Original prompt-used.txt or request text file")
    retry_prompt.add_argument("hints_file", help="retry-hints.txt file")
    retry_prompt.add_argument("output", nargs="?", default="retry-prompt.txt", help="Output retry prompt text file")
    retry_prompt.add_argument("--cells", type=int, default=64, help="Final pixel-grid target size")
    retry_prompt.add_argument("--background", default="#FF00FF", help="Removable background color")
    retry_prompt.add_argument("--preset", choices=sorted(PRESETS), default="generic", help="Asset preset guidance")
    retry_prompt.add_argument("--sheet", action="store_true", help="Use sheet/frame consistency guardrails")

    extract = subparsers.add_parser("extract-palette", help="Extract visible colors from a sprite or sheet")
    extract.add_argument("input", help="Input image")
    extract.add_argument("output", help="Output palette path")
    extract.add_argument("--max-colors", type=int, default=24, help="Maximum colors to write")
    extract.add_argument("--format", choices=["hex", "json", "gpl"], default="hex", help="Output palette format")

    repixel = subparsers.add_parser("repixelize", help="Rebuild fake pixel art as true low-res pixel art")
    repixel.add_argument("input", help="Input fake or upscaled pixel-art image")
    repixel.add_argument("output", help="Output low-res PNG path")
    repixel.add_argument("--backend", choices=["local", "repixelizer"], default="local", help="Use Sprite Forge lattice fallback or GameCult/repixelizer phase-field backend")
    repixel.add_argument("--pixel-size", type=int, help="Known source pixel block size; omit to infer")
    repixel.add_argument("--max-pixel-size", type=int, default=32, help="Largest source pixel block size to consider during inference")
    repixel.add_argument("--phase-x", type=int, help="Known lattice x phase; omit to infer or default to 0")
    repixel.add_argument("--phase-y", type=int, help="Known lattice y phase; omit to infer or default to 0")
    repixel.add_argument("--sample-mode", choices=["median", "mode"], default="median", help="How to choose each output pixel color")
    repixel.add_argument("--palette", type=int, default=0, help="Limit output to this many colors; 0 disables quantization")
    repixel.add_argument("--transparent", action="store_true", help="Preserve alpha instead of flattening onto estimated background")
    repixel.add_argument("--chroma-key", help="Force this source color to transparent before lattice sampling")
    repixel.add_argument("--chroma-tolerance", type=int, default=64, help="RGB tolerance for chroma-key transparency")
    repixel.add_argument("--scale", type=int, default=1, help="Nearest-neighbor scale for saved output")
    repixel.add_argument("--repixelizer-path", help="Path to a GameCult/repixelizer checkout or src directory for --backend repixelizer")
    repixel.add_argument("--target-size", type=int, help="Repixelizer backend target max dimension override")
    repixel.add_argument("--target-width", type=int, help="Repixelizer backend target width override")
    repixel.add_argument("--target-height", type=int, help="Repixelizer backend target height override")
    repixel.add_argument("--palette-file", help="Repixelizer backend palette file")
    repixel.add_argument("--palette-mode", choices=["off", "fit", "strict"], default="off", help="Repixelizer backend palette mode")
    repixel.add_argument("--diagnostics-dir", help="Repixelizer backend diagnostics output directory")
    repixel.add_argument("--seed", type=int, default=7, help="Repixelizer backend random seed")
    repixel.add_argument("--steps", type=int, default=200, help="Repixelizer backend optimizer steps")
    repixel.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto", help="Repixelizer backend torch device")
    repixel.add_argument("--strip-background", action="store_true", help="Repixelizer backend edge background strip")
    repixel.add_argument("--skip-candidate-rerank", action="store_true", help="Repixelizer backend: skip low-confidence candidate rerank")

    json_sprite = subparsers.add_parser("json-sprite", help="Validate, repair, render, or prompt strict JSON pixel sprites")
    json_subparsers = json_sprite.add_subparsers(dest="json_command", required=True)
    json_validate = json_subparsers.add_parser("validate", help="Validate a JSON pixel sprite")
    json_validate.add_argument("input", help="Input JSON file or raw LLM response text")
    json_validate.add_argument("--repair", action="store_true", help="Repair missing rows/cells and invalid colors before validating")
    json_validate.add_argument("--output", help="Optional repaired/normalized JSON output path")
    json_render = json_subparsers.add_parser("render", help="Render a JSON pixel sprite to PNG")
    json_render.add_argument("input", help="Input JSON file or raw LLM response text")
    json_render.add_argument("output", help="Output PNG path")
    json_render.add_argument("--repair", action="store_true", help="Repair before rendering")
    json_render.add_argument("--scale", type=int, default=1, help="Nearest-neighbor output scale")
    json_repair = json_subparsers.add_parser("repair", help="Repair a JSON pixel sprite")
    json_repair.add_argument("input", help="Input JSON file or raw LLM response text")
    json_repair.add_argument("output", help="Output repaired JSON path")
    json_set_pixel = json_subparsers.add_parser("set-pixel", help="Set one pixel in a strict JSON sprite")
    json_set_pixel.add_argument("input", help="Input JSON sprite")
    json_set_pixel.add_argument("output", help="Output JSON sprite")
    json_set_pixel.add_argument("--x", type=int, required=True, help="Pixel x coordinate")
    json_set_pixel.add_argument("--y", type=int, required=True, help="Pixel y coordinate")
    json_set_pixel.add_argument("--color", required=True, help="New pixel color, #RRGGBB/#RRGGBBAA/#RGB or transparent")
    json_replace_color = json_subparsers.add_parser("replace-color", help="Replace one color across a strict JSON sprite")
    json_replace_color.add_argument("input", help="Input JSON sprite")
    json_replace_color.add_argument("output", help="Output JSON sprite")
    json_replace_color.add_argument("--from-color", required=True, help="Source color, #RRGGBB/#RRGGBBAA/#RGB or transparent")
    json_replace_color.add_argument("--to-color", required=True, help="Target color, #RRGGBB/#RRGGBBAA/#RGB or transparent")
    json_patch = json_subparsers.add_parser("apply-patch", help="Apply pixel edits from a patch JSON file")
    json_patch.add_argument("input", help="Input JSON sprite")
    json_patch.add_argument("patch", help="Patch JSON file with pixels/edits entries")
    json_patch.add_argument("output", help="Output JSON sprite")
    json_frames_validate = json_subparsers.add_parser("frames-validate", help="Validate a JSON frames array")
    json_frames_validate.add_argument("input", help="Input JSON file or raw LLM response text")
    json_frames_validate.add_argument("--repair", action="store_true", help="Repair each frame before validating consistency")
    json_frames_validate.add_argument("--output", help="Optional normalized frames JSON output path")
    json_frames_sheet = json_subparsers.add_parser("frames-render-sheet", help="Render JSON frames to a horizontal PNG sheet")
    json_frames_sheet.add_argument("input", help="Input JSON file or raw LLM response text")
    json_frames_sheet.add_argument("output", help="Output PNG sheet path")
    json_frames_sheet.add_argument("--repair", action="store_true", help="Repair each frame before rendering")
    json_frames_sheet.add_argument("--scale", type=int, default=1, help="Nearest-neighbor output scale")
    json_frames_gif = json_subparsers.add_parser("frames-gif", help="Render JSON frames to a transparent GIF")
    json_frames_gif.add_argument("input", help="Input JSON file or raw LLM response text")
    json_frames_gif.add_argument("output", help="Output GIF path")
    json_frames_gif.add_argument("--repair", action="store_true", help="Repair each frame before rendering")
    json_frames_gif.add_argument("--scale", type=int, default=1, help="Nearest-neighbor output scale")
    json_frames_gif.add_argument("--duration", type=int, default=120, help="Frame duration in milliseconds")
    json_prompt = json_subparsers.add_parser("prompt", help="Write a strict JSON sprite generation prompt")
    json_prompt.add_argument("subject", help="Sprite subject/request")
    json_prompt.add_argument("output", nargs="?", default="json_sprite_prompt.txt", help="Output prompt text path")
    json_prompt.add_argument("--width", type=int, default=16, help="Sprite width")
    json_prompt.add_argument("--height", type=int, default=16, help="Sprite height")
    json_prompt.add_argument("--mode", choices=["generate", "edit", "animate"], default="generate", help="Prompt mode")
    json_prompt.add_argument("--style", default="modern game sprite", help="Style guidance")

    plan = subparsers.add_parser("plan-asset", help="Infer a Sprite Forge asset plan from a natural-language request")
    plan.add_argument("prompt", help="Asset request")
    plan.add_argument("output", nargs="?", help="Optional JSON output path")

    hero = subparsers.add_parser("hero-bundle", help="Scaffold a hero action bundle run folder")
    hero.add_argument("prompt", help="Hero bundle request")
    hero.add_argument("output_dir", help="Output bundle directory")

    prod_plan = subparsers.add_parser("production-plan", help="Create a multi-worker imagegen/Codex production queue")
    prod_plan.add_argument("request", help="Asset production request")
    prod_plan.add_argument("output_dir", help="Output production run directory")
    prod_plan.add_argument("--attempts", type=int, default=3, help="Raw imagegen attempts per subasset")
    prod_plan.add_argument("--workers", type=int, default=4, help="Parallel Codex/imagegen workers for the generated dispatch script")
    prod_plan.add_argument("--mode", choices=["auto", "hero", "single"], default="auto", help="Production loop mode")
    prod_plan.add_argument("--preset", choices=sorted(PRESETS), default="fighter", help="Single-sprite preset")
    prod_plan.add_argument("--cells", type=int, default=64, help="Single-sprite final cell size")
    prod_plan.add_argument("--codex-bin", default="codex", help="Codex CLI binary used by run-codex-workers.sh")
    prod_plan.add_argument("--no-dispatch-script", action="store_true", help="Do not write run-codex-workers.sh")

    prod_ingest = subparsers.add_parser("production-ingest", help="Process raw imagegen outputs from a production run")
    prod_ingest.add_argument("run_dir", help="Production run directory created by production-plan")

    prod_retry = subparsers.add_parser("production-retry", help="Create retry imagegen jobs from production QC failures")
    prod_retry.add_argument("run_dir", help="Production run directory")
    prod_retry.add_argument("--max-retries", type=int, default=1, help="Maximum retry jobs per subasset")
    prod_retry.add_argument("--include-passed", action="store_true", help="Also create retry jobs for currently passing accepted attempts")
    prod_retry.add_argument("--codex-bin", default="codex", help="Codex CLI binary used by run-codex-workers.sh")

    prod_final = subparsers.add_parser("production-finalize", help="Assemble accepted production attempts into final exports")
    prod_final.add_argument("run_dir", help="Production run directory")
    prod_final.add_argument("output_dir", nargs="?", help="Optional final output directory")
    prod_final.add_argument("--formats", default="texturepacker,aseprite,gamemaker,godot,raw", help="Comma-separated export formats")
    prod_final.add_argument("--sheet-name", default="spriteforge_final", help="Base filename for final exported sheet")

    anim_direct = subparsers.add_parser("animation-direct-action", help="Create per-frame direct imagegen action jobs from one reference image")
    anim_direct.add_argument("reference_image", help="Clean reference/keyframe PNG used only for identity/style")
    anim_direct.add_argument("subject", help="Animation subject")
    anim_direct.add_argument("output_dir", help="Output animation run directory")
    anim_direct.add_argument("--frames", type=int, default=4, help="Total animation frame count")
    anim_direct.add_argument("--frame-descriptions", help="Frame descriptions separated by |")
    anim_direct.add_argument("--cells", type=int, default=64, help="Final cleaned frame size")
    anim_direct.add_argument("--target-side", type=int, default=1024, help="Control-grid image side per frame")
    anim_direct.add_argument("--workers", type=int, default=4, help="Parallel Codex/imagegen workers")
    anim_direct.add_argument("--preset", choices=sorted(PRESETS), default="fighter", help="Frame cleanup/scoring preset")
    anim_direct.add_argument("--codex-bin", default="codex", help="Codex CLI binary used by run-animation-workers.sh")
    anim_direct.add_argument("--strict-grid-qc", action="store_true", help="Fail frames whose raw output loses visible grid lines")
    anim_direct.add_argument("--no-dispatch-script", action="store_true", help="Do not write run-animation-workers.sh")
    anim_direct.add_argument("--run-workers", action="store_true", help="Run the generated worker script after preparing")
    anim_direct.add_argument("--control-profile", default="green-cyan", choices=["auto", *sorted(CONTROL_GRID_PROFILES)], help="Service background/grid profile for direct-action controls")
    anim_direct.add_argument("--no-lock-first-frame", action="store_true", help="Also send frame 1 to imagegen instead of copying the approved reference as the locked keyframe")
    anim_direct.add_argument("--attempts", type=int, default=1, help="Imagegen attempts per generated frame; ingest chooses the best candidate")

    anim_plan = subparsers.add_parser("animation-plan", help="Create keyframe-first animation generation jobs")
    anim_plan.add_argument("subject", help="Animation subject")
    anim_plan.add_argument("output_dir", help="Output animation run directory")
    anim_plan.add_argument("--frames", type=int, default=4, help="Total animation frame count")
    anim_plan.add_argument("--frame-descriptions", help="Frame descriptions separated by |")
    anim_plan.add_argument("--cells", type=int, default=32, help="Final cells per frame side")
    anim_plan.add_argument("--target-side", type=int, default=1024, help="Control-grid image side per frame")
    anim_plan.add_argument("--workers", type=int, default=4, help="Parallel workers for non-keyframe generation")
    anim_plan.add_argument("--preset", choices=sorted(PRESETS), default="item", help="Frame preset")
    anim_plan.add_argument("--codex-bin", default="codex", help="Codex CLI binary used by run-animation-workers.sh")
    anim_plan.add_argument("--no-dispatch-script", action="store_true", help="Do not write run-animation-workers.sh")

    anim_continue = subparsers.add_parser("animation-continue", help="Create parallel follow-up frame jobs after keyframe processing")
    anim_continue.add_argument("run_dir", help="Animation run directory")
    anim_continue.add_argument("--codex-bin", default="codex", help="Codex CLI binary used by run-animation-workers.sh")

    anim_ingest = subparsers.add_parser("animation-ingest", help="Process animation raw frames and assemble when complete")
    anim_ingest.add_argument("run_dir", help="Animation run directory")

    anim_retry = subparsers.add_parser("animation-retry", help="Create retry jobs for animation frames that fail grid QC or optional pose threshold")
    anim_retry.add_argument("run_dir", help="Animation run directory")
    anim_retry.add_argument("--max-retries", type=int, default=1, help="Maximum retry jobs per frame")
    anim_retry.add_argument("--pose-threshold", type=float, help="Also retry accepted frames whose pose score is below this threshold")
    anim_retry.add_argument("--codex-bin", default="codex", help="Codex CLI binary used by run-animation-workers.sh")

    anim_render = subparsers.add_parser("animation-render-job", help="Prepare and optionally run imagegen workers for a UI animation render job")
    anim_render.add_argument("job_dir", help="UI-created animation-render-jobs/job_XX directory")
    anim_render.add_argument("--cells", type=int, help="Final cleaned frame size; defaults to current-frame/rough-frame size")
    anim_render.add_argument("--mode", choices=["sheet", "frames"], default="sheet", help="Render full action sheets as candidates (default) or legacy independent frames")
    anim_render.add_argument("--workers", type=int, default=4, help="Parallel Codex/imagegen workers for render pass")
    anim_render.add_argument("--candidates", type=int, help="Number of full-sheet candidates in sheet mode; defaults to --workers")
    anim_render.add_argument("--preset", choices=sorted(PRESETS), default="fighter", help="Cleanup scoring preset")
    anim_render.add_argument("--codex-bin", default="codex", help="Codex CLI binary used by run-render-workers.sh")
    anim_render.add_argument("--no-dispatch-script", action="store_true", help="Do not write run-render-workers.sh")
    anim_render.add_argument("--run-workers", action="store_true", help="Run the generated worker script after preparing")

    anim_render_ingest = subparsers.add_parser("animation-render-ingest", help="Clean raw imagegen outputs from an animation render job into a review run")
    anim_render_ingest.add_argument("job_dir", help="animation-render-jobs/job_XX directory")
    anim_render_ingest.add_argument("--review-dir", help="Output review-run directory; defaults to job_dir/review-run")
    anim_render_ingest.add_argument("--gif-duration", type=int, default=140, help="GIF frame duration in ms")

    anim_part_render = subparsers.add_parser("animation-part-render-job", help="Prepare selective rig-part imagegen jobs on top of an accepted animation run")
    anim_part_render.add_argument("run_dir", help="Accepted animation run/review-run directory with frames/ and rig-parts metadata")
    anim_part_render.add_argument("--part", action="append", required=True, help="Rig part name to regenerate; may be repeated or comma-separated")
    anim_part_render.add_argument("--instruction", required=True, help="Localized edit request, e.g. 'hair has more secondary motion'")
    anim_part_render.add_argument("--cells", type=int, help="Frame cell size; defaults to accepted frame size")
    anim_part_render.add_argument("--mask-padding", type=int, default=6, help="Pixels to expand the selected part mask/envelope")
    anim_part_render.add_argument("--workers", type=int, default=2, help="Parallel Codex/imagegen workers")
    anim_part_render.add_argument("--candidates", type=int, help="Number of candidates; defaults to --workers")
    anim_part_render.add_argument("--preset", choices=sorted(PRESETS), default="fighter", help="Cleanup scoring preset")
    anim_part_render.add_argument("--codex-bin", default="codex", help="Codex CLI binary used by run-part-render-workers.sh")
    anim_part_render.add_argument("--no-dispatch-script", action="store_true", help="Do not write run-part-render-workers.sh")
    anim_part_render.add_argument("--run-workers", action="store_true", help="Run the generated worker script after preparing")

    anim_part_ingest = subparsers.add_parser("animation-part-render-ingest", help="Clean and composite selective rig-part render candidates into a review run")
    anim_part_ingest.add_argument("part_job_dir", help="part-render-jobs/<part>_XX directory")
    anim_part_ingest.add_argument("--review-dir", help="Output review-run directory; defaults to part_job_dir/review-run")
    anim_part_ingest.add_argument("--gif-duration", type=int, default=140, help="GIF frame duration in ms")

    atlas = subparsers.add_parser("assemble-atlas", help="Assemble accepted transparent frames/sheets into a runtime atlas")
    atlas.add_argument("output", help="Output atlas PNG path")
    atlas.add_argument("inputs", nargs="+", help="Input transparent PNG frames or sheets")
    atlas.add_argument("--cols", type=int, required=True, help="Atlas columns")
    atlas.add_argument("--cell-size", type=int, default=64, help="Atlas cell size")
    atlas.add_argument("--labels", help="Optional comma-separated frame labels")

    export = subparsers.add_parser("export-formats", help="Export SpriteBrew-style engine/editor metadata formats")
    export.add_argument("output_dir", help="Output export directory")
    export.add_argument("inputs", nargs="+", help="Processed sheet dirs, frame dirs, or individual PNG frames")
    export.add_argument(
        "--formats",
        default="texturepacker,aseprite,gamemaker,godot,raw",
        help="Comma-separated formats: texturepacker, aseprite, gamemaker, godot, raw, rpgmaker, all",
    )
    export.add_argument("--sheet-name", default="spriteforge_export", help="Base filename for exported sheet and metadata")
    export.add_argument("--cols", type=int, help="Grid columns for combined atlas; defaults to roughly square")
    export.add_argument("--padding", type=int, default=0, help="Pixels of transparent padding between atlas frames")
    export.add_argument("--power-of-two", action="store_true", help="Pad combined atlas canvas to power-of-two dimensions")
    export.add_argument("--frame-width", type=int, help="Resize every frame to this width before export")
    export.add_argument("--frame-height", type=int, help="Resize every frame to this height before export")
    export.add_argument("--fps", type=int, default=12, help="Default animation FPS for metadata formats")
    export.add_argument("--rpg-direction-map", default="down,left,right,up", help="Four animation names for RPG Maker rows")

    qc = subparsers.add_parser("hero-qc", help="Check body scale and anchor drift across processed hero action sheets")
    qc.add_argument("sheet_dirs", nargs="+", help="Processed sheet directories containing frames/")
    qc.add_argument("--baseline", default="idle", help="Baseline sheet directory name for body-shrink checks")
    qc.add_argument("--max-body-shrink", type=float, default=0.15, help="Maximum allowed mean body-height shrink from baseline")
    qc.add_argument("--max-anchor-drift", type=int, default=3, help="Maximum allowed bbox bottom-line drift in pixels")
    qc.add_argument("--output", help="Optional JSON report path")

    diagnose = subparsers.add_parser("diagnose-sprite", help="Run scoring and face/feature diagnostics on a cleaned sprite")
    diagnose.add_argument("input", help="Input sprite PNG")
    diagnose.add_argument("output", nargs="?", help="Optional JSON report path")
    diagnose.add_argument("--preset", choices=sorted(PRESETS), default="generic", help="Asset preset used by diagnostics")
    diagnose.add_argument("--heatmaps", help="Optional directory for artifact heatmap PNGs")
    diagnose.add_argument("--chroma-key", help="Optional chroma color for remnant heatmaps")
    diagnose.add_argument("--chroma-tolerance", type=int, default=64, help="RGB tolerance for chroma remnant heatmaps")
    diagnose.add_argument("--grid-key", help="Optional grid color for grid echo heatmaps")
    diagnose.add_argument("--grid-tolerance", type=int, default=48, help="RGB tolerance for grid echo heatmaps")
    diagnose.add_argument("--dark-threshold", type=int, default=80, help="RGB channel-sum threshold for dark speck heatmaps")

    detect = subparsers.add_parser("detect-sheet-regions", help="Detect non-grid sprite regions in a generated sheet")
    detect.add_argument("input", help="Input generated sheet")
    detect.add_argument("output", nargs="?", help="Optional JSON report path")
    detect.add_argument("--rows", type=int, help="Expected rows; with --cols, also reports expected frame count")
    detect.add_argument("--cols", type=int, help="Expected columns; with --rows, also reports expected frame count")
    detect.add_argument("--mode", choices=["content", "components"], default="components", help="Detect the content bbox or separate opaque components")
    detect.add_argument("--padding", type=int, default=0, help="Padding around component boxes")
    detect.add_argument("--min-component-size", type=int, default=16, help="Ignore components smaller than this many pixels")
    detect.add_argument("--chroma-key", default="#ff00ff", help="Solid background color to remove before detection")
    detect.add_argument("--chroma-tolerance", type=int, default=64, help="RGB tolerance for background removal")

    control = subparsers.add_parser("control-grid", help="Create a real-grid imagegen control canvas from a reference")
    control.add_argument("input", help="Reference image")
    control.add_argument("output", help="Output control PNG path")
    control.add_argument("--crop", help="Optional crop as x,y,w,h before fitting into the grid")
    control.add_argument("--cells", type=int, default=64, help="Grid cells per side")
    control.add_argument("--cell-size", type=int, default=16, help="Pixels per grid cell in the control image")
    control.add_argument("--target-side", type=int, help="Output side in pixels; overrides --cell-size when divisible by --cells")
    control.add_argument("--profile", default="auto", choices=["auto", *sorted(CONTROL_GRID_PROFILES)], help="Background/grid color profile")
    control.add_argument("--background", help="Override the profile background/chroma color")
    control.add_argument("--padding-ratio", type=float, default=0.06, help="Padding around fitted reference")
    control.add_argument("--grid-color", help="Override the profile service grid line color")
    control.add_argument("--grid-line-width", type=int, default=1, help="Grid line width in pixels")
    control.add_argument("--remove-reference-bg", action="store_true", help="Replace the reference crop border background with chroma color")
    control.add_argument("--reference-bg-tolerance", type=int, default=70, help="Tolerance for reference background replacement")
    control.add_argument("--settings-output", help="Optional process-settings JSON with matching chroma/grid keys")

    scratch_control = subparsers.add_parser("scratch-control-grid", help="Create a blank real-grid imagegen canvas for from-scratch assets")
    scratch_control.add_argument("output", help="Output control PNG path")
    scratch_control.add_argument("--cells", type=int, default=64, help="Grid cells per side")
    scratch_control.add_argument("--cell-size", type=int, default=16, help="Pixels per grid cell in the control image")
    scratch_control.add_argument("--target-side", type=int, help="Output side in pixels; overrides --cell-size when divisible by --cells")
    scratch_control.add_argument("--profile", default="auto", choices=["auto", *sorted(CONTROL_GRID_PROFILES)], help="Background/grid color profile")
    scratch_control.add_argument("--background", help="Override the profile background/chroma color")
    scratch_control.add_argument("--grid-color", help="Override the profile service grid line color")
    scratch_control.add_argument("--grid-line-width", type=int, default=1, help="Grid line width in pixels")
    scratch_control.add_argument("--subject", default="a clean production-ready pixel art sprite", help="Subject text for the optional prompt file")
    scratch_control.add_argument("--reference-image", help="Optional reference/style image used only to avoid service color collisions in --profile auto")
    scratch_control.add_argument("--prompt-output", help="Optional path for an imagegen edit prompt")
    scratch_control.add_argument("--settings-output", help="Optional process-settings JSON with matching chroma/grid keys")

    sheet_control = subparsers.add_parser("sheet-control-grid", help="Create a multi-frame real-grid imagegen canvas")
    sheet_control.add_argument("output", help="Output control sheet PNG path")
    sheet_control.add_argument("--rows", type=int, required=True, help="Frame rows")
    sheet_control.add_argument("--cols", type=int, required=True, help="Frame columns")
    sheet_control.add_argument("--frame-cells", type=int, default=64, help="Final cells per frame side")
    sheet_control.add_argument("--cell-size", type=int, default=16, help="Pixels per final pixel in the control image")
    sheet_control.add_argument("--frame-side", type=int, help="Frame side in source pixels; overrides --cell-size when divisible by --frame-cells")
    sheet_control.add_argument("--profile", default="auto", choices=["auto", *sorted(CONTROL_GRID_PROFILES)], help="Background/grid color profile")
    sheet_control.add_argument("--background", help="Override the profile background/chroma color")
    sheet_control.add_argument("--grid-color", help="Override the profile service grid line color")
    sheet_control.add_argument("--grid-line-width", type=int, default=1, help="Grid line width in pixels")
    sheet_control.add_argument("--subject", default="a clean production-ready pixel art animation", help="Subject text for the prompt file")
    sheet_control.add_argument("--frames", help="Optional frame descriptions separated by |")
    sheet_control.add_argument("--prompt-output", help="Optional path for an imagegen edit prompt")
    sheet_control.add_argument("--settings-output", help="Optional process-settings JSON with matching chroma/grid keys")

    layout = subparsers.add_parser("layout-guide", help="Create a layout-only guide image for sheet generation")
    layout.add_argument("output", help="Output guide PNG path")
    layout.add_argument("--rows", type=int, required=True, help="Number of guide rows")
    layout.add_argument("--cols", type=int, required=True, help="Number of guide columns")
    layout.add_argument("--cell-width", type=int, default=384, help="Guide cell width in pixels")
    layout.add_argument("--cell-height", type=int, default=384, help="Guide cell height in pixels")
    layout.add_argument("--safe-margin-x", type=int, default=52, help="Horizontal safe-area margin inside each cell")
    layout.add_argument("--safe-margin-y", type=int, default=52, help="Vertical safe-area margin inside each cell")
    layout.add_argument("--background", default="#f8f8f8", help="Guide background color")
    layout.add_argument("--slot-color", default="#111111", help="Outer cell slot outline color")
    layout.add_argument("--safe-color", default="#2f80ed", help="Safe-area outline color")
    layout.add_argument("--center-color", default="#b8b8b8", help="Dashed centerline color")
    layout.add_argument("--label-cells", action="store_true", help="Draw small row,column labels for debugging")

    sheet = subparsers.add_parser("process-sheet", help="Split and normalize a generated sprite sheet")
    sheet.add_argument("input", help="Input generated sheet")
    sheet.add_argument("output_dir", help="Output run directory")
    sheet.add_argument("--rows", type=int, required=True, help="Number of sheet rows")
    sheet.add_argument("--cols", type=int, required=True, help="Number of sheet columns")
    sheet.add_argument("--cell-size", type=int, default=64, help="Output frame cell size")
    sheet.add_argument("--chroma-key", default="#ff00ff", help="Solid background color to remove")
    sheet.add_argument("--chroma-tolerance", type=int, default=64, help="RGB tolerance for background removal")
    sheet.add_argument("--fit-scale", type=float, default=0.86, help="Fraction of output cell used by the fitted frame")
    sheet.add_argument("--align", choices=["center", "bottom", "feet"], default="center", help="Frame alignment inside output cells")
    sheet.add_argument("--shared-scale", action=argparse.BooleanOptionalAction, default=True, help="Use one scale for every frame")
    sheet.add_argument("--component-mode", choices=["all", "largest"], default="all", help="Keep all components or only the largest per frame")
    sheet.add_argument("--component-padding", type=int, default=0, help="Padding around selected component bbox before fitting")
    sheet.add_argument("--min-component-size", type=int, default=1, help="Ignore components smaller than this many pixels")
    sheet.add_argument("--region-mode", choices=["grid", "content", "components"], default="grid", help="Use fixed grid boxes, content-bbox splitting, or detected component regions")
    sheet.add_argument("--region-padding", type=int, default=0, help="Padding around detected component regions")
    sheet.add_argument("--edge-touch-margin", type=int, default=0, help="Treat bboxes within this margin as edge-touching")
    sheet.add_argument("--reject-edge-touch", action="store_true", help="Fail if any frame touches a source cell edge")
    sheet.add_argument("--gif-duration", type=int, default=200, help="Frame duration for animation.gif in milliseconds")
    sheet.add_argument("--contact-sheet", action=argparse.BooleanOptionalAction, default=True, help="Write contact_sheet.png for frame QC")
    sheet.add_argument("--preview-scale", type=int, default=4, help="Nearest-neighbor frame scale in contact_sheet.png")
    sheet.add_argument("--direction-strips", action="store_true", help="For 4x4 walk sheets, export down/left/right/up strips and GIFs")
    sheet.add_argument("--palette-file", help="Lock frame colors to a .hex, .gpl, .pal, or .json palette file")
    sheet.add_argument("--prompt-file", help="Optional prompt-used.txt to copy into the sheet run folder")
    sheet.add_argument("--preset", choices=sorted(PRESETS), default="generic", help="Asset preset used by frame expression diagnostics")
    sheet.add_argument("--expression-qc", action=argparse.BooleanOptionalAction, default=True, help="Write sheet-level eyes/mouth/beak consistency diagnostics")
    sheet.add_argument("--max-expression-drift", type=float, default=6.0, help="Maximum allowed feature centroid drift across frames")

    grid_sheet = subparsers.add_parser("process-grid-sheet", help="Split and sample a real-control-grid animation sheet")
    grid_sheet.add_argument("input", help="Input generated control-grid sheet")
    grid_sheet.add_argument("output_dir", help="Output run directory")
    grid_sheet.add_argument("--rows", type=int, required=True, help="Frame rows")
    grid_sheet.add_argument("--cols", type=int, required=True, help="Frame columns")
    grid_sheet.add_argument("--frame-cells", type=int, default=64, help="Final cells per frame side")
    grid_sheet.add_argument("--chroma-key", default="#ff00ff", help="Solid background color to remove")
    grid_sheet.add_argument("--chroma-tolerance", type=int, default=64, help="RGB tolerance for background removal")
    grid_sheet.add_argument("--grid-key", default="#00ffff", help="Service grid color to ignore while sampling")
    grid_sheet.add_argument("--grid-tolerance", type=int, default=48, help="RGB tolerance for service grid removal")
    grid_sheet.add_argument("--sample-margin-ratio", type=float, default=0.40, help="Fraction of each cell edge ignored before sampling")
    grid_sheet.add_argument("--sample-mode", choices=["median", "mode"], default="median", help="How to choose each output pixel color")
    grid_sheet.add_argument("--grid-rectify", action=argparse.BooleanOptionalAction, default=True, help="Detect warped service grid lines before sampling")
    grid_sheet.add_argument("--palette", type=int, default=24, help="Limit each frame to this many colors; 0 disables quantization")
    grid_sheet.add_argument("--min-component-size", type=int, default=0, help="Remove tiny opaque components after sampling")
    grid_sheet.add_argument("--center-alpha", action="store_true", help="Recenter each frame after sampling")
    grid_sheet.add_argument("--no-strip-edge-background", action="store_true", help="Disable edge background cleanup")
    grid_sheet.add_argument("--gif-duration", type=int, default=160, help="Frame duration for animation.gif in milliseconds")
    grid_sheet.add_argument("--preview-scale", type=int, default=4, help="Nearest-neighbor frame scale in contact_sheet.png")
    grid_sheet.add_argument("--prompt-file", help="Optional prompt-used.txt to copy into the sheet run folder")
    grid_sheet.add_argument("--preset", choices=sorted(PRESETS), default="generic", help="Asset preset used by QC")

    animation = subparsers.add_parser("assemble-animation", help="Assemble cleaned frame PNGs into a transparent sheet and GIF")
    animation.add_argument("output_dir", help="Output animation run directory")
    animation.add_argument("inputs", nargs="+", help="Cleaned frame PNGs in animation order")
    animation.add_argument("--cols", type=int, default=4, help="Columns in sheet-transparent.png")
    animation.add_argument("--gif-duration", type=int, default=140, help="Frame duration for animation.gif in milliseconds")
    animation.add_argument("--preview-scale", type=int, default=6, help="Nearest-neighbor frame scale in contact_sheet.png")

    ui = subparsers.add_parser("ui", help="Launch the local Sprite Forge preview/editor UI")
    ui.add_argument("--run", default="examples", help="Sprite Forge run folder to open")
    ui.add_argument("--host", default="127.0.0.1", help="HTTP bind host")
    ui.add_argument("--port", type=int, default=8765, help="HTTP port")
    ui.add_argument("--open", action="store_true", help="Open the UI in the default browser")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "ui":
        from sprite_forge_ui import run_server, safe_path

        run_server(safe_path(args.run), args.host, args.port, args.open)
        return

    if args.command == "prompt":
        write_imagegen_prompt(Path(args.output), args.subject, args.cells, args.background, args.mode, args.preset)
        return

    if args.command == "retry-prompt":
        prompt_text = Path(args.prompt_file).read_text(encoding="utf-8")
        retry_text = write_retry_prompt(
            Path(args.output),
            prompt_text,
            read_retry_hints_file(Path(args.hints_file)),
            cells=args.cells,
            background=args.background,
            preset=args.preset,
            sheet=args.sheet,
        )
        print(retry_text)
        return

    if args.command == "extract-palette":
        colors = extract_palette(Image.open(args.input), args.max_colors)
        write_palette_file(colors, Path(args.output), args.format)
        return

    if args.command == "repixelize":
        if args.backend == "repixelizer":
            payload = run_repixelizer_backend(
                Path(args.input),
                Path(args.output),
                repixelizer_path=Path(args.repixelizer_path) if args.repixelizer_path else None,
                target_size=args.target_size,
                target_width=args.target_width,
                target_height=args.target_height,
                palette_path=Path(args.palette_file) if args.palette_file else None,
                palette_mode=args.palette_mode,
                diagnostics_dir=Path(args.diagnostics_dir) if args.diagnostics_dir else None,
                seed=args.seed,
                steps=args.steps,
                device=args.device,
                strip_background=args.strip_background,
                skip_candidate_rerank=args.skip_candidate_rerank,
            )
        else:
            payload = repixelize_image(
                Path(args.input),
                Path(args.output),
                pixel_size=args.pixel_size,
                max_pixel_size=args.max_pixel_size,
                phase_x=args.phase_x,
                phase_y=args.phase_y,
                sample_mode=args.sample_mode,
                palette=args.palette,
                transparent=args.transparent,
                chroma_key=parse_rgb(args.chroma_key) if args.chroma_key else None,
                chroma_tolerance=args.chroma_tolerance,
                scale=args.scale,
            )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "json-sprite":
        if args.json_command == "prompt":
            prompt = build_json_sprite_prompt(args.subject, width=args.width, height=args.height, mode=args.mode, style=args.style)
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(prompt, encoding="utf-8")
            print(prompt)
            return

        if args.json_command in {"set-pixel", "replace-color", "apply-patch"}:
            sprite = load_json_sprite(Path(args.input), repair=True)
            if args.json_command == "set-pixel":
                edited = set_pixel_in_sprite(sprite, args.x, args.y, args.color)
            elif args.json_command == "replace-color":
                edited = replace_color_in_sprite(sprite, args.from_color, args.to_color)
            else:
                patch_payload = parse_jsonish_text(Path(args.patch).read_text(encoding="utf-8"))
                edited = apply_pixel_patch(sprite, patch_payload)
            validation = validate_pixel_sprite(edited, repair=True)
            if not validation["ok"]:
                print(json.dumps(validation, indent=2))
                raise SystemExit(1)
            normalized = validation["sprite"]
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(json.dumps(normalized, indent=2) + "\n", encoding="utf-8")
            print(
                json.dumps(
                    {
                        "ok": True,
                        "output": args.output,
                        "warnings": validation["warnings"],
                        "quality": pixel_sprite_quality(normalized),  # type: ignore[arg-type]
                    },
                    indent=2,
                )
            )
            return

        if args.json_command in {"frames-validate", "frames-render-sheet", "frames-gif"}:
            payload = parse_jsonish_text(Path(args.input).read_text(encoding="utf-8"))
            validation = validate_json_frames(payload, repair=args.repair or args.json_command != "frames-validate")
            if not validation["ok"]:
                print(json.dumps(validation, indent=2))
                raise SystemExit(1)
            frames = validation["frames"]
            result = {
                "ok": True,
                "warnings": validation["warnings"],
                "frame_count": len(frames),  # type: ignore[arg-type]
                "width": validation["width"],
                "height": validation["height"],
            }
            if args.json_command == "frames-validate":
                if args.output:
                    output_payload = {"frames": frames}
                    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
                    Path(args.output).write_text(json.dumps(output_payload, indent=2) + "\n", encoding="utf-8")
                print(json.dumps(result, indent=2))
                return
            if args.json_command == "frames-render-sheet":
                render_json_frames_sheet(frames, Path(args.output), scale=args.scale)  # type: ignore[arg-type]
                print(json.dumps({**result, "output": args.output, "scale": args.scale}, indent=2))
                return
            if args.json_command == "frames-gif":
                render_json_frames_gif(frames, Path(args.output), scale=args.scale, duration=args.duration)  # type: ignore[arg-type]
                print(json.dumps({**result, "output": args.output, "scale": args.scale, "duration": args.duration}, indent=2))
                return

        payload = extract_sprite_payload(Path(args.input).read_text(encoding="utf-8"))
        validation = validate_pixel_sprite(payload, repair=getattr(args, "repair", False) or args.json_command in {"repair", "render"})
        if not validation["ok"]:
            print(json.dumps(validation, indent=2))
            raise SystemExit(1)
        sprite = validation["sprite"]
        result = {
            "ok": True,
            "warnings": validation["warnings"],
            "quality": pixel_sprite_quality(sprite),  # type: ignore[arg-type]
            "sprite": sprite,
        }
        if args.json_command == "validate":
            if args.output:
                Path(args.output).parent.mkdir(parents=True, exist_ok=True)
                Path(args.output).write_text(json.dumps(sprite, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(result, indent=2))
            return
        if args.json_command == "repair":
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(json.dumps(sprite, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(result, indent=2))
            return
        if args.json_command == "render":
            render_pixel_sprite(sprite, Path(args.output), scale=args.scale)  # type: ignore[arg-type]
            render_result = {**result, "output": args.output, "scale": args.scale}
            print(json.dumps(render_result, indent=2))
            return

    if args.command == "plan-asset":
        payload = asset_plan_to_dict(infer_asset_plan(args.prompt))
        text = json.dumps(payload, indent=2)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(text + "\n", encoding="utf-8")
        print(text)
        return

    if args.command == "hero-bundle":
        payload = scaffold_hero_bundle(args.prompt, Path(args.output_dir))
        print(json.dumps(payload, indent=2))
        return

    if args.command == "production-plan":
        payload = create_production_loop(
            args.request,
            Path(args.output_dir),
            attempts=args.attempts,
            workers=args.workers,
            mode=args.mode,
            preset=args.preset,
            cells=args.cells,
            codex_bin=args.codex_bin,
            dispatch_script=not args.no_dispatch_script,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "production-ingest":
        payload = process_production_loop(Path(args.run_dir))
        print(json.dumps(payload, indent=2))
        return

    if args.command == "production-retry":
        payload = create_production_retry_jobs(
            Path(args.run_dir),
            max_retries=args.max_retries,
            only_failed=not args.include_passed,
            codex_bin=args.codex_bin,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "production-finalize":
        formats = [item.strip().lower() for item in args.formats.split(",") if item.strip()]
        payload = finalize_production_loop(
            Path(args.run_dir),
            Path(args.output_dir) if args.output_dir else None,
            formats=formats,
            sheet_name=args.sheet_name,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "animation-direct-action":
        payload = create_direct_action_plan(
            Path(args.reference_image),
            args.subject,
            Path(args.output_dir),
            frames=args.frames,
            frame_descriptions=args.frame_descriptions,
            cells=args.cells,
            target_side=args.target_side,
            workers=args.workers,
            preset=args.preset,
            codex_bin=args.codex_bin,
            relaxed_grid_qc=not args.strict_grid_qc,
            dispatch_script=not args.no_dispatch_script,
            control_profile=args.control_profile,
            lock_first_frame=not args.no_lock_first_frame,
            attempts=args.attempts,
        )
        print(json.dumps(payload, indent=2))
        if args.run_workers:
            script = payload.get("dispatch_script")
            if not script:
                raise ValueError("--run-workers requires a generated dispatch script")
            subprocess.run([str(script)], check=True)
        return

    if args.command == "animation-plan":
        payload = create_animation_plan(
            args.subject,
            Path(args.output_dir),
            frames=args.frames,
            frame_descriptions=args.frame_descriptions,
            cells=args.cells,
            target_side=args.target_side,
            workers=args.workers,
            preset=args.preset,
            codex_bin=args.codex_bin,
            dispatch_script=not args.no_dispatch_script,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "animation-continue":
        payload = create_animation_followup_jobs(Path(args.run_dir), codex_bin=args.codex_bin)
        print(json.dumps(payload, indent=2))
        return

    if args.command == "animation-ingest":
        payload = ingest_animation_plan(Path(args.run_dir))
        print(json.dumps(payload, indent=2))
        return

    if args.command == "animation-retry":
        payload = create_animation_retry_jobs(
            Path(args.run_dir),
            max_retries=args.max_retries,
            codex_bin=args.codex_bin,
            pose_threshold=args.pose_threshold,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "animation-render-job":
        payload = prepare_animation_render_job(
            Path(args.job_dir),
            cells=args.cells,
            workers=args.workers,
            candidates=args.candidates,
            mode=args.mode,
            preset=args.preset,
            codex_bin=args.codex_bin,
            dispatch_script=not args.no_dispatch_script,
        )
        print(json.dumps(payload, indent=2))
        if args.run_workers:
            script = payload.get("dispatch_script")
            if not script:
                raise ValueError("--run-workers requires a generated dispatch script")
            subprocess.run([str(script)], check=True)
        return

    if args.command == "animation-render-ingest":
        payload = ingest_animation_render_job(
            Path(args.job_dir),
            review_dir=Path(args.review_dir) if args.review_dir else None,
            gif_duration=args.gif_duration,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "animation-part-render-job":
        payload = prepare_animation_part_render_job(
            Path(args.run_dir),
            parts=args.part,
            instruction=args.instruction,
            cells=args.cells,
            mask_padding=args.mask_padding,
            workers=args.workers,
            candidates=args.candidates,
            preset=args.preset,
            codex_bin=args.codex_bin,
            dispatch_script=not args.no_dispatch_script,
        )
        print(json.dumps(payload, indent=2))
        if args.run_workers:
            script = payload.get("dispatch_script")
            if not script:
                raise ValueError("--run-workers requires a generated dispatch script")
            subprocess.run([str(script)], check=True)
        return

    if args.command == "animation-part-render-ingest":
        payload = ingest_animation_part_render_job(
            Path(args.part_job_dir),
            review_dir=Path(args.review_dir) if args.review_dir else None,
            gif_duration=args.gif_duration,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "assemble-atlas":
        labels = [label.strip() for label in args.labels.split(",")] if args.labels else None
        payload = assemble_atlas(
            [Path(input_path) for input_path in args.inputs],
            Path(args.output),
            cols=args.cols,
            cell_size=args.cell_size,
            labels=labels,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "export-formats":
        formats = [item.strip().lower() for item in args.formats.split(",") if item.strip()]
        direction_map = [item.strip() for item in args.rpg_direction_map.split(",") if item.strip()]
        payload = export_spritebrew_formats(
            [Path(input_path) for input_path in args.inputs],
            Path(args.output_dir),
            formats=formats,
            sheet_name=args.sheet_name,
            cols=args.cols,
            padding=args.padding,
            power_of_two=args.power_of_two,
            frame_width=args.frame_width,
            frame_height=args.frame_height,
            fps=args.fps,
            rpg_direction_map=direction_map,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "hero-qc":
        payload = hero_qc(
            [Path(sheet_dir) for sheet_dir in args.sheet_dirs],
            baseline=args.baseline,
            max_body_shrink=args.max_body_shrink,
            max_anchor_drift=args.max_anchor_drift,
        )
        text = json.dumps(payload, indent=2)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(text + "\n", encoding="utf-8")
        print(text)
        return

    if args.command == "diagnose-sprite":
        image = Image.open(args.input).convert("RGBA")
        payload = {
            "score": score_sprite(image, str(args.input), args.preset).__dict__,
            "features": sprite_feature_diagnostics(image, args.preset),
        }
        if args.heatmaps:
            payload["artifact_heatmaps"] = save_artifact_heatmaps(
                image,
                Path(args.heatmaps),
                chroma_key=parse_rgb(args.chroma_key) if args.chroma_key else None,
                chroma_tolerance=args.chroma_tolerance,
                grid_key=parse_rgb(args.grid_key) if args.grid_key else None,
                grid_tolerance=args.grid_tolerance,
                dark_threshold=args.dark_threshold,
            )
        text = json.dumps(payload, indent=2)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(text + "\n", encoding="utf-8")
        print(text)
        return

    if args.command == "detect-sheet-regions":
        cleaned = remove_keyed_background(Image.open(args.input).convert("RGBA"), parse_rgb(args.chroma_key), args.chroma_tolerance)
        payload = detect_sheet_regions(
            cleaned,
            rows=args.rows,
            cols=args.cols,
            mode=args.mode,
            padding=args.padding,
            min_component_size=args.min_component_size,
        )
        text = json.dumps(payload, indent=2)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(text + "\n", encoding="utf-8")
        print(text)
        return

    if args.command == "control-grid":
        create_control_grid(
            Path(args.input),
            Path(args.output),
            cells=args.cells,
            cell_size=args.cell_size,
            target_side=args.target_side,
            crop=parse_crop(args.crop) if args.crop else None,
            background=parse_rgb(args.background) if args.background else None,
            padding_ratio=args.padding_ratio,
            grid_color=parse_rgb(args.grid_color) if args.grid_color else None,
            grid_line_width=args.grid_line_width,
            profile=args.profile,
            remove_reference_bg=args.remove_reference_bg,
            reference_bg_tolerance=args.reference_bg_tolerance,
            settings_output=Path(args.settings_output) if args.settings_output else None,
        )
        return

    if args.command == "scratch-control-grid":
        create_scratch_control_grid(
            Path(args.output),
            cells=args.cells,
            cell_size=args.cell_size,
            target_side=args.target_side,
            background=parse_rgb(args.background) if args.background else None,
            grid_color=parse_rgb(args.grid_color) if args.grid_color else None,
            grid_line_width=args.grid_line_width,
            profile=args.profile,
            reference_image=Image.open(args.reference_image).convert("RGB") if args.reference_image else None,
            prompt_output=Path(args.prompt_output) if args.prompt_output else None,
            settings_output=Path(args.settings_output) if args.settings_output else None,
            subject=args.subject,
        )
        return

    if args.command == "sheet-control-grid":
        frame_descriptions = tuple(part.strip() for part in args.frames.split("|")) if args.frames else ()
        create_sheet_control_grid(
            Path(args.output),
            rows=args.rows,
            cols=args.cols,
            frame_cells=args.frame_cells,
            cell_size=args.cell_size,
            frame_side=args.frame_side,
            background=parse_rgb(args.background) if args.background else None,
            grid_color=parse_rgb(args.grid_color) if args.grid_color else None,
            grid_line_width=args.grid_line_width,
            profile=args.profile,
            prompt_output=Path(args.prompt_output) if args.prompt_output else None,
            settings_output=Path(args.settings_output) if args.settings_output else None,
            subject=args.subject,
            frames=frame_descriptions,
        )
        return

    if args.command == "layout-guide":
        create_layout_guide(
            Path(args.output),
            rows=args.rows,
            cols=args.cols,
            cell_width=args.cell_width,
            cell_height=args.cell_height,
            safe_margin_x=args.safe_margin_x,
            safe_margin_y=args.safe_margin_y,
            background=parse_rgb(args.background),
            slot_color=parse_rgb(args.slot_color),
            safe_color=parse_rgb(args.safe_color),
            center_color=parse_rgb(args.center_color),
            label_cells=args.label_cells,
        )
        return

    if args.command == "process-grid-sheet":
        metadata = process_grid_sheet(
            Path(args.input),
            Path(args.output_dir),
            rows=args.rows,
            cols=args.cols,
            frame_cells=args.frame_cells,
            chroma_key=parse_rgb(args.chroma_key),
            chroma_tolerance=args.chroma_tolerance,
            grid_key=parse_rgb(args.grid_key) if args.grid_key else None,
            grid_tolerance=args.grid_tolerance,
            sample_margin_ratio=args.sample_margin_ratio,
            sample_mode=args.sample_mode,
            palette=args.palette,
            min_component_size=args.min_component_size,
            center_alpha=args.center_alpha,
            strip_edge_background=not args.no_strip_edge_background,
            gif_duration=args.gif_duration,
            preview_scale=args.preview_scale,
            prompt_file=Path(args.prompt_file) if args.prompt_file else None,
            preset=args.preset,
            rectify_grid=args.grid_rectify,
        )
        print(json.dumps(metadata, indent=2))
        return

    if args.command == "assemble-animation":
        metadata = assemble_animation_frames(
            [Path(input_path) for input_path in args.inputs],
            Path(args.output_dir),
            cols=args.cols,
            gif_duration=args.gif_duration,
            preview_scale=args.preview_scale,
        )
        print(json.dumps(metadata, indent=2))
        return

    if args.command == "process-sheet":
        process_sheet(
            Path(args.input),
            Path(args.output_dir),
            rows=args.rows,
            cols=args.cols,
            cell_size=args.cell_size,
            chroma_key=parse_rgb(args.chroma_key),
            chroma_tolerance=args.chroma_tolerance,
            fit_scale=args.fit_scale,
            align=args.align,
            shared_scale=args.shared_scale,
            component_mode=args.component_mode,
            component_padding=args.component_padding,
            min_component_size=args.min_component_size,
            region_mode=args.region_mode,
            region_padding=args.region_padding,
            edge_touch_margin=args.edge_touch_margin,
            reject_edge_touch=args.reject_edge_touch,
            gif_duration=args.gif_duration,
            contact_sheet=args.contact_sheet,
            preview_scale=args.preview_scale,
            direction_strips=args.direction_strips,
            palette_colors=load_palette_file(Path(args.palette_file)) if args.palette_file else (),
            preset=args.preset,
            expression_qc=args.expression_qc,
            max_expression_drift=args.max_expression_drift,
            prompt_file=Path(args.prompt_file) if args.prompt_file else None,
        )
        return

    if args.command == "process-sprite":
        try:
            payload = process_single_sprite(
                Path(args.input),
                Path(args.output_dir),
                ForgeOptions(
                    cells=args.cells,
                    scale=1,
                    sample_margin_ratio=args.sample_margin_ratio,
                    palette=args.palette,
                    transparent=True,
                    background_tolerance=args.background_tolerance,
                    square_crop=args.square_crop,
                    sample_mode=args.sample_mode,
                    prequantize_palette=args.prequantize_palette,
                    chroma_key=parse_rgb(args.chroma_key) if args.chroma_key else None,
                    chroma_tolerance=args.chroma_tolerance,
                    grid_key=parse_rgb(args.grid_key) if args.grid_key else None,
                    grid_tolerance=args.grid_tolerance,
                    min_component_size=args.min_component_size,
                    keep_largest_component=args.keep_largest_component,
                    center_alpha=args.center_alpha,
                    trim_alpha=args.trim_alpha,
                    outline_color=parse_rgb(args.outline_color) if args.outline_color else None,
                    despeckle=args.despeckle,
                    min_color_component_size=args.min_color_component_size,
                    dark_speck_size=args.dark_speck_size,
                    dark_threshold=args.dark_threshold,
                    strip_edge_background=args.strip_edge_background,
                    strip_edge_tolerance=args.strip_edge_tolerance,
                    palette_colors=load_palette_file(Path(args.palette_file)) if args.palette_file else (),
                    preset=args.preset,
                    protect_face_details=args.protect_face_details,
                ),
                preview_scale=args.preview_scale,
                prompt_file=Path(args.prompt_file) if args.prompt_file else None,
                grid_qc=args.grid_qc,
                reject_grid_violations=args.reject_grid_violations,
                content_crop_before_sampling=args.content_crop_before_sampling,
                content_crop_padding_cells=args.content_crop_padding_cells,
            )
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            sys.exit(1)
        print(json.dumps(payload, indent=2))
        return

    if args.command == "reconstruct-sprite":
        payload = reconstruct_generated_sprite(
            Path(args.input),
            Path(args.output),
            cells=args.cells,
            chroma_key=parse_rgb(args.chroma_key),
            chroma_tolerance=args.chroma_tolerance,
            pixel_size=args.pixel_size,
            max_pixel_size=args.max_pixel_size,
            phase_mode=args.phase_mode,
            sample_mode=args.sample_mode,
            palette=args.palette,
            palette_colors=load_palette_file(Path(args.palette_file)) if args.palette_file else (),
            palette_strategy=args.palette_strategy,
            grid_quantize_first=args.grid_quantize_first,
            dither=args.dither,
            dither_strength=args.dither_strength,
            dither_scope=args.dither_scope,
            dither_edge_mask=args.dither_edge_mask,
            dither_edge_threshold=args.dither_edge_threshold,
            dither_luma_range=args.dither_luma_range,
            dither_error_threshold=args.dither_error_threshold,
            hidden_grid_variant_limit=args.hidden_grid_variant_limit,
            dark_stroke_threshold=args.dark_stroke_threshold,
            pad=args.pad,
            preview_scale=args.preview_scale,
            preset=args.preset,
            candidate_radius=args.candidate_radius,
            phase_sweep=args.phase_sweep,
            selection_mode=args.selection_mode,
            cleanup=args.cleanup,
            min_component_size=args.min_component_size,
            min_color_component_size=args.min_color_component_size,
            dark_speck_size=args.dark_speck_size,
            despeckle=args.despeckle,
            output_dir=Path(args.output_dir) if args.output_dir else None,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "style-reference-sheet":
        payload = build_style_reference_sheet(
            [Path(input_path) for input_path in args.inputs],
            Path(args.output_dir),
            cells=args.cells,
            palette=args.palette,
            sample_mode=args.sample_mode,
            pixel_size=args.pixel_size,
            target_ref=Path(args.target_ref) if args.target_ref else None,
            phase_sweep=args.phase_sweep,
            preview_scale=args.preview_scale,
            preset=args.preset,
            edge_tolerance=args.edge_tolerance,
            artifact_clean=args.artifact_clean,
            artifact_palette=args.artifact_palette,
            artifact_merge_tolerance=args.artifact_merge_tolerance,
            artifact_island_size=args.artifact_island_size,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "clean-style-ref-artifacts":
        payload = clean_style_reference_artifacts(
            Path(args.input),
            Path(args.output),
            palette=args.palette,
            merge_tolerance=args.merge_tolerance,
            island_size=args.island_size,
            preview_scale=args.preview_scale,
            preset=args.preset,
        )
        print(json.dumps(payload, indent=2))
        return

    if args.command == "rank":
        scores = rank_sprite_candidates(
            [Path(input_path) for input_path in args.inputs],
            Path(args.output_dir),
            ForgeOptions(
                cells=args.cells,
                scale=1,
                sample_margin_ratio=args.sample_margin_ratio,
                palette=args.palette,
                transparent=args.transparent,
                background_tolerance=args.background_tolerance,
                square_crop=args.square_crop,
                sample_mode=args.sample_mode,
                prequantize_palette=args.prequantize_palette,
                chroma_key=parse_rgb(args.chroma_key) if args.chroma_key else None,
                chroma_tolerance=args.chroma_tolerance,
                grid_key=parse_rgb(args.grid_key) if args.grid_key else None,
                grid_tolerance=args.grid_tolerance,
                min_component_size=args.min_component_size,
                keep_largest_component=args.keep_largest_component,
                center_alpha=args.center_alpha,
                trim_alpha=args.trim_alpha,
                outline_color=parse_rgb(args.outline_color) if args.outline_color else None,
                despeckle=args.despeckle,
                min_color_component_size=args.min_color_component_size,
                dark_speck_size=args.dark_speck_size,
                dark_threshold=args.dark_threshold,
                strip_edge_background=args.strip_edge_background,
                strip_edge_tolerance=args.strip_edge_tolerance,
                palette_colors=load_palette_file(Path(args.palette_file)) if args.palette_file else (),
                preset=args.preset,
                protect_face_details=args.protect_face_details,
            ),
            preview_scale=args.preview_scale,
        )
        for index, score in enumerate(scores, start=1):
            issues = ",".join(score.quality_issues) if score.quality_issues else "ok"
            print(
                f"{index}. score={score.score} colors={score.visible_colors} "
                f"fill={score.fill_ratio} issues={issues} "
                f"dark={score.dark_specks} color_islands={score.small_color_components} path={score.path}"
            )
        return

    forge_sprite(
        Path(args.input),
        Path(args.output),
        ForgeOptions(
            cells=args.cells,
            scale=args.scale,
            sample_margin_ratio=args.sample_margin_ratio,
            palette=args.palette,
            transparent=args.transparent,
            background_tolerance=args.background_tolerance,
            square_crop=args.square_crop,
            sample_mode=args.sample_mode,
            prequantize_palette=args.prequantize_palette,
            chroma_key=parse_rgb(args.chroma_key) if args.chroma_key else None,
            chroma_tolerance=args.chroma_tolerance,
            grid_key=parse_rgb(args.grid_key) if args.grid_key else None,
            grid_tolerance=args.grid_tolerance,
            min_component_size=args.min_component_size,
            keep_largest_component=args.keep_largest_component,
            center_alpha=args.center_alpha,
            trim_alpha=args.trim_alpha,
            outline_color=parse_rgb(args.outline_color) if args.outline_color else None,
            despeckle=args.despeckle,
            min_color_component_size=args.min_color_component_size,
            dark_speck_size=args.dark_speck_size,
            dark_threshold=args.dark_threshold,
            strip_edge_background=args.strip_edge_background,
            strip_edge_tolerance=args.strip_edge_tolerance,
            palette_colors=load_palette_file(Path(args.palette_file)) if args.palette_file else (),
            preset=getattr(args, "preset", "generic"),
            protect_face_details=args.protect_face_details,
        ),
    )


if __name__ == "__main__":
    main()
