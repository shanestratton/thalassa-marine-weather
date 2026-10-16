import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

b, p = module("build"), module("publication")

def geoline(ident="1", name="Fictional Coral Bay", code="BAY", lat="-17", lon="179.9"):
    c = [ident, name, name, "Fictional Alias", lat, lon, "H", code, "FJ", "", "", "", "", "", "0", "", "", "Pacific/Fiji", "2026-10-01"]
    return "\t".join(c) + "\n"

class BuildTests(unittest.TestCase):
    def test_geonames_stable_alias_id_and_missing(self):
        row = b.geonames(geoline())
        self.assertEqual(row["id"], "geonames:1")
        self.assertEqual(row["aliases"], ["Fictional Alias"])
        self.assertIsNone(b.geonames(geoline(code="LK")))
        with self.assertRaises(ValueError): b.geonames(geoline(lat="nan"))
    def test_unicode_prefix_and_dateline(self):
        self.assertEqual(b.prefix("Île du thé"), "69-6c-65")
        self.assertEqual(b.area(0, 180), b.area(0, -180))
        self.assertEqual(b.center({"type": "Polygon", "coordinates": [[[179, 0], [-179, 1], [179, 0]]]}), (0.5, -180.0, True))
    def test_osm_pickup_not_protection_and_restrictions(self):
        feature = {"properties": {"@id": "n42", "seamark:type": "mooring", "access": "private", "phone": "must-not-publish"}, "geometry": {"type": "Point", "coordinates": [3, 45]}}
        row = b.osm(feature)
        self.assertEqual(row["id"], "osm-node42")
        self.assertIn("private", row["restrictions"][0])
        self.assertNotIn("phone", json.dumps(row))
        feature["properties"]["seamark:mooring:category"] = "pile"
        self.assertIsNone(b.osm(feature))
    def test_noaa_refuses_rcid_only_and_uses_lnam(self):
        feature = {"properties": {"OBJL": "ACHARE", "RCID": 123}, "geometry": {"type": "Point", "coordinates": [-70, 40]}}
        with self.assertRaises(ValueError): b.noaa(feature)
        feature["properties"]["LNAM"] = "0226000000001234"
        self.assertEqual(b.noaa(feature)["id"], "noaa:0226000000001234")
    def fixture(self, root, content):
        source = root / "source.txt"
        source.write_text(content, encoding="utf-8")
        manifest = {"schema": 1, "dataset": "places", "licence": b.LICENCES["places"], "coverage": "Generated fixture only", "sourceAt": dt.datetime.now(dt.timezone.utc).isoformat(), "inputs": [{"path": "source.txt", "sourceUrl": "https://download.geonames.org/export/dump/allCountries.zip", "bytes": source.stat().st_size, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}]}
        path = root / "input.json"
        path.write_text(json.dumps(manifest))
        return path
    def test_generation_reuse_shards_and_atomic_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.fixture(root, geoline())
            gen = b.build(path, root / "output")
            self.assertEqual(b.build(path, root / "output"), gen)
            self.assertEqual(len(list((gen / "areas").glob("*.json"))), 1)
            self.assertEqual(len(list((gen / "names").glob("*.json"))), 1)
            body = json.loads(path.read_text()); body["inputs"][0]["sha256"] = "0" * 64; path.write_text(json.dumps(body))
            with self.assertRaises(ValueError): b.build(path, root / "output")
            self.assertTrue((gen / "manifest.json").exists())
            self.assertFalse((root / "output" / "places" / "manifest.json").exists())
    def test_empty_build_does_not_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = self.fixture(root, geoline(code="LK"))
            with self.assertRaises(ValueError): b.build(path, root / "output")
            self.assertEqual(list((root / "output" / "places").iterdir()), [])
    def test_source_path_and_host_refusal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = self.fixture(root, geoline())
            body = json.loads(path.read_text()); body["inputs"][0]["sourceUrl"] = "https://download.geonames.org.evil.test/allCountries.zip"; path.write_text(json.dumps(body))
            with self.assertRaises(ValueError): b.build(path, root / "output")
            body["inputs"][0]["sourceUrl"] = "https://download.geonames.org/export/dump/allCountries.zip"; body["inputs"][0]["path"] = "../outside.txt"; path.write_text(json.dumps(body))
            with self.assertRaises(ValueError): b.build(path, root / "output")
    def test_retention_protects_actual_current_and_refuses_other_prefixes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); gen = b.build(self.fixture(root, geoline()), root / "output")
            inventory = [{"key": "marine-catalogue/v1/places/20240101-old/areas/1_1.json", "bytes": 10}, {"key": "marine-catalogue/v1/places/20250101-active/areas/1_1.json", "bytes": 10}, {"key": "marine-catalogue/v1/places/20260101-last/areas/1_1.json", "bytes": 10}]
            result = p.plan(gen, inventory, {"dataset": "places", "generation": "20250101-active"})
            self.assertEqual([r["key"] for r in result["deleteCandidatesAfterSuccessfulManifestSwap"]], [inventory[0]["key"]])
            self.assertFalse(result["apply"])
            self.assertIn("20250101-active", result["protectedGenerations"])
            with self.assertRaises(ValueError): p.plan(gen, inventory, None)
            with self.assertRaises(ValueError): p.plan(gen, [{"key": "licensed-charts/private", "bytes": 1}], None)

    def test_dense_global_names_split_without_dropping_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); lines = []
            for index in range(100):
                c = geoline(str(index + 1), f"CoralIsland{index:03}", lat=str(-80 + index * 1.6)).strip().split("\t")
                c[2] = c[1]; c[3] = ""; lines.append("\t".join(c) + "\n")
            path = self.fixture(root, "".join(lines))
            with patch.object(b, "MAX_SHARD_BYTES", 4096): gen = b.build(path, root / "output")
            shards = list((gen / "names").glob("*.json"))
            self.assertGreater(len(shards), 1)
            records = {p["id"] for f in shards for p in json.loads(f.read_text(encoding="utf-8"))["records"]}
            self.assertEqual(len(records), 100)
            self.assertTrue(all(f.stat().st_size <= 4096 for f in shards))

if __name__ == "__main__": unittest.main()
