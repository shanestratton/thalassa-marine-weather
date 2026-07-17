/**
 * encDetailScrubber — the chart-declutter slider's map-side engine
 * (Shane 2026-07-14: "a scrubber along the bottom that removes certain
 * detail. hard right is very little detail, hard left is full detail").
 *
 * One knob, 0 (full chart) → 6 (minimal), two mechanisms:
 *
 *  1. CUMULATIVE FURNITURE CUTS — visibility per layer group, ordered
 *     from decorative to load-bearing: derived contours and light
 *     sectors go first, names and plain contours in the middle, marks
 *     and lights only at the very end.
 *  2. A SCAMIN BIAS on the density-laddered layers (soundings + the
 *     two name layers): each step subtracts ~0.9 "virtual zoom", so
 *     the sounding field THINS smoothly the way zooming out would,
 *     instead of blinking off.
 *
 * SAFETY FLOOR — never touched at ANY level: depth bands + glaze,
 * land + coastline, the bold safety contour, every hazard layer
 * (OBSTRN / WRECKS / UWTROC), and the ISOLATED-DANGER marks
 * (BOYISD / BCNISD) that point AT those hazards — a BRB danger pointer
 * is danger indication, not furniture, so it outranks the laterals and
 * must never be cut (closing audit 2026-07-18: it was dropped at d ≥ 3
 * while laterals survived to d = 6, three notches too soon). The
 * scrubber removes furniture, never danger.
 *
 * Writes are conditional (read → compare → write) so the styledata
 * re-assert loop stays dead at steady state, same discipline as the
 * satellite/terrain apply pass. Ownership: only the furniture layers
 * listed here — the layers other systems own (satellite hide-list,
 * ENC master toggle, chart-detail mode) are deliberately absent.
 */
import type mapboxgl from 'mapbox-gl';

import { ENC_VEC_LAYERS } from './encLayerIds';
import { SCAMIN_CLAUSE } from './encDepthStyle';

/** Slider maximum — 0 is the full chart, this is the bare one. */
export const DETAIL_SCRUB_MAX = 6;

/** Virtual-zoom bias per declutter step (negative = zoomed-out look). */
const BIAS_PER_STEP = -0.9;

/** Cumulative cuts: at declutter level d, groups [0..d-1] are hidden. */
const FURNITURE_CUTS: string[][] = [
    // d ≥ 1 — pure decoration first
    [
        ENC_VEC_LAYERS.DEPCNT_DERIVED_LINE,
        ENC_VEC_LAYERS.DEPCNT_DERIVED_LABEL,
        ENC_VEC_LAYERS.LIGHTSEC_LEG,
        ENC_VEC_LAYERS.LIGHTSEC_ARC,
    ],
    // d ≥ 2 — badges + minor labels
    [ENC_VEC_LAYERS.VHF_BADGE, ENC_VEC_LAYERS.VHF_BADGE_VTS, ENC_VEC_LAYERS.RECTRC_LABEL, ENC_VEC_LAYERS.POINTS_LABEL],
    // d ≥ 3 — special-purpose / safe-water minors + islet dots. Isolated-danger
    // marks (BOYISD/BCNISD) are DELIBERATELY absent: they point at a charted
    // hazard, so they belong to the safety floor, never a declutter tier.
    [
        ENC_VEC_LAYERS.BOYSPP,
        ENC_VEC_LAYERS.BCNSPP,
        ENC_VEC_LAYERS.BOYSAW,
        ENC_VEC_LAYERS.BCNSAW,
        ENC_VEC_LAYERS.LNDARE_ISLET,
    ],
    // d ≥ 4 — the written word: names, contour + navaid labels
    [
        ENC_VEC_LAYERS.DEPCNT_LABEL,
        ENC_VEC_LAYERS.NAVAIDS_LABEL,
        ENC_VEC_LAYERS.SEAARE_LABEL,
        ENC_VEC_LAYERS.LNDARE_LABEL,
    ],
    // d ≥ 5 — plain contours (the SAFETY contour lives elsewhere) + leads
    [ENC_VEC_LAYERS.DEPCNT_LINE, ENC_VEC_LAYERS.RECTRC],
    // d = 6 — the marks themselves; the chart is now bands, hazards, safety line
    [ENC_VEC_LAYERS.BOYLAT, ENC_VEC_LAYERS.BCNLAT, ENC_VEC_LAYERS.BOYCAR, ENC_VEC_LAYERS.BCNCAR, ENC_VEC_LAYERS.LIGHTS],
];

/** Layers with ANOTHER owner (setEncChartDetail hides DEPCNT_LINE/LABEL
 *  on the clean-chart toggle). The scrubber may HIDE them at high
 *  declutter but must never RESTORE them — force-showing here would
 *  fight the owner's 'none' and leave the wrong state standing. The
 *  owner re-shows them itself on every effect pass when it wants them. */
const HIDE_ONLY = new Set<string>([ENC_VEC_LAYERS.DEPCNT_LINE, ENC_VEC_LAYERS.DEPCNT_LABEL]);

const scaminWithBias = (bias: number): unknown =>
    bias === 0
        ? SCAMIN_CLAUSE
        : ['any', ['!', ['has', '_minZoom']], ['>=', ['+', ['zoom'], bias], ['get', '_minZoom']]];

/** The three density-laddered layers and their level-biased filters. */
const biasedFilters = (bias: number): Array<[string, unknown]> => [
    [ENC_VEC_LAYERS.SOUNDG, scaminWithBias(bias)],
    [ENC_VEC_LAYERS.SEAARE_LABEL, ['all', ['!=', ['get', '_kind'], 'land'], scaminWithBias(bias)]],
    [ENC_VEC_LAYERS.LNDARE_LABEL, ['all', ['==', ['get', '_kind'], 'land'], scaminWithBias(bias)]],
];

/** The level last applied — the other visibility writers consult this
 *  via isScrubHidden() so they never force-show scrubbed furniture.
 *  Without it, every merge/effect pass re-showed the cut layers and the
 *  scrubber re-hid them 120 ms later — "the lead lines start to flash"
 *  (Shane 2026-07-15) at any declutter ≥ 5. Module-level: one chart map
 *  per session, same convention as the refresh generation token. */
let activeDeclutter = 0;

/** Is this layer currently removed by the detail scrubber? Checked by
 *  setEncVectorVisibility / setEncChartDetail before force-showing. */
export function isScrubHidden(layerId: string): boolean {
    if (activeDeclutter <= 0) return false;
    for (let i = 0; i < Math.min(activeDeclutter, FURNITURE_CUTS.length); i++) {
        if (FURNITURE_CUTS[i].includes(layerId)) return true;
    }
    return false;
}

/**
 * Ownership options for the RESTORE side. The scrubber shares its
 * furniture with two other authorities that hide layers with a stronger
 * claim; force-showing what they hid creates a two-writer styledata loop
 * that never converges (audit 2026-07-15, rank 8):
 *
 *  - `encMasterOff` — the ENC master FAB hid the WHOLE vector stack. The
 *    scrubber must not resurrect any furniture; the master re-shows it
 *    itself when toggled back on.
 *  - `imageryHidden` — the satellite/hybrid hide-list hides opaque land
 *    fills (LNDARE_ISLET) that would blanket the imagery. With Hybrid the
 *    DEFAULT base, this fought applyChartDetailLevel's LNDARE_ISLET
 *    restore on EVERY apply pass — an ~8 Hz background loop with zero
 *    user action. The imagery owner wins; the scrubber only ever hides
 *    LNDARE_ISLET further (at d ≥ 3), never restores it while imagery is on.
 */
export interface ChartDetailOwnership {
    encMasterOff?: boolean;
    imageryHidden?: ReadonlySet<string>;
}

/**
 * Apply a declutter level (0 = full … DETAIL_SCRUB_MAX = minimal).
 * Self-healing and steady-state silent: every write is guarded by a
 * read, so re-running after a styledata burst costs reads only unless
 * a remounted layer actually reset something. Returns true when any
 * style mutation happened.
 */
export function applyChartDetailLevel(
    map: mapboxgl.Map,
    declutter: number,
    ownership: ChartDetailOwnership = {},
): boolean {
    const d = Math.max(0, Math.min(DETAIL_SCRUB_MAX, Math.round(declutter)));
    activeDeclutter = d;
    let changed = false;
    try {
        FURNITURE_CUTS.forEach((group, i) => {
            const target = d >= i + 1 ? 'none' : 'visible';
            for (const id of group) {
                if (!map.getLayer(id)) continue;
                if (target === 'visible') {
                    // RESTORE side — yield to the stronger owners so the
                    // two-writer loop can't form (see ChartDetailOwnership).
                    if (HIDE_ONLY.has(id)) continue;
                    if (ownership.encMasterOff) continue;
                    if (ownership.imageryHidden?.has(id)) continue;
                }
                const cur = (map.getLayoutProperty(id, 'visibility') as string | undefined) ?? 'visible';
                if (cur !== target) {
                    map.setLayoutProperty(id, 'visibility', target);
                    changed = true;
                }
            }
        });
        for (const [id, filter] of biasedFilters(d * BIAS_PER_STEP)) {
            if (!map.getLayer(id)) continue;
            // Filters have no cheap identity — compare serialised forms so
            // steady state stays write-free (and a remounted layer's reset
            // filter self-heals on the next pass).
            const want = JSON.stringify(filter);
            if (JSON.stringify(map.getFilter(id) ?? null) !== want) {
                map.setFilter(id, filter as mapboxgl.FilterSpecification);
                changed = true;
            }
        }
    } catch {
        /* style mid-swap — the next styledata pass re-applies */
    }
    return changed;
}
