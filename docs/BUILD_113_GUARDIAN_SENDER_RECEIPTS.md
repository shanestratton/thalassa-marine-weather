# Build 113 — Guardian sender receipts and recipient feeds

## Outcome

The Guardian sender and recipient feed repairs are deployed to project
`pcisdplnodrphauixcau` as migrations `20260911073000_guardian_sender_receipt`
and `20260911080000_guardian_recipient_feed`. Both repairs work with the
existing installed app's RPCs. The immediate receipt UI is prepared in
**1.2.0 (113)**; this build has not been archived or uploaded to TestFlight.
Delivered build 112 and its archive are unchanged.

## Root cause and changes

- The live `guardian_alerts_nearby` function referenced unqualified `radius_nm`
  inside a query against `guardian_alerts`, which also has a `radius_nm` column.
  An isolated copy of the exact live function reproduced PostgreSQL **42702**
  (ambiguous column reference). The new function qualifies its parameters.
- Senders were already included by identity, but their history was unnecessarily
  conditional on a fresh nearby position. Their own last-24-hour alerts now
  remain available after moving away or when a presence fix goes stale. The app
  still pauses its feed and location polling when Guardian is disarmed.
- A new receipt RPC returns the inserted server alert, ID and timestamp plus
  the count of other vessels queued for notification. The old INTEGER-returning
  RPC delegates once and remains compatible with 112 and service callers.
- Build 113 refreshes the armed presence before sending, then publishes the
  confirmed server row immediately, including with zero nearby recipients.
  No synthetic alert, self-push, client-supplied timestamp or ID is used.
- A feed generation fence prevents a pre-send poll erasing the new receipt.
  Later reads replace the list without duplicates; failed reads retain it.
  Account changes, stopping and disarming fence delayed responses.
- Server-derived **Sent by you** identifies the sender entry. Feedback says
  **queued**, not delivered/read. Missing receipts and ambiguous transport errors
  never automatically resend or claim definite non-delivery.
- Nearby boats were queued for a push but had no corresponding feed access.
  New canonical broadcasts now persist the exact server-selected recipients in
  `guardian_alert_recipients`, atomically with the alert and push queue. Cleaning
  the push queue no longer loses this audience record. No self-push is added.
- Non-owner feed entries still require an armed, fresh position within the
  bounded feed radius and time window. Only the recorded recipients can read
  broadcast entries; merely arriving nearby later does not grant access. Exact
  locations and other recipients are not exposed to app clients.

## Verification and deployment

- **82 focused tests passed** across eight Guardian service, identity,
  component and migration suites.
- Full app unit run: **10,015 passed**, three expected failures and five skips;
  1,116 suites passed and four skipped. Exit 0. This ran before the seven additional
  recipient migration tests; the final focused run above includes those tests.
- **85 isolated PostgreSQL/PostGIS assertions passed** against mechanically
  transformed copies of the final two RPC bodies and the unchanged legacy
  wrapper, extending the original 47 sender assertions. Application tables,
  auth and quota were temporary fixtures; the transaction ended with ROLLBACK
  and verified those fixture tables no longer existed. No real alert or push
  was sent and no customer records were used by these tests.
- Tests cover both alert types, zero recipients, exact persisted receipts,
  self-push exclusion, failures/rollback, legacy return compatibility, owner
  history, and the existing target identity/armed/fresh/radius boundaries. They
  also cover intended versus unrelated/late-arriving recipients, forged push
  metadata, queue cleanup, private target isolation, grant/push failure atomicity,
  the exact 50-recipient cap and cascading receipt deletion.
- The pre-change live function reproduced the specific 42702 failure in the
  same isolated fixture. The public table's conflicting column was confirmed
  through a read-only catalog query, not customer data.
- Deployment used one transaction with old-function MD5 drift guards, an absent
  migration/new-function guard, bounded lock/statement timeouts and the exact
  SQL in the migration ledger. It did not apply unrelated pending migrations.
- Read-back verified each deployed function body and both ledger entries against
  the tested SQL. The recipient deployment preserves the legacy wrapper byte for
  byte. Anonymous execution is denied; authenticated execution, SECURITY DEFINER
  and the pinned search path are intact. Existing alert-table RLS policies and
  recipient selection are unchanged. The new recipient table has RLS enabled,
  no app-client read/write privileges or policies, and cascading alert/user FKs.
- `VITE_APP_BUILD=113 npm run ship:beta` passed TypeScript, production build,
  web release parity, bundle budget, route audit, Capacitor sync, secret scans
  and all **140** final beta contracts. Main bundle: `main-CjXB1u3f.js`.
- All **418** compiled files byte-match the native public copies. Main SHA-256:
  `d8a63ae0c4f2e45151e98ec01b03b98fc179cd5e052d9ec0c981d3e3ae155640`.
- Scoped ESLint, formatting and migration lint passed.

Migration SHA-256:

- Sender: `69e758e523d32a1de5aebf9c5d8088552d1710bacbd84e907c9cbd1d4cc98e2e`.
- Recipient: `8b63cfc56c27fd438b1e26a69103237ebdb74aa8d1e6a833de22dbe6de991f3d`.

Local evidence and recovery SQL:
`/private/tmp/thalassa-guardian-receipt.VPLy7C/` (temporary audit artifacts,
not durable backups). Includes exact pre-deploy function definitions,
rollback-only fixtures, body comparison hashes, deployment/result/read-back,
guarded deployment and recovery SQL, and build/test logs.

## Limits and follow-up

This verifies sender/recipient storage and feed selection, not real APNs delivery or another skipper
reading an alert. No live safety broadcast was used as a test. The SQL fixtures
stubbed auth/quota; deployed execution grants were separately inspected.

Recipient grants apply to **new canonical broadcasts**, not historical pushes.
There is deliberately no backfill: `queue_self_push` accepts arbitrary metadata
for self-addressed weather notifications, so an old queue row's claimed alert ID
is not trustworthy proof of recipient eligibility. Existing own/target history
is retained without using queue metadata as authority.

The separate `queue_guardian_watchdog_alert` path is unchanged. Its worker
defaults off unless explicitly enabled, and its BOLO recipient rules need a
separate review before applying the same feed grants. This repair covers manual
Guardian reports/weather broadcasts, not a claim of end-to-end watchdog delivery.

On-device acceptance for 113: while armed, a legitimate report should appear
once with **Sent by you**, persist on reopening, and remain visible through a
temporary feed-read failure. Do not broadcast dummy safety alerts to others.
