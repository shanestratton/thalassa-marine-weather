# Build 133

Scope: the expanded Thalassa Roadmap dated 14 October 2026, confirmed by Shane on 16 October (Brisbane). The original is archived in [roadmap/2026-10-14.md](roadmap/2026-10-14.md). Its package scope is authoritative; its old delivery narrative is not current release evidence.

Base application: released build 132, `a9372b33c967d79d8676e9bb3564b68c794cc33b`. All eleven jobs in full validation [38805623915](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/38805623915) passed. Guarded virtual Mac release [38808271837](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/38808271837) succeeded and uploaded 1.2.0 (132) once. Apple reported processing VALID, not expired, at 2026-10-15T21:52:53Z. A separate read-only Apple check at 2026-10-15T22:15:50Z reported internalBuildState IN_BETA_TESTING with one internal group assigned; external state was READY_FOR_BETA_SUBMISSION with no external group. See [38815869441](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/38815869441). Installation on Shane's iPhone and physical-device acceptance remain unverified. After release completion, b132 was fast-forwarded to the exact validated and uploaded commit. Work for 133 stays on separate branches. Native build numbers are 133 in all four configurations; marketing version stays 1.2.0.

| Package | Scope                                                       | Delivery requirement                                                                 |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 133-01  | AIS ghosts, age, trails, dimensions, ETA and draught        | Preserve the real report; conservative alarm checks of report and projected position |
| 133-02  | Display filters, targets list and offline search            | Alarm isolation; DANGER/CAUTION and 97x targets always draw                          |
| 133-03  | ECMWF 9 km, regional models and sea-cell wind               | Capability-gated until the commercial proxy serves the requested model               |
| 133-04  | Route hazard look-ahead and Pi off-route watch              | One depth/UKC rule; conservative tide and channel handling                           |
| 133-05  | Pi polar learning with day/night variants                   | Exclude motoring; keep learning usable without RPM                                   |
| 133-06  | Barometer windows, boat source, 10-day history and tendency | Preserve 163 px Glass cell; account for tropical pressure tide                       |
| 133-07  | Navaids and per-cell datum                                  | App first; in-memory chart reread; producer allowlist fallback                       |
| 133-08  | Official tide providers and live gauge residual             | No mixed datums; WorldTides fallback until publisher data exists                     |
| 133-09  | Official analysis charts and offline sheet                  | Source terms verified; AU/NZ model-isobar fallback                                   |
| 133-10  | Staged Pi update 5                                          | Install/rollback/checksums; refuse during an active anchor watch                     |
| 133-11  | Android capability/dependency study                         | Read-only; no Android build or account purchase                                      |

Acceptance details, exclusions and dependencies are in the archived roadmap. Each implementation must record targeted tests and any live deploy/install evidence separately. Existing licensing restrictions, physical-device checks, paywall hold, PYD account restriction and memory gates remain in force. No size-limit increase: measure against the repository's current budget, not the roadmap's stale footer.

Build 132's upload and Apple processing outcome are established; build 133 still requires its own complete validation and release gates. Never reuse an uploaded build number. No package is complete merely because its plan or test fixture exists.

## Integration candidate, 16 October 2026

Build 133 is assembled locally on `codex/build-133-integration`; this is not yet a TestFlight release. Build 132 and the prior `b133` checkpoint remain preserved until the combined gates pass.

| Package | Combined source                                                                                     | Live or physical evidence still required                        |
| ------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 133-01  | AIS report age, ghosts/trails/details and conservative collision envelope; repaired parity fixtures | Combined CI and physical alarm checks                           |
| 133-02  | Account display filters, Targets sheet and receiver-first search; safety overrides                  | Combined browser/release CI                                     |
| 133-03  | Existing integrated coastal capability package                                                      | Commercial proxy deployment and model probe                     |
| 133-04  | App cone/query/watch, isolated Pi vault query, enrolled followed-route handoff and Pi XTE watch     | Relay migration/deploy, Pi install and locked-phone tests       |
| 133-05  | Incremental Pi learner, RPM/heuristic gates, civil twilight and routing blend                       | Linux native SQLite checks, Pi install and sailing data         |
| 133-06  | Recovered barometer package with corrected tendency/history/freshness                               | Pi install and physical sensors                                 |
| 133-07  | Reviewed schema-3 navaids and per-cell datums integrated                                            | App first, then guarded Pi in-memory reread                     |
| 133-08  | Official display tables/provenance plus a separate weather-server publisher                         | Timer installation and public publication; CHS remains disabled |
| 133-09  | Official charts, manual Satellite download and bounded offline/Pi cache                             | New public image proxy deployment; DWD remains excluded         |
| 133-10  | Offline weather and staged install/rollback/checksums assembled                                     | Combined package checks, pi5 dry run and owner install at dock  |
| 133-11  | Existing integrated read-only Android study                                                         | No Android build/purchase authorized or attempted               |

Shane's additional requests are included: the repeated off-route arming notice is removed; Obs Clear View is inside the top-centre dropdown, with single-tap restore. Safety controls and actionable missing-position warnings remain. Focused UI tests and Chromium phone/tablet checks passed; combined release validation is still required.

The existing JavaScript budget remains 10.15 MiB. A standard, pinned development-only Terser minifier replaces esbuild compression; no auth or feature code is stubbed out. The final local production checkpoint measured 10,586,736 JavaScript bytes against 10,643,046 bytes, including offline weather. The hosted source check also covers the final polar guard alignment. Release checks measure the final exact source again.

No held migration has been applied, no Pi install has occurred, and no build 133 upload has been attempted. Database/server deployment, installed Pi behavior, Apple processing, beta-group assignment and installation on a physical iPhone are distinct outcomes and must be recorded independently.
