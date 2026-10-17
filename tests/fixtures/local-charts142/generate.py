"""Own deterministic display-only fixtures. Requires Pillow only when regenerating.

TIFF bytes and independent original RGBA are emitted/read by Pillow's libtiff
path. KAP bytes follow the primary libbsb/GDAL documented run encoding and contain
only this script's colour pattern, not any published or licensed nautical chart.
"""
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from PIL import Image, TiffImagePlugin, features, __version__ as pillow_version

ROOT = Path(__file__).resolve().parent
W, H = 8, 8
DEG = math.pi / 180
E = math.sqrt(0.0066943799901413165)


def web(lat):
    return math.log(math.tan(math.pi / 4 + lat * DEG / 2))


def inverse_web(y):
    return math.atan(math.sinh(y)) / DEG


def ellipsoid(lat):
    sine = math.sin(lat * DEG)
    return math.log(math.tan(math.pi / 4 + lat * DEG / 2) * ((1-E*sine)/(1+E*sine)) ** (E/2))


manifest = {'purpose': 'Own format fixtures only; fictional colour patterns, never navigation data',
            'generator': {'pillow': pillow_version, 'libtiff': features.version('libtiff')}, 'files': {}}


def retain(path, original, expected, bounds, **metadata):
    raw = path.read_bytes()
    manifest['files'][path.name] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                                  'width': W, 'height': H, 'bounds': bounds,
                                  'originalRgba': list(original), 'displayRgba': list(expected), **metadata}


def tiff(name, compression, projection=4326, mode='RGB', point=False, bounds=None):
    bounds = bounds or [150, 50, 150.08, 75]
    image = Image.new(mode, (W, H))
    data = []
    for y in range(H):
        for x in range(W):
            if mode == 'RGB': value = (20+x*25, 10+y*30, 180)
            elif mode == 'RGBA': value = (20+x*25, 10+y*30, 180, 0 if x < 2 else 128 if x == 2 else 255)
            else: value = 0 if x < 2 else 30+y*25+x
            data.append(value)
    image.putdata(data)
    tags = TiffImagePlugin.ImageFileDirectory_v2()
    if projection == 4326:
        left, top, sx, sy = bounds[0], bounds[3], (bounds[2]-bounds[0])/W, (bounds[3]-bounds[1])/H
    else:
        left, top = bounds[0] * DEG * 6378137, web(bounds[3]) * 6378137
        sx, sy = (bounds[2]-bounds[0])/W * DEG * 6378137, (web(bounds[3])-web(bounds[1])) * 6378137/H
    tags.tagtype[33550] = tags.tagtype[33922] = 12
    tags[33550] = (sx, sy, 0.)
    tags[33922] = (0., 0., 0., left + (sx/2 if point else 0), top - (sy/2 if point else 0), 0.)
    keys = [1024, 0, 1, 2 if projection == 4326 else 1, 1025, 0, 1, 2 if point else 1,
            2048 if projection == 4326 else 3072, 0, 1, projection]
    tags.tagtype[34735] = 3
    tags[34735] = (1, 1, 1, 3, *keys)
    tags[270] = 'Thalassa own fictional format-test pattern; no chart or navigation data.'
    if mode == 'L': tags[42113] = '0'
    path = ROOT / name
    image.save(path, compression=compression, tiffinfo=tags)
    # Native Pillow/libtiff rereads the exact encoded file, independently of TS.
    with Image.open(path) as reopened:
        original = reopened.convert('RGBA').tobytes()
        if mode == 'L':
            original = bytes(v for i in range(W*H) for v in
                             (*original[i*4:i*4+3], 0 if data[i] == 0 else 255))
    displayed = bytearray()
    for y in range(H):
        lat = inverse_web(web(bounds[3]) + (web(bounds[1])-web(bounds[3])) * (y+.5)/H)
        source_y = int((bounds[3]-lat)/((bounds[3]-bounds[1])/H)) if projection == 4326 else y
        for x in range(W):
            value = original[(source_y*W+x)*4:(source_y*W+x+1)*4]
            displayed.extend(value if value[3] else bytes(4))
    retain(path, original, displayed, bounds, decoder='Pillow/libtiff readback', compression=compression,
           projection=projection, rasterType='PixelIsPoint' if point else 'PixelIsArea')


def kap(name, north=75, south=50, west=150, east=150.08, cutline=False, indexed=False):
    palette = {1: (240, 25, 80, 255), 2: (25, 220, 70, 255), 3: (25, 70, 230, 255)}
    header = ['!Own Thalassa fictional format fixture; no nautical data', 'VER/3.0',
              f'BSB/NA=Own colour pattern,RA={W},{H},DU=100',
              'KNP/SC=10000,GD=WGS84,PR=MERCATOR,SK=0,SD=UNVERIFIED TEST ONLY',
              f'REF/1,0,0,{north},{west}', f'REF/2,{W},0,{north},{east}',
              f'REF/3,0,{H},{south},{west}', f'REF/4,{W},{H},{south},{east}',
              'DTM/0,0', 'IFM/2', *[f'RGB/{key},{r},{g},{b}' for key, (r,g,b,_) in palette.items()]]
    if cutline:
        header += [f'PLY/1,{north},{west}', f'PLY/2,{north},{east}', f'PLY/3,{south},{west}']
    raw = bytearray(('\r\n'.join(header)+'\r\n').encode('ascii') + bytes([26, 0, 2]))
    original = bytearray(); rows = []; indices = []
    for y in range(H):
        rows.append(len(raw)); raw.append(y+1)
        row = [0, 0, *[((x//2+y)%3)+1 for x in range(2,W)]]
        indices += row
        for start in range(0,W,2): raw.append((row[start] << 5) | 1)
        raw.append(0)
        for value in row: original.extend(palette.get(value, (0,0,0,0)))
    if indexed:
        table = len(raw)
        for value in [*rows, table]: raw.extend(value.to_bytes(4, 'big'))
    path = ROOT / name; path.write_bytes(raw)
    displayed = bytearray()
    for y in range(H):
        lat = inverse_web(web(north)+(web(south)-web(north))*(y+.5)/H)
        source_y = int((ellipsoid(lat)-ellipsoid(north))/((ellipsoid(south)-ellipsoid(north))/H))
        for x in range(W):
            # A north/east/south-west triangle's right boundary at this latitude.
            inside = not cutline or (x+.5)/W < (lat-south)/(north-south)
            displayed.extend(palette.get(indices[source_y*W+x], (0,0,0,0)) if inside else bytes(4))
    retain(path, original, displayed, [west,south,east,north], decoder='Own documented BSB/KAP byte encoder', cutline=cutline, indexed=indexed)


for name, compression, projection, mode, point in [
    ('rgb-4326-raw.tif','raw',4326,'RGB',False), ('rgb-4326-deflate.tif','tiff_adobe_deflate',4326,'RGB',False),
    ('rgb-3857-packbits.tif','packbits',3857,'RGB',False), ('rgba-4326.tif','raw',4326,'RGBA',False),
    ('gray-nodata.tif','tiff_adobe_deflate',4326,'L',False), ('point-4326.tif','raw',4326,'RGB',True),
]: tiff(name,compression,projection,mode,point)
tiff('phone.tif','tiff_adobe_deflate',4326,'RGB',False,[152.9,-27.2,153.1,-27])
kap('own-mercator.kap', indexed=True)
kap('own-cutline.kap',cutline=True)
kap('phone.kap',north=-27,south=-27.2,west=152.9,east=153.1)

# Actual SQLite database and PNG tile for browser/sql.js/CSP proof.
path = ROOT / 'own-ocean.mbtiles'
if path.exists(): path.unlink()
with sqlite3.connect(path) as db:
    db.execute('CREATE TABLE metadata (name TEXT, value TEXT)')
    db.execute('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)')
    for key,value in {'name':'Own fictional colour tile','format':'png','minzoom':'4','maxzoom':'4',
                      'bounds':'-45,-21.943045533438177,-22.5,0'}.items():
        db.execute('INSERT INTO metadata VALUES (?,?)',(key,value))
    tile = Image.new('RGBA',(256,256),(255,0,200,255))
    tile.paste((0,0,0,0),(0,0,64,64)); tile.save(ROOT/'own-tile.png')
    db.execute('INSERT INTO tiles VALUES (4,6,7,?)',((ROOT/'own-tile.png').read_bytes(),))
for name in ['own-ocean.mbtiles','own-tile.png']:
    raw=(ROOT/name).read_bytes(); manifest['files'][name]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
(ROOT/'expected.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Wrote',len(manifest['files']),'own format fixtures with independent TIFF pixel readbacks.')
