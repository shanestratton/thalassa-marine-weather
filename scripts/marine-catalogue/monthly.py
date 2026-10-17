#!/usr/bin/env python3
"""Prepare one bounded monthly public catalogue generation under the wx lock.

Acquisition requires --execute and exact reviewed source-plan hash. Publication
requires either a separate reviewed plan or an exact, explicitly reviewed
publication/retention policy; installation alone cannot enable it.
No current weather-server job or timer is changed by installing these files.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import acquire
import build
from publish import exclusive, R2, prepare, apply, local_retention

def retention_inputs(root, dataset, active_source, delete=False):
    base = Path(root).resolve() / "inputs" / dataset
    if not base.exists(): return []
    result = []
    for path in base.iterdir():
        if path.is_symlink() or not path.is_dir() or not re.fullmatch(r"[a-z0-9-]{8,48}", path.name) or not (path / "input.json").is_file(): raise ValueError("Unexpected input retention path")
        if active_source is not None and (path / "input.json").read_bytes() == active_source: continue
        result.append(path)
    if delete:
        for path in result:
            if path.resolve().parent != base.resolve(): raise ValueError("Input deletion escaped owned directory")
            shutil.rmtree(path)
    return [str(path) for path in result]

def generations(directory, maximum, cap):
    root = Path(directory).resolve(); root.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in root.iterdir():
        if path.name == "refresh.lock": continue
        if path.is_symlink() or not path.is_dir() or not re.fullmatch(r"[a-z0-9-]{8,48}", path.name): raise ValueError("Unexpected owned staging path")
        size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
        if size > cap: raise ValueError("Owned generation exceeds local cap")
        rows.append(path)
    if len(rows) >= maximum: raise ValueError("Local generation cap reached; review retention plan before next acquisition")
    return rows

def monthly(plan_path, root, execute=False, expected=None, policy_path=None, policy_sha=None, *, world_runtime_policy=None, world_runtime_sha256=None, world_recovery=None, world_recovery_sha256=None):
    raw = Path(plan_path).read_bytes()
    if len(raw) > 65536: raise ValueError("Plan too large")
    plan = acquire.validate(json.loads(raw)); digest = hashlib.sha256(raw).hexdigest()
    root = Path(root).resolve()
    if not execute: return {"execute": False, "planSha256": digest, "sourcePlan": plan, "root": str(root)}
    if expected != digest: raise ValueError("Exact reviewed source plan required")
    if plan["dataset"] == "facilities-world" and (not world_runtime_policy or not world_runtime_sha256):
        raise ValueError("World execution requires the exact reviewed native runtime policy")
    if plan["dataset"] != "facilities-world" and any(value is not None for value in (world_runtime_policy, world_runtime_sha256, world_recovery, world_recovery_sha256)):
        raise ValueError("World resume controls cannot alter regional acquisition")
    with exclusive(root):
        store = None
        if policy_path:
            policy_raw = Path(policy_path).read_bytes(); policy = json.loads(policy_raw)
            if hashlib.sha256(policy_raw).hexdigest() != policy_sha or policy != {"schema": 1, "sourcePlanSha256": digest, "ownedPrefix": "marine-catalogue/v1/", "publication": True, "retention": True}:
                raise ValueError("Exact bounded publication/retention policy review required")
            store = R2()
            key = f"marine-catalogue/v1/{plan['dataset']}/manifest.json"
            current = store.get(key, 2 * 1024**2)
            active = json.loads(current[0]) if current else None
            if active and (active.get("dataset") != plan["dataset"] or not re.fullmatch(r"[a-z0-9-]{8,48}", active.get("generation", ""))): raise ValueError("Invalid active manifest; no cleanup")
            source = store.get(f"marine-catalogue/v1/{plan['dataset']}/{active['generation']}/SOURCE.json", 65536) if active else None
            if active and not source: raise ValueError("Current source proof unavailable; no local cleanup")
            versions = sorted([p.name for p in (root / "staged" / plan["dataset"]).iterdir() if p.is_dir()], reverse=True) if (root / "staged" / plan["dataset"]).exists() else []
            protected = ([active["generation"]] if active else []) + [v for v in versions if not active or v != active["generation"]][:1]
            # All automatic jobs share this OS lock. Recheck actual remote identity
            # before deleting only inactive generated local source snapshots.
            if store.get(key, 2 * 1024**2) != current: raise ValueError("Current publication changed; no cleanup")
            retention_inputs(root, plan["dataset"], source[0] if source else None, True)
            local_retention(root / "staged", plan["dataset"], protected, True)
        # Physical hard caps: two admitted source snapshots, three staged
        # generations/dataset. Without reviewed cleanup the next run stops.
        if plan["dataset"] != "facilities-world":
            generations(root / "inputs" / plan["dataset"], 2, acquire.LIMIT)
        generations(root / "staged" / plan["dataset"], 3, build.MAX_OUTPUT_BYTES)
        if plan["dataset"] == "facilities-world":
            import world_resume
            source = world_resume.run(plan, root / "inputs" / plan["dataset"], world_runtime_policy, world_runtime_sha256, world_recovery, world_recovery_sha256)
        else:
            source = acquire.acquire(plan, root / "inputs" / plan["dataset"])
        if shutil.disk_usage(root).free < 4 * 1024**3: raise ValueError("Insufficient output headroom")
        generation = build.build(source, root / "staged")
        if store:
            review = prepare(store, generation)
            (root / f"{plan['dataset']}-latest-review.json").write_text(json.dumps(review, sort_keys=True, indent=2), encoding="utf-8")
            # Explicit reviewed POLICY mode, never enabled by timer installation
            # alone. Each actual plan is recorded before any object upload.
            published = apply(store, review, True)
            local_retention(root / "staged", plan["dataset"], review["protectedGenerations"], True)
            return {"execute": True, "published": True, "generation": published["generation"]}
        return {"execute": True, "published": False, "generation": str(generation), "next": "Run publish.py dry-run; review exact object/retention plan before --apply"}

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__); p.add_argument("--plan", required=True); p.add_argument("--root", required=True); p.add_argument("--execute", action="store_true"); p.add_argument("--plan-sha256"); p.add_argument("--publication-policy"); p.add_argument("--policy-sha256")
    p.add_argument("--world-runtime-policy"); p.add_argument("--world-runtime-policy-sha256"); p.add_argument("--world-recovery"); p.add_argument("--world-recovery-sha256")
    a = p.parse_args(); print(json.dumps(monthly(a.plan, a.root, a.execute, a.plan_sha256, a.publication_policy, a.policy_sha256, world_runtime_policy=a.world_runtime_policy, world_runtime_sha256=a.world_runtime_policy_sha256, world_recovery=a.world_recovery, world_recovery_sha256=a.world_recovery_sha256), indent=2))
