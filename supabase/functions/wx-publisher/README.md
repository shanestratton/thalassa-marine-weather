# Scoped wx forecast ingestion

This endpoint completes the existing `wx_subscriptions` /
`wx_point_forecasts` contract. Deploy only this function and its four source
files, with `verify_jwt=false` plus mandatory dedicated-token verification in
`handler.ts`. The token is a random 256-bit value held only in wx's root-owned
0600 `/etc/thalassa/wx-point-publisher.env`. `tokenHash.ts` contains its public
SHA256 verifier. The service-role credential remains inside the existing Edge
runtime environment; it is never returned to wx or an app client.

Database model keys use `wx2:<actual-domain>`. The API and provenance retain
the actual model ID; only this boundary encodes/decodes the six known storage
aliases. Raw legacy rows are never read as v2 versions or updated. Builds132
and133 keep their existing fallback, and build134 must explicitly query/map
the namespaced keys and project current values from the valid hourly axis.

`POST {action:"work",after?:cell_id,limit?:1..64}` returns recent anonymous
coarse cells and current run versions. `POST {action:"publish",rows:[...]}`
accepts at most 16 rows / 1 MiB. Authenticated writes are limited to active
cells and six actual global model identities. There is no arbitrary table,
filter, URL, SQL, callback, deletion or user-account operation in this API.

All rows are validated before any write: explicit version 2 cell-centre
provenance, source domains/runs, oldest-dependent-run age, sea selection,
actual UTC axes/horizon, consistent units and finite next-day wind,
direction and temperature. Null remains null and genuine zero remains zero.
Nested objects reject unknown fields, conservative physical ranges reject
sentinels and impossible values, and privileged REST fetches reject redirects.
The weather-server producer additionally verifies actual local metadata,
successful idle sync state and stable snapshots. It samples cell centres;
this does not certify the boat's exact coastal point or IFS9km coverage.

Insert-ignore first plus conditional update only where stored `run_at` is
older handles concurrent absent/existing rows without older overwrites.
Publication timestamps do not change on duplicate runs. Existing RLS and
retention sweeps remain unchanged; no migration is required.

Before activation, run `tests/WxPublisherEdge.test.ts` and the weather-server
Python tests. Probe missing/wrong-token rejection, then obtain a real work
page only from wx's private environment. Install the matching producer and
units narrowly after review. Confirm fresh public rows, then run it again
and require zero forecast writes before enabling the timer. See the weather
repo's `ops/POINT-PUBLISHER.md` for staging and rollback.

Reviewed docs: [function auth](https://supabase.com/docs/guides/functions/auth),
[auth headers](https://supabase.com/docs/guides/functions/auth-headers),
[conditional updates and ignore duplicates](https://docs.postgrest.org/en/stable/references/api/tables_views.html).
