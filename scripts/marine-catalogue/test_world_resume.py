"""Offline interruption/adoption proofs. Fake native/HTTP ports, no provider I/O."""
from contextlib import nullcontext
import copy
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import build
import monthly
import world_policy
import world_resume as resume


def plan():
    return {"schema": 1, "dataset": "facilities-world", "coverage": "Eight synthetic continental cohorts only", "sources": [
        {"url": f"https://download.geofabrik.de/{region}-latest.osm.pbf", "format": "osm-pbf", "maxBytes": 8192, "maxExpandedBytes": 32768}
        for region in sorted(world_policy.REGIONS)]}


class Native:
    identity = "a" * 64
    def __init__(self):
        self.fail = None; self.calls = []; self.retired = False; self.mutate = None
        self.source_at = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    def current(self):
        if self.retired: raise ValueError("Native retired")
    def source_clock(self, raw, root):
        return resume.clock(self.source_at)
    def run(self, args, maximum, **kwargs):
        self.current(); self.calls.append(args)
        output = Path(args[args.index("-o") + 1])
        index = int(output.name.split("-")[1].split(".")[0])
        if self.fail == (args[0], index): raise RuntimeError("Simulated native interruption")
        if args[0] == "tags-filter":
            self.assert_selectors = args[3:args.index("-o")]
            output.write_bytes(b"filtered")
        else:
            feature = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [179.9, -17]}, "properties": {"@type": "node", "@id": index + 1, "name": "Fictional mapped facility", "leisure": "marina"}}
            output.write_bytes(b"\x1e" + json.dumps(feature).encode() + b"\n")
        if self.mutate: self.mutate(args)


class Ports:
    def __init__(self): self.calls = []; self.fail = None
    def download(self, source, target, headers):
        self.calls.append(source["url"])
        data = ("original:" + source["url"]).encode()
        headers({"sourceUrl": source["url"], "contentLength": len(data), "etag": '"fictional"', "lastModified": None, "headersObservedAt": resume.now()})
        if self.fail == "partial":
            target.write_bytes(data[:-1]); raise RuntimeError("Interrupted body")
        target.write_bytes(data)
        if self.fail == "complete": raise RuntimeError("Interrupted before raw receipt")


class WorldResumeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name); self.native = Native(); self.ports = Ports(); self.plan = plan()
        self.addCleanup(patch.stopall)
        patch.object(resume, "state_lock", lambda path: nullcontext()).start()
        patch.object(resume.shutil, "disk_usage", return_value=SimpleNamespace(free=10**15)).start()
        patch.object(resume, "download_world", self.ports.download).start()
        self.inputs = self.base / "inputs" / "facilities-world"
    def controller(self, native=None, recoveries=None):
        return resume.WorldResume(self.plan, self.inputs, native or self.native, recoveries)
    def interrupt(self):
        self.native.fail = ("tags-filter", 2)
        controller = self.controller()
        with self.assertRaises(RuntimeError): controller.execute()
        return controller
    def test_all_eight_original_scopes_build_and_repeat_without_fetch_or_native(self):
        source = self.controller().execute()
        original = source.read_bytes(); receipts = (source.parent / "transport-receipts.json").read_bytes()
        generated = build.build(source, self.base / "staged")
        manifest = json.loads((generated / "manifest.json").read_text())
        self.assertEqual(manifest["count"], 8); self.assertEqual(len(manifest["cohorts"]), 8)
        self.assertEqual(self.native.assert_selectors, list(world_policy.SELECTORS))
        count = len(self.native.calls)
        self.assertEqual(self.controller().execute(), source)
        self.assertEqual(len(self.ports.calls), 8); self.assertEqual(len(self.native.calls), count)
        self.assertEqual(source.read_bytes(), original); self.assertEqual((source.parent / "transport-receipts.json").read_bytes(), receipts)
        self.assertEqual({r["provenance"]["kind"] for r in json.loads(receipts)}, {"http-original"})
    def test_native_oom_resumes_current_raw_and_completed_outputs_without_redownload(self):
        controller = self.interrupt()
        self.assertTrue((controller.root / "cohort-0.json").is_file())
        self.assertTrue((controller.root / "raw-2.json").is_file())
        self.assertTrue((controller.root / "raw-2.osm.pbf").is_file())
        self.native.fail = None
        self.controller().execute()
        self.assertEqual(len(self.ports.calls), 8); self.assertEqual(len(set(self.ports.calls)), 8)
        self.assertFalse(any(controller.root.glob("*.osm.pbf")))
        self.assertFalse(any(controller.root.glob("*.geojsonseq")))
    def test_complete_http_stream_can_resume_from_original_prebody_headers(self):
        self.ports.fail = "complete"; controller = self.controller()
        with self.assertRaises(RuntimeError): controller.execute()
        self.assertFalse((controller.root / "raw-0.json").exists())
        self.ports.fail = None; source = self.controller().execute()
        receipts = json.loads((source.parent / "transport-receipts.json").read_text())
        self.assertEqual(receipts[0]["provenance"]["kind"], "completed-http-stream-recovered")
        self.assertEqual(len(self.ports.calls), 8)
    def test_partial_http_stream_holds_without_retry_or_promotion(self):
        self.ports.fail = "partial"
        with self.assertRaises(RuntimeError): self.controller().execute()
        self.ports.fail = None
        with self.assertRaisesRegex(ValueError, "complete-body"): self.controller().execute()
        self.assertEqual(len(self.ports.calls), 1); self.assertEqual(list(self.inputs.iterdir()), [])
    def test_missing_http_length_after_interruption_does_not_invent_completeness(self):
        self.ports.fail = "complete"; controller = self.controller()
        with self.assertRaises(RuntimeError): controller.execute()
        transfers = controller.read("transfers.json"); transfers["attempts"][0]["headers"]["contentLength"] = None
        controller.checkpoint("transfers.json", transfers)
        with self.assertRaisesRegex(ValueError, "complete-body"): self.controller().execute()
        self.assertEqual(len(self.ports.calls), 1)
    def test_unreceipted_legacy_export_is_never_adopted(self):
        self.inputs.mkdir(parents=True); (self.inputs / ".acquire-old").mkdir()
        (self.inputs / ".acquire-old" / "public-0.jsonl").write_bytes(b"unreceipted")
        with self.assertRaisesRegex(ValueError, "quarantine"): self.controller().execute()
        self.assertEqual(self.ports.calls, [])
    def test_unreceipted_original_holds(self):
        controller = self.controller(); (controller.root / "raw-0.osm.pbf").write_bytes(b"unreceipted")
        with self.assertRaisesRegex(ValueError, "explicit recovery"): controller.execute()
        self.assertEqual(self.ports.calls, [])
    def test_reviewed_local_original_is_copied_hashed_and_has_no_http_clock(self):
        original = self.base / "reviewed-original.pbf"; original.write_bytes(b"reviewed-fixed-original")
        recovery = {self.plan["sources"][2]["url"]: {"sourceUrl": self.plan["sources"][2]["url"], "path": str(original), **resume.descriptor(original, 8192), "reviewedAt": resume.now(), "reviewReceiptSha256": "b" * 64}}
        source = self.controller(recoveries=recovery).execute()
        receipt = json.loads((source.parent / "transport-receipts.json").read_text())[2]
        self.assertEqual(receipt["provenance"]["kind"], "reviewed-preserved-original")
        self.assertNotIn("headers", receipt["provenance"]); self.assertNotIn("startedAt", receipt["provenance"])
        self.assertEqual(len(self.ports.calls), 7); self.assertEqual(original.read_bytes(), b"reviewed-fixed-original")
    def test_mutated_reviewed_original_refused_before_recovery_copy(self):
        original = self.base / "original.pbf"; original.write_bytes(b"original")
        recovery = {self.plan["sources"][0]["url"]: {"sourceUrl": self.plan["sources"][0]["url"], "path": str(original), **resume.descriptor(original, 8192), "reviewedAt": resume.now(), "reviewReceiptSha256": "b" * 64}}
        original.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "bytes changed"): self.controller(recoveries=recovery).execute()
        self.assertEqual(self.ports.calls, [])
    def test_completed_output_and_raw_mutation_each_refuse_without_new_fetch(self):
        controller = self.interrupt(); calls = len(self.ports.calls)
        output = controller.root / "public-0.jsonl"; original = output.read_bytes(); output.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "bytes changed"): self.controller().execute()
        output.write_bytes(original); (controller.root / "raw-2.osm.pbf").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "bytes changed"): self.controller().execute()
        self.assertEqual(len(self.ports.calls), calls)
    def test_raw_mutation_during_native_refuses_before_receipt_and_deletion(self):
        controller = self.controller()
        self.native.mutate = lambda args: (controller.root / "raw-0.osm.pbf").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "during extraction"): controller.execute()
        self.assertFalse((controller.root / "cohort-0.json").exists())
        self.assertTrue((controller.root / "raw-0.osm.pbf").exists())
    def test_changed_runtime_plan_selector_or_controller_identity_refuses(self):
        controller = self.interrupt(); calls = len(self.ports.calls)
        native = Native(); native.identity = "c" * 64
        with self.assertRaisesRegex(ValueError, "identity changed"): self.controller(native).execute()
        job = controller.read("job.json"); job["controllerSources"]["build.py"]["sha256"] = "0" * 64
        controller.checkpoint("job.json", job)
        with self.assertRaisesRegex(ValueError, "identity changed"): self.controller().execute()
        self.assertEqual(len(self.ports.calls), calls)
    def test_unknown_state_paths_or_two_large_originals_refuse(self):
        controller = self.controller(); unknown = controller.root / "borrowed.geojson"; unknown.write_bytes(b"{}")
        with self.assertRaisesRegex(ValueError, "Unexpected file"): controller.execute()
        unknown.unlink()
        (controller.root / "raw-0.osm.pbf").write_bytes(b"one"); (controller.root / "incoming-1.osm.pbf").write_bytes(b"two")
        with self.assertRaisesRegex(ValueError, "simultaneous"): controller.execute()
        self.assertEqual(self.ports.calls, [])
    def test_source_clock_expiry_is_not_renewed_by_resuming(self):
        self.native.source_at = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=46)).strftime("%Y-%m-%dT%H:%M:%SZ")
        with self.assertRaisesRegex(ValueError, "expired"): self.controller().execute()
        self.assertEqual(len(self.ports.calls), 1)
    def test_runtime_retirement_during_export_preserves_original_and_no_success(self):
        controller = self.controller(); self.native.mutate = lambda args: setattr(self.native, "retired", args[0] == "export")
        with self.assertRaisesRegex(ValueError, "retired"): controller.execute()
        self.assertFalse((controller.root / "cohort-0.json").exists()); self.assertTrue((controller.root / "raw-0.osm.pbf").exists())
    def test_receipt_failure_keeps_original_until_durable_output_proof(self):
        controller = self.controller(); checkpoint = controller.checkpoint
        def fail(name, value):
            if name == "cohort-0.json": raise OSError("Simulated fsync failure")
            checkpoint(name, value)
        with patch.object(controller, "checkpoint", side_effect=fail):
            with self.assertRaises(OSError): controller.execute()
        self.assertTrue((controller.root / "raw-0.osm.pbf").exists()); self.assertFalse((controller.root / "cohort-0.json").exists())
        self.controller().execute(); self.assertEqual(len(self.ports.calls), 8)
    def test_partial_final_promotion_can_resume_with_two_snapshot_slots(self):
        controller = self.controller(); original_link = resume.os.link; count = 0
        def interrupt(src, dst):
            nonlocal count
            count += 1
            if count == 3: raise OSError("Simulated promotion crash")
            return original_link(src, dst)
        with patch.object(resume.os, "link", side_effect=interrupt):
            with self.assertRaises(OSError): controller.execute()
        other = self.inputs / "202501-0000000000000000"; other.mkdir(); (other / "input.json").write_text("{}")
        source = self.controller().execute()
        self.assertEqual(len(json.loads(source.read_text())["inputs"]), 8); self.assertEqual(len(self.ports.calls), 8)
    def test_promoted_manifest_and_link_corruption_refuse(self):
        source = self.controller().execute(); raw = source.read_bytes(); manifest = json.loads(raw)
        manifest["coverage"] = "inferred global readiness"; source.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "receipt changed"): self.controller().execute()
        source.write_bytes(raw); (source.parent / "public-0.jsonl").write_bytes(b"altered")
        with self.assertRaises(ValueError): self.controller().execute()
    def test_free_space_preserves_fresh_envelope_and_recovery_copy_cost(self):
        controller = self.controller(); required = sum(s["maxBytes"] for s in self.plan["sources"]) + 3 * sum(s["maxExpandedBytes"] for s in self.plan["sources"]) + 4 * 1024**3
        with patch.object(resume.shutil, "disk_usage", return_value=SimpleNamespace(free=required - 1)):
            with self.assertRaisesRegex(ValueError, "disk envelope"): controller.execute()
        self.assertEqual(self.ports.calls, [])
    def test_recovery_cannot_borrow_its_copy_bytes_from_remaining_download_budget(self):
        original = self.base / "original.pbf"; original.write_bytes(b"reviewed original")
        recovered = {self.plan["sources"][0]["url"]: {"sourceUrl": self.plan["sources"][0]["url"], "path": str(original), **resume.descriptor(original, 8192), "reviewedAt": resume.now(), "reviewReceiptSha256": "b" * 64}}
        required = sum(s["maxBytes"] for s in self.plan["sources"][1:]) + 3 * sum(s["maxExpandedBytes"] for s in self.plan["sources"]) + 4 * 1024**3 + original.stat().st_size
        with patch.object(resume.shutil, "disk_usage", return_value=SimpleNamespace(free=required - 1)):
            with self.assertRaisesRegex(ValueError, "disk envelope"): self.controller(recoveries=recovered).execute()
        self.assertEqual(self.ports.calls, []); self.assertEqual(original.read_bytes(), b"reviewed original")
    def test_converter_source_retirement_during_export_never_adopts_result(self):
        controller = self.controller()
        def retire(args):
            if args[0] == "export": controller.source_files["build.py"]["sha256"] = "0" * 64
        self.native.mutate = retire
        with self.assertRaisesRegex(ValueError, "source retired"): controller.execute()
        self.assertTrue((controller.root / "raw-0.osm.pbf").exists()); self.assertFalse((controller.root / "cohort-0.json").exists())
    def test_symlink_in_owned_state_refused_where_supported(self):
        controller = self.controller(); outside = self.base / "outside"; outside.write_text("{}"); link = controller.root / "transfers.json"
        try: link.symlink_to(outside)
        except OSError: self.skipTest("Windows symlink privilege unavailable; actual Linux proof still required")
        with self.assertRaisesRegex(ValueError, "regular file"): controller.execute()
        self.assertEqual(outside.read_text(), "{}")
        link.unlink(); self.inputs.rmdir(); outside_directory = self.base / "outside-directory"; outside_directory.mkdir()
        self.inputs.symlink_to(outside_directory, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "namespace"): self.controller()
        self.assertEqual(list(outside_directory.iterdir()), [])
    def test_oversized_metadata_or_changed_raw_provenance_refuse(self):
        controller = self.interrupt(); raw = controller.read("raw-2.json")
        raw["provenance"]["headers"]["etag"] = "x" * 1025; controller.checkpoint("raw-2.json", raw)
        with self.assertRaisesRegex(ValueError, "header cap"): self.controller().execute()
        (controller.root / "raw-2.json").write_bytes(b"x" * (resume.STATE_CAP + 1))
        with self.assertRaisesRegex(ValueError, "byte cap"): self.controller().execute()
    def malformed_checkpoint(self, name):
        for malformed in ({}, None, [], False, 0, ""):
            with self.subTest(name=name, malformed=malformed), tempfile.TemporaryDirectory() as tmp:
                native, ports = Native(), Ports()
                controller = resume.WorldResume(self.plan, Path(tmp) / "inputs" / "facilities-world", native)
                with patch.object(resume, "download_world", ports.download):
                    if name == "transfers.json": ports.fail = "partial"
                    if name == "raw-0.json": native.fail = ("tags-filter", 0)
                    if name == "cohort-0.json": native.fail = ("tags-filter", 1)
                    if name != "job.json":
                        if name == "promoted.json": controller.execute()
                        else:
                            with self.assertRaises(RuntimeError): controller.execute()
                    ports.fail = None; native.fail = None
                    provider_count, child_count = len(ports.calls), len(native.calls)
                    controller.checkpoint(name, malformed)
                    before = (controller.root / name).read_bytes()
                    with self.assertRaisesRegex(ValueError, "checkpoint must be a nonempty object"): controller.execute()
                    self.assertEqual(len(ports.calls), provider_count); self.assertEqual(len(native.calls), child_count)
                    self.assertEqual((controller.root / name).read_bytes(), before)
    def test_existing_malformed_transfer_checkpoint_cannot_reset_reservation(self):
        self.malformed_checkpoint("transfers.json")
    def test_existing_malformed_raw_checkpoint_cannot_become_absence(self):
        self.malformed_checkpoint("raw-0.json")
    def test_existing_malformed_cohort_checkpoint_cannot_become_absence(self):
        self.malformed_checkpoint("cohort-0.json")
    def test_existing_malformed_promoted_checkpoint_cannot_become_absence(self):
        self.malformed_checkpoint("promoted.json")
    def test_existing_malformed_job_checkpoint_cannot_become_absence(self):
        self.malformed_checkpoint("job.json")


class TransportTests(unittest.TestCase):
    def response(self, source, data=b"original", **headers):
        class Response(io.BytesIO):
            status = 200
            def geturl(self): return source["url"]
        response = Response(data); response.headers = {"Content-Length": str(len(data)), **headers}
        return response
    def download(self, source, path, callback, response):
        # The integration tests fake this port; exercise the actual transport here.
        return resume.download_world(source, path, callback, opener=SimpleNamespace(open=lambda *a, **k: response))
    def test_original_headers_are_observed_before_body_target_exists(self):
        source = plan()["sources"][0]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "body.pbf"; receipts = []
            def headers(value): self.assertFalse(path.exists()); receipts.append(value)
            self.download(source, path, headers, self.response(source, ETag='"original"'))
            self.assertEqual(path.read_bytes(), b"original"); self.assertEqual(receipts[0]["contentLength"], 8)
    def test_length_encoding_redirect_and_header_control_refuse_before_body(self):
        source = plan()["sources"][0]
        for headers in ({"Content-Length": "9" * 21}, {"Content-Encoding": "gzip"}, {"ETag": "bad\nheader"}):
            with self.subTest(headers=headers), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "body.pbf"
                with self.assertRaises(ValueError): self.download(source, path, lambda value: None, self.response(source, **headers))
                self.assertFalse(path.exists())
    def test_truncated_http_body_is_kept_unpromoted_for_explicit_review(self):
        source = plan()["sources"][0]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "body.pbf"
            with self.assertRaisesRegex(ValueError, "Incomplete"): self.download(source, path, lambda value: None, self.response(source, **{"Content-Length": "999"}))
            self.assertEqual(path.read_bytes(), b"original")
    def test_old_or_future_url_never_opens_transport(self):
        for days in (-46, 1):
            day = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days)).strftime("%y%m%d")
            source = {**plan()["sources"][0], "url": f"https://download.geofabrik.de/africa-{day}.osm.pbf"}
            with self.subTest(days=days), patch.object(resume.urllib.request, "build_opener") as opener:
                with self.assertRaisesRegex(ValueError, "Old/future"): resume.download_world(source, Path("never.pbf"), lambda value: None)
                opener.assert_not_called()


class IntegrationTests(unittest.TestCase):
    def test_stale_atomic_pending_hardlink_cannot_truncate_other_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); outside = root / "outside"; outside.write_bytes(b"original external bytes")
            destination = root / "job.json"; resume.os.link(outside, root / "job.json.pending")
            resume.atomic(destination, {"schema": 1})
            self.assertEqual(outside.read_bytes(), b"original external bytes")
            self.assertEqual(resume.read_json(destination), {"schema": 1})
    def test_monthly_world_requires_policy_before_lock_or_acquisition(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plan.json"; path.write_bytes(resume.encoded(plan())); sha = hashlib.sha256(path.read_bytes()).hexdigest()
            with patch.object(monthly, "exclusive") as lock:
                with self.assertRaisesRegex(ValueError, "native runtime"): monthly.monthly(path, tmp, True, sha)
                lock.assert_not_called()
                result = monthly.monthly(path, tmp)
                self.assertFalse(result["execute"])
    def test_world_monthly_calls_only_durable_controller_with_exact_controls(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plan.json"; path.write_bytes(resume.encoded(plan())); sha = hashlib.sha256(path.read_bytes()).hexdigest()
            source = Path(tmp) / "verified-input.json"
            with patch.object(monthly, "exclusive", return_value=nullcontext()), patch.object(monthly, "generations") as generations, patch.object(resume, "run", return_value=source) as controller, patch.object(monthly.acquire, "acquire") as old, patch.object(monthly.build, "build", return_value=Path(tmp) / "generation"):
                result = monthly.monthly(path, tmp, True, sha, world_runtime_policy="reviewed.json", world_runtime_sha256="a" * 64, world_recovery="recovery.json", world_recovery_sha256="b" * 64)
                self.assertFalse(result["published"]); old.assert_not_called(); self.assertEqual(generations.call_count, 1)
                self.assertEqual(controller.call_args.args[2:], ("reviewed.json", "a" * 64, "recovery.json", "b" * 64))
    def test_world_options_cannot_change_regional_flow(self):
        regional = {"schema": 1, "dataset": "facilities", "coverage": "Synthetic regional scope", "sources": [plan()["sources"][0]]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plan.json"; path.write_bytes(resume.encoded(regional)); sha = hashlib.sha256(path.read_bytes()).hexdigest()
            with patch.object(monthly, "exclusive") as lock:
                with self.assertRaisesRegex(ValueError, "regional"): monthly.monthly(path, tmp, True, sha, world_runtime_policy="reviewed.json")
                lock.assert_not_called()


class NativeBoundaryTests(unittest.TestCase):
    def runtime(self):
        runtime = resume.Runtime.__new__(resume.Runtime)
        runtime.executable = Path("/opt/reviewed/osmium")
        runtime.environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "OSMIUM_POOL_THREADS": "2"}
        runtime.snapshots = []
        runtime.bindings = []
        return runtime
    def test_child_canonical_argv0_exact_executable_cleared_env_and_deadline(self):
        runtime = self.runtime()
        child = SimpleNamespace(wait=lambda **kwargs: 0)
        with patch.dict(resume.os.environ, {"LD_PRELOAD": "untrusted", "PYTHONPATH": "untrusted", "CATALOGUE_R2_SECRET_ACCESS_KEY": "fictional"}), patch.object(resume.subprocess, "Popen", return_value=child) as popen:
            runtime.run(["tags-filter", "fixed.pbf"], 8192)
            self.assertEqual(popen.call_args.args[0], ["osmium", "tags-filter", "fixed.pbf"])
            self.assertEqual(popen.call_args.kwargs["executable"], str(runtime.executable))
            self.assertEqual(popen.call_args.kwargs["env"], runtime.environment)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            self.assertTrue(popen.call_args.kwargs["close_fds"])
            self.assertEqual(popen.call_args.kwargs["stdin"], subprocess.DEVNULL)
            self.assertNotIn("LD_PRELOAD", popen.call_args.kwargs["env"])
    def test_child_timeout_kills_group_and_reaps_before_failure(self):
        runtime = self.runtime(); calls = []
        class Child:
            pid = 12345
            def wait(self, **kwargs):
                calls.append(kwargs)
                if kwargs: raise subprocess.TimeoutExpired("osmium", kwargs["timeout"])
                return -9
            def poll(self): return None
        with patch.object(resume.subprocess, "Popen", return_value=Child()), patch.object(resume.os, "killpg", create=True) as kill, patch.object(resume.signal, "SIGKILL", 9, create=True):
            with self.assertRaises(subprocess.TimeoutExpired): runtime.run(["fileinfo", "fixed.pbf"], 4096, timeout=30)
            kill.assert_called_once_with(12345, resume.signal.SIGKILL)
            self.assertEqual(calls, [{"timeout": 30}, {}])
    def test_retired_dependency_is_rejected_before_child(self):
        runtime = self.runtime()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "dependency"; path.write_bytes(b"original")
            runtime.snapshots = [(path, resume.stamp(path.stat()))]; path.write_bytes(b"changed")
            with patch.object(resume.subprocess, "Popen") as child:
                with self.assertRaisesRegex(ValueError, "retired"): runtime.run(["fileinfo", "fixed.pbf"], 4096)
                child.assert_not_called()
    def test_actual_native_policy_is_linux_only_and_strict_if_linux(self):
        # Linux invocation of the same suite validates root ownership and real
        # absolute /opt files. Windows cannot represent that production policy.
        if resume.os.name != "posix": self.skipTest("Production POSIX policy admission requires Linux")
        if resume.os.geteuid() != 0 or not resume.os.access("/opt", resume.os.W_OK): self.skipTest("Root-owned isolated /opt fixture requires an explicit privileged Linux harness")
        with tempfile.TemporaryDirectory(prefix="thalassa-world-policy-", dir="/opt") as tmp:
            root = Path(tmp); executable = root / "osmium"; executable.write_bytes(b"fixed synthetic executable")
            executable.chmod(0o444)
            policy = {"schema": 1, "executable": str(executable), "files": [{"path": str(executable), **resume.descriptor(executable, 8192)}], "bindings": [], "libraryPath": ""}
            path = root / "policy.json"; path.write_bytes(resume.encoded(policy)); sha = hashlib.sha256(path.read_bytes()).hexdigest()
            runtime = resume.Runtime(path, sha); runtime.current()
            executable.chmod(0o644); executable.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "retired"): runtime.current()
            with self.assertRaises(ValueError): resume.Runtime(path, sha)
    def test_relinked_loader_alias_refuses_even_if_old_hashed_file_remains(self):
        runtime = self.runtime()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); first = root / "v1"; first.write_bytes(b"old dependency")
            second = root / "v2"; second.write_bytes(b"changed dependency")
            # A mocked resolve isolates the link fence from Windows symlink
            # privilege. The actual Linux case also exercises real symlinks.
            runtime.bindings = [(first, second)]
            with patch.object(resume, "root_namespace"):
                with self.assertRaisesRegex(ValueError, "loader binding retired"): runtime.current()


if __name__ == "__main__": unittest.main()
