"""Generated real ecCodes/NumPy cases; no original/provider qualification.

Run only in the separately reviewed Linux native boundary. The existing four
native fixtures remain unchanged and are required alongside these cases.
"""
import gzip
import json
import math
import os
from pathlib import Path
import struct
import sys
import unittest

import eccodes
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalogue import AdmissionError, DOMAINS, digest, packet_url
from native import FIELDS, RH_DISPLAY_POLICY, decode_packet, qualify_rh_display
from static_tiles import build_static, encoded, write_fresh
from test_native import DEFAULTS, NOW, RUN, message

POINT = (240, 300)


def changed_message(field='rh2m', offset=0, changes=None, fill=None, missing=False,
                    i_negative=0, j_positive=0, ieee=False):
    raw = message(field, 'NCALED', offset, i_negative, j_positive)
    handle = eccodes.codes_new_from_message(raw)
    try:
        values = np.full((491, 521), DEFAULTS[field] if fill is None else fill, dtype='<f8')
        for point, value in (changes or {}).items(): values[point] = value
        if missing:
            eccodes.codes_set_long(handle, 'bitmapPresent', 1)
            eccodes.codes_set_double(handle, 'missingValue', 9999.)
            values[240, 301] = 9999.
        if ieee:
            eccodes.codes_set(handle, 'packingType', 'grid_ieee')
            eccodes.codes_set_long(handle, 'precision', 2)
        if j_positive == 0: values = values[::-1, :]
        if i_negative == 1: values = values[:, ::-1]
        eccodes.codes_set_values(handle, values.reshape(-1))
        return eccodes.codes_get_message(handle)
    finally:
        eccodes.codes_release(handle)


def changed_packet(offset=0, **options):
    return b''.join(changed_message(field, offset, **options) if field == 'rh2m'
                    else message(field, 'NCALED', offset) for field in FIELDS)


class RhDisplayNativeTests(unittest.TestCase):
    def test_compiled_array_exact_boundary_upper_values_and_source_unchanged(self):
        original = np.array([0., 100., math.nextafter(100., math.inf), 100.00163650512695,
                             100.0125732421875, 150., 1e6, sys.float_info.max, np.nan])
        before = original.tobytes()
        values, qa = qualify_rh_display(original, np)
        self.assertEqual(values[:2].tolist(), [0., 100.])
        self.assertTrue(np.all(np.isnan(values[2:])))
        self.assertEqual(original.tobytes(), before)
        self.assertIsNot(values, original)
        self.assertEqual((qa['upperDisplayUnavailableCells'], qa['sourceMissingCells']), (6, 1))
        self.assertEqual(qa['upperSourceMaximum'], sys.float_info.max)

    def test_compiled_array_negative_or_nonfinite_present_still_refuses(self):
        for bad in (-.00001, -math.inf, math.inf):
            values = np.array([75., 150., bad, np.nan])
            before = values.tobytes()
            with self.subTest(bad=bad), self.assertRaisesRegex(AdmissionError, 'original field physical range'):
                qualify_rh_display(values, np)
            self.assertEqual(values.tobytes(), before)

    def test_actual_ccsds_keeps_bitmap_missing_separate_and_other_four_fields(self):
        raw = changed_packet(changes={POINT: 100.125, (240, 302): 150., (240, 303): 100.}, missing=True)
        before = digest(raw)
        values, facts = decode_packet(raw, 'NCALED', RUN, 0)
        self.assertTrue(np.isnan(values['rh2m'][POINT]))
        self.assertTrue(np.isnan(values['rh2m'][240, 301]))
        self.assertTrue(np.isnan(values['rh2m'][240, 302]))
        self.assertEqual(values['rh2m'][240, 303], 100.)
        self.assertEqual(values['rh2m'][240, 304], 75.)
        qa = facts['rh2m']['displayQualification']
        self.assertEqual((qa['upperDisplayUnavailableCells'], qa['sourceMissingCells']), (2, 1))
        self.assertEqual((qa['sourceBitmapMissingCells'], qa['sourceUnmarkedMissingCells']), (1, 0))
        self.assertEqual((qa['upperSourceMinimum'], qa['upperSourceMaximum']), (100.125, 150.))
        for field in FIELDS[:-1]: self.assertTrue(np.all(values[field] == DEFAULTS[field]))
        self.assertEqual(digest(raw), before)

    def test_actual_ccsds_all_upper_rh_unavailable_with_valid_other_fields(self):
        values, facts = decode_packet(changed_packet(fill=1000000.), 'NCALED', RUN, 0)
        self.assertTrue(np.all(np.isnan(values['rh2m'])))
        qa = facts['rh2m']['displayQualification']
        self.assertEqual(qa['displayAvailability'], 'unavailable')
        self.assertEqual(qa['upperDisplayUnavailableCells'], 255811)
        self.assertEqual(qa['displayAvailableCells'], 0)
        for field in FIELDS[:-1]: self.assertTrue(np.all(values[field] == DEFAULTS[field]))

    def test_actual_ccsds_negative_rh_still_refuses(self):
        with self.assertRaisesRegex(AdmissionError, 'original field physical range'):
            decode_packet(changed_packet(changes={POINT: -1.}), 'NCALED', RUN, 0)

    def test_actual_other_field_ranges_are_not_relaxed_by_upper_rh(self):
        for field, bad in (('u10', 103.), ('v10', -103.), ('msl', 110001.), ('t2m', 339.)):
            raw = b''.join(changed_message(name, changes={POINT: bad}) if name == field
                           else changed_message(name, changes={POINT: 150.}) if name == 'rh2m'
                           else message(name, 'NCALED') for name in FIELDS)
            with self.subTest(field=field), self.assertRaisesRegex(AdmissionError, 'original field physical range'):
                decode_packet(raw, 'NCALED', RUN, 0)

    def test_actual_ieee64_infinite_rh_still_refuses(self):
        for bad in (-math.inf, math.inf):
            with self.subTest(bad=bad), self.assertRaisesRegex(AdmissionError, 'original field physical range'):
                decode_packet(changed_packet(changes={POINT: bad}, ieee=True), 'NCALED', RUN, 0)

    def test_actual_scan_keeps_unknown_at_the_original_cell(self):
        for i in (0, 1):
            for j in (0, 1):
                raw = changed_message(changes={POINT: 150.}, i_negative=i, j_positive=j)
                packet = b''.join(message(field, 'NCALED') for field in FIELDS[:-1]) + raw
                values, _ = decode_packet(packet, 'NCALED', RUN, 0)
                self.assertTrue(np.isnan(values['rh2m'][POINT]))
                self.assertEqual(np.count_nonzero(np.isnan(values['rh2m'])), 1)
                self.assertEqual(values['rh2m'][240, 301], 75.)

    def test_actual_full49_static_view_qa_hashes_and_nearest_cell_gap(self):
        root = Path(os.environ['AROME_RH_NATIVE_FIXTURE_DIR'])
        self.assertFalse(root.exists(), 'unique RH fixture output required')
        root.mkdir(mode=0o700)
        inputs = root / 'input'; inputs.mkdir()
        sources = []
        for offset in range(49):
            options = ({'changes': {POINT: 100.125}} if offset == 6 else {'fill': 150.} if offset == 7
                       else {'changes': {POINT: 9999.}, 'missing': True} if offset == 8
                       else {'changes': {POINT: 100.}} if offset == 9
                       else {'changes': {POINT: 0.}} if offset == 10
                       else {'changes': {POINT: 1000000.}} if offset == 11 else {})
            raw = changed_packet(offset, **options)
            path = inputs / f'hour-{offset:03}.grib2'; write_fresh(path, raw)
            sources.append({'path': str(path), 'offsetHours': offset, 'url': packet_url('NCALED', RUN, offset),
                            'bytes': len(raw), 'sha256': digest(raw)})
        mask_raw = changed_message('mask', changes={POINT: 0., (240, 301): 0.})
        mask_path = inputs / 'mask.grib2'; write_fresh(mask_path, mask_raw)
        resource = 'https://www.data.gouv.fr/fr/datasets/r/00000000-0000-0000-0000-000000000001'
        mask = {'path': str(mask_path), 'resource': resource, 'bytes': len(mask_raw), 'sha256': digest(mask_raw)}
        spec = DOMAINS['NCALED']
        plan = {'schema': 1, 'domain': 'NCALED', 'model': spec['model'], 'runUtc': RUN, 'grid': spec['grid'],
                'licence': 'Etalab-2.0', 'resolutionDegrees': .025, 'bounds': spec['bounds'], 'width': spec['width'],
                'height': spec['height'], 'catalogueSha256': 'd' * 64, 'constantResource': resource,
                'packets': [{key: row[key] for key in ('offsetHours', 'url', 'bytes')} for row in sources]}
        result = build_static(plan, sources, mask, root / 'cohort', lambda: NOW)
        proof_raw = (root / 'cohort/native-proof.json').read_bytes()
        proof = json.loads(proof_raw)
        self.assertEqual(digest(proof_raw), result['nativeProofSha256'])
        self.assertNotIn('allOriginalCellsPreserved', proof)
        self.assertTrue(proof['allOriginalGridLocationsPreserved'])
        self.assertFalse(proof['originalSourceGribBytesModified'])
        self.assertEqual(proof['optionalDisplayQualification']['policy'], RH_DISPLAY_POLICY)
        self.assertEqual(proof['optionalDisplayQualification']['displayAvailability'], 'partial')
        self.assertEqual(proof['optionalDisplayQualification']['upperDisplayUnavailableCells'], 255813)
        self.assertEqual(proof['optionalDisplayQualification']['sourceMissingCells'], 2)
        self.assertEqual(proof['optionalDisplayQualification']['sourceBitmapMissingCells'], 2)
        for name, sha in proof['scientificFilesSha256'].items():
            self.assertEqual(sha, digest(Path(__file__).resolve().parents[1].joinpath(name).read_bytes()))
        qa = proof['packets'][7]['fields']['rh2m']['displayQualification']
        self.assertEqual((qa['displayAvailability'], qa['upperDisplayUnavailableCells']), ('unavailable', 255811))
        manifest = json.loads((root / 'cohort/manifest.json').read_bytes())
        tile = next(row for row in manifest['tiles'] if row['id'] == '9-7')
        raw = gzip.decompress((root / 'cohort/tiles' / f"{tile['sha256']}.bin.gz").read_bytes())
        size = struct.unpack_from('<I', raw, 8)[0]
        header = json.loads(raw[12:12 + size]); cells = header['width'] * header['height']
        values = np.frombuffer(raw, dtype='<f8', offset=12 + size)
        cell = (240 - header['j0']) * header['width'] + 300 - header['i0']
        rh = values[cells + 4 * 49 * cells:].reshape(49, cells)
        self.assertTrue(np.all(np.isnan(rh[[6, 7, 8, 11], cell])))
        self.assertEqual(rh[9, cell], 100.); self.assertEqual(rh[10, cell], 0.)
        self.assertEqual(rh[6, cell + 1], 75., 'neighbor remains valid but must not be borrowed')
        for source in [*sources, mask]:
            self.assertEqual(digest(Path(source['path']).read_bytes()), source['sha256'])
        write_fresh(root / 'rh-proof.json', encoded({'schema': 1, 'fixtureOnly': True, 'providerRequests': 0,
                    'originalSourceFilesUnchanged': True, 'policy': RH_DISPLAY_POLICY, **result}))


if __name__ == '__main__': unittest.main()
