"""Verify completed immutable NZ blocks and write metadata in a separate review directory."""
import argparse
import hashlib
import json
from pathlib import Path
from nz_coastal import (ROOT, RETAINED, ROI_CAP, OUTPUT_CAP, candidate_blocks,
                        collection_identity, load_plan, rows_for_tiles, verify_file)
from build_au250 import workspace_size
from regional_sources import source_hash


def check_checkpoint(output, stamp, z, y, x, recipe):
    if stamp.is_symlink() or stamp.stat().st_size > 65536:
        raise ValueError('Missing or oversized completed NZ block')
    data = json.loads(stamp.read_bytes())
    if (data['recipe'] != recipe or not 0 <= data['maximumInputsPerWindow'] <= 8
            or not 0 <= data['decodedRoiBytes'] <= ROI_CAP or len(data['tiles']) > 4):
        raise ValueError('Completed block violates its original recipe or resource limits')
    tiles = {tuple(tile) for tile in data['tiles']}
    if (len(tiles) != len(data['tiles']) or len(data['files']) != len(tiles)*3
            or data['sourcePixels'] < 0 or data['fallbackPixels'] < 0
            or data['sourcePixels'] + data['fallbackPixels'] != len(tiles)*65536
            or any(tz != z or ty not in (y,y+1) or tx not in (x,x+1) for tz,ty,tx in tiles)):
        raise ValueError('Completed block tile coordinates changed')
    expected = {f'v2/relief-nz/{kind}/{z}/{tx}/{ty}.{ext}' for _,ty,tx in tiles
                for kind,ext in [('dem','webp'),('idx','png'),('coverage','png')]}
    if {row['path'] for row in data['files']} != expected:
        raise ValueError('Completed block output paths changed')
    for row in data['files']:
        path = output/row['path']
        if (path.is_symlink() or not path.resolve().is_relative_to(output)
                or path.stat().st_size != row['bytes'] or source_hash(path) != row['sha256']):
            raise ValueError('Completed NZ output hash or length changed')
    return data


def immutable(path, body):
    if path.exists():
        if path.is_symlink() or path.read_bytes() != body:
            raise ValueError('Metadata review output conflict; preserve it')
    else:
        with path.open('xb') as output:
            output.write(body)


def main():
    from PIL import Image
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--recipe-sha256', required=True)
    args = parser.parse_args()
    plan, output = load_plan(args.plan), ROOT/'output'
    recipe_file = output/'recipe.json'
    if source_hash(recipe_file) != args.recipe_sha256:
        raise ValueError('Original frozen raster recipe changed')
    recipe = json.loads(recipe_file.read_bytes())
    if recipe['planSha256'] != source_hash(args.plan) or len(recipe['sources']) != 61:
        raise ValueError('Original source recipe changed')
    for row in plan['sources']:
        verify_file(RETAINED if row['id']=='AU26' else ROOT/'sources'/(row['id']+'.tiff'), row)
    blocks, tiles, inventory, stats = candidate_blocks(plan['sources']), [], [], {}
    if len(blocks) != 6425 or len(list((output/'checkpoints').glob('*.json'))) != 6425:
        raise ValueError('Raster invocation did not finish every approved footprint block')
    for z,y,x in blocks:
        data = check_checkpoint(output, output/'checkpoints'/f'{z}_{x}_{y}.json', z,y,x,args.recipe_sha256)
        tiles.extend(data['tiles'])
        inventory.extend(data['files'])
        row = stats.setdefault(str(z), {'tilePairs':0,'sourcePixels':0,'fallbackPixels':0})
        row['tilePairs'] += len(data['tiles'])
        for field in ('sourcePixels','fallbackPixels'):
            row[field] += data[field]
        observed = 0
        for file in data['files']:
            with Image.open(output/file['path']) as image:
                image.load()
                if image.size != (256,256) or image.format not in ('PNG','WEBP'):
                    raise ValueError('Actual emitted tile decode/dimensions failed')
                if '/coverage/' in file['path']:
                    counts = dict((value,count) for count,value in image.getcolors(3) or [])
                    if not counts or set(counts)-{0,255}:
                        raise ValueError('Source mask is not binary')
                    observed += counts.get(255,0)
        if observed != data['sourcePixels']:
            raise ValueError('Actual source mask count differs from checkpoint')
    if len({tuple(tile) for tile in tiles}) != len(tiles) or len(tiles)*2 > 46886:
        raise ValueError('Duplicate or oversized emitted tile inventory')
    used = workspace_size(output)
    if used > OUTPUT_CAP-1_000_000:
        raise ValueError('No room for bounded final metadata')
    availability = {'schema':1,'region':'nz','version':'v2','minzoom':8,'maxzoom':14,
                    'tilePairs':len(tiles),'rows':rows_for_tiles(tiles)}
    raw = json.dumps(availability,separators=(',',':')).encode()
    if len(raw)>1_000_000:
        raise ValueError('Exact availability exceeds app metadata cap')
    target=ROOT/'review-final'
    target.mkdir(exist_ok=True)
    availability_sha=hashlib.sha256(raw).hexdigest()
    immutable(target/'availability-nz.json',raw)
    manifest={'schema':3,'published':False,'provider':'LINZ','generation':'v2',
              'dataset':plan['dataset'],**collection_identity(plan),'verticalDatum':plan['verticalDatum'],
              'verticalTransform':False,'purpose':'Illustrative relief only; no navigation/depth sampling',
              'attribution':'Derived from LINZ NZ Coastal LiDAR1m DEM surveyed patches, CC BY4.0; GEBCO2026 fallback; OpenStreetMap land mask ODbL. Not for navigation.',
              'recipeSha256':args.recipe_sha256,'availabilitySha256':availability_sha,'availabilityBytes':len(raw),
              'perZoom':stats,'uploadObjects':len(tiles)*2,'verifiedCheckpointCount':len(blocks),
              'verifiedImageCount':len(inventory),'retainedOutputBytes':used,
              'tileInventorySha256':hashlib.sha256(json.dumps(sorted(inventory,key=lambda r:r['path']),sort_keys=True).encode()).hexdigest(),
              'metadataFinalizerSha256':source_hash(Path(__file__)),
              'originalRasterSourceUnchanged':True,'failedMetadataLogPreserved':True}
    body=(json.dumps(manifest,sort_keys=True,indent=2)+'\n').encode()
    immutable(target/'manifest-nz.json',body)
    print(json.dumps({'manifest':str(target/'manifest-nz.json'),'manifestSha256':hashlib.sha256(body).hexdigest(),
                     'availabilitySha256':availability_sha,'tilePairs':len(tiles),'verifiedImages':len(inventory),
                     'verifiedBlocks':len(blocks),'retainedOutputBytes':used,'published':False}))


if __name__=='__main__':
    main()
