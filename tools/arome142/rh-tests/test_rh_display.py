"""Pure availability/QA boundary tests; no native/provider acceptance claim."""
import json
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalogue import AdmissionError
from native import RH_DISPLAY_POLICY, RANGES, rh_display_qa


class RhDisplayTests(unittest.TestCase):
    def test_zero_and_exact100_remain_available(self):
        qa = rh_display_qa(2, 0, 0, 0., 100.)
        self.assertEqual(qa['displayAvailableCells'], 2)
        self.assertEqual(qa['displayAvailability'], 'complete')
        self.assertIsNone(qa['reason'])
        self.assertEqual(RANGES['rh2m'], (0, 100))

    def test_every_finite_upper_value_is_unavailable_not_accepted_or_clamped(self):
        for value in (math.nextafter(100., math.inf), 100.00163650512695,
                      100.0125732421875, 125., 1000000., sys.float_info.max):
            with self.subTest(value=value):
                qa = rh_display_qa(3, 0, 1, 25., value, value, value)
                self.assertEqual(qa['upperDisplayUnavailableCells'], 1)
                self.assertEqual(qa['upperSourceMinimum'], value)
                self.assertEqual(qa['upperSourceMaximum'], value)
                self.assertEqual(qa['displayAvailableCells'], 2)
                self.assertEqual(qa['displayAvailability'], 'partial')
                self.assertEqual(qa['reason'], 'upper-rh-outside-display-domain')
                self.assertEqual(qa['upperRhCause'], 'unproven')
                self.assertFalse(qa['upperValuesClamped'])
                self.assertFalse(qa['roundingNormalizationApplied'])

    def test_negative_and_infinite_present_extrema_still_refuse(self):
        for low, high in ((-.01, 75.), (0., math.inf), (-math.inf, 75.),
                          (math.nan, 75.), (0., math.nan)):
            with self.subTest(low=low, high=high), self.assertRaisesRegex(AdmissionError, 'physical range'):
                rh_display_qa(3, 0, 0, low, high)

    def test_original_missing_and_upper_quarantine_have_separate_counts(self):
        qa = rh_display_qa(10, 2, 3, 0., 101., 100.5, 101., bitmap_missing=1)
        self.assertEqual((qa['sourceMissingCells'], qa['sourceFiniteCells']), (2, 8))
        self.assertEqual((qa['displayMissingCells'], qa['displayAvailableCells']), (5, 5))
        self.assertEqual(qa['upperDisplayUnavailableCells'], 3)
        self.assertEqual((qa['sourceBitmapMissingCells'], qa['sourceUnmarkedMissingCells']), (1, 1))

    def test_all_upper_rh_is_unavailable_without_a_numeric_extreme_threshold(self):
        qa = rh_display_qa(5, 1, 4, 150., sys.float_info.max, 150., sys.float_info.max)
        self.assertEqual(qa['displayAvailability'], 'unavailable')
        self.assertEqual(qa['displayAvailableCells'], 0)
        self.assertEqual(qa['displayMissingCells'], 5)
        self.assertEqual(qa['sourceMissingCells'], 1)
        self.assertEqual(qa['upperDisplayUnavailableCells'], 4)

    def test_original_entirely_missing_is_not_called_upper_quarantine(self):
        qa = rh_display_qa(4, 4, 0, None, None)
        self.assertEqual(qa['displayAvailability'], 'unavailable')
        self.assertEqual(qa['upperDisplayUnavailableCells'], 0)
        self.assertIsNone(qa['reason'])
        self.assertIsNone(qa['sourceFiniteMaximum'])

    def test_false_counts_or_extrema_cannot_make_a_complete_availability_claim(self):
        for args in ((0, 0, 0, None, None), (500000, 0, 0, 0, 100), (2, -1, 0, 0, 100),
                     (2, 1, 2, 0, 101, 101, 101), (True, 0, 0, 0, 100),
                     (2, 0, 0, 0, 101), (2, 0, 1, 0, 100, 100, 100),
                     (2, 0, 1, 101, 102, 102, 102), (2, 0, 2, 0, 102, 102, 102),
                     (2, 2, 0, 0, 100), (2, 0, 0, 0, 100, 101, 101),
                     (2, 0, 1, 0, 101, 102, 102), (2, 0, 1, 0, 101, math.inf, 101),
                     (2, 0, 0, 0, 100, None, None, 1)):
            with self.subTest(args=args), self.assertRaises(AdmissionError): rh_display_qa(*args)

    def test_qa_is_compact_finite_json_with_no_samples_or_native_import(self):
        qa = rh_display_qa(255811, 0, 8, 42.00163650512695, 100.00163650512695,
                           100.00163650512695, 100.00163650512695)
        raw = json.dumps(qa, allow_nan=False, separators=(',', ':'))
        self.assertLess(len(raw.encode()), 2048)
        self.assertEqual(qa['policy'], RH_DISPLAY_POLICY)
        self.assertNotIn('samples', qa)
        self.assertNotIn('numpy', sys.modules)
        self.assertNotIn('eccodes', sys.modules)


if __name__ == '__main__': unittest.main()
