import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from nz_coastal import checked_window, rows_for_tiles, verify_file, acquire_one, check_deadline, collection_identity
from nz_render import split_windows
from nz_finalize import check_checkpoint


class CoastalLimits(unittest.TestCase):
    def test_finalizer_refuses_incomplete_changed_or_out_of_budget_checkpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)
            files=[]
            for kind,ext in [('dem','webp'),('idx','png'),('coverage','png')]:
                path=output/f'v2/relief-nz/{kind}/8/1/2.{ext}'
                path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'public synthetic output')
                files.append({'path':path.relative_to(output).as_posix(),'bytes':path.stat().st_size,
                              'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
            data={'recipe':'a'*64,'maximumInputsPerWindow':8,'decodedRoiBytes':256000000,
                  'tiles':[[8,2,1]],'files':files,'sourcePixels':100,'fallbackPixels':65436}
            stamp=output/'checkpoint.json';stamp.write_text(json.dumps(data))
            self.assertEqual(check_checkpoint(output,stamp,8,2,0,'a'*64)['tiles'],[[8,2,1]])
            for change in [{'recipe':'b'*64},{'maximumInputsPerWindow':9},{'decodedRoiBytes':256000001},
                           {'tiles':[[8,4,1]]},{'fallbackPixels':0}]:
                stamp.write_text(json.dumps({**data,**change}))
                with self.assertRaises(ValueError):check_checkpoint(output,stamp,8,2,0,'a'*64)
            stamp.write_text(json.dumps(data));(output/files[0]['path']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'hash or length'):check_checkpoint(output,stamp,8,2,0,'a'*64)
    def test_manifest_keeps_real_provider_issuance_separate_from_its_title(self):
        plan={'dataset':'NZ Coastal LiDAR1m DEM national coastal composite, collection updated 2026-10-15T17:04:29Z',
              'collectionUrl':'https://example.test/collection.json','collectionSha256':'a'*64}
        self.assertEqual(collection_identity(plan)['sourceCollectionUpdated'],'2026-10-15T17:04:29Z')
        for title in ['ENC Product Catalog','NZ Coastal collection updated 2026-02-30T00:00:00Z']:
            with self.assertRaises(ValueError):collection_identity({**plan,'dataset':title})
    def test_exact_runs_preserve_holes_and_zoom_rows(self):
        # JSON checkpoints contain lists, rather than in-memory tuple fixtures.
        self.assertEqual(rows_for_tiles([[8, 4, 5], [8, 4, 3], [8, 4, 4], [8, 4, 8], [9, 4, 3], [8, 4, 3]]),
                         [[8, 4, 3, 5], [8, 4, 8, 8], [9, 4, 3, 3]])

    def test_decoded_roi_cap_and_clipping(self):
        self.assertEqual(checked_window((0, 1, 0, 10, 0, -1), 10, 10, [(-5, -5), (20, 20)]), (0, 0, 10, 10))
        with self.assertRaisesRegex(ValueError, '256 MB'):
            checked_window((0, 1, 0, 20000, 0, -1), 20000, 20000, [(0, 0), (20000, 20000)])

    def test_retained_checksum_mismatch_stops_without_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'sources').mkdir()
            path = root/'sources'/'AB12.tiff'
            path.write_bytes(b'bad')
            row = {'id': 'AB12', 'bytes': 3, 'sha256': hashlib.sha256(b'yes').hexdigest()}
            with patch('urllib.request.build_opener') as fetch:
                with self.assertRaisesRegex(ValueError, 'pinned inventory'):
                    acquire_one(row, root, time.time()+60)
                fetch.assert_not_called()

    def test_deadline_is_an_error_not_completion(self):
        with self.assertRaises(TimeoutError):
            check_deadline(time.time()-1)

    def test_sixteen_grids_subdivide_without_seams_or_dropped_pixels(self):
        # A low-zoom output block spans 16 disjoint source grids. Simulate a
        # continuous source field and explicit one-grid NoData hole at every pixel.
        sources = [{'id': f'{x}_{y}', 'mercatorBounds': [x, y, x+1, y+1]}
                   for y in range(4) for x in range(4)]
        visits, pixels = [], {}
        def visit(bounds, width, height, candidates, offset):
            self.assertLessEqual(len(candidates), 8)
            visits.append(len(candidates))
            for y in range(height):
                for x in range(width):
                    lon = bounds[0] + (x+.5)*(bounds[2]-bounds[0])/width
                    lat = bounds[3] - (y+.5)*(bounds[3]-bounds[1])/height
                    key = offset[0]+x, offset[1]+y
                    self.assertNotIn(key, pixels)
                    valid = any(row['id'] != '1_1' and row['mercatorBounds'][0] <= lon < row['mercatorBounds'][2]
                                and row['mercatorBounds'][1] <= lat < row['mercatorBounds'][3] for row in candidates)
                    pixels[key] = lon+lat if valid else None
        split_windows([0, 0, 4, 4], 512, 512, sources, visit)
        self.assertEqual(len(visits), 4)
        self.assertEqual(len(pixels), 512*512)
        for (x, y), value in pixels.items():
            lon, lat = (x+.5)/128, 4-(y+.5)/128
            self.assertEqual(value, None if 1 <= lon < 2 and 1 <= lat < 2 else lon+lat)

    def test_irreducible_overlapping_sources_refuse(self):
        with self.assertRaisesRegex(ValueError, 'single output pixel'):
            split_windows([0, 0, 1, 1], 2, 2,
                          [{'mercatorBounds': [0, 0, 1, 1]} for _ in range(9)], lambda *args: None)


if __name__ == '__main__':
    unittest.main()
