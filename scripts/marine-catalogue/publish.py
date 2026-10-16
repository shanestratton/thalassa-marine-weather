#!/usr/bin/env python3
"""R2 publication: immutable objects verified before atomic manifest CAS.

Default command only reads/list/plans. --apply requires the exact saved plan
SHA256; --enable-retention is separate and defaults OFF. Server-side keys only.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
import publication

def hash_file(path):
    with Path(path).open("rb") as stream: return hashlib.file_digest(stream, "sha256").hexdigest()

@contextmanager
def exclusive(directory):
    """wx runs Linux: OS lock is released after crashes; an old lock file is harmless."""
    import fcntl
    root = Path(directory).resolve(); root.mkdir(parents=True, exist_ok=True)
    with (root / "refresh.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield

class R2:
    def __init__(self):
        import boto3
        from botocore.config import Config
        account = os.environ["CATALOGUE_R2_ACCOUNT_ID"]
        self.bucket = os.environ["CATALOGUE_R2_BUCKET"]
        if not re.fullmatch(r"[a-f0-9]{32}", account) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", self.bucket):
            raise ValueError("Invalid R2 destination")
        self.client = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com", region_name="auto", aws_access_key_id=os.environ["CATALOGUE_R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["CATALOGUE_R2_SECRET_ACCESS_KEY"], config=Config(connect_timeout=10, read_timeout=30, retries={"max_attempts": 2}))
    def listing(self):
        result, token, seen = [], None, set()
        for _ in range(101):
            opts = {"Bucket": self.bucket, "Prefix": publication.PREFIX, "MaxKeys": 1000}
            if token: opts["ContinuationToken"] = token
            body = self.client.list_objects_v2(**opts)
            for row in body.get("Contents", []):
                if not publication.owned(row["Key"]): raise ValueError("Unexpected object inside owned prefix")
                result.append({"key": row["Key"], "bytes": row["Size"]})
            if len(result) > publication.MAX_OBJECTS: raise ValueError("Remote listing cap exceeded")
            if not body.get("IsTruncated"): return result
            token = body.get("NextContinuationToken")
            if not token or token in seen: raise ValueError("Invalid remote pagination")
            seen.add(token)
        raise ValueError("Remote listing did not finish")
    def get(self, key, maximum):
        if not publication.owned(key): raise ValueError("Outside owned prefix")
        try: response = self.client.get_object(Bucket=self.bucket, Key=key)
        except self.client.exceptions.NoSuchKey: return None
        stream = response["Body"]
        try:
            if response["ContentLength"] > maximum: raise ValueError("Remote read cap exceeded")
            body = stream.read(maximum + 1)
            if len(body) > maximum: raise ValueError("Remote read cap exceeded")
            return body, response["ETag"]
        finally: stream.close()
    def put(self, key, body, previous=None, immutable=False):
        if not publication.owned(key): raise ValueError("Outside owned prefix")
        opts = {"Bucket": self.bucket, "Key": key, "Body": body, "Metadata": {"sha256": hashlib.sha256(body).hexdigest()}, "ContentType": "text/plain; charset=utf-8" if key.endswith(".txt") else "application/json", "CacheControl": "public,max-age=31536000,immutable" if immutable else "public,max-age=43200"}
        opts["IfMatch" if previous is not None else "IfNoneMatch"] = previous if previous is not None else "*"
        self.client.put_object(**opts)
    def delete(self, key):
        if not publication.owned(key) or len(key.split("/")) == 4: raise ValueError("Protected/outside object deletion refused")
        self.client.delete_object(Bucket=self.bucket, Key=key)

def prepare(store, generation):
    m = json.loads((Path(generation) / "manifest.json").read_text())
    key = f"{publication.PREFIX}{m['dataset']}/manifest.json"
    current = store.get(key, 2 * 1024**2)
    old = json.loads(current[0]) if current else None
    plan = publication.plan(generation, store.listing(), old)
    plan["expectedManifestETag"] = current[1] if current else None
    return plan

def apply(store, plan, retention=False):
    # Recompute exact paths, hashes, current identity and inventory. A modified
    # plan or a competing writer invalidates this concrete review package.
    generation = Path(plan["manifestLast"]["file"]).parent
    actual = prepare(store, generation)
    if actual != plan or not actual["admitted"]: raise ValueError("Publication plan changed or byte admission refused")
    for row in plan["uploads"]:
        path = Path(row["file"])
        if path.is_symlink() or path.stat().st_size != row["bytes"] or hash_file(path) != row["sha256"]: raise ValueError("Staged object changed")
        data = path.read_bytes()
        previous = store.get(row["key"], row["bytes"])
        if previous:
            if hashlib.sha256(previous[0]).hexdigest() != row["sha256"]: raise ValueError("Immutable object conflict")
        else: store.put(row["key"], data, immutable=True)
        verified = store.get(row["key"], row["bytes"])
        if not verified or len(verified[0]) != row["bytes"] or hashlib.sha256(verified[0]).hexdigest() != row["sha256"]: raise ValueError("Uploaded object verification failed; old manifest kept")
    manifest = plan["manifestLast"]
    body = Path(manifest["file"]).read_bytes()
    checked = next(row for row in plan["uploads"] if row["file"] == manifest["file"])
    if len(body) != checked["bytes"] or hashlib.sha256(body).hexdigest() != checked["sha256"]:
        raise ValueError("Staged manifest changed; old manifest kept")
    # Conditional PutObject is atomic on R2, including IfNoneMatch for first publication.
    store.put(manifest["key"], body, previous=plan["expectedManifestETag"])
    live = store.get(manifest["key"], 2 * 1024**2)
    if not live or live[0] != body: raise ValueError("Manifest verification failed; no cleanup")
    if retention:
        for row in plan["deleteCandidatesAfterSuccessfulManifestSwap"]:
            current = store.get(manifest["key"], 2 * 1024**2)
            if not current or current[1] != live[1]: raise ValueError("Manifest changed during cleanup; stopped")
            version = row["key"].split("/")[3]
            if version in plan["protectedGenerations"] or not publication.owned(row["key"]): raise ValueError("Current generation protected")
            store.delete(row["key"])
    return json.loads(body)

def local_retention(root, dataset, protected, apply_delete=False):
    """Exact generated directories only. Never touch inputs, sibling jobs or active generation."""
    base = Path(root).resolve() / dataset
    if dataset not in ("places", "osm", "noaa", "facilities"): raise ValueError("Invalid dataset")
    result = []
    for child in base.iterdir() if base.exists() else []:
        if child.is_symlink() or not child.is_dir() or not re.fullmatch(r"[a-z0-9-]{8,48}", child.name): raise ValueError("Unexpected staging path")
        if child.name in protected: continue
        if not (child / "manifest.json").is_file(): raise ValueError("Not a generated directory")
        result.append(str(child))
    if apply_delete:
        for name in result:
            target = Path(name).resolve()
            if target.parent != base.resolve() or target.name in protected: raise ValueError("Local deletion escaped staging")
            shutil.rmtree(target)
    return result

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__); p.add_argument("--generation", required=True); p.add_argument("--review-plan", required=True); p.add_argument("--apply", action="store_true"); p.add_argument("--plan-sha256"); p.add_argument("--enable-retention", action="store_true")
    a = p.parse_args()
    with exclusive(Path(a.generation).resolve().parents[2]):
        store = R2()
        if a.apply:
            raw = Path(a.review_plan).read_bytes()
            if len(raw) > 64 * 1024**2 or hashlib.sha256(raw).hexdigest() != a.plan_sha256: raise ValueError("Exact reviewed publication plan SHA256 required")
            body = json.loads(raw)
            if Path(body["manifestLast"]["file"]).resolve().parent != Path(a.generation).resolve(): raise ValueError("Review plan targets another generation")
            print(json.dumps(apply(store, body, a.enable_retention)))
            if a.enable_retention:
                local_retention(Path(a.generation).resolve().parents[1], body["dataset"], body["protectedGenerations"], True)
        else:
            body = prepare(store, a.generation)
            body["localDeleteCandidates"] = local_retention(Path(a.generation).resolve().parents[1], body["dataset"], body["protectedGenerations"])
            # Local-only path list is outside the signed remote plan. Store separately.
            local = body.pop("localDeleteCandidates")
            raw = json.dumps(body, sort_keys=True, indent=2).encode()
            Path(a.review_plan).write_bytes(raw)
            print(json.dumps({"apply": False, "reviewPlan": a.review_plan, "sha256": hashlib.sha256(raw).hexdigest(), "localDeleteCandidates": local}))
