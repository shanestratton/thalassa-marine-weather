"""Actual ecCodes round trip; generated fixtures, NOT original provider data.

The full POLYN fixture uses every original grid node and all49 leads. No provider
request, publication, deployment or fabricated HTTP observation is involved.
"""
import gzip
import json
import os
import struct
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import eccodes
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalogue import AdmissionError, DOMAINS, digest, packet_url
from native import FIELDS, PARAMETERS, decode_packet
from static_tiles import build_static, encoded, read_source, write_fresh

RUN = '2026-10-17T00:00:00Z'
NOW = datetime(2026, 10, 17, 1, tzinfo=timezone.utc)
DEFAULTS = {'u10': 5.0, 'v10': -2., 'msl': 101234.5, 't2m': 290., 'rh2m': 75., 'mask': 1.}


def message(field, domain='POLYN', offset=0, i_negative=0, j_positive=0, missing=False):
    spec = DOMAINS[domain]
    south, north, west, east = spec['bounds']
    handle = eccodes.codes_grib_new_from_samples('regular_ll_sfc_grib2')
    try:
        pairs = {'centre': 85, 'Ni': spec['width'], 'Nj': spec['height'],
                 'iDirectionIncrementInDegrees': .025, 'jDirectionIncrementInDegrees': .025,
                 'latitudeOfFirstGridPointInDegrees': south if j_positive else north,
                 'latitudeOfLastGridPointInDegrees': north if j_positive else south,
                 'longitudeOfFirstGridPointInDegrees': (east if i_negative else west) % 360,
                 'longitudeOfLastGridPointInDegrees': (west if i_negative else east) % 360,
                 'iScansNegatively': i_negative, 'jScansPositively': j_positive,
                 'jPointsAreConsecutive': 0, 'alternativeRowScanning': 0,
                 'dataDate': 20261017, 'dataTime': 0, 'stepUnits': 1, 'forecastTime': offset,
                 'uvRelativeToGrid': 0}
        for key, value in pairs.items(): eccodes.codes_set(handle, key, value)
        for key, value in zip(('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'), PARAMETERS[field]):
            eccodes.codes_set_long(handle, key, value)
        eccodes.codes_set(handle, 'packingType', 'grid_ccsds')
        values = np.full((spec['height'], spec['width']), DEFAULTS[field], dtype='<f8')
        if field == 'mask':
            values[400, 400] = 0
        elif missing:
            eccodes.codes_set_long(handle, 'bitmapPresent', 1)
            eccodes.codes_set_double(handle, 'missingValue', 9999.)
            values[400, 400] = 9999.
        # Input array is logical south/east order, then exact original scan order.
        if j_positive == 0: values = values[::-1, :]
        if i_negative == 1: values = values[:, ::-1]
        eccodes.codes_set_values(handle, values.reshape(-1))
        return eccodes.codes_get_message(handle)
    finally:
        eccodes.codes_release(handle)


def packet(domain='POLYN', offset=0, i_negative=0, j_positive=0, missing=False):
    return b''.join(message(field, domain, offset, i_negative, j_positive, missing) for field in FIELDS)


class NativeAromeTests(unittest.TestCase):
    def test_actual_ccsds_all_five_fields_for_all_original_domains(self):
        for domain in DOMAINS:
            values, facts = decode_packet(packet(domain, offset=48), domain, RUN, 48)
            self.assertEqual(set(values), set(FIELDS))
            for field in FIELDS:
                self.assertEqual(values[field].shape, (DOMAINS[domain]['height'], DOMAINS[domain]['width']))
                self.assertTrue(np.all(values[field] == DEFAULTS[field]))
                self.assertEqual(facts[field]['validityDate'], 20261019)
                self.assertEqual(facts[field]['validityTime'], 0)

    def test_actual_scan_and_bitmap_preserve_original_sea_unknowns(self):
        for i in (0, 1):
            for j in (0, 1):
                mask, _ = decode_packet(message('mask', i_negative=i, j_positive=j), 'POLYN', mask_only=True)
                self.assertEqual(mask['mask'][400, 400], 0)
                self.assertEqual(np.count_nonzero(mask['mask'] == 0), 1)
                values, _ = decode_packet(packet(i_negative=i, j_positive=j, missing=True), 'POLYN', RUN, 0)
                for field in FIELDS:
                    self.assertTrue(np.isnan(values[field][400, 400]))
                    self.assertEqual(np.count_nonzero(np.isnan(values[field])), 1)

    def test_actual_wrong_lead_domain_duplicate_incomplete_or_symlink_refused(self):
        raw = packet()
        for domain, offset in (('NCALED', 0), ('POLYN', 1)):
            with self.assertRaises(AdmissionError): decode_packet(raw, domain, RUN, offset)
        with self.assertRaises(AdmissionError): decode_packet(raw + message('u10'), 'POLYN', RUN, 0)
        with self.assertRaises(AdmissionError): decode_packet(message('u10'), 'POLYN', RUN, 0)
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'source'
            source.write_bytes(raw)
            alias = Path(temp) / 'alias'
            alias.symlink_to(source)
            with self.assertRaises(AdmissionError): read_source(alias, digest(raw), len(raw))

    def test_full49_original_grid_local_tiles_and_no_source_mutation(self):
        root = Path(os.environ['AROME_NATIVE_FIXTURE_DIR'])
        self.assertFalse(root.exists(), 'native proof output must be unique')
        root.mkdir(mode=0o700)
        inputs = root / 'input'
        inputs.mkdir()
        sources = []
        for offset in range(49):
            raw = packet(offset=offset)
            path = inputs / f'{offset:03}.grib2'
            write_fresh(path, raw)
            sources.append({'path': str(path), 'offsetHours': offset, 'url': packet_url('POLYN', RUN, offset),
                            'bytes': len(raw), 'sha256': digest(raw)})
        mask_raw = message('mask')
        mask_path = inputs / 'constant.grib2'
        write_fresh(mask_path, mask_raw)
        spec = DOMAINS['POLYN']
        mask = {'path': str(mask_path), 'resource': 'https://www.data.gouv.fr/fr/datasets/r/00000000-0000-0000-0000-000000000001',
                'sha256': digest(mask_raw), 'bytes': len(mask_raw)}
        plan = {'schema': 1, 'domain': 'POLYN', 'model': spec['model'], 'runUtc': RUN, 'grid': spec['grid'],
                'licence': 'Etalab-2.0', 'resolutionDegrees': .025, 'bounds': spec['bounds'], 'width': spec['width'],
                'height': spec['height'], 'catalogueSha256': 'd' * 64, 'constantResource': mask['resource'],
                'packets': [{key: row[key] for key in ('offsetHours', 'url', 'bytes')} for row in sources]}
        result = build_static(plan, sources, mask, root / 'cohort', lambda: NOW)
        manifest_raw = (root / 'cohort/manifest.json').read_bytes()
        manifest = json.loads(manifest_raw)
        self.assertEqual(result['slot']['manifestSha256'], digest(manifest_raw))
        self.assertEqual(result['tileCount'], 272)
        self.assertFalse(result['published'])
        self.assertFalse((root / 'cohort/.native').exists())
        # Verify every reconstructed native tile value, all49 hours, fields and
        # halo nodes against the independent generated original constants.
        core_cells = 0
        for tile in manifest['tiles']:
            packed = (root / f"cohort/tiles/{tile['sha256']}.bin.gz").read_bytes()
            self.assertEqual(digest(packed), tile['sha256'])
            raw = gzip.decompress(packed)
            self.assertEqual(digest(raw), tile['rawSha256'])
            self.assertEqual(len(raw), tile['rawBytes'])
            size = struct.unpack_from('<I', raw, 8)[0]
            header = json.loads(raw[12:12 + size])
            self.assertEqual(header['runUtc'], RUN)
            cells = tile['width'] * tile['height']
            decoded = np.frombuffer(raw, dtype='<f8', offset=12 + size)
            self.assertEqual(decoded.size, cells * (1 + 49 * len(FIELDS)))
            for field_index, field in enumerate(FIELDS):
                block = decoded[cells + field_index * 49 * cells:cells + (field_index + 1) * 49 * cells]
                self.assertTrue(np.all(block == DEFAULTS[field]))
            x, y = map(int, tile['id'].split('-'))
            core_cells += min(32, spec['width'] - x * 32) * min(32, spec['height'] - y * 32)
        self.assertEqual(core_cells, spec['width'] * spec['height'])
        for source in sources: self.assertEqual(digest(Path(source['path']).read_bytes()), source['sha256'])
        self.assertEqual(digest(mask_path.read_bytes()), mask['sha256'])
        with self.assertRaises(AdmissionError): build_static(plan, sources, mask, root / 'cohort', lambda: NOW)
        write_fresh(root / 'proof.json', encoded({'schema': 1, 'fixtureOnly': True, 'providerRequests': 0,
                    'published': False, 'nativeApi': eccodes.codes_get_api_version(), 'fullGridCells': core_cells,
                    'hours': 49, 'fields': FIELDS, 'originalSourceFilesUnchanged': True, **result}))


if __name__ == '__main__':
    print('Actual ecCodes API:', eccodes.codes_get_api_version(), 'generated fixture only; providerRequests=0')
    unittest.main()
