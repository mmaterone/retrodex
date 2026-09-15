from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from PIL import Image
from pixel_character_core.pixel_grid_cleanup import sample_pixel_cells
from pixel_character_core.worker import WorkerJob, run_cleanup

class PixelGridCleanupTest(unittest.TestCase):
    def test_exact_enlarged_grid_is_recovered_without_color_changes(self):
        source = Image.new('RGBA', (2, 2))
        source.putdata([(255,0,0,255),(0,255,0,128),(0,0,255,255),(20,30,40,255)])
        actual, metrics = sample_pixel_cells(source.resize((16,16),Image.Resampling.NEAREST),8)
        self.assertEqual(actual.tobytes(), source.tobytes())
        self.assertEqual(metrics['sourceNearlyFlatCellFraction'],1)

    def test_median_rejects_boundary_and_single_pixel_noise(self):
        source = Image.new('RGBA',(8,8),(255,0,255,255))
        for y in range(2,6):
            for x in range(2,6):source.putpixel((x,y),(80,100,120,255))
        source.putpixel((3,3),(255,255,255,255))
        actual, metrics = sample_pixel_cells(source,8)
        self.assertEqual(actual.getpixel((0,0)),(80,100,120,255))
        self.assertEqual(metrics['sourceNearlyFlatCellFraction'],0)

    def test_non_divisible_grid_is_rejected(self):
        with self.assertRaises(ValueError):sample_pixel_cells(Image.new('RGBA',(15,16)),8)

    def test_worker_is_idempotent_and_enforces_opaque_palette(self):
        with TemporaryDirectory() as directory:
            root=Path(directory); source=root/'raw.png'; output=root/'clean.png'
            im=Image.new('RGBA',(32,32));im.putdata([(x*8,y*8,80,180) for y in range(32) for x in range(32)]);im.save(source)
            pipeline={'id':'test-grid','steps':[{'id':'set-opaque-alpha'},{'id':'sample-pixel-grid','params':{'cellSize':8}},{'id':'quantize-palette','params':{'maxColors':4}},{'id':'score-frame'}]}
            def job(path):return WorkerJob(root/'qc.json','frame_01',path,'test',output,[],pipeline,{'id':'test','canvas':{'width':4,'height':4},'presetId':'artwork.imagegen-grid.v1'})
            result=run_cleanup(job(source));first=Image.open(output).tobytes()
            self.assertEqual(result['frame']['canvas'],{'width':4,'height':4})
            self.assertLessEqual(len(result['frame']['palette']['colors']),4)
            self.assertEqual(Image.open(output).getchannel('A').getextrema(),(255,255))
            run_cleanup(job(output));self.assertEqual(Image.open(output).tobytes(),first)

    def test_refined_coverage_palette_preserves_alpha_and_color_budget(self):
        from pixel_character_core.vision_to_pixel import _quantize
        image=Image.new('RGBA',(16,16));image.putdata([(x*16,y*16,80,128 if x else 0) for y in range(16) for x in range(16)])
        result=_quantize(image,8,Image.Quantize.MAXCOVERAGE,4)
        self.assertEqual(result.getchannel('A').tobytes(),image.getchannel('A').tobytes())
        visible={p[:3] for p in result.getdata() if p[3]}
        self.assertLessEqual(len(visible),8)
