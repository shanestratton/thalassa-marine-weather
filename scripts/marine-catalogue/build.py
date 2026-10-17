#!/usr/bin/env python3
"""Build only reviewed local public inputs. No network, cloud credentials or chart-vault access.

Input manifest, hashes and source identities are mandatory. SQLite bounds working RAM;
the global GeoNames TSV is streamed. Output generations are immutable and deterministic.
"""
import argparse
from contextlib import ExitStack, closing
import datetime as dt
import hashlib
import json
import itertools
import math
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unicodedata
from urllib.parse import urlparse

SCHEMA = 1
MAX_SOURCE_BYTES = 8 * 1024**3
MAX_LINE_BYTES = 8 * 1024**2
MAX_RECORDS = 2_000_000
MAX_SHARD_BYTES = 2 * 1024**2
MAX_OUTPUT_BYTES = 2 * 1024**3
BUILD_POLICY = b"marine-v1-area-quadtree8-name24"
OSM_BUILD_POLICY = b"osm-vertex-order-independent-conflict-check1"
LICENCES = {
    "places": "https://creativecommons.org/licenses/by/4.0/",
    "osm": "https://opendatacommons.org/licenses/odbl/1-0/",
    "noaa": "https://charts.noaa.gov/ENCs/ENC_Agreement.shtml",
}
HOSTS = {"places": "download.geonames.org", "osm": "download.geofabrik.de", "noaa": "www.charts.noaa.gov"}
# Excludes inland river/lake/administrative/settlement/obsolete feature codes.
GEONAMES = {"ISL": "island", "ISLS": "island", "ISLET": "island", "BAY": "bay", "BAYS": "bay", "BGHT": "bay", "COVE": "cove", "HBR": "harbour", "HBRX": "harbour", "RF": "reef", "RFC": "reef", "RFX": "reef", "HDLD": "headland", "CAPE": "headland", "PT": "headland", "ANCH": "anchorage"}

def text(v, maximum=200):
    return "".join(c for c in str(v or "") if unicodedata.category(c) != "Cc").strip()[:maximum]

def normalise(value):
    value = "".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.category(c).startswith("M")).lower()
    return " ".join("".join(c if c.isalnum() else " " for c in value).split())

def prefix(value):
    chars = normalise(value).replace(" ", "")[:3]
    return "-".join(f"{ord(c):x}" for c in chars) if len(chars) == 3 else None

def position(lat, lon):
    if isinstance(lat, bool) or isinstance(lon, bool):
        raise ValueError("Invalid position")
    lat, lon = float(lat), float(lon)
    if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90 or abs(lon) > 180:
        raise ValueError("Invalid position")
    return lat, lon

def area(lat, lon):
    return f"{min(89, math.floor((lat + 90) / 2))}_{math.floor(((lon + 180) % 360) / 2)}"

def geonames(line):
    c = line.rstrip("\r\n").split("\t")
    if len(c) != 19:
        raise ValueError("GeoNames requires19 TSV columns")
    if c[7] not in GEONAMES:
        return None
    if not re.fullmatch(r"[1-9]\d{0,11}", c[0]) or not text(c[1]):
        raise ValueError("Invalid GeoNames identity")
    lat, lon = position(c[4], c[5])
    aliases = list(dict.fromkeys(text(n) for n in [c[2], *c[3].split(",")] if text(n) and text(n) != text(c[1])))[:16]
    return {"id": f"geonames:{c[0]}", "name": text(c[1]), "kind": GEONAMES[c[7]], "lat": lat, "lon": lon, "country": c[8] if re.fullmatch(r"[A-Z]{2}", c[8]) else "", "aliases": aliases, "approximate": True}

def geometry_points(geometry, canonical=True):
    """Validated vertices, independent of ring start, direction or export shape."""
    if not geometry:
        raise ValueError("Missing geometry")
    points = []
    def walk(value):
        if isinstance(value, list) and len(value) >= 2 and all(isinstance(n, (int, float)) for n in value[:2]):
            lat, lon = position(value[1], value[0])
            points.append((lat, lon))
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(geometry.get("coordinates"))
    if not points:
        raise ValueError("Missing representative geometry")
    return sorted(set((lat or 0.0, lon or 0.0) for lat, lon in points)) if canonical else points

def geometry_fingerprint(geometry):
    # Osmium emits a closed way as both a line and an area, rotating its ring.
    # We publish only a representative point, but differing vertices must not
    # disappear merely because two shapes happen to have the same midpoint.
    return hashlib.sha256(json.dumps(geometry_points(geometry), separators=(",", ":")).encode()).hexdigest()

def center(geometry, *, order_independent=False):
    """Representative point only; never claims interior/water/anchor-drop position."""
    if geometry and geometry.get("type") == "Point":
        lon, lat = geometry["coordinates"][:2]
        return (*position(lat, lon), False)
    points = geometry_points(geometry, canonical=order_independent)
    # Use one canonical base: ring rotation must not change floating-point
    # normalization. Unwrap a Fiji polygon without moving it to Greenwich.
    base = min(lon for _, lon in points) if order_independent else points[0][1]
    longitudes = [base + ((lon - base + 180) % 360) - 180 for _, lon in points]
    lon = ((min(longitudes) + max(longitudes)) / 2 + 180) % 360 - 180
    return (min(p[0] for p in points) + max(p[0] for p in points)) / 2, lon, True

def osm(feature):
    p = feature.get("properties", {})
    # osmium export --attributes=type,id supplies original @type/@id. Also admit
    # canonical n/w/r IDs, never synthesized osmium area IDs (aNN).
    ident = str(p.get("@id", ""))
    if p.get("@type") in ("node", "way", "relation") and re.fullmatch(r"[1-9]\d{0,15}", ident):
        ident = p["@type"] + ident
    match = re.fullmatch(r"(node|way|relation)[/:]?([1-9]\d{0,15})", ident)
    if not match:
        match = re.fullmatch(r"([nwr])([1-9]\d{0,15})", ident)
        if match:
            typ = {"n": "node", "w": "way", "r": "relation"}[match[1]]
            ident = f"{typ}{match[2]}"
    else:
        ident = f"{match[1]}{match[2]}"
    if not match:
        raise ValueError("Missing stable OSM source ID")
    seamark = p.get("seamark:type")
    anchorage = seamark in ("anchorage", "anchor_berth") or p.get("anchorage") == "yes"
    mooring = p.get("mooring") == "buoy" or p.get("seamark:buoy_special_purpose:category") == "mooring" or (seamark == "mooring" and p.get("seamark:mooring:category", "buoy") == "buoy")
    if not anchorage and not mooring:
        return None  # Protection marks, piles, bollards are not pick-up buoys.
    lat, lon, approximate = center(feature.get("geometry"), order_independent=True)
    restrictions = [f"Reported {key}: {text(p[key], 240)}" for key in ("access", "boat", "anchoring", "access:conditional", "boat:conditional", "anchoring:conditional", "seamark:anchorage:restriction", "seamark:mooring:restriction") if key in p and p[key] not in ("yes", "public", "none", "unrestricted")][:12]
    colours = list(dict.fromkeys(re.split(r"[;,]", text(p.get("seamark:mooring:colour") or p.get("colour")).lower().replace("gray", "grey"))))
    return {"id": f"osm-{ident}", "name": text(p.get("name") or p.get("seamark:name")) or ("Mapped anchorage" if anchorage else "Mapped mooring"), "kind": "anchorage" if anchorage else "mooring", "lat": lat, "lon": lon, "country": "", "aliases": [], "approximate": approximate, "access": text(p.get("access") or p.get("seamark:mooring:access") or p.get("seamark:anchorage:access"), 300) or "Unknown — check permission", "restrictions": restrictions, "colours": [c for c in colours if c in {"blue", "white", "red", "green", "yellow", "orange", "black", "brown", "grey"}]}

def noaa(feature):
    p = feature.get("properties", {})
    if p.get("OBJL") not in ("ACHARE", "ACHBRT", 4, 3) and p.get("class") not in ("ACHARE", "ACHBRT"):
        return None
    # S-57 Long Name is stable across cells; RCID/OBJECTID alone is not.
    ident = str(p.get("LNAM", ""))
    if not re.fullmatch(r"[a-fA-F0-9]{16}", ident):
        raise ValueError("NOAA anchorage needs its original16-hex LNAM")
    lat, lon, _ = center(feature.get("geometry"))
    restrictions = [f"NOAA reported {key}: {text(p[key], 240)}" for key in ("RESTRN", "INFORM", "NINFOM") if p.get(key)][:12]
    return {"id": f"noaa:{ident.upper()}", "name": text(p.get("OBJNAM")) or "NOAA anchorage reference", "kind": "anchorage", "lat": lat, "lon": lon, "country": "", "aliases": [], "approximate": True, "restrictions": restrictions}

def checked_input(spec, base, dataset):
    if set(spec) != {"path", "sourceUrl", "bytes", "sha256"} or Path(spec["path"]).is_absolute() or ".." in Path(spec["path"]).parts or not re.fullmatch(r"[a-f0-9]{64}", spec["sha256"]):
        raise ValueError("Invalid public source descriptor; no secrets / absolute paths")
    url = urlparse(spec["sourceUrl"])
    if url.scheme != "https" or url.hostname != HOSTS[dataset] or url.username or url.password or url.query or url.fragment:
        raise ValueError("Refused non-whitelisted public source URL")
    candidate = base / spec["path"]
    source = candidate.resolve()
    if base.resolve() not in source.parents or candidate.is_symlink() or not source.is_file():
        raise ValueError("Inputs must be regular files inside the approved input directory")
    if source.stat().st_size > MAX_SOURCE_BYTES or source.stat().st_size != spec["bytes"]:
        raise ValueError("Source byte count mismatch / source too large")
    with source.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != spec["sha256"]:
        raise ValueError("Source SHA256 mismatch")
    return source

def build(input_manifest, output):
    input_manifest = Path(input_manifest).resolve()
    if input_manifest.stat().st_size > 65536:
        raise ValueError("Input manifest too large")
    raw = input_manifest.read_bytes()
    spec = json.loads(raw)
    if set(spec) != {"schema", "dataset", "licence", "coverage", "sourceAt", "inputs"}:
        raise ValueError("Unexpected input metadata; nothing private may be published")
    dataset = spec["dataset"]
    if dataset not in LICENCES or spec.get("licence") != LICENCES[dataset] or spec.get("schema") != 1:
        raise ValueError("Dataset / licence not approved")
    if not spec.get("coverage") or len(spec["coverage"]) > 300 or not 1 <= len(spec["inputs"]) <= 32:
        raise ValueError("Missing coverage / too many source files")
    now = dt.datetime.now(dt.timezone.utc)
    source_at = dt.datetime.fromisoformat(spec["sourceAt"].replace("Z", "+00:00"))
    if source_at.tzinfo is None or source_at > now + dt.timedelta(minutes=5) or source_at < now - dt.timedelta(days=45):
        raise ValueError("Old/future source snapshot; review before monthly publication")
    sources = [checked_input(s, input_manifest.parent, dataset) for s in spec["inputs"]]
    policy = BUILD_POLICY + (b"\0" + OSM_BUILD_POLICY if dataset == "osm" else b"")
    generation = now.strftime("%Y%m") + "-" + hashlib.sha256(raw + b"\0" + policy).hexdigest()[:16]
    root = Path(output).resolve() / dataset
    root.mkdir(parents=True, exist_ok=True)
    destination = root / generation
    if destination.exists():
        return destination  # Whole immutable generation is reused.
    with tempfile.TemporaryDirectory(prefix=".build-", dir=root) as temporary, ExitStack() as resources:
        stage = Path(temporary)
        database = resources.enter_context(closing(sqlite3.connect(stage / "work.sqlite")))
        database.execute("PRAGMA cache_size=-16384")
        database.execute("PRAGMA max_page_count=524288")  #2GiB scratch database, independent of free disk.
        database.execute("CREATE TABLE records (id TEXT PRIMARY KEY, area TEXT, lat REAL, lon REAL, json TEXT)")
        database.execute("CREATE TABLE osm_geometry (id TEXT PRIMARY KEY, sha TEXT)")
        database.execute("CREATE TABLE names (value TEXT, id TEXT, PRIMARY KEY(value,id))")
        database.execute("CREATE INDEX record_areas ON records(area,lat,lon)")
        admitted = 0
        for source in sources:
            with source.open("rb") as stream:
                for raw_line in iter(lambda: stream.readline(MAX_LINE_BYTES + 1), b""):
                    if len(raw_line) > MAX_LINE_BYTES:
                        raise ValueError("Oversized source feature / TSV row")
                    if not raw_line.strip():
                        continue
                    line = raw_line.decode("utf-8")
                    feature = None if dataset == "places" else json.loads(line)
                    record = geonames(line) if dataset == "places" else (osm if dataset == "osm" else noaa)(feature)
                    if record is None:
                        continue
                    encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
                    geometry_sha = geometry_fingerprint(feature.get("geometry")) if dataset == "osm" else None
                    indexed_lon = (record["lon"] + 180) % 360 - 180
                    indexed_area = area(record["lat"], record["lon"])
                    inserted = database.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)", (record["id"], indexed_area, record["lat"], indexed_lon, encoded))
                    admitted += inserted.rowcount
                    if admitted > MAX_RECORDS: raise ValueError("Admitted record cap exceeded")
                    if inserted.rowcount == 0:
                        if dataset == "osm":
                            previous = database.execute("SELECT r.json,g.sha FROM records r JOIN osm_geometry g ON g.id=r.id WHERE r.id=?", (record["id"],)).fetchone()
                            if previous != (encoded, geometry_sha):
                                raise ValueError("Conflicting OSM source ID: " + record["id"])
                        else:
                            # NOAA input order is reviewed: latest/highest-detail cell last.
                            database.execute("UPDATE records SET area=?,lat=?,lon=?,json=? WHERE id=?", (indexed_area, record["lat"], indexed_lon, encoded, record["id"]))
                    elif dataset == "osm":
                        database.execute("INSERT INTO osm_geometry VALUES(?,?)", (record["id"], geometry_sha))
                    if dataset == "places":
                        for name in [record["name"], *record["aliases"]]:
                            value = normalise(name).replace(" ", "")
                            if len(value) >= 3:
                                database.execute("INSERT OR IGNORE INTO names VALUES(?,?)", (value, record["id"]))
        count = database.execute("SELECT count(*) FROM records").fetchone()[0]
        if not 1 <= count <= MAX_RECORDS:
            raise ValueError("Empty / oversized build; old manifest must remain active")
        database.commit()
        total, shard_keys = 0, []
        class DenseShard(ValueError):
            pass

        def write_shard(key, query, args):
            nonlocal total
            records = [json.loads(row[0]) for row in itertools.islice(database.execute(query, args), 10001)]
            if len(records) > 10000:
                raise DenseShard(f"Too many records in {key}; no truncation")
            body = json.dumps({"schema": 1, "dataset": dataset, "generation": generation, "key": key, "records": records}, ensure_ascii=False, separators=(",", ":")).encode()
            if len(body) > MAX_SHARD_BYTES:
                raise DenseShard(f"Shard byte cap exceeded: {key}; no truncation")
            if total + len(body) > MAX_OUTPUT_BYTES:
                raise ValueError(f"Output cap exceeded: {key}; no truncation")
            total += len(body)
            path = stage / (key + ".json")
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(body)
            shard_keys.append(key)
        def area_group(base, south, west, width=2, quadrants=""):
            north, east = south + width, west + width
            where = f"area=? AND lat>=? AND lat{'<=' if north == 90 else '<'}? AND lon>=? AND lon<?"
            args = (base, south, north, west, east)
            if not database.execute("SELECT 1 FROM records WHERE " + where + " LIMIT 1", args).fetchone():
                return
            key = "areas/" + base + ("-" + quadrants if quadrants else "")
            try:
                write_shard(key, "SELECT json FROM records WHERE " + where + " ORDER BY id", args)
            except DenseShard:
                if len(quadrants) >= 8:
                    raise ValueError("Dense exact location exceeds cap; review before publishing")
                half = width / 2
                for child in range(4):
                    area_group(
                        base,
                        south + (half if child & 2 else 0),
                        west + (half if child & 1 else 0),
                        half,
                        quadrants + str(child),
                    )
        for key, in database.execute("SELECT DISTINCT area FROM records ORDER BY area").fetchall():
            row, column = map(int, key.split("_"))
            area_group(key, row * 2 - 90, column * 2 - 180)
        if dataset == "places":
            def names_group(value):
                query = "SELECT r.json FROM records r JOIN (SELECT DISTINCT id FROM names WHERE value>=? AND value<? LIMIT 10001) n ON n.id=r.id ORDER BY r.id"
                args = (value, value + chr(0x10ffff))
                rows = list(database.execute(query, args))
                key = "-".join(f"{ord(c):x}" for c in value)
                if len(rows) <= 10000 and len(json.dumps([json.loads(row[0]) for row in rows], ensure_ascii=False).encode()) < MAX_SHARD_BYTES - 512:
                    write_shard("names/" + key, query, args)
                    return
                if len(value) >= 24: raise ValueError("Dense exact name group exceeds cap; review before publishing")
                terminal = "SELECT r.json FROM records r JOIN names n ON n.id=r.id WHERE n.value=? ORDER BY r.id"
                if database.execute("SELECT 1 FROM names WHERE value=? LIMIT 1", (value,)).fetchone():
                    write_shard("names/" + key + "-end", terminal, (value,))
                children = database.execute("SELECT DISTINCT substr(value,1,?) FROM names WHERE value>=? AND value<? AND length(value)>? ORDER BY 1", (len(value) + 1, *args, len(value))).fetchall()
                for child, in children: names_group(child)
            for value, in database.execute("SELECT DISTINCT substr(value,1,3) FROM names WHERE length(value)>=3 ORDER BY 1").fetchall():
                names_group(value)
        database.close()
        (stage / "work.sqlite").unlink()
        manifest = {"schema": 1, "dataset": dataset, "generation": generation, "builtAt": now.isoformat(), "sourceAt": spec["sourceAt"], "count": count, "coverage": spec["coverage"], "licence": LICENCES[dataset], "sourceUrl": spec["inputs"][0]["sourceUrl"], "shards": sorted(shard_keys)}
        if dataset == "noaa":
            agreement = Path(__file__).resolve().parents[2] / "public" / "data" / "noaa-enc-user-agreement.txt"
            manifest["agreementSha256"] = hashlib.sha256(agreement.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n").encode()).hexdigest()
        manifest_bytes = json.dumps(manifest, ensure_ascii=False).encode()
        if len(shard_keys) > 50000 or len(manifest_bytes) > MAX_SHARD_BYTES: raise ValueError("Manifest inventory exceeds cap")
        (stage / "manifest.json").write_bytes(manifest_bytes)
        (stage / "SOURCE.json").write_bytes(raw)
        if dataset == "noaa":
            agreement = Path(__file__).resolve().parents[2] / "public" / "data" / "noaa-enc-user-agreement.txt"
            (stage / "NOAA-AGREEMENT.txt").write_bytes(agreement.read_bytes())
        if dataset == "osm":
            (stage / "LICENCE.txt").write_text("© OpenStreetMap contributors. This adapted database is offered under ODbL1.0.\n" + LICENCES[dataset] + "\nThe complete adapted database is this generation's area shards (names remain separate GeoNames data).\n", encoding="utf-8")
        os.replace(stage, destination)
    return destination

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-manifest", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(build(args.input_manifest, args.output))
