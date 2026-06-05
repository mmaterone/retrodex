from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Literal

from PIL import Image

# Adapted from boona13/sprite-lab (MIT License, 2026 Sprite Lab contributors).
# The implementation is translated to Python/Pillow and integrated with
# Retrodex's deterministic cleanup worker.

BackdropKind = Literal["magenta", "green", "checkerboard", "solid", "transparent", "none"]
ALPHA_CUT = 16


@dataclass(frozen=True)
class BackdropAnalysis:
    confidence: float
    kind: BackdropKind
    label: str


@dataclass(frozen=True)
class ComponentFrame:
    box: dict[str, int]
    image: Image.Image


def clamp_byte(value: float) -> int:
    return max(0, min(255, round(value)))


def magenta_cast(red: int, green: int, blue: int) -> int:
    return max(0, min(red, blue) - green)


def green_cast(red: int, green: int, blue: int) -> int:
    return max(0, green - max(red, blue))


def luminance(red: int, green: int, blue: int) -> float:
    return red * 0.2126 + green * 0.7152 + blue * 0.0722


def sample_for_analysis(image: Image.Image, max_dim: int = 512) -> Image.Image:
    rgba = image.convert("RGBA")
    scale = min(1.0, max_dim / max(rgba.width, rgba.height))
    if scale >= 1:
        return rgba
    return rgba.resize(
        (max(1, round(rgba.width * scale)), max(1, round(rgba.height * scale))),
        Image.Resampling.NEAREST,
    )


def _border_points(width: int, height: int):
    for x in range(width):
        yield x, 0
        yield x, height - 1
    for y in range(height):
        yield 0, y
        yield width - 1, y


def border_has_checker_pattern(image: Image.Image) -> bool:
    pixels = image.load()
    whiteish = 0
    greyish = 0
    samples = 0
    for x, y in _border_points(image.width, image.height):
        red, green, blue, _alpha = pixels[x, y]
        maximum = max(red, green, blue)
        minimum = min(red, green, blue)
        if maximum - minimum > 42:
            continue
        samples += 1
        if maximum > 225:
            whiteish += 1
        elif 130 < maximum < 215:
            greyish += 1
    return samples > 0 and whiteish / samples > 0.1 and greyish / samples > 0.1


def border_is_solid_light(image: Image.Image) -> bool:
    pixels = image.load()
    colors = [pixels[x, y][:3] for x, y in _border_points(image.width, image.height)]
    if not colors:
        return False
    average = tuple(round(sum(color[channel] for color in colors) / len(colors)) for channel in range(3))
    if max(average) < 180:
        return False
    matches = 0
    for color in colors:
        distance = sum(abs(color[channel] - average[channel]) for channel in range(3))
        if distance < 50:
            matches += 1
    return matches / len(colors) > 0.65


def detect_backdrop(image: Image.Image) -> BackdropAnalysis:
    sample = sample_for_analysis(image)
    pixels = sample.load()
    total = sample.width * sample.height
    transparent = 0
    magenta = 0
    green = 0
    for y in range(sample.height):
        for x in range(sample.width):
            red, green_channel, blue, alpha = pixels[x, y]
            if alpha < 200:
                transparent += 1
                continue
            if magenta_cast(red, green_channel, blue) > 60:
                magenta += 1
            if green_cast(red, green_channel, blue) > 60:
                green += 1

    transparent_fraction = transparent / max(1, total)
    if transparent_fraction > 0.02:
        return BackdropAnalysis(round(transparent_fraction, 3), "transparent", "Already transparent")

    magenta_fraction = magenta / max(1, total)
    green_fraction = green / max(1, total)
    if magenta_fraction > 0.06 and magenta_fraction >= green_fraction:
        return BackdropAnalysis(round(magenta_fraction, 3), "magenta", "Magenta screen")
    if green_fraction > 0.06:
        return BackdropAnalysis(round(green_fraction, 3), "green", "Green screen")
    if border_has_checker_pattern(sample):
        return BackdropAnalysis(0.72, "checkerboard", "Checkerboard")
    if border_is_solid_light(sample):
        return BackdropAnalysis(0.78, "solid", "Solid backdrop")

    corners = [pixels[0, 0][:3], pixels[sample.width - 1, 0][:3], pixels[0, sample.height - 1][:3], pixels[sample.width - 1, sample.height - 1][:3]]
    spread = max(max(abs(color[channel] - corners[0][channel]) for channel in range(3)) for color in corners)
    if spread < 24:
        return BackdropAnalysis(0.68, "solid", "Solid backdrop")
    return BackdropAnalysis(0.35, "none", "No backdrop detected")


def chroma_key_in_place(image: Image.Image, key: tuple[int, int, int], tolerance: int = 64) -> int:
    pixels = image.load()
    removed = 0
    is_magenta = key == (255, 0, 255)
    is_green = key[1] >= 150 and key[0] <= 80 and key[2] <= 80
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                continue
            if is_magenta or is_green:
                cast = magenta_cast(red, green, blue) if is_magenta else green_cast(red, green, blue)
                if cast <= 18:
                    continue
                next_alpha = 0 if cast > 120 else round(255 * (1 - (cast - 18) / 102))
                if next_alpha < alpha:
                    pixels[x, y] = (red, green, blue, max(0, next_alpha))
                    removed += 1
                continue
            distance = abs(red - key[0]) + abs(green - key[1]) + abs(blue - key[2])
            if distance <= tolerance:
                pixels[x, y] = (red, green, blue, 0)
                removed += 1
    return removed


def border_flood_remove(image: Image.Image, tolerance: int = 50) -> int:
    pixels = image.load()
    corners = [pixels[0, 0][:3], pixels[image.width - 1, 0][:3], pixels[0, image.height - 1][:3], pixels[image.width - 1, image.height - 1][:3]]
    background = tuple(round(sum(color[channel] for color in corners) / len(corners)) for channel in range(3))
    queue = deque(_border_points(image.width, image.height))
    visited: set[tuple[int, int]] = set()
    removed = 0
    while queue:
        x, y = queue.popleft()
        if (x, y) in visited or x < 0 or y < 0 or x >= image.width or y >= image.height:
            continue
        visited.add((x, y))
        red, green, blue, alpha = pixels[x, y]
        if alpha < ALPHA_CUT:
            continue
        distance = abs(red - background[0]) + abs(green - background[1]) + abs(blue - background[2])
        if distance > tolerance:
            continue
        pixels[x, y] = (red, green, blue, 0)
        removed += 1
        queue.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    return removed


def remove_checkerboard_in_place(image: Image.Image) -> int:
    pixels = image.load()
    border = [pixels[x, y][:3] for x, y in _border_points(image.width, image.height)]
    neutral = [color for color in border if max(color) - min(color) <= 42]
    if not neutral:
        return 0
    light = tuple(round(sum(color[channel] for color in neutral if max(color) > 220) / max(1, sum(1 for color in neutral if max(color) > 220))) for channel in range(3))
    grey = tuple(round(sum(color[channel] for color in neutral if max(color) <= 220) / max(1, sum(1 for color in neutral if max(color) <= 220))) for channel in range(3))
    removed = 0
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                continue
            if min(
                sum(abs((red, green, blue)[channel] - light[channel]) for channel in range(3)),
                sum(abs((red, green, blue)[channel] - grey[channel]) for channel in range(3)),
            ) <= 58:
                pixels[x, y] = (red, green, blue, 0)
                removed += 1
    return removed


def refine_edge_matte_in_place(image: Image.Image, radius: int = 1, passes: int = 2, min_contrast: int = 200) -> int:
    pixels = image.load()
    changed = 0
    for _pass in range(passes):
        updates: list[tuple[int, int, tuple[int, int, int, int]]] = []
        for y in range(image.height):
            for x in range(image.width):
                red, green, blue, alpha = pixels[x, y]
                if alpha < ALPHA_CUT:
                    continue
                background: list[tuple[int, int, int]] = []
                foreground: list[tuple[int, int, int]] = []
                for dy in range(-radius, radius + 1):
                    for dx in range(-radius, radius + 1):
                        if dx == 0 and dy == 0:
                            continue
                        nx, ny = x + dx, y + dy
                        if nx < 0 or ny < 0 or nx >= image.width or ny >= image.height:
                            continue
                        nr, ng, nb, na = pixels[nx, ny]
                        if na < ALPHA_CUT:
                            background.append((nr, ng, nb))
                        else:
                            foreground.append((nr, ng, nb))
                if not background or not foreground:
                    continue
                bg = tuple(sum(color[channel] for color in background) / len(background) for channel in range(3))
                weights = []
                for color in foreground:
                    distance = sum(abs(color[channel] - bg[channel]) for channel in range(3))
                    weights.append(distance * distance)
                total_weight = sum(weights)
                fg = (
                    tuple(sum(color[channel] for color in foreground) / len(foreground) for channel in range(3))
                    if total_weight == 0
                    else tuple(sum(color[channel] * weights[index] for index, color in enumerate(foreground)) / total_weight for channel in range(3))
                )
                denom = sum(abs(fg[channel] - bg[channel]) for channel in range(3))
                if denom < min_contrast:
                    continue
                current = (red, green, blue)
                amount = max(0.0, min(1.0, sum(abs(current[channel] - bg[channel]) for channel in range(3)) / denom))
                next_alpha = round(amount * 255)
                if next_alpha >= alpha:
                    continue
                if next_alpha < ALPHA_CUT:
                    next_rgb = tuple(clamp_byte(bg[channel]) for channel in range(3))
                else:
                    next_rgb = tuple(clamp_byte((current[channel] - (1 - amount) * bg[channel]) / amount) for channel in range(3))
                updates.append((x, y, (*next_rgb, next_alpha)))
        if not updates:
            break
        changed += len(updates)
        for x, y, value in updates:
            pixels[x, y] = value
    return changed


def remove_backdrop(image: Image.Image, analysis: BackdropAnalysis | None = None) -> tuple[Image.Image, dict[str, object]]:
    rgba = image.convert("RGBA")
    detected = analysis or detect_backdrop(rgba)
    removed = 0
    matted = 0
    if detected.kind == "magenta":
        removed = chroma_key_in_place(rgba, (255, 0, 255))
        matted = refine_edge_matte_in_place(rgba, radius=2, passes=2, min_contrast=80)
    elif detected.kind == "green":
        removed = chroma_key_in_place(rgba, (0, 177, 64))
        matted = refine_edge_matte_in_place(rgba, radius=2, passes=2, min_contrast=80)
    elif detected.kind == "checkerboard":
        removed = remove_checkerboard_in_place(rgba)
        matted = refine_edge_matte_in_place(rgba, radius=2, passes=2, min_contrast=120)
    elif detected.kind in {"solid", "none"}:
        removed = border_flood_remove(rgba, tolerance=58)
        matted = refine_edge_matte_in_place(rgba, radius=1, passes=2, min_contrast=200)
    return rgba, {
        "backdropConfidence": detected.confidence,
        "backdropKind": detected.kind,
        "backdropLabel": detected.label,
        "edgeMattePixels": matted,
        "removedBackdropPixels": removed,
    }


def _dilate(mask: bytearray, width: int, height: int, radius: int = 1) -> bytearray:
    out = bytearray(mask)
    for y in range(height):
        for x in range(width):
            if not mask[y * width + x]:
                continue
            for dy in range(-radius, radius + 1):
                for dx in range(-radius, radius + 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < width and 0 <= ny < height:
                        out[ny * width + nx] = 1
    return out


def find_alpha_components(image: Image.Image, *, alpha_threshold: int = 32, min_area_frac: float = 0.0008, pad: int = 4) -> list[ComponentFrame]:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    total = rgba.width * rgba.height
    mask = bytearray(total)
    for y in range(rgba.height):
        for x in range(rgba.width):
            if pixels[x, y][3] >= alpha_threshold:
                mask[y * rgba.width + x] = 1
    mask = _dilate(mask, rgba.width, rgba.height, 1)
    visited = bytearray(total)
    min_area = max(96, round(total * min_area_frac))
    components: list[tuple[int, int, int, int, int]] = []
    for start in range(total):
        if not mask[start] or visited[start]:
            continue
        queue = deque([start])
        visited[start] = 1
        min_x, min_y, max_x, max_y, area = rgba.width, rgba.height, -1, -1, 0
        while queue:
            point = queue.popleft()
            x = point % rgba.width
            y = point // rgba.width
            area += 1
            min_x, min_y, max_x, max_y = min(min_x, x), min(min_y, y), max(max_x, x), max(max_y, y)
            for next_point, ok in ((point - 1, x > 0), (point + 1, x < rgba.width - 1), (point - rgba.width, y > 0), (point + rgba.width, y < rgba.height - 1)):
                if ok and mask[next_point] and not visited[next_point]:
                    visited[next_point] = 1
                    queue.append(next_point)
        if area >= min_area:
            components.append((min_x, min_y, max_x, max_y, area))
    row_tolerance = max(24, round(rgba.height * 0.04))
    components.sort(key=lambda box: (round(box[1] / row_tolerance), box[0]))
    frames = []
    for min_x, min_y, max_x, max_y, _area in components:
        left = max(0, min_x - pad)
        top = max(0, min_y - pad)
        right = min(rgba.width, max_x + pad + 1)
        bottom = min(rgba.height, max_y + pad + 1)
        frames.append(
            ComponentFrame(
                box={"height": bottom - top, "width": right - left, "x": left, "y": top},
                image=rgba.crop((left, top, right, bottom)),
            )
        )
    return frames
