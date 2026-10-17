"""Synthetic response/receipt contracts; no provider or native acceptance claim."""
from datetime import datetime, timezone
from email.message import Message
import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import constant_original as capture
import constant_native as native

NOW = datetime(2026, 10, 17, 14, tzinfo=timezone.utc)


class Reply:
    def __init__(self):
        self.status = 200
        self.url = capture.URL
        self.headers = Message()
        self.headers['Content-Length'] = str(capture.EXPECTED)
        self.headers['ETag'] = capture.ETAG
        self.body = io.BytesIO(b'fictional-mask-not-GRIB'.ljust(capture.EXPECTED, b'x'))

    def __enter__(self): return self
    def __exit__(self, *_): return None
    def read(self, size): return self.body.read(size)


class ConstantConditionTests(unittest.TestCase):
    def run_reply(self, response, expected_error=None):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            requests = []
            class Opener:
                def open(self, request, timeout):
                    requests.append(request)
                    self_timeout = timeout
                    assert self_timeout == 20
                    return response
            with patch.object(capture, 'utc_now', return_value=NOW), patch.object(
                    capture.urllib.request, 'build_opener', return_value=Opener()) as builder:
                if expected_error:
                    with self.assertRaisesRegex(capture.Refused, expected_error): capture.download_child(output)
                else:
                    capture.download_child(output)
                self.assertEqual(builder.call_count, 1)
                self.assertEqual(builder.call_args.args[0].proxies, {})
                self.assertIsInstance(builder.call_args.args[1], capture.NoRedirect)
            self.assertEqual(len(requests), 1)
            request = requests[0]
            self.assertEqual(request.full_url, capture.URL)
            self.assertEqual(request.get_method(), 'GET')
            self.assertEqual(request.get_header('If-match'), capture.ETAG)
            self.assertEqual(request.get_header('Accept-encoding'), 'identity')
            for key in ('Range', 'Authorization', 'Cookie'): self.assertIsNone(request.get_header(key))
            facts = capture.bounded_json(output / 'transport.json', 131072)
            self.assertEqual(facts['ifMatch'], capture.ETAG)
            self.assertEqual(facts['outcome'], 'failed-no-retry' if expected_error else 'complete-exact-original')
            return facts

    def test_fixed_conditional_request_and_exact_reply(self):
        facts = self.run_reply(Reply())
        self.assertEqual(facts['bodyBytes'], 44900)

    def test_etag_changed(self):
        reply = Reply(); reply.headers.replace_header('ETag', '"changed"')
        self.run_reply(reply, 'conditional ETag')

    def test_weak_etag_refused(self):
        reply = Reply(); reply.headers.replace_header('ETag', 'W/' + capture.ETAG)
        self.run_reply(reply, 'conditional ETag')

    def test_duplicate_etag_refused(self):
        reply = Reply(); reply.headers['ETag'] = capture.ETAG
        self.run_reply(reply, 'conditional ETag')

    def test_absent_etag_refused(self):
        reply = Reply(); del reply.headers['ETag']
        self.run_reply(reply, 'conditional ETag')

    def test_absent_content_length_refused(self):
        reply = Reply(); del reply.headers['Content-Length']
        self.run_reply(reply, 'Content-Length')

    def test_duplicate_content_length_refused(self):
        reply = Reply(); reply.headers['Content-Length'] = str(capture.EXPECTED)
        self.run_reply(reply, 'Content-Length')

    def test_changed_content_length_refused(self):
        reply = Reply(); reply.headers.replace_header('Content-Length', '44899')
        self.run_reply(reply, 'Content-Length')

    def test_changed_status_refused(self):
        reply = Reply(); reply.status = 206
        self.run_reply(reply, 'status/redirect')

    def test_redirected_url_refused(self):
        reply = Reply(); reply.url += '?redirected'
        self.run_reply(reply, 'status/redirect')

    def test_encoded_body_refused(self):
        reply = Reply(); reply.headers['Content-Encoding'] = 'gzip'
        self.run_reply(reply, 'encoded original')

    def receipt(self):
        digest = hashlib.sha256(b'fictional').hexdigest()
        return ({'source': native.SOURCE, 'attempt': native.ATTEMPT,
                 'outcome': 'download-complete-native-unadmitted', 'writtenOriginalBytes': 44900,
                 'originalSha256': digest, 'nativeAdmitted': False, 'published': False},
                {'outcome': 'complete-exact-original', 'method': 'GET', 'url': native.URL, 'status': 200,
                 'ifMatch': native.ETAG, 'bodyBytes': 44900, 'redirects': 0, 'retries': 0,
                 'range': False, 'credentials': False, 'headers': {'content-length': '44900', 'etag': native.ETAG}}, digest)

    def test_native_capture_receipt_exact(self): native.admit_capture(*self.receipt())

    def test_native_capture_digest_mismatch(self):
        value, transport, _ = self.receipt()
        with self.assertRaisesRegex(ValueError, 'capture provenance'): native.admit_capture(value, transport, 'a' * 64)

    def test_native_capture_source_mismatch(self):
        value, transport, digest = self.receipt(); value['source'] = '9f' * 20
        with self.assertRaisesRegex(ValueError, 'capture provenance'): native.admit_capture(value, transport, digest)

    def test_native_transport_condition_mismatch(self):
        value, transport, digest = self.receipt(); transport['ifMatch'] = '"changed"'
        with self.assertRaisesRegex(ValueError, 'transport provenance'): native.admit_capture(value, transport, digest)

    def test_native_transport_retries_refused(self):
        value, transport, digest = self.receipt(); transport['retries'] = 1
        with self.assertRaisesRegex(ValueError, 'transport provenance'): native.admit_capture(value, transport, digest)

    def test_native_transport_redirects_refused(self):
        value, transport, digest = self.receipt(); transport['redirects'] = 1
        with self.assertRaisesRegex(ValueError, 'transport provenance'): native.admit_capture(value, transport, digest)

    def test_native_header_mismatch_refused(self):
        value, transport, digest = self.receipt(); transport['headers']['etag'] = '"changed"'
        with self.assertRaisesRegex(ValueError, 'response identity'): native.admit_capture(value, transport, digest)

    def test_exact_actual_h000_prerequisite(self):
        raw = Path(os.environ['AROME_H000_PROOF']).read_bytes()
        capture.check_h000_proof(raw, NOW)

    def test_changed_h000_prerequisite_refused(self):
        raw = Path(os.environ['AROME_H000_PROOF']).read_bytes()
        with self.assertRaisesRegex(ValueError, 'native proof changed'):
            capture.check_h000_proof(raw[:-1] + b' ', NOW)

    def test_empty_h000_prerequisite_refuses_before_any_transfer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); state = root / 'state'; state.mkdir()
            with self.assertRaisesRegex(capture.Refused, 'native proof changed'):
                capture.capture(state / 'day.sqlite', root / 'attempt',
                    Path(os.environ['AROME_PILOT_CATALOGUE']).read_bytes(),
                    __import__('test_constant_original').ticket(), NOW,
                    lambda _: self.fail('unqualified transfer attempted'), h000_proof=b'')
            self.assertFalse((state / 'day.sqlite').exists())


if __name__ == '__main__': unittest.main()
