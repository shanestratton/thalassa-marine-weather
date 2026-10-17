# 140-01 worldwide facilities: preparation and deployment boundary

The new `facilities-world` namespace is separate from released anchorage/mooring `osm` and build 138's regional marina/fuel `facilities` dataset. Their source formats, policies and limits remain unchanged. This packet does not install a service, download continental files, contact wx/R2, upload a generation or enable a timer.

`facilities-world.plan.json` uses the same eight continental public Geofabrik sources and byte caps as the existing reviewed world-OSM plan. Acquisition requires **all eight** original continental cohorts, their actual PBF header clocks and fixed reviewed plan SHA. Missing, duplicate or invented cohorts refuse a world generation. Original OSM node/way/relation identities remain stable across sources; existing geometry/conflict checks, bounded SQLite construction, immutable area/name shards, manifest inventory, SOURCE proof and ODbL licence file are reused. Publication preserves the oldest original source clock and cannot regress a cohort or replace its bytes under an unchanged clock.

Only explicit marine facility tags qualify. `leisure=marina` and existing explicit boat-fuel tags retain their meaning. Boat ramps require `leisure=slipway`, an actual `highway=service/service=slipway`, or the small-craft slipway category. Pump-outs require the small-craft `pump-out` category, or an explicit suction pump tag combined with marine scope. A chemical-toilet basin, RV drain or ordinary roadside fuel station does not establish a boat pump-out/fuel dock. Availability, permission, vessel suitability and interpreted opening hours are never inferred.

## Concrete resource envelope

The no-network review command is `python scripts/marine-catalogue/world_monthly_review.py`; its output is a **plan**, not an acquisition result.

| Limit | Prepared envelope |
| --- | --- |
| Total source transport caps | 114.25 GiB |
| Filtered/exported input caps | 14.125 GiB |
| Existing acquisition admission free-space requirement | 160.625 GiB, before this run |
| Largest source file | 40 GiB (Europe cap) |
| Per-source intermediate/export limit | At most 2 GiB; Antarctica 128 MiB |
| Local source snapshots | At most 2 per dataset; existing 24 GiB hard cap each |
| Local staged generations | At most 3; existing 2 GiB cap each |
| Remote owned namespace peak before cleanup | Existing 8 GiB cap |
| Memory / tasks / CPU | 2 GiB / 16 / 50% |
| Per-download / osmium-child / header deadline | World-only size budget at4MiB/s, minimum1 hour and absolute maximum3 hours / 2 hours / 30 seconds |
| Whole prepared world service deadline | 24 hours, with 2-minute stop timeout |

The per-child worst-case sum can exceed the whole-service deadline. A slow or oversized run therefore stops without publishing; no global coverage claim follows from partial preparation. Initial continental runtime, bandwidth and an explicit dedicated filesystem/project quota must be reviewed before executing. Free-disk admission is not a substitute for an operator-configured quota. These are substantial global downloads, not the old regional 512 MiB workload. The existing regional service/timer and quotas are not modified.

The17 October first wx trial transferred3.576GB in about610 seconds (about5.8MB/s). The dated original Europe file is35,239,521,568 bytes, so the previous one-hour transfer deadline was insufficient. That unpublished trial was stopped early; no partial acquisition is promoted. World downloads now receive a conservative size-derived budget at4MiB/s, with a hard3-hour ceiling (the admitted40GiB source cap gives10,240 seconds). Existing regional/default downloads keep their one-hour limit. Whole-service24h, byte limits,2GiB memory, dedicated180GiB filesystem, source identity and redirect refusal remain unchanged. Actual receipts distinguish this measured correction from a completed global generation.

The supplied **new**, preparation-only `thalassa-facilities-world.service` and `.timer` are reviewable templates. They use the existing catalogue account/root and shared OS lock, but a separate environment-file name and monthly schedule. The service requires an exact reviewed source plan path/hash and cannot publish or delete remote objects. It is not installed/enabled by source delivery.

## Eventual reviewed deployment

1. Verify the current public source sizes/rights, measured runtime, dedicated quota and the exact source-plan hash from the dry run. Prepare the dedicated environment and source/runtime files without touching weather credentials or jobs.
2. Run the reviewed acquisition once under the new service's resource envelope; retain transport receipts and actual PBF source clocks. Inspect the generated immutable index, admitted counts, provenance, duplicate handling, geographic scope and ODbL offer.
3. Create the existing **exact object publication/retention plan** against the actual owned `marine-catalogue/v1/facilities-world/` inventory. The source-only tests use an empty synthetic inventory; they do not claim real R2 availability.
4. Review that concrete plan before any upload. Existing byte/SHA readback, manifest-last conditional ETag swap, protected generations and after-swap bounded retention apply. Failure leaves the previous public manifest intact. Serve JSON with the existing public CORS/content-type/cache contract, no credentials. Keep the whole adapted area/name database and SOURCE/licence metadata publicly available under ODbL.
5. Only after actual accepted publication and phone checks, review enabling the **new** monthly preparation timer. Unattended publication needs the existing second exact publication/retention policy approval; installation alone cannot enable it. No installer or arbitrary sync/delete command is part of this packet.

Primary sources checked 17 October 2026: [OSM copyright/ODbL](https://www.openstreetmap.org/copyright), [Geofabrik extraction and public metadata rules](https://download.geofabrik.de/technical.html), [boat ramps](https://wiki.openstreetmap.org/wiki/Tag:leisure=slipway), [marine fuel](https://wiki.openstreetmap.org/wiki/Tag:waterway=fuel), [holding-tank disposal distinctions](https://wiki.openstreetmap.org/wiki/Toilet_Holding_Tank_Disposal), [small-craft categories](https://wiki.openstreetmap.org/wiki/Seamarks/Small_Craft_Facilities). These sources establish tagging/licence contracts, not complete real-world facility coverage.
