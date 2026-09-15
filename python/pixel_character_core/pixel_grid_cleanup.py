"""Explicit-grid reconstruction for generated full-canvas pixel artwork."""
from __future__ import annotations

from PIL import Image, ImageStat


def sample_pixel_cells(image: Image.Image, cell_size: int, margin_ratio: float = 0.25):
    """Sample cell interiors, avoiding noisy boundaries; never infer a grid here."""
    if cell_size < 1 or image.width % cell_size or image.height % cell_size:
        raise ValueError('Source dimensions must be exact multiples of the requested pixel cell size.')
    if not 0 <= margin_ratio < 0.5:
        raise ValueError('Cell sampling margin must be between 0 and 0.5 (exclusive).')
    source = image.convert('RGBA')
    margin = min((cell_size - 1) // 2, int(cell_size * margin_ratio))
    size = source.width // cell_size, source.height // cell_size
    result = Image.new('RGBA', size)
    cells = []
    nearly_flat = 0
    total_stddev = 0.0
    for y in range(0, source.height, cell_size):
        for x in range(0, source.width, cell_size):
            tile = source.crop((x, y, x + cell_size, y + cell_size))
            nearly_flat += int(all(high - low <= 8 for low, high in tile.getextrema()[:3]))
            total_stddev += sum(ImageStat.Stat(tile).stddev[:3]) / 3
            inner = tile.crop((margin, margin, cell_size - margin, cell_size - margin))
            cells.append(tuple(int(value) for value in ImageStat.Stat(inner).median))
    result.putdata(cells)
    count = size[0] * size[1]
    return result, {
        'cellSize': cell_size,
        'sampleMarginRatio': margin_ratio,
        'logicalWidth': size[0], 'logicalHeight': size[1],
        'sourceNearlyFlatCellFraction': round(nearly_flat / count, 5),
        'sourceMeanCellStddev': round(total_stddev / count, 5),
        'gridBasis': 'explicit-generation-contract-not-inferred',
    }
