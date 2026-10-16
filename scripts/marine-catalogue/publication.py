#!/usr/bin/env python3
"""Produce an exact, bounded object publication/retention plan. Never contacts R2.

The operator supplies an actual listing of the ONE owned prefix and current
manifest. Upload immutable generation objects first; swap manifest LAST only
after every uploaded size/SHA256 has been checked. Deletions require review.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re

PREFIX = "marine-catalogue/v1/"
MAX_OBJECTS = 100000
MAX_GENERATION_BYTES = 2 * 1024**3

def owned(key):
    return bool(re.fullmatch(r"marine-catalogue/v1/(places|osm|noaa|facilities)/(?:manifest\.json|[a-z0-9-]{8,48}/(?:manifest\.json|SOURCE\.json|LICENCE\.txt|NOAA-AGREEMENT\.txt|(?:areas/\d{1,2}_\d{1,3}(?:-[0-3]{1,8})?|names/(?:[a-f0-9]{1,6}-){2,23}[a-f0-9]{1,6}(?:-end)?)\.json))", key))

def plan(generation, inventory, current):
    generation = Path(generation).resolve()
    m = json.loads((generation / "manifest.json").read_text(encoding="utf-8"))
    dataset, version = m["dataset"], m["generation"]
    if dataset not in ("places", "osm", "noaa", "facilities") or generation.name != version or not re.fullmatch(r"[a-z0-9-]{8,48}", version):
        raise ValueError("Invalid generation")
    if current and (current.get("dataset") != dataset or not re.fullmatch(r"[a-z0-9-]{8,48}", current.get("generation", ""))):
        raise ValueError("Invalid active manifest")
    if dataset == "facilities":
        def cohorts(value):
            rows = value.get("cohorts")
            if not isinstance(rows, list) or not 1 <= len(rows) <= 32 or not all(isinstance(v, dict) and set(v) == {"id", "sourceAt", "sha256"} and isinstance(v["id"], str) and re.fullmatch(r"https://download\.geofabrik\.de/[a-z0-9/_-]+", v["id"]) and isinstance(v["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", v["sha256"]) and isinstance(v["sourceAt"], str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", v["sourceAt"]) for v in rows):
                raise ValueError("Invalid facilities regional inventory")
            ids = {v["id"] for v in rows}
            if len(ids) != len(rows): raise ValueError("Duplicate facilities regional inventory")
            return ids
        included = cohorts(m)
        try:
            for value in [m, *([current] if current else [])]:
                for row in value["cohorts"]:
                    stamp = dt.datetime.fromisoformat(row["sourceAt"].replace("Z", "+00:00"))
                    if stamp > dt.datetime.fromisoformat(value["builtAt"].replace("Z", "+00:00")):
                        raise ValueError("Future facilities regional clock")
                if value["sourceAt"] != min(row["sourceAt"] for row in value["cohorts"]):
                    raise ValueError("Facilities source clock cannot hide an older regional cohort")
        except (KeyError, TypeError) as error:
            raise ValueError("Invalid facilities regional source clocks") from error
        if current and not cohorts(current).issubset(included):
            raise ValueError("Facilities publication cannot withdraw an existing regional cohort")
        if current:
            next_rows = {v["id"]: v for v in m["cohorts"]}
            for previous in current["cohorts"]:
                following = next_rows[previous["id"]]
                if following["sourceAt"] < previous["sourceAt"] or (following["sourceAt"] == previous["sourceAt"] and following["sha256"] != previous["sha256"]):
                    raise ValueError("Facilities regional source cannot regress or change under an unchanged clock")
    if len(inventory) > MAX_OBJECTS or any(not owned(row["key"]) or not isinstance(row["bytes"], int) or row["bytes"] < 0 for row in inventory):
        raise ValueError("Refused listing outside exact owned prefix / invalid size")
    uploads, total = [], 0
    for file in sorted(generation.rglob("*")):
        if file.is_symlink():
            raise ValueError("Symlink not allowed")
        if not file.is_file():
            continue
        if file.stat().st_size > 2 * 1024**2:
            raise ValueError("Oversized publication object")
        key = f"{PREFIX}{dataset}/{version}/{file.relative_to(generation).as_posix()}"
        if not owned(key):
            raise ValueError("Unexpected generation object")
        total += file.stat().st_size
        uploads.append({"file": str(file), "key": key, "bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    if not uploads or total > MAX_GENERATION_BYTES or len(uploads) > MAX_OBJECTS:
        raise ValueError("Oversized generation")
    prefix = f"{PREFIX}{dataset}/"
    versions = sorted({r["key"][len(prefix):].split("/")[0] for r in inventory if r["key"].startswith(prefix) and r["key"] != prefix + "manifest.json"}, reverse=True)
    # Keep current + new + latest previous. Never infer current from lexicographic date.
    protected = {version, *(versions[:1]), *([current["generation"]] if current else [])}
    if not current and versions:
        raise ValueError("Remote history exists: actual current manifest required before retention planning")
    deletes = [r for r in inventory if r["key"].startswith(prefix) and r["key"] != prefix + "manifest.json" and r["key"][len(prefix):].split("/")[0] not in protected]
    retained_bytes = sum(r["bytes"] for r in inventory if r["key"].startswith(prefix) and r not in deletes)
    existing_bytes = sum(r["bytes"] for r in inventory if r["key"].startswith(prefix))
    existing_keys = {r["key"] for r in inventory}
    added_bytes = sum(r["bytes"] for r in uploads if r["key"] not in existing_keys)
    # Cleanup is optional and follows the swap. Count every old/orphan object
    # in the physical peak, so preparation/default-no-cleanup cannot grow forever.
    peak = existing_bytes + added_bytes + (generation / "manifest.json").stat().st_size
    return {"schema": 1, "dataset": dataset, "generation": version, "uploads": uploads, "manifestLast": {"file": str(generation / "manifest.json"), "key": prefix + "manifest.json", "expectedPreviousGeneration": current["generation"] if current else None}, "protectedGenerations": sorted(protected), "deleteCandidatesAfterSuccessfulManifestSwap": deletes, "newBytes": total, "retainedBytesBeforeUpload": retained_bytes, "existingBytesBeforeUpload": existing_bytes, "peakBytesBeforeCleanup": peak, "publicationByteCap": 4 * MAX_GENERATION_BYTES, "admitted": peak <= 4 * MAX_GENERATION_BYTES, "apply": False}

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--generation", required=True)
    p.add_argument("--inventory", required=True, help="JSON array [{key,bytes}] from the exact owned R2 prefix")
    p.add_argument("--current", help="Downloaded current manifest, or omit ONLY for empty prefix")
    a = p.parse_args()
    print(json.dumps(plan(a.generation, json.loads(Path(a.inventory).read_text()), json.loads(Path(a.current).read_text()) if a.current else None), indent=2))
