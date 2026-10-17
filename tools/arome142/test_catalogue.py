"""Fictional catalogue fixtures on the documented original grid; no downloads."""
import copy
import json
import unittest
from datetime import datetime, timezone, timedelta

from catalogue import AdmissionError, DOMAINS, HOURS, MAX_PACKET_BYTES, build_plan, packet_url

NOW = datetime(2026, 10, 17, 9, tzinfo=timezone.utc)
RUN = '2026-10-17T00:00:00Z'


def fixture(domain='NCALED'):
    spec = DOMAINS[domain]
    resources = [
        {'url': packet_url(domain, RUN, offset),
         'title': packet_url(domain, RUN, offset).rsplit('/', 1)[1],
         'filesize': 3_000_000, 'format': 'grib2'} for offset in range(HOURS)
    ]
    resources.append({'url': 'https://www.data.gouv.fr/fr/datasets/r/8339b164-c9ef-411a-8109-82e2cd4be437',
                      'title': f"Champs CONSTANT {spec['grid']}0025", 'format': 'grib2'})
    return {'id': spec['catalogue'], 'license': 'lov2', 'resources': resources}


def raw(data):
    return json.dumps(data).encode()


class AromeOriginalCatalogueTests(unittest.TestCase):
    def test_three_actual_domains_plan_only_their_full49_hour_original_sp1_cohort(self):
        for domain in DOMAINS:
            with self.subTest(domain=domain):
                source = raw(fixture(domain))
                plan = build_plan(source, domain, RUN, NOW)
                self.assertEqual([row['offsetHours'] for row in plan['packets']], list(range(49)))
                self.assertEqual(plan['runUtc'], RUN)
                self.assertEqual(plan['declaredForecastBytes'], 147_000_000)
                self.assertEqual(plan['limits']['dayBytes'], 2_500_000_000)
                self.assertTrue(plan['nativeMaskAndOriginalGridAdmissionRequired'])
                self.assertFalse(plan['installed']); self.assertFalse(plan['published'])
                self.assertFalse(plan['liveCoverageClaim'])
                self.assertEqual(source, raw(fixture(domain)))

    def test_antilles_documented_caraib_grid_uses_actual_official_antil_object_key(self):
        plan = build_plan(raw(fixture('ANTIL')), 'ANTIL', RUN, NOW)
        self.assertEqual(plan['grid'], 'CARAIB')
        self.assertIn('/arome-om/ANTIL/0025/SP1/', plan['packets'][0]['url'])
        self.assertEqual(plan['bounds'], [9.7, 22.9, -75.3, -51.7])

    def test_foreign_catalogue_and_unknown_source_rights_refuse(self):
        for field, value in [('id', DOMAINS['POLYN']['catalogue']), ('license', 'unknown')]:
            data = fixture(); data[field] = value
            with self.subTest(field=field), self.assertRaises(AdmissionError):
                build_plan(raw(data), 'NCALED', RUN, NOW)

    def test_wrong_origin_or_wrong_model_is_not_a_fallback(self):
        for replacement in ['https://attacker.example/data', 'http://'+packet_url('NCALED', RUN, 0)[8:],
                            packet_url('POLYN', RUN, 0)]:
            data = fixture(); data['resources'][0]['url'] = replacement
            with self.subTest(url=replacement), self.assertRaises(AdmissionError):
                build_plan(raw(data), 'NCALED', RUN, NOW)

    def test_missing_lead_and_duplicate_lead_refuse_instead_of_partial_success(self):
        data = fixture(); data['resources'].pop(2)
        with self.assertRaises(AdmissionError): build_plan(raw(data), 'NCALED', RUN, NOW)
        data = fixture(); data['resources'].append(copy.deepcopy(data['resources'][0]))
        with self.assertRaises(AdmissionError): build_plan(raw(data), 'NCALED', RUN, NOW)

    def test_mixed_source_clocks_never_form_a_complete_cohort(self):
        data = fixture()
        for field in ('url', 'title'):
            data['resources'][5][field] = data['resources'][5][field].replace(RUN, '2026-10-16T18:00:00Z')
        with self.assertRaises(AdmissionError): build_plan(raw(data), 'NCALED', RUN, NOW)

    def test_declared_object_and_total_byte_caps_refuse_before_any_acquisition(self):
        for bad in [None, True, '3000000', -1, 15, MAX_PACKET_BYTES+1]:
            data=fixture(); data['resources'][0]['filesize']=bad
            with self.subTest(size=bad), self.assertRaises(AdmissionError):
                build_plan(raw(data), 'NCALED', RUN, NOW)
        data=fixture()
        for resource in data['resources'][:-1]: resource['filesize']=MAX_PACKET_BYTES
        with self.assertRaises(AdmissionError): build_plan(raw(data), 'NCALED', RUN, NOW)

    def test_missing_or_ambiguous_constant_mask_cannot_be_invented(self):
        data=fixture(); data['resources'].pop()
        with self.assertRaises(AdmissionError): build_plan(raw(data), 'NCALED', RUN, NOW)
        data=fixture(); data['resources'].append(copy.deepcopy(data['resources'][-1]))
        with self.assertRaises(AdmissionError): build_plan(raw(data), 'NCALED', RUN, NOW)
        data=fixture(); data['resources'][-1]['url']='https://attacker.example/mask.grib2'
        with self.assertRaises(AdmissionError): build_plan(raw(data), 'NCALED', RUN, NOW)

    def test_cycle_timezone_calendar_future_and_original_age_are_strict(self):
        for cycle in ['2026-10-17T00:00:00', '2026-10-17T03:00:00Z', '2026-02-30T00:00:00Z', RUN+'?x']:
            with self.subTest(cycle=cycle), self.assertRaises(AdmissionError):
                build_plan(raw(fixture()), 'NCALED', cycle, NOW)
        for now in [NOW-timedelta(hours=10), NOW+timedelta(hours=10), NOW.replace(tzinfo=None)]:
            with self.subTest(now=now), self.assertRaises(AdmissionError):
                build_plan(raw(fixture()), 'NCALED', RUN, now)
        with self.assertRaises(AdmissionError): build_plan(raw(fixture()), 'ACCESS-C', RUN, NOW)

    def test_resource_inventory_and_json_are_bounded(self):
        for value in [b'{', b'null', b'{}', b'x'*(4*1024*1024+1)]:
            with self.subTest(bytes=len(value)), self.assertRaises(AdmissionError):
                build_plan(value, 'NCALED', RUN, NOW)
        data=fixture(); data['resources']*=200
        with self.assertRaises(AdmissionError): build_plan(raw(data), 'NCALED', RUN, NOW)


if __name__=='__main__': unittest.main()
