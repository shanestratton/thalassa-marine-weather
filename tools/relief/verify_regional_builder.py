"""Run inside the pinned GDAL image; temporary synthetic data only."""
import tempfile
import unittest
from pathlib import Path

import numpy as np

from build_au250 import BudgetWriter, workspace_size
from prove_regional import blend_elevations


class BoundedWriter(unittest.TestCase):
    def test_replacement_checks_peak_bytes_and_preserves_old_data_on_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            writer = BudgetWriter(root, 10)
            path = root / 'idx' / 'tile.png'
            writer.write(path, b'old!')
            writer.write(path, b'new!!!')
            self.assertEqual(writer.used, 6)
            with self.assertRaisesRegex(ValueError, 'byte cap'):
                writer.write(path, b'too large')
            self.assertEqual(path.read_bytes(), b'new!!!')
            self.assertFalse(path.with_name(path.name + '.partial').exists())

    def test_only_exact_generated_partial_is_reclaimed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'keep').write_bytes(b'keep')
            (root / 'tile.png.partial').write_bytes(b'bad')
            writer = BudgetWriter(root, 20, used=7)
            writer.write(root / 'tile.png', b'good')
            self.assertEqual((root / 'keep').read_bytes(), b'keep')
            self.assertEqual(writer.used, workspace_size(root))

    def test_outside_paths_and_symlinks_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            writer = BudgetWriter(root / 'output', 20)
            with self.assertRaises(ValueError):
                writer.write(root / 'outside.png', b'bad')
            (root / 'link').symlink_to(root / 'missing')
            with self.assertRaises(ValueError):
                workspace_size(root)


class CoverageAndFallback(unittest.TestCase):
    def blend(self, regional, fallback, valid, land=False, weight=0.2):
        return blend_elevations(np.array([[regional]]), np.array([[fallback]]),
                                np.array([[valid]]), np.array([[land]]), np.array([[weight]])).item()

    def test_missing_regional_water_uses_coarse_data_and_never_invents_zero(self):
        self.assertEqual(self.blend(float('nan'), -27, False), -27)

    def test_no_source_or_coarse_water_data_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'Unknown water'):
            self.blend(float('nan'), float('nan'), False)

    def test_explicit_land_remains_zero_and_missing_coarse_cannot_dilute_valid_source(self):
        self.assertEqual(self.blend(float('nan'), float('nan'), False, land=True), 0)
        self.assertEqual(self.blend(-30, float('nan'), True), -30)


if __name__ == '__main__':
    unittest.main()
