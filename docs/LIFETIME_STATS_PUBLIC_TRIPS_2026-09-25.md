# Lifetime statistics and public trip overview — 25 September 2026

## Requested behaviour

- Archiving is a filing action, not a reduction in in-app lifetime voyage statistics.
- The public “All diary entries” selection becomes **All trips & diary**: recorded
  tracks and published diary locations together, with diary entries newest first.

## Lifetime statistics

All six Log metrics and the All Voyages statistics screen use the same lifetime
summary set, including archived history. Passage legs are counted as individual
voyages; sea time is summed per voyage, not across time spent between trips.
Planned routes, imported routes, land trips and confirmed never-departed recordings
do not contribute. The UI labels the scope “Lifetime · includes archived”.

The source aggregates before filtering archive state, so an older voyage with
both archived and unarchived rows is still one complete trip. Failed refreshes
retain the last complete lifetime result with a notice rather than replacing it
with a partial total. Only the legacy unnamed-voyage bucket needs targeted
row-level reconciliation; ordinary totals do not download full GPS histories.

## Public overview

The API selector remains `trip=all-diary` for existing links and clients. Only its
display label changes. The overview returns every eligible public voyage within
the existing publication window, plus all published diary posts (including posts
not linked to a voyage). Owner/boat scope, explicit hidden-trip choices and diary
publication consent still apply. Existing archived-track privacy is unchanged;
showing archived voyages publicly requires the owner's separate decision.
Retired live-tail IDs are read independently: a previously deleted voyage cannot
reappear from live points left behind by a failed purge. That fence does not hide
restored durable voyage history.

Geometry is paginated and budgeted per voyage. Each voyage keeps its endpoints,
and dense newer tracks cannot consume the entire overview budget. The client
groups by voyage identity and draws separate lines, never a connector between
different voyages. Photo/story locations are included in the overview framing.
Choosing the overview opens the map on phones; Map and Diary remain separate
reachable views. Planned routes, live instruments and live AIS are not shown as
historical-trip data.

Overview history reads complete or fail explicitly rather than silently returning
a capped prefix. `track_meta` reports raw/returned point counts, voyage count and
the publication-window boundary. Completeness is conditional on readable public
visibility authority. No sharing settings or customer records are changed by
this implementation.

## Verification and release

- Focused client and public-history tests cover trip separation, map photo pins,
  default selection, history pagination, endpoint retention and privacy filters.
- Public voyage browser checks pass on Chromium and iPhone WebKit, including
  narrow phones, landscape, tablet and desktop layouts.
- Verification completed: 161 focused lifetime/archive/hook/UI tests, 87 focused
  public client/history tests, and the final backend retirement regression suite
  (67 tests). All 20 public voyage browser cases pass. Scoped ESLint, Deno type
  checking, the production TypeScript/Vite build, iOS Capacitor sync and client
  artifact secret checks pass. The build still reports its existing large-chunk
  advisory; it completes successfully.
- The implementation turn did not deploy. At the subsequent explicit request
  “ok update website changes”, the website and `voyage-log` Edge Function were
  published (release details below). The iOS bundle remains synced but has not
  been installed on the phone.

## Published release

- Vercel production: `dpl_t5kEZ9s7XWV9vzq6RtSy71JmAQ1k`,
  `https://thalassa-2tjtq9j2p-serene-summer.vercel.app`.
- Previous website rollback reference: `dpl_9KeycKbZYsdEqxR8AMvcWzp9L8KN`,
  `https://thalassa-k54bahshc-serene-summer.vercel.app`.
- Supabase `voyage-log`: v71 → v72, ACTIVE. `verify_jwt=false` unchanged.
  Previous deployed function source is retained at
  `/tmp/thalassa-voyage-log-rollback.ei80w3` with its restoration command.
- Unauthenticated API verification returned six eligible shared voyages,
  11 public diary posts and 8,527 displayed points from 43,732 samples, plus
  34 waypoints; `complete=true`. These counts are a release-time snapshot.
- No archive/public-sharing settings were changed. Read-only validation showed
  all six current voyages were already unarchived when this release began.
- Authenticated candidate checks confirmed the overview and lifetime-statistics
  bundles before promotion. Serene Summer's `.app` and `.com` diary URLs and
  `.app/plan` now return the new bundles with their no-index headers preserved.
- The complete post-promotion hosted web-release check passed, including live
  marine-data discovery/assets and retired legacy endpoints.
- No database migration, Pi deployment, TestFlight upload or Git push.
