# Source-only ERA5 climate pipeline

This folder is **not installed or armed**. It contains no credential lookup,
CDS SDK, scheduler, direct HTTP client or live Storage implementation. The app's
static prefix is empty/unadmitted until an actual complete generation is produced
and independently verified. Fictional tests do not constitute ERA5 acceptance.

`contract.py` fixes `reanalysis-era5-complete`, 1991–2020, hourly analyses,
1° provider regridding, and exactly 720 monthly originals: u10/v10 (165/166,
stream oper) and significant wave height/mean wave direction (140229/140230,
stream wave). Each request is whole-month/hourly. Monthly-mean products cannot
produce roses or exceedance frequencies. The immutable plan SHA binds all
requests and byte caps. The WMO reference supports the 30-year period; the
90%-hour coverage rule is Thalassa's disclosed method, not WMO certification.

`ledger.py` reserves a full 2 GiB before an injected transport is invoked. One
incomplete reservation blocks further reads; there is no automatic retry. Only
a completed, fsynced original reduces its charge to actual bytes. Original SHA,
fixed-request SHA and actual receipt time are durable, including across restart.
The cumulative 280 GiB transfer budget survives raw retirement. Missing primary
identity or an orphan original refuses initialization. A completed original can
be retired only with explicit `managed_retention=True`, a read-only lookup of
its exact committed accumulator seal/reduction hash, and an unchanged original
SHA/inode/stat check. A durable `retiring` state precedes unlinking that single
file; a crash there holds rather than reopening acquisition. No recursive
cleanup exists. No real original has been downloaded or retired by this source.

`native_grib.py` has a real ecCodes/NumPy decoder, loaded only after actual Linux
cgroup/kernel/privilege/environment/FD checks. It refuses non-analyses, wrong
class/stream/expver, unexpected units, time/grid/scanning/parameter changes,
duplicate or missing original hourly planes, changed raw bytes, extra messages
and malformed values. Missing bitmaps remain missing. Exact poles cannot claim
from-bearing. An on-disk bounded SQLite spool supports parameter-first GRIB
order; two fields are paired for each original hour. A uint32 histogram handles
one month at a time; there is no all-years RAM cube. Wind direction uses
`atan2(-u,-v)` and speed converts m/s to knots. Wave direction is mean direction
coming from; significant wave height supplies the magnitude. Calm counts are
separate. The original is rehashed and its inode/size/mtime/ctime is fenced.

`aggregate.py` commits all cells and the original seal in one transaction,
rejecting replay, missing/duplicate/reordered cells and inconsistent histograms.
It stores the actual reduction SHA. A year bit is set independently for each
variable/month only when that year's original hours reach 90%; good coverage
in another year cannot fill the gap. Export requires all 720 original seals.
Only one 5×5-cell tile is retained while exporting. It writes immutable tiles,
their manifest and a local pointer, plus a nonpublic original audit seal.

`publish.py` has no live store. Its injected store must enforce the existing
weather bucket. It validates the local full cohort/plan/seal and each bounded
file before any write. Every immutable tile gets an exact readback; then the
manifest does; the latest pointer is written last and read back. A failed child
or missing original seal cannot promote a pointer. The public namespace is
exclusively `climate/era5-v1/`; private paths are removed from the audit seal and
never uploaded. No user/vessel data is part of this climate product.

## Native admission proposal

`native_entry.py` accepts only fixed `/work/input/original.grib` and a ≤4 KiB
receipt containing period, kind, original SHA and plan SHA. It cannot select an
input path, variable, arbitrary year or command. The fixed output is
`/work/output/month.jsonl`; no native decoder calls a provider or publisher.
The source root must be root-owned under `/opt/thalassa-climate142-v1/source`.

`native-proof.proposed.service` is an **uninstalled proposal**, with no timer or
Install section. It sets 2 GiB RAM, no swap, 16 tasks, 50% CPU, CPU time ≤3600 s,
wall ≤7200 s, per-file ≤2 GiB, no capabilities, no new privileges, DynamicUser,
private network/devices, read-only system/home, fixed input and owned output.
An `env -i` command clears credentials, library/plugin paths and proxy variables;
all four numeric-library thread limits are exactly 1. The decoder checks actual
memory/swap/task/CPU cgroup values and rlimits before native imports. The external
admission must verify effective unit/mount properties, source/runtime hashes,
original fixtures, all open FDs, deadline/OOM/output refusals and full cgroup
cleanup. There is **no actual Linux positive decoder proof yet**, no installed
hash-locked ecCodes runtime, and no production admission inferred from Python
unit tests. Fixed GRIB header aliases/units must be confirmed on genuine native
fixtures; unexpected representations hold rather than being guessed.

## Bounds and remaining concrete work

| Resource              | Source ceiling / remaining admission                         |
| --------------------- | ------------------------------------------------------------ |
| Requests              | 720 fixed originals, one active, no automatic retries        |
| Original              | 2 GiB; cumulative transfers 280 GiB                          |
| Raw/state directory   | 8 GiB including the next full reservation                    |
| Native spool          | 1 GiB; ≤1488 hourly parameter messages/month                 |
| Monthly reduced JSONL | 128 MiB; ≤4096 B/line; exactly 65160 ordered cells           |
| Global accumulator    | 2 GiB SQLite at verified 4096-byte pages                     |
| Static export         | ≤2664 tiles ×512 KiB = 1.301 GiB, plus ≤512 KiB manifest     |
| Native process        | 2 GiB/no swap/16 tasks/50% CPU; positive Linux proof pending |
| App read              | 128 cells/32 tiles/8 MiB aggregate/45 s/two native reads     |

The float32 equivalent of all four hourly variables at this grid is about
274 GB (255 GiB), not a download-size prediction. GRIB compression and CDS queue
latency have not been measured. The bounded streaming design avoids retaining
an all-years cube or all raw originals at once, but needs an exact disk-reservation
review shared with other wx jobs (including accumulator rollback journal and a
single export generation), then managed-retention admission. No claim is made
that current wx resources are available. No 185–280 GB bulk request is authorized
by running these tests or by installing the app.

Three conventional CDS credential paths were absent in the earlier presence-only
receipt. This does not prove no account exists. Before actual collection, root
must review a concrete supported CDS transport, its trusted auth/download hosts,
actual accepted dataset terms, no-hidden-retry behavior, queue deadline and
original HTTP receipts. The injected transport intentionally has no default
live implementation until those facts are available. Next proof should be one
reviewed small genuine hourly sample, not the 720-request plan. Current primary
CDS metadata identifies the complete dataset's DOI `10.24381/cds.143582cf` and
CC-BY licence. Preserve source attribution and modifications when publishing.

## Offline software proof

```powershell
python -m unittest discover -s scripts/climate142 -p test_climate142.py -v
```

These are 18 stdlib Python fixtures on the local host. They cover fixed requests,
from-direction/units/clocks, unconfined native refusal, durable reservation and
receipt, interruption, byte/cumulative budgets, exact retirement, replay,
per-year coverage, transactional rollback and publication-last readbacks. Their
`GRIBfictional` byte strings test transport durability only and are never decoded
or presented as real observations. App algorithm/reader/UI and phone evidence
are documented separately in `docs/build142/era5-climate.md`.
