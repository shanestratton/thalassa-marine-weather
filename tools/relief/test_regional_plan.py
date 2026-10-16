import unittest
from regional_plan import PROFILES, plan_region, review_plan, tile_range


class RegionalBudgetPlan(unittest.TestCase):
    def test_missing_US_and_NZ_footprints_remain_unknown_not_zero_coverage(self):
        plan = review_plan(['au250', 'eu', 'pr', 'us', 'nz'])
        self.assertEqual(plan['unresolvedFootprints'], ['us', 'nz'])
        self.assertFalse(plan['allInputsKnown'])
        self.assertFalse(plan['fullGenerationBuilt'])
        self.assertFalse(plan['regions']['nz']['eligibleForNextBuildReview'])
        self.assertIsNone(plan['regions']['us']['objectsUpperBound'])

    def test_actual_AU_source_budget_is_separate_from_unbuilt_continental_output(self):
        plan = review_plan(['au250'])
        self.assertEqual(plan['knownInputBytes'], 2_380_292_468)
        self.assertEqual(plan['knownObjectsUpperBound'], 116388)
        self.assertTrue(plan['dryRunOnly'])
        self.assertEqual(plan['caps']['outputBytes'], 30_000_000_000)
        self.assertTrue(plan['regions']['au250']['eligibleForNextBuildReview'])

    def test_PR_uses_one_real_footprint_and_keeps_its_native_vertical_datum(self):
        plan = plan_region(PROFILES['pr'])
        self.assertEqual(plan['verticalDatum'], 'PRVD02')
        self.assertLess(plan['bounds'][2] - plan['bounds'][0], 0.3)
        self.assertIn('one raster footprint', plan['hold'])
        self.assertFalse(plan['eligibleForNextBuildReview'])

    def test_coarse_grid_cannot_gain_fine_zoom_and_giant_plans_fail_before_allocating(self):
        with self.assertRaisesRegex(ValueError, 'Fine zoom'):
            plan_region({**PROFILES['eu'], 'maxzoom': 15})
        original = PROFILES['au250']
        try:
            PROFILES['au250'] = {**original, 'maxzoom': 14}
            with self.assertRaisesRegex(ValueError, 'budget'):
                review_plan(['au250'])
        finally:
            PROFILES['au250'] = original

    def test_invalid_windows_regions_and_duplicates_are_refused(self):
        for ids in ([], ['au250', 'au250'], ['unknown']):
            with self.assertRaises(ValueError):
                review_plan(ids)
        for bounds in ([0, 0, 0, 1], [180, 0, -180, 1], [0, 0, 1, 90], [0, float('nan'), 1, 1]):
            with self.assertRaises(ValueError):
                tile_range(bounds, 10)


if __name__ == '__main__':
    unittest.main()
