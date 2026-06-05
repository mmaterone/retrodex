from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from pixel_character_core.backdrop import (
    detect_backdrop,
    find_alpha_components,
    remove_backdrop,
)
from pixel_character_core.ingest import auto_slice_components


class BackdropCleanupTest(unittest.TestCase):
    def test_detects_common_backdrops(self) -> None:
        cases = [
            ("magenta", (255, 0, 255, 255)),
            ("green", (0, 177, 64, 255)),
            ("solid", (255, 255, 255, 255)),
            ("transparent", (0, 0, 0, 0)),
        ]
        for expected, color in cases:
            with self.subTest(expected=expected):
                image = Image.new("RGBA", (16, 16), color)
                if expected != "transparent":
                    image.putpixel((8, 8), (32, 32, 32, 255))
                self.assertEqual(detect_backdrop(image).kind, expected)

    def test_detects_checkerboard_backdrop(self) -> None:
        image = Image.new("RGBA", (16, 16), (255, 255, 255, 255))
        for y in range(16):
            for x in range(16):
                if (x // 4 + y // 4) % 2:
                    image.putpixel((x, y), (170, 170, 170, 255))
        for y in range(6, 10):
            for x in range(6, 10):
                image.putpixel((x, y), (32, 32, 32, 255))

        self.assertEqual(detect_backdrop(image).kind, "checkerboard")

    def test_remove_backdrop_cleans_white_halo(self) -> None:
        image = Image.new("RGBA", (12, 12), (255, 255, 255, 255))
        for y in range(3, 9):
            for x in range(3, 9):
                image.putpixel((x, y), (24, 24, 24, 255))
        for point in [(2, 5), (5, 2), (9, 5), (5, 9)]:
            image.putpixel(point, (220, 220, 220, 255))

        cleaned, metrics = remove_backdrop(image)

        self.assertEqual(metrics["backdropKind"], "solid")
        self.assertEqual(cleaned.getpixel((0, 0))[3], 0)
        self.assertLess(cleaned.getpixel((2, 5))[3], 255)
        self.assertEqual(cleaned.getpixel((5, 5))[3], 255)

    def test_finds_alpha_components_with_padding(self) -> None:
        image = Image.new("RGBA", (48, 24), (0, 0, 0, 0))
        for y in range(4, 16):
            for x in range(3, 15):
                image.putpixel((x, y), (255, 0, 0, 255))
        for y in range(5, 18):
            for x in range(30, 44):
                image.putpixel((x, y), (0, 0, 255, 255))

        frames = find_alpha_components(image, min_area_frac=0.001, pad=2)

        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0].box["x"], 0)
        self.assertEqual(frames[1].box["x"], 27)

    def test_auto_slice_components_writes_padded_frames_and_manifest(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "sheet.png"
            out_dir = root / "frames"
            image = Image.new("RGBA", (64, 28), (255, 0, 255, 255))
            for y in range(4, 18):
                for x in range(4, 18):
                    image.putpixel((x, y), (16, 16, 16, 255))
            for y in range(3, 22):
                for x in range(36, 54):
                    image.putpixel((x, y), (32, 32, 32, 255))
            image.save(source)

            result = auto_slice_components(
                {
                    "frameIds": ["frame_01", "frame_02"],
                    "framesDir": str(out_dir),
                    "sheet": {
                        "minAreaFrac": 0.001,
                        "pad": 2,
                        "path": str(source),
                    },
                    "startIndex": 0,
                }
            )

            self.assertEqual(result["frameIds"], ["frame_01", "frame_02"])
            self.assertEqual(result["backdrop"]["backdropKind"], "magenta")
            self.assertEqual(len(result["manifest"]["frames"]), 2)
            self.assertTrue((out_dir / "frame_01.png").exists())
            self.assertTrue((out_dir / "frame_02.png").exists())


if __name__ == "__main__":
    unittest.main()
