"""Pure scalar boundary fixtures, not a claim of actual ecCodes admission."""
from __future__ import annotations

import ast
import io
from pathlib import Path
import sys
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import native
import scalar_inspection as subject
import scalar_artifact as artifact


def valid(field='u10'):
    data = dict(zip(('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'),
                    native.PARAMETERS[field]))
    data.update(edition=2, centre=85, gridType='regular_ll', Ni=721, Nj=801, numberOfPoints=577521,
                iScansNegatively=0, jScansPositively=1, jPointsAreConsecutive=0, alternativeRowScanning=0,
                dataDate=20261017, dataTime=0, validityDate=20261017, validityTime=0,
                startStep=0, endStep=0, stepUnits=1, stepType='instant', bitmapPresent=0, uvRelativeToGrid=0,
                iDirectionIncrementInDegrees=.025, jDirectionIncrementInDegrees=.025,
                latitudeOfFirstGridPointInDegrees=-30., latitudeOfLastGridPointInDegrees=-10.,
                longitudeOfFirstGridPointInDegrees=156., longitudeOfLastGridPointInDegrees=174.,
                units=native.UNIT_SPELLINGS[field][0], packingType='grid_simple', bitsPerValue=16)
    return data


def message():
    return b'GRIB' + b'\0\0\0\2' + (20).to_bytes(8, 'big') + b'7777'


class Scalars:
    def __init__(self, rows):
        self.rows, self.created, self.released = rows, 0, []

    def codes_new_from_message(self, raw):
        self.created += 1
        return self.created - 1

    def codes_get_long(self, handle, key):
        value = self.rows[handle][key]
        if type(value) is not int:
            raise ValueError('not an integer fixture scalar')
        return value

    def codes_get_double(self, handle, key):
        return self.rows[handle][key]

    def codes_get_string(self, handle, key):
        return str(self.rows[handle][key])

    def codes_release(self, handle):
        self.released.append(handle)

    def __getattr__(self, key):
        raise AssertionError('non-scalar native operation attempted: ' + key)


class ScalarInspection(unittest.TestCase):
    def test_all_five_selected_headers_are_compared_without_arrays(self):
        codes = Scalars([valid(field) for field in native.FIELDS])
        result = subject.inspect_headers(message() * 5, codes, native)
        self.assertEqual(result['missing9fFields'], [])
        self.assertEqual(result['messageCount'], 5)
        self.assertEqual(codes.released, list(range(5)))
        for row in result['messages']:
            comparison = next(iter(row['comparison9f'].values()))
            self.assertEqual(comparison['differences'], [])
            self.assertTrue(comparison['unchanged9fScalarGate']['accepted'])

    def test_actual_mismatched_centre_grid_and_clock_remain_refused(self):
        for key, value in (('centre', 98), ('Ni', 722), ('dataDate', 20261016),
                           ('validityTime', 100), ('stepUnits', 0), ('startStep', 1),
                           ('units', 'knots'), ('uvRelativeToGrid', 1)):
            with self.subTest(key=key):
                row = valid()
                row[key] = value
                result = subject.inspect_headers(message(), Scalars([row]), native)
                comparison = result['messages'][0]['comparison9f']['u10']
                self.assertIn(key, [entry['key'] for entry in comparison['differences']])
                self.assertFalse(comparison['unchanged9fScalarGate']['accepted'])

    def test_unselected_parameter_inventory_and_original_units_are_preserved(self):
        row = valid()
        row.update(parameterNumber=99, units='W m**-2', name='Fictional unselected radiation')
        result = subject.inspect_headers(message(), Scalars([row]), native)
        self.assertEqual(result['messages'][0]['selected9fFields'], [])
        self.assertEqual(result['messages'][0]['stringHeaders']['units']['value'], 'W m**-2')
        self.assertEqual(result['missing9fFields'], list(native.FIELDS))

    def test_missing_headers_are_explicit_not_filled_with_zero(self):
        row = valid()
        del row['centre']
        result = subject.inspect_headers(message(), Scalars([row]), native)
        self.assertFalse(result['messages'][0]['scalarHeaders']['centre']['available'])
        self.assertFalse(result['messages'][0]['comparison9f']['u10']['unchanged9fScalarGate']['accepted'])

    def test_duplicate_selected_members_are_reported(self):
        result = subject.inspect_headers(message() * 2, Scalars([valid(), valid()]), native)
        self.assertEqual(result['duplicate9fFields'], ['u10'])

    def test_original_framing_is_not_skipped(self):
        for raw in (b'junk' + message(), message() + b'junk', message()[:-1], b''):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    subject.inspect_headers(raw, Scalars([valid()]), native)

    def test_message_ceiling_and_metadata_ceiling_remain_bounded(self):
        with self.assertRaises(ValueError):
            subject.inspect_headers(message() * 129, Scalars([valid()] * 129), native)
        with self.assertRaises(ValueError):
            subject.encoded({'headers': 'x' * subject.MAX_METADATA_BYTES})

    def test_unbounded_native_strings_and_nonfinite_scalars_are_explicitly_missing(self):
        codes = Scalars([{'name': 'x' * 257, 'referenceValue': float('nan')}])
        self.assertFalse(subject.scalar(codes, 0, 'name', 'string')['available'])
        self.assertFalse(subject.scalar(codes, 0, 'referenceValue', 'double')['available'])

    def test_native_handles_close_even_if_metadata_limit_refuses(self):
        codes = Scalars([valid()] * 128)
        with self.assertRaises(ValueError):
            subject.inspect_headers(message() * 128, codes, native)
        self.assertEqual(len(codes.released), codes.created)

    def test_inspector_has_no_value_or_array_api_or_numpy_import(self):
        tree = ast.parse(Path(subject.__file__).read_text())
        forbidden = {'codes_get_values', 'codes_get_array', 'codes_get_data', 'decode_packet'}
        self.assertFalse(any(isinstance(node, ast.Attribute) and node.attr in forbidden for node in ast.walk(tree)))
        self.assertFalse(any(isinstance(node, ast.Import) and any(alias.name == 'numpy' for alias in node.names)
                             for node in ast.walk(tree)))


class RetainedArtifact(unittest.TestCase):
    def archive(self, mutate=None):
        names = list(artifact.SELECT) + [f'extra-{index}.txt' for index in range(31 - len(artifact.SELECT))]
        if mutate:
            names = mutate(names)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            for name in names:
                info = zipfile.ZipInfo()
                info.filename = name
                archive.writestr(info, b'fixture')
        return zipfile.ZipFile(io.BytesIO(buffer.getvalue()))

    def test_inventory_accepts_bounded_plain_named_fixture(self):
        with self.archive() as archive:
            artifact.inventory(archive)

    def test_duplicate_missing_traversal_and_absolute_members_refuse(self):
        for mutate in (lambda rows: rows[:-1], lambda rows: rows[:-1] + [rows[0]],
                       lambda rows: rows[:-1] + ['../outside'], lambda rows: rows[:-1] + ['/outside'],
                       lambda rows: rows[:-1] + ['C:/outside'], lambda rows: rows[:-1] + ['a\\outside']):
            with self.subTest(mutate=mutate):
                with self.archive(mutate) as archive, self.assertRaises(ValueError):
                    artifact.inventory(archive)

    def test_arbitrary_zip_cannot_replace_exact_captured_artifact(self):
        with self.assertRaises(ValueError):
            artifact.verified_members(b'fictional archive')


if __name__ == '__main__':
    unittest.main()
