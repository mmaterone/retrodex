from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from pixel_character_core.exporter import export_animation, make_lottie
from pixel_character_core.worker import (
    CleanupContext,
    WorkerJob,
    alpha_bbox,
    lock_palette,
    palette_colors,
    protect_face_details,
    recover_lattice,
    remove_service_colors,
    remove_small_components,
)


def make_context(image: Image.Image, palette_lock: list[str] | None = None) -> CleanupContext:
    job = WorkerJob(
        diagnostics_path=Path("diagnostics.json"),
        frame_id="frame_01",
        input_path=Path("input.png"),
        job_id="job",
        output_path=Path("output.png"),
        palette_lock=palette_lock or [],
        pipeline={"id": "test", "steps": []},
        run={
            "canvas": {"height": 8, "width": 8},
            "id": "run",
            "presetId": "character.fighter.control-grid.v1",
        },
    )
    return CleanupContext(
        blocking_issues=[],
        image=image,
        job=job,
        metrics={},
        protected_pixels=set(),
        retry_hints=[],
        warnings=[],
    )


class WorkerHelpersTest(unittest.TestCase):
    def test_alpha_bbox_detects_visible_pixels(self) -> None:
        image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
        image.putpixel((2, 3), (10, 20, 30, 255))

        self.assertEqual(alpha_bbox(image), {"height": 1, "width": 1, "x": 2, "y": 3})

    def test_palette_ignores_transparent_and_service_colors(self) -> None:
        image = Image.new("RGBA", (2, 2), (255, 0, 255, 255))
        image.putpixel((0, 0), (32, 32, 32, 255))
        image.putpixel((1, 0), (255, 255, 255, 255))
        image.putpixel((0, 1), (0, 255, 255, 255))
        context = make_context(image)
        remove_service_colors(context, {})

        self.assertEqual(context.image.getpixel((0, 1))[3], 0)
        self.assertEqual(context.image.getpixel((1, 1))[3], 0)
        self.assertEqual(palette_colors(context.image), ["#202020", "#ffffff"])

    def test_remove_small_components_keeps_larger_subject(self) -> None:
        image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
        image.putpixel((0, 0), (255, 255, 255, 255))
        for x in range(3):
            for y in range(3):
                image.putpixel((3 + x, 3 + y), (32, 32, 32, 255))
        context = make_context(image)

        remove_small_components(context, {"minSize": 4})

        self.assertEqual(context.image.getpixel((0, 0))[3], 0)
        self.assertEqual(context.image.getpixel((4, 4))[3], 255)

    def test_protect_face_details_prevents_eye_cleanup(self) -> None:
        image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
        for x in range(2, 6):
            for y in range(1, 7):
                image.putpixel((x, y), (180, 140, 90, 255))
        image.putpixel((3, 2), (20, 20, 20, 255))
        image.putpixel((4, 2), (20, 20, 20, 255))
        context = make_context(image)

        protect_face_details(
            context,
            {"contrastThreshold": 42, "maxDetailSize": 4, "regionTopRatio": 0.62},
        )
        remove_small_components(context, {"minSize": 4})

        self.assertEqual(context.image.getpixel((3, 2))[3], 255)
        self.assertEqual(context.image.getpixel((4, 2))[3], 255)
        self.assertEqual(context.metrics["protectedFaceDetailPixels"], 2)

    def test_lock_palette_maps_to_approved_colors(self) -> None:
        image = Image.new("RGBA", (2, 1), (31, 31, 31, 255))
        image.putpixel((1, 0), (250, 250, 250, 255))
        context = make_context(image, ["#202020", "#ffffff"])

        lock_palette(context, {"source": "approved-keyframe"})

        self.assertEqual(context.image.getpixel((0, 0))[:3], (32, 32, 32))
        self.assertEqual(context.image.getpixel((1, 0))[:3], (255, 255, 255))
        self.assertEqual(context.metrics["paletteLockedPixels"], 2)

    def test_recover_lattice_fits_content_to_canvas(self) -> None:
        image = Image.new("RGBA", (16, 8), (0, 0, 0, 0))
        for x in range(10, 14):
            for y in range(2, 6):
                image.putpixel((x, y), (32, 32, 32, 255))
        context = make_context(image)

        recover_lattice(context, {"mergeFragmentsPx": 0})

        self.assertEqual(context.image.size, (8, 8))
        self.assertIsNotNone(alpha_bbox(context.image))

    def test_exporter_writes_web_share_and_embed_formats(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            frames_dir = root / "frames"
            export_dir = root / "export"
            frames_dir.mkdir()
            for index, color in enumerate([(32, 32, 32, 255), (255, 255, 255, 255)], start=1):
                image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
                image.putpixel((index, index), color)
                image.save(frames_dir / f"frame_{index:02d}.png")

            result = export_animation(
                {
                    "exportDir": str(export_dir),
                    "fps": 8,
                    "frames": [
                        {"savedPath": str(frames_dir / "frame_01.png")},
                        {"savedPath": str(frames_dir / "frame_02.png")},
                    ],
                    "name": "Unit Export",
                }
            )

            for key in ("webp", "svg", "lottie", "tgs", "tgsMetadata", "react", "css"):
                self.assertTrue(Path(result[key]).exists(), key)
            self.assertIn("data:image/png;base64", Path(result["svg"]).read_text())
            self.assertIn("retrodex", Path(result["lottie"]).read_text())
            self.assertLess(Path(result["tgs"]).stat().st_size, 64_000)
            self.assertIn("PixelAnimation", Path(result["react"]).read_text())
            self.assertIn("@keyframes", Path(result["css"]).read_text())

    def test_lottie_export_stays_vector_for_many_unique_colors(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            frame_paths = []
            frames = []
            for index in range(2):
                image = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
                for y in range(16):
                    for x in range(16):
                        image.putpixel(
                            (x, y),
                            (
                                (x * 13 + y * 3 + index) % 256,
                                (x * 5 + y * 17) % 256,
                                (x * 19 + y * 7) % 256,
                                255,
                            ),
                        )
                frame_path = root / f"frame_{index + 1}.png"
                image.save(frame_path)
                frame_paths.append(frame_path)
                frames.append(image)

            lottie = make_lottie({"fps": 8, "name": "Noisy Pixel Art"}, frame_paths, frames)

            self.assertEqual(lottie["meta"]["encoding"], "vector-rect-runs")
            self.assertEqual(lottie["assets"], [])
            self.assertEqual(lottie["layers"][0]["ty"], 4)


if __name__ == "__main__":
    unittest.main()
