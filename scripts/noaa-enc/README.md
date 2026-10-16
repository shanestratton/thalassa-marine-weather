# Reviewed NOAA-only publisher

This directory prepares the original-source/update pipeline and an atomic
static catalogue. It does not configure a public bucket, install services or
activate anything merely by being imported. All commands below are review
instructions, not a claim that publication has occurred.

## Stages and boundaries

1. `catalogue.py` validates the fixed official ISO19115 source, source URLs,
   active extents, true edition/update strings and dates. Missing coverage is a
   withdrawn record, not an installable chart. It emits fixed 10-degree shards.
2. `stage.py` defaults to a local plan. Explicit `--acquire` verifies the current
   government agreement HTML, downloads only selected active NOAA IDs, preserves
   the exact ZIP, safely expands the original.000 plus updates and invokes the
   shared converter in the pinned isolated image with network disabled.
3. `publish.py` defaults to a read-only R2 plan. It checks local hashes and remote
   inventory, uploads immutable objects, verifies every object by reading it
   back, then conditionally replaces `noaa-enc/v1/index.json` using the captured
   ETag. Any failure before that final conditional update, or a competing writer,
   leaves the previous root intact. If the root update succeeds but its final
   readback fails, the new root may already be live: report failure and inspect
   the current root before preparing another exact plan or rollback.
4. `refresh.py` is the optional reviewed weekly policy. It fetches current
   metadata and stages at most256 new/changed cells per invocation, then publishes
   only with explicit `--run --publish`. The supplied timer is **not enabled**.

No deleted objects, retention job, bucket-policy edits or credential export are
included. Local staging is capped 32 GiB and requires 16 GiB of weather-volume free
space; remote NOAA prefix is capped 32 GiB/40,000 objects. Growth is refused until
retention is separately reviewed. Each cycle caps originals 512 MiB, converted
output 4 GiB, source XML 64 MiB, each ZIP 32 MiB / 128 MiB expanded, each phone chart 16 MiB
and250,000 features. Original sources and receipts are immutable. Failed cells
stop a run and do not stamp the old public catalogue as freshly checked.

Do not stage under `/srv/relief` or the source checkout. Use the weather volume,
for example `/srv/weather/thalassa-noaa/catalogue`. Marine reference extraction
may consume only the verified active source directory recorded in
`receipts/<zip-sha>.json` (`sourceDirectory`, source URL, edition/update), never a
second unfiltered All_ENCs download. The active proof source is
`/srv/weather/thalassa-noaa/proofs/us5ca1lk-1u1/input`; US5CA16M is cancelled.

Conversion upgrades preserve that original acquisition receipt byte-for-byte,
including older receipts that also contain conversion fields. A separate
`conversions/<zip-sha>/<conversion-identity>.json` records each conversion; its
identity hashes the original ZIP, converter bundle SHA and exact image ID.
`objects.json` references the selected immutable conversion receipt. Changing
either converter or image reprocesses the retained original in a separate
bounded work directory; unchanged runtime identities reuse the verified output.
New output hashes or generation metadata require a fresh exact publication
plan. Existing pilot objects and generations are never rewritten by this change.

## Runtime and credentials

`build-converter.mjs` bundles the existing shared Pi converter with esbuild into
an explicit output outside the checkout. Runtime needs no npm packages.
`prepare-image.py` verifies the exact local GDAL image and pinned official
Node 24.20.0 archive before creating a separate Docker context. Build with
`--pull=false --network=none`; no package manager or host Node/GDAL installation.

The reviewed isolated wx image is
`sha256:990dc0e63d9ce8cdbb37fad528013872f0fb4008641bd8967015f75149e4a1cf`;
converter SHA is
`aa4aa33d0033d6611dd102baaae98810213f37727d5ff4d00f5274d7081ed151`.

Host wx already has boto3. Existing mode600 server-only
`/home/shanes/.config/thalassa-relief/r2.env` supplies variable NAMES
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; existing relief
bucket default is `thalassa-relief` with optional `BUCKET` override. The reviewed
deployment must map these **inside the server process only** to
`CATALOGUE_R2_ACCOUNT_ID`, `CATALOGUE_R2_ACCESS_KEY_ID`,
`CATALOGUE_R2_SECRET_ACCESS_KEY`, `CATALOGUE_R2_BUCKET`. Do not read values into
chat, copy keys to this repository, create new keys or place them in app env.

Public client origin is fixed:
`https://tiles.thalassatiles.com/noaa-enc/v1/`. Verify that the existing owned
bucket/domain maps to it and permits GET/HEAD CORS for the app/native origin
before any activation. No such mutation or verification is claimed yet.

R2's current documentation confirms that conditional PutObject headers are
evaluated atomically against committed state:
https://developers.cloudflare.com/r2/api/s3/api/ and
https://developers.cloudflare.com/r2/api/s3/extensions/.
For an existing custom domain, cached assets may need a reviewed CORS cache
refresh after a policy change:
https://developers.cloudflare.com/r2/buckets/cors/.

## Concrete initial review and activation order

The corrected local outside-Git pilot generation
`work/noaa-publication135-corrected-timestamp/generations/3847831cfee29f42821c545a` contains full active
catalogue metadata with just one verified ready cell. Its empty-inventory
simulation is 106 immutable objects, 2,172,965 B; root-last total 2,195,390 B. All other
rows explicitly carry null chart/original objects. This is not complete global
rendering coverage. No R2 request has been made for this pilot.

The preceding `7d8d345f3e5807b535f1fd9d` pilot is retained as historical evidence,
but is invalid: the provider's series DateTime contained its title, which the old
parser wrongly used as `sourceAt`. It must never be published. Only that exact
known series placeholder is treated as unavailable; other malformed timestamps
fail closed. Validated per-cell metadata supplies the actual issuance time,
`2026-10-16T04:59:07Z`, independently of the later `checkedAt`. The corrected real
root and every one of its 102 shards pass the actual app parsers. US5CA1LK's
original ZIP and converted chart hashes are unchanged. Normalized metadata is
part of generation identity, so a parser correction cannot reuse an immutable
generation name with different content.

After code/destination review, copy the immutable generation, object files,
source receipts and canonical agreement to the isolated NOAA staging root.
Recompute all hashes there; do not recreate/rewrite original ZIPs. Run the live
**read-only** plan against the actual existing bucket, capturing the current
ETag and byte inventory:

```sh
python3 scripts/noaa-enc/publish.py --root /srv/weather/thalassa-noaa/catalogue \
  --generation /srv/weather/thalassa-noaa/catalogue/generations/3847831cfee29f42821c545a \
  --agreement public/data/noaa-enc-user-agreement.txt --review-plan /srv/weather/thalassa-noaa/pilot-plan.json
```

Review that exact saved plan hash and its intended owned prefix. Only then
apply with the same arguments plus `--apply --plan-sha256 <reviewed-hash>`.
No timers are enabled by this command. Verify public root/shard hashes,
cache headers/CORS, untouched ZIP and chart hashes, current effective DSID, an
anonymous client download/normal store import, cached offline reopening and
Satellite Mode zero-WAN behaviour. Preserve the preceding root snapshot/ETag.

Before global coverage is claimed, run further reviewed bounded cell batches:

```sh
python3 scripts/noaa-enc/stage.py --root /srv/weather/thalassa-noaa/catalogue \
  --catalogue /path/to/reviewed/ENCProdCat_19115.xml --cells US5CA1LK \
  --acquire --image sha256:990dc0e63d9ce8cdbb37fad528013872f0fb4008641bd8967015f75149e4a1cf \
  --converter-sha256 aa4aa33d0033d6611dd102baaae98810213f37727d5ff4d00f5274d7081ed151
```

The weekly policy defaults to a local plan unless `--run` is present. Activate
the supplied unit/timer only after the initial publication and one manual
weekly-policy run/readback have succeeded, with a dedicated reviewed environment
file and the existing server credentials mapped in place. Its lock prevents
overlapping refreshes. It is bounded to 256 cells per run; a backlog is reported.
Verify the timer's next trigger and last result without cancelling other wx jobs.

## Rollback and failure

Stop only the NOAA timer if it has been enabled. Keep original ZIPs, immutable
objects and the previously published generation. Prepare a new exact review plan
for that previous generation with `publish.py --rollback` (normal publication
refuses older source dates), inspect its current ETag and apply its reviewed
hash. This still verifies all referenced objects and uses conditional root CAS;
it does not delete newer data. Never replay an old plan/ETag or overwrite a
competing newer writer. Verify public root/shard reads after rollback.

If a source/revision, agreement, layer count, hash or byte cap fails, no new root
is published. The app displays saved ages and refuses stale publisher installs.
Do not relabel an old check, force a base-only conversion past a cancellation,
silently raise limits, enable paid sources or delete other publisher prefixes.

Tests: `python -m unittest discover -s scripts/noaa-enc -p test_pipeline.py -v`.
