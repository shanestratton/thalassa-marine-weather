"""Pure controller refusal fixtures, not native/resource/original qualification."""
import copy
from datetime import datetime, timedelta, timezone
import json
import hashlib
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rh_retained_qualification as q
from native import rh_display_qa

NOW = datetime(2026, 10, 17, 16, tzinfo=timezone.utc)


def capture():
    return {'source': q.RAW_SOURCE, 'outcome': 'all48-captured-native-unadmitted',
            'completedNewOriginals': 48, 'newCapturedBytes': 136003911,
            'originalRunUtc': q.RUN, 'originalExpiresAt': q.EXPIRES,
            'h000Refetched': False, 'maskRefetched': False,
            'full49HourCohortAdmitted': False, 'published': False,
            'deadlineMonotonic': 1284.789584713}


class TinyArray(tuple):
    """Explicit pure fake for reconciliation branches, never a native proof."""
    @property
    def size(self): return len(self)
    def __getitem__(self, key):
        if isinstance(key, list): return TinyArray(v for v, present in zip(self, key) if present)
        return super().__getitem__(key)


class TinyNp:
    @staticmethod
    def isfinite(values): return [math.isfinite(v) for v in values]
    @staticmethod
    def count_nonzero(values): return sum(bool(v) for v in values)
    min = staticmethod(min)
    max = staticmethod(max)


def reconciliation_fixture(refused):
    fields = {name: TinyArray((1., 2.)) for name in ('u10', 'v10', 'msl', 't2m')}
    prior_fields = {name: {'finiteCells': 2, 'unknownCells': 0, 'minimum': 1., 'maximum': 2.} for name in fields}
    if refused:
        qa = rh_display_qa(255811, 0, 8, 42., 100.125, 100.125, 100.125)
        row = {'offsetHours': 0, 'outcome': 'unchanged-native-refusal', 'field': 'rh2m',
               'originalError': 'original field physical range', 'admittedPriorFieldExtrema': prior_fields,
               'rangeEvidence': {'aboveMaximumCells': 8, 'missingNaNCells': 0, 'finiteMinimum': 42., 'finiteMaximum': 100.125}}
    else:
        qa = rh_display_qa(255811, 0, 0, 42., 98.)
        row = {'offsetHours': 0, 'outcome': 'unchanged-native-fields-passed',
               'fields': {**prior_fields, 'rh2m': {'unknownCells': 0, 'minimum': 42., 'maximum': 98.}}}
    return fields, qa, {'outcomes': [row]}


class RetainedRhQualificationTests(unittest.TestCase):
    def test_accepted_and_refused_original_survey_structures_reconcile(self):
        for refused in (False, True):
            fields, qa, survey = reconciliation_fixture(refused)
            q.reconcile_packet(0, fields, qa, survey, TinyNp)

    def test_mutated_upper_missing_extrema_and_false_availability_refuse(self):
        fields, qa, survey = reconciliation_fixture(True)
        for key, value in (('upperDisplayUnavailableCells', 9), ('sourceMissingCells', 1),
                           ('sourceFiniteMinimum', 41.), ('sourceFiniteMaximum', 100.126),
                           ('displayAvailability', 'complete'), ('displayAvailableCells', 255811),
                           ('displayMissingCells', 0), ('sourceBitmapMissingCells', 1),
                           ('sourceUnmarkedMissingCells', 1), ('reason', None),
                           ('upperRhCause', 'packing-only'), ('upperValuesClamped', True)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                q.reconcile_packet(0, fields, {**qa, key: value}, survey, TinyNp)

    def test_other_field_count_or_extrema_changes_refuse(self):
        fields, qa, survey = reconciliation_fixture(False)
        for name in fields:
            changed = {**fields, name: TinyArray((1., 3.))}
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'other-field'):
                q.reconcile_packet(0, changed, qa, survey, TinyNp)

    def test_independent_raw_upper_count_and_extrema_readback_refuses_mutation(self):
        _, qa, _ = reconciliation_fixture(True)
        counts = {'upperCells': 8, 'upperMinimum': 100.125, 'upperMaximum': 100.125}
        q.reconcile_upper_readback(qa, counts)
        for key, value in (('upperCells', 7), ('upperMinimum', 100.126), ('upperMaximum', 100.126)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'raw/view'):
                q.reconcile_upper_readback(qa, {**counts, key: value})

    def test_exact50_names_missing_extra_and_mask_omission_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in [*(f'hour-{i:03}.grib2' for i in range(49)), 'mask.grib2']: (root/name).touch()
            q.admit_original_names(root)
            for name in ('hour-000.grib2', 'hour-048.grib2', 'mask.grib2'):
                (root/name).unlink()
                with self.subTest(missing=name), self.assertRaisesRegex(ValueError, 'exact50'): q.admit_original_names(root)
                (root/name).touch()
            (root/'hour-049.grib2').touch()
            with self.assertRaisesRegex(ValueError, 'exact50'): q.admit_original_names(root)

    def test_regular_file_hash_size_order_origin_mismatch_refuse_before_arrays(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'hour-000.grib2'; raw = b'fictional-not-GRIB-1234'; path.write_bytes(raw)
            expected = {'bytes': len(raw), 'url': 'https://object-fixed.invalid/hour-000.grib2'}
            row = {**expected, 'path': 'historical-capture-path', 'offsetHours': 0, 'sha256': hashlib.sha256(raw).hexdigest()}
            with patch.object(q, 'readonly_file', return_value={'syntheticOwnershipCheck': True}):
                got, _, _ = q.verify_original_row(row, expected, path, 0)
                self.assertEqual(got['path'], str(path.resolve()))
                for key, value in (('sha256', '0'*64), ('bytes', len(raw)+1), ('bytes', True),
                                   ('offsetHours', 1), ('url', 'https://foreign.invalid/original')):
                    with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'declaration/hash'):
                        q.verify_original_row({**row, key: value}, expected, path, 0)
                path.write_bytes(raw[:-1]+b'x')
                with self.assertRaisesRegex(ValueError, 'declaration/hash'): q.verify_original_row(row, expected, path, 0)

    def test_new_phase_is_explicit_and_cannot_relabel_historical_failed_capture(self):
        original = capture(); before = copy.deepcopy(original)
        phase = q.make_phase(NOW, 2000.)
        q.admit_capture(original)
        self.assertEqual(phase['phase'], q.PHASE)
        self.assertEqual(phase['deadlineMonotonic'], 3200.)
        self.assertEqual(original, before)
        self.assertFalse(phase['originalCaptureQualificationSucceeded'])
        self.assertFalse(phase['originalForecastExpiryRenewed'])
        self.assertEqual(q.check_phase(phase, NOW + timedelta(seconds=10), 2010.), 1190.)

    def test_phase_clamps_to_original18UTC_and_never_renews_expiry(self):
        near = datetime(2026, 10, 17, 17, 59, tzinfo=timezone.utc)
        phase = q.make_phase(near, 100.)
        self.assertEqual(phase['maximumSeconds'], 60.)
        self.assertEqual(phase['deadlineMonotonic'], 160.)
        with self.assertRaises(ValueError): q.check_phase(phase, near + timedelta(seconds=60), 160.)

    def test_expired_future_timezone_and_invalid_monotonic_cannot_start(self):
        for now, mono in ((NOW.replace(hour=18), 1.), (NOW.replace(tzinfo=None), 1.),
                          (NOW, math.nan), (NOW, math.inf), (NOW, -1.), (NOW, True)):
            with self.subTest(now=now, mono=mono), self.assertRaises(ValueError): q.make_phase(now, mono)

    def test_source_run_and_original_success_claims_are_exact(self):
        for key, value in (('scientificSource', q.RAW_SOURCE), ('rawScientificSource', q.SCIENCE),
                           ('phase', 'old-capture-success'), ('originalRunUtc', '2026-10-17T06:00:00Z'),
                           ('originalExpiresAt', '2026-10-18T00:00:00Z'),
                           ('originalCaptureQualificationSucceeded', True), ('originalForecastExpiryRenewed', True)):
            phase = q.make_phase(NOW, 100.); phase[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): q.check_phase(phase, NOW, 100.)

    def test_deadline_widening_restarting_or_false_remaining_refuses(self):
        for changes in ({'deadlineMonotonic': 1301.}, {'maximumSeconds': 1201.},
                        {'startedMonotonic': 101.}, {'maximumSeconds': math.nan},
                        {'deadlineMonotonic': math.inf}, {'maximumSeconds': True}):
            phase = {**q.make_phase(NOW, 100.), **changes}
            with self.subTest(changes=changes), self.assertRaises(ValueError): q.check_phase(phase, NOW, 100.)

    def test_utc_or_monotonic_rollback_and_elapsed_phase_refuse(self):
        phase = q.make_phase(NOW, 100.)
        for now, mono in ((NOW-timedelta(seconds=1), 100.), (NOW, 99.), (NOW, 1300.),
                          (NOW+timedelta(hours=2), 101.)):
            with self.subTest(now=now, mono=mono), self.assertRaises(ValueError): q.check_phase(phase, now, mono)

    def test_extra_phase_field_or_missing_expiry_refuses(self):
        phase = q.make_phase(NOW, 100.); phase['allowExpired'] = True
        with self.assertRaises(ValueError): q.check_phase(phase, NOW, 100.)
        del phase['allowExpired']; del phase['originalExpiresAt']
        with self.assertRaises(ValueError): q.check_phase(phase, NOW, 100.)

    def test_missing_failed_capture_provenance_or_original_change_refuses(self):
        for key in capture():
            if key == 'deadlineMonotonic': continue
            value = capture(); del value[key]
            with self.subTest(key=key), self.assertRaises(ValueError): q.admit_capture(value)

    def test_failed_capture_cannot_become_success_or_allow_reacquisition(self):
        for key, value in (('source', q.SCIENCE), ('outcome', 'success'), ('completedNewOriginals', 47),
                           ('newCapturedBytes', 0), ('h000Refetched', True), ('maskRefetched', True),
                           ('full49HourCohortAdmitted', True), ('published', True)):
            row = capture(); row[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): q.admit_capture(row)

    def test_source_manifest_cannot_alias_old_science_change_hash_or_add_feature(self):
        manifest = {'source': q.SCIENCE, 'rawScientificSource': q.RAW_SOURCE, 'files': q.SCIENCE_FILES}
        variants = [{**manifest, 'source': q.RAW_SOURCE}, {**manifest, 'rawScientificSource': q.SCIENCE},
                    {**manifest, 'files': {**q.SCIENCE_FILES, 'native.py': '0'*64}},
                    {**manifest, 'allowPartial': True}]
        for value in variants:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'scientific identity'):
                q.verify_manifest(value, Path('.'))

    def test_actual_scientific_bytes_are_bound_and_byte_mutation_refuses(self):
        # readonly_file is isolated because Windows cannot prove POSIX root/RO.
        # No claim of real Linux/source ownership is made by this pure test.
        source = Path(__file__).resolve().parents[3]
        manifest = {'source': q.SCIENCE, 'rawScientificSource': q.RAW_SOURCE, 'files': q.SCIENCE_FILES}
        with patch.object(q, 'readonly_file', return_value={'syntheticOwnershipCheck': True}):
            self.assertEqual(len(q.verify_manifest(manifest, source)), 4)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory); target = root / 'tools/arome142'; target.mkdir(parents=True)
                for name in q.SCIENCE_FILES: (target/name).write_bytes((source/'tools/arome142'/name).read_bytes())
                (target/'native.py').write_bytes((target/'native.py').read_bytes()+b'\n')
                with self.assertRaisesRegex(ValueError, 'hash changed'): q.verify_manifest(manifest, root)

    def test_output_is_bounded_finite_json_without_native_import(self):
        raw = q.compact(q.make_phase(NOW, 100.)); self.assertLess(len(raw), 4096)
        self.assertEqual(json.loads(raw)['scientificSource'], q.SCIENCE)
        with self.assertRaises(ValueError): q.compact({'value': math.nan})
        with self.assertRaises(ValueError): q.compact({'value': 'x' * (256*1024)})
        self.assertNotIn('eccodes', sys.modules); self.assertNotIn('numpy', sys.modules)


if __name__ == '__main__': unittest.main()
