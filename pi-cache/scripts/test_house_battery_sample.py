import unittest
from unittest.mock import patch
from house_battery_sample import HouseBatterySample


class HouseBatteryTests(unittest.TestCase):
    def test_only_real_percent_with_original_receipt_time(self):
        source = HouseBatterySample()
        with patch('time.time', return_value=1000), patch('time.monotonic', return_value=100):
            source.record(94.6)
        with patch('time.time', return_value=1040), patch('time.monotonic', return_value=140):
            self.assertEqual(source.snapshot()['soc_pct'], 94.6)
            self.assertEqual(source.snapshot()['at'], 1000000)
        with patch('time.monotonic', return_value=191):
            self.assertIsNone(source.snapshot()['soc_pct'])

    def test_invalid_retained_or_disconnected_are_not_measurements(self):
        source = HouseBatterySample()
        for value in [None, '94.6', True, -1, 101, float('nan'), float('inf')]:
            source.record(value)
            self.assertIsNone(source.snapshot()['soc_pct'])
        source.record(94.6, retained=True)
        self.assertIsNone(source.snapshot()['soc_pct'])
        source.record(0)
        self.assertEqual(source.snapshot()['soc_pct'], 0)
        source.clear()
        self.assertIsNone(source.snapshot()['at'])


if __name__ == '__main__':
    unittest.main()
