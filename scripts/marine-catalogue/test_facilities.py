"""Synthetic source-only fixtures; no provider, publication or product calls."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import acquire
import build
import publication

def feature(ident, **tags):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [179.9, -17]}, "properties": {"@id": f"n{ident}", "name": "Fictional public facility", **tags}}

def fixture(root):
    stamp = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    inputs = []
    for index, (region, record) in enumerate([
        ("australia-oceania/fiji", feature(1, leisure="marina", waterway="fuel", phone="must-not-copy")),
        ("central-america/belize", feature(2, **{"seamark:type": "small_craft_facility", "seamark:small_craft_facility:category": "water_tap;fuel_station"})),
    ]):
        file = root / f"source-{index}.jsonl"
        raw = (json.dumps(record) + "\n").encode()
        file.write_bytes(raw)
        inputs.append({"path": file.name, "sourceUrl": f"https://download.geofabrik.de/{region}-latest.osm.pbf", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "sourceAt": stamp})
    source = root / "input.json"
    source.write_text(json.dumps({"schema": 1, "dataset": "facilities", "licence": build.LICENCES["facilities"], "coverage": "Synthetic two-region fixtures only", "sourceAt": stamp, "inputs": inputs}), encoding="utf-8")
    generation = build.build(source, root / "output")
    manifest = json.loads((generation / "manifest.json").read_text(encoding="utf-8"))
    shards = [json.loads((generation / (key + ".json")).read_text(encoding="utf-8")) for key in manifest["shards"]]
    return source, generation, manifest, shards

class FacilitiesTests(unittest.TestCase):
    def test_explicit_boat_fuel_and_dual_marina_role(self):
        self.assertIsNone(build.facilities(feature(1, amenity="fuel")))
        self.assertIsNone(build.facilities(feature(1, **{"seamark:type": "small_craft_facility", "seamark:small_craft_facility:category": "fuel_stationary"})))
        row = build.facilities(feature(1, leisure="marina", waterway="fuel", access="private", phone="must-not-copy"))
        self.assertEqual(row["facilityKinds"], ["marina", "fuel"])
        self.assertEqual(row["id"], "osm-node1")
        self.assertIn("private", row["restrictions"][0])
        self.assertNotIn("must-not-copy", json.dumps(row))
        self.assertIsNone(build.osm(feature(1, leisure="marina", waterway="fuel")))
        self.assertIsNone(build.facilities(feature(1, **{"seamark:type": "anchorage"})))

    def test_cumulative_local_build_and_manifest_last_owned_plan(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, generation, manifest, shards = fixture(Path(temporary))
            self.assertEqual(manifest["count"], 2)
            self.assertEqual(len(manifest["cohorts"]), 2)
            self.assertEqual(manifest["sourceAt"], min(row["sourceAt"] for row in manifest["cohorts"]))
            self.assertEqual(sum(len(shard["records"]) for shard in shards), 2)
            plan = publication.plan(generation, [], None)
            self.assertFalse(plan["apply"])
            self.assertEqual(plan["manifestLast"]["key"], "marine-catalogue/v1/facilities/manifest.json")
            self.assertTrue(all("/facilities/" in row["key"] for row in plan["uploads"]))
            previous = {**manifest, "generation": "202610-previous", "cohorts": [*manifest["cohorts"], {**manifest["cohorts"][0], "id": "https://download.geofabrik.de/europe/iceland"}]}
            with self.assertRaisesRegex(ValueError, "cannot withdraw"):
                publication.plan(generation, [], previous)
            changed_source = {**manifest, "generation": "202610-previous", "cohorts": [{**row, "sha256": "0" * 64} for row in manifest["cohorts"]]}
            with self.assertRaisesRegex(ValueError, "unchanged clock"):
                publication.plan(generation, [], changed_source)
            spec = json.loads(source.read_text())
            spec["inputs"][0]["sourceAt"] = "2026-02-31T00:00:00Z"
            source.write_text(json.dumps(spec))
            with self.assertRaises(ValueError): build.build(source, Path(temporary) / "another")

    def test_source_age_is_not_renewed_to_receipt_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, _, manifest, _ = fixture(Path(temporary))
            spec = json.loads(source.read_text())
            spec["sourceAt"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            source.write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, "oldest regional"):
                build.build(source, Path(temporary) / "another")
            self.assertNotEqual(manifest["sourceAt"], spec["sourceAt"])
            del spec["inputs"][0]["sourceAt"]
            source.write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, "source descriptor"):
                build.build(source, Path(temporary) / "missing")

    def test_header_clock_is_required_and_has_a_deadline(self):
        with tempfile.TemporaryDirectory() as temporary:
            stamp = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
            def run(args, **options):
                self.assertIn("header.option.osmosis_replication_timestamp", args)
                self.assertEqual(options["timeout"], 30)
                options["stdout"].write((stamp + "\n").encode())
            with patch.object(acquire.subprocess, "run", run):
                self.assertEqual(acquire.osm_source_clock(Path(temporary) / "synthetic.osm.pbf", temporary), stamp)
            def missing(_, **options): options["stdout"].write(b"\n")
            with patch.object(acquire.subprocess, "run", missing):
                with self.assertRaisesRegex(ValueError, "actual UTC"):
                    acquire.osm_source_clock(Path(temporary) / "synthetic.osm.pbf", temporary)

    def test_future_source_clock_cannot_produce_an_app_invalid_generation(self):
        # The app rejects cohorts newer than builtAt. Do not admit a five-minute
        # transport grace here and then create a generation it cannot consume.
        future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        with self.assertRaisesRegex(ValueError, "Future facilities"):
            build.source_time(future)

    def test_facilities_source_caps_do_not_increase_existing_caps(self):
        plan = {"schema": 1, "dataset": "facilities", "coverage": "Synthetic regional plan only", "sources": [{"url": "https://download.geofabrik.de/europe/iceland-latest.osm.pbf", "format": "osm-pbf", "maxBytes": 512 * 1024**2, "maxExpandedBytes": 2 * 1024**3}]}
        self.assertEqual(acquire.validate(plan), plan)
        plan["sources"][0]["maxBytes"] += 1
        with self.assertRaisesRegex(ValueError, "Facilities acquisition"):
            acquire.validate(plan)

if __name__ == "__main__":
    if sys.argv[1:] == ["--emit-fixture"]:
        with tempfile.TemporaryDirectory() as temporary:
            _, _, manifest, shards = fixture(Path(temporary))
            print(json.dumps({"manifest": manifest, "shards": shards}))
    else:
        unittest.main()
