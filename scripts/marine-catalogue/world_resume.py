#!/usr/bin/env python3
"""World-only crash checkpoints. No publication, installation or implicit recovery.

The caller holds the existing catalogue OS lock. A second per-state OS lock
also protects direct/controller use. All writes stay in the selected owned
catalogue tree. Incomplete transport without durable completeness proof holds.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
import urllib.request
from contextlib import contextmanager
import acquire
import build
import world_policy

META_CAP = 1024 * 1024
STATE_CAP = 65536
SHA = re.compile(r"[a-f0-9]{64}")


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clock(value):
    result = build.source_time(value)
    if result < dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=45):
        raise ValueError("World source clock expired; no resumed publication")
    return value


def sync_directory(path):
    if os.name == "posix":
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def require_regular(path, maximum):
    if path.is_symlink() or not path.is_file():
        raise ValueError("Expected an owned regular file")
    value = path.stat()
    if value.st_size > maximum:
        raise ValueError("Owned file exceeds byte cap")
    return value


def stamp(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def descriptor(path, maximum):
    before = require_regular(path, maximum)
    sha = hashlib.sha256(); total = 0; deadline = time.monotonic() + 600
    with path.open("rb") as stream:
        while chunk := stream.read(1024**2):
            total += len(chunk)
            if total > maximum or time.monotonic() > deadline:
                raise ValueError("Original hash byte/time bound")
            sha.update(chunk)
    if stamp(before) != stamp(require_regular(path, maximum)):
        raise ValueError("Original changed while hashing")
    return {"bytes": before.st_size, "sha256": sha.hexdigest()}


def read_json(path, maximum=STATE_CAP):
    require_regular(path, maximum)
    with path.open("rb") as stream:
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("Metadata byte cap")
    return json.loads(raw)


def atomic(path, value, maximum=STATE_CAP):
    raw = encoded(value)
    if len(raw) > maximum:
        raise ValueError("Metadata byte cap")
    pending = path.with_name(path.name + ".pending")
    for candidate in (path, pending):
        if candidate.exists() or candidate.is_symlink():
            require_regular(candidate, maximum)
    # Only this fixed owned transaction filename may be replaced after a crash.
    # Unlink a stale transaction link, never truncate a possibly hardlinked
    # external inode. The lock excludes another legitimate writer.
    pending.unlink(missing_ok=True)
    with pending.open("xb") as output:
        os.chmod(pending, 0o600)
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    os.replace(pending, path)
    sync_directory(path.parent)


def directory(path):
    if path.is_symlink():
        raise ValueError("Owned directory cannot be a symlink")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir():
        raise ValueError("Expected owned directory")
    if os.name == "posix" and path.stat().st_mode & 0o022:
        raise ValueError("Owned state directory cannot be group/other writable")


def root_namespace(path):
    if os.name == "posix":
        for parent in [path, *path.parents]:
            info = parent.lstat()
            if info.st_uid != 0 or (not parent.is_symlink() and info.st_mode & 0o022):
                raise ValueError("Native namespace must be root-owned and read-only to the job")


@contextmanager
def state_lock(path):
    import fcntl
    if path.is_symlink():
        raise ValueError("Resume lock cannot be a symlink")
    with path.open("a") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


class Runtime:
    """Exact operator-reviewed executable/dependency set; no provider choices."""
    def __init__(self, policy_path, expected):
        if not isinstance(expected, str) or not SHA.fullmatch(expected):
            raise ValueError("Reviewed world runtime policy SHA256 required")
        policy_path = Path(policy_path)
        policy_stamp = stamp(require_regular(policy_path, META_CAP))
        with policy_path.open("rb") as stream:
            raw = stream.read(META_CAP + 1)
        if len(raw) > META_CAP:
            raise ValueError("World runtime metadata cap")
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError("World runtime policy changed")
        if stamp(require_regular(policy_path, META_CAP)) != policy_stamp:
            raise ValueError("World runtime policy changed while reading")
        policy = json.loads(raw)
        if set(policy) != {"schema", "executable", "files", "bindings", "libraryPath"} or policy["schema"] != 1:
            raise ValueError("World runtime policy shape")
        self.executable = Path(policy["executable"])
        if not self.executable.is_absolute() or self.executable.name != "osmium" or not str(self.executable).startswith("/opt/"):
            raise ValueError("Reviewed canonical osmium executable required")
        if not isinstance(policy["files"], list) or not 1 <= len(policy["files"]) <= 64:
            raise ValueError("World runtime file inventory cap")
        self.snapshots = []
        seen = set()
        runtime_bytes = 0
        for row in policy["files"]:
            if set(row) != {"path", "bytes", "sha256"} or not isinstance(row["path"], str) or not isinstance(row["sha256"], str) or not SHA.fullmatch(row["sha256"]):
                raise ValueError("World runtime file descriptor")
            path = Path(row["path"])
            if not path.is_absolute() or str(path) in seen or ".." in path.parts:
                raise ValueError("World runtime file path")
            seen.add(str(path))
            info = require_regular(path, 256 * 1024**2)
            runtime_bytes += info.st_size
            if runtime_bytes > 256 * 1024**2:
                raise ValueError("World native aggregate byte cap")
            if type(row["bytes"]) is not int or info.st_size != row["bytes"] or descriptor(path, 256 * 1024**2) != {"bytes": row["bytes"], "sha256": row["sha256"]}:
                raise ValueError("World runtime original changed")
            if os.name == "posix" and (info.st_uid != 0 or info.st_mode & 0o022):
                raise ValueError("World runtime must be root-owned read-only to the job")
            root_namespace(path)
            self.snapshots.append((path, stamp(info)))
        if str(self.executable) not in seen:
            raise ValueError("Executable absent from reviewed runtime inventory")
        self.snapshots.append((policy_path, policy_stamp))
        self.bindings = []
        if not isinstance(policy["bindings"], list) or len(policy["bindings"]) > 128:
            raise ValueError("World native link inventory cap")
        aliases = set()
        for row in policy["bindings"]:
            if not isinstance(row, dict) or set(row) != {"path", "target"} or not all(isinstance(row[k], str) for k in row):
                raise ValueError("World native link binding shape")
            path, target = Path(row["path"]), Path(row["target"])
            if not path.is_absolute() or ".." in path.parts or str(path) in aliases or str(target) not in seen or path.resolve(strict=True) != target:
                raise ValueError("World native link binding changed")
            root_namespace(path)
            aliases.add(str(path)); self.bindings.append((path, target))
        if {str(target) for _, target in self.bindings} != seen - {str(self.executable)}:
            raise ValueError("Every native dependency needs its actual loader binding")
        library = policy["libraryPath"]
        if not isinstance(library, str) or len(library) > 4096:
            raise ValueError("World library path cap")
        for value in library.split(":") if library else []:
            p = Path(value)
            if not p.is_absolute() or not str(p).startswith("/opt/") or ".." in p.parts or p.is_symlink() or not p.is_dir():
                raise ValueError("World private library directory")
            if os.name == "posix" and (p.stat().st_uid != 0 or p.stat().st_mode & 0o022):
                raise ValueError("World library directory must be read-only to the job")
        self.environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "OSMIUM_POOL_THREADS": "2", **{"OSMIUM_MAX_" + key + "_QUEUE_SIZE": "2" for key in ("INPUT", "OSMDATA", "OUTPUT", "WORK")}}
        if library:
            self.environment["LD_LIBRARY_PATH"] = library
        self.identity = expected

    def current(self):
        if any(path.is_symlink() or stamp(path.stat()) != original for path, original in self.snapshots):
            raise ValueError("World native runtime retired")
        for path, target in self.bindings:
            root_namespace(path)
            if path.resolve(strict=True) != target:
                raise ValueError("World native loader binding retired")

    def run(self, arguments, maximum, *, stdout=None, timeout=7200):
        self.current()
        def limits():
            import resource
            _, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
            resource.setrlimit(resource.RLIMIT_FSIZE, (maximum if hard == resource.RLIM_INFINITY else min(maximum, hard), hard))
        # osmium dispatches from argv0. Do not let a diagnostic executable
        # basename silently become an osmium subcommand.
        child = subprocess.Popen(["osmium", *arguments], executable=str(self.executable), env=self.environment,
                                 stdin=subprocess.DEVNULL, stdout=stdout, close_fds=True, start_new_session=True, preexec_fn=limits if os.name == "posix" else None)
        try:
            status = child.wait(timeout=timeout)
            if status:
                raise subprocess.CalledProcessError(status, arguments)
        except BaseException:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise
        self.current()

    def source_clock(self, raw, root):
        target = root / "source-clock.txt"
        if target.exists() or target.is_symlink():
            require_regular(target, 4096)
        with target.open("wb") as output:
            self.run(["fileinfo", "--no-progress", "--get", "header.option.osmosis_replication_timestamp", str(raw)], 4096, stdout=output, timeout=30)
        require_regular(target, 4096)
        return clock(target.read_text(encoding="utf-8").strip())


class WorldResume:
    def __init__(self, plan, input_directory, runtime, recoveries=None):
        acquire.validate(plan)
        if plan["dataset"] != "facilities-world":
            raise ValueError("World-only resume controller")
        self.plan = json.loads(encoded(plan))
        self.plan_id = digest(self.plan)
        self.runtime = runtime
        proposed = Path(input_directory).absolute()
        if any(path.is_symlink() for path in [proposed, *proposed.parents]):
            raise ValueError("World input namespace cannot traverse a symlink")
        self.inputs = proposed.resolve()
        directory(self.inputs)
        self.container = self.inputs.parent / ".facilities-world-resume"
        directory(self.container)
        self.name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m") + "-" + self.plan_id[:16]
        self.root = self.container / self.name
        for path in self.container.iterdir():
            if path.name == "resume.lock":
                require_regular(path, 4096)
            elif path.is_symlink() or not path.is_dir() or not re.fullmatch(r"\d{6}-[a-f0-9]{16}", path.name):
                raise ValueError("Unexpected resume state path")
        existing = [p for p in self.container.iterdir() if p.is_dir()]
        if not self.root.exists() and len(existing) >= 2:
            raise ValueError("Resume history cap; review completed metadata retention")
        if any(p != self.root and not (p / "promoted.json").is_file() for p in existing):
            raise ValueError("Another unfinished world cohort requires review")
        directory(self.root)
        self.recoveries = recoveries or {}
        self.source_files = {name: descriptor(Path(__file__).with_name(name), META_CAP) for name in ("world_resume.py", "acquire.py", "world_policy.py", "build.py", "monthly.py")}

    def current(self):
        self.runtime.current()
        if any(descriptor(Path(__file__).with_name(name), META_CAP) != value for name, value in self.source_files.items()):
            raise ValueError("World controller source retired")

    def inventory(self):
        names = {"job.json", "transfers.json", "input.json", "transport-receipts.json", "source-clock.txt", "promoted.json"}
        for index in range(8):
            names |= {f"raw-{index}.json", f"cohort-{index}.json", f"incoming-{index}.osm.pbf", f"raw-{index}.osm.pbf", f"marine-{index}.osm.pbf", f"sequence-{index}.geojsonseq", f"public-{index}.jsonl"}
        original_count = 0
        for path in self.root.iterdir():
            base = path.name.removesuffix(".pending")
            if base not in names or (path.name.endswith(".pending") and not base.endswith(".json")):
                raise ValueError("Unexpected file in owned world resume state")
            match = re.fullmatch(r"(raw|incoming|marine|sequence|public)-(\d)\.(?:osm\.pbf|geojsonseq|jsonl)", base)
            cap = STATE_CAP
            if match:
                source = self.plan["sources"][int(match[2])]
                cap = source["maxBytes"] if match[1] in ("raw", "incoming") else source["maxExpandedBytes"]
                original_count += int(match[1] in ("raw", "incoming"))
            elif base == "source-clock.txt":
                cap = 4096
            require_regular(path, cap)
        # Execution is serial. A second large original cannot have been
        # produced by this state machine and cannot borrow its disk envelope.
        if original_count > 1:
            raise ValueError("Unexpected simultaneous world originals")

    def input_admission(self):
        rows = list(self.inputs.iterdir())
        for path in rows:
            if path.is_symlink() or not path.is_dir() or not re.fullmatch(r"\d{6}-[a-f0-9]{16}", path.name):
                raise ValueError("Unexpected input path; legacy partials require explicit quarantine")
            total = 0
            for file in path.iterdir():
                if not re.fullmatch(r"public-[0-7]\.jsonl|input\.json|transport-receipts\.json|(?:input|transport-receipts)\.json\.pending", file.name):
                    raise ValueError("Unexpected source snapshot file")
                total += require_regular(file, build.MAX_SOURCE_BYTES if file.suffix == ".jsonl" else STATE_CAP).st_size
            if total > acquire.LIMIT:
                raise ValueError("World input snapshot exceeds unchanged24GiB cap")
        if len(rows) > 2 or (len(rows) == 2 and not any(p.name == self.name for p in rows)):
            raise ValueError("World input snapshot cap; review retention")

    def valid_raw(self, index, receipt):
        source = self.plan["sources"][index]
        if not isinstance(receipt, dict) or set(receipt) != {"schema", "sourceUrl", "original", "sourceAt", "provenance"} or receipt["schema"] != 1 or receipt["sourceUrl"] != source["url"]:
            raise ValueError("Raw cohort receipt scope changed")
        value = receipt["original"]
        if not isinstance(value, dict) or set(value) != {"bytes", "sha256"} or type(value["bytes"]) is not int or not 0 < value["bytes"] <= source["maxBytes"] or not isinstance(value["sha256"], str) or not SHA.fullmatch(value["sha256"]):
            raise ValueError("Raw original descriptor corrupt")
        clock(receipt["sourceAt"])
        proof = receipt["provenance"]
        if not isinstance(proof, dict):
            raise ValueError("Raw provenance unavailable")
        completed = build.source_time(proof.get("completionObservedAt"))
        if proof.get("kind") == "reviewed-preserved-original":
            if set(proof) != {"kind", "reviewedAt", "reviewReceiptSha256", "completionObservedAt"}:
                raise ValueError("Recovery cannot invent HTTP/fetched clocks")
            expected = self.recoveries.get(source["url"])
            if not expected or any(proof[k] != expected[k] for k in ("reviewedAt", "reviewReceiptSha256")) or value != {k: expected[k] for k in ("bytes", "sha256")}:
                raise ValueError("Recovery no longer matches exact reviewed original")
            if build.source_time(proof["reviewedAt"]) > completed:
                raise ValueError("Recovery receipt chronology changed")
        elif proof.get("kind") in ("http-original", "completed-http-stream-recovered"):
            if set(proof) != {"kind", "headers", "startedAt", "completionObservedAt"}:
                raise ValueError("Original HTTP receipt fields changed")
            header = proof["headers"]
            if not isinstance(header, dict) or set(header) != {"sourceUrl", "contentLength", "etag", "lastModified", "headersObservedAt"} or header["sourceUrl"] != source["url"]:
                raise ValueError("Original HTTP header scope changed")
            length = header["contentLength"]
            if length is not None and (type(length) is not int or length != value["bytes"]):
                raise ValueError("Original HTTP completeness changed")
            if proof["kind"] == "completed-http-stream-recovered" and length is None:
                raise ValueError("Recovered HTTP stream lost its known original length")
            for name in ("etag", "lastModified"):
                text = header[name]
                if text is not None and (not isinstance(text, str) or len(text) > 1024 or any(ord(c) < 32 for c in text)):
                    raise ValueError("HTTP receipt header cap")
            started, observed = build.source_time(proof["startedAt"]), build.source_time(header["headersObservedAt"])
            if not started <= observed <= completed:
                raise ValueError("Original HTTP receipt chronology changed")
            transfers = self.transfers()
            matching = [a for a in transfers.get("attempts", []) if a.get("index") == index] if isinstance(transfers, dict) else []
            if len(matching) != 1 or matching[0].get("headers") != header or matching[0].get("startedAt") != proof["startedAt"]:
                raise ValueError("Original HTTP receipt lost its durable pre-body reservation")
        else:
            raise ValueError("Original provenance kind unavailable")
        return receipt

    def read(self, name):
        path = self.root / name
        if not path.exists() and not path.is_symlink():
            return None
        value = read_json(path)
        if not isinstance(value, dict) or not value:
            raise ValueError("Existing world checkpoint must be a nonempty object")
        return value

    def checkpoint(self, name, value):
        atomic(self.root / name, value)

    def transfers(self):
        value = self.read("transfers.json") or {"schema": 1, "attempts": []}
        if not isinstance(value, dict) or set(value) != {"schema", "attempts"} or value["schema"] != 1 or not isinstance(value["attempts"], list) or len(value["attempts"]) > 8:
            raise ValueError("World transfer budget corrupt")
        attempts = value["attempts"]
        if any(not isinstance(a, dict) or set(a) != {"index", "maxBytes", "startedAt", "headers"} or type(a.get("index")) is not int or not 0 <= a["index"] < 8 or a.get("maxBytes") != self.plan["sources"][a["index"]]["maxBytes"] for a in attempts) or len({a["index"] for a in attempts}) != len(attempts) or sum(a["maxBytes"] for a in attempts) > acquire.TRANSPORT_LIMIT:
            raise ValueError("World transfer reservation changed")
        for attempt in attempts:
            build.source_time(attempt["startedAt"])
        return value

    def matches(self, path, expected, maximum):
        if set(expected) != {"bytes", "sha256"} or type(expected["bytes"]) is not int or expected["bytes"] < 0 or not isinstance(expected["sha256"], str) or not SHA.fullmatch(expected["sha256"]):
            raise ValueError("Invalid original descriptor")
        if descriptor(path, maximum) != expected:
            raise ValueError("Resumed original bytes changed")

    def raw(self, index):
        source = self.plan["sources"][index]
        target, incoming = self.root / f"raw-{index}.osm.pbf", self.root / f"incoming-{index}.osm.pbf"
        receipt = self.read(f"raw-{index}.json")
        if receipt:
            self.valid_raw(index, receipt)
            path = target if target.exists() else incoming
            self.matches(path, receipt["original"], source["maxBytes"])
            if self.runtime.source_clock(path, self.root) != receipt["sourceAt"]:
                raise ValueError("Original PBF source clock changed")
            if path == incoming:
                os.replace(incoming, target); sync_directory(self.root)
            return receipt, target
        transfers = self.transfers()
        attempts = transfers["attempts"]
        attempt = next((a for a in attempts if a["index"] == index), None)
        if target.exists():
            raise ValueError("Unreceipted original requires explicit recovery review")
        recovery = self.recoveries.get(source["url"])
        if recovery and not attempt:
            if incoming.exists():
                raise ValueError("Unowned recovery partial requires review")
            original = Path(recovery["path"])
            self.matches(original, {"bytes": recovery["bytes"], "sha256": recovery["sha256"]}, source["maxBytes"])
            with original.open("rb") as inp, incoming.open("xb") as output:
                shutil.copyfileobj(inp, output, 1024**2); output.flush(); os.fsync(output.fileno())
            self.matches(incoming, {"bytes": recovery["bytes"], "sha256": recovery["sha256"]}, source["maxBytes"])
            provenance = {"kind": "reviewed-preserved-original", "reviewedAt": recovery["reviewedAt"], "reviewReceiptSha256": recovery["reviewReceiptSha256"], "completionObservedAt": now()}
        else:
            if attempt:
                headers = attempt.get("headers")
                # A crash can lose the final receipt but not these original
                # pre-body headers. Only exact known length proves completeness.
                if not incoming.exists() or not isinstance(headers, dict) or type(headers.get("contentLength")) is not int or incoming.stat().st_size != headers["contentLength"]:
                    raise ValueError("Interrupted source has no durable complete-body proof; review before retry")
                provenance = {"kind": "completed-http-stream-recovered", "headers": headers, "startedAt": attempt["startedAt"], "completionObservedAt": now()}
            else:
                if incoming.exists():
                    raise ValueError("Unreceipted incoming original requires review")
                if sum(a["maxBytes"] for a in attempts) + source["maxBytes"] > acquire.TRANSPORT_LIMIT:
                    raise ValueError("Durable world transport reservation cap")
                attempt = {"index": index, "maxBytes": source["maxBytes"], "startedAt": now(), "headers": None}
                attempts.append(attempt); self.checkpoint("transfers.json", transfers)
                def headers(value):
                    attempt["headers"] = value; self.checkpoint("transfers.json", transfers)
                download_world(source, incoming, headers)
                provenance = {"kind": "http-original", "headers": attempt["headers"], "startedAt": attempt["startedAt"], "completionObservedAt": now()}
        original = descriptor(incoming, source["maxBytes"])
        if not original["bytes"]:
            raise ValueError("Empty world original")
        source_at = self.runtime.source_clock(incoming, self.root)
        receipt = {"schema": 1, "sourceUrl": source["url"], "original": original, "sourceAt": source_at, "provenance": provenance}
        self.valid_raw(index, receipt)
        # Metadata is durable before rename; either filename is recoverable.
        self.checkpoint(f"raw-{index}.json", receipt)
        os.replace(incoming, target); sync_directory(self.root)
        return receipt, target

    def cohort(self, index):
        source = self.plan["sources"][index]
        receipt = self.read(f"cohort-{index}.json")
        output = self.root / f"public-{index}.jsonl"
        if receipt:
            if set(receipt) != {"schema", "index", "runtimePolicySha256", "raw", "output"} or receipt["schema"] != 1 or receipt["index"] != index or receipt["runtimePolicySha256"] != self.runtime.identity or receipt["raw"].get("sourceUrl") != source["url"]:
                raise ValueError("Completed cohort identity changed")
            self.valid_raw(index, receipt["raw"])
            self.matches(output, receipt["output"], min(source["maxExpandedBytes"], build.MAX_SOURCE_BYTES))
            for candidate in (self.root / f"raw-{index}.osm.pbf", self.root / f"incoming-{index}.osm.pbf"):
                if candidate.exists() or candidate.is_symlink():
                    self.matches(candidate, receipt["raw"]["original"], source["maxBytes"]); candidate.unlink()
            for candidate in (self.root / f"marine-{index}.osm.pbf", self.root / f"sequence-{index}.geojsonseq"):
                if candidate.exists() or candidate.is_symlink():
                    require_regular(candidate, source["maxExpandedBytes"]); candidate.unlink()
            sync_directory(self.root)
            return receipt
        raw, path = self.raw(index)
        original_stamp = stamp(require_regular(path, source["maxBytes"]))
        filtered, sequence = self.root / f"marine-{index}.osm.pbf", self.root / f"sequence-{index}.geojsonseq"
        # Known partial intermediates are replaceable only while the complete
        # original receipt still exists. Nothing unreceipted is promoted.
        for candidate in (filtered, sequence, output):
            if candidate.exists() or candidate.is_symlink():
                require_regular(candidate, source["maxExpandedBytes"]); candidate.unlink()
        self.runtime.run(["tags-filter", "--no-progress", str(path), *world_policy.SELECTORS, "-o", str(filtered)], source["maxExpandedBytes"])
        require_regular(filtered, source["maxExpandedBytes"])
        self.runtime.run(["export", "--no-progress", str(filtered), "--attributes=type,id", "-f", "geojsonseq", "-o", str(sequence)], source["maxExpandedBytes"])
        require_regular(sequence, source["maxExpandedBytes"])
        acquire.convert_sequence(sequence, output, source["maxExpandedBytes"])
        with output.open("r+b") as stream:
            os.fsync(stream.fileno())
        self.current()
        if stamp(require_regular(path, source["maxBytes"])) != original_stamp:
            raise ValueError("World original changed during extraction")
        receipt = {"schema": 1, "index": index, "runtimePolicySha256": self.runtime.identity, "raw": raw,
                   "output": descriptor(output, min(source["maxExpandedBytes"], build.MAX_SOURCE_BYTES))}
        self.checkpoint(f"cohort-{index}.json", receipt)
        for candidate in (path, filtered, sequence):
            require_regular(candidate, max(source["maxBytes"], source["maxExpandedBytes"])); candidate.unlink()
        sync_directory(self.root)
        return receipt

    def execute(self):
        with state_lock(self.container / "resume.lock"):
            self.input_admission()
            self.inventory()
            self.current()
            identity = {"schema": 1, "planIdentitySha256": self.plan_id, "runtimePolicySha256": self.runtime.identity,
                        "selectors": list(world_policy.SELECTORS), "plan": self.plan,
                        "controllerSources": self.source_files, "recoveryIdentitySha256": digest(self.recoveries)}
            old = self.read("job.json")
            if old is not None and old != identity:
                raise ValueError("Resume job plan/runtime/selector identity changed")
            if old is None:
                self.checkpoint("job.json", identity)
            target = self.inputs / self.name
            promoted = self.read("promoted.json")
            if promoted:
                if set(promoted) != {"schema", "inputSha256"} or promoted["schema"] != 1 or digest(read_json(target / "input.json")) != promoted["inputSha256"]:
                    raise ValueError("Promoted input receipt changed")
                manifest = read_json(target / "input.json")
                if set(manifest) != {"schema", "dataset", "coverage", "licence", "sourceAt", "inputs"} or manifest["schema"] != 1 or manifest["dataset"] != "facilities-world" or manifest["coverage"] != self.plan["coverage"] or manifest["licence"] != build.LICENCES["facilities-world"] or not isinstance(manifest["inputs"], list) or manifest["sourceAt"] != min(r["sourceAt"] for r in manifest["inputs"]):
                    raise ValueError("Promoted world manifest scope changed")
                world_policy.validate_sources(manifest["inputs"])
                for row in manifest["inputs"]:
                    build.checked_input(row, target, "facilities-world"); clock(row["sourceAt"])
                for i, row in enumerate(manifest["inputs"]):
                    receipt = self.read(f"cohort-{i}.json")
                    if not receipt or receipt["runtimePolicySha256"] != self.runtime.identity:
                        raise ValueError("Promoted cohort proof missing")
                    self.valid_raw(i, receipt["raw"])
                    expected = {"path": f"public-{i}.jsonl", "sourceUrl": receipt["raw"]["sourceUrl"], **receipt["output"], "sourceAt": receipt["raw"]["sourceAt"]}
                    if row != expected:
                        raise ValueError("Promoted cohort descriptor changed")
                    leftover = self.root / f"public-{i}.jsonl"
                    if leftover.exists() or leftover.is_symlink():
                        self.matches(leftover, receipt["output"], build.MAX_SOURCE_BYTES); leftover.unlink()
                self.current(); sync_directory(self.root)
                return target / "input.json"
            known = [self.read(f"cohort-{i}.json") or self.read(f"raw-{i}.json") for i in range(8)]
            no_fetch = [bool(row) or source["url"] in self.recoveries for row, source in zip(known, self.plan["sources"])]
            # The original fresh-run envelope minus only independently verified
            # cohorts that need no further download; recovery copies are extra.
            for i, row in enumerate(known):
                if row:
                    if "output" in row:
                        self.cohort(i)
                    else:
                        self.raw(i)
            recovery_copy = sum(row["bytes"] for url, row in self.recoveries.items() if not known[next(i for i, s in enumerate(self.plan["sources"]) if s["url"] == url)])
            need = sum(s["maxBytes"] for i, s in enumerate(self.plan["sources"]) if not no_fetch[i]) + 3 * sum(s["maxExpandedBytes"] for s in self.plan["sources"]) + 4 * 1024**3 + recovery_copy
            if shutil.disk_usage(self.inputs).free < need:
                raise ValueError("Insufficient unchanged world disk envelope")
            rows = [self.cohort(i) for i in range(8)]
            self.current()
            inputs = [{"path": f"public-{i}.jsonl", "sourceUrl": row["raw"]["sourceUrl"], **row["output"], "sourceAt": row["raw"]["sourceAt"]} for i, row in enumerate(rows)]
            world_policy.validate_sources(inputs)
            manifest = {"schema": 1, "dataset": "facilities-world", "coverage": self.plan["coverage"], "licence": build.LICENCES["facilities-world"], "sourceAt": min(r["sourceAt"] for r in inputs), "inputs": inputs}
            directory(target)
            for i, row in enumerate(rows):
                source, destination = self.root / f"public-{i}.jsonl", target / f"public-{i}.jsonl"
                if destination.exists() or destination.is_symlink():
                    self.matches(destination, row["output"], build.MAX_SOURCE_BYTES)
                else:
                    os.link(source, destination)
                build.checked_input(inputs[i], target, "facilities-world")
            for name, value in (("transport-receipts.json", [row["raw"] for row in rows]), ("input.json", manifest)):
                self.current()
                if (target / name).exists():
                    if read_json(target / name) != value:
                        raise ValueError("Existing final snapshot cannot be overwritten")
                else:
                    atomic(target / name, value)
            self.checkpoint("promoted.json", {"schema": 1, "inputSha256": digest(manifest)})
            self.current()
            # Final input hardlinks own these immutable bytes now. Drop only
            # the coordinator's exact known links, retaining all small receipts.
            for i in range(8):
                (self.root / f"public-{i}.jsonl").unlink()
            sync_directory(self.root)
            return target / "input.json"


def download_world(source, target, headers_callback, opener=None):
    dated = re.search(r"-(\d{6})\.osm\.pbf$", source["url"])
    if dated:
        day = dt.datetime.strptime(dated[1], "%y%m%d").date()
        today = dt.datetime.now(dt.timezone.utc).date()
        if day > today or day < today - dt.timedelta(days=45):
            raise ValueError("Old/future OSM snapshot; no acquisition")
    opener = opener or urllib.request.build_opener(acquire.NoRedirect())
    request = urllib.request.Request(source["url"], headers={"User-Agent": "ThalassaPublicCatalogue/140", "Accept-Encoding": "identity"})
    deadline = time.monotonic() + world_policy.download_deadline_seconds(source)
    with opener.open(request, timeout=30) as response:
        length = response.headers.get("Content-Length")
        if length is not None and (not re.fullmatch(r"\d{1,20}", length) or not 0 < int(length) <= source["maxBytes"]):
            raise ValueError("Invalid original HTTP length")
        if response.geturl() != source["url"] or response.headers.get("Content-Encoding", "identity") != "identity" or getattr(response, "status", 200) != 200:
            raise ValueError("Changed world transport origin/encoding/status")
        fields = {key: response.headers.get(key) for key in ("ETag", "Last-Modified")}
        if any(v is not None and (len(v) > 1024 or any(ord(c) < 32 for c in v)) for v in fields.values()):
            raise ValueError("Original HTTP header cap")
        headers_callback({"sourceUrl": source["url"], "contentLength": int(length) if length else None, "etag": fields["ETag"], "lastModified": fields["Last-Modified"], "headersObservedAt": now()})
        total = 0
        with target.open("xb") as output:
            while chunk := response.read(1024**2):
                total += len(chunk)
                if total > source["maxBytes"] or time.monotonic() > deadline:
                    raise ValueError("World transfer original byte/time bound")
                output.write(chunk)
            output.flush(); os.fsync(output.fileno())
        if not total or (length is not None and total != int(length)):
            raise ValueError("Incomplete original HTTP body")


def recovery_policy(path, expected, plan):
    if path is None and expected is None:
        return {}
    if not isinstance(expected, str) or not SHA.fullmatch(expected):
        raise ValueError("Reviewed local recovery SHA required")
    require_regular(Path(path), STATE_CAP)
    with Path(path).open("rb") as stream:
        raw = stream.read(STATE_CAP + 1)
    if len(raw) > STATE_CAP or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Recovery policy changed or oversized")
    policy = json.loads(raw)
    if set(policy) != {"schema", "planIdentitySha256", "originals"} or policy["schema"] != 1 or policy["planIdentitySha256"] != digest(plan) or not isinstance(policy["originals"], list) or not 1 <= len(policy["originals"]) <= 8:
        raise ValueError("Recovery policy scope")
    sources = {s["url"]: s for s in plan["sources"]}
    result = {}
    for row in policy["originals"]:
        if set(row) != {"sourceUrl", "path", "bytes", "sha256", "reviewedAt", "reviewReceiptSha256"} or row["sourceUrl"] not in sources or row["sourceUrl"] in result:
            raise ValueError("Recovery original scope")
        path = Path(row["path"])
        if not path.is_absolute() or ".." in path.parts or not str(path).startswith("/srv/thalassa-catalogue/"):
            raise ValueError("Recovery is restricted to existing owned catalogue originals")
        for parent in [path, *path.parents]:
            if parent.is_symlink():
                raise ValueError("Recovery cannot traverse a symlink")
        if type(row["bytes"]) is not int or not 0 < row["bytes"] <= sources[row["sourceUrl"]]["maxBytes"] or not isinstance(row["sha256"], str) or not SHA.fullmatch(row["sha256"]) or not isinstance(row["reviewReceiptSha256"], str) or not SHA.fullmatch(row["reviewReceiptSha256"]):
            raise ValueError("Recovery original byte/digest cap")
        build.source_time(row["reviewedAt"])
        result[row["sourceUrl"]] = row
    return result


def run(plan, input_directory, runtime_policy_path, runtime_policy_sha256, recovery_path=None, recovery_sha256=None):
    runtime = Runtime(runtime_policy_path, runtime_policy_sha256)
    original = stamp(require_regular(Path(recovery_path), STATE_CAP)) if recovery_path is not None else None
    recoveries = recovery_policy(recovery_path, recovery_sha256, plan)
    if recovery_path is not None:
        if stamp(require_regular(Path(recovery_path), STATE_CAP)) != original:
            raise ValueError("Recovery policy changed while reading")
        runtime.snapshots.append((Path(recovery_path), original))
    return WorldResume(plan, input_directory, runtime, recoveries).execute()
