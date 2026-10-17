# World facilities: durable source checkpoints

This packet is source-only. It changes neither the installed service nor any
provider, timer, public object, regional source selector or resource limit.
Root owns installation, quarantine, Linux admission and the actual retry.

`monthly.py` now routes **only facilities-world** through `world_resume.py`.
World execution requires a separate exact-hash native policy. Regional
acquisition and its existing limits keep their original path. The ordinary CI
Python discovery includes the new tests; no custom-only test suite is needed.

The existing catalogue OS lock remains held by `monthly.py`; the controller
also takes a Linux `flock` on its own fixed state lock. Persistent state lives
in `inputs/.facilities-world-resume/YYYYMM-<16 hex plan identity>`, outside the
final snapshot directory and its ordinary retention scope. The exact plan,
selectors, runtime policy, recovery descriptor and five controller/converter
source digests bind a job. A changed job cannot inherit its receipts. At most
two state histories are retained, and an unfinished different history holds
the next run. Further history cleanup requires explicit review; this packet
does not silently delete old evidence.

## Crash and provenance rules

1. Before transport, durably reserve that source's full reviewed maxBytes.
   Before opening the body file, fsync its actual URL, observed headers,
   Content-Length (or explicit absence), ETag, Last-Modified and start/receipt
   clocks. Redirects, compressed bodies, old/future dated URLs and bounds fail.
2. Hash the complete original and read its actual PBF replication timestamp
   with the reviewed binary. Fsync the original receipt **before** renaming
   incoming to raw. An interrupted known-length body may resume only when its
   actual byte count exactly matches its durable original Content-Length.
   A partial/unknown-length interrupted transfer holds without another request.
3. Keep the original while the unchanged tags-filter selectors, original OSM
   type/id export and bounded JSONL conversion run. Fence original stat and
   runtime/source identity before accepting the result. Fsync the JSONL and
   complete cohort receipt **before** deleting the original or intermediates.
4. On restart, independently rehash every reusable original/output. An existing
   cohort needs its matching source URL, original/source clock, provenance,
   runtime and output hashes. No receipt means no adoption. Unchanged completed
   cohorts make no new provider request.
5. After all eight original continental cohorts pass, create verified hardlinks
   into the final owned snapshot. Write transport receipts, then the ordinary
   strict input.json last, followed by a promoted checkpoint. A crash during
   this sequence can resume without overwriting different bytes. A completed
   job is rechecked against all cohort receipts before being returned to build.

No old HTTP/fetch clock is invented. Original PBF clocks are never replaced by
resume/publication time. The existing 45-day source admission remains in force.
Corrupt metadata, extra paths, symlinks, excess bytes, multiple large originals,
unexpected snapshots and retired runtime/source identities hold the run.

## Native policy and unchanged envelope

The root-reviewed JSON policy has exactly:

```json
{"schema":1,"executable":"/opt/<reviewed>/osmium","files":[{"path":"/absolute/resolved/file","bytes":1,"sha256":"<64 hex>"}],"bindings":[{"path":"/actual/loader/alias","target":"/reviewed/resolved/file"}],"libraryPath":""}
```

This illustrates the schema; it is not an executable policy. The actual
candidate policy in `work/world140-resume-review/runtime-policy.candidate.json`
pins the admitted binary plus ten actual resolved dependencies and ten observed
loader bindings. Policy SHA256 is
`f788170fbc075e59b3cb6948bf0dc1e68397dc35fd44fb30ec2fc67d8e8b0d2a`.
Every dependency needs an actual binding, checked before/after every child;
relinking a soname to a new target invalidates the old runtime even while the
old hashed file still exists. Root-owned non-writable namespace/file checks,
original file hashes and stat retirement fences apply. Limits are 64 files,
128 bindings and 256 MiB total native files. No ldd command runs in production.

Child argv0 is the canonical `osmium`; `executable` is the exact reviewed path.
The environment is cleared to fixed locale/PATH, the original two-thread/four
two-item queues and only an explicitly reviewed private library path. Stdin is
closed, inherited credential FDs are closed, file-size limits are applied, and
a deadline kills/reaps the entire child process group. Header reads remain
30 seconds; extraction children remain two hours. The outer reviewed 2 GiB,
no-swap, 16-task, 50% CPU, 24-hour service and 180 GiB filesystem remain root
deployment prerequisites, not claims made by a local Python fixture.

The fresh disk admission remains `sum(maxBytes) + 3*sum(maxExpandedBytes) +
4 GiB`. Resume subtracts only independently verified no-fetch cohorts or an
explicit reviewed local original; local recovery copies add their full actual
bytes back. Existing free space already includes all preserved/failed files.
Two source snapshots, 24 GiB per snapshot, three output generations, the
128 GiB durable transport reservation and all per-source caps are unchanged.

## Exact preserved Asia recovery, pending root activation

The prior Africa/Antarctica JSONLs have no durable original receipts and **must
be reacquired**. The controller refuses the legacy `.acquire-zwoq9mj1` directory
under final inputs. Root has separately approved moving that whole directory
to `/srv/thalassa-catalogue/failed-trials/second-oom` without recursive deletion.
After that move, root must verify the actual path and prepare/review a new
exact-hash recovery descriptor; no path move is performed by this code.

The preserved Asia source is 16,386,309,668 bytes, full original SHA256
`9dabe0b7afecc153d6c92a911e4e47552884c5d9d8631da20664abafe6558393`.
Actual fresh admitted-tool fileinfo confirms source timestamp
`2026-10-16T20:21:21Z`, matching the old 21-byte header file. The full-hash read
and header read each retained stable inode/mtime/ctime. The combined local
evidence file `work/world140-resume-review/preserved-original-review.json`
has SHA256
`a28b9cea749c0a3573407afef3a409daf8a0a577e59ac9f5f1de3e19d23820b7`;
it retains the two original receipt hashes. It asserts no original HTTP clock.

A recovery descriptor has exactly schema=1, planIdentitySha256 (canonical plan
JSON SHA256) and originals, each with sourceUrl, absolute owned catalogue path,
bytes, sha256, reviewedAt and reviewReceiptSha256. It is separately SHA-pinned
on the CLI and stat-fenced throughout the job. The controller copies and
rehashes the reviewed original before extraction; it never mutates that source.
Recovery provenance records its actual completion observation and reviewed
receipt, without HTTP/fetch fields. The next fresh monthly plan needs no
recovery descriptor.

The existing monthly invocation receives these additional arguments only after
root's exact installation/admission review:

```text
--world-runtime-policy <installed-readonly-policy>
--world-runtime-policy-sha256 <reviewed-exact-file-SHA>
--world-recovery <reviewed-moved-original-descriptor>
--world-recovery-sha256 <reviewed-exact-file-SHA>
```

Publication still requires the existing separate publication policy/plan. The
controller itself has no R2 client, provider credentials, activation or publish
API. Global acquisition, publication and any native performance claim remain
unproven until root's actual controlled Linux run.

## Source proof

`python -m unittest discover -s scripts/marine-catalogue -p 'test_*.py' -v`
passes 88 cases locally: 86 pass, two explicit Windows skips (real symlink
privilege; root-owned POSIX /opt policy admission). Actual Linux must execute
those fences before deployment. The focused suite uses synthetic HTTP/native
ports, eight small continental fixtures and real build/output validation; it
proves interruption/resume, no silent re-fetch, complete/partial/no-length body
distinction, raw/output/current-source mutation refusal, private recovery
provenance, receipt-before-delete, promotion recovery, free-space admission,
child kill/reap and unchanged regional dispatch. It does not decode a real PBF
or emulate kernel cgroup enforcement.

The first local test pass exposed Windows refusing fsync on a read-only file
descriptor; output fsync now opens the existing file r+b. The first whole-suite
pass also exposed the Windows absence of SIGKILL in the mocked Linux timeout
test; that test now supplies the Linux signal explicitly. Assertions were
retained; production cleanup remains the Linux process-group path.

Before installation review, an additional read audit caught empty JSON being
treated like absence by truthy fallback. `self.read` now distinguishes a missing
path from every existing malformed/empty checkpoint. Existing null, empty
object/array, false, zero and empty-string transfer/raw/cohort/promoted/job state
all refuse immediately, preserving the original reservation and bytes without
another provider/native call. Five additional tests retain all original 83 and
cover those 30 corruption combinations. The original v4 preparation is retained
unexecuted; the corrected child requires a separately pinned v4b packet and an
actual Linux88 proof with zero skips before production.
