#!/usr/bin/env python3
"""Decode two reviewed public rasters into four tile pairs each. Never publishes."""
import hashlib
import json
import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image
from scipy import ndimage

import encode_tiles as encoder
import regional_sources as source_tools
from regional_sources import PROOF_ROOT, SOURCES, TRANSFORM_GRID, source_hash

gdal.UseExceptions()
gdal.SetCacheMax(32 * 1024 * 1024)
encoder.ARGS = SimpleNamespace(webp_method=4)
GEBCO = Path('/srv/relief/src/gebco/gebco_2026.vrt')
LAND = Path('/srv/relief/src/osm/land.gpkg')
IMAGE_ID = 'sha256:57b20fcd82df868582b1a024f7b00f181e0614950b7a7046b02a5d5cd3c2bb2e'


def warp(source, bounds, size):
    # Reproject the horizontal coordinates only. Keep provider height values
    # in their native vertical datum; this is illustrative relief, not depth.
    options = gdal.WarpOptions(options=['-novshift'], format='MEM', outputBounds=bounds,
                               dstSRS='EPSG:3857', width=size, height=size,
                               resampleAlg='bilinear', outputType=gdal.GDT_Float32,
                               dstNodata=float('nan'), multithread=False,
                               transformerOptions=['ONLY_BEST=YES', 'ALLOW_BALLPARK=NO'],
                               warpMemoryLimit=64)
    return gdal.Warp('', source, options=options).ReadAsArray().astype('float32')


def blend_elevations(regional, fallback, valid, land, weight):
    coarse_valid = np.isfinite(fallback) & (fallback > -12000) & (fallback < 9000)
    if np.any(~land & ~valid & ~coarse_valid):
        raise ValueError('Unknown water has neither regional data nor a valid coarse fallback')
    weight = np.where(valid & ~coarse_valid, 1, weight)
    mixed = np.where(valid, np.nan_to_num(regional) * weight + np.where(coarse_valid, fallback, 0) * (1 - weight), fallback)
    return np.where(land | ~(mixed < 0), 0, mixed).astype('float32')


def render_block(source, x, y, zoom, latitude):
    """One padded 2x2 block; finite source mask and coarse fallback stay separate."""
    left, _, _, top = encoder.tile_bounds(zoom, x, y)
    _, bottom, right, _ = encoder.tile_bounds(zoom, x + 1, y + 1)
    core, pad = 512, 128
    resolution = (right - left) / core
    bounds = (left - pad * resolution, bottom - pad * resolution,
              right + pad * resolution, top + pad * resolution)
    size = core + 2 * pad
    regional = warp(source, bounds, size)
    fallback = warp(str(GEBCO), bounds, size)
    valid = np.isfinite(regional) & (regional > -12000) & (regional < 9000)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    land = gdal.GetDriverByName('MEM').Create('', size, size, 1, gdal.GDT_Byte)
    land.SetGeoTransform((bounds[0], resolution, 0, bounds[3], 0, -resolution))
    land.SetProjection(srs.ExportToWkt())
    polygons = ogr.Open(str(LAND), 0)
    layer = polygons.GetLayer(0)
    layer.SetSpatialFilterRect(*bounds)
    gdal.RasterizeLayer(land, [1], layer, burn_values=[1])
    ground_pixel = resolution * math.cos(math.radians(latitude))
    distance = ndimage.distance_transform_edt(np.pad(valid, 1, constant_values=False))[1:-1, 1:-1]
    weight = np.clip(distance * ground_pixel / 2000, 0, 1)
    # Holes use the original coarse relief. They never turn into invented 0m
    # seabed, and the independent coverage mask never labels them regional.
    mixed = blend_elevations(regional, fallback, valid, land.ReadAsArray() > 0, weight)
    interior = (slice(pad, pad + core), slice(pad, pad + core))
    mixed, coverage = mixed[interior], valid[interior]
    return mixed, coverage, [left, bottom, right, top]


def prove(key, source_path, lon, lat, zoom, receipt):
    if source_path.resolve().is_relative_to(PROOF_ROOT) is False:
        raise ValueError('Source must stay in the reviewed weather-volume directory')
    source = gdal.Open(str(source_path), gdal.GA_ReadOnly)
    if source.RasterCount != 1:
        raise ValueError('Only the reviewed single-band height grid is supported')
    band = source.GetRasterBand(1)
    gt = source.GetGeoTransform()
    x, y = (math.floor(value) for value in encoder.lonlat_to_tile(lon, lat, zoom))
    mixed, coverage, block_bounds = render_block(source, x, y, zoom, lat)
    recipe = hashlib.sha256(json.dumps({'recipe': 1, 'provider': key,
                                       'source': receipt['sha256'], 'zoom': zoom,
                                       'x': x, 'y': y, 'encoder': source_hash(Path(encoder.__file__)),
                                       'builder': source_hash(Path(__file__)),
                                       'sourceTools': source_hash(Path(source_tools.__file__)),
                                       'image': IMAGE_ID,
                                       'horizontalGrid': TRANSFORM_GRID['sha256']},
                                      sort_keys=True).encode()).hexdigest()
    output = PROOF_ROOT / 'tiles' / key / recipe[:16]
    if output.is_symlink():
        raise ValueError('Proof output must not be a symbolic link')
    output.mkdir(parents=True, exist_ok=True)
    tiles = []
    for dy in range(2):
        for dx in range(2):
            section = (slice(dy * 256, (dy + 1) * 256), slice(dx * 256, (dx + 1) * 256))
            prefix = f'{zoom}_{x + dx}_{y + dy}'
            idx = output / f'{prefix}.png'
            dem = output / f'{prefix}.webp'
            mask = output / f'{prefix}.coverage.png'
            idx.write_bytes(encoder.png_l(encoder.encode_index(mixed[section])))
            dem.write_bytes(encoder.webp_terrarium(mixed[section] * encoder.EXAG))
            Image.fromarray(coverage[section].astype('uint8') * 255, 'L').save(mask, 'PNG')
            for path in (idx, dem, mask):
                with Image.open(path) as image:
                    image.load()
                    if image.size != (256, 256):
                        raise ValueError('Output tile dimensions changed')
            tiles.append({'z': zoom, 'x': x + dx, 'y': y + dy,
                          'sourcePixels': int(coverage[section].sum()),
                          'waterPixels': int((mixed[section] < 0).sum()),
                          'files': [{'name': path.name, 'bytes': path.stat().st_size,
                                     'sha256': source_hash(path)} for path in (idx, dem, mask)]})
    projection = osr.SpatialReference(wkt=source.GetProjection())
    result = {'provider': key, 'proofOnly': True, 'published': False, 'recipeSha256': recipe,
              'source': SOURCES[key], 'inputSha256': receipt['sha256'],
              'gdalVersion': gdal.VersionInfo('--version'),
              'containerImage': IMAGE_ID,
              'nativeGrid': {'width': source.RasterXSize, 'height': source.RasterYSize,
                             'geotransform': list(gt), 'crs': projection.ExportToWkt(),
                             'nodata': str(band.GetNoDataValue()), 'unit': band.GetUnitType()},
              'verticalTransform': False, 'purpose': 'Seafloor illustration only; not for navigation',
              'coverage': 'Actual finite source pixels; explicit mask. Coarse GEBCO fills holes.',
              'tileBounds3857': block_bounds,
              'sourceCoveredPixels': int(coverage.sum()),
              'coarseFallbackPixels': int((~coverage).sum()),
              'fallbackWaterPixels': int(((~coverage) & (mixed < 0)).sum()),
              'outputDirectory': str(output), 'tiles': tiles}
    (output / 'proof.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'provider': key, 'tiles': len(tiles),
                      'sourcePixels': sum(tile['sourcePixels'] for tile in tiles),
                      'waterPixels': sum(tile['waterPixels'] for tile in tiles),
                      'outputBytes': sum(file['bytes'] for tile in tiles for file in tile['files']),
                      'outputDirectory': str(output)}), flush=True)
    return result


def main():
    receipt_path = PROOF_ROOT / 'acquisition.json'
    if receipt_path.stat().st_size > 65536:
        raise ValueError('Acquisition receipt exceeds metadata limit')
    receipts = json.loads(receipt_path.read_text())
    grid = PROOF_ROOT / 'proj' / TRANSFORM_GRID['name']
    if source_hash(grid) != TRANSFORM_GRID['sha256']:
        raise ValueError('Required horizontal projection grid is missing or changed')
    osr.SetPROJSearchPaths([str(grid.parent), *osr.GetPROJSearchPaths()])
    for key, expected in SOURCES.items():
        if receipts[key]['sha256'] != expected['sha256']:
            raise ValueError('Acquisition receipt does not identify the reviewed source')
    candidates = [Path(row['path']) for row in receipts['au250']['rasters'] if row['path'].endswith('_MSL_cog.tif')]
    if len(candidates) != 1:
        raise ValueError('Reviewed GA height raster missing or ambiguous')
    if source_hash(candidates[0]) != SOURCES['au250']['rasterSha256']:
        raise ValueError('Extracted GA grid hash changed')
    if source_hash(Path(receipts['pr']['path'])) != SOURCES['pr']['sha256']:
        raise ValueError('NOAA raster hash changed')
    prove('au250', candidates[0], 115.7, -32.1, 10, receipts['au250'])
    # Deliberately straddle the raster's west edge: prove actual source holes
    # stay masked and fall through to coarse GEBCO, rather than becoming zero.
    prove('pr', Path(receipts['pr']['path']), -66.01, 17.9, 13, receipts['pr'])


if __name__ == '__main__':
    main()
