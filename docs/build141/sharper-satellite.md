# Build 141-05 sharper satellite source

This is a display-only, separately lazy component for the existing capped Obs
layer key and credit rollup. Its owned public Edge service and candidate release
profile are admitted by the [actual public-read checkpoint](satellite-public-admission.md).
Both
`VITE_SHARPER_SATELLITE_ENABLED` and the server's `SATELLITE_VIEW_ENABLED` require
the literal value `true`; their default is off. The existing hourly mosaic stays
available to the parent integration. Satellite Mode blocks these image reads.

The fixed registry contains Himawari and GOES East/West clean infrared Band 13,
hourly Meteosat FCI infrared, a daily VIIRS night composite, and NOAA's hourly
upper-water-vapour mosaic. Auto suggests a regional or polar source from the
viewport; it does not establish actual disk/swath coverage. Water vapour describes
mid/upper-air moisture and supplies no surface-fog, visibility, depth, routing or
alarm authority. Source resolution and resampled viewport resolution differ.

Metadata is bounded to 512 KiB and two minutes, and original gaps remain gaps.
Only explicitly listed frames may be requested. Meteosat is restricted to UTC
clock hours. VIIRS uses its actual advertised 250 m tile matrix; its input's
nominal 375 m resolution does not make the daily composite instantaneous. GIBS's
documented raw time-domain KVP syntax is retained after the percent-encoded form
returned HTTP 400. Fixed source URLs and styles are adapter-owned.

One viewport canvas is at most 1024 by 1024 pixels. A dateline viewport has at
most two sequential bounded PNG reads, each at most 2 MiB; one provider bitmap is
closed before the next is decoded. There is no image history or durable cache.
Provider colours are preserved at 72% display opacity. Empty decoded coverage is
held; partial coverage is disclosed as unknown. The source checks metadata again
after each image, but **a requested/listed timestamp is not independent proof of
the image acquisition clock**. Provider nearest-time responses and scan timing
remain an explicit limitation until real image provenance is verified.

The client binds the exact original metadata lease, frame, minted viewport plan,
map and cancellation context. Serialized flags cannot mint a plan or original
selection. Late results and late decoders are retired. Blob ownership transfers
to the shared image owner; URL revocation requires actual source absence or map
removal. Uncertain visible removal keeps the original provider credit and warning.
Source refresh does not renew an old viewport or metadata lifetime.

The proxy uses the fixed owned Supabase public endpoint. Existing web/native
CSP already permits local blob images; no provider browser origins were added.
The API rejects malformed requests before any network read, follows no redirects,
sends no credentials, and shares one 25-second request deadline. The native image
owner retains its independent 10-second readiness deadline.

## Source and licence review

The implementation follows [NASA GIBS access basics](https://nasa-gibs.github.io/gibs-api-docs/access-basics/)
for explicit listed times and [advanced access](https://nasa-gibs.github.io/gibs-api-docs/access-advanced-topics/)
for projection/resampling. NASA's [data-use policy](https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy)
does not make every third-party product public domain merely because GIBS hosts it.

[EUMETSAT's 2025 data policy](<https://www-cdn.eumetsat.int/files/2025-02/45173%20-%20Data_Policy(1442019%20V1).pdf>)
places hourly Level 1 FCI data in its Core category under CC BY 4.0. This adapter
admits clock-hour frames only and acknowledges the source, modification and year.
It does not admit sub-hourly Level 1 data. The [JMA policy](https://www.jma.go.jp/jma/en/copyright.html)
requires source acknowledgement and disclosure of edits. JAXA's
[current FAQ](https://www.eorc.jaxa.jp/ptree/faq.html) distinguishes commercial use
of Himawari products from 1 February 2026 onward from older archive restrictions;
this live recent-frame path does not imply permission for every historical file.
The original data provider remains in each visible credit.

[NOAA's GMGSI description](https://vlab.noaa.gov/web/towr-s/gmgsi) and its actual
WMS capabilities identify the upper-water-vapour product, approximate 3 km source
resolution and typical 2–3 hour latency. This is not an invented GIBS Band 8
product. Actual read-only metadata excerpts for GIBS domains, EUMETSAT, NOAA and
VIIRS's tile matrix are retained as fixtures; no provider imagery was downloaded
for this source/UI checkpoint.

## Verification and limits

The three focused suites pass 50 tests covering bounds, original listed times,
gaps, default-off admission, request/decoder cancellation, original identity,
clocks, source changes, one-pass playback, Satellite Mode and stuck attribution.
Final scoped lint and formatting pass. Whole-app compilation and the configured
production budget are reserved for the parent composition.

Four actual installed-Chrome/WebKit phone cases pass at 300/375 px with 130% text.
They exercise the real proxy contract against **fictional** provider metadata and
PNG responses, the native PNG decoder/compositor and actual Mapbox ImageSource,
the original credit dialog, all six source choices, hourly Meteosat, daily VIIRS,
dateline splitting and late user-off retirement. The map/page remain 780 px high
and viewport-width wide; the existing layer-key scroll and 44 px credit opener
retain their bounds. The Info paragraph is scrolled into view and centre-hit
tested. No remote requests, Mapbox errors or page errors occurred.

An earlier visual refinement run passed three cases and stopped Chrome 300 at an
unchanged five-second intermediate readiness assertion. Its trace/report remain
preserved. A subsequent instrumented single case and the final four-case run pass
without widening that assertion. The initial timeout is unreproduced, not proven
to be only a test timing issue. Final request/native-source/status timelines are
attached. Earlier fixture/effect failures also remain in the local evidence.

This checkpoint establishes source/UI behaviour, not real-provider availability,
complete world coverage, independent acquisition clocks, live activation or an
Apple/TestFlight build. A separate reviewed bounded real-source check is required.

## Parent integration and first real-source follow-up

The actual MapHub now has a literal-gated lazy mount, one optional Sky → Sharper
sat menu item, and an ephemeral shared selection hook. The original Sat cloud
hourly layer and sharper imagery are mutually exclusive. Explicit Hourly mosaic
returns to the original GMGSI hook; non-menu hourly activation also retires
sharper. Neither selection is persisted by this hook. Clear all clears the one
sharper selection/count. Embedded, picker, planning, pin and MOB surfaces do not
activate sharper imagery. Satellite Mode remains enforced by the actual source
and component lifetimes.

Controls join the existing capped LegendDock and credits join the existing
44 px rollup. A loading-key placeholder preserves the open key through a mode
handoff. The first parent phone run exposed a disappearing controls region after
hourly → sharper despite a ready native image; its trace and timings remain
preserved. The repaired flow retains the existing key while controls initialize.
The parent fixture uses the actual shared selection hook, menu, both satellite
hooks, original hourly key, LegendDock and credits. It is not a full MapHub mount;
MapHub's actual wiring is present in source and remains for parent whole-app
compilation/release review.

Root's first real-source read (run 39002448267, exact source `5f9da29ac`, definition
`38d74a4dd`) exited one with four of six products producing a visible PNG. It
consumed 408,471 body bytes across 28 requests. Himawari/GOES West and GOES East's
04:00 frame returned the same fully transparent 334-byte PNG despite remaining
listed. East's 03:50 frame was an opaque, uniformly black 914-byte PNG: a valid
PNG observation, not evidence of usable cloud detail. Only Meteosat, VIIRS and
upper-water-vapour images demonstrated varying visible detail in those small
windows. The original four-of-six observation receipt is immutable; it has not
been relabelled a six-product success or deployment approval.

The client now refuses zero alpha **or a single visible RGB value** before
encoding, URL creation or presentation ownership. Hidden RGB changes and varying
alpha do not create detail. This conservative display hold does not claim a
uniform view is physically impossible; its detail/coverage remains unknown.
The exact retained 334/914-byte originals are fixtures, with fixed SHA checks and
critical CRC decoding, and both fail the actual client pixel guard. Synthetic
nonuniform and partial-alpha images continue to pass. The original source's
metadata age/admission rules are unchanged. A separate bounded older-advertised
diagnostic, if reviewed, must keep those same clocks and original membership.

The source/UI fixture now supplies nonuniform fictional imagery so it remains a
valid detail example under that guard. Native parent checks separately feed
transparent and opaque uniform PNGs and require an unavailable status with no
native satellite layer before testing explicit fallback, return to sharper,
Satellite Mode, and delayed Clear all retirement. All imagery in these phone
fixtures is fictional; the retained provider originals are separately verified
by the source-byte/pixel tests.

The final combined run passes all eight single-attempt Chrome/WebKit cases
(original source controls plus the parent composition, 300/375 px, 130% text).
The final focused packet passes 124 cases in ten suites, including the original
shared community/menu, weather-control and credit regressions; scoped lint is
zero. These results supersede no failed evidence. Whole-app compilation,
configured production budget and physical-device memory remain parent checks.
