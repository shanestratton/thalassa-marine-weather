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

import type mapboxgl from 'mapbox-gl';
import type { ExpressionSpecification, FilterSpecification } from 'mapbox-gl';
import { readS57 } from '../../services/enc/types';

// ── Sentinels ──────────────────────────────────────────────────────

/** Expression-side sentinel for a missing/garbage numeric attribute.
 *  MUST stay distinct from NO_SAFETY_VALDCO: if they collided, a
 *  contour with unknown VALDCO would MATCH the "no safety contour"
 *  filter and render bold. */
/** One named home for the raw-expression cast (2026-07-17 audit: ~30
 *  scattered `as unknown as ExpressionSpecification` double-casts on
 *  load-bearing filters/expressions). Mapbox's expression types can't
 *  model data-driven match/case trees built as plain arrays; this helper
 *  is the single greppable place that laundering happens — and the one
 *  place to tighten if the types ever catch up. */
export function mapExpr(expr: unknown): ExpressionSpecification {
    return expr as ExpressionSpecification;
}

/** Same laundering, filter flavour — see mapExpr. */
export function mapFilter(filter: unknown): mapboxgl.FilterSpecification {
    return filter as mapboxgl.FilterSpecification;
}

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
    return mapExpr([
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
    ]);
}

/** BLUE-SHALLOW band palette (Shane 2026-07-18: "change it — let's keep
 *  it real"). S-52/paper convention: the shallower the water, the more
 *  saturated the blue; deep water fades to clean paper white. This
 *  replaced the earlier "whiter = deeper" warm ramp — matching every
 *  chart a sailor has ever read beats a house style. `drying` keeps its
 *  distinct sand-khaki step (dries-vs-water separation in glare, audit
 *  U4) — that part of the old design survives on merit. */
export const DEPARE_BAND_COLORS = {
    drying: '#c6c295',
    b0to2: '#8bbcdd',
    b2to5: '#a6cce6',
    b5to10: '#c0dcee',
    b10to20: '#d8e9f5',
    b20to50: '#ecf4fa',
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
 *  ROUND 2 — the on-device review this asked for came back NEGATIVE (Shane,
 *  2026-07-18, Moreton Bay over hybrid imagery). Round 1 shipped the three
 *  sub-safe bands as #ecd39a / #f4e3bb against a #f7f5f0 safe white: three
 *  pale warm near-whites a few percent apart in luminance, alpha-composited
 *  at 0.4-0.5 onto photographic water. The verdict was computed correctly and
 *  then encoded in a channel the eye cannot resolve on a phone in daylight —
 *  "will ground you" and "sail here" read as one wash, which is worse than
 *  the binary look it replaced because it looks informative.
 *
 *  The defect was HUE, not alpha, so the fix is hue: white now means GO and
 *  nothing else. Sub-safe water moves into the saturated amber of the #f97316
 *  safety contour, where it reads as a warning at a glance and cannot be
 *  confused with paper. This also matches the S-52 convention the eye already
 *  expects — depth areas lighten as they deepen — so darker-warm reads as
 *  "shallow" without training.
 *
 *  Alpha does NOT carry the warning and must not be used to: the opacity ramp
 *  rises monotonically with depth on purpose (asserted by encDepthStyle.test),
 *  because shallow water is precisely where the imagery should read through and
 *  show the real sand bank, while deep water is where thick paper-white is safe
 *  to lay down. So shallow keeps the LOWEST alpha and gets its urgency from
 *  chroma instead — a saturated amber at 0.30 reads as a warning far more
 *  loudly than round 1's pale cream at 0.40 did.
 *
 *  It stays ABOVE 0 though: opacity 0 is what made a known shoal pixel-
 *  identical to uncharted no-data, the bug round 1 fixed. Do not "fix" this by
 *  reverting to 0. */
export const SHALLOW_CAUTION_COLOR = '#d9822b';
const SHALLOW_CAUTION_OPACITY = 0.3;
/** Router-hazard CAUTION band [S, hazard): water that clears the S-52 safety
 *  depth (draft + UKC) but is shallower than the ROUTER's draft×1.5 + UKC
 *  grounding threshold — margin-thin (cycle-5 re-audit: the glaze painted this
 *  band GO-white while the router flagged it as a hazard, a mixed signal at the
 *  helm). Round 2: a LIGHT amber — still unmistakably warm (not paper), but
 *  visibly weaker than the [0,S) amber, so the three-step read is
 *  amber → light amber → white as the water deepens. DEVICE-VISUAL, tunable;
 *  omit the hazard arg (or set opacity 0) to restore the two-band look. */
export const CAUTION_BAND_COLOR = '#f0c26a';
const CAUTION_BAND_OPACITY = 0.36;

export function buildDepareSatelliteOpacity(safetyDepthM: number, hazardDepthM?: number): ExpressionSpecification {
    const s = Math.max(safetyDepthM, 0.1);
    // Router-hazard caution band [s, h): present only when a valid deeper hazard
    // depth is supplied; otherwise h === s and every stop below is byte-
    // identical to the pre-caution expression (graceful degrade for one-arg
    // callers + the pathological deep-draft case where hazard clamps below s).
    const h = hazardDepthM != null && hazardDepthM > s ? hazardDepthM : s;
    const hasCaution = h > s;
    return mapExpr([
        'case',
        attrValid(DRVAL1_ATTR),
        [
            'step',
            DRVAL1_ATTR,
            0.55, // drying — a real warning even over imagery
            0,
            SHALLOW_CAUTION_OPACITY, // charted-shallow — distinct caution wash (was 0 = identical to uncharted)
            ...(hasCaution ? [s, CAUTION_BAND_OPACITY] : []), // [s,h) router-hazard caution
            h,
            0.62, // enough water — bright paper, sail here (white begins at the HAZARD depth, not s)
            Math.max(h + 0.01, 20),
            0.68,
            Math.max(h + 0.02, 50),
            0.72, // open water — mostly paper
        ],
        0,
    ]);
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
export function buildDepareGlazeFillColor(safetyDepthM: number, hazardDepthM?: number): ExpressionSpecification {
    const s = Math.max(safetyDepthM, 0.1);
    const h = hazardDepthM != null && hazardDepthM > s ? hazardDepthM : s;
    const hasCaution = h > s;
    return mapExpr([
        'case',
        attrValid(DRVAL1_ATTR),
        // drying khaki < 0 ≤ shallow-caution amber < s ≤ router-caution straw
        // < h ≤ safe white. Same 0/s boundaries as buildDepareSatelliteOpacity
        // (the PAIRING INVARIANT); white now begins at the router HAZARD depth h.
        [
            'step',
            DRVAL1_ATTR,
            DEPARE_BAND_COLORS.drying,
            0,
            SHALLOW_CAUTION_COLOR,
            ...(hasCaution ? [s, CAUTION_BAND_COLOR] : []),
            h,
            '#f7f5f0',
        ],
        '#f7f5f0', // unknown DRVAL1 is opacity-0 anyway; colour never shows
    ]);
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
    return mapExpr([
        'case',
        ['<', ['abs', v], 10],
        [
            'concat',
            ['to-string', whole],
            // INT1: DRYING soundings are UNDERLINED — the khaki ink was the
            // only 'dries' channel (audit). Combining low line U+0332 under
            // the whole-metre digit; drying heights are single-digit.
            ['case', ['<', v, 0], '\u0332', ''],
            ['case', ['==', tenth, 0], '', ['at', tenth, ['literal', SUBSCRIPT_DIGITS]]],
        ],
        // ≥10 m: FLOOR, not round (audit: 10.9 printed "11" — deeper than
        // charted). Truncation is the shallow-biased, safe direction; the
        // rare ≥10 m drying height keeps round (floor would overstate it in
        // the other sign).
        ['to-string', ['case', ['>=', v, 0], ['floor', v], ['round', v]]],
    ]);
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
        return mapExpr(['case', ['<', ['get', '_d'], 0], '#6b5e23', ['<', ['get', '_d'], 5], '#0b1116', '#26333d']);
    }
    const v = ['+', ['get', '_d'], tideOffsetM];
    return mapExpr(['case', ['<', v, 0], '#6b5e23', ['<', v, 5], '#0b4f58', '#2a6b77']);
}

/** Contour label text — shifts with the tide offset so the screen never
 *  mixes datums. Unknown VALDCO renders NO label — the old bare
 *  to-number turned a lowercase-attributed cell into contours all
 *  labelled "0" (a wrong depth number on the chart, hard rule 2). */
export function buildDepcntLabelField(tideOffsetM = 0): ExpressionSpecification {
    const v = tideOffsetM === 0 ? VALDCO_ATTR : ['+', VALDCO_ATTR, tideOffsetM];
    // Non-integer VALDCO keeps one decimal (audit: rounding printed a WRONG
    // depth on the line — a 3.6 m contour labelled "4"). Integer values
    // stay clean whole numbers.
    const tenths = ['round', ['*', v, 10]];
    const isWhole = ['==', ['%', tenths, 10], 0];
    const oneDp = ['concat', ['to-string', ['floor', ['/', tenths, 10]]], '.', ['to-string', ['%', tenths, 10]]];
    return mapExpr(['case', attrValid(VALDCO_ATTR), ['case', isWhole, ['to-string', ['round', v]], oneDp], '']);
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
        const v = Number(readS57(props, 'VALDCO'));
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
