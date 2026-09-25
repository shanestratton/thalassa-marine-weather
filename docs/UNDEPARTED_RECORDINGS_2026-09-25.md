# Never-departed recording cleanup

The reported 25 September card shows 467 entries, 0.0 nm and 0h 0m. A read-only cloud check found the five archived sailed voyages but no matching new recording. Its exact phone-local history has not been inspected or deleted remotely.

## Fixed

- Log history now nominates stopped local-only recordings as well as cloud summaries. A summary is never permission to delete.
- Historical cleanup reads the full authenticated cloud history (including archived rows) and the owner-scoped local queue before and after that read. Immutable capture operation IDs deduplicate uploaded copies; conflicting evidence retains the voyage.
- The opt-in strict cloud reader distinguishes a successful empty history from unavailable, malformed, cancelled or truncated reads. Uncertain connectivity/storage leaves the recording intact for a later retry.
- Pending capture handoffs, failed-upload recovery rows, active/paused sessions, account changes and start/resume races prevent deletion.
- The exact generated `Acquiring position...` Start placeholder and bounded asynchronous Start ordering no longer invalidate otherwise complete stationary evidence. Startup uncertainty beyond one minute remains protected.
- Older cloud summaries whose footprint includes the zero-coordinate Start placeholder may nominate a full read; every actual position must still pass the stationary check.

Only complete, ended casual recordings with no authored content, plans or imports qualify. Existing distance, speed, footprint and observation-gap guards remain. Deletion uses the existing durable log-only tombstone/outbox, not a broad route/passage delete.

## Validation and delivery

All 280 focused checks passed across nine suites, including local-only history after reload, queue upload races, meaningful cloud movement, placeholder startup, incomplete reads, identity changes and failed-upload evidence. Production build, client-secret checks and scoped lint passed; the updated web bundle was synced into Xcode.

No live database deletion or production web publication was performed for this change. The updated iPhone app must be installed before its local recording can be checked. Archived-voyage statistics were audited but not changed; the recommendation is lifetime totals including archived voyages.
