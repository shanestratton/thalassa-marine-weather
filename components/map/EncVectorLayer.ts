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
import type { FeatureCollection } from 'geojson';

import { createLogger } from '../../utils/createLogger';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import { LITCHR_LABELS } from '../../services/enc/types';
import { registerSeamarkIcons } from './seamarkIcons';

const log = createLogger('EncVectorLayer');

// ── Source IDs ─────────────────────────────────────────────────────

export const ENC_VEC_SRC = {
    LNDARE: 'enc-vec-lndare',
    DEPARE: 'enc-vec-depare', // DEPARE + DRGARE merged
    DEPARE_GLAZE: 'enc-vec-depare-glaze', // overlap-clipped twin for the satellite glaze
    DEPCNT: 'enc-vec-depcnt',
    COALNE: 'enc-vec-coalne',
    POINTS: 'enc-vec-points', // OBSTRN + WRECKS + UWTROC merged
    NAVAIDS: 'enc-vec-navaids', // LIGHTS + BOY*/BCN* merged
    RECTRC: 'enc-vec-rectrc', // recommended tracks / leading lines
    SOUNDG: 'enc-vec-soundg', // exploded spot soundings
} as const;

// NOTE: layer-id stability is load-bearing. Click handlers, the
// master-toggle probe (BCNLAT visibility) and the hide lists all
// reference these ids — the lateral/cardinal layers keep their
// legacy '-circle' suffix even though they're symbol layers now.
// Renaming is a separate mechanical commit, never a drive-by.
export const ENC_VEC_LAYERS = {
    LNDARE: 'enc-vec-lndare-fill',
    LNDARE_ISLET: 'enc-vec-lndare-islet',
    DEPARE: 'enc-vec-depare-fill',
    /** Fine-survey water REPAINTED ABOVE land (2026-07-11: the coarse
     *  1:90k cell's crude LNDARE blob swallowed the Mooloolah river +
     *  canal estates — "where is our beautiful layer??? help help").
     *  Land-over-water is right for a cell's OWN generalisation; wrong
     *  across scales. Harbour-grade bands overrule coarse land bleed. */
    DEPARE_FINE: 'enc-vec-depare-fine-fill',
    /** Satellite-glaze fill off the overlap-CLIPPED collection: exactly
     *  one translucent band per point of water, so overlapping surveys
     *  can't stack into the hard-edged dark wedges ("80's rendering",
     *  2026-07-12). Opacity-0 in chart mode; over imagery it replaces
     *  BOTH plain DEPARE fills (which go opacity-0 — translucent twins
     *  double-paint every fine feature). */
    DEPARE_GLAZE: 'enc-vec-depare-glaze-fill',
    DEPCNT_LINE: 'enc-vec-depcnt-line',
    DEPCNT_SAFETY: 'enc-vec-depcnt-safety',
    DEPCNT_LABEL: 'enc-vec-depcnt-label',
    COALNE: 'enc-vec-coalne-line',
    OBSTRN: 'enc-vec-obstrn-circle',
    WRECKS: 'enc-vec-wrecks-circle',
    UWTROC: 'enc-vec-uwtroc-circle',
    BOYLAT: 'enc-vec-boylat-circle',
    BOYCAR: 'enc-vec-boycar-circle',
    BCNLAT: 'enc-vec-bcnlat-circle',
    BCNCAR: 'enc-vec-bcncar-circle',
    BOYSPP: 'enc-vec-boyspp-symbol',
    BCNSPP: 'enc-vec-bcnspp-symbol',
    LIGHTS: 'enc-vec-lights-symbol',
    RECTRC: 'enc-vec-rectrc-line',
    RECTRC_LABEL: 'enc-vec-rectrc-label',
    SOUNDG: 'enc-vec-soundg-label',
    NAVAIDS_LABEL: 'enc-vec-navaids-label',
    POINTS_LABEL: 'enc-vec-points-label',
} as const;

// All layer IDs, ordered bottom-to-top for correct stacking. The
// mount is idempotent-additive: each layer is inserted before the
// next HIGHER layer that already exists (see beforeIdFor), so new
// layers slot into a live map in the right place rather than
// appending on top.
const ALL_LAYER_IDS = [
    ENC_VEC_LAYERS.DEPARE, // bottom (water fills)
    ENC_VEC_LAYERS.DEPARE_GLAZE, // satellite twin directly above (opacity-0 on chart)
    ENC_VEC_LAYERS.DEPCNT_LINE,
    ENC_VEC_LAYERS.DEPCNT_SAFETY,
    ENC_VEC_LAYERS.DEPCNT_LABEL,
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.LNDARE_ISLET,
    ENC_VEC_LAYERS.COALNE,
    ENC_VEC_LAYERS.DEPARE_FINE, // fine-survey water beats coarse land bleed
    ENC_VEC_LAYERS.SOUNDG, // depth numbers under everything interactive
    ENC_VEC_LAYERS.RECTRC, // leads under the marks that define them
    ENC_VEC_LAYERS.BOYLAT,
    ENC_VEC_LAYERS.BCNLAT,
    ENC_VEC_LAYERS.BOYCAR,
    ENC_VEC_LAYERS.BCNCAR,
    ENC_VEC_LAYERS.BOYSPP,
    ENC_VEC_LAYERS.BCNSPP,
    ENC_VEC_LAYERS.OBSTRN,
    ENC_VEC_LAYERS.WRECKS,
    ENC_VEC_LAYERS.UWTROC,
    ENC_VEC_LAYERS.LIGHTS,
    ENC_VEC_LAYERS.RECTRC_LABEL,
    ENC_VEC_LAYERS.NAVAIDS_LABEL, // labels topmost
    ENC_VEC_LAYERS.POINTS_LABEL,
];

// Layers that take click handlers. Excludes the text-only label
// layers — a tap on a label should fall through to the symbol or
// polygon underneath, not open a generic popup. RECTRC is excluded
// too: a thin lead line under a tracer tap must never swallow the
// pin drop with a popup.
const CLICKABLE_LAYER_IDS = ALL_LAYER_IDS.filter(
    (id) =>
        id !== ENC_VEC_LAYERS.NAVAIDS_LABEL &&
        id !== ENC_VEC_LAYERS.POINTS_LABEL &&
        id !== ENC_VEC_LAYERS.RECTRC &&
        id !== ENC_VEC_LAYERS.RECTRC_LABEL &&
        id !== ENC_VEC_LAYERS.SOUNDG &&
        id !== ENC_VEC_LAYERS.DEPCNT_LABEL &&
        id !== ENC_VEC_LAYERS.DEPARE_FINE &&
        id !== ENC_VEC_LAYERS.DEPARE_GLAZE,
);

const ALL_SOURCE_IDS = Object.values(ENC_VEC_SRC);

// ── Helpers ────────────────────────────────────────────────────────

function emptyFC(): FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
}

/**
 * Find a sensible insertion anchor — vector chart should sit
 * above water/bathymetry but below labels and the route line.
 * We use the same anchor strategy as MpaLayer / EncCoverageLayer.
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
    const features = [
        ...data.OBSTRN.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'OBSTRN' },
        })),
        ...data.WRECKS.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'WRECKS' },
        })),
        ...data.UWTROC.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'UWTROC' },
        })),
    ];
    return { type: 'FeatureCollection', features };
}

/**
 * Same approach for navaids — one source, layer-level filters by
 * `_kind`. Saves the worker tile-build cost of three separate
 * sources holding the same Point geometries.
 */
function buildMergedNavaids(data: EncMergedVectorData): FeatureCollection {
    const features = [
        ...data.LIGHTS.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'LIGHTS' },
        })),
        ...data.BOYLAT.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BOYLAT' },
        })),
        ...data.BOYCAR.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BOYCAR' },
        })),
        ...data.BCNLAT.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BCNLAT' },
        })),
        ...data.BCNCAR.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BCNCAR' },
        })),
        ...data.BOYSPP.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BOYSPP' },
        })),
        ...data.BCNSPP.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BCNSPP' },
        })),
    ];
    return { type: 'FeatureCollection', features };
}

// ── Draft-aware depth styling ──────────────────────────────────────

/**
 * Fallback safety depth when the caller doesn't supply one:
 * vesselDraftMetres() default (2.5 m) + the MASTERPLAN §8 tide
 * margin (0.5 m). The hook always passes the live value.
 */
const DEFAULT_SAFETY_DEPTH_M = 3.0;

/**
 * S-52-style day-palette band fills keyed to the vessel's safety
 * depth S (draft + tide margin, METRES — callers must come through
 * vesselDraftMetres(), never raw vessel.draft which is FEET).
 *
 * House pattern: compute the stops in TS, keep the expression dumb.
 * `step` stops must ascend strictly — S > 0 guarantees 0 < S < 2S,
 * and max(4S, 20) > 2S for any S.
 */
export function buildDepareFillColor(tideOffsetM = 0): mapboxgl.ExpressionSpecification {
    // Absolute white ramp — paper-chart convention (Shane 2026-07-11:
    // "white where deep, off white all the way to a dirty white where
    // it is not"). White = SURVEYED AND DEEP; the tint dirties as the
    // sand comes up, drying banks go khaki (paper-chart intertidal).
    // Bands are absolute, not draft-keyed (his call — predictable,
    // matches the paper chart aboard); the keel story lives in the
    // draft-keyed SAFETY CONTOUR on top. Uncharted water gets no fill
    // at all — absence of data must never read as deep (the
    // au-brisbane-test lesson).
    //
    // tideOffsetM ("depth right now" toggle): shifting every band stop
    // down by the predicted tide height re-tints the whole chart for
    // the water that's actually under the keel — a drying bank under
    // 1.8 m of tide renders as 0–2 m dirty white because it IS
    // navigable water right now. Stops stay strictly ascending for any
    // constant shift, so the step expression remains valid.
    const h = tideOffsetM;
    return [
        'step',
        // DRVAL1 = minimum depth in S-57 metres (positive = depth,
        // negative = drying height). Missing values sort as "very
        // deep" so empty polygons don't render as drying banks.
        ['coalesce', ['to-number', ['get', 'DRVAL1']], 999],
        '#c9c6ae', // < 0 now — still drying at THIS tide
        0 - h,
        '#d4cdbf', // 0–2 m — dirtiest white
        2 - h,
        '#ded8cc', // 2–5 m — the 2.4 m-keel decision band
        5 - h,
        '#e8e3d9', // 5–10 m
        10 - h,
        '#f0ede5', // 10–20 m
        20 - h,
        '#f7f5f0', // 20–50 m
        50 - h,
        '#ffffff', // 50 m+ — clean paper
    ] as unknown as mapboxgl.ExpressionSpecification;
}

/** Subscript digits for chart-style sounding tenths (3₄, not 3.4). */
const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

/**
 * Sounding label text. With a tide offset the displayed value is
 * charted + tide ("depth right now"). Carry-safe: whole and tenth both
 * derive from round(|v|·10) — computing them separately turned 1.96
 * into "1₀" instead of "2" once offsets made non-pre-rounded values
 * possible.
 */
export function buildSoundingTextField(tideOffsetM = 0): mapboxgl.ExpressionSpecification {
    const v = tideOffsetM === 0 ? ['get', '_d'] : ['+', ['get', '_d'], tideOffsetM];
    const d10 = ['round', ['*', ['abs', v], 10]];
    const whole = ['floor', ['/', d10, 10]];
    const tenth = ['%', d10, 10];
    return [
        'case',
        ['<', ['abs', v], 10],
        ['concat', ['to-string', whole], ['case', ['==', tenth, 0], '', ['at', tenth, ['literal', SUBSCRIPT_DIGITS]]]],
        ['to-string', ['round', v]],
    ] as unknown as mapboxgl.ExpressionSpecification;
}

/**
 * Sounding ink. Chart datum = slate (shallow darker) with khaki drying.
 * LIVE tide mode = a distinct TEAL family so a screenshot can never
 * masquerade as chart datum (the honesty rule from the design session);
 * "drying at this tide" keeps the khaki.
 */
export function buildSoundingTextColor(tideOffsetM: number | null = null): mapboxgl.ExpressionSpecification {
    if (tideOffsetM === null) {
        // Black-family ink (Shane 2026-07-11: "black, and thinner") —
        // shallow slightly blacker than deep, khaki for drying.
        return [
            'case',
            ['<', ['get', '_d'], 0],
            '#6b5e23',
            ['<', ['get', '_d'], 5],
            '#0b1116',
            '#26333d',
        ] as unknown as mapboxgl.ExpressionSpecification;
    }
    const v = ['+', ['get', '_d'], tideOffsetM];
    return [
        'case',
        ['<', v, 0],
        '#6b5e23',
        ['<', v, 5],
        '#0b4f58',
        '#2a6b77',
    ] as unknown as mapboxgl.ExpressionSpecification;
}

/** Contour label text — shifts with the tide offset so the screen never
 *  mixes datums (a "5" line reading charted while soundings read live
 *  would be a trap). */
export function buildDepcntLabelField(tideOffsetM = 0): mapboxgl.ExpressionSpecification {
    const val = ['to-number', ['get', 'VALDCO']];
    const v = tideOffsetM === 0 ? val : ['+', val, tideOffsetM];
    return ['to-string', ['round', v]] as unknown as mapboxgl.ExpressionSpecification;
}

/**
 * "Depth right now" — apply (or clear, with null) the tide offset on
 * every depth READOUT layer: band tints, sounding numbers + ink,
 * contour labels. VISUAL ONLY by hard rule: the safety contour, the
 * tracer and the router all keep grading against chart datum (they do
 * their own per-spot tide windows properly). Stored per map so
 * mount/refresh re-apply it after style swaps and cell loads.
 */
export function setEncTideOffset(map: mapboxgl.Map, tideOffsetM: number | null, atMs: number | null = null): void {
    const state = depthStyleState.get(map) ?? {
        safetyDepthM: DEFAULT_SAFETY_DEPTH_M,
        depcntValdcos: [],
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
        depcntValdcos: [],
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
    if (map.getLayer(ENC_VEC_LAYERS.DEPARE_GLAZE)) {
        map.setPaintProperty(ENC_VEC_LAYERS.DEPARE_GLAZE, 'fill-color', buildDepareFillColor(h));
    }
    if (map.getLayer(ENC_VEC_LAYERS.SOUNDG)) {
        map.setLayoutProperty(ENC_VEC_LAYERS.SOUNDG, 'text-field', buildSoundingTextField(h));
        map.setPaintProperty(ENC_VEC_LAYERS.SOUNDG, 'text-color', buildSoundingTextColor(live ? h : null));
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPCNT_LABEL)) {
        map.setLayoutProperty(ENC_VEC_LAYERS.DEPCNT_LABEL, 'text-field', buildDepcntLabelField(h));
        map.setPaintProperty(ENC_VEC_LAYERS.DEPCNT_LABEL, 'text-color', live ? '#54828d' : '#7d8e9b');
    }
}

/**
 * The safety contour to embolden: the smallest charted VALDCO ≥ the
 * vessel's safety depth S. Null when NO charted contour reaches S (a
 * shallow-only cell, or S deeper than every contour here) — we then
 * embolden NOTHING and let the draft-keyed DEPARE bands carry the depth
 * message. Emboldening the deepest available contour in that case (the
 * old `best ?? deepest`) was actively MISLEADING: it promoted a line
 * SHALLOWER than S to "safety contour", implying the water seaward of it
 * clears the keel when it doesn't — a grounding-risk line drawn at the
 * wrong depth, exactly what the draft wiring exists to prevent. The
 * shallower contours still draw as ordinary thin lines; only the bold
 * "this is your safety line" emphasis is withheld.
 */
export function computeSafetyValdco(valdcos: readonly number[], safetyDepthM: number): number | null {
    let best: number | null = null;
    for (const v of valdcos) {
        if (!Number.isFinite(v)) continue;
        if (v >= safetyDepthM && (best == null || v < best)) best = v;
    }
    return best;
}

/** Distinct VALDCO values present in the merged DEPCNT collection. */
function distinctValdcos(fc: FeatureCollection): number[] {
    const set = new Set<number>();
    for (const f of fc.features ?? []) {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const v = Number(props.VALDCO ?? props.valdco);
        if (Number.isFinite(v)) set.add(v);
    }
    return [...set].sort((a, b) => a - b);
}

/**
 * Per-map depth-style state so `updateEncDepthStyle` and
 * `refreshEncVectorData` can recompute the safety contour without
 * re-threading the merged data / safety depth through every caller.
 */
interface EncDepthStyleState {
    safetyDepthM: number;
    depcntValdcos: number[];
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

// SCAMIN-aware visibility clause — features pre-tagged with `_minZoom`
// (derived from S-57 SCAMIN at extraction time) become visible only at
// or above their chart-prescribed display zoom. Features without
// `_minZoom` are always-visible (correct for hazards lacking SCAMIN).
const SCAMIN_CLAUSE = ['any', ['!', ['has', '_minZoom']], ['>=', ['zoom'], ['get', '_minZoom']]];

/**
 * Compose the `_kind` routing filter with the SCAMIN clause.
 *
 * Mapbox's published `FilterSpecification` is a huge discriminated union
 * that doesn't admit dynamic composition cleanly; cast at the seam.
 */
const scaminAware = (kindFilter: unknown): mapboxgl.FilterSpecification =>
    ['all', kindFilter, SCAMIN_CLAUSE] as unknown as mapboxgl.FilterSpecification;

/** Sentinel VALDCO that matches no real contour (no-contour cells). */
const NO_SAFETY_VALDCO = -9999;

function depcntLineFilter(safetyValdco: number | null): mapboxgl.FilterSpecification {
    const sv = safetyValdco ?? NO_SAFETY_VALDCO;
    // Ordinary contours: everything except the safety contour, SCAMIN-gated.
    return [
        'all',
        ['!=', ['to-number', ['get', 'VALDCO']], sv],
        SCAMIN_CLAUSE,
    ] as unknown as mapboxgl.FilterSpecification;
}

function depcntSafetyFilter(safetyValdco: number | null): mapboxgl.FilterSpecification {
    const sv = safetyValdco ?? NO_SAFETY_VALDCO;
    // The safety contour always shows — NO scamin gate, per S-52.
    return ['==', ['to-number', ['get', 'VALDCO']], sv] as unknown as mapboxgl.FilterSpecification;
}

/**
 * THE single choke point for draft changes (risk note: a missed
 * update path silently shows the WRONG safety contour — worse than
 * none). Moves the safety contour; the DEPARE fill is an ABSOLUTE
 * white ramp since 2026-07-11 and no longer re-bands with draft.
 * Called from mount (via opts), from the hook whenever vessel draft
 * changes, and from refresh when new cells land.
 *
 * `safetyDepthM` = vesselDraftMetres(vessel) + tide margin. METRES.
 */
export function updateEncDepthStyle(map: mapboxgl.Map, safetyDepthM: number): void {
    const state = depthStyleState.get(map) ?? { safetyDepthM, depcntValdcos: [] };
    state.safetyDepthM = safetyDepthM;
    depthStyleState.set(map, state);

    const safetyValdco = computeSafetyValdco(state.depcntValdcos, safetyDepthM);
    if (map.getLayer(ENC_VEC_LAYERS.DEPCNT_LINE)) {
        map.setFilter(ENC_VEC_LAYERS.DEPCNT_LINE, depcntLineFilter(safetyValdco));
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPCNT_SAFETY)) {
        map.setFilter(ENC_VEC_LAYERS.DEPCNT_SAFETY, depcntSafetyFilter(safetyValdco));
    }
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

/**
 * Idempotent mount. Adds (or updates) all sources + layers. Safe to
 * call repeatedly — re-using existing sources avoids the
 * layer-rebuild cost on cell-list changes; we just setData on the
 * source.
 */
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
    // refresh can recompute the safety contour later. The tide offset
    // survives re-mounts (style swaps, cell loads) — it belongs to the
    // MODE, not the mount.
    depthStyleState.set(map, {
        safetyDepthM,
        depcntValdcos: distinctValdcos(data.DEPCNT),
        tideOffsetM: depthStyleState.get(map)?.tideOffsetM ?? null,
    });
    const safetyValdco = computeSafetyValdco(distinctValdcos(data.DEPCNT), safetyDepthM);

    const ensureSource = (id: string, fc: FeatureCollection) => {
        const existing = map.getSource(id);
        if (existing && 'setData' in existing) {
            (existing as mapboxgl.GeoJSONSource).setData(fc);
            return;
        }
        map.addSource(id, {
            type: 'geojson',
            data: fc,
            generateId: true,
        });
    };

    ensureSource(ENC_VEC_SRC.LNDARE, data.LNDARE);
    ensureSource(ENC_VEC_SRC.DEPARE, data.DEPARE);
    ensureSource(ENC_VEC_SRC.DEPARE_GLAZE, data.DEPARE_GLAZE);
    ensureSource(ENC_VEC_SRC.DEPCNT, data.DEPCNT);
    ensureSource(ENC_VEC_SRC.COALNE, data.COALNE);
    ensureSource(ENC_VEC_SRC.POINTS, buildMergedPoints(data));
    ensureSource(ENC_VEC_SRC.NAVAIDS, buildMergedNavaids(data));
    ensureSource(ENC_VEC_SRC.RECTRC, data.RECTRC);
    ensureSource(ENC_VEC_SRC.SOUNDG, data.SOUNDG);

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
    // Same ramp off the CLIPPED collection; syncDepareBaseTreatment
    // owns its opacity (0 on the chart, the depth glaze over imagery).
    if (!map.getLayer(ENC_VEC_LAYERS.DEPARE_GLAZE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPARE_GLAZE,
                type: 'fill',
                source: ENC_VEC_SRC.DEPARE_GLAZE,
                minzoom: minZoom,
                paint: {
                    'fill-color': buildDepareFillColor(),
                    'fill-opacity': 0,
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

    // Mount can happen while satellite is already on (style swap,
    // late cell load) — apply the right treatment immediately. Same
    // for a live tide offset: re-point the depth readouts at it.
    syncDepareBaseTreatment(map);
    applyTideOffsetPaint(map, depthStyleState.get(map)?.tideOffsetM ?? null);

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
                filter: depcntLineFilter(safetyValdco),
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
                filter: depcntSafetyFilter(safetyValdco),
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
                filter: SCAMIN_CLAUSE as unknown as mapboxgl.FilterSpecification,
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
                    'text-color': '#46555f',
                    'text-halo-color': 'rgba(255, 255, 255, 0.8)',
                    'text-halo-width': 0.8,
                    'text-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.DEPCNT_LABEL),
        );
    }

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
                filter: ['==', ['geometry-type'], 'Point'] as unknown as mapboxgl.FilterSpecification,
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
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 10, 0.8, 13, 0.95, 15, opacity],
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.COALNE),
        );
    }

    // ── Hazard points (filtered by `_kind` from one merged source) ─
    // OBSTRN, WRECKS, UWTROC are all magenta point hazards in IHO
    // styling. We use circle-stroke + circle-color to differentiate.
    // Hazards lacking SCAMIN/_minZoom are NEVER zoom-hidden (the
    // `scaminAware` no-_minZoom arm) — they're the things the router
    // routes around.
    const POINT_BASE_COLOR = '#d837a9'; // magenta

    if (!map.getLayer(ENC_VEC_LAYERS.OBSTRN)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.OBSTRN,
                type: 'circle',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'OBSTRN']),
                paint: {
                    'circle-color': POINT_BASE_COLOR,
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2, 11, 4, 15, 6],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 1.2,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.OBSTRN),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.WRECKS)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.WRECKS,
                type: 'circle',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'WRECKS']),
                paint: {
                    'circle-color': POINT_BASE_COLOR,
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 11, 5, 15, 7],
                    'circle-stroke-color': '#ffd1ec',
                    'circle-stroke-width': 2,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            beforeIdFor(ENC_VEC_LAYERS.WRECKS),
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.UWTROC)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.UWTROC,
                type: 'circle',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'UWTROC']),
                paint: {
                    'circle-color': '#ffffff',
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 1.5, 11, 3, 15, 5],
                    'circle-stroke-color': POINT_BASE_COLOR,
                    'circle-stroke-width': 1.5,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
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
    const navaidSymbolLayer = (
        layerId: string,
        kind: 'BOYLAT' | 'BCNLAT' | 'BOYCAR' | 'BCNCAR' | 'BOYSPP' | 'BCNSPP',
    ) => {
        if (map.getLayer(layerId)) return;
        map.addLayer(
            {
                id: layerId,
                type: 'symbol',
                source: ENC_VEC_SRC.NAVAIDS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], kind]),
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

    navaidSymbolLayer(ENC_VEC_LAYERS.BOYLAT, 'BOYLAT');
    navaidSymbolLayer(ENC_VEC_LAYERS.BCNLAT, 'BCNLAT');
    navaidSymbolLayer(ENC_VEC_LAYERS.BOYCAR, 'BOYCAR');
    navaidSymbolLayer(ENC_VEC_LAYERS.BCNCAR, 'BCNCAR');
    navaidSymbolLayer(ENC_VEC_LAYERS.BOYSPP, 'BOYSPP');
    navaidSymbolLayer(ENC_VEC_LAYERS.BCNSPP, 'BCNSPP');

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
                filter: SCAMIN_CLAUSE as unknown as mapboxgl.FilterSpecification,
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
                filter: [
                    'all',
                    ['==', ['get', '_kind'], 'LIGHTS'],
                    SCAMIN_CLAUSE,
                    ['any', ['==', ['get', '_lightTier'], 'major'], ['>=', ['zoom'], 11]],
                ] as unknown as mapboxgl.FilterSpecification,
                layout: {
                    'text-field': '★',
                    'text-size': ['interpolate', ['linear'], ['zoom'], 7, 11, 11, 16, 15, 22],
                    // Collision-cull minor lights instead of stamping
                    // them all from z7 — the sort key keeps the
                    // longest-range lights when space is tight.
                    'text-allow-overlap': false,
                    'text-anchor': 'center',
                    'symbol-sort-key': ['-', 0, ['coalesce', ['to-number', ['get', 'VALNMR']], 0]],
                },
                paint: {
                    'text-color': ['coalesce', ['get', '_lightColor'], '#fde047'],
                    'text-halo-color': 'rgba(0, 0, 0, 0.85)',
                    'text-halo-width': 1.5,
                    'text-opacity': opacity,
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
                filter: ['any', ['has', 'OBJNAM'], ['has', '_lightLabel']] as unknown as mapboxgl.FilterSpecification,
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
            `(safety VALDCO=${safetyValdco ?? 'n/a'} @ S=${safetyDepthM.toFixed(1)}m), ` +
            `${data.OBSTRN.features.length + data.WRECKS.features.length + data.UWTROC.features.length} hazard pts`,
    );
}

/**
 * Replace just the underlying source data without rebuilding
 * layers. Faster than a full mount cycle when cells are imported
 * or removed mid-session.
 */
export function refreshEncVectorData(map: mapboxgl.Map, data: EncMergedVectorData): void {
    const setData = (id: string, fc: FeatureCollection) => {
        const src = map.getSource(id);
        if (src && 'setData' in src) (src as mapboxgl.GeoJSONSource).setData(fc);
    };
    setData(ENC_VEC_SRC.LNDARE, data.LNDARE);
    setData(ENC_VEC_SRC.DEPARE, data.DEPARE);
    setData(ENC_VEC_SRC.DEPARE_GLAZE, data.DEPARE_GLAZE);
    setData(ENC_VEC_SRC.DEPCNT, data.DEPCNT);
    setData(ENC_VEC_SRC.COALNE, data.COALNE);
    setData(ENC_VEC_SRC.POINTS, buildMergedPoints(data));
    setData(ENC_VEC_SRC.NAVAIDS, buildMergedNavaids(data));
    setData(ENC_VEC_SRC.RECTRC, data.RECTRC);
    setData(ENC_VEC_SRC.SOUNDG, data.SOUNDG);

    // New cells can carry different charted contour values — refresh
    // the VALDCO inventory and re-derive the safety contour at the
    // last-applied safety depth.
    const state = depthStyleState.get(map);
    const safetyDepthM = state?.safetyDepthM ?? DEFAULT_SAFETY_DEPTH_M;
    depthStyleState.set(map, { safetyDepthM, depcntValdcos: distinctValdcos(data.DEPCNT) });
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
const SATELLITE_KEY = 'thalassa_satellite_base_v2';
// Land fills blanket the imagery; COALNE + the bold safety contour are
// CHART furniture that reads as scribble over photos (Shane 2026-07-11:
// "the thick black line, the straight brown lines… can we remove all of
// these" — the brown was the 1:90k cell's generalized coastline drawn
// straight across a headland the imagery already shows perfectly). The
// thin grey depth contours + labels stay: they carry information the
// imagery can't.
const SATELLITE_HIDE_LAYERS: readonly string[] = [
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.LNDARE_ISLET,
    ENC_VEC_LAYERS.COALNE,
    ENC_VEC_LAYERS.DEPCNT_SAFETY,
];
function satelliteBaseOn(): boolean {
    try {
        return localStorage.getItem(SATELLITE_KEY) === 'true';
    } catch {
        return false;
    }
}

/**
 * Satellite-mode DEPARE opacity — the white ramp becomes a depth-graded
 * GLAZE over the imagery: deep water takes the full wash (the imagery
 * there is featureless navy), shallows go translucent so the real sand
 * banks glow through the dirty tint, and drying stays solid enough to
 * read as a warning.
 */
export function buildDepareSatelliteOpacity(): mapboxgl.ExpressionSpecification {
    return [
        'step',
        ['coalesce', ['to-number', ['get', 'DRVAL1']], 999],
        0.55, // drying — a real warning even over imagery
        0,
        0.3, // 0–2 m — the banks themselves, let them show
        2,
        0.33,
        5,
        0.37,
        10,
        0.42,
        20,
        0.48,
        50,
        0.55, // open water — mostly paper
    ] as unknown as mapboxgl.ExpressionSpecification;
}

/** Chart-mode fill opacity — near-opaque paper over the dark shell. */
export const DEPARE_CHART_OPACITY = 0.95;

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
const DEPARE_COMPETENCE_FILTER = [
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
] as unknown as mapboxgl.FilterSpecification;

/** Harbour-grade fineness gate for the over-land repaint (rank from
 *  cellScaleRank: ~1-degree coastal cells are ~0; harbour cells 80+). */
const DEPARE_FINE_RANK_FILTER = [
    '>=',
    ['coalesce', ['to-number', ['get', '_scaleRank']], -32768],
    40,
] as unknown as mapboxgl.FilterSpecification;

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
            satOn
                ? ([
                      'all',
                      DEPARE_FINE_RANK_FILTER,
                      DEPARE_COMPETENCE_FILTER,
                  ] as unknown as mapboxgl.FilterSpecification)
                : DEPARE_FINE_RANK_FILTER,
        );
    }
    if (map.getLayer(ENC_VEC_LAYERS.DEPARE_GLAZE)) {
        map.setPaintProperty(
            ENC_VEC_LAYERS.DEPARE_GLAZE,
            'fill-opacity',
            satOn ? buildDepareSatelliteOpacity() : 0,
        );
        map.setFilter(ENC_VEC_LAYERS.DEPARE_GLAZE, satOn ? DEPARE_COMPETENCE_FILTER : null);
    }
}

/**
 * Toggle layer visibility without mutating sources. Useful for the
 * UI toggle (when added) — keeps the tile cache warm so re-show
 * is instant.
 */
export function setEncVectorVisibility(map: mapboxgl.Map, visible: boolean): void {
    const satOn = satelliteBaseOn();
    for (const id of ALL_LAYER_IDS) {
        const wantVisible = visible && !(satOn && SATELLITE_HIDE_LAYERS.includes(id));
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', wantVisible ? 'visible' : 'none');
    }
    syncDepareBaseTreatment(map);
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
    // Probe master toggle state via BCNLAT (always 'visible' when ENC is on,
    // 'none' when ENC is off). If the layer doesn't exist yet, the user has
    // no cells imported and there's nothing to focus.
    const probe = map.getLayer(ENC_VEC_LAYERS.BCNLAT);
    if (!probe) return;
    const masterVisible = map.getLayoutProperty(ENC_VEC_LAYERS.BCNLAT, 'visibility') !== 'none';
    if (!masterVisible) return; // every ENC layer already hidden — leave it

    const satOn = satelliteBaseOn();
    for (const id of ROUTE_FOCUS_HIDE_LAYERS) {
        const wantVisible = !focused && !(satOn && SATELLITE_HIDE_LAYERS.includes(id));
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', wantVisible ? 'visible' : 'none');
    }
    syncDepareBaseTreatment(map);
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
    const probe = map.getLayer(ENC_VEC_LAYERS.BCNLAT);
    if (!probe) return;
    const masterVisible = map.getLayoutProperty(ENC_VEC_LAYERS.BCNLAT, 'visibility') !== 'none';
    if (!masterVisible) return;

    const satOn = satelliteBaseOn();
    for (const id of CHART_DETAIL_HIDE_LAYERS) {
        // Contour lines stay under satellite — only the area fills yield.
        const wantVisible = detailed && !(satOn && SATELLITE_HIDE_LAYERS.includes(id));
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', wantVisible ? 'visible' : 'none');
    }
    syncDepareBaseTreatment(map);
}

// ── Click-to-popup ─────────────────────────────────────────────────

/**
 * Escape HTML special chars so feature properties (e.g. `OBJNAM`
 * containing apostrophes) can't break the popup HTML.
 */
function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fmtDepth(v: unknown, suffix = ' m'): string {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(1)}${suffix}`;
}

function fmtRange(min: unknown, max: unknown): string | null {
    const a = typeof min === 'number' ? min : Number(min);
    const b = typeof max === 'number' ? max : Number(max);
    if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
    if (Number.isFinite(a) && Number.isFinite(b)) return `${a.toFixed(1)}–${b.toFixed(1)} m`;
    if (Number.isFinite(a)) return `${a.toFixed(1)} m+`;
    return `≤${b.toFixed(1)} m`;
}

/**
 * S-57 attribute lookups for the popup. Wreck and obstruction
 * categories are coded ints in the source — we map the most-common
 * ones; unknown codes fall back to the raw value.
 */
const CATWRK_LABELS: Record<string, string> = {
    '1': 'Non-dangerous wreck',
    '2': 'Dangerous wreck',
    '3': 'Distributed remains',
    '4': 'Wreck showing mast/funnel',
    '5': 'Wreck showing hull',
};

const CATOBS_LABELS: Record<string, string> = {
    '1': 'Snag/Stump',
    '2': 'Wellhead',
    '3': 'Diffuser',
    '4': 'Crib',
    '5': 'Fish haven',
    '6': 'Foul area',
    '7': 'Foul ground',
    '8': 'Ice boom',
    '9': 'Ground tackle',
    '10': 'Boom',
};

const WATLEV_LABELS: Record<string, string> = {
    '1': 'Partly submerged at high water',
    '2': 'Always dry',
    '3': 'Always submerged',
    '4': 'Covers and uncovers',
    '5': 'Awash',
    '6': 'Subject to inundation/flooding',
    '7': 'Floating',
};

/**
 * Build the popup HTML for a feature. The layer ID determines
 * which fields we surface — DEPARE shows depth range, WRECKS
 * shows category + depth, etc.
 *
 * Style: dark glassmorphic to match the rest of the app's chart
 * UI. Mapbox's default popup CSS gives us a white background; we
 * override per-class in the class names.
 */
interface PopupExtras {
    /** Vessel keel floor (draft + tide margin, metres) from depthStyleState. */
    safetyDepthM?: number;
    /** Tide offset in force on the chart (metres above LAT), null = datum. */
    tideOffsetM?: number | null;
    /** Non-null when the offset is a SCRUBBED instant, not live "now". */
    tideOffsetAtMs?: number | null;
    /** Keel floor came from the 2.5 m fallback draft — caveat required. */
    draftAssumed?: boolean;
}

const fmtHm = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

function buildFeaturePopupHtml(layerId: string, props: Record<string, unknown>, extras: PopupExtras = {}): string {
    const cellId = props._cellId as string | undefined;
    const sourceHO = props._sourceHO as string | undefined;
    const provenance = cellId
        ? `<div class="enc-popup-cell">${esc(cellId)}${sourceHO ? ` · ${esc(sourceHO)}` : ''}</div>`
        : '';

    let title = 'Feature';
    let body = '';
    let accent = '#0ea5e9'; // sky-500 default

    if (layerId === ENC_VEC_LAYERS.DEPARE) {
        // Tap-the-water (2026-07-11 #1): the punter taps any patch of
        // water and gets the ANSWER — charted band, live water, and the
        // keel verdict — instead of chart-speak. The tide window for
        // needs-tide reads fills in async (see fillDepareTideWindow).
        title = 'Water';
        accent = '#3a8dbf';
        const d1raw = Number(props.DRVAL1 ?? props.drval1);
        const d2raw = Number(props.DRVAL2 ?? props.drval2);
        const d1 = Number.isFinite(d1raw) ? d1raw : null;
        const d2 = Number.isFinite(d2raw) ? d2raw : null;
        if (d1 !== null) {
            const charted =
                d1 < 0 && d2 !== null && d2 > 0
                    ? // Straddles the drying line: part sand at low tide,
                      // part water — say BOTH (review minor: "dries up to
                      // X" alone hid the water).
                      `dries up to ${Math.abs(d1).toFixed(1)} m / up to ${d2.toFixed(1)} m of water`
                    : d1 < 0
                      ? `dries up to ${Math.abs(d1).toFixed(1)} m`
                      : d2 !== null
                        ? `${d1.toFixed(d1 < 10 ? 1 : 0)}–${d2.toFixed(d2 < 10 ? 1 : 0)} m of water`
                        : `at least ${d1.toFixed(1)} m`;
            body += `<div class="enc-popup-row"><span>At low tide</span><b>${esc(charted)}</b></div>`;
            const h = extras.tideOffsetM;
            // Scrub honesty (review CRITICAL): a scrubbed offset must never
            // wear "right now" — every tide-derived row is labelled with
            // the instant it describes, in the scrubber's violet.
            const scrubbedAt = extras.tideOffsetAtMs ?? null;
            const whenLabel = scrubbedAt !== null ? `At ${fmtHm(scrubbedAt)}` : 'Right now';
            const tideColor = scrubbedAt !== null ? '#c4b5fd' : '#5eead4';
            if (h != null) {
                const lo = d1 + h;
                const hi = d2 !== null ? d2 + h : null;
                const reads =
                    lo <= 0 && hi !== null && hi <= 0
                        ? 'still dry'
                        : `≈ ${Math.max(0, lo).toFixed(1)}${hi !== null ? `–${Math.max(0, hi).toFixed(1)}` : ''} m`;
                body += `<div class="enc-popup-row"><span>${esc(whenLabel)}</span><b style="color:${tideColor}">${esc(reads)} (tide ${h >= 0 ? '+' : ''}${h.toFixed(1)} m)</b></div>`;
            }
            const S = extras.safetyDepthM;
            if (S != null && S > 0) {
                if (d1 >= S) {
                    body += `<div class="enc-popup-row"><span>Your keel</span><b style="color:#4ade80">✓ deep enough at any tide</b></div>`;
                } else if (h != null && d1 + h >= S) {
                    body +=
                        scrubbedAt !== null
                            ? `<div class="enc-popup-row"><span>Your keel</span><b style="color:${tideColor}">✓ enough water at ${esc(fmtHm(scrubbedAt))} — NOT necessarily now</b></div>`
                            : `<div class="enc-popup-row"><span>Your keel</span><b style="color:${tideColor}">✓ enough water right now — the tide is in</b></div>`;
                } else {
                    body += `<div class="enc-popup-row"><span>Your keel</span><b style="color:#fbbf24">needs +${(S - d1).toFixed(1)} m of tide</b></div>`;
                    body += `<div class="enc-popup-row"><span>Window</span><b class="enc-popup-tidewin" style="color:#fbbf24">checking tides…</b></div>`;
                }
                // Draft honesty (mirrors the tracer): a verdict against the
                // fallback draft always says so.
                if (extras.draftAssumed) {
                    body += `<div class="enc-popup-row"><span></span><b style="color:#fbbf24">checked against a default 2.5 m draft — set your vessel</b></div>`;
                }
            }
        } else {
            body += `<div class="enc-popup-row"><span>Type</span><b>Charted depth area</b></div>`;
        }
    } else if (layerId === ENC_VEC_LAYERS.LNDARE) {
        title = 'Land';
        accent = '#a8956a';
        body += `<div class="enc-popup-row"><span>Type</span><b>Charted land area</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.COALNE) {
        title = 'Coastline';
        accent = '#ffffff';
        body += `<div class="enc-popup-row"><span>Type</span><b>Charted coastline</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.OBSTRN) {
        title = 'Obstruction';
        accent = '#d837a9';
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        const cat = String(props.CATOBS ?? props.catobs ?? '');
        if (cat && CATOBS_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Category</span><b>${esc(CATOBS_LABELS[cat])}</b></div>`;
        }
        const depth = props.VALSOU ?? props.valsou;
        if (depth != null) body += `<div class="enc-popup-row"><span>Depth</span><b>${esc(fmtDepth(depth))}</b></div>`;
        const watlev = String(props.WATLEV ?? props.watlev ?? '');
        if (watlev && WATLEV_LABELS[watlev]) {
            body += `<div class="enc-popup-row"><span>Water level</span><b>${esc(WATLEV_LABELS[watlev])}</b></div>`;
        }
    } else if (layerId === ENC_VEC_LAYERS.WRECKS) {
        title = 'Wreck';
        accent = '#d837a9';
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        const cat = String(props.CATWRK ?? props.catwrk ?? '');
        if (cat && CATWRK_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Category</span><b>${esc(CATWRK_LABELS[cat])}</b></div>`;
        }
        const depth = props.VALSOU ?? props.valsou;
        if (depth != null) body += `<div class="enc-popup-row"><span>Depth</span><b>${esc(fmtDepth(depth))}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.UWTROC) {
        title = 'Underwater rock';
        accent = '#d837a9';
        const depth = props.VALSOU ?? props.valsou;
        if (depth != null) body += `<div class="enc-popup-row"><span>Depth</span><b>${esc(fmtDepth(depth))}</b></div>`;
        const watlev = String(props.WATLEV ?? props.watlev ?? '');
        if (watlev && WATLEV_LABELS[watlev]) {
            body += `<div class="enc-popup-row"><span>Water level</span><b>${esc(WATLEV_LABELS[watlev])}</b></div>`;
        }
    } else if (layerId === ENC_VEC_LAYERS.LIGHTS) {
        title = 'Light';
        accent = '#fde047';
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        // Character row: prefer the merge-time pre-baked full description
        // ("Fl(2)G 5s 12m 8M" from buildLightCharacterLabel); else decode
        // the raw LITCHR code through LITCHR_LABELS ('Fl' → 'Flashing');
        // else show the raw code the user can cross-reference on a chart.
        const lightLabel = props._lightLabel;
        const litchr = props.LITCHR ?? props.litchr;
        const sigper = props.SIGPER ?? props.sigper;
        const valnmr = props.VALNMR ?? props.valnmr;
        const height = props.HEIGHT ?? props.height;
        const colour = props.COLOUR ?? props.colour;
        if (typeof lightLabel === 'string' && lightLabel) {
            body += `<div class="enc-popup-row"><span>Character</span><b>${esc(lightLabel)}</b></div>`;
        } else if (litchr) {
            const decoded = LITCHR_LABELS[String(litchr)] ?? String(litchr);
            body += `<div class="enc-popup-row"><span>Character</span><b>${esc(decoded)}</b></div>`;
        }
        if (sigper) body += `<div class="enc-popup-row"><span>Period</span><b>${esc(sigper)} s</b></div>`;
        if (height) body += `<div class="enc-popup-row"><span>Height</span><b>${esc(fmtDepth(height))}</b></div>`;
        if (valnmr) body += `<div class="enc-popup-row"><span>Range</span><b>${esc(valnmr)} NM</b></div>`;
        if (colour) body += `<div class="enc-popup-row"><span>Colour code</span><b>${esc(String(colour))}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYLAT || layerId === ENC_VEC_LAYERS.BCNLAT) {
        const isBeacon = layerId === ENC_VEC_LAYERS.BCNLAT;
        title = isBeacon ? 'Lateral beacon' : 'Lateral buoy';
        accent = '#facc15';
        const CATLAM_LABELS: Record<string, string> = {
            '1': 'Port-hand mark',
            '2': 'Starboard-hand mark',
            '3': 'Preferred channel — port',
            '4': 'Preferred channel — starboard',
            '5': 'Channel marker',
            '6': 'Bifurcation',
            '7': 'Junction',
            '8': 'Wreck mark',
        };
        const cat = String(props.CATLAM ?? props.catlam ?? '');
        if (cat && CATLAM_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Mark</span><b>${esc(CATLAM_LABELS[cat])}</b></div>`;
        }
        const region = props._ialaRegion;
        if (region === 'A' || region === 'B') {
            body += `<div class="enc-popup-row"><span>Region</span><b>IALA-${esc(region)}</b></div>`;
        }
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYCAR || layerId === ENC_VEC_LAYERS.BCNCAR) {
        const isBeacon = layerId === ENC_VEC_LAYERS.BCNCAR;
        title = isBeacon ? 'Cardinal beacon' : 'Cardinal buoy';
        accent = '#facc15';
        const CATCAM_LABELS: Record<string, string> = {
            '1': 'North',
            '2': 'East',
            '3': 'South',
            '4': 'West',
        };
        const cat = String(props.CATCAM ?? props.catcam ?? '');
        if (cat && CATCAM_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Quadrant</span><b>${esc(CATCAM_LABELS[cat])}</b></div>`;
            // The rule, spelled out — a cardinal is passed on the side it
            // NAMES. Shane 2026-07-11: "I need to pass on the correct side
            // of cardinals but I do not know which side is which."
            body += `<div class="enc-popup-row"><span>Pass</span><b style="color:#4ade80">${esc(
                CATCAM_LABELS[cat].toUpperCase(),
            )} of this mark</b></div>`;
        }
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYSPP || layerId === ENC_VEC_LAYERS.BCNSPP) {
        const isBeacon = layerId === ENC_VEC_LAYERS.BCNSPP;
        title = isBeacon ? 'Special-purpose beacon' : 'Special-purpose buoy';
        accent = '#facc15';
        // S-57 CATSPM (category of special-purpose mark) — the values a
        // skipper actually meets; anything else falls through to the name.
        const CATSPM_LABELS: Record<string, string> = {
            '1': 'Firing-danger area',
            '6': 'Cable mark',
            '7': 'Spoil-ground mark',
            '8': 'Outfall mark',
            '9': 'ODAS (data buoy)',
            '14': 'Mooring',
            '15': 'LANBY',
            '16': 'Leading mark',
            '18': 'Notice mark',
            '20': 'Anchorage mark',
            '22': 'Pipeline mark',
            '25': 'Control mark',
            '26': 'Diving mark',
            '28': 'Foul-ground mark',
            '39': 'Marine-farm mark',
            '44': 'Wreck mark',
        };
        const cat = String(props.CATSPM ?? props.catspm ?? '');
        if (cat && CATSPM_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Purpose</span><b>${esc(CATSPM_LABELS[cat])}</b></div>`;
        }
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
    }

    if (!body) body = `<div class="enc-popup-row"><span>Feature</span><b>${esc(title)}</b></div>`;

    return `
        <div class="enc-popup">
            <button class="enc-popup-close" aria-label="Close">×</button>
            <div class="enc-popup-title" style="color:${accent}">${esc(title)}</div>
            <div class="enc-popup-body">${body}</div>
            ${provenance}
        </div>
        <style>
            .enc-popup {
                position: relative;
                font-family: system-ui, -apple-system, sans-serif;
                color: rgb(229, 231, 235);
                background: rgba(15, 23, 42, 0.92);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 10px;
                padding: 10px 12px;
                font-size: 12px;
                line-height: 1.5;
                min-width: 180px;
                max-width: 280px;
            }
            .enc-popup-close {
                position: absolute;
                top: 4px;
                right: 6px;
                background: rgba(15, 23, 42, 0.85);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: rgb(209, 213, 219);
                border-radius: 999px;
                width: 22px;
                height: 22px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                font-weight: bold;
                padding: 0;
            }
            .enc-popup-close:hover {
                background: rgba(220, 38, 38, 0.85);
                color: white;
            }
            .enc-popup-title {
                font-size: 13px;
                font-weight: 700;
                margin-bottom: 6px;
                padding-right: 22px;
            }
            .enc-popup-body { display: flex; flex-direction: column; gap: 2px; }
            .enc-popup-row { display: flex; justify-content: space-between; gap: 12px; }
            .enc-popup-row span { color: rgba(229, 231, 235, 0.55); }
            .enc-popup-row b { font-weight: 600; color: rgb(229, 231, 235); }
            .enc-popup-cell {
                margin-top: 6px;
                padding-top: 6px;
                border-top: 1px solid rgba(255, 255, 255, 0.08);
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 10px;
                color: rgba(229, 231, 235, 0.55);
            }
            .mapboxgl-popup-content { background: transparent !important; padding: 0 !important; box-shadow: none !important; }
            .mapboxgl-popup-tip { display: none !important; }
        </style>
    `;
}

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

/**
 * Async half of the tap-the-water popup: a needs-tide verdict shows
 * "checking tides…" and this fills in the actual window ("clears
 * 09:10–14:30 today") once the curve answers. No-ops silently when
 * the popup closed or tide data is unreachable.
 */
function fillDepareTideWindow(popup: mapboxgl.Popup, props: Record<string, unknown>, extras: PopupExtras): void {
    const d1 = Number(props.DRVAL1 ?? props.drval1);
    const S = extras.safetyDepthM;
    if (!Number.isFinite(d1) || S == null || S <= 0 || d1 >= S) return;
    const h = extras.tideOffsetM;
    if (h != null && d1 + h >= S) return;
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

/**
 * Wire up click handlers on every ENC vector layer so tapping a
 * feature shows a popup describing it. Idempotent — if handlers
 * are already attached, this is a no-op.
 */
export function attachEncFeatureClickHandlers(map: mapboxgl.Map): void {
    if (attachedHandlers.has(map)) return;

    const onClick = (e: mapboxgl.MapMouseEvent) => {
        if (popupSuppression.get(map)) return;
        // queryRenderedFeatures across all our layers; topmost wins.
        // Order matters: we list points first (small, easy to miss
        // if covered by a polygon hit) then polygons last.
        const features = map.queryRenderedFeatures(e.point, { layers: CLICKABLE_LAYER_IDS });
        if (!features.length) return;

        // Prefer point features over big polygons when both are
        // hit — clicking near a buoy that sits on top of a depth
        // area should pop the buoy info, not the depth.
        const POINT_LAYER_IDS = new Set<string>([
            ENC_VEC_LAYERS.OBSTRN,
            ENC_VEC_LAYERS.WRECKS,
            ENC_VEC_LAYERS.UWTROC,
            ENC_VEC_LAYERS.LIGHTS,
            ENC_VEC_LAYERS.BOYLAT,
            ENC_VEC_LAYERS.BOYCAR,
            ENC_VEC_LAYERS.BCNLAT,
            ENC_VEC_LAYERS.BCNCAR,
            ENC_VEC_LAYERS.BOYSPP,
            ENC_VEC_LAYERS.BCNSPP,
        ]);
        const point = features.find((f) => POINT_LAYER_IDS.has(f.layer?.id ?? ''));
        const feat = point ?? features[0];
        const layerId = feat.layer?.id ?? '';
        const props = (feat.properties ?? {}) as Record<string, unknown>;

        const existing = attachedHandlers.get(map);
        if (existing?.popup) existing.popup.remove();

        // Vessel keel + live tide state ride along so the DEPARE branch
        // can answer "can I float here" instead of quoting chart-speak.
        const dstate = depthStyleState.get(map);
        const extras: PopupExtras = {
            safetyDepthM: dstate?.safetyDepthM,
            tideOffsetM: dstate?.tideOffsetM ?? null,
            tideOffsetAtMs: dstate?.tideOffsetAtMs ?? null,
            draftAssumed: dstate?.draftAssumed ?? false,
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

    for (const id of CLICKABLE_LAYER_IDS) {
        map.on('click', id, onClick);
        map.on('mouseenter', id, onEnter);
        map.on('mouseleave', id, onLeave);
    }

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
    for (const id of CLICKABLE_LAYER_IDS) {
        map.off('click', id, h.click);
        map.off('mouseenter', id, h.enter);
        map.off('mouseleave', id, h.leave);
    }
    if (h.popup) h.popup.remove();
    attachedHandlers.delete(map);
    log.info('detached ENC feature click handlers');
}
