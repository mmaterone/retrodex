from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from pixel_character_core.ingest import materialize_frame


class IngestMaterializationTest(unittest.TestCase):
    def test_infer_hidden_grid_materializes_large_background_without_blur(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source.png"
            output = root / "frame_01.png"
            image = Image.new("RGBA", (1672, 940), (32, 16, 32, 255))
            for x in range(0, image.width, 5):
                for y in range(image.height):
                    image.putpixel((x, y), (96, 24, 48, 255))
            image.save(source)

            result = materialize_frame(
                {
                    "assetType": "background",
                    "gridStrategy": "infer-hidden-grid",
                    "outputPath": str(output),
                    "sourcePath": str(source),
                }
            )

            with Image.open(output) as materialized:
                self.assertEqual(materialized.size, (320, 180))
            self.assertEqual(result["gridInference"]["reason"], "estimated-hidden-imagegen-grid")
            self.assertGreaterEqual(result["gridInference"]["confidence"], 0.5)

    def test_preserve_source_keeps_small_editor_sized_frame(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source.png"
            output = root / "frame_01.png"
            Image.new("RGBA", (32, 32), (255, 255, 255, 255)).save(source)

            result = materialize_frame(
                {
                    "assetType": "icon",
                    "gridStrategy": "infer-hidden-grid",
                    "outputPath": str(output),
                    "sourcePath": str(source),
                }
            )

            with Image.open(output) as materialized:
                self.assertEqual(materialized.size, (32, 32))
            self.assertEqual(result["gridInference"]["reason"], "source-already-editor-sized")

    def test_infer_hidden_grid_collapses_large_icon_texture_to_logical_pixels(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source.png"
            output = root / "frame_01.png"
            image = Image.new("RGBA", (1254, 1254), (96, 128, 255, 255))
            for x in range(0, image.width, 22):
                for y in range(0, image.height, 22):
                    for dx in range(12):
                        for dy in range(12):
                            if x + dx < image.width and y + dy < image.height:
                                image.putpixel((x + dx, y + dy), (64, 96, 255, 255))
            image.save(source)

            result = materialize_frame(
                {
                    "assetType": "icon",
                    "gridStrategy": "infer-hidden-grid",
                    "outputPath": str(output),
                    "sourcePath": str(source),
                }
            )

            with Image.open(output) as materialized:
                self.assertEqual(materialized.size, (64, 64))
            self.assertEqual(result["gridInference"]["reason"], "estimated-hidden-imagegen-grid")
            self.assertGreaterEqual(result["gridInference"]["sourceCellSize"]["width"], 16)


if __name__ == "__main__":
    unittest.main()
