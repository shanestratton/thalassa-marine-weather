/**
 * EncVectorLayer — actual S-57 vector chart features rendered on
 * the Mapbox map.
 *
 * Phase 8 — the user's imported ENC cells stop being just bbox
 * outlines and become real chart features. Depth-graduated water
 * fills, white coastline strokes, hazard symbols.
 *
 * Symbology approach: simplified IHO INT1 / S-52 day palette. Not
 * chart-grade (proper INT1 has hundreds of symbol classes); enough
 * that a cruising sailor can recognise their chart.
 *
 *   LNDARE  → tan fill (#d6c590)
 *   DEPARE  → absolute white ramp, paper-chart convention (see
 *             buildDepareFillColor): drying khaki, then dirty white
 *             at 0–2 m cleaning stepwise to pure white at 50 m+.
 *             The draft-keyed keel story lives in the SAFETY
 *             CONTOUR, not the fill
 *   DEPCNT  → thin gray contours + the bold dark safety contour
 *             (smallest charted VALDCO ≥ S)
 *   COALNE  → chart-brown line
 *   OBSTRN  → magenta circle (5 px) with cross
 *   WRECKS  → magenta circle (5 px) with cross + bold ring
 *   UWTROC  → magenta circle (4 px) with star centre
 *   BOY/BCN → IALA symbol icons from seamarkIcons.ts (`_icon`
 *             pre-baked at merge time)
 *   LIGHTS  → coloured star glyph + 'Fl(2)G 5s 12m 8M' labels
 *
 * Performance: a typical user (1-10 cells) loads ~1-50 MB of
 * GeoJSON total. Mapbox-GL tessellates GeoJSON into vector tiles
 * in a Web Worker; one-time CPU cost is a few seconds, runtime
 * draw is fast. We mount once per cell-list-change.
 *
 * Phase 9+ scope (not done here):
 *   - Viewport-filtered loading (only push features in view)
 *   - Click-to-popup (cell ID, depth, description)
 *   - Light/Dark/Day theme variants
 */

import mapboxgl from 'mapbox-gl';
import { mapExpr, mapFilter } from './encDepthStyle';
import { readS57 } from '../../services/enc/types';
import type { FeatureCollection } from 'geojson';

import { createLogger } from '../../utils/createLogger';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import { registerSeamarkIcons } from './seamarkIcons';
import {
    ALL_LAYER_IDS,
    CLICKABLE_LAYER_IDS,
    ENC_VEC_LAYERS,
    ENC_VEC_SRC,
    S57_BUOY_BEACON_CLASSES,
    S57_HAZARD_POINT_CLASSES,
    S57_NAVAID_CLASSES,
    S57_POINT_MARK_CLASSES,
} from './encLayerIds';
import { isScrubHidden } from './encDetailScrubber';
import { buildFeaturePopupHtml, needsTideWindow, pickAreaTap, type PopupExtras } from './encPopup';
import { mountCautionAreaLayers } from './encCautionMounts';

export { ENC_VEC_LAYERS, ENC_VEC_SRC } from './encLayerIds';
import {
    DEFAULT_SAFETY_DEPTH_M,
    DEPARE_CHART_OPACITY,
    DEPCNT_LABEL_INK_DATUM,
    DEPCNT_LABEL_INK_LIVE,
    SCAMIN_CLAUSE,
    MARK_SCAMIN_CLAUSE,
    buildDepareFillColor,
    buildDepareGlazeFillColor,
    buildDepareSatelliteOpacity,
    buildDepcntLabelField,
    buildSoundingTextColor,
    buildSoundingTextField,
    computeSafetyValdcoByCell,
    depcntLineFilter,
    depcntSafetyFilter,
    distinctValdcosByCell,
} from './encDepthStyle';

// Re-export the pure style API for existing importers + tests.
export {
    DEFAULT_SAFETY_DEPTH_M,
    DEPARE_CHART_OPACITY,
    buildDepareFillColor,
    buildDepareSatelliteOpacity,
    buildDepcntLabelField,
    buildSoundingTextColor,
    buildSoundingTextField,
} from './encDepthStyle';
export { computeSafetyValdco } from './encDepthStyle';

const log = createLogger('EncVectorLayer');

/** Brisbane VTS working area, approximated: Moreton Bay incl. the river
 *  mouth and the NW/NE/Main channel approaches (Caloundra down to the
 *  bay's southern islands; the Gold Coast Broadwater is deliberately
 *  outside). Leads within it badge "VHF 12·16" — MSQ Brisbane VTS works
 *  channel 12; everywhere else badges the ch-16 watch. Refine to the
 *  gazetted VTS boundary when it matters. */
const BRISBANE_VTS_AREA = {
    type: 'Polygon',
    coordinates: [
        [
            [152.85, -27.6],
            [153.65, -27.6],
            [153.65, -26.6],
            [152.85, -26.6],
            [152.85, -27.6],
        ],
    ],
} as const;

// ── Source + layer IDs ─────────────────────────────────────────────
// Live in encLayerIds.ts so the popup module (encPopup.ts) can name
// layers without importing this map-heavy module (no import cycle).
// Re-exported here for existing importers.

const ALL_SOURCE_IDS = Object.values(ENC_VEC_SRC);

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Find a sensible insertion anchor — vector chart should sit
 * above water/bathymetry but below labels and the route line.
 * We use the same anchor strategy as MpaLayer.
 */
function findInsertionAnchor(map: mapboxgl.Map): string | undefined {
    const style = map.getStyle();
    const layers = style?.layers ?? [];
    const candidates = ['settlement-major-label', 'place-city', 'country-label', 'admin-0-boundary'];
    for (const id of candidates) {
        if (layers.some((l) => l.id === id)) return id;
    }
    const firstSymbol = layers.find((l) => l.type === 'symbol');
    return firstSymbol?.id;
}

/**
 * Tag the merged points data with a 'kind' property so the three
 * point layers can filter their own features out of one shared
 * source — saves an extra source per point type, which speeds up
 * Mapbox's worker-side tile generation.
 */
function buildMergedPoints(data: EncMergedVectorData): FeatureCollection {
    // Derived from the canonical hazard-point registry (#2a full bind): a new
    // hazard class added there flows into this source automatically.
    return {
        type: 'FeatureCollection',
        features: S57_HAZARD_POINT_CLASSES.flatMap((cls) =>
            data[cls].features.map((f) => ({ ...f, properties: { ...(f.properties ?? {}), _kind: cls } })),
        ),
    };
}

/**
 * Same approach for navaids — one source, layer-level filters by
 * `_kind`. Saves the worker tile-build cost of three separate
 * sources holding the same Point geometries.
 */
function buildMergedNavaids(data: EncMergedVectorData): FeatureCollection {
    // Derived from the canonical navaid registry (#2a full bind): each class
    // is _kind-tagged so the per-mark layer filters resolve, and adding a
    // navaid class to the registry wires it here + into navaidSymbolLayer
    // without editing this function.
    return {
        type: 'FeatureCollection',
        features: S57_NAVAID_CLASSES.flatMap((cls) =>
            data[cls].features.map((f) => ({ ...f, properties: { ...(f.properties ?? {}), _kind: cls } })),
        ),
    };
}

// ── Draft-aware depth styling ──────────────────────────────────────
// The pure style math (band ramps, sounding typography, safety-contour
// derivation) lives in encDepthStyle.ts so it's unit-testable without a
// map. This module owns the stateful map-facing half.

/**
 * "Depth right now" — apply (or clear, with null) the tide offset on
 * every depth READOUT layer: band tints, sounding numbers + ink,
 * contour labels. VISUAL ONLY by hard rule: the safety contour, the
 * tracer and the router all keep grading against chart datum (they do
 * their own per-spot tide windows properly). The satellite GLAZE is a
 * VERDICT, not a readout — it stays chart-datum in both colour and
 * opacity (see applyTideOffsetPaint). Stored per map so mount/refresh
 * re-apply it after style swaps and cell loads.
 */
export function setEncTideOffset(map: mapboxgl.Map, tideOffsetM: number | null, atMs: number | null = null): void {
    const state = depthStyleState.get(map) ?? {
        safetyDepthM: DEFAULT_SAFETY_DEPTH_M,
        depcntValdcosByCell: {},
    };
    state.tideOffsetM = tideOffsetM;
    state.tideOffsetAtMs = tideOffsetM === null ? null : atMs;
    depthStyleState.set(map, state);
    applyTideOffsetPaint(map, tideOffsetM);
}

/** Flag the keel maths as fallback-draft so the popup verdicts carry
 *  the honesty caveat (mirrors the tracer's draftAssumed convention). */
export function setEncDraftAssumed(map: mapboxgl.Map, assumed: boolean): void {
    const state = depthStyleState.get(map) ?? {
        safetyDepthM: DEFAULT_SAFETY_DEPTH_M,
        depcntValdcosByCell: {},
    };
    state.draftAssumed = assumed;
    depthStyleState.set(map, state);
}

function applyTideOffsetPaint(map: mapboxgl.Map, tideOffsetM: number | null): void {
    const h = tideOffsetM ?? 0;
    const live = tideOffsetM !== null;
    if (map.getLayer(ENC_VEC_LAYERS.DEPARE)) {
        map.setPaintProperty(ENC_VEC_LAYERS.DEPARE, 'fill-color', buildDepareFillColor(h));
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPARE_FINE)) {
        map.setPaintProperty(ENC_VEC_LAYERS.DEPARE_FINE, 'fill-color', buildDepareFillColor(h));
    }
    // DEPARE_GLAZE is deliberately NOT here. The satellite glaze is a
    // go/no-go VERDICT (keel-keyed opacity on chart-datum DRVAL1, same
    // hard rule as the safety contour) and its colour must stay keyed
    // to the SAME datum as that opacity: shifting the colour alone
    // repainted a drying bank as the near-safe dirty white while the
    // datum-keyed opacity still flagged it drying — a 0.55-strength
    // "almost safe" wash over ground (adversarial review 2026-07-14).
    if (map.getLayer(ENC_VEC_LAYERS.SOUNDG)) {
        map.setLayoutProperty(ENC_VEC_LAYERS.SOUNDG, 'text-field', buildSoundingTextField(h));
        map.setPaintProperty(ENC_VEC_LAYERS.SOUNDG, 'text-color', buildSoundingTextColor(live ? h : null));
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPCNT_LABEL)) {
        map.setLayoutProperty(ENC_VEC_LAYERS.DEPCNT_LABEL, 'text-field', buildDepcntLabelField(h));
        map.setPaintProperty(
            ENC_VEC_LAYERS.DEPCNT_LABEL,
            'text-color',
            live ? DEPCNT_LABEL_INK_LIVE : DEPCNT_LABEL_INK_DATUM,
        );
    }
}

/**
 * Per-map depth-style state so `updateEncDepthStyle` and
 * `refreshEncVectorData` can recompute the safety contour without
 * re-threading the merged data / safety depth through every caller.
 */
interface EncDepthStyleState {
    safetyDepthM: number;
    /** Distinct charted VALDCO values PER CELL (keyed by `_cellId`) —
     *  each cell bolds its own smallest qualifying contour, so a cell
     *  whose inventory lacks its neighbour's exact value keeps its
     *  keel line (2026-07-12 audit). */
    depcntValdcosByCell: Record<string, number[]>;
    /** "Depth right now" offset (predicted tide above LAT, metres) —
     *  null = chart datum. VISUAL ONLY: routing/tracer verdicts never
     *  read this. See setEncTideOffset. */
    tideOffsetM?: number | null;
    /** When the offset is a SCRUBBED instant (the tide slider), the
     *  absolute ms it was sampled at; null/undefined = live "now".
     *  The tap-the-water popup words its rows off this — a scrubbed
     *  offset presented as "right now" was a grounding-grade lie
     *  (adversarial review, critical, 2026-07-11). */
    tideOffsetAtMs?: number | null;
    /** True when safetyDepthM was derived from the 2.5 m fallback
     *  draft — the popup's keel verdict must carry the same "set your
     *  vessel" caveat the tracer uses, never an unqualified tick. */
    draftAssumed?: boolean;
}
const depthStyleState = new WeakMap<mapboxgl.Map, EncDepthStyleState>();

/**
 * Compose the `_kind` routing filter with the SCAMIN clause.
 *
 * Mapbox's published `FilterSpecification` is a huge discriminated union
 * that doesn't admit dynamic composition cleanly; cast at the seam.
 */
const scaminAware = (kindFilter: unknown): mapboxgl.FilterSpecification =>
    mapFilter(['all', kindFilter, SCAMIN_CLAUSE]);

// Like scaminAware but with the z10 mark floor — for buoys/beacons/lights,
// which should be visible from z10 (Shane 2026-07-16).
const scaminAwareMark = (kindFilter: unknown): mapboxgl.FilterSpecification =>
    mapFilter(['all', kindFilter, MARK_SCAMIN_CLAUSE]);

/**
 * THE single choke point for draft changes (risk note: a missed
 * update path silently shows the WRONG safety contour — worse than
 * none). Moves the safety contour and re-keys the keel-keyed satellite
 * glaze; the chart-mode DEPARE fill is an ABSOLUTE white ramp since
 * 2026-07-11 and no longer re-bands with draft.
 * Called from mount (via opts), from the hook whenever vessel draft
 * changes, and from refresh when new cells land.
 *
 * `safetyDepthM` = vesselDraftMetres(vessel) + tide margin. METRES.
 */
export function updateEncDepthStyle(map: mapboxgl.Map, safetyDepthM: number): void {
    const state = depthStyleState.get(map) ?? { safetyDepthM, depcntValdcosByCell: {} };
    state.safetyDepthM = safetyDepthM;
    depthStyleState.set(map, state);

    const safetyByCell = computeSafetyValdcoByCell(state.depcntValdcosByCell, safetyDepthM);
    if (map.getLayer(ENC_VEC_LAYERS.DEPCNT_LINE)) {
        map.setFilter(ENC_VEC_LAYERS.DEPCNT_LINE, depcntLineFilter(safetyByCell));
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPCNT_SAFETY)) {
        map.setFilter(ENC_VEC_LAYERS.DEPCNT_SAFETY, depcntSafetyFilter(safetyByCell));
    }
    // The satellite glaze is keel-keyed (safe = whiter) — a draft change
    // must re-key it through the same choke point as the contour.
    syncDepareBaseTreatment(map);
}

// ── Mount ──────────────────────────────────────────────────────────

export interface EncVectorMountOptions {
    /** Minimum zoom level at which to render. Default 7 — below
     *  this, the dashed coverage overlay is sufficient and the
     *  vector data would be too dense to read anyway. */
    minZoom?: number;
    /** Overall opacity multiplier. Default 0.85 (matches an
     *  IHO-style chart on a dark basemap). DEPARE ignores this and
     *  paints at 0.95 so the dark shell doesn't bleed through the
     *  pale day-palette deep band. */
    opacity?: number;
    /**
     * Safety depth S in METRES (vesselDraftMetres(vessel) + tide
     * margin) driving the DEPARE bands + safety contour. Use
     * `updateEncDepthStyle` for live changes after mount.
     */
    safetyDepthM?: number;
}

/** mountLandCoastLayers — lifted from the mount monolith (#2b, pure statement move). */
function mountLandCoastLayers(
    map: mapboxgl.Map,
    minZoom: number,
    opacity: number,
    beforeIdFor: (layerId: string) => string | undefined,
): void {
    // ── LNDARE (tan land) ─────────────────────────────────────────
    // No fill-outline-color: Mapbox strokes EVERY internal edge of
    // the MultiPolygon triangle-fallback meshes (geojsonEmitter
    // fallback path), scribbling mesh lines across the land. Unset,
    // fill-outline defaults to the fill colour so mesh edges vanish;
    // the coastline stroke comes from COALNE — the S-57-correct
    // source for it anyway.
    if (!map.getLayer(ENC_VEC_LAYERS.LNDARE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.LNDARE,
                type: 'fill',
                source: ENC_VEC_SRC.LNDARE,
                minzoom: minZoom,
                paint: {
                    'fill-color': '#d6c590',
                    'fill-opacity': opacity,
                    'fill-antialias': true,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.LNDARE),
        );
    }

    // ── LNDARE islets (Point-geometry land) ───────────────────────
    // Charted islets too small for a polygon emit as Point LNDARE
    // features that a fill layer silently drops (23 in the live
    // coastal cell). Render as small tan dots with the coastline
    // stroke colour.
    if (!map.getLayer(ENC_VEC_LAYERS.LNDARE_ISLET)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.LNDARE_ISLET,
                type: 'circle',
                source: ENC_VEC_SRC.LNDARE,
                minzoom: minZoom,
                filter: mapFilter(['==', ['geometry-type'], 'Point']),
                paint: {
                    'circle-color': '#d6c590',
                    'circle-stroke-color': '#5c4a1a',
                    'circle-stroke-width': 1,
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 3.5],
                    'circle-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.LNDARE_ISLET),
        );
    }

    // ── COALNE (chart-source coastline) ───────────────────────────
    // The chart-author's intended coastline as a line feature. With the
    // LineIndex field-order fix (2026-05-19) these resolve correctly to
    // continuous traced coastlines — no more criss-cross spans. Classic
    // chart buff/dark-brown — pure black reads harsh against the pale
    // day-palette deep-water band.
    if (!map.getLayer(ENC_VEC_LAYERS.COALNE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.COALNE,
                type: 'line',
                source: ENC_VEC_SRC.COALNE,
                minzoom: minZoom,
                layout: {
                    'line-cap': 'round',
                    'line-join': 'round',
                },
                paint: {
                    'line-color': '#4a3f28',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 10, 1.0, 13, 1.4, 15, 1.8],
                    // MONOTONIC ramp — the charted coastline gets crisper as
                    // you zoom in, never dimmer. The z15 stop used the 0.85
                    // opacity multiplier, so it FADED below its own z13 value
                    // (0.95) exactly where detail matters (audit cosmetic).
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 10, 0.8, 13, 0.95, 15, 1],
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.COALNE),
        );
    }
}

/** mountPointMarkLayers — lifted from the mount monolith (#2b, pure statement move). */
function mountPointMarkLayers(
    map: mapboxgl.Map,
    minZoom: number,
    opacity: number,
    beforeIdFor: (layerId: string) => string | undefined,
): void {
    // ── Hazard points (filtered by `_kind` from one merged source) ─
    // OBSTRN, WRECKS, UWTROC draw as INT1 K-section glyphs (burn-down:
    // they were generic circles — a mariner reads +/*/hull symbols off a
    // paper chart, and a dangerous wreck must not look like a swept one).
    // Layer ids keep their legacy '-circle' suffix — they're load-bearing
    // (click handlers, hide lists), same precedent as the lateral marks.
    // Hazards lacking SCAMIN/_minZoom are NEVER zoom-hidden (the
    // `scaminAware` no-_minZoom arm) — they're the things the router
    // routes around.
    const hazardIconSize = ['interpolate', ['linear'], ['zoom'], 7, 0.3, 11, 0.45, 15, 0.62] as unknown;

    if (!map.getLayer(ENC_VEC_LAYERS.OBSTRN)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.OBSTRN,
                type: 'symbol',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'OBSTRN']),
                layout: {
                    // CATOBS 7 = foul ground (K31 hash: anchoring/gear risk,
                    // not surface danger) — everything else, incl. unknown,
                    // keeps the dangerous-obstruction circle (audit).
                    'icon-image': mapExpr([
                        'match',
                        ['to-string', ['coalesce', ['get', 'CATOBS'], ['get', 'catobs'], '']],
                        '7',
                        'sm-hazard-foul',
                        'sm-hazard-obstruction',
                    ]),
                    'icon-size': hazardIconSize as mapboxgl.ExpressionSpecification,
                    'icon-allow-overlap': true, // a danger symbol never yields to declutter
                },
                paint: { 'icon-opacity': opacity },
            },
            beforeIdFor(ENC_VEC_LAYERS.OBSTRN),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.WRECKS)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.WRECKS,
                type: 'symbol',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'WRECKS']),
                layout: {
                    // CATWRK 1 = non-dangerous → outline hull; everything
                    // else INCLUDING unknown → filled dangerous hull (safety
                    // bias: an uncategorised wreck reads dangerous).
                    'icon-image': mapExpr([
                        'match',
                        ['to-string', ['coalesce', ['get', 'CATWRK'], ['get', 'catwrk'], '']],
                        '1',
                        'sm-hazard-wreck',
                        'sm-hazard-wreck-dangerous',
                    ]),
                    'icon-size': hazardIconSize as mapboxgl.ExpressionSpecification,
                    'icon-allow-overlap': true,
                },
                paint: { 'icon-opacity': opacity },
            },
            beforeIdFor(ENC_VEC_LAYERS.WRECKS),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.UWTROC)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.UWTROC,
                type: 'symbol',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'UWTROC']),
                layout: {
                    // INT1 K-section (audit: 4 and 5 shared a glyph):
                    // WATLEV 4 covers+uncovers → K11 asterisk; WATLEV 5
                    // awash at CD → K12 dotted cross; submerged/unknown →
                    // K13 plain cross.
                    'icon-image': mapExpr([
                        'match',
                        ['to-string', ['coalesce', ['get', 'WATLEV'], ['get', 'watlev'], '']],
                        '4',
                        'sm-hazard-rock-awash',
                        '5',
                        'sm-hazard-rock-awash-cd',
                        'sm-hazard-rock',
                    ]),
                    'icon-size': hazardIconSize as mapboxgl.ExpressionSpecification,
                    'icon-allow-overlap': true,
                },
                paint: { 'icon-opacity': opacity },
            },
            beforeIdFor(ENC_VEC_LAYERS.UWTROC),
        );
    }

    // ── Buoys / beacons (IALA symbol layers) ──────────────────────
    // The icon id is pre-baked at merge time (`_icon`, see
    // encNavaidIconId in services/enc/types.ts) from CATLAM/CATCAM +
    // IALA region, so the layers stay dumb ['get'] expressions.
    // Cardinal quadrant identity (N/S/E/W band patterns + double-cone
    // topmarks) comes free with the icons. `_priority` (also
    // pre-baked: cardinals 0 < laterals 1 < specials 2) drives
    // symbol-sort-key so the engine culls minor marks first.
    //
    // Layer ids keep the legacy '-circle' suffix on purpose — click
    // handlers, toggles and the master-visibility probe reference
    // them (see ENC_VEC_LAYERS note).
    const navaidSymbolLayer = (layerId: string, kind: (typeof S57_BUOY_BEACON_CLASSES)[number]) => {
        if (map.getLayer(layerId)) return;
        map.addLayer(
            {
                id: layerId,
                type: 'symbol',
                source: ENC_VEC_SRC.NAVAIDS,
                minzoom: minZoom,
                filter: scaminAwareMark(['==', ['get', '_kind'], kind]),
                layout: {
                    'icon-image': ['get', '_icon'],
                    'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 15, 0.9],
                    // Navaids are position-critical: never collision-cull
                    // them against each other or against labels.
                    'icon-allow-overlap': true,
                    'symbol-sort-key': ['coalesce', ['get', '_priority'], 99],
                },
                paint: {
                    'icon-opacity': opacity,
                },
            },
            beforeIdFor(layerId),
        );
    };

    // Driven by the canonical buoy/beacon registry (#2a full bind) — a new
    // class in S57_BUOY_BEACON_CLASSES mounts here automatically.
    for (const cls of S57_BUOY_BEACON_CLASSES) navaidSymbolLayer(ENC_VEC_LAYERS[cls], cls);
}

/** mountSoundingLabelLayers — lifted from the mount monolith (#2b, pure statement move). */
function mountSoundingLabelLayers(
    map: mapboxgl.Map,
    opacity: number,
    beforeIdFor: (layerId: string) => string | undefined,
): void {
    // ── SOUNDG (spot soundings — the chartplotter depth numbers) ──
    // Shane 2026-07-09: "more depth measurements in close"; 2026-07-11:
    // numbers at every zoom, density-laddered. Text-only layer: sub-10 m
    // depths keep one decimal ("3.2"), deeper rounds whole ("12"). The
    // zoom gate is the PRECOMPUTED density ladder (soundingDensity.ts,
    // one number per ~90 px of glass, shallowest-first) baked into
    // _minZoom and applied by SCAMIN_CLAUSE — so the layer floor drops
    // to z4 and open water stays chart-clean. Dark ink + light halo
    // reads on the white ramp AND on satellite imagery (fills hidden
    // there, numbers stay). Shallow reads darker than deep so the eye
    // finds the skinny water first.
    if (!map.getLayer(ENC_VEC_LAYERS.SOUNDG)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.SOUNDG,
                type: 'symbol',
                source: ENC_VEC_SRC.SOUNDG,
                minzoom: 4,
                filter: mapFilter(SCAMIN_CLAUSE),
                layout: {
                    // Paper-chart sounding typography: sub-10 m depths carry
                    // their tenths as a TRUE SUBSCRIPT (3₄, not 3.4) — the
                    // convention every chart-reading eye already parses.
                    // Drying heights render as magnitude in khaki ink (see
                    // text-color), never with a minus sign ("-0.2 m" reads
                    // as nonsense to a punter; khaki 0₂ over the khaki
                    // drying band reads as "dries 0.2 m"). Single source of
                    // truth in buildSoundingTextField — the tide-offset mode
                    // re-points this at charted+tide.
                    'text-field': buildSoundingTextField(0),
                    'text-font': ['DIN Pro Italic', 'Arial Unicode MS Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 16, 12],
                    'text-allow-overlap': false,
                    // Collision padding shrinks as you zoom in — the density
                    // ladder offers more numbers from z13 ("at zoom 14 we
                    // need a lot more", 2026-07-11) and the collision engine
                    // must not eat them; shallowest-wins sort still decides
                    // who yields when glass runs out.
                    'text-padding': ['interpolate', ['linear'], ['zoom'], 12, 2, 14, 1, 16, 0.5],
                    // Shallowest wins collision placement — those are the
                    // numbers a keel actually cares about.
                    'symbol-sort-key': ['get', '_d'],
                },
                paint: {
                    // Drying = khaki ink (pairs with the drying band and the
                    // magnitude-only text-field); shallow darker than deep so
                    // the eye finds the skinny water first. symbol-sort-key
                    // on _d already puts drying (negative) first in collision
                    // placement — the scariest number always survives. Live
                    // tide mode swaps the whole family to teal via
                    // buildSoundingTextColor.
                    'text-color': buildSoundingTextColor(null),
                    'text-halo-color': 'rgba(255, 255, 255, 0.8)',
                    'text-halo-width': 0.8,
                    'text-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.SOUNDG),
        );
    }

    // ── SEAARE labels (waterway names in the waterways) ───────────
    // "Put the channel name in the channels — dark easy readable ink,
    // not too big, not too small" (Shane 2026-07-13). One point per
    // named sea area from the merge (finest chart wins the dedupe).
    // Paper-chart water lettering: italic, letter-spaced, slate ink
    // with a soft halo so it reads on the white ramp AND on satellite.
    // z9+: at passage zoom the big bay names orient; channel/river
    // names land as their areas become legible.
    if (!map.getLayer(ENC_VEC_LAYERS.SEAARE_LABEL)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.SEAARE_LABEL,
                type: 'symbol',
                source: ENC_VEC_SRC.SEAARE_LABELS,
                minzoom: 9,
                // Water names only — island names get their own upright
                // layer below (paper-chart convention: italic water,
                // upright land).
                filter: mapFilter(['all', SCAMIN_CLAUSE, ['!=', ['get', '_kind'], 'land']]),
                layout: {
                    'text-field': ['get', '_name'],
                    'text-font': ['DIN Pro Italic', 'Arial Unicode MS Regular'],
                    // "Not too big, not too small": a step above the
                    // sounding digits, well under settlement labels.
                    'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 13, 16, 15],
                    'text-letter-spacing': 0.18,
                    'text-allow-overlap': false,
                    'text-padding': 6,
                    // Long names ("North East Channel") wrap rather than
                    // sprawl across half the bay.
                    'text-max-width': 8,
                },
                paint: {
                    // "Dark lettering with a nice blue hue... that will
                    // pop" (Shane 2026-07-14): deep marine ink with a
                    // crisper white halo than the old slate.
                    'text-color': '#123f66',
                    'text-halo-color': 'rgba(255, 255, 255, 0.92)',
                    'text-halo-width': 1.4,
                    'text-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.SEAARE_LABEL),
        );
    }

    // ── Island / named-land labels ────────────────────────────────
    // "More names, like names of islands" (Shane 2026-07-14). LNDARE
    // OBJNAM reduced in the merge alongside SEAARE (_kind: 'land').
    // Upright dark ink on a warm halo — reads on tan land fill AND on
    // satellite bush; visually distinct from the italic blue water
    // names at a glance.
    if (!map.getLayer(ENC_VEC_LAYERS.LNDARE_LABEL)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.LNDARE_LABEL,
                type: 'symbol',
                source: ENC_VEC_SRC.SEAARE_LABELS,
                minzoom: 9,
                filter: mapFilter(['all', SCAMIN_CLAUSE, ['==', ['get', '_kind'], 'land']]),
                layout: {
                    'text-field': ['get', '_name'],
                    'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10.5, 13, 12.5, 16, 14],
                    'text-letter-spacing': 0.12,
                    'text-allow-overlap': false,
                    'text-padding': 6,
                    'text-max-width': 8,
                },
                paint: {
                    'text-color': '#3d3327', // dark earth — land ink
                    'text-halo-color': 'rgba(255, 250, 240, 0.9)',
                    'text-halo-width': 1.3,
                    'text-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.LNDARE_LABEL),
        );
    }
}

/** mountTrackAidLayers — lifted from the mount monolith (#2b, pure statement move). */
function mountTrackAidLayers(
    map: mapboxgl.Map,
    data: EncMergedVectorData,
    minZoom: number,
    opacity: number,
    safetyByCell: Readonly<Record<string, number | null>>,
    safetyDepthM: number,
    anchor: string | undefined,
    beforeIdFor: (layerId: string) => string | undefined,
): void {
    // ── RECTRC (recommended tracks / leading lines) ───────────────
    // The lead the tracer grades "off-lead by 40 m" against was
    // invisible until now — a punter can't ride a line he can't see
    // (Shane 2026-07-09). Amber dash reads on both the pale day
    // chart and dark satellite, and stays visually distinct from
    // every route colour (tier teal/yellow/red, trace green/amber
    // uses solid). z10-gated: leads are harbour-approach furniture.
    if (!map.getLayer(ENC_VEC_LAYERS.RECTRC)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.RECTRC,
                type: 'line',
                source: ENC_VEC_SRC.RECTRC,
                minzoom: 10,
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#f59e0b',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 14, 2.2],
                    'line-opacity': 0.9,
                    'line-dasharray': [4, 2.5],
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.RECTRC),
        );
    }
    // ── LIGHTSEC (light-sector arcs + limit legs) ─────────────────
    // The night-approach read (competitive gap vs Navionics/C-MAP,
    // 2026-07-12): coloured arcs + dashed limit bearings generated at
    // merge time from SECTR1/SECTR2 (services/enc/lightSectors.ts).
    // z11+ — harbour/approach furniture; the light glyph draws on top.
    if (!map.getLayer(ENC_VEC_LAYERS.LIGHTSEC_LEG)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.LIGHTSEC_LEG,
                type: 'line',
                source: ENC_VEC_SRC.LIGHTSEC,
                minzoom: 11,
                filter: mapFilter(['==', ['get', '_secKind'], 'leg']),
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    // Thin dashed grey radials — the limit bearings, not
                    // the message; the coloured arc carries the read.
                    'line-color': '#8794a1',
                    'line-width': 0.8,
                    'line-opacity': 0.7,
                    'line-dasharray': [3, 3],
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.LIGHTSEC_LEG),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.LIGHTSEC_ARC)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.LIGHTSEC_ARC,
                type: 'line',
                source: ENC_VEC_SRC.LIGHTSEC,
                minzoom: 11,
                filter: mapFilter(['==', ['get', '_secKind'], 'arc']),
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    // The sector colour itself (red/white/green/amber) —
                    // pre-baked _secColor. Bold enough to read at a glance at
                    // night; the "white" sector is a warm off-white (#f0e030,
                    // the _secColor fallback too) rather than pure #ffffff so
                    // it still reads on the pale day chart — there is no line
                    // casing/halo here (that would need a separate under-layer).
                    'line-color': ['coalesce', ['get', '_secColor'], '#f0e030'],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 15, 3.5],
                    'line-opacity': 0.95,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.LIGHTSEC_ARC),
        );
    }

    if (!map.getLayer(ENC_VEC_LAYERS.RECTRC_LABEL)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.RECTRC_LABEL,
                type: 'symbol',
                source: ENC_VEC_SRC.RECTRC,
                minzoom: 12,
                layout: {
                    'symbol-placement': 'line',
                    'symbol-spacing': 400,
                    'text-field': ['coalesce', ['get', 'OBJNAM'], 'LEAD'],
                    'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                    'text-size': 10,
                    'text-allow-overlap': false,
                },
                paint: {
                    'text-color': '#f59e0b',
                    'text-halo-color': 'rgba(0, 0, 0, 0.85)',
                    'text-halo-width': 1.3,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.RECTRC_LABEL),
        );
    }

    // ── VHF watch-channel badges along the leads ──────────────────
    // "A little radio symbol with the correct radio channel punters
    // should be on, dotted along" (Shane 2026-07-14). The charted
    // leads ARE the marked channels, so the badges ride them like the
    // lead labels do — ((•)) reads as a transmitting antenna and stays
    // inside the DIN glyph set (emoji don't rasterise in Mapbox glyph
    // PBFs). Inside the Brisbane VTS area the watch is VHF 12 + 16
    // (MSQ: Brisbane VTS works channel 12); everywhere else the
    // distress/hailing watch, 16. Split with `within` filters — the
    // one expression Mapbox only honours in filters.
    const vhfLayer = (id: string, insideVts: boolean): void => {
        if (map.getLayer(id)) return;
        map.addLayer(
            {
                id,
                type: 'symbol',
                source: ENC_VEC_SRC.RECTRC,
                minzoom: 10.5,
                filter: mapFilter(insideVts ? ['within', BRISBANE_VTS_AREA] : ['!', ['within', BRISBANE_VTS_AREA]]),
                layout: {
                    'symbol-placement': 'line',
                    'symbol-spacing': 560,
                    'text-field': insideVts ? '((•)) VHF 12·16' : '((•)) VHF 16',
                    'text-font': ['DIN Pro Bold', 'Arial Unicode MS Regular'],
                    'text-size': 9.5,
                    'text-letter-spacing': 0.06,
                    'text-offset': [0, 1.25], // sit just below the lead, clear of its label
                    'text-allow-overlap': false,
                    'text-padding': 4,
                },
                paint: {
                    'text-color': '#7dd3fc', // radio sky-blue — distinct from every chart ink
                    'text-halo-color': 'rgba(8, 20, 34, 0.9)',
                    'text-halo-width': 1.3,
                },
            },
            beforeIdFor(id as (typeof ENC_VEC_LAYERS)[keyof typeof ENC_VEC_LAYERS]),
        );
    };
    vhfLayer(ENC_VEC_LAYERS.VHF_BADGE, false);
    vhfLayer(ENC_VEC_LAYERS.VHF_BADGE_VTS, true);

    // ── LIGHTS (lighthouses + lit aids) ───────────────────────────
    // Symbol layer with a star char so it stays sharp at any zoom —
    // the cheap path; an SDF flare icon is the phase-2 pretty path.
    // Colour comes from `_lightColor` pre-baked at merge time (first
    // code of the comma-split S-57 COLOUR — multi-colour lights no
    // longer fall to yellow). Declutter: minor lights (VALNMR < 10
    // or missing) only render from z11; major lights always show and
    // win collision placement via the VALNMR sort key.
    if (!map.getLayer(ENC_VEC_LAYERS.LIGHTS)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.LIGHTS,
                type: 'symbol',
                source: ENC_VEC_SRC.NAVAIDS,
                minzoom: minZoom,
                filter: mapFilter([
                    'all',
                    ['==', ['get', '_kind'], 'LIGHTS'],
                    MARK_SCAMIN_CLAUSE,
                    ['any', ['==', ['get', '_lightTier'], 'major'], ['>=', ['zoom'], 10]],
                ]),
                layout: {
                    // Real light-FLARE glyph, colour-matched (closing audit:
                    // the light was a ★ text character — a font glyph, not
                    // chart symbology). The pre-registered lightSvg icons
                    // carry the S-52 flare shape; the match keys are the
                    // exact hexes lightColourHex bakes into _lightColor.
                    'icon-image': mapExpr([
                        'match',
                        ['coalesce', ['get', '_lightColor'], ''],
                        '#ef4444',
                        'sm-light-red',
                        '#22c55e',
                        'sm-light-green',
                        '#f0e030',
                        'sm-light-white',
                        ['case', ['==', ['get', '_lightTier'], 'major'], 'sm-light-major', 'sm-light-minor'],
                    ]),
                    'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.28, 11, 0.42, 15, 0.6],
                    // Collision-cull minor lights instead of stamping
                    // them all from z7 — the sort key keeps the
                    // longest-range lights when space is tight.
                    'icon-allow-overlap': false,
                    'icon-anchor': 'center',
                    // Flare OFFSET from the structure, S-52 style — stamped
                    // dead-centre it painted the flare directly over the
                    // buoy/beacon symbol beneath, hiding the IALA bands and
                    // topmark (2026-07-12 audit). Icon offset is in PIXELS.
                    'icon-offset': [14, -14],
                    'symbol-sort-key': ['-', 0, ['coalesce', ['to-number', ['get', 'VALNMR']], 0]],
                },
                paint: {
                    'icon-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.LIGHTS),
        );
    }

    // ── Labels (OBJNAM + light character, z13+) ───────────────────
    // One text-only label layer per point source, following the
    // tide-station idiom. Light halo — labels sit over the pale day
    // chart, not the dark shell. text-allow-overlap stays false so
    // Mapbox auto-decimates dense clusters.
    const labelLayer = (layerId: string, sourceId: string) => {
        if (map.getLayer(layerId)) return;
        map.addLayer(
            {
                id: layerId,
                type: 'symbol',
                source: sourceId,
                minzoom: 13,
                filter: mapFilter(['any', ['has', 'OBJNAM'], ['has', '_lightLabel']]),
                layout: {
                    'text-field': [
                        'format',
                        ['coalesce', ['get', 'OBJNAM'], ''],
                        {},
                        '\n',
                        {},
                        ['coalesce', ['get', '_lightLabel'], ''],
                        { 'font-scale': 0.85 },
                    ],
                    'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 16, 11],
                    'text-offset': [0, 1.4],
                    'text-anchor': 'top',
                    'text-max-width': 9,
                    'text-allow-overlap': false,
                },
                paint: {
                    'text-color': '#13242e',
                    'text-halo-color': 'rgba(255, 255, 255, 0.85)',
                    'text-halo-width': 1.2,
                },
            },
            beforeIdFor(layerId),
        );
    };

    labelLayer(ENC_VEC_LAYERS.NAVAIDS_LABEL, ENC_VEC_SRC.NAVAIDS);
    labelLayer(ENC_VEC_LAYERS.POINTS_LABEL, ENC_VEC_SRC.POINTS);

    // Z-ORDER HEAL: idempotent-additive mounting only positions layers
    // at ADD time — layers surviving from an earlier bundle keep the
    // old stacking (the 2026-07-12 audit found the DEPCNT trio buried
    // below DEPARE_FINE this way). Walk the canonical list top-down and
    // moveLayer anything out of place so a live map converges on the
    // spec order without a remount.
    let aboveId: string | undefined;
    for (let i = ALL_LAYER_IDS.length - 1; i >= 0; i--) {
        const id = ALL_LAYER_IDS[i];
        if (!map.getLayer(id)) continue;
        if (aboveId) {
            try {
                map.moveLayer(id, aboveId);
            } catch {
                /* best effort */
            }
        }
        aboveId = id;
    }

    log.info(
        `mounted vector layers: ${data.cellCount} cells, ` +
            `${data.LIGHTS.features.length} lights, ` +
            `lat marks=${data.BOYLAT.features.length + data.BCNLAT.features.length} ` +
            `(${data.BOYLAT.features.length} buoys, ${data.BCNLAT.features.length} beacons), ` +
            `card marks=${data.BOYCAR.features.length + data.BCNCAR.features.length} ` +
            `(${data.BOYCAR.features.length} buoys, ${data.BCNCAR.features.length} beacons), ` +
            `spp marks=${data.BOYSPP.features.length + data.BCNSPP.features.length}, ` +
            `polygons: ${data.DEPARE.features.length} depare(+drgare), ${data.LNDARE.features.length} lndare, ` +
            `${data.COALNE.features.length} coalne, ${data.DEPCNT.features.length} depcnt ` +
            `(safety VALDCO by cell=${
                Object.values(safetyByCell)
                    .filter((v): v is number => v != null)
                    .sort((a, b) => a - b)
                    .join('/') || 'n/a'
            } @ S=${safetyDepthM.toFixed(1)}m), ` +
            `${data.OBSTRN.features.length + data.WRECKS.features.length + data.UWTROC.features.length} hazard pts`,
    );
    // Wake a parked render loop (see refreshEncVectorData): with rAF
    // throttled, the mount's source uploads sit untiled until the next
    // interaction — the chart mounts invisible.
    try {
        map.triggerRepaint();
    } catch {
        /* map mid-teardown */
    }
}

/**
 * Idempotent mount. Adds (or updates) all sources + layers. Safe to
 * call repeatedly — re-using existing sources avoids the
 * layer-rebuild cost on cell-list changes; we just setData on the
 * source.
 */
/** Depth-AREA band fills, lifted out of the mount monolith (#2b, pure
 *  move): the absolute white-ramp DEPARE, the satellite glaze twin, and
 *  the fine-survey water repainted above land. Sources are ensured by the
 *  caller; the base-treatment + tide sync run in the caller right after. */
function mountDepthAreaLayers(
    map: mapboxgl.Map,
    minZoom: number,
    beforeIdFor: (layerId: string) => string | undefined,
): void {
    // ── DEPARE (absolute white-ramp band fills) ───────────────────
    if (!map.getLayer(ENC_VEC_LAYERS.DEPARE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPARE,
                type: 'fill',
                source: ENC_VEC_SRC.DEPARE,
                minzoom: minZoom,
                paint: {
                    // Absolute paper-chart ramp — see
                    // buildDepareFillColor. Static: draft changes move
                    // only the safety contour now.
                    'fill-color': buildDepareFillColor(),
                    // Near-opaque paper on the chart, depth-graded
                    // glaze over satellite — syncDepareBaseTreatment
                    // right below picks per the current base.
                    'fill-opacity': DEPARE_CHART_OPACITY,
                    // NO antialiasing: adjacent bands (and the 1°×1° cell
                    // tiles) abut exactly; AA outlines on translucent
                    // fills double-painted every shared edge into a
                    // hairline "graticule" over the glaze (Shane
                    // 2026-07-11: "dead straight horizontal and vertical
                    // lines"). Aliased band edges are sub-pixel at retina.
                    'fill-antialias': false,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPARE),
        );
    } else {
        // Heal layers created by earlier app versions (AA on).
        map.setPaintProperty(ENC_VEC_LAYERS.DEPARE, 'fill-antialias', false);
    }
    // ── DEPARE_GLAZE (overlap-clipped satellite twin) ─────────────
    // FLAT two-tone colour off the CLIPPED collection (white / drying
    // khaki, chart datum) — NOT the depth ramp: graded hues turned
    // every clipped-piece overlap into a different-tone rectangle
    // ("blocky squares... 80's styling", 2026-07-14). White-on-white
    // overlap is just white. syncDepareBaseTreatment owns the opacity
    // (0 on the chart, the keel-keyed glaze over imagery).
    if (!map.getLayer(ENC_VEC_LAYERS.DEPARE_GLAZE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPARE_GLAZE,
                type: 'fill',
                source: ENC_VEC_SRC.DEPARE_GLAZE,
                minzoom: minZoom,
                paint: {
                    // Placeholder S — syncDepareBaseTreatment (called right after
                    // mount) re-asserts colour + opacity keyed to the live draft.
                    'fill-color': buildDepareGlazeFillColor(DEFAULT_SAFETY_DEPTH_M),
                    'fill-opacity': 0,
                    // AA OFF, matching the chart fills (Shane 2026-07-12:
                    // "vertical + horizontal lines" once the 172-cell
                    // bucket landed). Overlap-clipping stops the WITHIN-
                    // cell band feathers from double-painting, but it does
                    // nothing for adjacent CELLS: their clipped glaze
                    // polygons abut along dead-straight bbox edges, and AA
                    // feathered every one of those seams into a hairline —
                    // invisible at 19 cells, a full graticule at 172.
                    // Aliased band edges are sub-pixel on the retina phone;
                    // if desktop stair-steps ever bite, the fix is a cross-
                    // cell geometry dissolve, not AA back on.
                    'fill-antialias': false,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPARE_GLAZE),
        );
    }
    // ── DEPARE_FINE (fine-survey water repainted ABOVE land) ──────
    // Same source, filtered to harbour-grade ranks. Sits over LNDARE/
    // COALNE so a coarse cell's generalised land blob can't swallow a
    // finer survey's rivers and canal estates (Mooloolaba, 2026-07-11).
    // Not clickable — the base DEPARE layer answers taps.
    if (!map.getLayer(ENC_VEC_LAYERS.DEPARE_FINE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPARE_FINE,
                type: 'fill',
                source: ENC_VEC_SRC.DEPARE,
                minzoom: minZoom,
                filter: DEPARE_FINE_RANK_FILTER,
                paint: {
                    'fill-color': buildDepareFillColor(),
                    'fill-opacity': DEPARE_CHART_OPACITY,
                    'fill-antialias': false,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPARE_FINE),
        );
    }
}

/** Depth-CONTOUR layers, lifted out of the mount monolith (mission-audit
 *  #2b — pure statement move, identical behaviour): the interpolated
 *  DERIVED densification (faint teal dashes that can never pass for
 *  surveyed) plus the official DEPCNT trio — thin ordinary contours, the
 *  bold per-cell safety contour, and the along-line value labels. Sources
 *  are already ensured by the caller; this only adds the layers. */
function mountContourLayers(
    map: mapboxgl.Map,
    minZoom: number,
    opacity: number,
    safetyByCell: Readonly<Record<string, number | null>>,
    beforeIdFor: (layerId: string) => string | undefined,
): void {
    // ── DEPCNT_DERIVED (contours interpolated from our soundings) ──
    // Honest densification (2026-07-12): a distinct TEAL-GREY, DASHED,
    // faint line, deliberately unlike the official slate DEPCNT so it
    // can never pass for surveyed data. Sits UNDER the official trio, so
    // a real contour always draws over an interpolated one. z13+ — this
    // is close-in shallow-water detail, not an overview layer.
    if (!map.getLayer(ENC_VEC_LAYERS.DEPCNT_DERIVED_LINE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPCNT_DERIVED_LINE,
                type: 'line',
                source: ENC_VEC_SRC.DEPCNT_DERIVED,
                minzoom: 13,
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#5b9aa0',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 1.1],
                    'line-opacity': 0.5,
                    'line-dasharray': [2, 3],
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPCNT_DERIVED_LINE),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.DEPCNT_DERIVED_LABEL)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPCNT_DERIVED_LABEL,
                type: 'symbol',
                source: ENC_VEC_SRC.DEPCNT_DERIVED,
                minzoom: 14,
                layout: {
                    'symbol-placement': 'line',
                    'symbol-spacing': 600,
                    // Italic + a tilde: chart convention for an approximate /
                    // unsurveyed depth. Reads "about 5 m", never "5 m surveyed".
                    'text-field': ['concat', '~', ['to-string', ['get', '_valdco']]],
                    'text-font': ['DIN Pro Italic', 'Arial Unicode MS Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 14, 8, 16, 10],
                    'text-allow-overlap': false,
                    'text-padding': 6,
                },
                paint: {
                    'text-color': '#5b9aa0',
                    'text-halo-color': 'rgba(255, 255, 255, 0.75)',
                    'text-halo-width': 0.8,
                    'text-opacity': 0.75,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPCNT_DERIVED_LABEL),
        );
    }

    // ── DEPCNT (depth contours + bold safety contour) ─────────────
    // Two layers off one source: thin gray ordinary contours
    // (SCAMIN-gated) and the bold dark safety contour — per S-52 the
    // single most prominent line on the water, never zoom-gated.
    // Filters move atomically with the fill bands via
    // updateEncDepthStyle when the draft changes.
    if (!map.getLayer(ENC_VEC_LAYERS.DEPCNT_LINE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPCNT_LINE,
                type: 'line',
                source: ENC_VEC_SRC.DEPCNT,
                minzoom: minZoom,
                filter: depcntLineFilter(safetyByCell),
                paint: {
                    'line-color': '#7d8e9b',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 15, 1.0],
                    'line-opacity': 0.7,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPCNT_LINE),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.DEPCNT_SAFETY)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPCNT_SAFETY,
                type: 'line',
                source: ENC_VEC_SRC.DEPCNT,
                minzoom: minZoom,
                filter: depcntSafetyFilter(safetyByCell),
                paint: {
                    // Slate hairline, not marker pen (Shane 2026-07-11:
                    // "horrible black lines" — ECDIS-bold traced every bank
                    // in a shallow bay into black scribble on the white
                    // paper). Still the only keel-aware line on the chart;
                    // now it whispers it.
                    'line-color': '#44586a',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 15, 1.4],
                    'line-opacity': 0.9,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPCNT_SAFETY),
        );
    }
    // ── DEPCNT value labels ("more depth numbers", Shane 2026-07-09) ──
    // Every contour already carries VALDCO; labelling it along the line
    // is how paper charts pack depth-reading into open water without a
    // sounding cloud. Sparse line placement + collision culling keep it
    // chart-clean; the numbers inherit the contour's muted slate so
    // soundings (brighter) stay the primary read.
    if (!map.getLayer(ENC_VEC_LAYERS.DEPCNT_LABEL)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPCNT_LABEL,
                type: 'symbol',
                source: ENC_VEC_SRC.DEPCNT,
                minzoom: 11,
                filter: mapFilter(SCAMIN_CLAUSE),
                layout: {
                    'symbol-placement': 'line',
                    'symbol-spacing': 350,
                    'text-field': buildDepcntLabelField(0),
                    'text-font': ['DIN Pro Italic', 'Arial Unicode MS Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9, 15, 11],
                    'text-allow-overlap': false,
                    'text-padding': 4,
                },
                paint: {
                    // Muted dark slate on a thin light halo — legible on
                    // the white ramp and over satellite imagery, quieter
                    // than the soundings (which stay the primary read).
                    // Shared constant: applyTideOffsetPaint re-asserts the
                    // same ink on every mount, so a second hardcoded hex
                    // here silently drifts (2026-07-12 audit).
                    'text-color': DEPCNT_LABEL_INK_DATUM,
                    'text-halo-color': 'rgba(255, 255, 255, 0.8)',
                    'text-halo-width': 0.8,
                    'text-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPCNT_LABEL),
        );
    }
}

/**
 * THE source table (closing audit: the mount's ensureSource calls and the
 * refresh's staggered upload list were hand-mirrored — a source added to
 * one but not the other shipped a permanently blank layer). One row per
 * GeoJSON source, in STAGGERED-UPLOAD PRIORITY order (glaze first: on
 * satellite it IS the chart); `buffer` tunes the tile-buffer per geometry
 * kind (symbols need the default 128 for cross-tile collision, fills clip
 * clean at seams). Mount + refresh both iterate THIS.
 */
export const ENC_SOURCE_TABLE: ReadonlyArray<{
    id: string;
    build: (data: EncMergedVectorData) => FeatureCollection;
    buffer?: number;
}> = [
    { id: ENC_VEC_SRC.DEPARE_GLAZE, build: (d) => d.DEPARE_GLAZE, buffer: 8 },
    { id: ENC_VEC_SRC.DEPARE, build: (d) => d.DEPARE, buffer: 8 },
    { id: ENC_VEC_SRC.LNDARE, build: (d) => d.LNDARE, buffer: 16 },
    { id: ENC_VEC_SRC.DEPCNT, build: (d) => d.DEPCNT },
    { id: ENC_VEC_SRC.SOUNDG, build: (d) => d.SOUNDG },
    { id: ENC_VEC_SRC.COALNE, build: (d) => d.COALNE, buffer: 32 },
    { id: ENC_VEC_SRC.POINTS, build: (d) => buildMergedPoints(d) },
    { id: ENC_VEC_SRC.NAVAIDS, build: (d) => buildMergedNavaids(d) },
    { id: ENC_VEC_SRC.RECTRC, build: (d) => d.RECTRC },
    { id: ENC_VEC_SRC.LIGHTSEC, build: (d) => d.LIGHTSEC, buffer: 32 },
    { id: ENC_VEC_SRC.DEPCNT_DERIVED, build: (d) => d.DEPCNT_DERIVED },
    { id: ENC_VEC_SRC.SEAARE_LABELS, build: (d) => d.SEAARE_LABELS },
    { id: ENC_VEC_SRC.CAUTION_AREAS, build: (d) => d.CAUTION_AREAS, buffer: 8 },
    { id: ENC_VEC_SRC.FAIRWY, build: (d) => d.FAIRWY, buffer: 8 },
];

export function mountEncVectorLayer(
    map: mapboxgl.Map,
    data: EncMergedVectorData,
    opts: EncVectorMountOptions = {},
): void {
    const minZoom = opts.minZoom ?? 7;
    const opacity = opts.opacity ?? 0.85;
    const safetyDepthM = opts.safetyDepthM ?? DEFAULT_SAFETY_DEPTH_M;

    // IALA symbol sprites for the buoy/beacon symbol layers.
    // Idempotent (hasImage guard inside) and async — Mapbox repaints
    // symbol layers as each image lands, so fire-and-forget is fine.
    void registerSeamarkIcons(map);

    // Seed the per-map depth-style state so updateEncDepthStyle /
    // refresh can recompute the safety contour later. MERGE with the
    // previous state — the tide offset, its scrub timestamp AND the
    // draft-assumed honesty flag all survive re-mounts (style swaps,
    // cell loads): they belong to the MODE, not the mount. Rebuilding
    // this object from scratch silently wiped them, so a re-mount
    // could relabel a scrubbed verdict "Right now" and drop the
    // "default 2.5 m draft" caveat for the session (2026-07-12 audit).
    const prevState = depthStyleState.get(map);
    const valdcosByCell = distinctValdcosByCell(data.DEPCNT);
    depthStyleState.set(map, {
        ...prevState,
        safetyDepthM,
        depcntValdcosByCell: valdcosByCell,
        tideOffsetM: prevState?.tideOffsetM ?? null,
    });
    const safetyByCell = computeSafetyValdcoByCell(valdcosByCell, safetyDepthM);

    // Tile buffer per source: symbols need the default 128 (cross-tile
    // label collision), but fills clip cleanly at seams and plain lines
    // only need enough for caps/joins — the geojson worker then tiles
    // 4-16× less overlap geometry for the heaviest sources (DEPARE and
    // the glaze), which is real pan/zoom smoothness on a 47-cell view.
    // DEPCNT keeps the default: its valdco labels ride the lines.
    // FIRST-MOUNT STAGGER (2026-07-17 audit): creating every source with
    // its full payload pushed all 14 serialisations into ONE synchronous
    // tick — the boot-path analogue of the re-merge hitch the staggered
    // refresh already cures. New sources are created EMPTY; one deferred
    // refreshEncVectorData call at the end of the mount uploads the real
    // payloads a-frame-at-a-time. Existing sources (style swap) keep the
    // immediate setData — their GPU tiles are warm and a stagger would
    // flash stale layers.
    let createdAnySource = false;
    const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const ensureSource = (id: string, buildFc: () => FeatureCollection, buffer?: number) => {
        const existing = map.getSource(id);
        if (existing && 'setData' in existing) {
            (existing as mapboxgl.GeoJSONSource).setData(buildFc());
            return;
        }
        createdAnySource = true;
        map.addSource(id, {
            type: 'geojson',
            data: EMPTY_FC,
            generateId: true,
            ...(buffer != null ? { buffer } : {}),
        });
    };

    for (const row of ENC_SOURCE_TABLE) ensureSource(row.id, () => row.build(data), row.buffer);

    const anchor = findInsertionAnchor(map);

    /**
     * Strict z-order under idempotent-additive mounting: insert each
     * layer before the next HIGHER layer that already exists on the
     * map, falling back to the settlement-label anchor. Append order
     * alone would stack any newly-introduced layer on top of
     * everything from earlier app versions.
     */
    const beforeIdFor = (layerId: string): string | undefined => {
        const idx = ALL_LAYER_IDS.indexOf(layerId as (typeof ALL_LAYER_IDS)[number]);
        if (idx >= 0) {
            for (let i = idx + 1; i < ALL_LAYER_IDS.length; i++) {
                if (map.getLayer(ALL_LAYER_IDS[i])) return ALL_LAYER_IDS[i];
            }
        }
        return anchor;
    };

    // Depth-area band fills (DEPARE + satellite glaze + fine repaint) live
    // in mountDepthAreaLayers now — see #2b.
    mountDepthAreaLayers(map, minZoom, beforeIdFor);

    // Mount can happen while satellite is already on (style swap,
    // late cell load) — apply the right treatment immediately. Same
    // for a live tide offset: re-point the depth readouts at it.
    syncDepareBaseTreatment(map);
    applyTideOffsetPaint(map, depthStyleState.get(map)?.tideOffsetM ?? null);

    // Depth-contour layers (derived densification + official DEPCNT trio)
    // live in mountContourLayers now — see #2b.
    mountContourLayers(map, minZoom, opacity, safetyByCell, beforeIdFor);

    mountLandCoastLayers(map, minZoom, opacity, beforeIdFor);

    mountCautionAreaLayers(map, beforeIdFor);

    mountPointMarkLayers(map, minZoom, opacity, beforeIdFor);

    mountSoundingLabelLayers(map, opacity, beforeIdFor);

    mountTrackAidLayers(map, data, minZoom, opacity, safetyByCell, safetyDepthM, anchor, beforeIdFor);

    // First mount created empty sources — hand the real payloads to the
    // staggered uploader (one source per frame, biggest first).
    if (createdAnySource) refreshEncVectorData(map, data);
}

/**
 * Replace just the underlying source data without rebuilding
 * layers. Faster than a full mount cycle when cells are imported
 * or removed mid-session.
 */
/**
 * Push ONLY the worker-upgraded collections (hole-free satellite glaze,
 * sounding-derived contours) into their live sources. Called by the hook
 * when encGeometryWorker's answer lands in the cached merge — a focused
 * two-source refresh, not the full 14-source re-upload.
 */
export function refreshEncAsyncLayers(map: mapboxgl.Map, data: EncMergedVectorData): void {
    const setData = (id: string, fc: FeatureCollection) => {
        const src = map.getSource(id);
        if (src && 'setData' in src) (src as mapboxgl.GeoJSONSource).setData(fc);
    };
    setData(ENC_VEC_SRC.DEPARE_GLAZE, data.DEPARE_GLAZE);
    setData(ENC_VEC_SRC.DEPCNT_DERIVED, data.DEPCNT_DERIVED);
}

/** Monotonic token — a newer refresh supersedes the staggered tail of an
 *  older one (per map is overkill: one chart map exists per session). */
let refreshGeneration = 0;

// ── Night dim (S-52 night-palette v1) ──────────────────────────────
// The near-opaque white DEPARE ramp at the helm destroys night vision
// (burn-down). Chartplotter-style uniform dim: one dark-red-tinted fill
// over the WHOLE map stack (red preserves scotopic vision), added with no
// beforeId so it sits above every map layer — DOM UI is unaffected. A
// world polygon avoids fighting the dynamic paint state machines
// (syncDepareBaseTreatment / applyTideOffsetPaint) that own the ENC fills.

const NIGHT_DIM_LAYER = 'enc-night-dim';
export const ENC_NIGHT_DIM_KEY = 'thalassa_enc_night_dim';

const NIGHT_DIM_OVERLAY_ID = 'enc-night-dim-overlay';

export function setEncNightDim(map: mapboxgl.Map, on: boolean): void {
    // ROUND 2 (2026-07-17 audit): the v1 map-LAYER dim covered the canvas
    // only — DOM UI (panels, sheets, chips) kept full-brightness glare at
    // the helm, and any layer added after the dim mounted painted ABOVE
    // it. One fixed full-screen DOM overlay retires both: it sits over
    // everything the app draws, map and UI alike, and nothing can be
    // z-ordered past it. pointer-events:none keeps every interaction live.
    if (map.getLayer(NIGHT_DIM_LAYER)) map.removeLayer(NIGHT_DIM_LAYER); // legacy v1 cleanup
    const existing = document.getElementById(NIGHT_DIM_OVERLAY_ID);
    if (!on) {
        existing?.remove();
        return;
    }
    if (existing) return;
    const el = document.createElement('div');
    el.id = NIGHT_DIM_OVERLAY_ID;
    el.style.cssText = 'position:fixed;inset:0;background:#1a0505;opacity:0.45;pointer-events:none;z-index:2147483000;';
    document.body.appendChild(el);
}

export function refreshEncVectorData(map: mapboxgl.Map, data: EncMergedVectorData): void {
    const generation = ++refreshGeneration;
    const setData = (id: string, fc: FeatureCollection) => {
        const src = map.getSource(id);
        if (src && 'setData' in src) (src as mapboxgl.GeoJSONSource).setData(fc);
    };
    // STAGGERED upload ("free flowing", Shane 2026-07-14): every setData
    // serialises a multi-thousand-feature collection to Mapbox's worker
    // ON the main thread — pushing all 14 sources in one tick was a
    // 100-400 ms hitch on every window-escape re-merge, felt as a jerk
    // mid-pan/zoom. One source per animation frame spreads the same work
    // across ~12 frames; layers refresh progressively and imperceptibly.
    // The two biggest ship first so the visual core lands early; a newer
    // refresh simply abandons the tail of a superseded one (adjacent
    // windows share most content — a stale side layer survives a frame
    // or two at worst).
    // Derived from THE source table (closing audit: this list and the
    // mount's ensureSource calls were hand-mirrored). Table order IS the
    // upload priority — glaze first: on satellite it IS the chart, the
    // white wash "popping" at z10 is the thing the punter waits on
    // (2026-07-14); on the white chart it's an invisible no-op.
    const uploads: Array<() => void> = ENC_SOURCE_TABLE.map((row) => () => setData(row.id, row.build(data)));
    // rAF with a WATCHDOG (2026-07-15, "your white layer is not showing…
    // just the old enc layer"): rAF only fires while the browser is
    // painting — an occluded/throttled tab (browser pane, PWA behind the
    // lock screen, Safari page-cache) parks it, which froze this queue
    // MID-WAY and left the sources permanently stale. A raced setTimeout
    // keeps the queue draining at ~20 fps even with rAF parked; whichever
    // scheduler fires first wins, the other is cancelled by the `done`
    // latch.
    const schedule = (cb: () => void): void => {
        let done = false;
        const once = () => {
            if (done) return;
            done = true;
            cb();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
        setTimeout(once, 48);
    };
    // Gesture-deferred (2026-07-14): even ONE big setData mid-gesture
    // drops frames, so while the camera is moving the loop idles and the
    // previous window's chart keeps rendering — it covers most of the
    // screen anyway. Capped by TIME, not frames (frames don't tick when
    // rAF is parked), so a perpetual camera animation can't stall
    // uploads past ~3 s.
    const deferStart = Date.now();
    const step = (): void => {
        if (generation !== refreshGeneration) return; // superseded — newer refresh owns the sources
        if (typeof map.isMoving === 'function' && map.isMoving() && Date.now() - deferStart < 3000) {
            schedule(step);
            return;
        }
        const job = uploads.shift();
        if (!job) return;
        try {
            job();
        } catch {
            /* source mid-teardown — the next refresh re-applies */
        }
        if (uploads.length > 0) {
            schedule(step);
        } else {
            // Wake a parked render loop: Mapbox schedules its own tiling
            // repaint via rAF too, so with rAF throttled the final setData
            // otherwise sits untiled until the next user interaction —
            // the sources LOOK stale ("the old enc layer") while holding
            // fresh data.
            try {
                map.triggerRepaint();
            } catch {
                /* map mid-teardown */
            }
        }
    };
    step(); // first source immediately (or deferred past a live gesture)

    // New cells can carry different charted contour values — refresh
    // the VALDCO inventory and re-derive the safety contour at the
    // last-applied safety depth. MERGE, never rebuild: this fires on
    // every window-escape pan and every cloud-hydration arrival, and
    // rebuilding the state object from scratch wiped tideOffsetM /
    // tideOffsetAtMs / draftAssumed while the tide-tinted paint stayed
    // on screen — teal "live" soundings answering taps in chart datum,
    // and the "default 2.5 m draft" caveat lost for the session
    // (2026-07-12 audit, the mixed-datum trap this module's own rules
    // prohibit).
    const state = depthStyleState.get(map);
    const safetyDepthM = state?.safetyDepthM ?? DEFAULT_SAFETY_DEPTH_M;
    depthStyleState.set(map, {
        ...state,
        safetyDepthM,
        depcntValdcosByCell: distinctValdcosByCell(data.DEPCNT),
    });
    updateEncDepthStyle(map, safetyDepthM);

    log.info(`refreshed vector data: ${data.cellCount} cells`);
}

/**
 * Tear down all sources + layers. Idempotent.
 */
export function unmountEncVectorLayer(map: mapboxgl.Map): void {
    for (const id of ALL_LAYER_IDS) {
        if (map.getLayer(id)) {
            try {
                map.removeLayer(id);
            } catch {
                /* best effort */
            }
        }
    }
    for (const id of ALL_SOURCE_IDS) {
        if (map.getSource(id)) {
            try {
                map.removeSource(id);
            } catch {
                /* best effort */
            }
        }
    }
    log.info('unmounted ENC vector layers');
}

/**
 * Satellite-base gate. When the user has satellite imagery on, the opaque
 * LAND fills must never paint — they'd blanket the imagery. The DEPARE
 * ramp is different since 2026-07-11 ("our layer sitting on top of the
 * satellite layer"): it stays VISIBLE as a translucent glaze — see
 * syncDepareBaseTreatment. Every visibility writer in this module
 * consults this so that cell-list bumps, master toggles, detail mode and
 * route-focus can't re-show a land fill (or leave the wrong DEPARE
 * treatment) behind MapHub's back, whatever order they run in. Contour
 * LINES, coastline, markers and hazards are unaffected — they read fine
 * on top of imagery.
 */
/** Exported (closing audit): MapHub WRITES this key raw while every ENC
 *  visibility decision READS it here — an untested cross-file string
 *  equality. One home, both sides import. */
export const SATELLITE_KEY = 'thalassa_satellite_base_v2';
// Land fills blanket the imagery; COALNE is CHART furniture that reads as
// scribble over photos (Shane 2026-07-11: "the thick black line, the
// straight brown lines… can we remove all of these" — the brown was the
// 1:90k cell's generalized coastline drawn straight across a headland the
// imagery already shows). Land + coastline stay hidden.
//
// The bold SAFETY contour USED to hide here too, but that left satellite
// with no crisp keel line once the glaze retires on coarse cells at
// overview zoom (mission-audit #3c). It now STAYS on satellite, re-styled
// by syncDepareBaseTreatment as a deliberate amber keel-limit line — one
// per-cell contour, NOT the "thick black scribble" Shane rejected. The
// thin grey depth contours + labels also stay: they carry information the
// imagery can't.
const SATELLITE_HIDE_LAYERS: readonly string[] = [
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.LNDARE_ISLET,
    ENC_VEC_LAYERS.COALNE,
];
function satelliteBaseOn(): boolean {
    try {
        return localStorage.getItem(SATELLITE_KEY) === 'true';
    } catch {
        return false;
    }
}

/**
 * Survey-competence filter for the satellite glaze: a band from a coarse
 * cell retires at zooms beyond its survey's generalisation — a 1:90k
 * flats polygon drawn at street zoom cut "1980s edges" across the real
 * foreshore imagery (Shane 2026-07-11: "we don't need those"). Bare
 * imagery beats a wrong edge. Ranks come from cellScaleRank (higher =
 * finer); unranked features never retire. Chart mode keeps everything —
 * there's no imagery to contradict, the chart IS the picture (and the
 * tap-the-water popup keeps answering everywhere).
 */
const DEPARE_RANK = ['coalesce', ['to-number', ['get', '_scaleRank']], 32000];
const DEPARE_COMPETENCE_FILTER = mapFilter([
    'step',
    ['zoom'],
    true,
    10,
    ['>=', DEPARE_RANK, -200], // ocean/overview cells bow out
    12,
    ['>=', DEPARE_RANK, -120],
    14,
    ['>=', DEPARE_RANK, -40],
    16,
    ['>=', DEPARE_RANK, 40], // ~1° coastal cells bow out at street zoom
]);

/** Harbour-grade fineness gate for the over-land repaint (rank from
 *  cellScaleRank: ~1-degree coastal cells are ~0; harbour cells 80+). */
const DEPARE_FINE_RANK_FILTER = mapFilter(['>=', ['coalesce', ['to-number', ['get', '_scaleRank']], -32768], 40]);

/**
 * Re-point BOTH DEPARE fills at the current base: near-opaque paper on
 * the chart, depth-graded glaze + competence filter over satellite.
 * Called by every visibility writer here plus MapHub's satellite
 * effect, so no code path can leave the wrong treatment behind.
 */
export function syncDepareBaseTreatment(map: mapboxgl.Map): void {
    if (!map.getLayer(ENC_VEC_LAYERS.DEPARE)) return;
    const satOn = satelliteBaseOn();
    // Over imagery the GLAZE layer (overlap-clipped collection) is the
    // ONLY band painter — the plain fills go opacity-0. Translucent
    // twins stack: DEPARE + DEPARE_FINE double-painted every fine
    // feature, and unclipped coarse-under-fine doubled the rest into
    // the hard-edged dark wedges (Shane 2026-07-12: "horrible 80's
    // style rendering"). On the chart the opaque originals return and
    // the glaze goes opacity-0.
    map.setPaintProperty(ENC_VEC_LAYERS.DEPARE, 'fill-opacity', satOn ? 0 : DEPARE_CHART_OPACITY);
    map.setFilter(ENC_VEC_LAYERS.DEPARE, satOn ? DEPARE_COMPETENCE_FILTER : null);
    if (map.getLayer(ENC_VEC_LAYERS.DEPARE_FINE)) {
        map.setPaintProperty(ENC_VEC_LAYERS.DEPARE_FINE, 'fill-opacity', satOn ? 0 : DEPARE_CHART_OPACITY);
        // The twin ALWAYS keeps its fineness gate; satellite adds the
        // competence ladder on top (harbour cells never retire anyway).
        map.setFilter(
            ENC_VEC_LAYERS.DEPARE_FINE,
            satOn ? mapFilter(['all', DEPARE_FINE_RANK_FILTER, DEPARE_COMPETENCE_FILTER]) : DEPARE_FINE_RANK_FILTER,
        );
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPARE_GLAZE)) {
        // Heal AA on glaze layers built before 2026-07-12 (AA was on):
        // adjacent cells' clipped glaze polygons feathered every bbox
        // seam into a graticule once the 172-cell bucket landed. Cheap
        // to re-assert every sync — Mapbox no-ops if already false.
        map.setPaintProperty(ENC_VEC_LAYERS.DEPARE_GLAZE, 'fill-antialias', false);
        // Keel-keyed glaze: bright paper where the band guarantees the
        // safety depth, bare imagery where it doesn't. Chart datum by
        // the same hard rule as the safety contour — the tide scrubber
        // never moves the go/no-go read. Colour and opacity are asserted
        // TOGETHER on the same datum (pairing invariant, encDepthStyle):
        // applyTideOffsetPaint deliberately skips this layer.
        const safetyDepthM = depthStyleState.get(map)?.safetyDepthM ?? DEFAULT_SAFETY_DEPTH_M;
        map.setPaintProperty(ENC_VEC_LAYERS.DEPARE_GLAZE, 'fill-color', buildDepareGlazeFillColor(safetyDepthM));
        map.setPaintProperty(
            ENC_VEC_LAYERS.DEPARE_GLAZE,
            'fill-opacity',
            satOn ? buildDepareSatelliteOpacity(safetyDepthM) : 0,
        );
        map.setFilter(ENC_VEC_LAYERS.DEPARE_GLAZE, satOn ? DEPARE_COMPETENCE_FILTER : null);
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPCNT_SAFETY)) {
        // The one keel-limit line, re-styled per base (#3c). On the white
        // chart it stays the slate hairline Shane tuned; on satellite slate
        // goes muddy over water, so it becomes a deliberate AMBER line — the
        // crisp go/no-go boundary the glaze edge only implies, and still
        // legible on coarse cells at overview zoom where the glaze retires.
        // One per-cell contour, amber, hairline-to-modest — NOT the "thick
        // black scribble" Shane rejected (2026-07-11).
        map.setPaintProperty(ENC_VEC_LAYERS.DEPCNT_SAFETY, 'line-color', satOn ? '#f97316' : '#44586a');
        map.setPaintProperty(
            ENC_VEC_LAYERS.DEPCNT_SAFETY,
            'line-width',
            satOn
                ? ['interpolate', ['linear'], ['zoom'], 8, 1.0, 15, 2.2]
                : ['interpolate', ['linear'], ['zoom'], 8, 0.8, 15, 1.4],
        );
        map.setPaintProperty(ENC_VEC_LAYERS.DEPCNT_SAFETY, 'line-opacity', satOn ? 1 : 0.9);
    }
}

// ── Visibility state machine (closing audit) ───────────────────────
//
// FIVE writers used to compose by mutating the same layout property with
// a "probe BCNLAT + whichever wrote 'none' last sticks" convention — an
// indirect channel that broke the moment BCNLAT joined any hide list,
// with the precedence specified only in prose. Now: each writer sets its
// FIELD on one explicit per-map state record and ONE composer derives
// every layer's visibility deterministically, in documented precedence:
//
//   1. master OFF hides everything (the FAB).
//   2. route-focus subtracts ROUTE_FOCUS_HIDE_LAYERS.
//   3. clean-chart (detailed=false) subtracts CHART_DETAIL_HIDE_LAYERS.
//   4. satellite base subtracts SATELLITE_HIDE_LAYERS.
//   5. the detail scrubber's cuts are never resurrected (its own channel).
//
// Call order no longer matters; toggling master can no longer stomp an
// active focus/clean mode.

export interface EncVisibilityState {
    master: boolean;
    routeFocused: boolean;
    detailed: boolean;
}

const visibilityState = new WeakMap<mapboxgl.Map, EncVisibilityState>();

function getVisibilityState(map: mapboxgl.Map): EncVisibilityState {
    let st = visibilityState.get(map);
    if (!st) {
        st = { master: true, routeFocused: false, detailed: true };
        visibilityState.set(map, st);
    }
    return st;
}

/** THE composer — the only writer of the visibility layout property.
 *  Exported for tests (a stub map with getLayer/setLayoutProperty is
 *  enough to verify the precedence table). */
export function applyEncVisibility(map: mapboxgl.Map): void {
    const st = getVisibilityState(map);
    const satOn = satelliteBaseOn();
    for (const id of ALL_LAYER_IDS) {
        if (!map.getLayer(id)) continue;
        let want = st.master;
        if (want && st.routeFocused && (ROUTE_FOCUS_HIDE_LAYERS as readonly string[]).includes(id)) want = false;
        if (want && !st.detailed && (CHART_DETAIL_HIDE_LAYERS as readonly string[]).includes(id)) want = false;
        if (want && satOn && SATELLITE_HIDE_LAYERS.includes(id)) want = false;
        if (want && isScrubHidden(id)) want = false;
        map.setLayoutProperty(id, 'visibility', want ? 'visible' : 'none');
    }
    syncDepareBaseTreatment(map);
}

/**
 * Master FAB toggle. Keeps the tile cache warm so re-show is instant —
 * and, unlike the old writer, no longer stomps an active focus/clean
 * mode: the composer re-derives them.
 */
export function setEncVectorVisibility(map: mapboxgl.Map, visible: boolean): void {
    getVisibilityState(map).master = visible;
    applyEncVisibility(map);
}

/**
 * Text-only label layers (OBJNAM + light character). Hidden in
 * route-focus mode so test-route debugging stays clean — names and
 * 'Fl(2)G 5s' strings fight the route polyline for attention.
 */
const ENC_LABEL_HIDE_LAYERS = [ENC_VEC_LAYERS.NAVAIDS_LABEL, ENC_VEC_LAYERS.POINTS_LABEL] as const;

/**
 * The ENC layers we drop when a route is on the map. Polygon fills
 * (DEPARE, LNDARE) and lines (COALNE) clutter the route polyline; the
 * lateral/cardinal markers + lights + obstruction symbols help the user
 * verify the route is sensible so we keep those visible. Hazard points
 * (WRECKS/UWTROC/OBSTRN as circles) also stay — they're the things the
 * router already routed around but the user wants to see.
 */
const ROUTE_FOCUS_HIDE_LAYERS = [
    ENC_VEC_LAYERS.DEPARE,
    ENC_VEC_LAYERS.DEPARE_FINE,
    // The satellite twin hides too — route-focus over imagery kept
    // painting keel-keyed bands at up to 0.72 opacity, fighting the
    // route polyline the mode exists to spotlight (2026-07-12 audit).
    // Visibility is a separate channel from the opacity/filter pair
    // syncDepareBaseTreatment manages, so the base-treatment sync
    // can't resurrect a hidden glaze.
    ENC_VEC_LAYERS.DEPARE_GLAZE,
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.COALNE,
    ...ENC_LABEL_HIDE_LAYERS,
] as const;

/**
 * "Clean chart" mode — hide the busy depth-band fills + contour lines so
 * the chart reads as just land + coastline + navigational markers +
 * hazards. COALNE (chart-source coastline) stays VISIBLE in clean mode
 * because it's the authoritative land/water boundary. With the LineIndex
 * field-order fix (2026-05-19) COALNE renders cleanly without
 * criss-cross spans.
 */
const CHART_DETAIL_HIDE_LAYERS = [
    ENC_VEC_LAYERS.DEPARE,
    ENC_VEC_LAYERS.DEPARE_FINE,
    // Clean chart means clean over imagery too (see the route-focus
    // note — visibility beats the base-treatment opacity writer).
    ENC_VEC_LAYERS.DEPARE_GLAZE,
    ENC_VEC_LAYERS.DEPCNT_LINE,
    ENC_VEC_LAYERS.DEPCNT_SAFETY,
    // Contour value labels travel with their contours.
    ENC_VEC_LAYERS.DEPCNT_LABEL,
] as const;

/**
 * Route-focus mode: hide the busy bulk-fill and coastline layers so the route
 * polyline is the dominant visual, but keep markers / lights / hazards so the
 * sailor can sense-check the route against channel marks.
 *
 * Composes with the master FAB toggle (`setEncVectorVisibility`) by reading
 * the BCNLAT layer's current visibility as a master-state probe — BCNLAT is
 * one of the marker layers we never hide, so its visibility equals the master
 * state. If master is off, we leave every layer hidden. If master is on, we
 * flip the bulk-fill subset and leave the markers alone.
 *
 * Idempotent — calling repeatedly with the same args costs almost nothing.
 */
export function setEncRouteFocusMode(map: mapboxgl.Map, focused: boolean): void {
    getVisibilityState(map).routeFocused = focused;
    applyEncVisibility(map);
}

/**
 * Chart-detail toggle: false = clean (land + markers + hazards only), true =
 * full (also depth-fills + coastline). Mirrors `setEncRouteFocusMode` shape
 * so MapHub can call them independently and the more-specific layer wins.
 *
 * Order rule: clean-chart can be on alongside route-focus; whichever sets
 * 'none' last sticks. Since both target overlapping layers (DEPARE/COALNE),
 * effectively "clean OR focused → hide" is what the user sees — which is
 * the intended composition.
 */
export function setEncChartDetail(map: mapboxgl.Map, detailed: boolean): void {
    getVisibilityState(map).detailed = detailed;
    applyEncVisibility(map);
}

// ── Click-to-popup ─────────────────────────────────────────────────
// The pure HTML half (formatters, S-57 label tables,
// buildFeaturePopupHtml) lives in encPopup.ts — this module keeps only
// the stateful wiring: handlers, suppression, the async tide window.

/**
 * Track click handlers per map for clean teardown. We can't use a
 * closure inside detachClickHandlers without a reference, so we
 * stash them on the map object itself via a WeakMap.
 */
interface AttachedHandlers {
    click: (e: mapboxgl.MapMouseEvent) => void;
    enter: () => void;
    leave: () => void;
    popup: mapboxgl.Popup | null;
}
const attachedHandlers = new WeakMap<mapboxgl.Map, AttachedHandlers>();

/**
 * Popup suppression — a tap sometimes means something else entirely
 * (tracer pin drops, picker mode, weather inspect). MapHub flips this
 * so the tap-the-water popup never fights those. PER MAP: every ENC
 * mount attaches popup handlers (embedded surfaces included), so a
 * module-global flag would let one surface mute another (review
 * minor, 2026-07-11).
 */
const popupSuppression = new WeakMap<mapboxgl.Map, boolean>();
export function setEncPopupSuppression(map: mapboxgl.Map, suppressed: boolean): void {
    popupSuppression.set(map, suppressed);
}

// ONE-SHOT: swallow the popup for the very next click. A long-press that
// places a tracer pin ALSO emits a click on release; the ENC click handler
// is a separate listener not covered by useMapInit's suppressNextClick, so
// without this a pin drop would pop up "Water 5 m" right where you plotted
// (Shane 2026-07-16, once popups went live during plotting). Set from the
// tracer's long-press placement; consumed by the next click.
const suppressNextClickPopup = new WeakMap<mapboxgl.Map, boolean>();
export function encSuppressNextClickPopup(map: mapboxgl.Map): void {
    suppressNextClickPopup.set(map, true);
}

/**
 * Async half of the tap-the-water popup: a needs-tide verdict shows
 * "checking tides…" and this fills in the actual window ("clears
 * 09:10–14:30 today") once the curve answers. No-ops silently when
 * the popup closed or tide data is unreachable.
 */
function fillDepareTideWindow(popup: mapboxgl.Popup, props: Record<string, unknown>, extras: PopupExtras): void {
    const d1 = Number(readS57(props, 'DRVAL1'));
    const S = extras.safetyDepthM;
    // Gate lives in needsTideWindow (pure, tested): keel-limited band the
    // current tide doesn't already clear.
    if (S == null || !needsTideWindow(d1, S, extras.tideOffsetM)) return;
    if (!popup.getElement()?.querySelector('.enc-popup-tidewin')) return;
    const at = popup.getLngLat();
    void Promise.all([import('../../services/routeTracer'), import('../../services/routing/tidalWindow')])
        .then(([{ tideWindowLabelFor }, { DEFAULT_TIDE_SAFETY_M }]) =>
            tideWindowLabelFor(d1, S - DEFAULT_TIDE_SAFETY_M, { lat: at.lat, lon: at.lng }),
        )
        .then((label) => {
            if (!popup.isOpen()) return;
            const span = popup.getElement()?.querySelector('.enc-popup-tidewin');
            if (span) span.textContent = label ?? 'tide data unavailable right now';
        })
        .catch(() => {
            const span = popup.getElement()?.querySelector('.enc-popup-tidewin');
            if (span) span.textContent = 'tide data unavailable right now';
        });
}

/** Point-feature layers — small tap targets that get the padded
 *  fat-finger search box (vs. area fills, which keep exact-point).
 *  DERIVED from the canonical S57_POINT_MARK_CLASSES registry so this
 *  can't drift from the layer/popup machinery (mission-audit #2a). */
const POINT_LAYER_IDS = new Set<string>(S57_POINT_MARK_CLASSES.map((c) => ENC_VEC_LAYERS[c]));
const CLICKABLE_POINT_LAYER_IDS = CLICKABLE_LAYER_IDS.filter((id) => POINT_LAYER_IDS.has(id));

/** Fat-finger tap tolerance in screen px. Wreck dots render ~13-18 px
 *  and an exact-pixel hit test made a near-miss silently answer about
 *  the WATER instead of the mark a gloved hand was asking about
 *  (2026-07-12 audit) — the popup's "Pass NORTH of this mark" row is
 *  worthless if you can't hit the mark from a moving deck. */
const TAP_PAD_PX = 12;

/**
 * Is there a clickable ENC feature (mark / light / hazard / water) under this
 * tap? Same padded-box-for-points + exact-point-for-areas test the click
 * handler uses. The tracer calls this so a tap that hit a mark shows its
 * popup (and skips the "hold to drop a pin" coach) while plotting — placement
 * is the long press, so a tap is free to inspect (Shane 2026-07-16).
 */
export function encHasClickableFeatureAt(map: mapboxgl.Map, lngLat: { lat: number; lng: number }): boolean {
    try {
        const p = map.project([lngLat.lng, lngLat.lat]);
        const box: [mapboxgl.PointLike, mapboxgl.PointLike] = [
            [p.x - TAP_PAD_PX, p.y - TAP_PAD_PX],
            [p.x + TAP_PAD_PX, p.y + TAP_PAD_PX],
        ];
        if (
            CLICKABLE_POINT_LAYER_IDS.length > 0 &&
            map.queryRenderedFeatures(box, { layers: CLICKABLE_POINT_LAYER_IDS }).length > 0
        ) {
            return true;
        }
        return map.queryRenderedFeatures(p, { layers: CLICKABLE_LAYER_IDS }).length > 0;
    } catch {
        return false; // style mid-swap — treat as no feature
    }
}

/**
 * Wire up ONE map-level click handler for every ENC vector layer so
 * tapping a feature shows a popup describing it. Map-level (not
 * per-layer): 17 per-layer registrations ran the full query/HTML/popup
 * cycle once per hit layer on a single stacked tap. Idempotent — if
 * handlers are already attached, this is a no-op.
 */
export function attachEncFeatureClickHandlers(map: mapboxgl.Map): void {
    if (attachedHandlers.has(map)) return;

    const onClick = (e: mapboxgl.MapMouseEvent) => {
        // Swallow the release-click that follows a long-press pin placement.
        if (suppressNextClickPopup.get(map)) {
            suppressNextClickPopup.set(map, false);
            return;
        }
        if (popupSuppression.get(map)) return;
        // Marks first, through the padded box — the NEAREST mark to the
        // tap wins, so a finger-width miss still answers about the buoy,
        // not the depth area beneath it.
        const box: [mapboxgl.PointLike, mapboxgl.PointLike] = [
            [e.point.x - TAP_PAD_PX, e.point.y - TAP_PAD_PX],
            [e.point.x + TAP_PAD_PX, e.point.y + TAP_PAD_PX],
        ];
        const pointHits =
            CLICKABLE_POINT_LAYER_IDS.length > 0
                ? map.queryRenderedFeatures(box, { layers: CLICKABLE_POINT_LAYER_IDS })
                : [];
        let feat: mapboxgl.GeoJSONFeature | undefined;
        let colocatedLight: Record<string, unknown> | undefined;
        // Caution-area props riding under a water tap — folded into the
        // DEPARE popup (see the areaHits branch below).
        let cautionsUnder: Record<string, unknown>[] = [];
        if (pointHits.length > 0) {
            const distSqTo = (f: mapboxgl.GeoJSONFeature, to: { x: number; y: number }): number => {
                if (f.geometry?.type !== 'Point') return Infinity;
                const p = map.project(f.geometry.coordinates as [number, number]);
                return (p.x - to.x) ** 2 + (p.y - to.y) ** 2;
            };
            const nearest = (
                feats: mapboxgl.GeoJSONFeature[],
                to: { x: number; y: number },
            ): mapboxgl.GeoJSONFeature | undefined => {
                let best: mapboxgl.GeoJSONFeature | undefined;
                let bestD = Infinity;
                for (const f of feats) {
                    const d = distSqTo(f, to);
                    if (d < bestD) {
                        bestD = d;
                        best = f;
                    }
                }
                return best ?? feats[0];
            };
            // STRUCTURES BEAT THEIR LIGHTS: a lit mark carries a LIGHTS
            // point on the SAME coordinate, rendered on top — pure
            // nearest-wins answered "Light" for every lit mark, so the
            // mark info (Pass NORTH of this mark, port-hand, name) never
            // surfaced (Shane 2026-07-15: "all markers that have lights
            // are just showing the light information — this includes
            // cardinal markers"). Pick the nearest NON-light point first;
            // its light folds into the same popup via extras below. A
            // standalone light (lighthouse, jetty light with no charted
            // structure sibling) still answers as a Light.
            const lights = pointHits.filter((f) => f.layer?.id === ENC_VEC_LAYERS.LIGHTS);
            const structures = pointHits.filter((f) => f.layer?.id !== ENC_VEC_LAYERS.LIGHTS);
            feat = structures.length > 0 ? nearest(structures, e.point) : nearest(lights, e.point);
            if (structures.length > 0 && lights.length > 0 && feat?.geometry?.type === 'Point') {
                // "Its" light = within ~1.5 tap-pads of the MARK itself
                // (not the tap) — co-located S-57 light objects sit on the
                // structure's coordinate exactly; the slack absorbs symbol
                // anchor offsets without adopting a neighbour's light.
                const anchor = map.project(feat.geometry.coordinates as [number, number]);
                const light = nearest(lights, anchor);
                if (light && distSqTo(light, anchor) <= (TAP_PAD_PX * 1.5) ** 2) {
                    colocatedLight = (light.properties ?? {}) as Record<string, unknown>;
                }
            }
        } else {
            // Area fills (water, land) answer only an exact-point tap.
            const areaHits = map.queryRenderedFeatures(e.point, { layers: CLICKABLE_LAYER_IDS });
            // A caution wash must never REPLACE the tap-the-water depth/keel
            // read (audit: over its whole footprint at z11+ the caution popup
            // stole the flagship answer). When charted water lies beneath,
            // answer as WATER and fold the caution into the depth popup —
            // the same treatment SBDARE already gets (extras below). The
            // precedence lives in pickAreaTap (pure, tested).
            const pick = pickAreaTap(
                areaHits.map((h) => ({
                    layerId: h.layer?.id ?? '',
                    properties: (h.properties ?? {}) as Record<string, unknown>,
                })),
            );
            if (!pick) return;
            feat = areaHits[pick.index];
            cautionsUnder = pick.cautionsUnder;
        }
        // pointHits non-empty guarantees a pick, but TS can't see through
        // the filter/nearest split — and a paranoid bail beats a throw.
        if (!feat) return;
        const layerId = feat.layer?.id ?? '';
        const props = (feat.properties ?? {}) as Record<string, unknown>;

        const existing = attachedHandlers.get(map);
        if (existing?.popup) existing.popup.remove();

        // Vessel keel + live tide state ride along so the DEPARE branch
        // can answer "can I float here" instead of quoting chart-speak.
        const dstate = depthStyleState.get(map);
        // Seabed enrichment: a WATER tap inside an SBDARE folds "Seabed:
        // Sand" into the depth popup (the SBDARE wash itself is non-clickable
        // so it can never STEAL this popup — audit). Fires z13+ only, the
        // SBDARE layer's minzoom — the anchoring-decision zoom.
        let seabed: Record<string, unknown> | null = null;
        if (layerId === ENC_VEC_LAYERS.DEPARE && map.getLayer(ENC_VEC_LAYERS.SBDARE_FILL)) {
            const sb = map.queryRenderedFeatures(e.point, { layers: [ENC_VEC_LAYERS.SBDARE_FILL] });
            if (sb.length > 0) seabed = (sb[0].properties ?? {}) as Record<string, unknown>;
        }
        const extras: PopupExtras = {
            safetyDepthM: dstate?.safetyDepthM,
            tideOffsetM: dstate?.tideOffsetM ?? null,
            tideOffsetAtMs: dstate?.tideOffsetAtMs ?? null,
            draftAssumed: dstate?.draftAssumed ?? false,
            ...(colocatedLight ? { light: colocatedLight } : {}),
            ...(seabed ? { seabed } : {}),
            ...(cautionsUnder.length > 0 ? { cautions: cautionsUnder } : {}),
        };

        const popup = new mapboxgl.Popup({
            closeButton: false,
            maxWidth: '280px',
            offset: 8,
            className: 'enc-popup-mapbox',
        })
            .setLngLat(e.lngLat)
            .setHTML(buildFeaturePopupHtml(layerId, props, extras))
            .addTo(map);

        if (existing) existing.popup = popup;
        if (layerId === ENC_VEC_LAYERS.DEPARE) fillDepareTideWindow(popup, props, extras);

        const closeBtn = popup.getElement()?.querySelector<HTMLButtonElement>('.enc-popup-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => popup.remove());
        }
    };

    const onEnter = () => {
        map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => {
        map.getCanvas().style.cursor = '';
    };

    // ONE map-level click; ONE array-scoped mouseenter/leave for the desktop
    // cursor affordance. The per-layer loop here was NOT "cheap, no query
    // work" (the old comment was wrong): Mapbox wires one delegated mousemove
    // per registration, each running its OWN queryRenderedFeatures on every
    // pointer move — ~40 qRF calls per mousemove, a sticky cursor over
    // charted water on desktop web (audit rank 5). Passing the id ARRAY makes
    // it a single delegate doing one qRF. Zero cost on iOS (no mousemove).
    map.on('click', onClick);
    map.on('mouseenter', CLICKABLE_LAYER_IDS, onEnter);
    map.on('mouseleave', CLICKABLE_LAYER_IDS, onLeave);

    attachedHandlers.set(map, { click: onClick, enter: onEnter, leave: onLeave, popup: null });
    log.info('attached ENC feature click handlers');
}

/**
 * Tear down click handlers + any open popup. Used when the
 * useEncVectorLayer hook unmounts.
 */
export function detachEncFeatureClickHandlers(map: mapboxgl.Map): void {
    const h = attachedHandlers.get(map);
    if (!h) return;
    map.off('click', h.click);
    map.off('mouseenter', CLICKABLE_LAYER_IDS, h.enter);
    map.off('mouseleave', CLICKABLE_LAYER_IDS, h.leave);
    if (h.popup) h.popup.remove();
    attachedHandlers.delete(map);
    log.info('detached ENC feature click handlers');
}
