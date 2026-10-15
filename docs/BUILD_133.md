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

## Integration checkpoint

Checkpoint after `cb085ac426e3cb4d6bdb36cd6db90e7490333fb4`. A feature branch is not a release candidate until it has been integrated and the combined application passes the full validation workflow.

| Package | Source status                                             | Outstanding evidence or work                                                                   |
| ------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 133-01  | AIS candidate `d0792dc`                                   | App and mirrored Pi checks queued; review before merge                                         |
| 133-02  | Pending                                                   | Display filters, Targets sheet and local-first search                                          |
| 133-03  | Integrated, PR 68                                         | Proxy/publisher deployment and live model capability still pending                             |
| 133-04  | Server contract and Pi relay client integrated, PRs 65/67 | App/vault look-ahead and Pi watcher integration; held SQL and deploy approval; physical alarms |
| 133-05  | Pending                                                   | Pi learner, engine gates, civil-twilight split and routing integration                         |
| 133-06  | Isolated draft                                            | Source review, app/Pi CI and physical sensor checks                                            |
| 133-07  | Chart candidate `fb4837b`                                 | Pi tests passed; corrected app fixtures under validation; no producer-wide datum assumed       |
| 133-08  | Client checkpoint `eee2771`                               | Provider publisher, app wiring, tests and live publication; CHS remains disabled               |
| 133-09  | Isolated draft                                            | Source review and tests; permission-held sources remain link-only                              |
| 133-10  | Pending                                                   | Combined Pi bundle, offline assets, install/rollback/checksums and watch guard; pi5 dry run    |
| 133-11  | Integrated, PR 66                                         | Read-only study complete; no Android build or purchase                                         |

Coastal checkpoint [38818030332](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/38818030332) passed full lint, routes, TypeScript, formatting, 205 focused app tests, 11 Deno proxy tests, production release gates and unchanged size limits: JS 10.11 MB / 10.15 MB; total 14.42 MB / 18 MB. The earlier Pi checkpoint [38816851813](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/38816851813) passed both complete Pi jobs; its two app failures were corrected and are tracked by separate runs.

The inherited source does not contain 130-07's official-marine-text implementation. That prerequisite must be implemented and validated before 133-10 can claim an offline bulletin copy. Track upload remains blocked on its explicit DB and deploy approvals. No held migration has been applied, no Pi install has occurred, and no build 133 upload has been attempted.
