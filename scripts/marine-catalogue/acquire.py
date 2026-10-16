#!/usr/bin/env python3
"""Reviewed, bounded public-source acquisition. Dry-run by default; no credentials.

Plan sources: {url,format,maxBytes,maxExpandedBytes}; formats geonames-zip,
osm-pbf, noaa-zip. At most8 sources; 128GiB transport /24GiB expansion per run.
Small AU plan is default staging material; world plan needs its own review.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from urllib.parse import urlparse
import build

LIMIT = 24 * 1024**3
TRANSPORT_LIMIT = 128 * 1024**3
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError("Source redirect refused")

def validate(plan):
    if set(plan) != {"schema", "dataset", "coverage", "sources"} or plan["schema"] != 1 or plan["dataset"] not in build.LICENCES or not isinstance(plan["coverage"], str) or not 1 <= len(plan["coverage"]) <= 300 or not 1 <= len(plan["sources"]) <= 8:
        raise ValueError("Invalid acquisition plan")
    expected = {"places": "geonames-zip", "osm": "osm-pbf", "noaa": "noaa-zip"}[plan["dataset"]]
    for s in plan["sources"]:
        if set(s) != {"url", "format", "maxBytes", "maxExpandedBytes"}:
            raise ValueError("Unexpected source plan fields")
        u = urlparse(s["url"])
        paths = {"places": r"/export/dump/(?:allCountries|[A-Z]{2})\.zip", "osm": r"/[a-z0-9/_-]+-latest\.osm\.pbf", "noaa": r"/ENCs/(?:All_ENCs|US[A-Z0-9]+)\.zip"}
        if u.scheme != "https" or u.hostname != build.HOSTS[plan["dataset"]] or u.query or u.fragment or u.username or u.password or not re.fullmatch(paths[plan["dataset"]], u.path) or s["format"] != expected:
            raise ValueError("Source host/path/format refused")
        if any(type(s[k]) is not int or s[k] <= 0 or s[k] > (64 * 1024**3 if k == "maxBytes" else LIMIT) for k in ("maxBytes", "maxExpandedBytes")):
            raise ValueError("Invalid source byte cap")
    if sum(s["maxBytes"] for s in plan["sources"]) > TRANSPORT_LIMIT or sum(s["maxExpandedBytes"] for s in plan["sources"]) > LIMIT:
        raise ValueError("Whole acquisition exceeds transport/expansion cap")
    return plan

def verify_noaa_agreement(opener=None):
    opener = opener or urllib.request.build_opener(NoRedirect())
    url = "https://charts.noaa.gov/ENCs/ENC_Agreement.shtml"
    with opener.open(url, timeout=30) as response:
        if response.geturl() != url: raise ValueError("NOAA agreement redirect refused")
        body = response.read(65537)
    expected = Path(__file__).with_name("noaa-agreement-html.sha256").read_text().strip()
    if len(body) > 65536 or hashlib.sha256(body).hexdigest() != expected:
        raise ValueError("NOAA agreement changed: review source terms and app acceptance version before publication")

def download(source, target, opener=None):
    opener = opener or urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(source["url"], headers={"User-Agent": "ThalassaPublicCatalogue/135", "Accept-Encoding": "identity"})
    deadline, total = time.monotonic() + 3600, 0
    digest = hashlib.sha256()
    try:
        with opener.open(request, timeout=30) as response, target.open("wb") as output:
            if response.geturl() != source["url"] or response.headers.get("Content-Encoding", "identity") != "identity" or int(response.headers.get("Content-Length", "0")) > source["maxBytes"]:
                raise ValueError("Changed/oversized source")
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > source["maxBytes"] or time.monotonic() > deadline:
                    raise ValueError("Source byte/time cap exceeded")
                digest.update(chunk); output.write(chunk)
        if not total:
            raise ValueError("Empty source")
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return {"sourceUrl": source["url"], "bytes": total, "sha256": digest.hexdigest()}

def extract_zip(source, target, cap, noaa=False):
    total, files = 0, []
    with zipfile.ZipFile(source) as archive:
        if len(archive.infolist()) > 20000:
            raise ValueError("Too many ZIP members")
        for entry in archive.infolist():
            path = Path(entry.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in entry.filename or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("ZIP traversal/symlink refused")
            if entry.is_dir(): continue
            total += entry.file_size
            if total > cap or entry.file_size > cap:
                raise ValueError("Expanded source exceeds cap")
            # NOAA's ancillary public cells stay in local staging only; output
            # extraction is strictly ACHARE/ACHBRT. No user chart input accepted.
            if not noaa and path.name != source.stem + ".txt": continue
            dest = target / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            actual = 0
            with archive.open(entry) as inp, dest.open("wb") as out:
                while chunk := inp.read(1024 * 1024):
                    actual += len(chunk)
                    if actual > entry.file_size or actual > cap: raise ValueError("ZIP expansion mismatch")
                    out.write(chunk)
            if actual != entry.file_size: raise ValueError("Truncated ZIP member")
            files.append(dest)
    return files

def convert_sequence(source, target, maximum):
    total = 0
    with source.open("rb") as inp, target.open("wb") as out:
        for line in iter(lambda: inp.readline(build.MAX_LINE_BYTES + 1), b""):
            if len(line) > build.MAX_LINE_BYTES: raise ValueError("Oversize public feature")
            line = line.lstrip(b"\x1e").strip()
            if not line: continue
            json.loads(line)
            total += len(line) + 1
            if total > maximum: raise ValueError("Feature export exceeds cap")
            out.write(line + b"\n")

def extract_noaa_cells(cells, output, maximum, driver=None):
    # Missing object classes are valid empty cells, not failed extractions.
    # Any actual S57/read error aborts the whole generation.
    if driver is None:
        from osgeo import gdal
        gdal.UseExceptions()
        driver = gdal
    with output.open("wb") as combined:
        for cell in cells:
            dataset = driver.OpenEx(str(cell), driver.OF_VECTOR, allowed_drivers=["S57"], open_options=["LNAM_REFS=ON"])
            if dataset is None: raise ValueError("NOAA S57 cell could not be read")
            for cls in ("ACHARE", "ACHBRT"):
                layer = dataset.GetLayerByName(cls)
                if layer is None: continue
                count = 0
                for feature in layer:
                    raw = feature.ExportToJson()
                    if len(raw.encode()) > build.MAX_LINE_BYTES: raise ValueError("NOAA feature too large")
                    f = json.loads(raw); f.setdefault("properties", {})["class"] = cls
                    combined.write(json.dumps(f, separators=(",", ":")).encode() + b"\n")
                    count += 1
                    if count > 10000 or combined.tell() > maximum: raise ValueError("NOAA export exceeds cap")
            dataset = None

def run_osmium(arguments, maximum):
    # wx is Linux. Bound intermediate files in the child before osmium starts,
    # not only after a potentially large export has consumed the disk.
    def file_limit():
        import resource
        _, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
        soft = maximum if hard == resource.RLIM_INFINITY else min(maximum, hard)
        resource.setrlimit(resource.RLIMIT_FSIZE, (soft, hard))
    subprocess.run(["osmium", *arguments], check=True, timeout=7200,
                   preexec_fn=file_limit if os.name == "posix" else None)

def acquire(plan, directory):
    validate(plan)
    if plan["dataset"] == "noaa":
        raise ValueError("NOAA inputs must come from the official catalogue job's ACTIVE-only immutable source directory; independent All_ENCs acquisition is disabled")
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()[:16]
    destination = directory / (dt.datetime.now(dt.timezone.utc).strftime("%Y%m") + "-" + fingerprint)
    if destination.is_symlink(): raise ValueError("Acquisition path cannot be a symlink")
    if destination.exists():
        source = destination / "input.json"
        if not source.is_file() or source.is_symlink(): raise ValueError("Incomplete acquisition snapshot")
        return source
    # Includes raw source, two bounded osmium intermediates, final extracted
    # inputs and output/SQLite reserve. A reviewed filesystem quota remains required.
    if shutil.disk_usage(directory).free < sum(s["maxBytes"] + 3 * s["maxExpandedBytes"] for s in plan["sources"]) + 4 * 1024**3:
        raise ValueError("Insufficient quota/disk headroom")
    with tempfile.TemporaryDirectory(prefix=".acquire-", dir=directory) as tmp:
        stage = Path(tmp); inputs, receipts = [], []
        for index, source in enumerate(plan["sources"]):
            work = stage / f"source-{index}"; work.mkdir()
            raw = work / Path(urlparse(source["url"]).path).name
            receipts.append(download(source, raw))
            output = stage / f"public-{index}.jsonl"
            if source["format"] == "geonames-zip":
                files = extract_zip(raw, work, source["maxExpandedBytes"])
                if len(files) != 1: raise ValueError("Missing GeoNames TSV")
                output = stage / f"public-{index}.txt"; shutil.move(files[0], output)
            elif source["format"] == "osm-pbf":
                filtered, sequence = work / "marine.osm.pbf", work / "marine.geojsonseq"
                run_osmium(["tags-filter", str(raw), "nwr/seamark:type=anchorage,anchor_berth,mooring", "nwr/mooring=buoy", "nwr/seamark:buoy_special_purpose:category=mooring", "nwr/anchorage=yes", "-o", str(filtered)], source["maxExpandedBytes"])
                if filtered.stat().st_size > source["maxExpandedBytes"]: raise ValueError("Filtered OSM file exceeds cap")
                run_osmium(["export", str(filtered), "--attributes=type,id", "-f", "geojsonseq", "-o", str(sequence)], source["maxExpandedBytes"])
                if sequence.stat().st_size > source["maxExpandedBytes"]: raise ValueError("OSM sequence exceeds cap")
                convert_sequence(sequence, output, source["maxExpandedBytes"])
            else:
                files = extract_zip(raw, work, source["maxExpandedBytes"], noaa=True)
                cells = sorted(p for p in files if p.suffix == ".000")
                if not cells: raise ValueError("No NOAA base cells")
                extract_noaa_cells(cells, output, source["maxExpandedBytes"])
            if output.stat().st_size > min(source["maxExpandedBytes"], build.MAX_SOURCE_BYTES): raise ValueError("Export exceeds admitted input cap")
            with output.open("rb") as stream: sha = hashlib.file_digest(stream, "sha256").hexdigest()
            inputs.append({"path": output.name, "sourceUrl": source["url"], "bytes": output.stat().st_size, "sha256": sha})
            shutil.rmtree(work)
        manifest = {"schema": 1, "dataset": plan["dataset"], "coverage": plan["coverage"], "licence": build.LICENCES[plan["dataset"]], "sourceAt": dt.datetime.now(dt.timezone.utc).isoformat(), "inputs": inputs}
        (stage / "input.json").write_text(json.dumps(manifest), encoding="utf-8")
        (stage / "transport-receipts.json").write_text(json.dumps(receipts), encoding="utf-8")
        os.replace(stage, destination)
    return destination / "input.json"

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__); p.add_argument("--plan", required=True); p.add_argument("--directory", required=True); p.add_argument("--execute", action="store_true"); p.add_argument("--plan-sha256")
    a = p.parse_args(); raw = Path(a.plan).read_bytes()
    if len(raw) > 65536: raise ValueError("Plan too large")
    spec = validate(json.loads(raw)); digest = hashlib.sha256(raw).hexdigest()
    if a.execute:
        if a.plan_sha256 != digest: raise ValueError("Exact reviewed plan SHA256 required")
        print(acquire(spec, a.directory))
    else: print(json.dumps({"execute": False, "sha256": digest, "plan": spec}, indent=2))
