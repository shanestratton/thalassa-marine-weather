"""Offline boundaries; fabricated bodies never stand in for a provider result."""
import ast
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import original_pilot as pilot

NOW = datetime(2026, 10, 17, 12, tzinfo=timezone.utc)
CATALOGUE = Path(os.environ['AROME_PILOT_CATALOGUE']).read_bytes()


def ticket():
    return {'schema': 1, 'attempt': pilot.ATTEMPT, 'day': pilot.DAY, 'source': pilot.SOURCE,
            'catalogueSha256': pilot.CATALOGUE_SHA, 'maximumRequests': 1,
            'expectedDeclaredBytes': pilot.EXPECTED, 'reservedBytes': pilot.CAP,
            'priorReviewedApplicationBytes': 2656963, 'dailyMaximumBytes': pilot.DAY_CAP,
            'otherAromeAcquisitionHeld': True, 'expiresAt': pilot.EXPIRES, 'reviewRequired': True}


def fabricated_transfer(output):
    (output / 'original.grib2').write_bytes(b'fictional-only'.ljust(pilot.EXPECTED, b'x'))
    pilot.write_json(output / 'transport.json', {'outcome': 'complete-exact-original'})
    return 0


class OriginalPilotTests(unittest.TestCase):
    def context(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        state = root / 'state'
        state.mkdir()
        return root, state / 'day.sqlite'

    def test_captured_catalogue_exact_declaration(self):
        plan = pilot.check_catalogue(CATALOGUE, NOW)
        self.assertEqual(len(plan['packets']), 49)
        self.assertEqual(plan['packets'][0]['bytes'], 1373100)
        self.assertEqual(plan['catalogueSha256'], pilot.CATALOGUE_SHA)

    def test_changed_catalogue_refuses_before_reservation(self):
        root, ledger = self.context()
        with self.assertRaises(pilot.Refused):
            pilot.capture(ledger, root / 'attempt', CATALOGUE + b' ', ticket(), NOW, fabricated_transfer)
        self.assertFalse(ledger.exists())

    def test_original_clock_future_stale_and_exact_expiry_refuse(self):
        for value in ((2026, 10, 16, 23), (2026, 10, 17, 18), (2026, 10, 18, 0)):
            with self.subTest(value=value), self.assertRaises(pilot.Refused):
                pilot.fresh(datetime(*value, tzinfo=timezone.utc))

    def test_naive_clock_refuses(self):
        with self.assertRaises(pilot.Refused):
            pilot.fresh(NOW.replace(tzinfo=None))

    def test_ticket_changed_source_or_product_refuses(self):
        for key in ('source', 'catalogueSha256', 'day', 'expiresAt', 'attempt'):
            value = ticket(); value[key] = 'changed'
            with self.subTest(key=key), self.assertRaises(pilot.Refused):
                pilot.check_ticket(value, NOW)

    def test_ticket_no_extra_url_or_credential_input(self):
        value = ticket(); value['url'] = 'https://fictional.invalid'
        with self.assertRaises(pilot.Refused):
            pilot.check_ticket(value, NOW)

    def test_ticket_caps_requests_and_declared_bytes_exact(self):
        for key in ('maximumRequests', 'expectedDeclaredBytes', 'reservedBytes', 'dailyMaximumBytes'):
            value = ticket(); value[key] += 1
            with self.subTest(key=key), self.assertRaises(pilot.Refused):
                pilot.check_ticket(value, NOW)

    def test_ticket_bool_is_not_integer(self):
        value = ticket(); value['priorReviewedApplicationBytes'] = False
        with self.assertRaises(pilot.Refused):
            pilot.check_ticket(value, NOW)

    def test_daily_worst_case_reservation_refuses_exhaustion(self):
        value = ticket(); value['priorReviewedApplicationBytes'] = pilot.DAY_CAP - pilot.CAP + 1
        with self.assertRaises(pilot.Refused):
            pilot.check_ticket(value, NOW)

    def test_concurrent_acquisition_must_remain_held(self):
        value = ticket(); value['otherAromeAcquisitionHeld'] = False
        with self.assertRaises(pilot.Refused):
            pilot.check_ticket(value, NOW)

    def test_reservation_durable_before_transfer(self):
        root, ledger = self.context()
        def transfer(output):
            with closing(sqlite3.connect(ledger)) as db:
                self.assertEqual(db.execute('SELECT reserved FROM day').fetchone()[0], pilot.CAP)
                self.assertEqual(db.execute('SELECT state FROM attempt').fetchone()[0], 'reserved-before-get')
            self.assertEqual(json.loads((output / 'reservation.json').read_bytes())['requestsReservedBeforeGet'], 1)
            return fabricated_transfer(output)
        result = pilot.capture(ledger, root / 'attempt', CATALOGUE, ticket(), NOW, transfer)
        self.assertEqual(result['outcome'], 'download-complete-native-unadmitted')
        self.assertFalse(result['nativeAdmitted'])
        self.assertFalse(result['published'])

    def test_second_attempt_never_calls_transport(self):
        root, ledger = self.context()
        pilot.capture(ledger, root / 'a', CATALOGUE, ticket(), NOW, fabricated_transfer)
        with self.assertRaises(pilot.Refused):
            pilot.capture(ledger, root / 'b', CATALOGUE, ticket(), NOW,
                          lambda _: self.fail('repeat transport called'))

    def test_partial_bytes_and_sha_preserved_and_charged(self):
        root, ledger = self.context()
        def transfer(output):
            (output / 'original.grib2').write_bytes(b'fictional-partial')
            raise TimeoutError('fictional deadline')
        result = pilot.capture(ledger, root / 'a', CATALOGUE, ticket(), NOW, transfer)
        self.assertEqual(result['originalSha256'], hashlib.sha256(b'fictional-partial').hexdigest())
        self.assertEqual(result['writtenOriginalBytes'], len(b'fictional-partial'))
        self.assertEqual(result['outcome'], 'failed-or-unknown-no-retry')
        with closing(sqlite3.connect(ledger)) as db:
            self.assertEqual(db.execute('SELECT reserved FROM day').fetchone()[0], pilot.CAP)

    def test_transport_error_zero_body_holds_reservation(self):
        root, ledger = self.context()
        result = pilot.capture(ledger, root / 'a', CATALOGUE, ticket(), NOW, lambda _: 1)
        self.assertEqual(result['writtenOriginalBytes'], 0)
        self.assertIsNone(result['originalSha256'])
        self.assertTrue(result['full16MiBReservationRetained'])

    def test_fake_success_missing_exact_receipt_refuses(self):
        root, ledger = self.context()
        result = pilot.capture(ledger, root / 'a', CATALOGUE, ticket(), NOW, lambda _: 0)
        self.assertEqual(result['outcome'], 'failed-or-unknown-no-retry')

    def test_short_completed_body_refuses(self):
        root, ledger = self.context()
        def transfer(output):
            (output / 'original.grib2').write_bytes(b'short')
            pilot.write_json(output / 'transport.json', {'outcome': 'complete-exact-original'})
            return 0
        self.assertEqual(pilot.capture(ledger, root / 'a', CATALOGUE, ticket(), NOW, transfer)['outcome'],
                         'failed-or-unknown-no-retry')

    def test_empty_malformed_and_unowned_ledger_never_reset(self):
        for raw in (b'', b'not sqlite', b'{}'):
            root, ledger = self.context(); ledger.write_bytes(raw)
            with self.subTest(raw=raw), self.assertRaises(pilot.Refused):
                pilot.reserve(ledger, ticket(), NOW)
            self.assertEqual(ledger.read_bytes(), raw)

    def test_deleted_ledger_with_historical_artifact_refuses(self):
        root, ledger = self.context(); (ledger.parent / 'historical.json').write_text('{}')
        with self.assertRaises(pilot.Refused):
            pilot.reserve(ledger, ticket(), NOW)

    def test_preexisting_output_refuses_before_network(self):
        root, ledger = self.context(); (root / 'attempt').mkdir()
        with self.assertRaises(pilot.Refused):
            pilot.capture(ledger, root / 'attempt', CATALOGUE, ticket(), NOW, lambda _: self.fail('network'))
        self.assertFalse(ledger.exists())

    def test_real_sqlite_competing_reservations_have_one_winner(self):
        root, ledger = self.context()
        barrier = threading.Barrier(2)
        def reserve_once(_):
            barrier.wait()
            try:
                pilot.reserve(ledger, ticket(), NOW); return True
            except (pilot.Refused, FileExistsError):
                return False
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(reserve_once, range(2))), [False, True])

    def test_stream_body_exact_bytes(self):
        destination = io.BytesIO()
        self.assertEqual(pilot.receive_body(io.BytesIO(b'x' * pilot.EXPECTED), destination), pilot.EXPECTED)
        self.assertEqual(len(destination.getvalue()), pilot.EXPECTED)

    def test_stream_short_body_refuses(self):
        with self.assertRaises(pilot.Refused):
            pilot.receive_body(io.BytesIO(b'x' * 12), io.BytesIO())

    def test_stream_extra_bytes_preserved_then_refused(self):
        destination = io.BytesIO()
        with self.assertRaises(pilot.Refused):
            pilot.receive_body(io.BytesIO(b'x' * (pilot.EXPECTED + 1)), destination)
        self.assertEqual(len(destination.getvalue()), pilot.EXPECTED + 1)

    def test_stream_absolute_body_deadline_not_reset_by_chunks(self):
        clocks = iter((0, 0, 21))
        with self.assertRaises(pilot.Refused):
            pilot.receive_body(io.BytesIO(b'x' * pilot.EXPECTED), io.BytesIO(), lambda: next(clocks))

    def test_no_redirect_handler(self):
        self.assertIsNone(pilot.NoRedirect().redirect_request(None, None, None, None, None, None))

    def test_parent_rechecks_actual_clock_after_transfer(self):
        root, ledger = self.context()
        with patch.object(pilot, 'utc_now', side_effect=[NOW, datetime(2026, 10, 17, 18, tzinfo=timezone.utc)]):
            result = pilot.capture(ledger, root / 'attempt', CATALOGUE, ticket(), transport=fabricated_transfer)
        self.assertEqual(result['outcome'], 'failed-or-unknown-no-retry')

    def test_native_boundary_import_follows_kernel_admission(self):
        raw = (Path(__file__).resolve().parents[1] / 'original_pilot_native.py').read_text()
        tree = ast.parse(raw)
        for node in tree.body:
            self.assertFalse(isinstance(node, ast.Import) and any(n.name in ('numpy', 'eccodes') for n in node.names))
        self.assertLess(raw.index('cgroup, kernel = kernel_before_native()'), raw.index('    import eccodes'))
        self.assertIn("decode_packet(raw, 'NCALED', '2026-10-17T00:00:00Z', 0)", raw)


if __name__ == '__main__':
    unittest.main()
