# Build 133

Scope: the expanded Thalassa Roadmap dated 14 October 2026, confirmed by Shane on 16 October (Brisbane). The original is archived in [roadmap/2026-10-14.md](roadmap/2026-10-14.md). Its package scope is authoritative; its old delivery narrative is not current release evidence.

Base application: corrected build 132 candidate `a9372b33c967d79d8676e9bb3564b68c794cc33b`. Build 132's isolated validation/release controls must finish without moving b132, master or its correction branch. Work for 133 stays on separate branches. Native build numbers are133 in all four configurations; marketing version stays1.2.0.

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

Do not release 133 before build 132's upload and Apple processing outcome are established. Never reuse an uploaded build number. No package is complete merely because its plan or test fixture exists.
