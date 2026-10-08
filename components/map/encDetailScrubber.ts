/**
 * encDetailScrubber — the chart-declutter slider's map-side engine
 * (Shane 2026-07-14: "a scrubber along the bottom that removes certain
 * detail. hard right is very little detail, hard left is full detail").
 *
 * One knob, 0 (full chart) → 6 (minimal), two mechanisms:
 *
 *  1. CUMULATIVE FURNITURE CUTS — visibility per layer group, ordered
 *     from decorative to load-bearing: derived contours first, then
 *     badges and minor labels, islet dots, names, plain contours and
 *     leads, and the aids to navigation only at the very end.
 *  2. A SCAMIN BIAS on the density-laddered layers (soundings + the
 *     two name layers): each step subtracts ~0.9 "virtual zoom", so
 *     the sounding field THINS smoothly the way zooming out would,
 *     instead of blinking off.
 *
 * THE TIERS FOLLOW IHO S-52 DISPLAY CATEGORIES (build 123, W1-01). S-52 is
 * the presentation standard every ECDIS draws to, worldwide. It puts the
 * aids to navigation (buoys, beacons, lights, and the sectors a light
 * carries) in "Standard display", the picture an ECDIS shows when a chart
 * first comes up; only Display Base (coastline, the safety contour,
 * isolated dangers) sits below it. Spot soundings, names and other
 * lettering are "Other". The browsing chart holds a forced floor
 * (BROWSE_DECLUTTER_FLOOR, see MapHub), and until W1-01 that floor cut the
 * light sectors (tier 1) and the special-purpose and safe-water marks
 * (tier 3): a sector light's white, red and green arcs and a fairway buoy
 * never showed on Obs at any zoom. Now every S-52 Standard navaid the chart
 * mounts (S52_STANDARD_NAVAID_LAYERS) sits in the last tier, together, and
 * the floor cannot reach it. What the floor thins is what Shane asked it to
 * (2026-07-22: "too much noise"): sounding density, names, VHF badges,
 * lead and hazard labels, derived contours and islet dots.
 *
 * SAFETY FLOOR — never touched at ANY level: depth bands + glaze,
 * land + coastline, the bold safety contour, the hazard layer (every
 * wreck, rock and obstruction, one layer since 125-04, so the shallowest
 * wins across classes), and the ISOLATED-DANGER marks
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

import { ENC_VEC_LAYERS, S57_NAVAID_CLASSES } from './encLayerIds';
import { SCAMIN_CLAUSE } from './encDepthStyle';

/** Slider maximum — 0 is the full chart, this is the bare one. */
export const DETAIL_SCRUB_MAX = 6;

/**
 * The browsing chart's declutter level (Shane 2026-07-22). The slider is
 * only on the plotting card, so whenever that card is closed the chart
 * draws at exactly this level (browseDetailLevel). It removes tiers 1–3
 * below and nothing else, so it must stay under the navaid tier (asserted
 * in tests/encDetailScrubber.test.ts).
 */
export const BROWSE_DECLUTTER_FLOOR = 3;

/**
 * The level the chart draws at. While plotting (the card with the slider is
 * open) it is exactly what the skipper set. While browsing it is the floor,
 * whatever the slider was left at. The slider is session state that nothing
 * resets, and Obs and the Plan tab share one map, so max(slider, floor)
 * carried a plotting "Clean" (6) back to Obs, which has no slider, and hid
 * every light, sector and buoy there for the rest of the session (W1-01
 * review).
 */
export function browseDetailLevel(plotting: boolean, slider: number): number {
    return plotting ? slider : BROWSE_DECLUTTER_FLOOR;
}

/**
 * The aids to navigation IHO S-52 places in Standard display: every navaid
 * class the chart mounts (S57_NAVAID_CLASSES: lights, lateral, cardinal,
 * safe-water, special-purpose and isolated-danger buoys and beacons) plus
 * the light-sector legs and arcs drawn from LIGHTS. Derived from the class
 * registry, so a navaid class added later is protected without another
 * edit here. None of them is cut below the bare level.
 */
export const S52_STANDARD_NAVAID_LAYERS: readonly string[] = [
    ...S57_NAVAID_CLASSES.map((c) => ENC_VEC_LAYERS[c]),
    ENC_VEC_LAYERS.LIGHTSEC_LEG,
    ENC_VEC_LAYERS.LIGHTSEC_ARC,
];

/** Navaids that belong to the safety floor instead: they point at a hazard. */
const SAFETY_FLOOR_MARKS = new Set<string>([ENC_VEC_LAYERS.BOYISD, ENC_VEC_LAYERS.BCNISD]);

/** Virtual-zoom bias per declutter step (negative = zoomed-out look). */
const BIAS_PER_STEP = -0.9;

/** Cumulative cuts: at declutter level d, groups [0..d-1] are hidden. */
const FURNITURE_CUTS: string[][] = [
    // d ≥ 1 — pure decoration first: contours we interpolated ourselves
    [ENC_VEC_LAYERS.DEPCNT_DERIVED_LINE, ENC_VEC_LAYERS.DEPCNT_DERIVED_LABEL],
    // d ≥ 2 — badges + minor labels
    [ENC_VEC_LAYERS.VHF_BADGE, ENC_VEC_LAYERS.VHF_BADGE_VTS, ENC_VEC_LAYERS.RECTRC_LABEL, ENC_VEC_LAYERS.POINTS_LABEL],
    // d ≥ 3 — islet dots. The special-purpose and safe-water marks that used
    // to share this tier are S-52 Standard navaids and moved to d = 6 (W1-01).
    [ENC_VEC_LAYERS.LNDARE_ISLET],
    // d ≥ 4 — the written word: names, contour + navaid labels
    [
        ENC_VEC_LAYERS.DEPCNT_LABEL,
        ENC_VEC_LAYERS.NAVAIDS_LABEL,
        ENC_VEC_LAYERS.SEAARE_LABEL,
        ENC_VEC_LAYERS.LNDARE_LABEL,
    ],
    // d ≥ 5 — plain contours (the SAFETY contour lives elsewhere) + leads
    [ENC_VEC_LAYERS.DEPCNT_LINE, ENC_VEC_LAYERS.RECTRC],
    // d = 6 — the aids to navigation, all together: lights and their sectors,
    // laterals, cardinals, safe-water and special-purpose marks. The chart is
    // now bands, hazards, the safety line and the isolated-danger marks.
    S52_STANDARD_NAVAID_LAYERS.filter((id) => !SAFETY_FLOOR_MARKS.has(id)),
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
