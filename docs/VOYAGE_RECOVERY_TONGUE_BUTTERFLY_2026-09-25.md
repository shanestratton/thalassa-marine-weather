# Tongue Bay → Butterfly Bay: missing departure recovery

The user requested rebuilding the missing start of this recorded trip. The
scoped recovery was committed and independently verified on 25 September 2026.

## Result

- Existing voyage retained: `voyage_1790124398484_ykoyqfm54`.
- Trip date: **23 September 2026, AEST**.
- The Pi brackets push-off between **09:30:39** (last stationary observation)
  and **09:31:35** (first moving observation). The summary's GPS-estimated
  departure is 09:31:35; this is not an invented precise cast-off event.
- Existing app recording began at 10:46:38 and ended at **12:23:01**.
- **398 actual Pi fixes** restored ahead of **1,043 original app rows**:
  **1,441 total observations**, about **2h 51m underway**, **17.9 nm**.
- Missing sampled distance including the observed join: 6.711369204935815 nm.
  Join separation: 2.916 seconds / 9.76 metres. Maximum missing-section
  sampling interval: 56.01 seconds; maximum derived segment speed: 10.46 knots.
- No positions or timestamps were interpolated. This is historical track
  reconstruction from recorded fixes, not a navigation route.

## Preservation

All existing row identities, coordinates, timestamps, sensor measurements,
notes and archive states remain unchanged. Only the following derived fields
changed on original rows:

- Their cumulative distances received the same missing-distance offset.
- The first original row's zero leg distance became the measured join distance.
- Its `Voyage Start` label became `App recording began · original mark` to
  distinguish late app recording from the recovered actual departure.

The same voyage ID retains its linked diary entry. No diary relink, new voyage,
archive change, public visibility change, route change, or Pi restart was needed.
The permanent retirement fence from an earlier archive/restore remains intact;
restoring historical fixes does not restart a retired live feed.

## Validation and rollback

An identical transaction first passed with `ROLLBACK`. The committed transaction
ran under the authenticated owner's RLS context with row locks, exact preflight
digests, and post-write checks. Fresh independent reads confirmed every original
measurement, all recovered observations, related diary/privacy records, and
unrelated voyage history were preserved. The public API returned HTTP 200 with
all 1,441 points, the existing diary, and the new departure marker.

A repeat of the rollback-only application was rejected before any changes with
`Recovery already applied: verify instead of rerun`, confirming the explicit
idempotence guard. A subsequent fresh summary read retained the correct count.

Private mode-0600 backups, sample manifest, dry-run/application SQL, post-write
snapshot, and a guarded `rollback-if-needed.sql` are stored at:

`/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-sept23-recovery-3t3JP7/`

Pi source SHA256:
`f3328d68856aa9c8c159324accbc3b6d5913628bd95033817a4d993a65840efd`.

The audit/preparation/verification scripts are deliberately scoped one-off tools:
`scripts/audit-sept23-pi-voyage.mjs`,
`scripts/prepare-sept23-voyage-recovery.mjs`, and
`scripts/verify-sept23-voyage-recovery.mjs`.
Do not reuse them for another voyage without a new request and evidence audit.

Existing unrelated display limitation: the public backend's default catalogue
label formats dates in UTC, so this pre-midnight-UTC AEST departure can show
22 September in that label. Stored observations and the AEST times above are
correct; no timestamp was shifted to disguise that presentation issue.
