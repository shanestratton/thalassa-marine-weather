/**
 * encLayerIds — the ENC chart layer's Mapbox source + layer IDs and
 * their canonical z-order, extracted from EncVectorLayer so the popup
 * module can reference layers without a dependency cycle.
 */

import type { S57PointMarkClass } from '../../services/enc/types';
import { ENC_DRAW_TIER_COUNT } from '../../services/enc/scaleShadow';

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
    LIGHTSEC: 'enc-vec-lightsec', // light-sector arcs + limit legs
    DEPCNT_DERIVED: 'enc-vec-depcnt-derived', // contours interpolated from soundings
    SEAARE_LABELS: 'enc-vec-seaare-labels', // one label point per named sea area
    CAUTION_AREAS: 'enc-vec-caution-areas', // restricted/cable/pipeline/seabed/TSS polygons
    FAIRWY: 'enc-vec-fairwy', // marked fairway polygons (drawn as boundary lines)
} as const;

// NOTE: layer-id stability is load-bearing. Click handlers, the
// master-toggle probe (BCNLAT visibility) and the hide lists all
// reference these ids — the lateral/cardinal layers keep their
// legacy '-circle' suffix even though they're symbol layers now.
// Renaming is a separate mechanical commit, never a drive-by.
export const ENC_VEC_LAYERS = {
    /** SCALE-ORDERED AREA FILLS (item f, Shane 2026-10-02: "we should overlay
     *  the charts the other way so the water is drawn over the land"). One
     *  water fill, land fill and coastline line PER SCALE TIER, drawn
     *  coarsest first (ENC_AREA_TIER_GROUPS), so a finer chart's fills cover
     *  a coarser one's: the 1:90,000 chart's water over the 1:3,500,000
     *  overview's land in Cid Harbour, and its islands over the overview's
     *  water. The tier is the router's fineness (scaleShadow encDrawTier,
     *  stamped `_drawTier` by the merge). These three ids are tier 1's:
     *  DEPARE stays the bottom of the chart stack (the imagery anchor and the
     *  tap answer key), LNDARE / COALNE the land and coast popups' keys; the
     *  finer tiers' ids are generated (`enc-vec-depare-t4-fill`, …). The
     *  DEPARE_FINE repaint (2026-07-11, Mooloolah's canals under a 1:90,000
     *  land blob) is retired into this: it was the same fix for harbour-grade
     *  cells only, by bbox size. */
    LNDARE: 'enc-vec-lndare-fill',
    LNDARE_ISLET: 'enc-vec-lndare-islet',
    DEPARE: 'enc-vec-depare-fill',
    /** Depth contours INTERPOLATED from our own spot soundings (honest,
     *  official-data-derived, dashed + faint so they never masquerade as
     *  surveyed DEPCNT lines). Densifies shallow water the way SonarChart
     *  HD does — without community-sonar guesswork. */
    DEPCNT_DERIVED_LINE: 'enc-vec-depcnt-derived-line',
    DEPCNT_DERIVED_LABEL: 'enc-vec-depcnt-derived-label',
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
    /** Caution / info AREAS (RESARE/CBLARE/PIPARE/TSSLPT). A faint
     *  per-class wash + dashed outline (restricted magenta, cable/pipeline
     *  violet, TSS amber). Fill is tappable (read the restriction); the
     *  outline is decoration. SBDARE is deliberately NOT here — see below. */
    CAUTION_AREA_FILL: 'enc-vec-caution-fill',
    CAUTION_AREA_LINE: 'enc-vec-caution-line',
    /** Seabed nature (SBDARE) — a SUBTLE olive wash at anchoring zoom (z13+),
     *  NON-clickable: as a whole-seabed blanket it stole the DEPARE depth
     *  popup and cluttered z11 (audit). The click handler queries this layer
     *  at a DEPARE tap and folds "Seabed: Sand" into the depth popup. */
    SBDARE_FILL: 'enc-vec-sbdare-fill',
    /** TSS lane-direction arrows (⇧ rotated by ORIENT) — a directionless
     *  lane wash told the helmsman nothing about which WAY the lane runs
     *  (audit). Map-aligned so the arrow points the lane's true bearing. */
    TSSLPT_ARROW: 'enc-vec-tsslpt-arrow',
    /** Fairway boundary — dashed marine-blue line, NON-clickable (a tappable
     *  fill would blanket the channel and steal the water tap). */
    FAIRWY_LINE: 'enc-vec-fairwy-line',
    OBSTRN: 'enc-vec-obstrn-circle',
    WRECKS: 'enc-vec-wrecks-circle',
    UWTROC: 'enc-vec-uwtroc-circle',
    BOYLAT: 'enc-vec-boylat-circle',
    BOYCAR: 'enc-vec-boycar-circle',
    BCNLAT: 'enc-vec-bcnlat-circle',
    BCNCAR: 'enc-vec-bcncar-circle',
    BOYSPP: 'enc-vec-boyspp-symbol',
    BCNSPP: 'enc-vec-bcnspp-symbol',
    BOYSAW: 'enc-vec-boysaw-symbol',
    BCNSAW: 'enc-vec-bcnsaw-symbol',
    BOYISD: 'enc-vec-boyisd-symbol',
    BCNISD: 'enc-vec-bcnisd-symbol',
    LIGHTS: 'enc-vec-lights-symbol',
    RECTRC: 'enc-vec-rectrc-line',
    RECTRC_LABEL: 'enc-vec-rectrc-label',
    SOUNDG: 'enc-vec-soundg-label',
    /** Light-sector limit legs (thin dashed) + coloured arcs. Drawn
     *  below the light glyph so the star sits on top of its own sectors. */
    LIGHTSEC_LEG: 'enc-vec-lightsec-leg',
    LIGHTSEC_ARC: 'enc-vec-lightsec-arc',
    NAVAIDS_LABEL: 'enc-vec-navaids-label',
    POINTS_LABEL: 'enc-vec-points-label',
    /** Named-water ink — "Mooloolah River" in the river (Shane
     *  2026-07-13). Marine-blue italic chart lettering, one per name. */
    SEAARE_LABEL: 'enc-vec-seaare-label',
    /** Island / named-land ink — "High Peak Island" on the island
     *  (Shane 2026-07-14). Upright dark-earth lettering; shares the
     *  SEAARE_LABELS source, filtered on _kind === 'land'. */
    LNDARE_LABEL: 'enc-vec-lndare-label',
    /** VHF watch-channel badges dotted along the leads — "((•)) VHF 16",
     *  and "((•)) VHF 12·16" inside the Brisbane VTS area (Shane
     *  2026-07-14: "a little radio symbol with the correct radio
     *  channel punters should be on"). Two layers, split by a `within`
     *  filter on the VTS polygon. */
    VHF_BADGE: 'enc-vec-vhf-badge',
    VHF_BADGE_VTS: 'enc-vec-vhf-badge-vts',
} as const;

/** One scale tier's area layers: its water fill, land fill and coastline. */
export interface EncAreaTierGroup {
    tier: number;
    water: string;
    land: string;
    coast: string;
}

/** The scale-ordered area groups, COARSEST FIRST (= bottom-to-top). Every
 *  area fill and coastline paints in exactly one of them, by its `_drawTier`
 *  (1 … ENC_DRAW_TIER_COUNT). Tier 1 keeps the legacy ids. */
export const ENC_AREA_TIER_GROUPS: readonly EncAreaTierGroup[] = Array.from(
    { length: ENC_DRAW_TIER_COUNT },
    (_, i): EncAreaTierGroup =>
        i === 0
            ? { tier: 1, water: ENC_VEC_LAYERS.DEPARE, land: ENC_VEC_LAYERS.LNDARE, coast: ENC_VEC_LAYERS.COALNE }
            : {
                  tier: i + 1,
                  water: `enc-vec-depare-t${i + 1}-fill`,
                  land: `enc-vec-lndare-t${i + 1}-fill`,
                  coast: `enc-vec-coalne-t${i + 1}-line`,
              },
);
/** The area layers of one draw tier (1 … ENC_DRAW_TIER_COUNT). */
export function encAreaTierGroup(tier: number): EncAreaTierGroup {
    return ENC_AREA_TIER_GROUPS[Math.max(1, Math.min(ENC_DRAW_TIER_COUNT, tier)) - 1];
}
/** Every tier's DEPARE(+DRGARE) water fill — what DEPARE alone used to be. */
export const ENC_WATER_FILL_LAYERS: readonly string[] = ENC_AREA_TIER_GROUPS.map((g) => g.water);
/** Every tier's LNDARE land fill. */
export const ENC_LAND_FILL_LAYERS: readonly string[] = ENC_AREA_TIER_GROUPS.map((g) => g.land);
/** Every tier's COALNE coastline. */
export const ENC_COAST_LINE_LAYERS: readonly string[] = ENC_AREA_TIER_GROUPS.map((g) => g.coast);

const AREA_BASE_ID = new Map<string, string>([
    ...ENC_WATER_FILL_LAYERS.map((id) => [id, ENC_VEC_LAYERS.DEPARE] as [string, string]),
    ...ENC_LAND_FILL_LAYERS.map((id) => [id, ENC_VEC_LAYERS.LNDARE] as [string, string]),
    ...ENC_COAST_LINE_LAYERS.map((id) => [id, ENC_VEC_LAYERS.COALNE] as [string, string]),
]);

/** The layer a tier layer stands for (enc-vec-depare-t5-fill → DEPARE): the
 *  popup, the tap precedence and the depth-popup gate key on the base ids.
 *  Any other id is returned as it is. */
export function encBaseLayerId(id: string): string {
    return AREA_BASE_ID.get(id) ?? id;
}

/** Retired layer ids a live map may still carry (an older bundle on the same
 *  map — dev reloads): the mount removes them so nothing paints off-stack. */
export const RETIRED_ENC_LAYER_IDS: readonly string[] = ['enc-vec-depare-fine-fill'];

// All layer IDs, ordered bottom-to-top for correct stacking. The
// mount is idempotent-additive: each layer is inserted before the
// next HIGHER layer that already exists (see beforeIdFor), so new
// layers slot into a live map in the right place rather than
// appending on top.
export const ALL_LAYER_IDS: readonly string[] = [
    // The scale-ordered area groups, coarsest tier first: tier 1's water at
    // the very bottom (the chart stack's anchor for imagery and weather), the
    // satellite twin directly above it (opacity-0 on the chart), then each
    // tier's land and coastline over its own water, and the next tier's water
    // over all of it.
    ...ENC_AREA_TIER_GROUPS.flatMap((g) =>
        g.tier === 1 ? [g.water, ENC_VEC_LAYERS.DEPARE_GLAZE, g.land, g.coast] : [g.water, g.land, g.coast],
    ),
    // Point islets over every tier's fills: a dot of land is drawn once, and a
    // harbour cell's own islets no longer sit under its own water (they did
    // under the retired DEPARE_FINE repaint).
    ENC_VEC_LAYERS.LNDARE_ISLET,
    // Caution AREAS over the water fills but UNDER contours/soundings/marks,
    // so numbers + navaids always read on top of a restricted/cable wash.
    // SBDARE's subtle fill sits lowest of the three (pure background info).
    ENC_VEC_LAYERS.SBDARE_FILL,
    ENC_VEC_LAYERS.CAUTION_AREA_FILL,
    ENC_VEC_LAYERS.CAUTION_AREA_LINE,
    ENC_VEC_LAYERS.TSSLPT_ARROW,
    ENC_VEC_LAYERS.FAIRWY_LINE,
    // Sounding-derived contours sit UNDER the official DEPCNT trio so a
    // surveyed line always draws over an interpolated one where both exist.
    ENC_VEC_LAYERS.DEPCNT_DERIVED_LINE,
    ENC_VEC_LAYERS.DEPCNT_DERIVED_LABEL,
    // Contours + the bold safety contour sit ABOVE every tier's fills
    // (2026-10-03: the scale-ordered groups replaced the fine repaint).
    // They used to sit just above DEPARE — when the fine-survey twin
    // landed (0eb6cc19) SOUNDG was re-slotted above it but the DEPCNT
    // trio was forgotten, so the 0.95-opacity repaint buried the one
    // keel-aware line on the chart across ALL fine-survey harbour
    // water in default chart mode (2026-07-12 audit, CRITICAL).
    ENC_VEC_LAYERS.DEPCNT_LINE,
    ENC_VEC_LAYERS.DEPCNT_SAFETY,
    ENC_VEC_LAYERS.DEPCNT_LABEL,
    ENC_VEC_LAYERS.SOUNDG, // depth numbers under everything interactive
    ENC_VEC_LAYERS.SEAARE_LABEL, // waterway names over numbers, under marks
    ENC_VEC_LAYERS.LNDARE_LABEL, // island names beside them, same altitude
    ENC_VEC_LAYERS.RECTRC, // leads under the marks that define them
    ENC_VEC_LAYERS.LIGHTSEC_LEG, // sector limit legs under the arcs
    ENC_VEC_LAYERS.LIGHTSEC_ARC, // coloured sector arcs under the light glyph
    ENC_VEC_LAYERS.BOYLAT,
    ENC_VEC_LAYERS.BCNLAT,
    ENC_VEC_LAYERS.BOYCAR,
    ENC_VEC_LAYERS.BCNCAR,
    ENC_VEC_LAYERS.BOYSPP,
    ENC_VEC_LAYERS.BCNSPP,
    ENC_VEC_LAYERS.BOYSAW,
    ENC_VEC_LAYERS.BCNSAW,
    ENC_VEC_LAYERS.BOYISD,
    ENC_VEC_LAYERS.BCNISD,
    // Hazard NAMES sit BELOW the hazard marks (build 123, HM). They share the
    // marks' source, so one collision graph (every chart map collides by
    // source: tests/enc/encMapsCollideBySource.test.ts), and Mapbox places
    // the higher layer first: on top, a wreck's name was placed before the
    // marks and culled the wreck itself and any rock beside it. Here every
    // mark is placed first and a name prints only where it has room.
    ENC_VEC_LAYERS.POINTS_LABEL,
    ENC_VEC_LAYERS.OBSTRN,
    ENC_VEC_LAYERS.WRECKS,
    ENC_VEC_LAYERS.UWTROC,
    ENC_VEC_LAYERS.LIGHTS,
    ENC_VEC_LAYERS.RECTRC_LABEL,
    ENC_VEC_LAYERS.VHF_BADGE, // watch-channel badges ride above the lead labels
    ENC_VEC_LAYERS.VHF_BADGE_VTS,
    ENC_VEC_LAYERS.NAVAIDS_LABEL, // navaid names topmost (their marks never yield: allow-overlap)
];

// S-57 point-mark class taxonomy — the DOMAIN registry lives in
// services/enc/types (so the merge can derive from it WITHOUT a
// services→components import); re-exported here beside the render bindings.
// See that file for the hazard-points ∪ navaids partition.
export {
    S57_POINT_MARK_CLASSES,
    S57_HAZARD_POINT_CLASSES,
    S57_NAVAID_CLASSES,
    S57_BUOY_BEACON_CLASSES,
} from '../../services/enc/types';

// Compile-time render binding: every point-mark class MUST own a layer id
// in ENC_VEC_LAYERS — a registry addition that forgets one fails HERE, in
// lock-step with encClassRegistry.test's runtime coverage guard.
type _EveryMarkClassHasLayer = [S57PointMarkClass] extends [keyof typeof ENC_VEC_LAYERS] ? true : never;
export const S57_MARK_CLASSES_HAVE_LAYERS: _EveryMarkClassHasLayer = true;

// Layers that take click handlers. Excludes the text-only label
// layers — a tap on a label should fall through to the symbol or
// polygon underneath, not open a generic popup. RECTRC is excluded
// too: a thin lead line under a tracer tap must never swallow the
// pin drop with a popup.
export const CLICKABLE_LAYER_IDS = ALL_LAYER_IDS.filter(
    (id) =>
        id !== ENC_VEC_LAYERS.NAVAIDS_LABEL &&
        id !== ENC_VEC_LAYERS.POINTS_LABEL &&
        id !== ENC_VEC_LAYERS.RECTRC &&
        id !== ENC_VEC_LAYERS.RECTRC_LABEL &&
        id !== ENC_VEC_LAYERS.SOUNDG &&
        id !== ENC_VEC_LAYERS.DEPCNT_LABEL &&
        id !== ENC_VEC_LAYERS.DEPCNT_DERIVED_LINE &&
        id !== ENC_VEC_LAYERS.DEPCNT_DERIVED_LABEL &&
        id !== ENC_VEC_LAYERS.LIGHTSEC_LEG && // thin dashed legs stay non-tappable…
        // …but the coloured arc IS tappable (#3a): "am I in the red/white/green?"
        // is the most safety-critical tap-to-read moment; without it a tap on a
        // red sector fell through to the DEPARE water popup.
        id !== ENC_VEC_LAYERS.DEPARE_GLAZE &&
        id !== ENC_VEC_LAYERS.SEAARE_LABEL &&
        id !== ENC_VEC_LAYERS.LNDARE_LABEL &&
        id !== ENC_VEC_LAYERS.VHF_BADGE &&
        id !== ENC_VEC_LAYERS.VHF_BADGE_VTS &&
        // The caution-area FILL is tappable (read "restricted — no anchoring");
        // its outline is decoration, and the SBDARE seabed wash must NEVER
        // steal the DEPARE depth popup (its info folds into that popup instead).
        id !== ENC_VEC_LAYERS.CAUTION_AREA_LINE &&
        id !== ENC_VEC_LAYERS.SBDARE_FILL &&
        id !== ENC_VEC_LAYERS.TSSLPT_ARROW &&
        id !== ENC_VEC_LAYERS.FAIRWY_LINE,
);
