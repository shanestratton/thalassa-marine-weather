# Log departure timing — 23 September 2026

Loading/following a route and arming GPS recording are not push-off. For device
voyages with sufficient recorded movement evidence, elapsed voyage time is
derived from GPS-confirmed movement. Recording itself is unchanged: all fixes,
original timestamps and the original recording-start marker remain available.

Confirmation needs three distinct-timestamp fixes at 0.8–80 knots, spanning at
least 30 seconds and 30 metres net displacement. When cumulative distance is
known it must increase too. A stationary/invalid fix or a gap over 20 minutes
breaks the candidate sequence. Once confirmed, time counts from the first fix
in that sequence, not the confirmation time. Subsequent stops do not reset it.
This is an estimate of departure, not an exact lines-off sensor; very slow
manoeuvring or sparse/missing GPS can delay confirmation.

Live Log shows “Recording · awaiting departure” with zero elapsed time until
confirmation. Saved cards, sea-time totals and statistics use the same rule.
The cloud summary adds `departed_at`, leaving `started_at` as the original
recording bound. A partial local tail cannot replace an established cloud
departure, including after reopening while stationary. Old servers/caches
without the new field retain their existing time behavior until refreshed.
Dense earlier device voyages now use the same departure estimate. Sparse earlier
voyages without confirmed movement retain their original recorded span; new
voyages remain at zero until movement is confirmed. Imported/planned tracks
retain their original durations. The end remains the recording stop, not an
inferred arrival: stops after departure count toward elapsed passage time.

Cards, Longest and total Sea Time share `formatVoyageDuration`: days plus hours
for spans of 24 hours or more, hours plus minutes below that. No rounding a
25-hour passage up to two days or dropping 46 hours down to one day.

## Passage surround

`PassageLogList` gives known passage members one purple surround and yellow
PASSAGE heading, without combining/deleting logs or changing their actions.
`get_voyage_summaries` supplies `passage_group_id` through exact saved-route /
voyage-plan links, with owner-scoped `log_passage_memberships` for confirmed
legacy associations. It is cached with the summary for offline use. Ambiguous
links and unrelated overnight badges never establish membership. There are no
extra per-card requests, and public followed-route links are unchanged.

The skipper explicitly identified Serene Summer's three September northbound
logs as one passage. Their legacy/recovered records lacked plan links; three
display-only membership rows now associate them with `trace-msmostgg-pl4k`.
No raw ship-log records, diary records, distances or timestamps were changed.
Verified after migration `20260923120000_log_passage_display`:

| Leg                                        | Points retained | GPS departure → recording stop |
| ------------------------------------------ | --------------: | -----------------------------: |
| Newport → Callemondah (recovered Pi track) |          16,018 |                        46.27 h |
| Callemondah → Mackay                       |          18,286 |                        32.86 h |
| Mackay → Whitsundays                       |           5,691 |                         8.15 h |

Recovered Newport times retain the recovery's known limitation: its exact
original stop time was unavailable. These are recorded/estimated spans, not
claims of exact berth departure or arrival times.

Verification: 82 focused tests, isolated PostgreSQL migration checks (including
membership RLS, cross-owner rejection and preservation of point counts), mobile
WebKit rendering of the real log cards at 430 px without horizontal overflow,
production build and Capacitor sync. The iPhone still needs the Xcode build
installed to show the new UI; no TestFlight upload or public-site deploy.

The passage-planning nudge is restricted to fresh follow/start actions on Log
or Plan. Restoring a route at startup does not raise it, and leaving those
screens clears it. Glass and OBS never display it. Route reversal is unchanged.

Verification: `tests/voyageTiming.test.ts`, `tests/PassageKitPrompt.test.tsx`,
existing Log/VoyageSummary identity tests, and an isolated PostgreSQL execution
of the migration via `scripts/check-voyage-timing-db.mjs` (PGlite).
