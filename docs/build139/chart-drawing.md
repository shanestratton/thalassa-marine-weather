# Build 139.03: private chart drawings and boat ruler

This package adds user-created lines, areas and point labels, plus an in-memory boat-centred EBL/VRM. `ChartDrawingTools` is the lazy integration boundary; the MapHub opener and gesture conflict policy are integrated separately.

```ts
interface ChartDrawingToolsProps {
    map: mapboxgl.Map | null;
    mapReady: boolean;
    active: boolean;
    canDraw: boolean;
    open: boolean;
    onClose: () => void;
    onInteractionChange?: (owned: boolean) => void;
    className?: string;
}
```

Keep the component mounted once loaded so visible drawings remain on Obs after its library closes. Pass `active` only for foreground Obs. Pass `canDraw` only when route placement, pin placement, MOB and other competing chart actions permit a drawing session. The `onInteractionChange` lease covers a draft or ruler pick, including Move map; do not feed that same lease back as a competing action or it will cancel itself. The component uses its own pointer surface and does not replace a shared MapHub gesture hook. Account, active-vessel, source and foreground changes retire draft/ruler actions. The default toolbar stays above the bottom controls with a bounded scroll area and leaves the right control column clear; composed-page placement must preserve Mapbox logo and attribution clearance.

## Persistence and exports

Only explicitly placed user geometry enters `services/chartAnnotations`. There is no ENC read/borrow entry point and no official-chart object or source metadata is retained. Drawings have no routing, no-go-zone or anchor-watch authority. Crew sharing and cloud storage are not enabled.

Signed-in libraries use Capacitor `Directory.Data`, under an account-scope hash at `chart-annotations/v1/<hash>/library.json`. Reads and mutations are serialized within this process, check current account scope and library/item revisions, validate a SHA-256 integrity envelope, and write a temporary file before rename. This is not a cross-tab or distributed transaction guarantee. Permission/integrity errors are surfaced instead of silently replacing the library. Account retirement clears private in-memory geometry and map sources.

Limits are 128 drawings, 256 placed points per drawing, 4,096 saved vertices in total, 256 KiB of library JSON and four account libraries per device. An area's closing vertex counts in saved vertices. WGS84 two-dimensional Point, LineString and Polygon geometry reuses the private-overlay geometry validator, including self-crossing, degeneracy and dateline checks. Labels are bounded plain text and rendered with `textContent`/React text.

GeoJSON preserves every supported geometry and exact stored coordinates. GPX 1.1 preserves points as waypoints and lines as tracks; the entire GPX export refuses any polygon or longitude `+180` rather than dropping or changing it. XML text is escaped and exponent-form numbers expand to round-trippable decimal text. Exports are limited to 1 MiB. Export handoff rechecks account, vessel/paired-source context and foreground before sharing/downloading. Native temporary exports use anonymous UUID filenames in `Directory.Cache` and schedule deletion of only that temporary file after the share handoff.

## EBL/VRM source contract

The ruler is never persisted or exported. It uses an original boat position from the selected boat gateway or paired Pi LAN instrument feed, at most 13 seconds old, with no future clock and latitude limited to the chart projection. A changed account, active vessel, paired device/full public key/pairing time, LAN base or receiver identity requires a newly received original fix. LAN input requires current pairing, reachable ordinary `piCache.lanBaseUrlNow()` and pinned transport; it does not require the optional chart-vault toggle.

The true bearing line and range ring stay fixed in bearing/range while following fresh boat position. Allowed range is 0.005–50 NM with a pole/projection guard. Relative bearing additionally needs the same feed's fresh original true-heading reading, with at most six seconds of position/heading clock skew. Magnetic heading, COG, phone position, cloud data and direct unpaired Signal K are not substitutions. Missing/stale/foreign position removes ruler geometry and reports unknown; missing true heading reports relative bearing unknown.

## Source proof

- Final focused tests: **19 passed in four suites**, `work/validation139-drawing-final.log`.
- Final actual Chrome/WebKit fixture: **10 passed**, `work/chart-drawing139-browser-final.log`, screenshots in `work/chart-drawing139-browser-final-results/`.
- Scoped ESLint: zero errors; only the existing ignored Playwright-config warning, `work/validation139-drawing-lint-final.log`.
- The browser fixture uses actual Mapbox rendering, real Capacitor web filesystem persistence and real downloaded exports with synthetic accounts/receiver evidence. External provider traffic is intercepted locally. It verifies exact geometry after save/export/reload/style reset, hide/show persistence, rendered cyan line pixels, area rejection/GPX refusal, fresh/stale/foreign ruler retirement, long Unicode plain labels, keyboard centre placement, bounded controls and unchanged page/map bounds at 300/375 px and 130% text size. Final ruler and long-label WebKit screenshots were manually inspected; Mapbox logo/attribution clearance is asserted.
- Earlier failed runs remain recorded: asynchronous durable checkbox state needed an explicit awaited assertion; a synthetic receiver fix exactly on a retirement barrier was correctly refused; a screenshot exposed logo overlap and the toolbar was moved before final proof. Deadlines, geometry assertions and source fences were retained.
- These fixtures do not establish live receiver, native share-sheet, real-chart or hardware acceptance. Whole-app TypeScript, production budget and actual MapHub composition are owned by the release integration pass.
