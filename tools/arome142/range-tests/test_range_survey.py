"""Fictional precision intervals. No native or provider calls."""
import math
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from retained_range_survey import compact_evidence, uncertainty_summary


class RangeSurveyTests(unittest.TestCase):
    def test_boundary_compatible_is_not_normalized_or_accepted(self):
        result = uncertainty_summary([100.00163650512695], 0, 100, .007814407348632812)
        self.assertEqual(result['outOfRangeCompatibleWithPhysicalBoundary'], 1)
        self.assertEqual(result['outOfRangeBeyondPackingInterval'], 0)
        self.assertTrue(result['originalPrePackingValueNotKnown'])
        self.assertFalse(result['normalizationOrAcceptancePerformed'])

    def test_open_lower_closed_upper_precision_interval(self):
        result = uncertainty_summary([100.5, -.5], 0, 100, .5)
        self.assertEqual(result['outOfRangeCompatibleWithPhysicalBoundary'], 1)
        self.assertEqual(result['outOfRangeBeyondPackingInterval'], 1)

    def test_far_values_nonfinite_and_missing_stay_distinct(self):
        result = uncertainty_summary([math.nan, math.inf, -math.inf, -.1, 100.1, 0, 100], 0, 100, .01)
        self.assertEqual(result['outOfRangeCompatibleWithPhysicalBoundary'], 0)
        self.assertEqual(result['outOfRangeBeyondPackingInterval'], 4)

    def test_invalid_precision_is_refused(self):
        for value in (-.1, math.nan, math.inf, True):
            with self.assertRaises(ValueError): uncertainty_summary([100.1], 0, 100, value)

    def test_compact_representation_preserves_data_and_the_text_ceiling(self):
        value = {'original': [100.00163650512695], 'accepted': False, 'missing': None}
        self.assertEqual(json.loads(compact_evidence(value)), value)
        with self.assertRaises(ValueError): compact_evidence({'unknown': math.nan})
        with self.assertRaises(ValueError): compact_evidence({'tooLarge': 'x' * 262144})


if __name__ == '__main__': unittest.main()
