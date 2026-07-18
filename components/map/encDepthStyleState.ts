/**
 * encDepthStyleState — the STATEFUL, map-facing half of the ENC depth
 * story, carved out of EncVectorLayer (god-module carve step 1 of 2,
 * see docs/ENC_VECTORLAYER_CARVE.md).
 *
 * Three things live here because they are one thing:
 *
 *   1. The per-map `depthStyleState` WeakMap — safety depth, hazard
 *      depth, the per-cell VALDCO inventory, the tide offset and the
 *      draft-assumed flag.
 *   2. The paint appliers that read it — `applyTideOffsetPaint` (the
 *      "depth right now" readout shift) and `updateEncDepthStyle` (THE
 *      choke point for draft changes).
 *   3. The satellite-base gate + `syncDepareBaseTreatment`, because the
 *      glaze is keel-keyed: a draft change has to re-key it through the
 *      same choke point as the safety contour, so the two cannot be
 *      separated without splitting that invariant across modules.
 *
 * The PURE style math (band ramps, sounding typography, safety-contour
 * derivation) is one layer further down in encDepthStyle.ts, unit-testable
 * without a map. This module is the substrate both EncVectorLayer and the
 * forthcoming encLayerMounts depend on — extracting it FIRST is what keeps
 * the mount carve free of an import cycle.
 *
 * EncVectorLayer re-exports the public names below so existing importers
 * (MapHub, useEncVectorLayer) are unaffected.
 */

import mapboxgl from 'mapbox-gl';
import { ENC_VEC_LAYERS } from './encLayerIds';
import {
    DEFAULT_SAFETY_DEPTH_M,
    DEPARE_CHART_OPACITY,
    DEPCNT_LABEL_INK_DATUM,
    DEPCNT_LABEL_INK_LIVE,
    buildDepareFillColor,
    buildDepareGlazeFillColor,
    buildDepareSatelliteOpacity,
    buildDepcntLabelField,
    buildSoundingTextColor,
    buildSoundingTextField,
    computeSafetyValdcoByCell,
    depcntLineFilter,
    depcntSafetyFilter,
    mapFilter,
} from './encDepthStyle';

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

export function applyTideOffsetPaint(map: mapboxgl.Map, tideOffsetM: number | null): void {
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
export interface EncDepthStyleState {
    safetyDepthM: number;
    /** Router grounding threshold (draft×1.5 + UKC, metres) — drives the glaze's
     *  [safety, hazard) caution band so the hand-piloting surface agrees with the
     *  router (cycle-5 re-audit). Undefined → the two-band glaze look. */
    hazardDepthM?: number;
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
export const depthStyleState = new WeakMap<mapboxgl.Map, EncDepthStyleState>();

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
export function updateEncDepthStyle(map: mapboxgl.Map, safetyDepthM: number, hazardDepthM?: number): void {
    const state = depthStyleState.get(map) ?? { safetyDepthM, depcntValdcosByCell: {} };
    state.safetyDepthM = safetyDepthM;
    // Only overwrite when explicitly supplied — the data-refresh path calls this
    // with just safetyDepthM and must preserve the hazard depth it spread in.
    if (hazardDepthM !== undefined) state.hazardDepthM = hazardDepthM;
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
/** Exported so MapHub's satellite pass can MIRROR it by import rather than by
 *  hand — the two copies had drifted (DEPCNT_SAFETY was removed here, because
 *  syncDepareBaseTreatment restyles it amber as the keel-limit line over
 *  imagery, but MapHub's hand-copy kept hiding it). */
export const SATELLITE_HIDE_LAYERS: readonly string[] = [
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.LNDARE_ISLET,
    ENC_VEC_LAYERS.COALNE,
];
export function satelliteBaseOn(): boolean {
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
export const DEPARE_FINE_RANK_FILTER = mapFilter([
    '>=',
    ['coalesce', ['to-number', ['get', '_scaleRank']], -32768],
    40,
]);

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
        const glazeState = depthStyleState.get(map);
        const safetyDepthM = glazeState?.safetyDepthM ?? DEFAULT_SAFETY_DEPTH_M;
        // Router-hazard caution band [safety, hazard): the glaze paints it a
        // distinct straw instead of GO-white (cycle-5 re-audit). Undefined
        // hazard depth → the two-band look (graceful degrade in the builders).
        const hazardDepthM = glazeState?.hazardDepthM;
        map.setPaintProperty(
            ENC_VEC_LAYERS.DEPARE_GLAZE,
            'fill-color',
            buildDepareGlazeFillColor(safetyDepthM, hazardDepthM),
        );
        map.setPaintProperty(
            ENC_VEC_LAYERS.DEPARE_GLAZE,
            'fill-opacity',
            satOn ? buildDepareSatelliteOpacity(safetyDepthM, hazardDepthM) : 0,
        );
        map.setFilter(ENC_VEC_LAYERS.DEPARE_GLAZE, satOn ? DEPARE_COMPETENCE_FILTER : null);
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPCNT_SAFETY)) {
        // The one keel-limit line — now the deliberate AMBER line on BOTH bases
        // (Shane 2026-07-20: default-bold; cycle-4 closing audit #4: the slate
        // hairline was near-invisible on the primary white display, the most
        // keel-load-bearing line whispering). Amber, hairline-to-modest — the
        // crisp go/no-go boundary the glaze edge only implies — NOT the "thick
        // black scribble" Shane rejected (2026-07-11); that was ECDIS-bold
        // black, not this tuned amber. Same treatment on satellite, where slate
        // went muddy over water anyway.
        map.setPaintProperty(ENC_VEC_LAYERS.DEPCNT_SAFETY, 'line-color', '#f97316');
        map.setPaintProperty(ENC_VEC_LAYERS.DEPCNT_SAFETY, 'line-width', [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            1.0,
            15,
            2.2,
        ]);
        map.setPaintProperty(ENC_VEC_LAYERS.DEPCNT_SAFETY, 'line-opacity', 1);
    }
}
