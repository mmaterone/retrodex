from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image
from pixel_character_core.vision_to_pixel import plan_image
from pixel_character_core.editor_pixels import cell_to_rgba


class VisionPlannerTest(unittest.TestCase):
    def plan(self, image, **options):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'source.png'
            image.save(path)
            return plan_image({'sourcePath': str(path), 'canvas': {'width': image.width, 'height': image.height},
                               'preserveBackground': True, **options})

    def test_preserves_alpha_and_does_not_spend_colors_on_transparent_rgb(self):
        image = Image.new('RGBA', (8, 8), (0, 255, 0, 0))
        image.putpixel((1, 1), (255, 0, 0, 255))
        image.putpixel((2, 1), (0, 0, 255, 128))
        result = self.plan(image, maxColors=2)
        self.assertEqual(result['grid']['cells'][0], None)
        self.assertEqual(result['grid']['cells'][9], '#ff0000')
        self.assertEqual(result['grid']['cells'][10], '#0000ff80')
        self.assertEqual(set(result['palette']), {'#ff0000', '#0000ff'})

    def test_final_palette_budget_including_edge_darkening(self):
        image = Image.new('RGBA', (16, 16))
        image.putdata([(x * 16, y * 16, (x + y) * 8, 255) for y in range(16) for x in range(16)])
        result = self.plan(image, maxColors=4, edgeDarkening=True)
        colors = {cell[:7] for cell in result['grid']['cells'] if cell}
        self.assertLessEqual(len(colors), 4)

    def test_contain_keeps_whole_subject_and_transparent_padding(self):
        image = Image.new('RGBA', (8, 4), (255, 0, 0, 255))
        result = self.plan(image, canvas={'width': 8, 'height': 8})
        self.assertEqual(result['alphaBBox'], {'x': 0, 'y': 2, 'width': 8, 'height': 4})

    def test_default_keeps_transparent_subject_at_canvas_edges(self):
        image = Image.new('RGBA', (8, 8))
        image.putpixel((0, 0), (255, 0, 0, 255))
        image.putpixel((7, 7), (0, 0, 255, 255))
        result = self.plan(image, preserveBackground=False)
        self.assertEqual(result['grid']['cells'][0], '#ff0000')
        self.assertEqual(result['grid']['cells'][-1], '#0000ff')

    def test_uncertain_background_is_preserved(self):
        image = Image.new('RGBA', (8, 8))
        image.putdata([(x * 25, x * 25, x * 25, 255) for y in range(8) for x in range(8)])
        result = self.plan(image, preserveBackground=False)
        self.assertTrue(all(result['grid']['cells']))
        self.assertIn('background-preserved-uncertain', [d['code'] for d in result['diagnostics']])

    def test_empty_and_thresholded_images_remain_empty(self):
        for alpha in (0, 8):
            result = self.plan(Image.new('RGBA', (8, 8), (255, 0, 0, alpha)))
            self.assertEqual(result['palette'], [])
            self.assertIsNone(result['alphaBBox'])
            self.assertTrue(all(cell is None for cell in result['grid']['cells']))

    def test_nearest_recovers_exact_explicit_grid(self):
        image = Image.new('RGBA', (8, 8))
        image.putpixel((3, 2), (255, 255, 255, 255))
        image.putpixel((4, 2), (0, 0, 255, 255))
        enlarged = image.resize((64, 64), Image.Resampling.NEAREST)
        result = self.plan(enlarged, canvas={'width': 8, 'height': 8})
        self.assertEqual([cell_to_rgba(cell) for cell in result['grid']['cells']], list(image.getdata()))
