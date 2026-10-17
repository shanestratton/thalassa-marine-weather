"""Fictional scalar/traceback fixtures; no NumPy/ecCodes/provider calls."""
import json
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from retained_range_diagnostic import MAX_CELLS, range_summary, refusal_frame


class RetainedRangeTests(unittest.TestCase):
    def test_exact_boundaries_are_not_changed(self):
        values = [50.] * MAX_CELLS
        values[:2] = [0., 100.]
        result = range_summary(values, 0, 100)
        self.assertEqual((result['finiteMinimum'], result['finiteMaximum']), (0, 100))
        self.assertEqual(result['belowMinimumCells'] + result['aboveMaximumCells'], 0)
        self.assertEqual(result['samples'], [])
        self.assertFalse(result['valuesClampedOrChanged'])
        self.assertEqual(values[:2], [0, 100])

    def test_small_excess_is_reported_without_clamp(self):
        values = [50.] * MAX_CELLS
        values[27] = 100.00001
        result = range_summary(values, 0, 100)
        self.assertEqual(result['aboveMaximumCells'], 1)
        self.assertEqual(result['samples'], [{'originalScanIndex': 27, 'value': 100.00001, 'kind': 'above'}])
        self.assertEqual(values[27], 100.00001)

    def test_missing_infinite_and_low_counts_are_distinct(self):
        values = [50.] * MAX_CELLS
        values[:5] = [math.nan, math.inf, -math.inf, -.1, 100.1]
        result = range_summary(values, 0, 100)
        self.assertEqual((result['missingNaNCells'], result['nonfinitePresentCells']), (1, 2))
        self.assertEqual((result['belowMinimumCells'], result['aboveMaximumCells']), (1, 1))
        self.assertEqual(len(result['samples']), 4)
        json.dumps(result, allow_nan=False)

    def test_sixteen_is_a_total_sample_ceiling(self):
        result = range_summary([100.1] * MAX_CELLS, 0, 100)
        self.assertEqual(result['aboveMaximumCells'], MAX_CELLS)
        self.assertEqual(len(result['samples']), 16)
        self.assertEqual([row['originalScanIndex'] for row in result['samples']], list(range(16)))

    def test_wrong_cardinality_or_unbounded_range_refused(self):
        for values, low, high in (([0.], 0, 100), ([0.] * MAX_CELLS, math.nan, 100),
                                  ([0.] * MAX_CELLS, 100, 0)):
            with self.assertRaises(ValueError): range_summary(values, low, high)

    def test_exact_original_frame_is_required(self):
        native = Path('/fictional/strict/native.py')
        namespace = {}
        exec(compile('def decode_packet():\n field="rh2m"; domain="NCALED"; offset=1; metadata={}; values=[]; low=0; high=100; reverse_i=False; reverse_j=True\n raise ValueError("original field physical range")\n', str(native), 'exec'), namespace)
        try:
            namespace['decode_packet']()
        except ValueError as error:
            local, line = refusal_frame(error, native)
            self.assertEqual(local['field'], 'rh2m')
            self.assertEqual(local['offset'], 1)
            self.assertEqual(line, 3)
            with self.assertRaises(ValueError): refusal_frame(error, Path('/other/native.py'))

    def test_wrong_guard_and_pre_scalar_frame_refused(self):
        with self.assertRaises(ValueError): refusal_frame(ValueError('original units mismatch'), Path('/native.py'))
        native = Path('/fictional/incomplete/native.py')
        namespace = {}
        exec(compile('def decode_packet():\n raise ValueError("original field physical range")\n', str(native), 'exec'), namespace)
        try: namespace['decode_packet']()
        except ValueError as error:
            with self.assertRaises(ValueError): refusal_frame(error, native)

    def test_import_does_not_load_native_science(self):
        self.assertFalse({'catalogue', 'native', 'static_tiles', 'numpy', 'eccodes'}.intersection(sys.modules))


if __name__ == '__main__': unittest.main()
