"""140-01 synthetic offline build/publication contracts. No source downloads/R2."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import acquire
import build
import publication
import world_policy
import world_monthly_review

def feature(ident, **tags):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [179.9, -17]}, "properties": {"@id": f"n{ident}", "name": "Fictional mapped facility", **tags}}

def fixture(root):
    stamp = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    inputs = []
    for index, region in enumerate(sorted(world_policy.REGIONS)):
        file = root / f"source-{index}.jsonl"
        raw = (json.dumps(feature(index + 1, leisure="slipway", **{"seamark:type": "small_craft_facility", "seamark:small_craft_facility:category": "pump-out;fuel_station", "operator": "must-not-copy", "phone": "must-not-copy"})) + "\n").encode()
        file.write_bytes(raw)
        inputs.append({"path": file.name, "sourceUrl": f"https://download.geofabrik.de/{region}-latest.osm.pbf", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "sourceAt": stamp})
    source = root / "input.json"
    source.write_text(json.dumps({"schema": 1, "dataset": "facilities-world", "licence": build.LICENCES["facilities-world"], "coverage": "Eight synthetic continental fixtures only; not live coverage", "sourceAt": stamp, "inputs": inputs}), encoding="utf-8")
    generation = build.build(source, root / "output")
    manifest = json.loads((generation / "manifest.json").read_text(encoding="utf-8"))
    shards = [json.loads((generation / (key + ".json")).read_text(encoding="utf-8")) for key in manifest["shards"]]
    return source, generation, manifest, shards

class WorldFacilitiesTests(unittest.TestCase):
    def test_all_four_explicit_kinds_and_legacy_reader_unchanged(self):
        value = feature(1, leisure="marina", waterway="fuel", highway="service", service="slipway", **{"seamark:type": "small_craft_facility", "seamark:small_craft_facility:category": "pump-out"})
        self.assertEqual(build.facilities(value, world=True)["facilityKinds"], list(world_policy.KINDS))
        self.assertEqual(build.facilities(value)["facilityKinds"], ["marina", "fuel"])
        self.assertIsNone(build.osm(value))
        self.assertIsNone(build.facilities(feature(2, leisure="slipway")))

    def test_marine_pump_out_does_not_invent_boat_service_or_suction(self):
        for tags in [{"amenity": "fuel"}, {"amenity": "sanitary_dump_station"}, {"waterway": "sanitary_dump_station", "sanitary_dump_station:basin": "yes"}, {"amenity": "sanitary_dump_station", "sanitary_dump_station:pump-out": "yes"}, {"service": "slipway"}, {"seamark:type": "small_craft_facility", "seamark:small_craft_facility:category": "pump-outside"}]:
            self.assertIsNone(build.facilities(feature(1, **tags), world=True))
        for tags in [{"waterway": "sanitary_dump_station", "sanitary_dump_station:pump-out": "yes"}, {"amenity": "sanitary_dump_station", "boat": "yes", "sanitary_dump_station:pump-out": "yes"}]:
            self.assertEqual(build.facilities(feature(1, **tags), world=True)["kind"], "pump_out")

    def test_global_plan_is_eight_original_scopes_with_unchanged_existing_caps(self):
        plan = json.loads(Path(__file__).with_name("facilities-world.plan.json").read_text())
        self.assertEqual(acquire.validate(plan), plan)
        old = json.loads(Path(__file__).with_name("osm-world.plan.json").read_text())
        self.assertEqual(plan["sources"], old["sources"])
        for sources in [plan["sources"][:-1], [*plan["sources"][:-1], plan["sources"][0]]]:
            with self.assertRaises(ValueError): acquire.validate({**plan, "sources": sources})
        with self.assertRaisesRegex(ValueError, "512MiB"):
            acquire.validate({**plan, "dataset": "facilities"})

    def test_offline_public_index_and_manifest_last_plan_preserve_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, generation, manifest, shards = fixture(Path(temporary))
            self.assertEqual(manifest["dataset"], "facilities-world")
            self.assertEqual(manifest["count"], 8)
            self.assertEqual(len(manifest["cohorts"]), 8)
            self.assertEqual(manifest["sourceAt"], min(row["sourceAt"] for row in manifest["cohorts"]))
            self.assertEqual({row["id"] for row in manifest["cohorts"]}, world_policy.COHORTS)
            self.assertNotIn("must-not-copy", json.dumps(shards))
            self.assertTrue(all(row["id"].startswith("osm-node") for shard in shards for row in shard["records"]))
            self.assertIn("ODbL", (generation / "LICENCE.txt").read_text(encoding="utf-8"))
            plan = publication.plan(generation, [], None)
            self.assertFalse(plan["apply"])
            self.assertEqual(plan["manifestLast"]["key"], "marine-catalogue/v1/facilities-world/manifest.json")
            self.assertTrue(all("/facilities-world/" in row["key"] for row in plan["uploads"]))
            bad = {**manifest, "generation": "202610-previous", "cohorts": manifest["cohorts"][:-1]}
            with self.assertRaisesRegex(ValueError, "omit"): publication.plan(generation, [], bad)
            spec = json.loads(source.read_text()); spec["inputs"] = spec["inputs"][:-1]; source.write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, "eight"): build.build(source, Path(temporary) / "missing")

    def test_resource_review_is_honest_and_not_an_execution(self):
        result = world_monthly_review.review(Path(__file__).with_name("facilities-world.plan.json"))
        self.assertFalse(result["execute"]); self.assertFalse(result["published"]); self.assertFalse(result["installed"])
        envelope = result["resourceEnvelope"]
        self.assertEqual(envelope["transportByteCap"], 114.25 * 1024**3)
        self.assertEqual(envelope["extractedByteCap"], 14.125 * 1024**3)
        self.assertEqual(envelope["admissionFreeDiskBytes"], 160.625 * 1024**3)
        self.assertEqual(envelope["serviceFileByteCap"], envelope["largestSourceByteCap"])
        self.assertEqual(envelope["downloadDeadlineSecondsPerSource"], 3600)
        self.assertEqual(envelope["osmiumDeadlineSecondsPerChild"], 7200)

if __name__ == "__main__": unittest.main()
