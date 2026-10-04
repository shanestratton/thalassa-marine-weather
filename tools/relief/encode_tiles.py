#!/usr/bin/env python3
"""Build Thalassa's seafloor "Relief" base tiles.

Two pyramids of 256 px Web Mercator (EPSG:3857) XYZ tiles:

  relief-global  GEBCO 2026 (15", ice surface), z0-9
  relief-au      GA Great Barrier Reef 2020 30 m grids A-D, merged over GEBCO
                 with a feathered edge, z8-13, only tiles that touch GBR data

Land is decided by OpenStreetMap's land polygons (osmdata.openstreetmap.de,
EPSG:3857), rasterised per block: anything on land, or at/above 0 m, is 0 m.
That keeps the tint off ground that lies below sea level (the Netherlands
polders, Lake Eyre, the Caspian depression) and puts the tint's edge on the
same OSM coastline Mapbox draws. GEBCO's TID grid cannot do this: it codes
those depressions as data (TID 40/44/70), not as land.

Each pyramid has two tile sets, written under OUT/<pyramid>/:

  dem/{z}/{x}/{y}.webp  Terrarium RGB (elev = R*256 + G + B/256 - 32768),
                        lossless WebP, for the hillshade ONLY. Land is clamped
                        to 0 m. One vertical exaggeration (x3) is baked into
                        both pyramids and the value is quantised to whole
                        metres (B = 0). It must be the same everywhere: an
                        exaggeration that changes across the GBR feather turns
                        a depth d into a fake cliff of (change x d) over 2 km.
                        relief-au z11-13 is smoothed with a sigma=1 px gaussian
                        to soften survey-swath edges.
  idx/{z}/{x}/{y}.png   8-bit depth index for the colour ramp, from the
                        UN-exaggerated, UN-smoothed depth d (metres, +down):
                          0                                      land / d <= 0.3 m
                          1 + round(253 * ln(1 + d/2) / ln(3001)) water (d clipped to 6000)
                        This is encode_index() from the Obs prototype
                        (proto/server.py), unchanged. Grey (L) PNG: a browser
                        decodes it to R = G = B = index, which is what the
                        app's raster-color-mix [255, 0, 0, 0] reads.

Tiles whose every pixel is land (index 0) are not written: the app sees 404
and draws plain vector water/land there.

Runs inside the osgeo/gdal docker image (+ scipy, pillow); see build_relief.sh.
Resumable: each finished block leaves a JSON stamp under WORK/done/.
"""
import argparse
import io
import json
import math
import os
import sys
import time
from multiprocessing import Pool

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image
from scipy import ndimage

gdal.UseExceptions()

R = 6378137.0
HALF = math.pi * R
TILE = 256

# GBR 30 m 2020 grids (GA eCat 115066), nominal footprints, lon/lat.
GBR_BBOX = (142.0, -29.0, 156.0, -10.0)
FEATHER_M = 2000.0          # feathered blend at every GBR grid edge
# One exaggeration for every source. v1's first build used x4 on GBR 30 m and
# x3 on GEBCO, blended across the 2 km feather: at the grids' outer edges in
# deep water that baked a 1.7-4.5 km cliff into the DEM (measured at 154E,
# 156E and 147E), and the hillshade drew every grid edge as a straight line.
# Shallow-water relief is tuned in the app (hillshade-exaggeration paint).
EXAG = 3.0
TERRARIUM_MIN = -32760.0

ARGS = None
DS = {}


# ---------------------------------------------------------------- geometry

def tile_bounds(z, x, y):
    size = 2 * HALF / 2 ** z
    minx = -HALF + x * size
    maxy = HALF - y * size
    return minx, maxy - size, minx + size, maxy


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(max(min(lat, 85.0511), -85.0511))
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def tile_lat(z, y):
    """Latitude (degrees) of the top edge of tile row y."""
    n = math.pi - 2.0 * math.pi * y / 2 ** z
    return math.degrees(math.atan(math.sinh(n)))


# ---------------------------------------------------------------- encoders

def encode_index(a):
    """Exact copy of proto/server.py encode_index's mapping (a = elevation, m)."""
    d = -np.nan_to_num(a, nan=0.0)  # depth, positive down
    f = np.log1p(np.clip(d, 0, 6000) / 2.0) / math.log1p(3000.0)
    return np.where(d > 0.3, 1 + np.round(253 * np.clip(f, 0, 1)), 0).astype('uint8')


def png_l(idx):
    buf = io.BytesIO()
    Image.fromarray(idx, 'L').save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def webp_terrarium(elev_exag):
    """Terrarium, whole metres, land 0, lossless WebP."""
    v = np.round(np.clip(np.nan_to_num(elev_exag, nan=0.0), TERRARIUM_MIN, 0.0)) + 32768.0
    r = np.floor(v / 256.0)
    g = v - r * 256.0
    rgb = np.dstack([r, g, np.zeros_like(r)]).astype('uint8')
    buf = io.BytesIO()
    Image.fromarray(rgb, 'RGB').save(buf, 'WEBP', lossless=True, quality=100, method=ARGS.webp_method, exact=True)
    return buf.getvalue()


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def down2(a):
    h, w = a.shape
    return a.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3), dtype='float64').astype('float32')


# ---------------------------------------------------------------- sources

def open_sources():
    DS['gebco'] = gdal.Open(ARGS.gebco)
    DS['land'] = ogr.Open(ARGS.land)
    DS['srs'] = osr.SpatialReference()
    DS['srs'].ImportFromEPSG(3857)
    DS['gbr'] = [gdal.Open(p) for p in ARGS.gbr] if ARGS.gbr else []
    DS['gbr_bbox'] = []
    for ds in DS['gbr']:
        gt = ds.GetGeoTransform()
        x0, y0 = gt[0], gt[3]
        x1, y1 = x0 + gt[1] * ds.RasterXSize, y0 + gt[5] * ds.RasterYSize
        DS['gbr_bbox'].append((min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))


def warp(src, bounds, size, resample):
    ds = gdal.Warp('', src, format='MEM', outputBounds=bounds, dstSRS='EPSG:3857',
                   width=size, height=size, resampleAlg=resample, outputType=gdal.GDT_Float32,
                   dstNodata=float('nan'), multithread=False, warpMemoryLimit=512)
    return ds.GetRasterBand(1).ReadAsArray().astype('float32')


def land_mask(bounds, size):
    """OSM land polygons rasterised onto the block (pixel centres): True = land."""
    ds = gdal.GetDriverByName('MEM').Create('', size, size, 1, gdal.GDT_Byte)
    res = (bounds[2] - bounds[0]) / size
    ds.SetGeoTransform((bounds[0], res, 0.0, bounds[3], 0.0, -res))
    ds.SetProjection(DS['srs'].ExportToWkt())
    lyr = DS['land'].GetLayer(0)
    lyr.SetSpatialFilterRect(bounds[0], bounds[1], bounds[2], bounds[3])
    gdal.RasterizeLayer(ds, [1], lyr, burn_values=[1])
    lyr.SetSpatialFilter(None)
    return ds.GetRasterBand(1).ReadAsArray() > 0


def gebco_elev(bounds, size, land):
    """GEBCO elevation with land (OSM land, or anything >= 0 m) clamped to 0."""
    e = warp(DS['gebco'], bounds, size, 'bilinear')
    return np.where(land | ~(e < 0), 0.0, e).astype('float32')


def bbox_3857_to_lonlat(b):
    lon0 = math.degrees(b[0] / R)
    lon1 = math.degrees(b[2] / R)
    lat0 = math.degrees(2 * math.atan(math.exp(b[1] / R)) - math.pi / 2)
    lat1 = math.degrees(2 * math.atan(math.exp(b[3] / R)) - math.pi / 2)
    return lon0, lat0, lon1, lat1


def overlaps(a, b):
    return not (a[2] <= b[0] or a[0] >= b[2] or a[3] <= b[1] or a[1] >= b[3])


# ---------------------------------------------------------------- tiles

def emit(pyr, z, x0, y0, elev, dem, stats, extra_keep=None):
    """Write every tile of a level array whose top-left tile is (x0, y0)."""
    n = elev.shape[0] // TILE
    out = os.path.join(ARGS.out, pyr)
    lv = stats.setdefault(str(z), {'tiles': 0, 'dem_bytes': 0, 'idx_bytes': 0, 'skipped_land': 0, 'skipped_nogbr': 0})
    for ty in range(n):
        for tx in range(n):
            sl = (slice(ty * TILE, (ty + 1) * TILE), slice(tx * TILE, (tx + 1) * TILE))
            idx = encode_index(elev[sl])
            if not idx.any():
                lv['skipped_land'] += 1
                continue
            if extra_keep is not None and not extra_keep[sl].any():
                lv['skipped_nogbr'] += 1
                continue
            x, y = x0 + tx, y0 + ty
            pi = png_l(idx)
            pd = webp_terrarium(dem[sl])
            write(os.path.join(out, 'idx', str(z), str(x), f'{y}.png'), pi)
            write(os.path.join(out, 'dem', str(z), str(x), f'{y}.webp'), pd)
            lv['tiles'] += 1
            lv['idx_bytes'] += len(pi)
            lv['dem_bytes'] += len(pd)


def stamp_path(pyr, z, x, y):
    return os.path.join(ARGS.work, 'done', pyr, f'{z}_{x}_{y}.json')


def save_stamp(pyr, z, x, y, stats, tail):
    p = stamp_path(pyr, z, x, y)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if tail is not None:
        np.save(os.path.join(ARGS.work, 'tail', pyr, f'{z}_{x}_{y}.npy'), tail)
    write(p, json.dumps(stats).encode())


def global_block(job):
    """relief-global: one z{B} block -> z{B}..z9 tiles; returns its z{B} level."""
    bz, bx, by = job
    pyr = 'relief-global'
    tail_p = os.path.join(ARGS.work, 'tail', pyr, f'{bz}_{bx}_{by}.npy')
    if os.path.exists(stamp_path(pyr, bz, bx, by)) and os.path.exists(tail_p):
        return job, None
    os.makedirs(os.path.dirname(tail_p), exist_ok=True)
    zmax = ARGS.global_maxzoom
    size = TILE * 2 ** (zmax - bz)
    b = tile_bounds(bz, bx, by)
    elev = gebco_elev(b, size, land_mask(b, size))
    stats = {}
    if (elev < -0.3).any():
        for z in range(zmax, bz - 1, -1):
            k = 2 ** (z - bz)
            emit(pyr, z, bx * k, by * k, elev, elev * EXAG, stats)
            if z > bz:
                elev = down2(elev)
    else:
        elev = np.zeros((TILE, TILE), 'float32')
        stats[str(bz)] = {'tiles': 0, 'dem_bytes': 0, 'idx_bytes': 0, 'skipped_land': 1, 'skipped_nogbr': 0}
    save_stamp(pyr, bz, bx, by, stats, elev)
    return job, stats


def au_block(job):
    """relief-au: one z9 block -> z13..z9 tiles; returns its z9 level (elev, w)."""
    bz, bx, by = job
    pyr = 'relief-au'
    tail_p = os.path.join(ARGS.work, 'tail', pyr, f'{bz}_{bx}_{by}.npy')
    if os.path.exists(stamp_path(pyr, bz, bx, by)) and os.path.exists(tail_p):
        return job, None
    os.makedirs(os.path.dirname(tail_p), exist_ok=True)
    zmax = ARGS.au_maxzoom
    core = TILE * 2 ** (zmax - bz)
    res = 2 * HALF / (2 ** zmax * TILE)
    pad = ARGS.pad
    b = tile_bounds(bz, bx, by)
    pb = (b[0] - pad * res, b[1] - pad * res, b[2] + pad * res, b[3] + pad * res)
    size = core + 2 * pad
    ll = bbox_3857_to_lonlat(pb)
    mid_lat = math.radians((ll[1] + ll[3]) / 2)
    feather_px = FEATHER_M / (res * math.cos(mid_lat))

    land = land_mask(pb, size)
    geb = gebco_elev(pb, size, land)
    num = np.zeros((size, size), 'float64')
    wsum = np.zeros((size, size), 'float64')
    for ds, bb in zip(DS['gbr'], DS['gbr_bbox']):
        if not overlaps(ll, bb):
            continue
        g = warp(ds, pb, size, 'bilinear')
        valid = np.isfinite(g)
        if not valid.any():
            continue
        if valid.all():
            wi = np.ones((size, size), 'float64')
        else:
            # Distance (px) to this grid's own edge / nodata; 0 outside it.
            wi = np.clip(ndimage.distance_transform_edt(valid) / feather_px, 0.0, 1.0)
        gi = np.where(valid, np.minimum(np.nan_to_num(g, nan=0.0), 0.0), 0.0)
        num += wi * gi
        wsum += wi
    stats = {}
    if not (wsum > 0).any():
        # No GBR data in this block: no z9-13 tiles, but keep its GEBCO z9
        # level so a z8 parent that does touch GBR has no hole (and no cliff).
        elev, p = geb, pad
        for _ in range(zmax - bz):
            elev, p = down2(elev), p // 2
        c = (slice(p, p + TILE), slice(p, p + TILE))
        save_stamp(pyr, bz, bx, by, {'empty': True}, np.stack([elev[c], np.zeros((TILE, TILE), 'float32')]))
        return job, stats
    w = np.clip(wsum, 0.0, 1.0).astype('float32')
    gbr = np.where(wsum > 0, num / np.maximum(wsum, 1e-9), 0.0)
    elev = (w * gbr + (1.0 - w) * geb).astype('float32')
    elev = np.where(land, 0.0, np.minimum(elev, 0.0)).astype('float32')
    del land, num, wsum, gbr, geb

    p = pad
    for z in range(zmax, bz - 1, -1):
        dem = elev * EXAG
        if z >= ARGS.smooth_from:
            dem = ndimage.gaussian_filter(dem, sigma=ARGS.smooth_sigma, mode='nearest')
        c = (slice(p, p + elev.shape[0] - 2 * p), slice(p, p + elev.shape[1] - 2 * p))
        k = 2 ** (z - bz)
        emit(pyr, z, bx * k, by * k, elev[c], dem[c], stats, extra_keep=(w[c] > 0))
        if z > bz:
            elev, w = down2(elev), down2(w)
            p //= 2
    c = (slice(p, p + TILE), slice(p, p + TILE))
    save_stamp(pyr, bz, bx, by, stats, np.stack([elev[c], w[c]]))
    return job, stats


def finish_low(pyr, bz, zmin, jobs, exag_fn, keep_fn=None):
    """Build z{bz-1}..z{zmin} from the per-block z{bz} levels saved in WORK/tail."""
    xs = [j[1] for j in jobs]
    ys = [j[2] for j in jobs]
    stats = {}
    # Work per z{zmin} parent so memory stays bounded.
    span = 2 ** (bz - zmin)
    parents = sorted({(x // span, y // span) for x, y in zip(xs, ys)})
    for px, py in parents:
        layers = None
        for jx in range(px * span, (px + 1) * span):
            for jy in range(py * span, (py + 1) * span):
                tp = os.path.join(ARGS.work, 'tail', pyr, f'{bz}_{jx}_{jy}.npy')
                if not os.path.exists(tp):
                    continue
                a = np.load(tp)
                a = a[None] if a.ndim == 2 else a
                if layers is None:
                    layers = np.zeros((a.shape[0], span * TILE, span * TILE), 'float32')
                ox, oy = (jx - px * span) * TILE, (jy - py * span) * TILE
                layers[:, oy:oy + TILE, ox:ox + TILE] = a
        if layers is None:
            continue
        arrs = list(layers)
        for z in range(bz - 1, zmin - 1, -1):
            arrs = [down2(a) for a in arrs]
            k = 2 ** (z - zmin)
            keep = keep_fn(arrs) if keep_fn else None
            emit(pyr, z, px * k, py * k, arrs[0], exag_fn(arrs), stats, extra_keep=keep)
    return stats


def merge_stats(total, s):
    for z, v in (s or {}).items():
        if not isinstance(v, dict):
            continue
        t = total.setdefault(z, {'tiles': 0, 'dem_bytes': 0, 'idx_bytes': 0, 'skipped_land': 0, 'skipped_nogbr': 0})
        for k in t:
            t[k] += v.get(k, 0)


def collect_stamps(pyr):
    total = {}
    d = os.path.join(ARGS.work, 'done', pyr)
    if os.path.isdir(d):
        for f in os.listdir(d):
            if f.endswith('.json'):
                with open(os.path.join(d, f)) as fh:
                    merge_stats(total, json.load(fh))
    return total


def run_pool(fn, jobs, label):
    t0 = time.time()
    done = 0
    with Pool(ARGS.workers, initializer=init_worker, initargs=(ARGS,), maxtasksperchild=16) as pool:
        for _job, _s in pool.imap_unordered(fn, jobs, chunksize=1):
            done += 1
            if done % 25 == 0 or done == len(jobs):
                el = time.time() - t0
                print(f'[{label}] {done}/{len(jobs)} blocks, {el:.0f}s elapsed, ~{el / done * (len(jobs) - done):.0f}s left', flush=True)


def init_worker(args):
    global ARGS
    ARGS = args
    gdal.SetCacheMax(ARGS.gdal_cache_mb * 1024 * 1024)
    open_sources()


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pyramid', choices=['global', 'au'], required=True)
    ap.add_argument('--gebco', required=True, help='GEBCO 2026 elevation (VRT of the GeoTIFF tiles)')
    ap.add_argument('--land', required=True, help='OSM land polygons, EPSG:3857 (GeoPackage with a spatial index)')
    ap.add_argument('--gbr', nargs='*', default=[], help='GBR 30 m grids A-D (COG GeoTIFFs)')
    ap.add_argument('--out', required=True, help='output root, e.g. /srv/relief/v1')
    ap.add_argument('--work', required=True, help='scratch/resume dir')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 4) - 4))
    ap.add_argument('--global-block-zoom', type=int, default=5)
    ap.add_argument('--global-maxzoom', type=int, default=9)
    ap.add_argument('--au-block-zoom', type=int, default=9)
    ap.add_argument('--au-minzoom', type=int, default=8)
    ap.add_argument('--au-maxzoom', type=int, default=13)
    ap.add_argument('--pad', type=int, default=128, help='z13 px of padding per AU block (>= feather + 4 sigma)')
    ap.add_argument('--smooth-from', type=int, default=11)
    ap.add_argument('--smooth-sigma', type=float, default=1.0)
    ap.add_argument('--webp-method', type=int, default=4)
    ap.add_argument('--gdal-cache-mb', type=int, default=256)
    ap.add_argument('--only', help='debug: comma list of block x:y to run')
    ARGS = ap.parse_args()
    init_worker(ARGS)

    if ARGS.pyramid == 'global':
        pyr, bz = 'relief-global', ARGS.global_block_zoom
        jobs = [(bz, x, y) for y in range(2 ** bz) for x in range(2 ** bz)]
    else:
        pyr, bz = 'relief-au', ARGS.au_block_zoom
        x0, y0 = lonlat_to_tile(GBR_BBOX[0], GBR_BBOX[3], bz)
        x1, y1 = lonlat_to_tile(GBR_BBOX[2], GBR_BBOX[1], bz)
        # Align to whole z{minzoom} parents so every low-zoom tile has all
        # of its children (a missing child would read as land: a cliff).
        a = 2 ** (bz - ARGS.au_minzoom)
        x0, y0 = int(x0) // a * a, int(y0) // a * a
        x1, y1 = -(-int(math.ceil(x1)) // a) * a, -(-int(math.ceil(y1)) // a) * a
        jobs = [(bz, x, y) for y in range(y0, y1) for x in range(x0, x1)]
    if ARGS.only:
        want = {tuple(int(v) for v in s.split(':')) for s in ARGS.only.split(',')}
        jobs = [j for j in jobs if (j[1], j[2]) in want]
    os.makedirs(os.path.join(ARGS.work, 'tail', pyr), exist_ok=True)
    print(f'{pyr}: {len(jobs)} z{bz} blocks, {ARGS.workers} workers', flush=True)
    run_pool(global_block if ARGS.pyramid == 'global' else au_block, jobs, pyr)

    if ARGS.only:
        print(json.dumps(collect_stamps(pyr), indent=1))
        return
    if ARGS.pyramid == 'global':
        low = finish_low(pyr, bz, 0, jobs, lambda a: a[0] * EXAG)
    else:
        low = finish_low(pyr, bz, ARGS.au_minzoom, jobs,
                         lambda a: a[0] * EXAG,
                         keep_fn=lambda a: a[1] > 0)
    total = collect_stamps(pyr)
    merge_stats(total, low)
    path = os.path.join(ARGS.work, f'{pyr}-stats.json')
    write(path, json.dumps(total, indent=1, sort_keys=True).encode())
    tiles = sum(v['tiles'] for v in total.values())
    size = sum(v['dem_bytes'] + v['idx_bytes'] for v in total.values())
    print(f'{pyr}: {tiles} tiles per set, {size / 1e9:.2f} GB (dem + idx); stats in {path}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
