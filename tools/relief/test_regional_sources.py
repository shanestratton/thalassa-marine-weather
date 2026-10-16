"""Synthetic validators only: no real raster bodies, boat data or network."""
import hashlib
import io
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipInfo

from regional_sources import COMPRESSED_LIMIT, SOURCES, NoRedirect, acquire, validate_zip


def entry(name, size=10):
    value = ZipInfo(name)
    value.file_size = size
    return value


class ArchiveBoundaries(unittest.TestCase):
    def test_nested_public_rasters_and_a_directory_are_allowed(self):
        self.assertEqual(validate_zip([entry('source/'), entry('source/height.tif', 200)]), 210)

    def test_paths_controls_duplicates_links_and_encryption_are_rejected(self):
        for name in ('../outside.tif', '/outside.tif', 'C:/outside.tif', 'source\\outside.tif',
                     'source/../outside.tif', './height.tif', 'source/\x01height.tif', 'source//height.tif'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_zip([entry(name)])
        with self.assertRaises(ValueError):
            validate_zip([entry('same.tif'), entry('same.tif')])
        symlink = entry('linked.tif')
        symlink.external_attr = 0o120777 << 16
        with self.assertRaises(ValueError):
            validate_zip([symlink])
        encrypted = entry('encrypted.tif')
        encrypted.flag_bits = 1
        with self.assertRaises(ValueError):
            validate_zip([encrypted])

    def test_declared_size_and_entry_count_are_bounded_before_extraction(self):
        with self.assertRaisesRegex(ValueError, 'Expanded'):
            validate_zip([entry('huge.tif', 101)], limit=100)
        with self.assertRaisesRegex(ValueError, 'many entries'):
            validate_zip([entry(f'{n}.tif') for n in range(129)])


class Response(io.BytesIO):
    def __init__(self, body, declared='4', mime='image/tiff'):
        super().__init__(body)
        self.headers = Message()
        self.headers['Content-Length'] = declared
        self.headers['Content-Type'] = mime
        self.status = 200
        self.url = 'https://public.example/height.tif'


class DownloadBoundaries(unittest.TestCase):
    source = {'url': 'https://public.example/height.tif', 'bytes': 4, 'mime': 'image/tiff',
              'sha256': hashlib.sha256(b'test').hexdigest()}

    def download(self, body, declared='4', mime='image/tiff'):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        target = Path(temporary.name) / 'height.tif'
        response = Response(body, declared, mime)
        with patch('regional_sources.urllib.request.build_opener') as opener:
            opener.return_value.open.return_value = response
            result = acquire(self.source, target)
        return target, result

    def test_exact_body_is_hashed_and_committed_only_when_complete(self):
        target, digest = self.download(b'test')
        self.assertEqual(digest, self.source['sha256'])
        self.assertEqual(target.read_bytes(), b'test')
        self.assertFalse(target.with_suffix('.tif.partial').exists())

    def test_changed_size_type_truncated_oversized_or_changed_hash_is_refused(self):
        for body, declared, mime in [(b'test', '5', 'image/tiff'), (b'test', '4', 'text/html'),
                                     (b'bad', '4', 'image/tiff'), (b'tests', '4', 'image/tiff'),
                                     (b'evil', '4', 'image/tiff')]:
            with self.subTest(body=body, declared=declared, mime=mime), self.assertRaises(ValueError):
                self.download(body, declared, mime)

    def test_existing_same_size_unreviewed_input_is_not_trusted(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'height.tif'
            target.write_bytes(b'evil')
            with self.assertRaisesRegex(ValueError, 'hash differs'):
                acquire(self.source, target)
            self.assertEqual(target.read_bytes(), b'evil')

    def test_redirects_require_a_reviewed_identity(self):
        with self.assertRaisesRegex(ValueError, 'redirect refused'):
            NoRedirect().redirect_request(None, None, 302, '', None, 'https://unreviewed.example/')

    def test_only_two_exact_reviewed_provider_inputs_fit_the_total_budget(self):
        self.assertEqual(set(SOURCES), {'au250', 'pr'})
        self.assertLessEqual(sum(source['bytes'] for source in SOURCES.values()), COMPRESSED_LIMIT)
        self.assertTrue(all(len(source['sha256']) == 64 for source in SOURCES.values()))


if __name__ == '__main__':
    unittest.main()
