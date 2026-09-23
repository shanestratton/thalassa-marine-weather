# Newport regional obstacle copy

The `osm-overlay` edge function serves the controlled Newport dataset **before**
its Overpass cache. The nine existing GeoJSON collections remain compatible with
the installed canal trial. No app build, sync, TestFlight release, Pi change or
SevenCs route activation is needed.

## Coverage and limits

- Region: `newport-v1`, W/S/E/N `[153.075, -27.23, 153.13, -27.15]`.
- Every requested bbox must fit wholly inside it. Partial/outside requests use
  the existing separate Overpass path, never an incomplete regional response.
- Geometry comes from the **public, dated Queensland PBF** published by
  [Geofabrik](https://download.geofabrik.de/australia-oceania/australia/queensland.html).
  It is not an ENC, hydrographic survey, depth inventory or clearance guarantee.
  Unmapped obstacles can still exist. The client retains its separate mapped-water
  mask, margins, bridge checks and no-route-on-failure behaviour.
- Mapped walls, retaining walls, quays, groynes and all bridges are conservative
  obstacles in the existing `breakwater` collection. Pontoons/piers are `berths`.
  No presumed bridge height, navigability or dredged depth is invented.
- © OpenStreetMap contributors; extraction by Geofabrik. [ODbL 1.0](https://www.openstreetmap.org/copyright).
  Provenance, source URL, date and licence accompany every regional response.
- Source age is checked on **every request**. At seven days the region fails
  closed with 503; stale data is not relabelled fresh. Daily refresh reports
  sources delayed beyond three days, before expiry. There is no public response
  cache or old database-cache fallback for covered Newport queries.

## Reproducible generation

Install `osmium-tool` (tested 1.19.1), and a Python virtual environment with
`pip install -r scripts/newport-overlay/requirements.txt`. No app dependencies
or credentials are required for extraction.

```sh
python scripts/newport-overlay/generate.py \
  --pbf /absolute/path/queensland-260911.osm.pbf \
  --source-url https://download.geofabrik.de/australia-oceania/australia/queensland-260911.osm.pbf \
  --output /absolute/path/newport-v1.json
python -m unittest discover -s scripts/newport-overlay -p 'test_*.py'
```

The generator checks the published source checksum and actual PBF replication
timestamp (not file modification time). It scans whole-state way envelopes,
including crossings with both vertices outside Newport and enclosing polygons.
It recursively retrieves selected relation references, verifies completeness,
and uses Osmium's strict area export to preserve hole/outer membership.
Malformed local geometry is rejected, never force-closed, repaired or simplified.
Clipping happens only beyond the advertised region with an additional buffer.
No contributor names, IDs, changesets, addresses or other unnecessary tags are
published. The source object type/ID is retained for audit.

Output is atomic. Invalid output, source-date regression or a >10% fall in any
existing water, berth or hard-obstacle inventory stops replacement for review.
Do not bypass these gates just to get the daily job green.

## Daily data-only refresh runbook

The approved Codex daily maintenance task uses this runbook. It runs on the Mac;
the Mac/Codex must be available. It is separate from app CI and TestFlight.

1. Read the live `osm-overlay` version/JWT setting for project
   `pcisdplnodrphauixcau`. Download **only that function** via Supabase CLI into a
   fresh `mktemp -d` work directory. Never deploy from the shared dirty workspace.
2. Preserve the downloaded files as rollback evidence. Find its bundled
   `supabase/functions/osm-overlay/data/newport-v1.json`; stop if the live layout
   or schema no longer matches. Read the live source timestamp/checksum.
3. Run `refresh.py --output <temporary live bundle path>` using a virtual
   environment with the requirements above. It finds the newest dated extract,
   downloads once with size/time limits and calls the strict generator. If the
   current source is unchanged and under three days old, make **no deployment**.
4. Run Python tests and `deno check` against the temporary function. Run
   `loadRegionalOverlay` and `selectRegionalOverlay` against the candidate and
   confirm the reported Newport bbox gets attributed obstacles. The existing
   repository test `tests/RegionalCanalOverlay.test.ts` covers the data contract
   and a real Newport bend; run it against the candidate without modifying
   unrelated files (or reproduce its checks in the temporary workspace).
5. Compare the downloaded and candidate function trees: **only**
   `data/newport-v1.json` may change. Re-read the live function version immediately
   before deployment; stop if another task changed it meanwhile. Preserve the
   observed JWT verification setting in temporary Supabase config.
6. Deploy only `osm-overlay` from that isolated directory with `--use-api`.
   Never blanket-deploy functions, change auth/quota settings, alter application
   code, buy a service, activate a route, or create a TestFlight build.
7. Verify live authenticated/quota-protected lookup: header `X-Overlay-Cache:
regional`, source date/hash match candidate, counts match; invalid bearer
   still rejected. If publication fails verification, restore the exact prior
   bundle/code only if live version still matches this job's deployment. Keep
   evidence and report the failure rather than overwriting concurrent work.
8. Keep successful new bundles and source provenance in a dated local maintenance
   archive. Never commit/push unrelated work. Stay quiet on unchanged healthy
   state; notify on successful refresh, failure or required user action.

The maintained source copy removes live Overpass availability as a dependency
for Newport obstacles. It does **not** remove the current client's separate
Mapbox-water dependency or make the trial suitable for unattended navigation.
