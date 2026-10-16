# Confirmed voyage engine time

This checkpoint connects explicit Log engine declarations and source-clock-qualified RPM to an ended-voyage review, plus the Engine Instrument Panel section. The owner-confirmed engine-hours backend is deployed; the app source targets native build136.

The counter has no speed/polar heuristic. Time before a declaration or outside a measured RPM window stays unknown. A measured RPM sample can override a declaration only for13 seconds after its original sensor clock; repeated/late/future samples cannot renew it. Pausing or changing account retires the declaration and RPM evidence, keeping that gap unknown. Normal cold-start continuation preserves its explicit declaration. A backwards or implausible clock marks the counter for manual meter review. End freezes the counter once, after verified GPS teardown.

Ending a voyage publishes only a local UI event, so it never waits for a database, provider, UI chunk or confirmation. The review is lazy. The skipper checks the current Maintenance reading and that it belongs to the same boat/engine before pressing **Add recorded time**. Nothing is added automatically. Maintenance can reopen the latest ended counter; starting another voyage replaces this latest local review record. The underlying voyage log is unaffected.

The existing Maintenance meter is a whole-hour reading per owner. The new authenticated RPC locks that row, rejects a stale expected reading, and records an immutable owner+voyage receipt. Partial hours carry as seconds toward the next whole hour. A later manual meter edit supersedes an older fractional estimate. A duplicate exact confirmation returns its receipt without changing the meter; a conflicting confirmation requires review. Current-boat/account/binder and unresolved local meter edits are checked before a request. The app refreshes the mirror after success; it never queues a second absolute meter update.

Measured time requires an explicit engine identity and exactly one reported engine. The counter pins the first accepted identity; missing metadata, multiple reported engines and another engine's readings cannot add measured time. The review names that identity beside its time. The existing aggregate RPM gauge is not an individual engine-hour meter. The skipper still checks the intended boat and meter explicitly; no manufacturer's meter is invented or overwritten aboard.

The voyage also pins the first qualified instrument feed. Direct Signal K uses the account, configured client and reported vessel identity, while its live session remains separately fenced. Retirement clears measured RPM immediately without clearing an independent skipper declaration. A same-vessel reconnect needs a newer sensor clock; another vessel with an engine also called `main` cannot contribute to that voyage. These local counter identities contain no access token and are not sent to the maintenance RPC. Five focused regressions cover retirement, reconnect gaps, reloads, conflicting engines and declaration preservation; the combined six-suite check passes59 tests.

A paired Pi must also report a verified vessel identity for measured maintenance
time. Version2 of the existing engine pack appends a24-character SHA-256-derived
key for Signal K's validated self URN; the raw URN is not published. Its RPM-only
fallback carries the same key in the existing RPM-source scalar. No extra scalar
is added. A Pi changing vessel UUID cannot combine two engines both named `main`.
Legacy unqualified Pi readings retain their gauges and source-clock panel values;
the skipper's independent declarations remain usable. They do not silently gain
a maintenance-meter identity. Conflicting metric/RPM-source identities are refused.
The populated actual supplement/history/AIS/Edge round trip still fits40 keys and
4KiB with this qualified format.

`20261016175740_confirmed_voyage_engine_hours.sql` was applied live under the recorded ledger version on16 October2026. Its exact SQL SHA-256 is ebc41e5df949e28881f4c4512b3ea7036b6af856764dc9e0badf2eaa661d1fff. Read-only postflight checks verified owner-only access, an empty receipt/carry ledger, and an unchanged existing meter. No live confirmation or meter update was invoked. New receipt/carry tables permit only owner SELECT; mutations go through the authenticated, search-path-pinned RPC. The RPC contains its own `auth.uid()` boundary and updates that owner's existing meter only. No positions, chart data, voyage timestamps or provider credentials enter these tables.

Validation so far:

-105 focused counter/review/recording lifecycle tests pass, including account changes, all pending/syncing/failed meter edits, changed active boats and ignored late results.

- The isolated PostgreSQL transaction/privacy fixture and16 real concurrent sessions passed on [run38886556230](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/38886556230), exact database source228b3c83c and definitiona01f11d79: one application and15 duplicate no-ops. This proof does not deploy a migration.
- Full app TypeScript and owned ESLint passed before the final narrow review changes; final combined source/browser checks remain pending.

Signal K engine units are defined in its [primary vessel schema reference](https://signalk.org/specification/1.7.0/doc/vesselsBranch.html): revolutions Hz, runTime seconds, temperature Kelvin and oil pressure Pascals. Device readings and calibration still need hardware verification.

The Engine section appends to the existing fixed panel order, is optional in device Preferences, and auto-hides without identified fresh RPM. Its meter, coolant and oil values come only from the same identified engine. `coolantTemperature` is distinct from general engine `temperature`; no substitution is made. Each value ages on its original sensor timestamp, dims after6.5 seconds and becomes unknown after13 seconds. Multiple reported engines are labelled and their meters are never combined.

The Pi emits one bounded `engine_metrics_v1` scalar `[1, engineId, baseEpochMs, runTimeSeconds, offsetMs, coolantC, offsetMs, oilKPa, offsetMs]`. It replaces the separate RPM source scalar only when the complete payload fits120 characters. Long identifiers or missing valid metrics retain RPM-only metadata. The full populated sensor/watch/history/AIS path still fits40 keys and4KiB, and its actual Edge parser round-trip preserves every key. Signal K fields with absent timestamps, incompatible units or invalid ranges remain unknown. This source belongs in staged Pi update6; it is not installed aboard.

Combined checks:71 focused panel/counter/review tests pass;12 real Chrome/WebKit cases pass at300/375 pixels, including Engine geometry, performance suppression, current guides and source retirement. The narrow WebKit Engine screenshot was inspected. Actual end-to-end iPhone sensor readings and a physical meter comparison remain unverified.
