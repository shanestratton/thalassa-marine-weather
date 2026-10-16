"""Sixteen real PostgreSQL sessions confirm the same voyage; exactly one changes the meter."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess

OWNER = "00000000-0000-4000-8000-000000000001"

def sql(body):
    result = subprocess.run(
        ["psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", body],
        check=True, capture_output=True, text=True, timeout=30, env=os.environ.copy(),
    )
    return result.stdout.strip().splitlines()[-1]

def claim(_):
    return json.loads(sql(
        "SET ROLE authenticated; "
        f"SELECT set_config('request.jwt.claim.sub','{OWNER}',false); "
        "SELECT public.confirm_voyage_engine_hours('race136',3600,'log',200);"
    ))

with ThreadPoolExecutor(max_workers=16) as pool:
    results = list(pool.map(claim, range(16)))
assert sum(row["applied"] for row in results) == 1, results
proof = json.loads(sql(
    "SELECT json_build_object('hours',hours,'receipts',(SELECT count(*) FROM public.voyage_engine_hours_receipts "
    f"WHERE user_id='{OWNER}' AND voyage_id='race136')) FROM public.vessel_engine_hours WHERE user_id='{OWNER}';"
))
assert proof == {"hours": 201, "receipts": 1}, proof
assert all(row["hours"] == 201 for row in results), results
print(json.dumps({"realConcurrentSessions":16,"applied":1,"duplicateNoops":15,**proof}))
