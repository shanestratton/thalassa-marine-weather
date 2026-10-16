# 139-08 — Find on chart

Isolated source package based on `55c33414fd6e8fe65d05a97a4aa2b7bb1a53a685`.
No backend, provider, chart-ingestion, native-version or deployment changes.
This package is not part of the build 137 release.

## Behaviour

Obs → map dropdown → Charts & detail → Find on chart. The lazy sheet searches
loaded chart portions for light characteristics, marks and named objects.
`Fl.G 3s`, `FlG3s` and `Fl.G3.0s` match the same chart light. Names are compared
without accents/punctuation, displayed as React text, and never inserted as HTML.
The existing S-57 light-character formatter remains the source of the label.

Find rechecks source availability, then moves the existing camera to a display
anchor. Polygon/line anchors use a bounded unwrapped vertex mean, including
the short dateline crossing. This is a label location, not a navigable point or
a route/clearance decision. No route, fix, boat profile or weather selection is
written. The original chart geometry is neither edited nor retained by the index.

Open NOAA results require the current account's existing versioned agreement.
Licensed results require the current paired boat LAN and remain in RAM only.
No search text, chart name or chart position is sent to a remote index/geocoder,
logged, uploaded or persisted by this feature. Existing map rendering and source
credits stay in force. No new source, chart licence or navigation authority is
inferred from a matching name.

An explicit “Read downloaded NOAA around view” tap reads existing local chart
bytes only, even in Satellite Mode. It never invokes the Pi/cloud hydration
ladder or downloads charts. A missing local package is reported unavailable.
The camera is split locally at the dateline; unwrapped Mapbox world copies work.
Wide views require zooming in. A dateline package scan reads one intersecting
side per cell and reports partial area coverage. Search is always labelled as
loaded portions; missing names do not prove the object is absent.

## Bounds and lifetime

- Per cell: at most 512 primitive objects and 128 KiB estimated object/string
  weight, scanning at most 50,000 features / 128 layers and 2,048 vertices per
  candidate geometry. Dense/oversized/malformed portions report a partial index.
- Whole index: at most 8 cells, 4,096 objects and 1 MiB estimated weight; native JS
  object overhead is additionally bounded by those fixed object/count limits.
  At most 256 pending cell tokens. A stale UI result cannot pin an evicted cell's
  full index through its proof record.
- Query: 80 characters and 20 returned matches, with a partial/narrow-search
  notice where capped. No global dataset scan or phone-boot acquisition.
- Explicit local read: one outstanding read session, four cells maximum,
  sequential package decoding using existing 4 MiB parts / 16 MiB resident leases.
  Views are at most 120° longitude / 90° latitude. A monotonic 10 second acceptance budget
  prevents starting/accepting further reads after expiry.
- Capacitor file I/O cannot be forcibly aborted. Cancel prevents result
  acceptance/continuation; its one read slot and package lease stay held until
  pending I/O settles. Repeated Cancel/Read taps cannot multiply native buffers.
  This is not a claim that a hung native file operation returns within 10 seconds.

Opaque parse tokens are captured before asynchronous reads/worker parsing and
survive the sync-error fallback without being renewed. Import generation is
captured before entering the same-cell mutation queue. Validated imports build
their index after metadata commits, only for the still-current generation and
registry revision. Byte-identical metadata upserts leave the index alone.
Replacement, removal, account/Pi switch, unpair, reset and memory shedding retire
tokens/results synchronously. LAN status changes hide licensed results; selection
rechecks current access across its async agreement read. Transport loss does not
grant another identity or renew a pending parse token.

## Proof

Whole-app TypeScript (`node node_modules/typescript/bin/tsc --noEmit`) passed
with exit 0 and an empty log after the source/browser freeze. No native compiler
or configured production bundle measurement was run for this isolated package.

Focused standard Vitest group: 68 tests across 11 suites passed, including 23 new
cases for the index, access, lifecycle and sheet. Additional bounds assertions
cover wrapped/unwrapped/adjacent-world cameras. A queued-import account-switch
repro failed before the admission-time generation fix, then passed.

Actual Chrome and WebKit: 4/4 at 300×667 and 375×667 with 130% font size. The cold
lazy child preserves the parent, agreement acceptance is exercised, real parsed
S-57 attributes produce the light result, explicit downloaded-cell read stays
local, a real Mapbox camera moves to the short dateline anchor, chart deletion
retires the row, and Escape returns focus to the opener. Sheet bounds and
horizontal overflow are checked without weakening existing layout assertions.
Screenshots were inspected, including 300px WebKit with the result above the
explanation and the Done button visible.

The fixture blocks every external request. Fixed Mapbox SDK handshake/telemetry
attempts are explicitly aborted and checked for absence of fixture search terms;
all other external attempts fail the test. This is not a claim that the Mapbox
SDK makes zero baseline requests, or a proof with physical hardware/licensed
production cells. Only synthetic chart data was used.

Proof logs outside the repository:

- `work/validation139-chart-find-focused-final.log`
- `work/validation139-chart-find-queued-red.log`
- `work/validation139-chart-find-queued-green.log`
- `work/validation139-chart-find-browser-freeze.log`
- `work/validation139-chart-find-lint-final.log`
- `work/validation139-chart-find-tsc.log`

The browser spec is included in the normal keyboard Playwright configuration;
all unit files are found by standard Vitest discovery. Full type and configured
bundle gates still apply; no budget or release gate is raised here. A configured
production bundle measurement is pending parent integration review.
