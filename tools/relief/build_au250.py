#!/usr/bin/env python3
"""Offline AU-only generation. Default prints a no-op plan; never uploads or serves."""
import argparse
import hashlib
import io
import json
import math
import os
import time
from pathlib import Path

from regional_plan import PROFILES, plan_region, tile_range
from regional_sources import PROOF_ROOT, SOURCES, source_hash

ROOT = Path('/srv/weather/thalassa-relief135-build')
OUTPUT_LIMIT = 4_000_000_000
WORKSPACE_LIMIT = 16_000_000_000
OBJECT_LIMIT = 116388


def workspace_size(root):
    total = 0
    for directory, dirs, files in os.walk(root):
        for name in [*dirs, *files]:
            if (Path(directory) / name).is_symlink():
                raise ValueError('Symbolic links are forbidden in the isolated build workspace')
        for name in files:
            total += (Path(directory) / name).stat().st_size
    return total


class BudgetWriter:
    def __init__(self, root, limit, used=0):
        self.root, self.limit, self.used = root.resolve(), limit, used

    def write(self, path, data):
        if not path.resolve().is_relative_to(self.root) or path.is_symlink():
            raise ValueError('Output escapes the reviewed build workspace')
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + '.partial')
        if temporary.exists():
            if temporary.is_symlink():
                raise ValueError('Unexpected temporary link')
            size = temporary.stat().st_size
            temporary.unlink()  # Exact generated temporary file only; preserve all completed data.
            self.used -= size
        old = path.stat().st_size if path.exists() else 0
        if self.used + len(data) > self.limit:
            raise ValueError('AU output byte cap reached before writing')
        with temporary.open('xb') as output:
            output.write(data)
        temporary.replace(path)
        self.used += len(data) - old


def build():
    import fcntl
    import numpy as np
    from osgeo import gdal
    from PIL import Image
    import encode_tiles as encoder
    import prove_regional as renderer
    if ROOT.resolve() != ROOT or PROOF_ROOT.resolve() != PROOF_ROOT:
        raise ValueError('Build requires the reviewed weather-volume paths')
    ROOT.mkdir(parents=True, exist_ok=True)
    lock = (ROOT / 'build.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    input_size, output_size = workspace_size(PROOF_ROOT), workspace_size(ROOT)
    if input_size + output_size > WORKSPACE_LIMIT or output_size > OUTPUT_LIMIT:
        raise ValueError('Reviewed expanded-plus-output workspace cap exceeded')
    if os.statvfs(ROOT).f_bavail * os.statvfs(ROOT).f_frsize < 20_000_000_000:
        raise ValueError('Keep at least 20 GB disk reserve before starting this bounded build')
    receipt_file = PROOF_ROOT / 'acquisition.json'
    if receipt_file.stat().st_size > 65536:
        raise ValueError('Acquisition receipt exceeds metadata cap')
    receipt = json.loads(receipt_file.read_text())['au250']
    raster = [row for row in receipt['rasters'] if row['path'].endswith('_MSL_cog.tif')]
    if len(raster) != 1 or receipt['sha256'] != SOURCES['au250']['sha256']:
        raise ValueError('Expected reviewed GA source receipt is missing')
    source_path = Path(raster[0]['path'])
    if not source_path.resolve().is_relative_to(PROOF_ROOT) or source_hash(source_path) != SOURCES['au250']['rasterSha256']:
        raise ValueError('Reviewed GA height raster changed')
    source = gdal.Open(str(source_path), gdal.GA_ReadOnly)
    if source.RasterCount != 1:
        raise ValueError('Expected the reviewed single-band GA raster')
    recipe = {'schema': 1, 'provider': 'au250', 'generation': 'v2',
              'source': SOURCES['au250'], 'profile': PROFILES['au250'],
              'builder': source_hash(Path(__file__)),
              'renderer': source_hash(Path(renderer.__file__)),
              'encoder': source_hash(Path(encoder.__file__)), 'image': renderer.IMAGE_ID}
    recipe_bytes = json.dumps(recipe, sort_keys=True, indent=2).encode()
    recipe_hash = hashlib.sha256(recipe_bytes).hexdigest()
    recipe_file = ROOT / 'recipe.json'
    if recipe_file.exists() and recipe_file.read_bytes() != recipe_bytes:
        raise ValueError('Existing generation has a different recipe; preserve it for review')
    # Reserve bounded room for this process's progress log and Python metadata.
    writer = BudgetWriter(ROOT, min(OUTPUT_LIMIT, WORKSPACE_LIMIT - input_size) - 10_000_000, output_size)
    writer.write(recipe_file, recipe_bytes)
    profile = PROFILES['au250']
    output = ROOT / 'v2' / 'relief-au250'
    uploads, stats, began = 0, {}, time.monotonic()
    for zoom in range(profile['minzoom'], profile['maxzoom'] + 1):
        x0, y0, x1, y1 = tile_range(profile['bounds'], zoom)
        stats[str(zoom)] = {'tilePairs': 0, 'sourcePixels': 0, 'coarsePixels': 0, 'bytes': 0}
        done = 0
        for y in range(y0 // 2 * 2, y1 + 1, 2):
            for x in range(x0 // 2 * 2, x1 + 1, 2):
                stamp = ROOT / 'work' / f'{zoom}_{x}_{y}.json'
                if stamp.exists():
                    if stamp.stat().st_size > 65536:
                        raise ValueError('Block checkpoint exceeds metadata cap')
                    checkpoint = json.loads(stamp.read_text())
                    if checkpoint['recipe'] != recipe_hash:
                        raise ValueError('Checkpoint recipe changed')
                    if not 0 <= checkpoint['tilePairs'] <= 4 or len(checkpoint['files']) != checkpoint['tilePairs'] * 3:
                        raise ValueError('Invalid block checkpoint tile count')
                    for file in checkpoint['files']:
                        path = ROOT / file['path']
                        if not path.resolve().is_relative_to(ROOT) or source_hash(path) != file['sha256']:
                            raise ValueError('Checkpoint output missing or changed')
                else:
                    mixed, coverage, _ = renderer.render_block(source, x, y, zoom, encoder.tile_lat(zoom, y + 1))
                    files, tile_pairs, covered, coarse, byte_count = [], 0, 0, 0, 0
                    for dy in range(2):
                        for dx in range(2):
                            tx, ty = x + dx, y + dy
                            if not (x0 <= tx <= x1 and y0 <= ty <= y1):
                                continue
                            window = (slice(dy * 256, (dy + 1) * 256), slice(dx * 256, (dx + 1) * 256))
                            elevation, mask = mixed[window], coverage[window]
                            if not mask.any() or not (elevation < -0.3).any():
                                continue
                            tile_pairs += 1
                            covered += int(mask.sum())
                            coarse += int((~mask).sum())
                            buf = io.BytesIO()
                            Image.fromarray(mask.astype('uint8') * 255, 'L').save(buf, 'PNG')
                            for kind, extension, body in (
                                ('idx', 'png', encoder.png_l(encoder.encode_index(elevation))),
                                ('dem', 'webp', encoder.webp_terrarium(elevation * encoder.EXAG)),
                                ('coverage', 'png', buf.getvalue()),
                            ):
                                if len(body) > 256 * 1024:
                                    raise ValueError('Generated tile exceeds the app size contract')
                                path = output / kind / str(zoom) / str(tx) / f'{ty}.{extension}'
                                writer.write(path, body)
                                files.append({'path': path.relative_to(ROOT).as_posix(), 'bytes': len(body),
                                              'sha256': hashlib.sha256(body).hexdigest()})
                                byte_count += len(body)
                    checkpoint = {'recipe': recipe_hash, 'files': files, 'tilePairs': tile_pairs,
                                  'sourcePixels': covered, 'coarsePixels': coarse, 'bytes': byte_count}
                    writer.write(stamp, json.dumps(checkpoint, sort_keys=True).encode())
                row = stats[str(zoom)]
                for field in row:
                    row[field] += checkpoint[field]
                uploads += checkpoint['tilePairs'] * 2
                if uploads > OBJECT_LIMIT:
                    raise ValueError('AU DEM/index object cap reached')
                done += 1
                if done % 25 == 0:
                    print(json.dumps({'zoom': zoom, 'blocks': done, 'uploadObjects': uploads,
                                      'outputBytes': writer.used, 'elapsedSeconds': round(time.monotonic() - began)}), flush=True)
        print(json.dumps({'completedZoom': zoom, **stats[str(zoom)]}), flush=True)
    manifest = {'schema': 2, 'generation': 'v2', 'published': False, 'recipeSha256': recipe_hash,
                'purpose': 'Illustrative relief only; not for navigation or depth sampling',
                'provider': SOURCES['au250'], 'bounds': profile['bounds'], 'verticalTransform': False,
                'minzoom': 8, 'maxzoom': 10, 'perZoom': stats, 'uploadObjects': uploads,
                'coverage': 'Local per-pixel QA masks; source holes filled by GEBCO; no regional data means no tile',
                'attribution': 'Derived from Geoscience Australia AusBathyTopo Australia 2026 250m, CC BY 4.0, Commonwealth of Australia; GEBCO 2026; OpenStreetMap land mask (ODbL). Not for navigation.'}
    writer.write(ROOT / 'v2' / 'manifest-au250.json', json.dumps(manifest, indent=2).encode())
    print(json.dumps({'complete': True, 'published': False, 'objects': uploads, 'outputBytes': writer.used,
                      'elapsedSeconds': round(time.monotonic() - began), 'recipeSha256': recipe_hash}), flush=True)
    lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true', help='Run the reviewed AU-only offline generation')
    args = parser.parse_args()
    if args.build:
        build()
    else:
        print(json.dumps({'noOp': True, 'root': str(ROOT), 'profile': plan_region(PROFILES['au250']),
                          'outputCap': OUTPUT_LIMIT, 'workspaceCap': WORKSPACE_LIMIT,
                          'objectsCap': OBJECT_LIMIT, 'uploads': False}, indent=2))


if __name__ == '__main__':
    main()
