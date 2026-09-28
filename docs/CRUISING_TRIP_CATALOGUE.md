# Shared cruising-trip catalogue foundation

Status: **undeployed**, empty and not connected to the day-planning calculation or UI. There are no seeded destinations, routes, publication claims or private sailed-track imports. This is a database/read-client foundation, not a working worldwide collection of reviewed trips.

## Product boundary

The catalogue contains shared editorial destination references, trips between exact destination versions, and separately reviewed directional route variants. Private voyages and sailed tracks remain separate. No ownership, consent, copying or publication of private tracks is implied by creating this catalogue.

“Reviewed” means an editor has examined the stated evidence within the recorded review scope. It does not mean safe, charted, navigable, currently accessible, clear of hazards or suitable for a vessel or weather forecast. The client exports a limitation string for a future consumer. Catalogue coordinates are reference positions; they are not certified anchoring/landing points or approaches. No route should become a navigable recommendation solely because it exists here.

## Data and lifecycle

`cruising_catalogue_entries` is the stable identity, kind, publication state and current-version pointer. State is `draft`, `published` or `withdrawn`; withdrawal requires a reason. `cruising_catalogue_versions` stores append-only content for all three kinds. Stable identities cannot change kind, and the current version cannot move backwards. Corrections and re-review require a new version; even draft version content is immutable. Lifecycle/pointer updates are mutable and are not a complete editorial audit log.

Leaving `withdrawn` for either `draft` or `published` requires a strictly higher, non-null current version. A withdrawn identity with no previous version must acquire its first version before leaving withdrawal. Clearing a withdrawal reason or passing through draft cannot republish the same withdrawn content. Pointer rollback remains prohibited after that transition, so the old destination version and its exact-version dependants remain unreadable. Replacement content must still satisfy the existing review and dependency checks to become readable.

Every version contains a reference position, short description, limitations, source evidence and explicit review status. Every evidence item requires an HTTPS source link, label, retrieval timestamp, licence, licence URL, attribution and evidence scope. Retrieval and review dates are different. A reviewed record also needs reviewer label, review scope, review timestamp and a strictly later review expiry. The reviewer label must be approved for public display; no private user identity is queried. Stored licence metadata is not an automated determination that reuse rights are valid: the editor must verify that decision before publication.

Trips reference exact origin and destination versions. A route variant references an exact trip version, declares `outbound` or `return`, and contains 2–256 ordered required checkpoints with evidence notes. Positions must be in bounds, orders consecutive, adjacent checkpoints distinct, and directional endpoints equal the trip's exact destination reference positions. Checkpoints may describe a known corridor, but connecting them does not prove obstacle clearance. A return variant is supplied independently; the client never invents one by reversing an outbound route.

Ordinary signed-in users can read only current, published, reviewed versions while their reviews remain fresh. Pending or expired reviews fail closed. A trip also requires both exact destination dependencies to remain readable; a route variant requires its exact trip dependency. Superseding or withdrawing a dependency hides dependent versions on subsequent reads. Backend maintenance must republish newly reviewed dependent versions deliberately; it cannot silently update their geometry or endpoint references. Exact requests for superseded, withdrawn, stale, draft or unknown versions return `null`, without substituting the latest version.

Only the trusted backend `service_role` can insert versions and manage lifecycle/current pointers. There is no client-side editor role, insert/update policy, or exposed write RPC. Default table privileges are explicitly revoked, including the service role's inherited privileges, before granting the minimum operations. Version triggers reject edits/deletion; entry deletion is rejected in favour of withdrawal. Database owners remain administrative authorities and can change schema or disable triggers outside this application contract.

Publication state alone is insufficient for visibility: current review and dependency checks apply to RLS and both RPCs. This conservatively permits a backend to mark an incomplete record published while keeping it unreadable; an editorial workflow should verify read-back before declaring publication complete.

## Read contract and performance

`nearby_cruising_catalogue(latitude, longitude, radius_nm, limit)` returns destination/trip summaries without checkpoint geometry. Radius is positive and capped at 100 NM; result count defaults to 24 and is capped at 50. A PostGIS geography GiST index supports `ST_DWithin`; coordinates cover poles and the dateline. A trip's search position is its origin destination. This finds nearby departures, not every route crossing a viewport. Results are ordered by distance and stable identity. An empty or truncated bounded search does not prove the absence of other destinations or trips.

`cruising_catalogue_detail(id, version)` lazily returns one exact version. A trip includes at most 32 available directional variant references, with `variants_truncated` signalling additional choices. Variant geometry is fetched with its own exact detail call. The schema supports a global collection, but regional coverage, editorial staffing and query performance at production scale have not been established. Direct table reads still obey RLS but do not inherit RPC radius/result bounds; global abuse/rate controls need a separate metered boundary if required.

`services/dayPlanner/catalogue.ts` exports `createCruisingCatalogueClient(authenticatedSupabaseClient)`, a read-only factory exposing `nearby(...)` and `detail(...)`. Both require an `AbortSignal`. The caller passes the existing authenticated client explicitly; this module creates no client, reads no credentials, writes no database records and loads no private tracks. It is not imported into the current planner. A future caller must await fresh detail before using a selected reference and handle a `null` result as unavailable.

The client validates identifiers, exact versions, publication/review dates, positions, request/result bounds, evidence, licence links, kind-specific fields, direction and every checkpoint. It rejects the complete response if one item is malformed. Response limits are 128 KiB for summaries and 256 KiB for detail. These checks apply after Supabase has parsed the response; they do not implement a streaming transport byte limit. Server field/count limits bound returned payloads, and arbitrary unknown fields are never propagated into consumer objects.

There is no cache or latest-version fallback. Withdrawal becomes effective on the next database read after the withdrawal transaction commits; the foundation does not revoke content already downloaded or push a notification to an open screen. Offline use, retention, realtime invalidation, version-history authorisation and saved-plan refresh rules must be designed before integrating navigation or offline planning. Nearby requests send the supplied reference coordinates to Supabase; the client does not persist them, but deployment logging/retention policy still needs review.

## Backend maintenance outline

Use a trusted server process, never a service-role key in the application bundle:

1. Create a draft identity with no current version.
2. Insert an immutable version with verified source/licensing metadata. A pending review may be stored as a draft; it will not be readable.
3. For review or content changes, insert the next version, including fresh review scope, timestamps and evidence. Publish destinations before their trips and trips before variants.
4. In a transaction, set the identity's current-version pointer and publication status. Check the corresponding read RPC using an ordinary authenticated test account.
5. Withdraw with a reason when evidence or access changes. Insert and review replacement versions, then deliberately refresh dependent versions before republishing them.

No editorial admin interface, ingestion pipeline, licence verification service, notifications, automated review scheduling, publication history, or test account is created by this foundation.

## Verification and deployment limitations

The focused Vitest file uses synthetic fixtures and mocked Supabase responses. It exercises bounded requests, malformed/stale/unreviewed payloads, exact-version identity, ordered required checkpoints, licensing metadata, aborts and transport failures. Its SQL checks are **source contract checks**, not executed RLS or SQL integration tests.

Implementation checks on 28 September 2026: `npx vitest run tests/dayPlannerCatalogue.test.ts` passed all 69 tests, including the withdrawal-exit source regression check; isolated TypeScript checking of the new client and test passed; focused ESLint passed; and `node scripts/audit-supabase-migrations.mjs` passed across 173 migration files. These were focused checks, not a full application build or project-wide typecheck.

No local PostgreSQL executable, Docker runtime or existing listener on the normal local Supabase database port was available during implementation. No database was started, reset or migrated; no live project was queried or changed. This migration has not been parsed/executed by PostgreSQL, and database permissions, triggers, PostGIS query plans and performance are **unverified**. The migration recognises the repository's existing PostGIS schemas (`public` or `extensions`) and refuses other layouts rather than relocating extensions.

Before any deployment, apply to an isolated disposable database containing the project's existing PostGIS setup. Exercise real `anon`, `authenticated` and `service_role` transactions: anonymous denial; denied client writes; current-only reads; expired/future/pending review denial; exact-version null after supersession; dependency withdrawal; denied same-version withdrawal exits both directly to published and through draft; withdrawn entries with null version pointers; newer-version recovery with old dependants remaining hidden; immutability including service-role update/delete/truncate denial; cross-kind/self references; invalid endpoints/checkpoint order; boundaries and NaN/infinity; transaction rollback; and licence/evidence constraints. Run `EXPLAIN (ANALYZE, BUFFERS)` with realistic synthetic scale to confirm spatial index usage. Repeat schema checks against both supported extension locations. Successful mocked tests or the migration source audit do not substitute for these checks.

Deployment and current-planner integration require separate work and authorisation. No build, full-project typecheck, commit, deployment or change to the running development server is part of this foundation.
