import json
import tempfile
import unittest
from pathlib import Path

from generate import classify, collect, select_local_ids


class GeneratorTests(unittest.TestCase):
    def select(self, body):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.osm'
            path.write_text('<osm version="0.6">' + body + '</osm>')
            return select_local_ids(path)

    def test_wall_crossing_region_with_vertices_outside_is_selected(self):
        self.assertEqual(self.select('''
          <node id="1" lat="-27.20" lon="153.0"/>
          <node id="2" lat="-27.20" lon="153.2"/>
          <way id="10"><nd ref="1"/><nd ref="2"/><tag k="barrier" v="wall"/></way>
        '''), ['w10'])

    def test_missing_way_node_is_not_silently_skipped(self):
        with self.assertRaises(Exception):
            self.select('''<node id="1" lat="-27.20" lon="153.09"/>
              <way id="10"><nd ref="1"/><nd ref="999"/><tag k="man_made" v="pier"/></way>''')

    def test_incomplete_local_relation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            self.select('''<node id="1" lat="-27.20" lon="153.09"/>
              <node id="2" lat="-27.21" lon="153.09"/>
              <way id="10"><nd ref="1"/><nd ref="2"/></way>
              <relation id="20"><member type="way" ref="10" role="outer"/>
                <member type="way" ref="999" role="outer"/>
                <tag k="type" v="multipolygon"/><tag k="natural" v="water"/></relation>''')

    def test_wall_quay_and_bridge_are_hard_obstacles(self):
        for tags in ({'barrier': 'wall'}, {'barrier': 'retaining_wall'}, {'man_made': 'quay'}, {'bridge': 'yes'}):
            self.assertEqual(classify(tags, 'LineString'), 'breakwater')
        self.assertIsNone(classify({'bridge': 'no'}, 'LineString'))
        self.assertIsNone(classify({'seamark:type': 'navigation_line', 'seamark:navigation_line:category': 'clearing'}, 'LineString'))

    def test_holes_survive_and_invalid_local_polygon_fails(self):
        outer = [[153.08, -27.22], [153.10, -27.22], [153.10, -27.20], [153.08, -27.20], [153.08, -27.22]]
        inner = [[153.085, -27.215], [153.09, -27.215], [153.09, -27.21], [153.085, -27.21], [153.085, -27.215]]
        def feature(tags, geometry):
            return {'type': 'Feature', 'properties': tags, 'geometry': geometry}
        water = feature({'natural': 'water'}, {'type': 'Polygon', 'coordinates': [outer, inner]})
        pier = feature({'man_made': 'pier'}, {'type': 'LineString', 'coordinates': outer[:2]})
        canal = feature({'waterway': 'canal'}, {'type': 'LineString', 'coordinates': outer[:2]})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'features.geojsonseq'
            path.write_text('\n'.join(json.dumps(f) for f in [water] * 5 + [pier] * 100 + [canal] * 5))
            overlay, _ = collect(path)
            self.assertEqual(len(overlay['water']['features'][0]['geometry']['coordinates']), 2)
            broken = feature({'natural': 'water'}, {'type': 'Polygon', 'coordinates': [[outer[0], outer[2], outer[1], outer[3], outer[0]]]})
            path.write_text(json.dumps(broken))
            with self.assertRaisesRegex(ValueError, 'Invalid local'):
                collect(path)


if __name__ == '__main__':
    unittest.main()
