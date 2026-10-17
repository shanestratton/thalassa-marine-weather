"""Pure controller refusals; no native imports or claimed native acceptance."""
import ast
from pathlib import Path
import sys
import tempfile
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import corrected_original_native as proof


class CorrectedOriginalTests(unittest.TestCase):
    def capture(self):
        return {'outcome': 'download-complete-native-unadmitted', 'originalSha256': proof.ORIGINAL_SHA,
                'writtenOriginalBytes': proof.ORIGINAL_BYTES, 'nativeAdmitted': False, 'published': False}

    def test_exact_retained_capture_contract(self):
        proof.admit_capture(self.capture())

    def test_capture_never_aliases_another_digest(self):
        row = self.capture(); row['originalSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'provenance'): proof.admit_capture(row)

    def test_capture_never_accepts_partial_bytes(self):
        row = self.capture(); row['writtenOriginalBytes'] -= 1
        with self.assertRaisesRegex(ValueError, 'provenance'): proof.admit_capture(row)

    def test_capture_never_claims_prior_native_admission(self):
        row = self.capture(); row['nativeAdmitted'] = True
        with self.assertRaisesRegex(ValueError, 'provenance'): proof.admit_capture(row)

    def test_capture_never_accepts_prior_publication(self):
        row = self.capture(); row['published'] = True
        with self.assertRaisesRegex(ValueError, 'provenance'): proof.admit_capture(row)

    def test_source_manifest_requires_exact_corrected_identity(self):
        with self.assertRaisesRegex(ValueError, 'manifest'):
            proof.verify_source(Path('.'), {'source': '9f' * 20, 'files': proof.EXPECTED_FILES})

    def test_source_manifest_refuses_native_guard_hash_change(self):
        with self.assertRaisesRegex(ValueError, 'manifest'):
            proof.verify_source(Path('.'), {'source': proof.SOURCE, 'files': {**proof.EXPECTED_FILES, 'native.py': 'a' * 64}})

    def test_original_length_rejected_before_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'partial.grib2'; path.write_bytes(b'GRIB')
            with self.assertRaisesRegex(ValueError, 'length/path'): proof.verify_input(path, self.capture())

    def test_same_length_wrong_original_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'wrong.grib2'; path.write_bytes(b'x' * proof.ORIGINAL_BYTES)
            with self.assertRaisesRegex(ValueError, 'digest'): proof.verify_input(path, self.capture())

    def test_old_wider_grid_cannot_be_reported_as_admitted(self):
        with self.assertRaisesRegex(ValueError, 'cardinality'):
            proof.field_summary(types.SimpleNamespace(shape=(801, 721), size=577521), {}, {}, None)

    def test_partial_corrected_grid_refused(self):
        with self.assertRaisesRegex(ValueError, 'cardinality'):
            proof.field_summary(types.SimpleNamespace(shape=(491, 521), size=255810), {}, {}, None)

    def test_wrong_module_identity_refused(self):
        with self.assertRaisesRegex(ValueError, 'another source'):
            proof.exact_module(types.SimpleNamespace(__file__=__file__), Path('other/native.py'))

    def test_bounded_text_refuses_nonfinite_json(self):
        with self.assertRaises(ValueError): proof.encoded({'value': float('nan')})

    def test_bounded_text_refuses_large_payload(self):
        with self.assertRaisesRegex(ValueError, 'text bound'): proof.encoded({'value': 'x' * proof.MAX_TEXT})

    def test_no_scientific_module_or_native_import_before_kernel_admission(self):
        tree = ast.parse(Path(proof.__file__).read_text())
        imports = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))]
        names = [node.module if isinstance(node, ast.ImportFrom) else node.names[0].name for node in imports]
        self.assertFalse({'catalogue', 'native', 'eccodes', 'numpy', 'original_pilot_native'}.intersection(names))
        self.assertNotIn('eccodes', sys.modules)
        self.assertNotIn('numpy', sys.modules)


if __name__ == '__main__': unittest.main()
