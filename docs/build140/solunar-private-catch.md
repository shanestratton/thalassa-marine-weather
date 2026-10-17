# 140-06: Solunar and private catch details

Source packet from 140-07 `13212163bb3356011d73494c3c70f993d0ae8fc2`. Its reviewed private catch sidecar is now deployed and read back with four owner policies and no Realtime membership; see [live deployment](live-community-deployment.md). Native versions, ChatPage, providers and Pi installation are separate.

## Solunar

The existing Sun and moon sheet adds traditional two-hour major windows around upper/lower lunar meridian transits, and one-hour minor windows around moonrise/moonset. These are approximate astronomical windows, explicitly **not predictions of fish activity**. There is no bite score.

`getMoonTransits` uses the existing Astronomical Almanac moon-position model's hour angle. It searches the actual local civil day, including 23/25-hour daylight-saving days, using at most 52 half-hour brackets and 24 bisections per crossing. Upper and lower crossings are calculated independently; a missing crossing is never replaced with a guessed 12-hour offset. Exact poles, invalid coordinates/dates/zones are unavailable. Circumpolar absence of rise/set leaves those minor windows empty while meaningful transits remain available. Window labels mark a previous/next calendar day across midnight. Existing sheet bounds and internal scrolling remain.

References reviewed 17 October 2026:

- [USNO: rise, set, twilight and transit definitions](https://aa.usno.navy.mil/faq/RST_defs).
- [SunCalc primary source and API](https://github.com/mourner/suncalc): the app retains installed 1.9.0. Current upstream 2.0 has changed units/API, so this packet does not upgrade it.
- [Solunar: traditional window durations](https://www.solunar.com/how-to-read). Only the conventional duration definition is used; no feeding/activity claims are adopted.

Existing USNO rise/set fixtures still pass. New transit tests independently check the meridian crossing against installed SunCalc's lower-precision coordinates in a +/-15-minute bracket, including a near-zenith case where azimuth alone is ill-conditioned. They are geometry checks, **not independently fetched USNO transit-accuracy fixtures**. USNO API retrieval was unavailable; no claim of an external numerical transit calibration is made.

## Catch privacy

Fish Quick Log and the actual Sighting Detail sheet add optional catch species, length in centimetres (one decimal, 0–2000 exclusive of zero) and kept/released/not recorded. These are separate from the existing shared catalogue species and remarks. Fields save on blur/change through the real owner-scoped local store and sightings startup outbox. Native select chrome and labels follow dark/daylight themes; touch targets remain at least 44 px.

The roadmap's private columns cannot safely be added to `sightings`: that table deliberately grants authenticated whole-row reads to crew and participates in Realtime. The approved alternative is owner-only `sighting_catches`, keyed to the actual fish sighting, with RLS and immutable identity columns. Crew visibility on the parent remains unchanged. No catch fields enter `SightingRow`, public/shared projections, Darwin Core, base-row INSERT/PATCH bodies, crew caches or Realtime publication.

Local edits use an atomic IndexedDB read/modify/write transaction, abort on an auth-generation change, and refuse to recreate missing rows. Anonymous catches remain on the phone until explicit adoption; adoption is atomic and identity-fenced. Ordinary asynchronous base/photo writes preserve a newer private revision and cannot reintroduce a private snapshot after a purge. Real memory and IndexedDB backends support this boundary; injected backends without atomic update support refuse private edits.

The existing outbox sends at most 50 private records per round, after the parent is server-known and the real session matches the captured owner. A duplicate INSERT uses an owner-filtered PATCH of mutable fields only, respecting column grants. A pending private failure does not fail or resend the shared parent. Unavailable cloud storage is shown truthfully; data remains on the phone with bounded retry delay. Clearing fields or regrouping away from fish queues sidecar deletion. Another device's private edits are read on demand when opening the own fish detail, without adding a shared feed or channel.

## Migration and deletion

`20261017030800_private_sighting_catches.sql` was generated with the existing Supabase CLI 2.121.0 using `migration new private_sighting_catches`; it has **not been applied live**. The migration grants only authenticated owner CRUD, limits UPDATE grants to species/length/disposition, enables RLS, binds INSERT/UPDATE to the real observer's fish sighting, and attaches the existing account-deletion tombstone write fence. Parent and auth-user deletion both cascade. There is no bucket, deletion-worker rewrite or new security-definer function. A schema-wide or all-table `supabase_realtime` publication refuses the migration before creating the table; the migration never widens or changes that publication.

Supabase [column security](https://supabase.com/docs/guides/database/postgres/column-level-security), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Realtime publication](https://supabase.com/docs/guides/realtime/postgres-changes) guidance and current changelog were reviewed. Actual disposable PGlite PostgreSQL executes the canonical migration and the real existing tombstone function: 31 checks pass for owner/crew/anon grants, hidden-row writes, constraints, ownership columns, tombstones, both cascades and both prohibited publication configurations. This does not claim a live Supabase replay or advisor result. Integration still needs the release owner's database review/push and whole-app compiler/build budget checks.

## Proof

- `work/validation14006-private-lifetime-final.log`: **229 tests / 11 suites PASS**, including existing celestial, Sun/Moon, sighting service/sync/deletion, Quick Log, page, exports and migration contracts.
- `work/validation14006-private-sql-final.log`: **31 actual PostgreSQL checks PASS**, offline WASM runtime, no live changes. Reproduce `supabase/tests/private-catches-postgres.mjs` with `PGLITE_MODULE_PATH` pointing to an existing PGlite entry.
- `work/validation14006-lint-lifetime-final.log`: scoped lint **0 errors / 0 warnings**.
- `work/validation14006-browser-lifetime-final.log`: **4 real Chrome/WebKit cases PASS**, 300/375 px at 130%, zero retries, unfiltered page errors or external requests. Native IndexedDB reload preserves fields; actual base INSERT/PATCH/export outputs exclude them; identity change hides them. Exact outer document dimensions, bounded sheet rectangles and >=44 px fields are asserted. Live theme switching checks native picker scheme and actual daylight label colour.
- `work/solunar140-browser-lifetime-final/`: 12 screenshots plus fictional owner/projection evidence. Earlier failed/intermediate logs and screenshots remain retained; the first browser run was interrupted after a WIP edit caused HMR and is not source proof. Visual review of the intermediate green run caught the native dropdown/label contrast issue; final catch-specific styling repairs it.

These are source and local fixture proofs. No whole-app TypeScript compiler, configured production build, live migration, upload or TestFlight release was run for this packet.
