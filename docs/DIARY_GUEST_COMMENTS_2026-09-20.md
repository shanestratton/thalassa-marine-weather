# Moderated guest diary comments — backend and public website deployed

Guest nickname + plain-text comment, no account or email required. Submission is
pending until the current owner of the public voyage log approves it. A guest's
pending comment is never optimistically inserted into the public thread.

## Public contract

New Edge Function: `diary-comments`, `verify_jwt = false` because the public form
is credentialless. The function enforces existing persisted HMAC/IP public
quotas (5 submissions/hour; 120 reads/hour), exact production-origin rules,
strict payload validation, and service-role-only database RPCs. Signed-in calls
are verified by the shared helper and have 5 submissions/180 reads per hour.

- `GET ?handle=<handle>&entry_id=<uuid>` returns `{ comments: [...] }`. Rows contain
  `id`, `guest_name`, `body`, `created_at`; approved only, newest first, max 100.
- `POST` JSON: `{ handle, entry_id, submission_id, guest_name, body, website }`.
  `submission_id` is a UUID reused for a retry of identical text. `website` is an
  empty honeypot. Success is HTTP 202 `{ ok: true, status: 'pending' }`.
- A failed/uncertain POST retains the guest's draft and retry ID, including when
  refreshing the approved comment list. Switching entries clears and aborts it.
- Name max 60 Unicode characters; body max 2,000. No HTML, URL schemes or control
  characters; body permits line breaks/tab. Request body max 16 KiB.
- Responses use `no-store`. Public boat origins allow exactly one valid handle
  label on `https://<handle>.thalassawx.app` and `.com`, plus the existing exact
  apex/www hosts. Nested labels, credentials, extra ports and suffix attacks are
  rejected. Exact localhost 3000/4173 origins are development-only exceptions.

## Authorization and moderation

Migration: `supabase/migrations/20260920120000_moderated_diary_guest_comments.sql`.
No existing diary/boat/voyage permissions are widened.

Publication is checked again on every public read and submission: entry public,
log enabled, matching boat, and either the log owner's entry or an eligible
combined-log boat member's entry. Disabled sharing, unpublished entries and
removed crew stop visibility. A transferred log invalidates approvals made by
the previous owner until the new owner approves them.

Authenticated clients have only RLS-scoped SELECT on the new table. They cannot
directly insert, rewrite, approve or delete comments. The owner-only
`moderate_diary_guest_comment(comment_id, 'approve' | 'reject')` RPC checks current
ownership and the existing persisted moderation quota. Rejection also removes
an already-approved comment from public reads. Guest text cannot be edited.

`DiaryCommentModeration` mounts in the app entry view below its media. As of
21 September it opens by default and loads the selected entry's review queue
immediately; it does not fetch a queue for every diary-list card. It can still
be collapsed and refreshed, puts pending comments first, and requires server
confirmation before changing approval state. Account changes fence stale responses. Public
`PublicDiaryComments` mounts in the website's entry detail, not the feed.

## Bounded resource impact

- One new indexed text table, one Edge Function; no paid external service,
  notification/email worker, cron, new secret or new npm dependency in the repo.
- Transaction advisory lock per log serializes caps: 100 pending per entry/log
  and 200 new comments per log in a rolling 24 hours. Identical retries do not
  create rows. Public reads max 100; owner queue max 200, pending first.
- Guest email and raw IP are not stored. Existing shared quota stores its HMAC
  pseudonym. Comments persist until their diary/log is deleted (cascade); this
  change intentionally introduces no destructive automatic retention job.
- Public requests are on-demand: no background polling or per-feed-entry fetches.
  In-app diary cards fetch review counts in metadata-only batches (100 entry IDs,
  500 rows per page), never comment bodies per card. While the Diary page is
  mounted and visible, counts refresh every minute, on foreground/reconnection,
  and after confirmed moderation. Requests stop when composing/unmounted and
  skip hidden pages. No persisted badge cache or new scheduler is introduced.

## Verification and release boundary

`scripts/check-diary-comments-db.mjs` executes the real migration in a fresh
in-memory PGlite PostgreSQL. It passes 49 assertions covering actual grants/RLS,
direct-function denial, publication/ownership revocation orderings, bounded
payloads/queues, idempotency and cascade deletion. The fixture substitutes only
existing auth identity/quota helpers and minimal existing tables. PGlite is
single-session: this is not a concurrent multi-session lock stress test.

Reproduce with an isolated `@electric-sql/pglite` installation, without changing
project dependencies or contacting the linked database:

```sh
PGLITE_MODULE_PATH=/absolute/temp/node_modules/@electric-sql/pglite/dist/index.js \
  node scripts/check-diary-comments-db.mjs
```

Six focused Vitest suites pass 49 tests: `DiaryGuestCommentsContract`,
`DiaryCommentService`, `DiaryCommentsApi`, `PublicDiaryComments`,
`DiaryCommentModeration`, `SupabaseEdgeJwtPolicyContract`. Edge Deno typecheck also
passes. The parent independently checked the migration against the linked schema
inside BEGIN/ROLLBACK, retaining no changes.

## Deployment evidence — 20 September 2026

The parent applied only this additive migration, with its migration-ledger row
in the same transaction, after a linked-schema BEGIN/ROLLBACK dry-run. Verified
remote version `20260920120000`, RLS enabled, and zero comment rows. No existing
diary entries were changed. The CLI reported a telemetry-shutdown timeout after
the SQL succeeded; a fresh read confirmed the atomic commit, so it was not retried.

Only `diary-comments` was deployed from an isolated bundle (version 1,
`verify_jwt=false`), preserving the existing live shared auth/quota and HTTP
helpers. Credentialless probes from `https://serene-summer.thalassawx.app`
confirmed an unknown-entry read returns an empty list with `no-store`, malformed
submission returns 400, and a foreign suffix-attack origin returns 403 without
CORS permission. No real guest comments were submitted or approved as tests.

The matching UI is built and copied into the local iOS project. The public
website was published with explicit approval on 20 September 2026 as Vercel
deployment `dpl_D1P6gYc1d4guNsPZBYzvom8D3S9E`. It serves `logs-C2Yi6yUr.js` at
`https://serene-summer.thalassawx.app` and the matching `.com` boat domain.

Because hosting is shared with the app and `/plan`, the release used the live
baseline commit `2b5fa8d18f4ef03aaba5334af32c15e7347c9127` plus only `logs.html`
and seven public-renderer files. The app-wide dirty worktree was not published
wholesale and the synced iOS assets were not replaced. The isolated baseline
passed 60 public unit tests and 16 Chromium/WebKit layout journeys. Hosted
document/asset/header checks passed; a real public entry's comments read and
form loaded in the production browser without errors. No test comment was
submitted to that entry. Prior deployment for rollback:
`dpl_EuUUgRNt4o6sVKfcVfCRQ3oVJWJq`.

## In-app discoverability — 21 September 2026

Vessel → Diary → open an entry → Guest comments. The approval section beneath
that entry now opens automatically, shows its pending count and offers Approve
or Reject. Approved comments can be removed from the public page. Offline-only
entries do not query cloud moderation; review buttons are disabled during a
refresh, and account changes discard stale results. Existing owner-only RLS/RPC
rules are unchanged; no database or public-site deployment was needed.

47 focused tests (including full entry-view approval placement), scoped ESLint,
production build and Capacitor sync passed. Native assets match the web build:
`main-DjR7xLWi.js`, `logs-CRyxbn-U.js`. Logs:
`/private/tmp/thalassa-diary-approval-{tests,lint,build,sync}.log`.
No phone install, real comment moderation or TestFlight upload was performed.

### Pending-comment card highlight

Entries with comments awaiting this skipper's approval have a static soft amber
halo, amber border and an explicit comment-count label. Selection retains its
blue border/checkbox. Counts include earlier owners' approvals needing renewed
review, exclude rejected/current-owner-approved rows, and rely on the existing
owner-only RLS. Account changes clear the in-memory counts and fence late reads;
failed refreshes retain last-known highlights and expose a Retry control instead
of incorrectly claiming an empty queue. Successful moderation triggers a fresh
count, removing the highlight when nothing remains to review.

Verified with 118 focused tests across nine app/public suites, scoped ESLint,
full TypeScript/production build and Capacitor sync. The static highlight was
visually checked down to a 320 px phone viewport, including selected-card styling
and disappearance when the fixture review count reaches zero. Native copied
assets match `dist`: `main-DKvZvrhN.js`, `logs-CCUlnF4a.js`. No physical-phone
install or TestFlight upload was performed.

## Public no-route diary default — 21 September 2026

On first successful load, a page with no usable planned route selects All diary
entries and opens the Diary panel (including on phones). A sailed track alone
does not count as a loaded route. Entries sort newest first with stable ID ties;
the original map/API data is not mutated. Later explicit trip/view choices are
preserved through refreshes. Latest already resolving to all diary entries does
not cause another request, preserving access to that mode's live instruments.

Published as `dpl_9z8zDsa6ppEbj3fT8mZBFnDpaywU`,
`https://thalassa-h9z88sq1e-serene-summer.vercel.app`. Both boat domains serve
`logs-CRe7xgGC.js` and retain noindex/nofollow/noarchive. The production browser
shows all six current public entries in descending date/time order. This was
the same isolated baseline as the September 20 release, plus its eight public
runtime files and the new `src/publicDiaryDefaults.ts`; no app-wide dirty tree,
backend, migration, or shared CSS changes were published. The isolated version
passed 62 public tests before the staged candidate was checked and promoted.
Rollback: `dpl_D1P6gYc1d4guNsPZBYzvom8D3S9E`.

Post-promotion hosted release checks passed on `https://www.thalassawx.app`,
including shell/security headers, v2 marine generations and retired legacy
endpoints. Live desktop and 390 px phone checks confirmed All diary entries is
selected, Diary is initially visible, and all six entries descend from September
20 to September 15. No public comment was submitted or moderated as a test.
Logs: `/private/tmp/thalassa-diary-sept21-{final-tests,final-lint,isolated-tests,promote,hosted-check}.log`.

This presentation correction does not restore missing sailed tracks or change
lifecycle Start markers. The separately requested read-only investigation is
documented in `VOYAGE_HISTORY_AUDIT_2026-09-21.md`.
