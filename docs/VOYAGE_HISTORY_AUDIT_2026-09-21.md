# Voyage history audit — 21 September 2026

Read-only investigation of repeated “Voyage Start” labels and missing earlier
tracks on the public Serene Summer page and the app Log page. No track records
were deleted, restored, or changed during this audit.

## Repeated starts — confirmed producer defect

`ShipLogService.performStartTracking` unconditionally captures `Voyage Start`
after each successful start, including native/WebView recovery and continuation
of the same voyage. Capture receives the current fix, timestamp and a new client
operation ID. Upload idempotency correctly treats these as different rows, so it
does not remove the extra lifecycle events.

The live public response contains 24 Starts and one End for the September 18–20
voyage, all under the same voyage ID. Public `MapContainer` draws every waypoint
unless a planned route suppresses the starts. The current voyage has no planned
route. Current native map source no longer renders those named waypoint markers,
so an identical installed native label display requires build/view confirmation.

Repair should separate an actual new departure from resuming its recorder and
make lifecycle capture idempotent per voyage. A fresh Cast Off also supplies a
voyage ID, so checking only `continueVoyageId` would suppress genuine starts.
Legacy display can select one earliest Start / latest End per voyage without
deleting any track samples or custom waypoints.

## Missing older voyage — cloud evidence

Linked database checks ran in READ ONLY transactions with bounded statement
timeouts, returning aggregate metadata only.

- September 15–17 voyage `voyage_1789439313134_5xka8gz8r`: no `ship_logs` rows
  across owners, no live track, no public-hidden record. Its three public diary
  entries remain attached to the correct boat/owner.
- A `live_track_retirements` record for that voyage has reason `deleted`, dated
  20 September at 17:07:06 Brisbane. This may be retry acknowledgement time,
  not the original deletion request time. It does not establish who requested it.
- September 18–20 voyage `voyage_1789727911316_jgthpaqcr`: 18,286 durable rows,
  correct owner/boat, not archived; 4,309 live rows; no retirement. Its first and
  final samples are present in the public decimated 10,000-point response.
- Both the latest-trip and legacy all-eligible-tracks public responses contain
  only the newer voyage. Configured retention is 30 days. The missing older
  geometry is not simply a dropdown selection or response pagination problem.

## Unsafe automatic deletion — reproduced

`useLogPageState.loadData` passes merged summaries to `pruneEmptyTracks` after
network loads. The sweep calls `ShipLogService.deleteVoyage`. End Voyage invokes
`loadData`, so deletion is not restricted to explicit user delete taps.

`VoyageSummary.mergeSummariesWithLive` replaces a complete server summary with
any locally held rows for that voyage, even an incomplete tail. `isEmptyTrack`
then calls any footprint below 150 m empty, regardless of cumulative distance.

Using the actual pure functions in a read-only diagnostic reproduction:

1. A cloud summary containing 230.1 NM and a 300 km span was not selected.
2. Adding one local tail point for that voyage replaced the span with zero.
3. The merged summary still carried 230.1 NM, but the sweep selected it for deletion.

Interrupted uploads can leave partial local tails. This establishes a real
data-loss bug and a plausible explanation for the retirement shortly after
ending the newer voyage. The deleted voyage's actual pre-deletion local snapshot
is unavailable, so this is not proof of the exact historical trigger.

Recommended immediate repair is to remove automatic destructive pruning based
on partial summaries, preserve complete history metadata when merging local
tails, and retain explicit user-controlled deletion. Regression coverage must
include partial local data, resumed voyages, and completed long passages.

## Recovery boundary

The sweep clears the per-voyage device cache; queued samples and old queue
generations are purged after durable deletion. The short Undo window occurs
before actual deletion, not a lasting trash archive.

The Pi has a separate append-only SQLite track store at `<CACHE_DIR>/track/track.db`,
with time-indexed samples and no automatic age-out. If enabled during the missing
dates it may retain an independent copy. Its existence/coverage has not yet been
checked, and nothing has been restored. Recovery needs original samples, not a
straight line invented between diary positions.

109 existing tracking/public-start tests passed. They do not assert one lifecycle
Start per voyage or protect the reproduced partial-summary deletion scenario.

## Approved repair — 21 September

After the user approved the Log repair and recovery check:

- Removed automatic empty-voyage deletion from network-load sweeps, Log End
  Voyage, and service-level stop/queue handling. Stopping retains all points and
  uploads them normally. Explicit user deletion/Undo remains; its accepted-state
  update removes both the summary card and entries.
- Partial local rows may extend but cannot replace a complete cloud summary.
  Existing distance, entry count, time range, footprint and classification
  evidence are preserved; averages cannot be reconstructed from an unsynced tail.
- A known-partial stop snapshot preserves an existing owned offline cache.
  Full fetches still replace caches, so deliberately deleted entries do not
  reappear. Identity checks and scoped serialization remain in place.
- Fresh Cast Off alone requests a Start, including a new supplied voyage ID and
  genuine failed-GPS-start retries. Start gets a stable owner-scoped operation ID.
  Ordinary resume/WebView recovery does not create another departure. If the
  original Start never saved, recovery leaves it unknown rather than attaching
  a later fix to the earlier departure time. Actual GPS recording still resumes.
- End markers keep separate identities for successive explicit stops/continues;
  a stable End would incorrectly preserve the first stop through offline replay.
- Public presentation chooses earliest Start and latest End per known voyage,
  preserving custom pins, all samples and original stored records. Unknown
  legacy multi-voyage responses are not merged. Planned-route Start suppression
  and the all-diary default remain unchanged.

Existing durable deletion tombstones still retry: their historical records do
not distinguish automatic cleanup from explicit user intent, so indiscriminately
clearing them would resurrect deliberately deleted history. No tombstones were
changed. Older installed app versions still contain the former automatic cleanup
and must be updated before relying on the repair.

## Pi recovery check — read only

SSH to the user-specified yacht address succeeded. The active service is
`thalassa-cache.service`; recorder settings show enabled. Its independent
`/opt/thalassa-pi-cache/cache/track/track.db` was opened with SQLite `readonly`,
`fileMustExist` and `query_only` safeguards. No Pi settings, files or rows were
changed and no database checkpoint/restore was run.

A provisional window from the old voyage ID's creation time to the reported
Gladstone arrival plus 15 minutes contains **16,018 valid-coordinate samples**:

- First: 15 September 2026 12:28:41 Brisbane, Newport area.
- Last: 17 September 2026 10:44:46 Brisbane, Gladstone area.
- Approximate accumulated sampled distance: 306.4 NM.
- Longest sample interval: approximately 7 minutes; no gaps over 15 minutes.

This is a promising independent recovery source, not a restored or certified
complete original voyage. The window/endpoints need review before import. No
track was recreated and no diary links/publication state changed. Reusing the
deleted voyage ID without accounting for existing device/cloud tombstones is
unsafe; any recovery plan must explicitly address that fence and diary linking.

Final focused verification: **302 tests passed across 21 suites**, including
partial-summary retention, no automatic delete on load/stop, explicit delete and
Undo, actual Cast Off/retry/resume, crash before Start capture, stop→continue→stop,
cache ownership/replacement/clear, and public waypoint grouping. Scoped ESLint
and whitespace checks passed. Log: `/private/tmp/thalassa-log-safety-final-tests.log`.

## Build and public release — completed

Production build and Capacitor iOS sync passed after the final cache/lifecycle
review. `dist` and `ios/App/App/public` both contain `main-mVikTP2O.js` and
`logs-v-Vio5YC.js`. This prepares Xcode; it does not install onto the phone or
publish TestFlight.

The isolated public-diary release was promoted as
`dpl_HFBWehm8sRLgQu4iUGZDsZSfn2VE` (`logs-D6faCBgP.js`). Both production domains
serve it. Hosted release/security/cache checks passed. The isolated public suite
passed 68 tests. Browser inspection of the September 18 track shows one departure
marker, not the former chain of repeated starts. Native Log safety changes were
not included in this public-only hosted deployment.

## User-approved recovery — committed 21 September

The user explicitly authorised restoration after the read-only findings.
Recovered voyage ID: `voyage_recovered_pi_1789439313134_5xka8gz8r`.

- Restored all **16,018 original Pi observations**, keeping exact timestamps and
  coordinates. Derived sampled distance is **306.355802765983 NM**. Maximum gap
  is 416.17 seconds; maximum speed derived between consecutive fixes is 10.46 kn.
- Preserved available SOG/COG, true wind speed/direction, water temperature and
  pressure. Exact raw NMEA fields remain in the private original-sample backup.
  Water classification stays unknown, not fabricated. Source is onboard device.
- First actual observation is labelled “Recovered GPS track · Newport to
  Gladstone”, with provenance explaining the provisional observation window.
  No invented Start/End lifecycle timestamps or interpolated positions were added.
- Relinked the existing three diary IDs, retaining their content, media and public
  settings. Incremented their revisions from 2 to 3; old equal/lower relay envelopes
  cannot undo the association. This does not overrule a future genuinely newer edit.
- Kept the original deleted-voyage fence intact and left the newer voyage unchanged.
  A separate recovered ID avoids old deletion retries erasing restored samples.

The first full request hit the Management API payload limit before SQL execution.
Transferred 33 bounded batches into a purpose-specific schema inaccessible to
anon/authenticated/service API roles. A rollback-only trial verified the complete
restore first. Final owner-RLS transaction inserted samples, relinked diaries and
dropped the exact staging table/schema atomically. No permanent staging objects
remain. The recovery utility aborts if the recovered voyage already exists; an
uncertain result must be verified, not duplicated or blindly retried.

Private recovery artifacts (original samples, before-state, manifest, applied SQL
and commit result) are kept under:
`/Users/shanestratton/Library/Application Support/Thalassa/recovery/2026-09-21-newport-gladstone/`.
Directory mode is 0700 and files 0600. Original sample SHA-256:
`f009e358d1138f3dc0f0bb9106166dee532117fb46ec2a226253c55f1b136328`.

Live public voyage selector now contains both September 15 (306.4 NM) and
September 18 (230.1 NM). Existing six public diary entries remain available under
All diary entries. An updated phone installation is still required to remove the
old app's automatic-deletion behavior.

Independent post-commit verification confirmed all 16,018 coordinate pairs
bit-for-bit using PostgreSQL `float8send`, and exact millisecond timestamps
against the Pi backup. (Default database JSON float formatting rounds display;
binary comparison avoids mistaking that for stored precision loss.) The newer
18,286-row full-record digest and old retirement snapshot are unchanged. The
three diary records differ only in voyage ID, revision and update time. Browser
inspection confirms the full restored passage, its recovery marker and three
associated diary entries. The six-entry all-diary view remains intact.
