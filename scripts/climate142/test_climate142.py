"""Fictional fixtures only. This does not admit ecCodes, CDS or a public dataset."""
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import math
import sqlite3
import unittest
from unittest.mock import patch
import aggregate
import ledger as ledger_module
from aggregate import ClimateAccumulator, checked_row
from contract import FIRST, LAST, KINDS, PLAN_SHA, DATASET, METHOD, ORIGINAL_LIMIT, canonical, cell_key, month_hours, original_id, plan, request, sha
from ledger import ClimateLedger
from native_grib import observation, require_linux_bounds, validate_header
from native_entry import parse_receipt
from publish import publish


def receipt(y=1991, m=1, kind='wind'):
    return {'id': original_id(y, m, kind), 'year': y, 'month': m, 'kind': kind,
            'sha256': 'a' * 64, 'bytes': 20, 'receivedAt': '2026-10-17T00:00:00Z',
            'planSha256': PLAN_SHA, 'requestSha256': sha(canonical(request(y, m, kind)))}


def row(index=0, y=1991, m=1, kind='wind', count=None):
    count = month_hours(y, m) if count is None else count
    rose = [0] * 128
    rose[2] = count
    return {'key': cell_key(index), 'year': y, 'month': m, 'kind': kind, 'count': count,
            'calm': 0, 'exceeds': 0, 'rose': rose, 'originalSha256': 'a' * 64}


class ClimateContractTests(unittest.TestCase):
    def test_exact720_hourly_originals_not_monthly_means(self):
        specs = plan()['requests']
        self.assertEqual(len(specs), 720)
        self.assertEqual(len({p['id'] for p in specs}), 720)
        self.assertEqual({p['kind'] for p in specs}, {'wind', 'wave'})
        self.assertEqual(request(2000, 2, 'wind')['date'], '2000-02-01/to/2000-02-29')
        self.assertEqual(request(1991, 1, 'wave')['param'], '140229/140230')
        self.assertEqual(request(1991, 1, 'wind')['param'], '165/166')
        self.assertTrue(all(p['request']['time'] == '00/to/23/by/1' and p['request']['type'] == 'an' and p['request']['grid'] == '1.0/1.0' for p in specs))
        for values in [(1990, 1, 'wind'), (2021, 1, 'wave'), (2000, 13, 'wind'), (2000, 1, 'means')]:
            with self.assertRaises(ValueError): request(*values)

    def test_from_direction_calm_and_exact_thresholds(self):
        self.assertEqual(observation('wind', 0, -20)['bin'] // 8, 0)
        self.assertEqual(observation('wind', -20, 0)['bin'] // 8, 4)
        self.assertTrue(observation('wind', 0, 0)['calm'])
        self.assertTrue(observation('wind', 34 / 1.9438444924406, 0)['exceeds'])
        self.assertEqual(observation('wave', 3, 359)['bin'], 4)
        self.assertTrue(observation('wave', .099, 90)['calm'])
        self.assertFalse(observation('wave', .1, 90)['calm'])
        self.assertIsNone(observation('wind', math.nan, 0))
        for args in [('wave', -1, 0), ('wave', 1, 361), ('wind', 131, 0), ('mean', 1, 1)]:
            with self.assertRaises(ValueError): observation(*args)

    def test_original_header_units_grid_and_clock_are_mandatory(self):
        header = {'paramId': 165, 'gridType': 'regular_ll', 'Ni': 360, 'Nj': 181, 'numberOfPoints': 65160,
                  'latitudeOfFirstGridPointInDegrees': 90, 'latitudeOfLastGridPointInDegrees': -90,
                  'longitudeOfFirstGridPointInDegrees': 0, 'longitudeOfLastGridPointInDegrees': 359,
                  'iDirectionIncrementInDegrees': 1, 'jDirectionIncrementInDegrees': 1, 'iScansNegatively': 0,
                  'jScansPositively': 0, 'jPointsAreConsecutive': 0, 'alternativeRowScanning': 0,
                  'dataType': 'an', 'step': 0, 'marsClass': 'ea', 'marsStream': 'oper', 'experimentVersionNumber': '0001',
                  'units': 'm s**-1', 'dataDate': 19910101, 'dataTime': 100, 'validityDate': 19910101, 'validityTime': 100}
        self.assertEqual(validate_header(header, 1991, 1, 'wind')[1], 165)
        for key, value in [('units', 'kn'), ('Ni', 720), ('jScansPositively', 1), ('step', 3), ('validityDate', 19910201), ('dataTime', 130), ('experimentVersionNumber', '0005'), ('marsStream', 'moda')]:
            with self.assertRaises(ValueError): validate_header({**header, key: value}, 1991, 1, 'wind')

    def test_unconfined_process_cannot_import_native_decoder(self):
        # No mock native import or skipped success: our ordinary test process is unadmitted.
        with self.assertRaises(RuntimeError): require_linux_bounds()

    def test_fixed_native_receipt_cannot_select_files_models_or_other_periods(self):
        spec = {'year': 1991, 'month': 1, 'kind': 'wind', 'sha256': 'a' * 64, 'planSha256': PLAN_SHA}
        self.assertEqual(parse_receipt(canonical(spec)), spec)
        for bad in [{**spec, 'path': '/etc/shadow'}, {**spec, 'year': 2025}, {**spec, 'sha256': 'bad'}, {**spec, 'planSha256': 'b' * 64}]:
            with self.assertRaises(ValueError): parse_receipt(canonical(bad))


class ClimateLedgerTests(unittest.TestCase):
    def test_reservation_is_durable_before_transport_and_never_auto_retried(self):
        with TemporaryDirectory() as temp:
            state = Path(temp) / 'state'
            ledger = ClimateLedger(state)
            calls = []
            def fail(dataset, params):
                calls.append((dataset, params))
                other = sqlite3.connect(state / 'ledger.sqlite')
                self.assertEqual(other.execute('SELECT state,charged FROM originals').fetchone(), ('reserved', ORIGINAL_LIMIT))
                other.close()
                yield b'GRIBfictional'
                raise OSError('interrupted fictional transport')
            with self.assertRaises(OSError): ledger.acquire(1991, 1, 'wind', fail)
            ledger.close()
            reopened = ClimateLedger(state)
            with self.assertRaisesRegex(ValueError, 'incomplete'): reopened.acquire(1991, 1, 'wave', fail)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0], (DATASET, request(1991, 1, 'wind')))
            reopened.close()

    def test_complete_body_charges_actual_bytes_and_refuses_replacement_or_lost_identity(self):
        with TemporaryDirectory() as temp:
            state = Path(temp) / 'state'
            ledger = ClimateLedger(state)
            result = ledger.acquire(1991, 1, 'wind', lambda *_: [b'GRIBfictional-original'])
            self.assertEqual(result['sha256'], sha(b'GRIBfictional-original'))
            self.assertEqual(ledger.db.execute('SELECT charged,state FROM originals').fetchone(), (22, 'downloaded'))
            ledger.close()
            ledger = ClimateLedger(state)
            self.assertEqual(ledger.read_receipt(result['id']), result)
            with self.assertRaises(ValueError): ledger.reserve(1991, 1, 'wind')
            ledger.db.execute('DELETE FROM meta')
            ledger.close()
            with self.assertRaisesRegex(ValueError, 'identity'): ClimateLedger(state)

    def test_byte_and_cumulative_transfer_limits_leave_the_prior_charge_durable(self):
        with TemporaryDirectory() as temp, patch.object(ledger_module, 'ORIGINAL_LIMIT', 8), patch.object(ledger_module, 'TRANSFER_LIMIT', 8):
            ledger = ClimateLedger(Path(temp) / 'state')
            ledger.acquire(1991, 1, 'wind', lambda *_: [b'GRIBabc'])
            with self.assertRaisesRegex(ValueError, 'budget'): ledger.reserve(1991, 1, 'wave')
            ledger.close()
        with TemporaryDirectory() as temp, patch.object(ledger_module, 'ORIGINAL_LIMIT', 8):
            ledger = ClimateLedger(Path(temp) / 'state')
            with self.assertRaisesRegex(ValueError, 'byte limit'): ledger.acquire(1991, 1, 'wind', lambda *_: [b'GRIB', b'12345'])
            self.assertEqual(ledger.db.execute('SELECT state,charged,bytes FROM originals').fetchone(), ('reserved', 8, None))
            ledger.close()

    def test_retirement_needs_exact_durable_aggregation_and_never_resets_transfer_or_receipt(self):
        with TemporaryDirectory() as temp, patch.object(aggregate, 'CELL_COUNT', 2):
            path = Path(temp); ledger = ClimateLedger(path / 'state')
            original = ledger.acquire(1991, 1, 'wind', lambda *_: [b'GRIBfictional-original'])
            body = Path(original['path'])
            with self.assertRaisesRegex(ValueError, 'not admitted'): ledger.retire_original(original['id'], path / 'counts.sqlite')
            with self.assertRaisesRegex(ValueError, 'missing'): ledger.retire_original(original['id'], path / 'counts.sqlite', managed_retention=True)
            accum = ClimateAccumulator(path / 'counts.sqlite')
            reduction = path / 'month.jsonl'
            reduction.write_bytes(b''.join(canonical({**row(i), 'originalSha256': original['sha256']}) + b'\n' for i in range(2)))
            accum.ingest(reduction, original)
            accum.close()
            ledger.retire_original(original['id'], path / 'counts.sqlite', managed_retention=True)
            self.assertFalse(body.exists())
            self.assertEqual(ledger.db.execute('SELECT charged,state,received_at FROM originals').fetchone(), (22, 'retired', original['receivedAt']))
            ledger.close()
            reopened = ClimateLedger(path / 'state')
            self.assertEqual(reopened.read_receipt(original['id']), original)
            with self.assertRaises(sqlite3.IntegrityError): reopened.reserve(1991, 1, 'wind')
            reopened.close()

    def test_interrupted_retirement_holds_existing_and_reopened_controller(self):
        with TemporaryDirectory() as temp:
            state = Path(temp) / 'state'; ledger = ClimateLedger(state)
            ledger.acquire(1991, 1, 'wind', lambda *_: [b'GRIBfictional'])
            ledger.db.execute('UPDATE originals SET state="retiring"')
            with self.assertRaisesRegex(ValueError, 'incomplete'): ledger.reserve(1991, 1, 'wave')
            ledger.close()
            with self.assertRaisesRegex(ValueError, 'incomplete'): ClimateLedger(state)

    def test_missing_ledger_with_original_or_empty_existing_ledger_is_not_new_state(self):
        with TemporaryDirectory() as temp:
            state = Path(temp) / 'state'; state.mkdir()
            (state / '1991-01-wind.grib').write_bytes(b'GRIBorphan')
            with self.assertRaisesRegex(ValueError, 'Orphan'): ClimateLedger(state)
            (state / '1991-01-wind.grib').unlink()
            (state / 'ledger.sqlite').write_bytes(b'')
            with self.assertRaisesRegex(ValueError, 'identity'): ClimateLedger(state)


class ClimateAggregationTests(unittest.TestCase):
    def test_year_mask_uses_each_original_month_not_pooled_count(self):
        with TemporaryDirectory() as temp, patch.object(aggregate, 'CELL_COUNT', 2):
            path = Path(temp)
            accum = ClimateAccumulator(path / 'counts.sqlite')
            for year, count in [(1991, 744), (1992, 669)]:
                original = path / f'{year}.jsonl'
                original.write_bytes(b''.join(canonical(row(i, y=year, count=count)) + b'\n' for i in range(2)))
                accum.ingest(original, receipt(year))
            self.assertEqual(accum.db.execute('SELECT count,years FROM climate ORDER BY key LIMIT 1').fetchone(), (1413, 1))
            with self.assertRaisesRegex(ValueError, 'replay'): accum.ingest(original, receipt(1992))
            with self.assertRaisesRegex(ValueError, '720'): accum.export(path / 'incomplete')
            accum.close()

    def test_missing_duplicate_or_corrupt_cell_rolls_back_whole_original(self):
        for rows in [[row(0)], [row(0), row(0)], [row(0), {**row(1), 'exceeds': 1}]]:
            with self.subTest(rows=len(rows)), TemporaryDirectory() as temp, patch.object(aggregate, 'CELL_COUNT', 2):
                path = Path(temp); source = path / 'bad.jsonl'
                source.write_bytes(b''.join(canonical(r) + b'\n' for r in rows))
                accum = ClimateAccumulator(path / 'counts.sqlite')
                with self.assertRaises(ValueError): accum.ingest(source, receipt())
                self.assertEqual(accum.db.execute('SELECT count(*) FROM climate').fetchone()[0], 0)
                self.assertEqual(accum.db.execute('SELECT count(*) FROM originals').fetchone()[0], 0)
                accum.close()

    def test_monthly_histogram_and_exceedance_are_consistent(self):
        checked_row(row(), 1991, 1, 'wind', 'a' * 64)
        for bad in [{**row(), 'count': 743}, {**row(), 'calm': 1}, {**row(), 'exceeds': 1}, {**row(), 'rose': [0] * 127}, {**row(), 'originalSha256': 'b' * 64}]:
            with self.assertRaises(ValueError): checked_row(bad, 1991, 1, 'wind', 'a' * 64)


def packet_fixture(path):
    path.mkdir()
    originals = {original_id(y, m, k): receipt(y, m, k) for y in range(FIRST, LAST + 1) for m in range(1, 13) for k in KINDS}
    cohort = sha(canonical(originals)); generation = sha(canonical({'plan': PLAN_SHA, 'cohort': cohort}))
    tiles = {}
    for key in ('18_0', '18_1'):
        data = canonical({'schema': 1, 'generation': generation, 'key': key, 'cells': []})
        (path / f'tile-{key}.json').write_bytes(data)
        tiles[key] = {'bytes': len(data), 'sha256': sha(data)}
    manifest = {'schema': 1, 'kind': 'era5-climate', 'generation': generation, 'firstYear': FIRST, 'lastYear': LAST,
                'gridDegrees': 1, 'originals': 720, 'dataset': DATASET, 'licence': 'CC-BY-4.0', 'method': METHOD,
                'originalCohortSha256': cohort, 'generatedAt': '2026-10-17T00:00:00Z', 'tiles': tiles}
    raw = canonical(manifest)
    (path / 'manifest.json').write_bytes(raw)
    (path / 'latest.json').write_bytes(canonical({'schema': 1, 'generation': generation, 'manifest': {'bytes': len(raw), 'sha256': sha(raw)}}))
    (path / 'originals-seal.json').write_bytes(canonical({'schema': 1, 'planSha256': PLAN_SHA, 'originals': originals}))


class Store:
    def __init__(self, fail=False): self.objects, self.writes, self.fail = {}, [], fail
    def put_immutable(self, key, value):
        if key in self.objects and self.objects[key] != value: raise ValueError('immutable overwrite')
        self.objects[key] = value; self.writes.append(key)
    def put_pointer(self, key, value): self.objects[key] = value; self.writes.append(key)
    def read(self, key, cap): return b'corrupt' if self.fail and 'tile-18_1' in key else self.objects[key]


class ClimatePublicationTests(unittest.TestCase):
    def test_pointer_is_last_after_all_children_and_manifest_readbacks(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / 'packet'; packet_fixture(path); store = Store()
            result = publish(path, store)
            self.assertEqual(result['children'], 2)
            self.assertEqual(store.writes[-1], 'climate/era5-v1/latest.json')
            self.assertTrue(store.writes[-2].endswith('/manifest.json'))
            self.assertFalse(any('originals-seal' in key for key in store.writes))

    def test_readback_failure_never_promotes_pointer_and_local_corruption_writes_nothing(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / 'packet'; packet_fixture(path); store = Store(fail=True)
            with self.assertRaisesRegex(ValueError, 'readback'): publish(path, store)
            self.assertFalse(any(key.endswith('/latest.json') for key in store.writes))
            (path / 'tile-18_0.json').write_bytes(b'tampered')
            clean = Store()
            with self.assertRaises(ValueError): publish(path, clean)
            self.assertEqual(clean.writes, [])

    def test_missing_original_seal_holds_before_any_public_write(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / 'packet'; packet_fixture(path); store = Store()
            seal = json.loads((path / 'originals-seal.json').read_bytes()); seal['originals'].pop('1991-01-wind')
            (path / 'originals-seal.json').write_bytes(canonical(seal))
            with self.assertRaisesRegex(ValueError, 'seal'): publish(path, store)
            self.assertEqual(store.writes, [])

    def test_child_changed_after_preflight_cannot_promote_a_mixed_cohort(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / 'packet'; packet_fixture(path)
            class ChangingStore(Store):
                def put_immutable(self, key, value):
                    super().put_immutable(key, value)
                    if key.endswith('/tile-18_0.json'):
                        (path / 'tile-18_1.json').write_bytes(b'changed-after-preflight')
            store = ChangingStore()
            with self.assertRaisesRegex(ValueError, 'changed during'): publish(path, store)
            self.assertEqual(len(store.writes), 1)
            self.assertFalse(any(key.endswith('/latest.json') for key in store.writes))


if __name__ == '__main__':
    unittest.main()
