import copy
from contextlib import nullcontext
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import acquire
import build
import publication
import publish
import monthly
import test_build as fixtures

class Store:
    def __init__(self): self.objects = {}; self.calls = []; self.fail = None; self.sequence = 0; self.race = False
    def listing(self): return [{"key": k, "bytes": len(v[0])} for k, v in sorted(self.objects.items())]
    def get(self, key, maximum):
        result = self.objects.get(key)
        if result and len(result[0]) > maximum: raise ValueError("Too large")
        return result
    def put(self, key, body, previous=None, immutable=False):
        self.calls.append(("put", key))
        if self.fail and self.fail in key: raise ValueError("Upload failed")
        if self.race and len(key.split("/")) == 4: raise ValueError("CAS412")
        current = self.objects.get(key)
        if (current[1] if current else None) != previous: raise ValueError("CAS412")
        self.sequence += 1; self.objects[key] = (body, f'"etag-{self.sequence}"')
    def delete(self, key): self.calls.append(("delete", key)); del self.objects[key]

class OperationsTests(unittest.TestCase):
    def generation(self, root):
        return build.build(fixtures.BuildTests().fixture(root, fixtures.geoline()), root / "staged")
    def test_failed_upload_keeps_old_manifest_and_never_deletes(self):
        with tempfile.TemporaryDirectory() as tmp:
            gen = self.generation(Path(tmp)); store = Store()
            old = json.loads((gen / "manifest.json").read_text()); old["generation"] = "20250101-active"
            key = "marine-catalogue/v1/places/manifest.json"
            store.objects[key] = (json.dumps(old).encode(), '"old"')
            plan = publish.prepare(store, gen); store.fail = "/areas/"
            with self.assertRaises(ValueError): publish.apply(store, plan, True)
            self.assertEqual(json.loads(store.objects[key][0])["generation"], "20250101-active")
            self.assertFalse(any(action == "delete" for action, _ in store.calls))
    def test_cas_conflict_never_promotes_or_cleans(self):
        with tempfile.TemporaryDirectory() as tmp:
            gen = self.generation(Path(tmp)); store = Store(); plan = publish.prepare(store, gen); store.race = True
            with self.assertRaises(ValueError): publish.apply(store, plan, True)
            self.assertNotIn("marine-catalogue/v1/places/manifest.json", store.objects)
            self.assertFalse(any(action == "delete" for action, _ in store.calls))
    def test_manifest_last_verified_and_cleanup_off_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            gen = self.generation(Path(tmp)); store = Store(); plan = publish.prepare(store, gen)
            publish.apply(store, plan)
            self.assertEqual(store.calls[-1], ("put", "marine-catalogue/v1/places/manifest.json"))
            self.assertFalse(any(action == "delete" for action, _ in store.calls))
            # Whole-generation reuse checks bytes rather than uploading again.
            before = len(store.calls); publish.apply(store, publish.prepare(store, gen)); self.assertEqual(len(store.calls), before + 1)
    def test_review_package_change_refused_before_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            gen = self.generation(Path(tmp)); store = Store(); plan = publish.prepare(store, gen)
            plan["uploads"][0]["key"] = "licensed-charts/private"
            with self.assertRaises(ValueError): publish.apply(store, plan)
            self.assertEqual(store.calls, [])
    def test_actual_osmium_original_attributes_preserve_way_relation_identity(self):
        for typ in ("way", "relation"):
            result = build.osm({"properties": {"@type": typ, "@id": 123, "seamark:type": "anchorage"}, "geometry": {"type": "Polygon", "coordinates": [[[179, 0], [-179, 1], [179, 0]]]}})
            self.assertEqual(result["id"], "osm-" + typ + "123")
            self.assertEqual(result["lon"], -180)
    def test_acquisition_whitelist_and_whole_caps(self):
        source = {"url": "https://download.geonames.org/export/dump/allCountries.zip", "format": "geonames-zip", "maxBytes": 1000, "maxExpandedBytes": 2000}
        plan = {"schema": 1, "dataset": "places", "coverage": "fixture", "sources": [source]}
        acquire.validate(plan)
        bad = copy.deepcopy(plan); bad["sources"][0]["url"] = "https://download.geonames.org.evil.test/allCountries.zip"
        with self.assertRaises(ValueError): acquire.validate(bad)
        bad = copy.deepcopy(plan); bad["sources"][0]["maxBytes"] = 129 * 1024**3
        with self.assertRaises(ValueError): acquire.validate(bad)
    def test_transport_unknown_length_overflow_and_redirect_cleanup(self):
        class Response(io.BytesIO):
            headers = {}
            def geturl(self): return "https://download.geonames.org/export/dump/allCountries.zip"
        class Opener:
            def open(self, *args, **kwargs): return Response(b"123456")
        source = {"url": "https://download.geonames.org/export/dump/allCountries.zip", "maxBytes": 5}
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "source.zip"
            with self.assertRaises(ValueError): acquire.download(source, target, Opener())
            self.assertFalse(target.exists())
            with patch.object(Response, "geturl", return_value="https://other.example/source"):
                with self.assertRaises(ValueError): acquire.download(source, target, Opener())
    def test_zip_traversal_and_expansion_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "allCountries.zip"
            with zipfile.ZipFile(source, "w") as archive: archive.writestr("../outside.txt", b"x")
            with self.assertRaises(ValueError): acquire.extract_zip(source, root / "out", 100)
            with zipfile.ZipFile(source, "w") as archive: archive.writestr("allCountries.txt", b"x" * 100)
            with self.assertRaises(ValueError): acquire.extract_zip(source, root / "out", 50)
    def test_local_retention_protects_current_and_refuses_non_generations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); gen = self.generation(root)
            self.assertEqual(publish.local_retention(root / "staged", "places", [gen.name], True), [])
            self.assertTrue(gen.exists())
            (root / "staged" / "places" / "unrelated").mkdir()
            with self.assertRaises(ValueError): publish.local_retention(root / "staged", "places", [], True)
    def test_monthly_dry_run_has_no_network_and_policy_is_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = Path(__file__).with_name("geonames-world.plan.json")
            with patch.object(monthly, "R2") as transport, patch.object(acquire, "acquire") as fetch:
                result = monthly.monthly(path, root)
                self.assertFalse(result["execute"]); transport.assert_not_called(); fetch.assert_not_called()
                with self.assertRaises(ValueError): monthly.monthly(path, root, True, "wrong")
    def test_full_reviewed_monthly_policy_runs_real_builder_and_atomic_fake_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = Path(__file__).with_name("geonames-world.plan.json")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            input_path = fixtures.BuildTests().fixture(root, fixtures.geoline())
            policy = root / "policy.json"; policy.write_text(json.dumps({"schema": 1, "sourcePlanSha256": digest, "ownedPrefix": "marine-catalogue/v1/", "publication": True, "retention": True}))
            store = Store()
            with patch.object(monthly, "exclusive", return_value=nullcontext()), patch.object(monthly, "R2", return_value=store), patch.object(acquire, "acquire", return_value=input_path):
                result = monthly.monthly(path, root / "owned", True, digest, policy, hashlib.sha256(policy.read_bytes()).hexdigest())
            self.assertTrue(result["published"])
            self.assertIn("marine-catalogue/v1/places/manifest.json", store.objects)
            self.assertEqual(store.calls[-1], ("put", "marine-catalogue/v1/places/manifest.json"))
    def test_input_cleanup_protects_exact_active_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); base = root / "inputs" / "places"; active = base / "202610-active"; old = base / "202609-obsolete"
            active.mkdir(parents=True); old.mkdir(); (active / "input.json").write_bytes(b"current-proof"); (old / "input.json").write_bytes(b"old-proof")
            monthly.retention_inputs(root, "places", b"current-proof", True)
            self.assertTrue(active.exists()); self.assertFalse(old.exists())
    def test_noaa_changed_agreement_blocks_acquisition_before_chart_download(self):
        class Response(io.BytesIO):
            def geturl(self): return "https://charts.noaa.gov/ENCs/ENC_Agreement.shtml"
        class Opener:
            def open(self, *args, **kwargs): return Response(b"changed legal terms")
        with self.assertRaisesRegex(ValueError, "agreement changed"):
            acquire.verify_noaa_agreement(Opener())
    def test_missing_noaa_class_is_empty_but_actual_s57_failure_aborts(self):
        class Feature:
            def ExportToJson(self): return json.dumps({"type": "Feature", "properties": {"LNAM": "0226000000001234", "OBJNAM": "Fixture"}, "geometry": {"type": "Point", "coordinates": [-70, 40]}})
        class Dataset:
            def GetLayerByName(self, name): return [Feature()] if name == "ACHARE" else None
        class Driver:
            OF_VECTOR = 4
            def OpenEx(self, *args, **kwargs):
                self.options = kwargs
                return Dataset()
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "public.jsonl"; driver = Driver()
            acquire.extract_noaa_cells([Path("US-FIXTURE.000")], output, 10000, driver)
            rows = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual(len(rows), 1)
            self.assertEqual(build.noaa(rows[0])["id"], "noaa:0226000000001234")
            self.assertEqual(driver.options, {"allowed_drivers": ["S57"], "open_options": ["LNAM_REFS=ON"]})
            with patch.object(driver, "OpenEx", side_effect=RuntimeError("Corrupt S57")):
                with self.assertRaises(RuntimeError): acquire.extract_noaa_cells([Path("US-FIXTURE.000")], output, 10000, driver)
    def test_remote_admission_counts_old_objects_before_optional_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            gen = self.generation(Path(tmp))
            inventory = [{"key": "marine-catalogue/v1/places/20240101-old/areas/1_1.json", "bytes": 8 * 1024**3}, {"key": "marine-catalogue/v1/places/20250101-current/areas/1_1.json", "bytes": 1}]
            plan = publication.plan(gen, inventory, {"dataset": "places", "generation": "20250101-current"})
            self.assertFalse(plan["admitted"])
            self.assertGreater(plan["peakBytesBeforeCleanup"], plan["publicationByteCap"])
            self.assertEqual(len(plan["deleteCandidatesAfterSuccessfulManifestSwap"]), 1)
    def test_every_source_recipe_is_bounded_including_separately_reviewed_world(self):
        for path in Path(__file__).parent.glob("*.plan.json"):
            acquire.validate(json.loads(path.read_bytes()))

if __name__ == "__main__": unittest.main()
