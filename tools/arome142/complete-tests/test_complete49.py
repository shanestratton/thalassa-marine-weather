"""Pure fixed48 state tests. Fabricated sparse bodies are NOT native/provider data."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import complete49 as pilot
from complete49_native import admit_deadline

NOW = datetime(2026, 10, 17, 15, tzinfo=timezone.utc)
CATALOGUE = Path(os.environ['AROME_PILOT_CATALOGUE'])
H000 = Path(os.environ['AROME_H000_ORIGINAL'])
MASK = Path(os.environ['AROME_MASK_ORIGINAL'])
H000_PROOF = Path(os.environ['AROME_H000_PROOF']).read_bytes()
MASK_PROOF = Path(os.environ['AROME_MASK_PROOF']).read_bytes()


def ticket():
    return {'schema': 1, 'attempt': pilot.ATTEMPT, 'day': pilot.DAY, 'source': pilot.SOURCE,
        'catalogueSha256': pilot.CATALOGUE_SHA, 'originalRunUtc': pilot.RUN, 'expiresAt': pilot.EXPIRES,
        'maximumRequests': 48, 'expectedDeclaredBytes': 136003911, 'reservedBytes': 805306368,
        'priorReviewedApplicationBytes': 36211395, 'dailyMaximumBytes': 2500000000,
        'otherAromeAcquisitionHeld': True, 'h000NativeProofSha256': pilot.H000_PROOF_SHA,
        'maskNativeProofSha256': pilot.MASK_PROOF_SHA, 'maskOriginalSha256': pilot.MASK_SHA,
        'fullAttemptSeconds': 1200, 'perReadSeconds': 20, 'reviewRequired': True}


def capture(ledger, output, transport, **kwargs):
    return pilot.capture_all(ledger, output, CATALOGUE, ticket(), H000, MASK,
        H000_PROOF, MASK_PROOF, clock=lambda: NOW, transport=transport, **kwargs)


def fictional_body(output, offset, catalogue, _deadline):
    packet = pilot.plan_from(Path(catalogue).read_bytes(), NOW)['packets'][offset]
    with (output / 'original.grib2').open('xb') as stream: stream.truncate(packet['bytes'])
    pilot.write_json(output / 'transport.json', {'outcome': 'complete-exact-original',
        'offsetHours': offset, 'url': packet['url'], 'status': 200, 'bodyBytes': packet['bytes']})
    return 0


class CompleteOriginalTests(unittest.TestCase):
    def context(self):
        base = Path(tempfile.gettempdir()).resolve()
        temporary = tempfile.TemporaryDirectory(prefix='arome142-complete49-fictional-', dir=base)
        root = Path(temporary.name).resolve()
        self.assertTrue(root.is_relative_to(base))
        self.addCleanup(temporary.cleanup)
        (root / 'state').mkdir()
        return root, root / 'state/day.sqlite'

    def test_exact_prior_proofs_and_originals(self):
        pilot.admit_priors(H000_PROOF, MASK_PROOF, NOW)
        self.assertEqual(len(pilot.verified_file(H000, pilot.H000_BYTES, pilot.H000_SHA)), pilot.H000_BYTES)
        self.assertEqual(len(pilot.verified_file(MASK, pilot.MASK_BYTES, pilot.MASK_SHA)), pilot.MASK_BYTES)

    def test_changed_h000_proof_refuses(self):
        with self.assertRaisesRegex(pilot.Refused, 'h000 native proof'):
            pilot.admit_priors(H000_PROOF + b' ', MASK_PROOF, NOW)

    def test_changed_mask_proof_refuses(self):
        with self.assertRaisesRegex(pilot.Refused, 'mask native proof'):
            pilot.admit_priors(H000_PROOF, MASK_PROOF[:-1] + b' ', NOW)

    def test_wrong_retained_original_refuses(self):
        root, _ = self.context(); wrong = root / 'wrong'; wrong.write_bytes(b'x' * pilot.MASK_BYTES)
        with self.assertRaisesRegex(pilot.Refused, 'hash changed'):
            pilot.verified_file(wrong, pilot.MASK_BYTES, pilot.MASK_SHA)

    def test_exact_original_metadata_plan(self):
        plan = pilot.plan_from(CATALOGUE.read_bytes(), NOW)
        self.assertEqual([row['offsetHours'] for row in plan['packets']], list(range(49)))
        self.assertEqual(sum(row['bytes'] for row in plan['packets'][1:]), 136003911)
        self.assertEqual((plan['width'], plan['height']), (521, 491))

    def test_changed_catalogue_refuses(self):
        with self.assertRaisesRegex(pilot.Refused, 'catalogue changed'):
            pilot.plan_from(CATALOGUE.read_bytes() + b' ', NOW)

    def test_oversize_catalogue_file_refuses_before_read(self):
        root, _ = self.context(); path = root / 'oversize.json'
        with path.open('xb') as stream: stream.truncate(4 * 1024**2 + 1)
        with self.assertRaisesRegex(pilot.Refused, 'bounded original catalogue path'):
            pilot.catalogue_bytes(path)

    def test_ticket_all_fields_exact(self): pilot.check_ticket(ticket(), NOW)

    def test_ticket_higher_reads_or_budget_refused(self):
        for key in ('maximumRequests', 'reservedBytes', 'priorReviewedApplicationBytes', 'fullAttemptSeconds', 'perReadSeconds'):
            value = ticket(); value[key] += 1
            with self.subTest(key=key), self.assertRaises(pilot.Refused): pilot.check_ticket(value, NOW)

    def test_ticket_no_url_or_credentials(self):
        value = ticket(); value['url'] = 'https://fictional.invalid'
        with self.assertRaises(pilot.Refused): pilot.check_ticket(value, NOW)

    def test_ticket_bool_not_integer(self):
        value = ticket(); value['maximumRequests'] = True
        with self.assertRaises(pilot.Refused): pilot.check_ticket(value, NOW)

    def test_whole_deadline_and_original_expiry(self):
        pilot.within(1200, NOW, lambda: 1199)
        with self.assertRaises(pilot.Refused): pilot.within(1200, NOW, lambda: 1200)
        with self.assertRaises(pilot.Refused): pilot.within(float('nan'), NOW, lambda: 1)
        with self.assertRaises(pilot.Refused): pilot.within(1200, datetime(2026,10,17,18,tzinfo=timezone.utc), lambda: 1)

    def test_no_h000_or_mask_network_mode(self):
        for offset in (0, -1, 49, False):
            with self.subTest(offset=offset), self.assertRaisesRegex(pilot.Refused, 'refetch'):
                pilot.download_child(Path('.'), offset, CATALOGUE)

    def test_all48_reservations_commit_before_transport(self):
        root, ledger = self.context()
        def first(_, offset, __, ___):
            self.assertEqual(offset, 1)
            with closing(sqlite3.connect(ledger)) as db:
                self.assertEqual(db.execute('SELECT prior,reserved FROM day').fetchone(), (36211395, 805306368))
                self.assertEqual(db.execute("SELECT COUNT(*) FROM packet WHERE state='reserved'").fetchone()[0], 47)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM packet WHERE state='receiving'").fetchone()[0], 1)
            return 1
        result = capture(ledger, root / 'attempt', first)
        self.assertEqual(result['outcome'], 'failed-or-unknown-never-retry')
        self.assertEqual(result['transfersStartedConservative'], 1)
        self.assertEqual(result['reservedWorstCaseBytesRetained'], 805306368)

    def test_complete_fictional_capture_never_claims_native_admission(self):
        root, ledger = self.context(); offsets = []
        def transfer(*args): offsets.append(args[1]); return fictional_body(*args)
        result = capture(ledger, root / 'attempt', transfer)
        self.assertEqual(offsets, list(range(1, 49)))
        self.assertEqual(result['outcome'], 'all48-captured-native-unadmitted')
        self.assertEqual(result['completedNewOriginals'], 48)
        self.assertEqual(result['newCapturedBytes'], 136003911)
        self.assertFalse(result['full49HourCohortAdmitted']); self.assertFalse(result['published'])
        source = json.loads((root / 'attempt/sources.json').read_bytes())
        self.assertEqual(len(source['packets']), 49)
        self.assertEqual(source['packets'][0]['sha256'], pilot.H000_SHA)
        self.assertEqual(source['mask']['sha256'], pilot.MASK_SHA)

    def test_partial_then_failure_never_calls_next_transfer(self):
        root, ledger = self.context(); calls = []
        def transfer(output, offset, *_):
            calls.append(offset); (output / 'original.grib2').write_bytes(b'fictional-partial')
            raise TimeoutError('fictional deadline')
        result = capture(ledger, root / 'attempt', transfer)
        self.assertEqual(calls, [1]); self.assertEqual(result['completedNewOriginals'], 0)
        with closing(sqlite3.connect(ledger)) as db:
            self.assertEqual(db.execute('SELECT state,written FROM packet WHERE offset=1').fetchone(), ('failed-or-unknown', 17))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM packet WHERE state='reserved'").fetchone()[0], 47)

    def test_second_invocation_never_retries(self):
        root, ledger = self.context(); capture(ledger, root / 'first', lambda *_: 1)
        with self.assertRaises(pilot.Refused): capture(ledger, root / 'second', lambda *_: self.fail('retry'))

    def test_no_full_freshness_window_refuses_before_reservation(self):
        root, ledger = self.context()
        with self.assertRaisesRegex(pilot.Refused, 'freshness window'):
            pilot.capture_all(ledger, root / 'attempt', CATALOGUE, ticket(), H000, MASK,
                H000_PROOF, MASK_PROOF, clock=lambda: datetime(2026,10,17,17,50,tzinfo=timezone.utc),
                transport=lambda *_: self.fail('late transfer'))
        self.assertFalse(ledger.exists())

    def test_original_expiry_during_transfer_holds_body_and_stops(self):
        root, ledger = self.context(); clocks = iter((NOW, NOW, datetime(2026,10,17,18,tzinfo=timezone.utc)))
        result = pilot.capture_all(ledger, root / 'attempt', CATALOGUE, ticket(), H000, MASK,
            H000_PROOF, MASK_PROOF, clock=lambda: next(clocks), transport=fictional_body)
        self.assertEqual(result['transfersStartedConservative'], 1)
        self.assertEqual(result['completedNewOriginals'], 0)
        self.assertEqual(result['outcome'], 'failed-or-unknown-never-retry')
        self.assertTrue((root / 'attempt/hour-001/original.grib2').is_file())

    def test_global_deadline_during_transfer_does_not_restart(self):
        root, ledger = self.context(); clocks = iter((0, 1, 1200))
        result = capture(ledger, root / 'attempt', fictional_body, monotonic=lambda: next(clocks))
        self.assertEqual(result['deadlineMonotonic'], 1200)
        self.assertEqual(result['transfersStartedConservative'], 1)
        self.assertEqual(result['completedNewOriginals'], 0)
        self.assertEqual(result['reservedWorstCaseBytesRetained'], 805306368)

    def test_packet_transition_cannot_be_reused(self):
        root, ledger = self.context(); pilot.reserve(ledger, ticket(), NOW)
        pilot.transition(ledger, 1, 'reserved', 'receiving')
        with self.assertRaisesRegex(pilot.Refused, 'transition changed'):
            pilot.transition(ledger, 1, 'reserved', 'receiving')

    def test_empty_malformed_and_orphan_ledgers_refuse(self):
        for raw in (b'', b'not sqlite', b'{}'):
            root, ledger = self.context(); ledger.write_bytes(raw)
            with self.subTest(raw=raw), self.assertRaises(pilot.Refused): pilot.reserve(ledger, ticket(), NOW)
            self.assertEqual(ledger.read_bytes(), raw)
        root, ledger = self.context(); (ledger.parent / 'prior.json').write_text('{}')
        with self.assertRaises(pilot.Refused): pilot.reserve(ledger, ticket(), NOW)

    def test_actual_sqlite_reservation_race_has_one_winner(self):
        root, ledger = self.context(); barrier = threading.Barrier(2)
        def reserve(_):
            barrier.wait()
            try: pilot.reserve(ledger, ticket(), NOW); return True
            except (pilot.Refused, FileExistsError): return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(reserve, range(2))), [False, True])

    def test_body_exact_short_and_oversize(self):
        output = io.BytesIO(); self.assertEqual(pilot.receive(io.BytesIO(b'abc'), output, 3), 3)
        for value in (b'ab', b'abcd'):
            with self.subTest(value=value), self.assertRaises(pilot.Refused): pilot.receive(io.BytesIO(value), io.BytesIO(), 3)

    def test_body_deadline_not_renewed(self):
        clocks = iter((0, 0, 21))
        with self.assertRaises(pilot.Refused): pilot.receive(io.BytesIO(b'abc'), io.BytesIO(), 3, lambda: next(clocks))

    def test_native_uses_original_full_attempt_clock(self):
        row = {'source': pilot.SOURCE, 'attempt': pilot.ATTEMPT, 'outcome': 'all48-captured-native-unadmitted',
            'completedNewOriginals': 48, 'maximumRequests': 48, 'originalRunUtc': pilot.RUN,
            'originalExpiresAt': pilot.EXPIRES, 'h000Refetched': False, 'maskRefetched': False,
            'full49HourCohortAdmitted': False, 'published': False, 'startedMonotonic': 10,
            'deadlineMonotonic': 1210, 'startedAtUtc': NOW.isoformat()}
        self.assertEqual(admit_deadline(row, NOW, lambda: 20), 1210)
        with self.assertRaisesRegex(ValueError, 'clock changed'): admit_deadline({**row, 'deadlineMonotonic': 1211}, NOW, lambda: 20)
        with self.assertRaises(pilot.Refused): admit_deadline(row, NOW, lambda: 1210)
        with self.assertRaisesRegex(ValueError, 'moved backwards'):
            admit_deadline(row, datetime(2026,10,17,14,59,tzinfo=timezone.utc), lambda: 20)


if __name__ == '__main__': unittest.main()
