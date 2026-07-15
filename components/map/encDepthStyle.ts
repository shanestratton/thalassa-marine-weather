/**
 * encDepthStyle — the PURE depth-style math for the ENC chart layer.
 *
 * Extracted from EncVectorLayer.ts (2026-07-12 audit) so the
 * safety-critical display rules — band ramps, sounding typography,
 * safety-contour derivation — are unit-testable without a Mapbox map.
 * EncVectorLayer owns everything that touches a live map; this module
 * owns everything that is just maths + expressions.
 *
 * HARD RULES enforced here (each has a test in tests/enc/):
 *  1. Unknown depth NEVER reads as safe. A DEPARE polygon whose DRVAL1
 *     is missing or garbage renders as UNCHARTED (transparent fill, no
 *     satellite glaze) — not as deep water. The old `coalesce → 999`
 *     fallback painted unknown polygons as 50 m+ clean paper and lit
 *     the keel-safe glaze over them.
 *  2. Attribute reads are case-defensive. ogr2ogr-converted cells can
 *     carry lowercase attribute names (the rest of the pipeline already
 *     defends this); paint/filter expressions must too, or a lowercase
 *     cell renders every contour as "0 m" with no safety line.
 *  3. The safety contour is per-CELL. One window-global "smallest
 *     VALDCO ≥ S" left neighbouring cells with no bold line whenever
 *     their contour inventory lacked that exact value.
 *  4. Never embolden a contour SHALLOWER than the safety depth —
 *     computeSafetyValdco returns null instead (see its docstring).
 */

import type { ExpressionSpecification, FilterSpecification } from 'mapbox-gl';

// ── Sentinels ──────────────────────────────────────────────────────

/** Expression-side sentinel for a missing/garbage numeric attribute.
 *  MUST stay distinct from NO_SAFETY_VALDCO: if they collided, a
 *  contour with unknown VALDCO would MATCH the "no safety contour"
 *  filter and render bold. */
export const ATTR_UNKNOWN = -9999;

/** Sentinel VALDCO that matches no real contour (no-contour cells). */
export const NO_SAFETY_VALDCO = -99999;

/** Any attr value above this is a real charted number (drying heights
 *  run ~-10..0; ATTR_UNKNOWN sits far below). */
const ATTR_VALID_FLOOR = -1000;

/**
 * Fallback safety depth when the caller doesn't supply one:
 * vesselDraftMetres() default (2.5 m) + the MASTERPLAN §8 tide
 * margin (0.5 m). The hook always passes the live value.
 */
export const DEFAULT_SAFETY_DEPTH_M = 3.0;

/** Chart-mode fill opacity — near-opaque paper over the dark shell. */
export const DEPARE_CHART_OPACITY = 0.95;

// ── Shared ink (single source of truth — audit R7: the authored
//    contour-label ink was dead code, silently overridden by a second
//    hardcoded colour in applyTideOffsetPaint) ─────────────────────

/** Contour value labels, chart datum — muted dark slate: quieter than
 *  soundings but legible on the white ramp and over imagery. */
export const DEPCNT_LABEL_INK_DATUM = '#46555f';
/** Contour value labels in live-tide mode — the teal family, so a
 *  screenshot can never masquerade as chart datum. */
export const DEPCNT_LABEL_INK_LIVE = '#54828d';

/** IHO hazard magenta — hazard point symbols AND their popup accents.
 *  Was four scattered literals; a rebrand that missed one left symbols
 *  and popups subtly mismatched. */
export const ENC_HAZARD_MAGENTA = '#d837a9';

// ── Case-defensive attribute reads ────────────────────────────────

type Expr = unknown[];

/**
 * Read a numeric S-57 attribute inside a Mapbox expression,
 * defending BOTH the uppercase and lowercase spelling, and resolving
 * missing/garbage values to ATTR_UNKNOWN (never 0, never "deep").
 *
 * Mapbox semantics this guards against:
 *  - ['get', missing] → null, and to-number(null) → 0 — which read
 *    as a real 0 m depth;
 *  - to-number(garbage string) throws, and coalesce() skips errors —
 *    which used to land on the "very deep" 999 fallback.
 */
export function numAttrExpr(upper: string, lower: string): Expr {
    return [
        'case',
        ['has', upper],
        ['to-number', ['get', upper], ATTR_UNKNOWN],
        ['has', lower],
        ['to-number', ['get', lower], ATTR_UNKNOWN],
        ATTR_UNKNOWN,
    ];
}

const DRVAL1_ATTR = numAttrExpr('DRVAL1', 'drval1');
const VALDCO_ATTR = numAttrExpr('VALDCO', 'valdco');

/** True when the attr expression resolved to a real charted number. */
const attrValid = (attr: Expr): Expr => ['>', attr, ATTR_VALID_FLOOR];

// ── DEPARE band fills ─────────────────────────────────────────────

/**
 * S-52-style day-palette band fills. Absolute white ramp — paper-chart
 * convention (Shane 2026-07-11: "white where deep, off white all the
 * way to a dirty white where it is not"). White = SURVEYED AND DEEP;
 * the tint dirties as the sand comes up, drying banks go khaki.
 * Bands are absolute, not draft-keyed (his call — predictable, matches
 * the paper chart aboard); the keel story lives in the draft-keyed
 * SAFETY CONTOUR on top. Uncharted water — AND water whose DRVAL1 is
 * missing/garbage — gets no fill at all: absence of data must never
 * read as deep (the au-brisbane-test lesson, hard rule 1).
 *
 * tideOffsetM ("depth right now" toggle): shifting every band stop
 * down by the predicted tide height re-tints the whole chart for
 * the water that's actually under the keel. Stops stay strictly
 * ascending for any constant shift, so the step stays valid.
 */
export function buildDepareFillColor(tideOffsetM = 0): ExpressionSpecification {
    const h = tideOffsetM;
    return [
        'case',
        attrValid(DRVAL1_ATTR),
        [
            'step',
            DRVAL1_ATTR,
            DEPARE_BAND_COLORS.drying, // < 0 now — still drying at THIS tide
            0 - h,
            DEPARE_BAND_COLORS.b0to2, // 0–2 m — dirtiest white
            2 - h,
            DEPARE_BAND_COLORS.b2to5, // 2–5 m — the 2.4 m-keel decision band
            5 - h,
            DEPARE_BAND_COLORS.b5to10, // 5–10 m
            10 - h,
            DEPARE_BAND_COLORS.b10to20, // 10–20 m
            20 - h,
            DEPARE_BAND_COLORS.b20to50, // 20–50 m
            50 - h,
            DEPARE_BAND_COLORS.b50plus, // 50 m+ — clean paper
        ],
        // Unknown depth: uncharted read. NEVER deep (hard rule 1).
        'rgba(0,0,0,0)',
    ] as unknown as ExpressionSpecification;
}

/** The white-ramp band palette. `drying` is deliberately a distinct
 *  sand-green step away from the 0–2 m dirty white — at-a-glance
 *  dries-vs-water separation in sunlight (audit U4: the two warm
 *  whites were ~3 L* apart and unreadable in glare). */
export const DEPARE_BAND_COLORS = {
    drying: '#c6c295',
    b0to2: '#d4cdbf',
    b2to5: '#ded8cc',
    b5to10: '#e8e3d9',
    b10to20: '#f0ede5',
    b20to50: '#f7f5f0',
    b50plus: '#ffffff',
} as const;

/**
 * Satellite-mode DEPARE opacity — KEEL-KEYED (Shane 2026-07-12: "we
 * need to be able to see the areas that have enough depth for our keel
 * easily"). The glaze is a go/no-go read:
 *  - drying: solid warning wash;
 *  - charted but SHALLOWER than the safety depth: a low-opacity amber
 *    CAUTION wash (SHALLOW_CAUTION_*). This was opacity ZERO (Shane
 *    2026-07-13: "remove these dark shaded areas" — the old 0.15 whisper
 *    read as murky dark blocks), but zero made a KNOWN shoal pixel-
 *    identical to unknown/uncharted (also 0) — a salience collision on
 *    the default base (mission audit). The amber caution is see-through
 *    enough to keep reading the water + numbers while distinguishing
 *    charted-shallow from both safe-white and bare imagery. Trade-off:
 *    the parked-martinez strip-clip glaze holes are no longer fully
 *    hidden (they read as faint gaps in the shallow wash);
 *  - guaranteed depth ≥ safety depth (band DRVAL1, chart datum — the
 *    same conservative convention as the safety contour): bright white
 *    paper, stepping brighter as it deepens;
 *  - unknown DRVAL1: BARE IMAGERY (opacity 0) — same as uncharted,
 *    never the bright "sail here" wash (hard rule 1).
 *
 * PAIRING INVARIANT: the glaze's fill-COLOR must be keyed to the same
 * chart datum as this opacity (buildDepareFillColor with NO tide
 * offset). Tide-shifting one half alone paints a drying bank in the
 * near-safe dirty white under the 0.55 drying wash (2026-07-14).
 */
/** Charted-but-shallow water (0 ≤ DRVAL1 < S) on the satellite base was
 *  opacity 0 — pixel-identical to unknown/UNCHARTED, so a KNOWN shoal read
 *  as no-data (mission audit). It now gets a distinct low-opacity CAUTION
 *  wash: warm amber, keyed to the amber safety contour, clearly not the
 *  bright safe-white and clearly not bare imagery. See-through enough to
 *  keep reading the water + soundings.
 *
 *  DEVICE-VISUAL, tunable/revertible: this reverses the deliberate
 *  "shallow = bare imagery, imagery IS the message" model AND may re-expose
 *  the parked strip-clip glaze holes as FAINT gaps in shallow water (they
 *  were hidden because shallow was untinted — "a hole in nothing is
 *  nothing"). Needs on-device review; set SHALLOW_CAUTION_OPACITY back to 0
 *  to restore the old binary look. */
export const SHALLOW_CAUTION_COLOR = '#ecd39a';
const SHALLOW_CAUTION_OPACITY = 0.4;

export function buildDepareSatelliteOpacity(safetyDepthM: number): ExpressionSpecification {
    const s = Math.max(safetyDepthM, 0.1);
    return [
        'case',
        attrValid(DRVAL1_ATTR),
        [
            'step',
            DRVAL1_ATTR,
            0.55, // drying — a real warning even over imagery
            0,
            SHALLOW_CAUTION_OPACITY, // charted-shallow — distinct caution wash (was 0 = identical to uncharted)
            s,
            0.62, // enough water — bright paper, sail here
            Math.max(s + 0.01, 20),
            0.68,
            Math.max(s + 0.02, 50),
            0.72, // open water — mostly paper
        ],
        0,
    ] as unknown as ExpressionSpecification;
}

/**
 * Satellite-glaze fill COLOUR — FLAT two-tone, not the chart ramp
 * (Shane 2026-07-14: "blocky squares floating around... 80's styling").
 * The glaze verdict is binary (white = GO), but painting it with the
 * DEPTH-GRADED ramp meant every overlap between a coarse and a fine
 * band of different depths rendered as a visibly different-hue
 * rectangle wherever the strip clip cut a piece — grey-blue deep-band
 * blocks over off-white mid-band water. One flat white for ALL safe
 * water makes overlaps invisible (white-on-white is just white);
 * drying keeps its distinct khaki. Chart-datum keyed, matching the
 * opacity (the PAIRING INVARIANT above).
 */
export function buildDepareGlazeFillColor(safetyDepthM: number): ExpressionSpecification {
    const s = Math.max(safetyDepthM, 0.1);
    return [
        'case',
        attrValid(DRVAL1_ATTR),
        // drying khaki < 0 ≤ shallow-caution amber < S ≤ safe white. Same 0/S
        // boundaries as buildDepareSatelliteOpacity (the PAIRING INVARIANT).
        ['step', DRVAL1_ATTR, DEPARE_BAND_COLORS.drying, 0, SHALLOW_CAUTION_COLOR, s, '#f7f5f0'],
        '#f7f5f0', // unknown DRVAL1 is opacity-0 anyway; colour never shows
    ] as unknown as ExpressionSpecification;
}

// ── Sounding typography ───────────────────────────────────────────

/** Subscript digits for chart-style sounding tenths (3₄, not 3.4). */
export const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

/**
 * Sounding label text. With a tide offset the displayed value is
 * charted + tide ("depth right now"). Carry-safe: whole and tenth both
 * derive from round(|v|·10) — computing them separately turned 1.96
 * into "1₀" instead of "2" once offsets made non-pre-rounded values
 * possible.
 */
export function buildSoundingTextField(tideOffsetM = 0): ExpressionSpecification {
    const v = tideOffsetM === 0 ? ['get', '_d'] : ['+', ['get', '_d'], tideOffsetM];
    const d10 = ['round', ['*', ['abs', v], 10]];
    const whole = ['floor', ['/', d10, 10]];
    const tenth = ['%', d10, 10];
    return [
        'case',
        ['<', ['abs', v], 10],
        ['concat', ['to-string', whole], ['case', ['==', tenth, 0], '', ['at', tenth, ['literal', SUBSCRIPT_DIGITS]]]],
        ['to-string', ['round', v]],
    ] as unknown as ExpressionSpecification;
}

/**
 * Sounding ink. Chart datum = slate (shallow darker) with khaki drying.
 * LIVE tide mode = a distinct TEAL family so a screenshot can never
 * masquerade as chart datum (the honesty rule from the design session);
 * "drying at this tide" keeps the khaki.
 */
export function buildSoundingTextColor(tideOffsetM: number | null = null): ExpressionSpecification {
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
        ] as unknown as ExpressionSpecification;
    }
    const v = ['+', ['get', '_d'], tideOffsetM];
    return ['case', ['<', v, 0], '#6b5e23', ['<', v, 5], '#0b4f58', '#2a6b77'] as unknown as ExpressionSpecification;
}

/** Contour label text — shifts with the tide offset so the screen never
 *  mixes datums. Unknown VALDCO renders NO label — the old bare
 *  to-number turned a lowercase-attributed cell into contours all
 *  labelled "0" (a wrong depth number on the chart, hard rule 2). */
export function buildDepcntLabelField(tideOffsetM = 0): ExpressionSpecification {
    const v = tideOffsetM === 0 ? VALDCO_ATTR : ['+', VALDCO_ATTR, tideOffsetM];
    return ['case', attrValid(VALDCO_ATTR), ['to-string', ['round', v]], ''] as unknown as ExpressionSpecification;
}

// ── Safety contour derivation ─────────────────────────────────────

/**
 * The safety contour to embolden: the smallest charted VALDCO ≥ the
 * vessel's safety depth S. Null when NO charted contour reaches S (a
 * shallow-only cell, or S deeper than every contour here) — we then
 * embolden NOTHING and let the DEPARE bands carry the depth message.
 * Emboldening the deepest available contour in that case (the old
 * `best ?? deepest`) was actively MISLEADING: it promoted a line
 * SHALLOWER than S to "safety contour", implying the water seaward of
 * it clears the keel when it doesn't — a grounding-risk line drawn at
 * the wrong depth. The shallower contours still draw as ordinary thin
 * lines; only the bold "this is your safety line" emphasis is withheld.
 */
export function computeSafetyValdco(valdcos: readonly number[], safetyDepthM: number): number | null {
    let best: number | null = null;
    for (const v of valdcos) {
        if (!Number.isFinite(v)) continue;
        if (v >= safetyDepthM && (best == null || v < best)) best = v;
    }
    return best;
}

/**
 * Per-cell safety contours (hard rule 3). Each cell bolds ITS OWN
 * smallest qualifying contour — a cell whose inventory lacks the
 * neighbour's exact value no longer loses its keel line at the seam.
 */
export function computeSafetyValdcoByCell(
    valdcosByCell: Readonly<Record<string, readonly number[]>>,
    safetyDepthM: number,
): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const [cellId, valdcos] of Object.entries(valdcosByCell)) {
        out[cellId] = computeSafetyValdco(valdcos, safetyDepthM);
    }
    return out;
}

/** Distinct VALDCO values present in the merged DEPCNT collection,
 *  grouped by the `_cellId` provenance the merge stamps on every
 *  feature. Features missing provenance group under '?'. */
export function distinctValdcosByCell(fc: {
    features?: Array<{ properties?: Record<string, unknown> | null } | null> | null;
}): Record<string, number[]> {
    const sets = new Map<string, Set<number>>();
    for (const f of fc.features ?? []) {
        const props = (f?.properties ?? {}) as Record<string, unknown>;
        const v = Number(props.VALDCO ?? props.valdco);
        if (!Number.isFinite(v)) continue;
        const cellId = typeof props._cellId === 'string' ? props._cellId : '?';
        let set = sets.get(cellId);
        if (!set) {
            set = new Set();
            sets.set(cellId, set);
        }
        set.add(v);
    }
    const out: Record<string, number[]> = {};
    for (const [cellId, set] of sets) out[cellId] = [...set].sort((a, b) => a - b);
    return out;
}

// SCAMIN-aware visibility clause — features pre-tagged with `_minZoom`
// (derived from S-57 SCAMIN at extraction time) become visible only at
// or above their chart-prescribed display zoom. Features without
// `_minZoom` are always-visible (correct for hazards lacking SCAMIN).
export const SCAMIN_CLAUSE = ['any', ['!', ['has', '_minZoom']], ['>=', ['zoom'], ['get', '_minZoom']]];

// Mark visibility FLOOR — nav marks (buoys, beacons, lights) show from z10
// regardless of their SCAMIN `_minZoom` (Shane 2026-07-16: "handy to see the
// markers at that level onwards"). AU nav-aid SCAMIN otherwise hides them
// until ~z13.5. Only the LOW-zoom floor moves; an EARLIER SCAMIN still wins,
// and above z10 marks were never SCAMIN-thinned (navaids allow-overlap), so
// no high-zoom density behaviour changes. Marks-only — soundings/names keep
// the plain SCAMIN_CLAUSE so their density ladder is untouched.
export const MARK_MIN_ZOOM = 10;
export const MARK_SCAMIN_CLAUSE = [
    'any',
    ['>=', ['zoom'], MARK_MIN_ZOOM],
    ['!', ['has', '_minZoom']],
    ['>=', ['zoom'], ['get', '_minZoom']],
];

/**
 * Boolean expression: "this DEPCNT feature is its cell's safety
 * contour". Built from the per-cell safety map; false when no cell
 * has a qualifying contour. Validity-guarded so an unknown VALDCO
 * (ATTR_UNKNOWN) can never match a sentinel (hard rule 2 + the
 * distinct-sentinel invariant).
 */
export function safetyContourMatchExpr(safetyByCell: Readonly<Record<string, number | null>>): unknown {
    const pairs = Object.entries(safetyByCell).filter((e): e is [string, number] => e[1] != null);
    if (pairs.length === 0) return false;
    return [
        'match',
        ['coalesce', ['get', '_cellId'], '?'],
        ...pairs.flatMap(([cellId, sv]) => [cellId, ['all', attrValid(VALDCO_ATTR), ['==', VALDCO_ATTR, sv]]]),
        false,
    ];
}

export function depcntLineFilter(safetyByCell: Readonly<Record<string, number | null>>): FilterSpecification {
    // Ordinary contours: everything except each cell's safety contour,
    // SCAMIN-gated.
    return ['all', ['!', safetyContourMatchExpr(safetyByCell)], SCAMIN_CLAUSE] as unknown as FilterSpecification;
}

export function depcntSafetyFilter(safetyByCell: Readonly<Record<string, number | null>>): FilterSpecification {
    // The safety contour always shows — NO scamin gate, per S-52.
    return safetyContourMatchExpr(safetyByCell) as FilterSpecification;
}
