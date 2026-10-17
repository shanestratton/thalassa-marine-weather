#!/usr/bin/env python3
"""No-network 140-01 source/resource review. Never acquires, publishes or installs."""
import hashlib
import json
from pathlib import Path
import acquire
import build
import world_policy

def review(plan_path):
    raw = Path(plan_path).read_bytes()
    if len(raw) > 65536: raise ValueError("Plan too large")
    plan = acquire.validate(json.loads(raw))
    if plan["dataset"] != "facilities-world": raise ValueError("Worldwide facilities plan required")
    transport = sum(row["maxBytes"] for row in plan["sources"])
    expanded = sum(row["maxExpandedBytes"] for row in plan["sources"])
    return {
        "schema": 1, "execute": False, "published": False, "installed": False,
        "planSha256": hashlib.sha256(raw).hexdigest(), "sourcePlan": plan,
        "resourceEnvelope": {
            "transportByteCap": transport, "extractedByteCap": expanded,
            "admissionFreeDiskBytes": transport + 3 * expanded + 4 * 1024**3,
            "largestSourceByteCap": max(row["maxBytes"] for row in plan["sources"]),
            "intermediateByteCap": max(row["maxExpandedBytes"] for row in plan["sources"]),
            "localSourceSnapshots": 2, "localStagedGenerations": 3,
            "retainedSourceSnapshotByteCapEach": acquire.LIMIT,
            "generationByteCap": build.MAX_OUTPUT_BYTES, "remoteOwnedDatasetByteCap": 4 * build.MAX_OUTPUT_BYTES,
            "serviceMemoryBytes": 2 * 1024**3, "serviceDeadlineSeconds": 24 * 3600,
            "downloadDeadlineSecondsPerSource": max(world_policy.download_deadline_seconds(row) for row in plan["sources"]),
            "downloadDeadlineSecondsBySource": [{"url": row["url"], "seconds": world_policy.download_deadline_seconds(row)} for row in plan["sources"]],
            "downloadBudgetBytesPerSecond": 4 * 1024**2, "osmiumDeadlineSecondsPerChild": 7200,
            "sourceClockDeadlineSecondsPerChild": 30, "serviceFileByteCap": 40 * 1024**3,
        },
        "publication": {"prefix": "marine-catalogue/v1/facilities-world/", "manifestLast": True, "conditionalSwap": True, "immutableChecksums": True, "apply": False},
        "prerequisites": ["Review actual bandwidth, runtime and a dedicated filesystem/project quota before any global acquisition", "Review this exact source plan hash; old regional facilities/AU quotas are unchanged", "Prepare and review the actual generated object/retention plan before R2 publication", "Enable the supplied monthly preparation timer only after explicit deployment review"],
    }

if __name__ == "__main__":
    print(json.dumps(review(Path(__file__).with_name("facilities-world.plan.json")), indent=2))
