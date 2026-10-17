"""Offline scalar/protocol fixtures. No ecCodes/provider/publication claim."""
import gzip
import json
import struct
import tempfile
import unittest
from pathlib import Path

from catalogue import AdmissionError, DOMAINS, digest
from native import PARAMETERS, admit_metadata, exact_messages
from static_tiles import FIELDS, HOURS, build_tile, read_rectangle, read_source, tile_shape, write_fresh

RUN = '2026-10-17T00:00:00Z'


def metadata(domain='NCALED', field='u10', i_negative=0, j_positive=0):
    spec = DOMAINS[domain]
    south, north, west, east = spec['bounds']
    value = {'edition': 2, 'centre': 85, 'gridType': 'regular_ll', 'Ni': spec['width'], 'Nj': spec['height'],
             'numberOfPoints': spec['width'] * spec['height'], 'iScansNegatively': i_negative,
             'jScansPositively': j_positive, 'jPointsAreConsecutive': 0, 'alternativeRowScanning': 0,
             'bitmapPresent': 0, 'uvRelativeToGrid': 0, 'dataDate': 20261017, 'dataTime': 0,
             'validityDate': 20261017, 'validityTime': 0, 'startStep': 0, 'endStep': 0,
             'stepUnits': 1, 'stepType': 'instant', 'iDirectionIncrementInDegrees': .025,
             'jDirectionIncrementInDegrees': .025,
             'latitudeOfFirstGridPointInDegrees': south if j_positive else north,
             'latitudeOfLastGridPointInDegrees': north if j_positive else south,
             'longitudeOfFirstGridPointInDegrees': east if i_negative else west,
             'longitudeOfLastGridPointInDegrees': west if i_negative else east,
             'units': {'u10': 'm s**-1', 'v10': 'm s**-1', 'msl': 'Pa', 't2m': 'K', 'rh2m': '%', 'mask': '(0 - 1)'}[field]}
    value.update(zip(('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'), PARAMETERS[field]))
    return value


class StaticAromeTests(unittest.TestCase):
    def test_ncaled_observed_original_grid_replaces_only_the_old_wider_extent(self):
        spec = DOMAINS['NCALED']
        self.assertEqual((spec['bounds'], spec['width'], spec['height']), ([-26, -13.75, 158.5, 171.5], 521, 491))
        self.assertEqual(spec['width'] * spec['height'], 255811)
        self.assertEqual((DOMAINS['ANTIL']['bounds'], DOMAINS['ANTIL']['width'], DOMAINS['ANTIL']['height']),
                         ([9.7, 22.9, -75.3, -51.7], 945, 529))
        self.assertEqual((DOMAINS['POLYN']['bounds'], DOMAINS['POLYN']['width'], DOMAINS['POLYN']['height']),
                         ([-25.25, -12.6, -157.5, -144.5], 521, 507))
        old = {**metadata(), 'Ni': 721, 'Nj': 801, 'numberOfPoints': 577521,
               'latitudeOfFirstGridPointInDegrees': -10, 'latitudeOfLastGridPointInDegrees': -30,
               'longitudeOfFirstGridPointInDegrees': 156, 'longitudeOfLastGridPointInDegrees': 174}
        with self.assertRaises(AdmissionError): admit_metadata(old, 'NCALED', 'u10', RUN, 0)

    def test_every_domain_field_and_admitted_scan_preserves_original_metadata(self):
        for domain in DOMAINS:
            for field in PARAMETERS:
                for i in (0, 1):
                    for j in (0, 1):
                        with self.subTest(domain=domain, field=field, i=i, j=j):
                            self.assertEqual(admit_metadata(metadata(domain, field, i, j), domain, field, RUN, 0), (i == 1, j == 0))

    def test_wrong_centre_parameter_level_grid_clock_scan_units_refuse_before_arrays(self):
        good = metadata()
        changes = {'edition': 1, 'centre': 98, 'Ni': 720, 'Nj': 802, 'numberOfPoints': 10,
                   'gridType': 'rotated_ll', 'jPointsAreConsecutive': 1, 'alternativeRowScanning': 1,
                   'bitmapPresent': None, 'uvRelativeToGrid': 1, 'dataDate': 20261016,
                   'validityTime': 100, 'startStep': 1, 'endStep': 1, 'stepUnits': 0,
                   'stepType': 'max', 'iDirectionIncrementInDegrees': .25,
                   'longitudeOfLastGridPointInDegrees': 173.975, 'latitudeOfFirstGridPointInDegrees': -30,
                   'discipline': 1, 'parameterNumber': 3, 'typeOfFirstFixedSurface': 1, 'level': 2, 'units': 'kn'}
        for key, bad in changes.items():
            with self.subTest(key=key), self.assertRaises(AdmissionError):
                admit_metadata({**good, key: bad}, 'NCALED', 'u10', RUN, 0)

    def test_canonical_longitude_wrapping_is_exact_and_not_a_new_grid(self):
        m = metadata('ANTIL')
        m['longitudeOfFirstGridPointInDegrees'] += 360
        m['longitudeOfLastGridPointInDegrees'] += 360
        admit_metadata(m, 'ANTIL', 'u10', RUN, 0)
        m['longitudeOfFirstGridPointInDegrees'] += .025
        with self.assertRaises(AdmissionError): admit_metadata(m, 'ANTIL', 'u10', RUN, 0)

    def test_exact_grib2_framing_rejects_scanner_gaps_and_members(self):
        message = b'GRIB' + b'\0\0\0\2' + (20).to_bytes(8, 'big') + b'7777'
        self.assertEqual(list(exact_messages(message * 2)), [message, message])
        for raw in (b'x' + message, message + b'x', message[:-1], message[:7] + b'\1' + message[8:], message * 129):
            with self.subTest(size=len(raw)), self.assertRaises(AdmissionError): list(exact_messages(raw))

    def test_lossless_f64_tile_layout_cardinality_and_deterministic_gzip(self):
        shape = tile_shape('NCALED', 0, 0)
        cells = shape['width'] * shape['height']
        mask = struct.pack('<d', 0.0) * cells
        value = struct.pack('<d', 101234.5678912345)
        samples = [value * cells] * (len(FIELDS) * HOURS)
        packed, tile = build_tile('NCALED', RUN, 'b' * 64, 'c' * 64, shape, mask, iter(samples))
        self.assertEqual(build_tile('NCALED', RUN, 'b' * 64, 'c' * 64, shape, mask, iter(samples)), (packed, tile))
        raw = gzip.decompress(packed)
        self.assertEqual(raw[:8], b'THAROME1')
        header_size = struct.unpack_from('<I', raw, 8)[0]
        header = json.loads(raw[12:12 + header_size])
        self.assertEqual(header['fields'], list(FIELDS))
        start = 12 + header_size
        self.assertEqual(raw[start:start + cells * 8], mask)
        self.assertEqual(raw[start + cells * 8:], b''.join(samples))
        self.assertEqual(tile['rawSha256'], digest(raw))
        self.assertEqual(tile['sha256'], digest(packed))
        with self.assertRaises(AdmissionError): build_tile('NCALED', RUN, 'b' * 64, 'c' * 64, shape, mask, iter(samples[:-1]))

    def test_exact_original_rectangle_no_interpolation(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'source'
            write_fresh(p, struct.pack('<24d', *range(24)))
            block = read_rectangle(p, {'i0': 1, 'j0': 1, 'width': 2, 'height': 2}, 4)
            self.assertEqual(struct.unpack('<4d', block), (5, 6, 9, 10))
            second = read_rectangle(p, {'i0': 1, 'j0': 0, 'width': 2, 'height': 1}, 4, 1, 12)
            self.assertEqual(struct.unpack('<2d', second), (13, 14))

    def test_regular_source_hash_size_and_fresh_output_refusals(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'packet'
            raw = b'fictional-local-packet' * 2
            write_fresh(p, raw)
            self.assertEqual(read_source(p, digest(raw), len(raw)), raw)
            for sha, size in (('0' * 64, len(raw)), (digest(raw), len(raw) + 1), ('x', len(raw)), (digest(raw), 17 * 1024**2)):
                with self.assertRaises(AdmissionError): read_source(p, sha, size)
            with self.assertRaises(FileExistsError): write_fresh(p, raw)


if __name__ == '__main__': unittest.main()
