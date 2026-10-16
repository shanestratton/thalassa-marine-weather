"""Offline NZ renderer. Sparse source windows; no native-resolution mosaic."""
import hashlib
import io
import json
import math
import time
from pathlib import Path

from nz_coastal import (ROOT, RETAINED, PLAN_SHA, IMAGE, OUTPUT_CAP, INPUTS_PER_WINDOW,
                        ROI_CAP, candidate_blocks, check_deadline, checked_window,
                        rows_for_tiles, verify_file, reserve, collection_identity)
from build_au250 import BudgetWriter, workspace_size
from regional_plan import tile_range
from regional_sources import source_hash


def intersects(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def split_windows(bounds, width, height, sources, visit, offset=(0, 0)):
    """Partition in output-pixel space; retain all sources, at most eight per read window."""
    candidates = [row for row in sources if intersects(bounds, row['mercatorBounds'])]
    if len(candidates) <= INPUTS_PER_WINDOW:
        visit(bounds, width, height, candidates, offset)
        return
    if width < 2 or height < 2:
        raise ValueError('More than eight source grids overlap a single output pixel')
    left_width, top_height = width // 2, height // 2
    middle_x = bounds[0] + (bounds[2] - bounds[0]) * left_width / width
    middle_y = bounds[3] - (bounds[3] - bounds[1]) * top_height / height
    for child, w, h, dx, dy in (
        ((bounds[0], middle_y, middle_x, bounds[3]), left_width, top_height, 0, 0),
        ((middle_x, middle_y, bounds[2], bounds[3]), width-left_width, top_height, left_width, 0),
        ((bounds[0], bounds[1], middle_x, middle_y), left_width, height-top_height, 0, top_height),
        ((middle_x, bounds[1], bounds[2], middle_y), width-left_width, height-top_height, left_width, top_height),
    ):
        split_windows(child, w, h, candidates, visit, (offset[0] + dx, offset[1] + dy))


def mercator_bounds(bbox):
    west, south, east, north = bbox
    radius = 6378137
    return [math.radians(west)*radius, math.asinh(math.tan(math.radians(south)))*radius,
            math.radians(east)*radius, math.asinh(math.tan(math.radians(north)))*radius]


def inspect_source(path):
    from osgeo import gdal
    ds = gdal.Open(str(path), gdal.GA_ReadOnly)
    if not ds or ds.RasterCount != 1:
        raise ValueError('LINZ source is not the reviewed single-band grid')
    band, srs, gt = ds.GetRasterBand(1), ds.GetSpatialRef(), ds.GetGeoTransform()
    if (not srs or srs.GetAuthorityCode(None) != '2193' or srs.GetLinearUnits() != 1
            or band.GetNoDataValue() != -9999 or band.GetScale() not in (None, 1)
            or band.GetOffset() not in (None, 0) or band.GetUnitType() not in ('', 'm', 'metre', 'metres')
            or band.DataType != gdal.GDT_Float32 or gt[2] or gt[4] or gt[1] != 1 or gt[5] != -1
            or ds.RasterXSize <= 0 or ds.RasterYSize <= 0 or band.GetOverviewCount() < 1):
        raise ValueError('LINZ CRS, metre grid, NoData, scale, packing or overview changed')
    overview = band.GetOverview(band.GetOverviewCount()-1)
    if overview.XSize * overview.YSize * 4 > 16_000_000:
        raise ValueError('LINZ coarsest overview exceeds preflight read cap')
    import numpy as np
    sample = overview.ReadAsArray()
    finite = np.isfinite(sample) & (sample != -9999) & (sample > -12000) & (sample < 9000)
    return {'width': ds.RasterXSize, 'height': ds.RasterYSize, 'geotransform': list(gt),
            'crs': srs.ExportToWkt(), 'nodata': -9999, 'nativeUnit': band.GetUnitType(),
            'heightUnitAuthority': 'LINZ provider metadata: metres, NZVD2016; no vertical transform',
            'overviewSizes': [[band.GetOverview(i).XSize, band.GetOverview(i).YSize]
                              for i in range(band.GetOverviewCount())],
            'coarseFinitePixels': int(finite.sum()),
            'coarseSeafloorPixels': int((finite & (sample < -0.3)).sum())}


def source_window(row, bounds, width, height, spent):
    import numpy as np
    from osgeo import gdal, osr
    source = gdal.Open(row['path'], gdal.GA_ReadOnly)
    srs = source.GetSpatialRef()
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    merc = osr.SpatialReference()
    merc.ImportFromEPSG(3857)
    merc.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    options = osr.CoordinateTransformationOptions()
    options.SetBallparkAllowed(False)
    options.SetOnlyBest(True)
    transform = osr.CreateCoordinateTransformation(merc, srs, options)
    # Densified perimeter handles horizontal curvature; no compound/vertical CRS.
    coordinates = [(bounds[0] + (bounds[2]-bounds[0])*t/16, y)
                   for t in range(17) for y in (bounds[1], bounds[3])]
    coordinates += [(x, bounds[1] + (bounds[3]-bounds[1])*t/16)
                    for t in range(17) for x in (bounds[0], bounds[2])]
    corners = [transform.TransformPoint(x, y) for x, y in coordinates]
    if not all(math.isfinite(v) for point in corners for v in point[:2]):
        raise ValueError('Nonfinite strict horizontal transform')
    # Choose a native overview no coarser than half the target ground pixel.
    centre_lat = math.degrees(math.atan(math.sinh((bounds[1]+bounds[3])/2/6378137)))
    target = (bounds[2]-bounds[0])/width * math.cos(math.radians(centre_lat)) / 2
    band, level = source.GetRasterBand(1), -1
    for i in range(band.GetOverviewCount()):
        if source.RasterXSize/band.GetOverview(i).XSize <= target:
            level = i
    selected = gdal.Translate('', source, format='VRT', overviewLevel=level if level >= 0 else 'NONE')
    x, y, w, h = checked_window(selected.GetGeoTransform(), selected.RasterXSize, selected.RasterYSize, corners)
    spent[0] += w*h*4
    if spent[0] > ROI_CAP:
        raise ValueError('Aggregate decoded source ROI for this output block exceeds 256 MB')
    if not w or not h:
        return np.full((height, width), np.nan, dtype='float32')
    clipped = gdal.Translate('', selected, format='VRT', srcWin=[x, y, w, h])
    result = gdal.Warp('', clipped, options=gdal.WarpOptions(options=['-novshift'], format='MEM',
        outputBounds=bounds, dstSRS='EPSG:3857', width=width, height=height,
        resampleAlg='bilinear', outputType=gdal.GDT_Float32, srcNodata=-9999,
        dstNodata=float('nan'), multithread=False, overviewLevel='NONE', warpMemoryLimit=64,
        transformerOptions=['ONLY_BEST=YES', 'ALLOW_BALLPARK=NO']))
    return result.ReadAsArray().astype('float32')


def render_block(rows, x, y, zoom, deadline):
    import numpy as np
    from osgeo import gdal, ogr, osr
    from scipy import ndimage
    import encode_tiles as encoder
    import prove_regional as renderer
    left, _, _, top = encoder.tile_bounds(zoom, x, y)
    _, bottom, right, _ = encoder.tile_bounds(zoom, x+1, y+1)
    core, pad = 512, 128
    resolution = (right-left)/core
    bounds = (left-pad*resolution, bottom-pad*resolution, right+pad*resolution, top+pad*resolution)
    regional = np.full((768, 768), np.nan, dtype='float32')
    spent, maximum_inputs = [0], [0]
    def visit(window, width, height, candidates, offset):
        check_deadline(deadline)
        maximum_inputs[0] = max(maximum_inputs[0], len(candidates))
        piece = regional[offset[1]:offset[1]+height, offset[0]:offset[0]+width]
        for row in candidates:
            data = source_window(row, window, width, height, spent)
            valid = np.isfinite(data) & (data > -12000) & (data < 9000)
            np.copyto(piece, data, where=valid & ~np.isfinite(piece))
    split_windows(bounds, 768, 768, rows, visit)
    fallback = renderer.warp(str(renderer.GEBCO), bounds, 768)
    valid = np.isfinite(regional)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    land = gdal.GetDriverByName('MEM').Create('', 768, 768, 1, gdal.GDT_Byte)
    land.SetGeoTransform((bounds[0], resolution, 0, bounds[3], 0, -resolution))
    land.SetProjection(srs.ExportToWkt())
    polygons = ogr.Open(str(renderer.LAND), 0)
    layer = polygons.GetLayer(0)
    layer.SetSpatialFilterRect(*bounds)
    gdal.RasterizeLayer(land, [1], layer, burn_values=[1])
    latitude = encoder.tile_lat(zoom, y+1)
    distance = ndimage.distance_transform_edt(np.pad(valid, 1, constant_values=False))[1:-1, 1:-1]
    weight = np.clip(distance * resolution * math.cos(math.radians(latitude)) / 2000, 0, 1)
    mixed = renderer.blend_elevations(regional, fallback, valid, land.ReadAsArray() > 0, weight)
    section = (slice(pad, pad+core), slice(pad, pad+core))
    return mixed[section], valid[section], regional[section], spent[0], maximum_inputs[0]


def build(plan, deadline):
    import fcntl
    import numpy as np
    from PIL import Image
    from osgeo import gdal
    import encode_tiles as encoder
    import prove_regional as renderer
    gdal.UseExceptions()
    gdal.SetCacheMax(32*1024*1024)
    lock = (ROOT/'build.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    reserve(ROOT)
    rows, metadata = [], []
    for row in plan['sources']:
        check_deadline(deadline)
        path = RETAINED if row['id'] == 'AU26' else ROOT/'sources'/(row['id']+'.tiff')
        verify_file(path, row)
        observed = inspect_source(path)
        rows.append({**row, 'path': str(path), 'mercatorBounds': mercator_bounds(row['bbox'])})
        metadata.append({'id': row['id'], 'sha256': row['sha256'], 'bytes': row['bytes'], **observed})
    output = ROOT/'output'
    output.mkdir(exist_ok=True)
    writer = BudgetWriter(output, OUTPUT_CAP-10_000_000, workspace_size(output))
    recipe = {'schema': 1, 'planSha256': PLAN_SHA, 'image': IMAGE,
              'builder': source_hash(Path(__file__)), 'driver': source_hash(Path(__file__).with_name('nz_coastal.py')),
              'renderer': source_hash(Path(renderer.__file__)), 'encoder': source_hash(Path(encoder.__file__)),
              'implementationFiles': {name: source_hash(Path(__file__).with_name(name)) for name in
                  ('nz_render.py','nz_coastal.py','build_au250.py','regional_plan.py','regional_sources.py',
                   'prove_regional.py','encode_tiles.py')},
              'sources': metadata, 'generation': 'v2', 'verticalTransform': False,
              'overlapCorrection': 'Recursively subdivide pixel windows to <=8 inputs; aggregate decoded ROI <=256MB'}
    body = json.dumps(recipe, sort_keys=True, indent=2).encode()
    recipe_sha = hashlib.sha256(body).hexdigest()
    if (output/'recipe.json').exists() and (output/'recipe.json').read_bytes() != body:
        raise ValueError('NZ output recipe changed; preserve this generation')
    writer.write(output/'recipe.json', body)
    emitted, blocks, started, stats = [], candidate_blocks(rows), time.monotonic(), {}
    for number, (z, y, x) in enumerate(blocks, 1):
        check_deadline(deadline)
        stamp = output/'checkpoints'/f'{z}_{x}_{y}.json'
        if stamp.exists():
            if stamp.stat().st_size > 65536:
                raise ValueError('NZ checkpoint is oversized')
            checkpoint = json.loads(stamp.read_text())
            if checkpoint['recipe'] != recipe_sha or len(checkpoint['files']) != len(checkpoint['tiles'])*3:
                raise ValueError('NZ checkpoint identity changed')
            for file in checkpoint['files']:
                path = output/file['path']
                if not path.resolve().is_relative_to(output) or source_hash(path) != file['sha256']:
                    raise ValueError('NZ checkpoint output changed')
        else:
            mixed, coverage, native, decoded, maximum = render_block(rows, x, y, z, deadline)
            files, tiles, covered, coarse = [], [], 0, 0
            for dy in range(2):
                for dx in range(2):
                    tx, ty = x+dx, y+dy
                    # Only tile coordinates intersecting real approved footprints are eligible.
                    if not any(a <= tx <= c and b <= ty <= d for a,b,c,d in (tile_range(row['bbox'], z) for row in rows)):
                        continue
                    section = (slice(dy*256,(dy+1)*256), slice(dx*256,(dx+1)*256))
                    mask, elevation = coverage[section], mixed[section]
                    if not np.any(mask & (native[section] < -0.3) & (elevation < -0.3)):
                        continue
                    tiles.append([z, ty, tx])
                    covered += int(mask.sum())
                    coarse += int((~mask).sum())
                    buf = io.BytesIO()
                    Image.fromarray(mask.astype('uint8')*255, 'L').save(buf, 'PNG')
                    for kind, ext, data in (
                        ('dem','webp',encoder.webp_terrarium(elevation*encoder.EXAG)),
                        ('idx','png',encoder.png_l(encoder.encode_index(elevation))), ('coverage','png',buf.getvalue())):
                        if len(data) > 262144:
                            raise ValueError('NZ output tile exceeds app contract')
                        path = output/'v2'/'relief-nz'/kind/str(z)/str(tx)/f'{ty}.{ext}'
                        writer.write(path, data)
                        files.append({'path': path.relative_to(output).as_posix(), 'bytes': len(data),
                                      'sha256': hashlib.sha256(data).hexdigest()})
            checkpoint = {'recipe': recipe_sha, 'files': files, 'tiles': tiles,
                          'sourcePixels': covered, 'fallbackPixels': coarse,
                          'decodedRoiBytes': decoded, 'maximumInputsPerWindow': maximum}
            writer.write(stamp, json.dumps(checkpoint, sort_keys=True).encode())
        emitted.extend(checkpoint['tiles'])
        if len(emitted)*2 > 46886:
            raise ValueError('NZ exact footprint object upper bound exceeded')
        row = stats.setdefault(str(z), {'tilePairs': 0, 'sourcePixels': 0, 'fallbackPixels': 0})
        row['tilePairs'] += len(checkpoint['tiles'])
        for field in ('sourcePixels', 'fallbackPixels'):
            row[field] += checkpoint[field]
        if number % 25 == 0:
            print(json.dumps({'blocks': number, 'totalBlocks': len(blocks), 'zoom': z,
                'tilePairs': len(emitted), 'outputBytes': writer.used,
                'elapsedSeconds': round(time.monotonic()-started)}), flush=True)
        if number % 250 == 0:
            reserve(ROOT)
    availability = {'schema': 1, 'region': 'nz', 'version': 'v2', 'minzoom': 8, 'maxzoom': 14,
                    'tilePairs': len(emitted), 'rows': rows_for_tiles(emitted)}
    data = json.dumps(availability, separators=(',', ':')).encode()
    if len(data) > 1_000_000:
        raise ValueError('NZ exact availability exceeds bounded app metadata contract')
    writer.write(output/'v2'/'availability-nz.json', data)
    manifest = {'schema': 3, 'published': False, 'provider': 'LINZ', 'generation': 'v2',
                'dataset': 'NZ Coastal LiDAR1m DEM surveyed coastal patches; GEBCO fallback',
                'verticalDatum': 'NZVD2016; no vertical transformation to MSL',
                'licence': 'CC-BY-4.0', 'attribution': 'Derived from LINZ NZ Coastal LiDAR DEM, CC BY4.0; '
                'GEBCO2026; OpenStreetMap land mask ODbL. Not for navigation.',
                'recipeSha256': recipe_sha, 'availabilitySha256': hashlib.sha256(data).hexdigest(),
                'availabilityBytes': len(data), 'perZoom': stats, 'uploadObjects': len(emitted)*2,
                'outputBytesBeforeManifest': writer.used, 'purpose': 'Illustrative display only',
                **collection_identity(plan), 'sourceFootprints': [r['geometry'] for r in rows]}
    writer.write(output/'v2'/'manifest-nz.json', json.dumps(manifest, indent=2).encode())
    print(json.dumps({'complete': True, 'published': False, 'tilePairs': len(emitted),
                      'outputBytes': writer.used, 'recipeSha256': recipe_sha}), flush=True)
