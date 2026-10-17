# Build 140-02 — anchorage and marina community notes

Source preparation only. No live database/function/bucket/environment change, R2 upload, Pi installation, whole-app TypeScript or production build has been performed by this packet. Root owns deployment and combined release checks.

## Actual user path

- Obs anchorage and marina pin popups have a 44px **Skipper notes / add review** button. The existing original IDs remain unchanged.
- Marine places detail has the same action for catalogue anchorages and marinas.
- The capped review sheet reads at most 12 latest visible notes. A signed-in skipper can create/edit/delete their own note, select observed holding, wind-from protection directions, swell and facilities, add a visit date and optionally submit a JPEG.
- Sharing requires explicit per-post user-content consent, recorded by the server with version2026-10-17 and server time.
- Signed-in readers can report a note (unsafe, abuse, privacy, copyright or spam) or hide its contributor. Reporting immediately holds the entire note and its public photo.
- AdminPanel has a lazy **Place notes** moderation tab. The existing unblocked chat admin/moderator roles authorize its RPCs. Decisions carry exact text/photo revisions; stale decisions fail. Staff can approve/remove text, approve/remove a pending photo, or suspend a contributor.
- The facility layer can call \`openPlaceReviews({id,name,kind:'marina'})\` from \`services/community/PlaceReviewsService.ts\`. The host strips coordinates and unknown fields.140-01 owns that additional facility consumer.

## Source identity and authority

Recognized review keys are original OSM node/way/relation IDs, NOAA LNAM IDs, and existing QLD GBRMPA IDs. Unstable fallback/tile IDs and private chart IDs are refused. The server checks ID syntax; it does not claim to verify that a place exists, that the author visited, or that observations are true.

The latest limited community view adds a descriptive reason to the existing anchorage weather verdict, using a RAM-only128-entry/15-second cache with auth retirement. It never changes the light, weather clocks, shelter/fetch, depth, holding-ground proof, routing, clearance or permissions. Tests compare the complete weather verdict apart from the added reason. No community numeric score is presented as safety evidence.

## Database and projection

Canonical migration: \`supabase/migrations/20261017010813_community_place_reviews.sql\`, created with Supabase CLI2.121.0 at current UTC, after the live139 migration. Earlier task-local untracked/unapplied04216 content was moved into this new CLI-created file; its evidence backup is \`work/community140-original-04216-unapplied.sql\`. Every inherited canonical/held migration remains unchanged.

All raw review, photo, report, block, ban, quota and moderation tables live in non-exposed \`community_private\`, have RLS enabled and no client schema/table grants or permissive policies. Their owners reference auth.users with deletion cascades and existing account-deletion write fences. Both accounts referenced by a personal block are fenced.

The public \`community_reviews\` RPC is a deliberately privileged, bounded projection/mutation API with pinned search_path and explicit anon/authenticated EXECUTE. Anonymous callers can only read the sanitized public whitelist. No supplied owner, role or moderation flag is honored. Anonymous sign-ins cannot contribute. Live account/tombstone and moderator-role checks are used. There is no JWT user_metadata authorization.

The public projection is computed directly from current status, author deletion/ban state and the viewer's blocks. It contains neither owner IDs, photo paths, private moderation/report metadata nor GPS fields. Ordinary text is post-moderated; obvious threat/spam patterns are held early, all ordinary new/edited text enters the queue, and reports synchronously hold it. Editing held/removed text cannot self-clear moderation. Photo approval is separate.

No raw table or projection table is added to Realtime. There is no stored public projection table. Migration refuses an all-tables or community_private-schema Realtime publication. Storage has a restrictive deny policy for this bucket even when an older broad permissive policy exists.

Source bounds:200 notes/account,1200 plain text characters/note, eight defined compass directions/eight facilities,40 successful save/report/block operations/account/UTC day,50 queue entries/read,20 report targets/day,500 personal contributor blocks. Owner deletion remains available independent of posting quota.

## Photos

\`community-review-photos\` is private, JPEG-only and limited to1MiB/object. Clients have no direct Storage read/write or signed-URL route. Object names are owner UUID/random photo UUID, never original filenames or coordinates.

\`community-review-photo\` authenticates getUser() and durable quotas before Storage. It accepts at most2MiB, bounds streamed-body memory and a five-second body deadline, checks JPEG dimensions before decode (at most1600 per side/1.92MP), and uses pinned jpeg-js0.4.4 with64MiB decoder allocation limit. A fresh pixel-only object is re-encoded; EXIF/comments and original bytes are never uploaded. Output must be at most1MiB. The codec is server-only; the app imports only the small JPEG header reader. Client JPEG resize is convenience and independently bounded to12MiB/20MP before a1200px preview.

A reservation locks the actual owner's review/revision before Storage. Finalization rechecks that revision; a report/edit/delete/deletion fence retires late uploads. Failure attempts remove the private uploaded object. Failed removal cannot make it readable. Forty recorded reservations, including retired/orphaned uploads, bound account storage even if cleanup fails; removed private objects remain charged until operator maintenance or account deletion. The UI explains this limit. There is currently no automatic garbage-collection timer.

Pending photos are accessible only to their owner and current moderator. Other signed-in readers need approved photo + visible current review + current author/account/block state. The Edge checks access before and after the awaited Storage download, checks exact identity/revisions/hash/size, then serves no-store bytes. No public or signed URL is issued. Reporting/deletion denies new requests. Bytes already displayed or independently saved cannot be recalled; the UI removes image handles at15 seconds and auth/intent changes. Photos open on demand; opening another closes/aborts the prior one.

JPEG-only is an explicit current limitation. The original image itself can disclose people or a location even after embedded metadata is stripped.

## Both account-deletion reaches

The migration extends the actual live \`account_deletion_storage_inventory(uuid)\` and \`block_tombstoned_storage_write()\` bodies with only the new owner-prefix bucket. Existing buckets, legacy recipes, enc u/owner paths, advisory seed/order, tombstone behavior and grants remain. Service uploads with null Storage owner_id are still inventoried by their owner prefix, including retired objects whose review row has been deleted. The existing generic delete-account Edge drain consumes that inventory; no separate client deletion bypass is introduced.

## Verification and review status

- 77 focused Vitest cases/10 suites PASS: actual component/service intent and auth fences, actual HTTP photo handler with mocked auth/DB/Storage boundary, real pinned JPEG metadata stripping, body memory/deadline, image demand lifetime, weather verdict non-promotion, AdminPanel and existing anchorage/facility regressions. Log: \`work/validation140-community-final-focused.log\`.

- Targeted photo Edge Deno check PASS; the first typed ArrayBuffer error and repaired logs are retained. Final log \`work/validation140-community-edge-final.log\`.
- Scoped new/changed source/tests lint0; existing MapHub has three inherited warnings outside the four-line host seam.
- Migration audit227 files PASS; Node syntax, formatting and diff checks run.
- Four actual-source browser fixture cases PASS: installed Chrome and WebKit2248 at300/375px,130% text, actual Save control/action, page width unchanged and panel/inner scroll width bounded, no page errors. API boundary is fake; this is not a live backend test. Receipt/screenshots: \`work/validation140-community-browser/\`; final exact-source rerun is recorded separately when frozen.

Prepared genuine PostgreSQL17.6 proof:
\`supabase/tests/community-reviews-postgres.mjs\` + minimal disposable auth/Storage host, using the actual canonical account fence and moderator function bodies.
\`.github/workflows/community-reviews-db.yml\` runs only against the exact empty localhost fixture, no product credentials. It records exact source, migration checksum, image identity and pinned pg8.16.3 client lock; preserves failures too.

**No real PostgreSQL PASS is claimed in this source packet yet.** Root must review and dispatch that frozen workflow. It tests raw ownership/ACL/RLS, sanitized fields, anonymous/forged-owner/moderator refusal, Storage restrictive policy, report removal, revision CAS, blocked-owner behavior, quota, original account-deletion reach and late writes. Competing RPCs exercise an explicit cross-owner busy refusal plus blocking-proven edit/finalization races. The fixture refuses product URLs and stray credentials.

## Deployment ordering and genuine remaining gates

1. Review source/migration and run the actual isolated PostgreSQL17.6 job; retain exact successful evidence and repair genuine failures before live changes.
2. Root merges140-01/other140 source, runs combined whole-app compiler, configured budget and release checks; none is implied by this packet.
3. Root preflights actual remote ledger/schema/roles and applies the canonical migration deliberately. Private bucket and deny policies are part of the same migration.
4. Deploy the pinned photo Edge with existing user authentication/quota infrastructure; no new third-party API key is required. Verify denied public/direct/signed requests, pending owner/moderator preview, approved delivery and report/delete revocation with synthetic accounts before feature release.
5. Verify real Storage account-deletion inventory/drain and absence from Realtime/public projections. Existing inherited delete-account orchestration remains the owner of actual Storage removal.
6. Keep a staffed moderation queue and urgent contact response. Automatic screening is deliberately limited; manual moderation and truthful community status are operational requirements, not a claim that all content has been verified.

No automatic source/provider activation, live bucket creation, human moderation, Storage deletion or deployment has happened here.
