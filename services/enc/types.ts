/**
 * ENC Integration — shared types.
 *
 * See docs/ENC_INTEGRATION.md for the architecture.
 *
 * S-57 ENC cells (.000 files from hydrographic offices) are converted
 * server-side (on the user's Pi) to GeoJSON, then loaded on the device
 * and queried via a spatial index.
 *
 * These types describe:
 *  - The hazard records we extract from each S-57 layer
 *  - The cell metadata we persist (one record per imported cell)
 *  - The shape of a hazard query result
 *  - The RBush spatial-index entry format
 */

import type { Geometry } from 'geojson';

// ── S-57 source layers we care about ───────────────────────────────

/**
 * Subset of S-57 layers we extract for routing.
 *
 * Hazard layers (drive routing detours):
 * - DEPARE: depth area polygons (the gold for hazard checks)
 * - LNDARE: land area polygons (always hazard)
 * - OBSTRN: general obstructions
 * - WRECKS: wrecks
 * - UWTROC: underwater rocks
 *
 * Soft / info layers (rendered + reported, never reroute):
 * - COALNE: coastline lines, used for proximity warnings
 * - LIGHTS: lights / lighthouses (display only)
 * - BOYLAT: lateral buoys (display only)
 * - BOYCAR: cardinal buoys (display only)
 * - M_QUAL: zones of confidence (CATZOC). Tagged on every result.
 */
export type EncLayer =
    | 'DEPARE'
    | 'DRGARE'
    | 'LNDARE'
    | 'OBSTRN'
    | 'WRECKS'
    | 'UWTROC'
    | 'COALNE'
    | 'SOUNDG'
    // Man-made allision structures (cycle-5 audit #3): shoreline construction
    // (training walls / breakwaters / groynes), dams, and piles.
    | 'SLCONS'
    | 'DAMCON'
    | 'PILPNT';

// ── S-57 point-mark class taxonomy ─────────────────────────────────
// The DOMAIN source of truth for which buoy/beacon/light/hazard classes
// exist and how they group. Lives here (services, low-level) so the merge
// (EncHazardService) and the render layer (encLayerIds/EncVectorLayer) can
// both derive from it WITHOUT a services→components import. encLayerIds
// binds these to render layer-ids; the merge's tagAndPush + the mount's
// point/navaid sources iterate them, so a class added here can't silently
// no-op (mission-audit: the registry previously only half-bound). Every
// element is also a key of EncMergedVectorData and of EncConversionResult
// .layers (enforced where they're indexed).

/** Hazard points → the merged POINTS source (magenta symbols). */
export const S57_HAZARD_POINT_CLASSES = ['OBSTRN', 'WRECKS', 'UWTROC'] as const;

/** Man-made allision structures (cycle-5 audit #3) — ONE list consumed by the
 *  parser WATLEV gate and the proximity report so a new class can't drift
 *  between them. classifyHazard/segmentAreaGraze switch on these too and carry
 *  a fail-safe default arm (an unenumerated hazard layer → obstruction). */
export const S57_STRUCTURE_CLASSES = ['SLCONS', 'DAMCON', 'PILPNT'] as const;
export function isStructureClass(layer: string): boolean {
    return (S57_STRUCTURE_CLASSES as readonly string[]).includes(layer);
}

/** Lights + buoys/beacons → the merged NAVAIDS source (each _kind-tagged). */
export const S57_NAVAID_CLASSES = [
    'LIGHTS',
    'BOYLAT',
    'BOYCAR',
    'BCNLAT',
    'BCNCAR',
    'BOYSPP',
    'BCNSPP',
    'BOYSAW',
    'BCNSAW',
    'BOYISD',
    'BCNISD',
] as const;

/** Buoy/beacon navaids that mount as IALA symbol layers — the navaids
 *  minus LIGHTS (its own lighthouse layer). */
export const S57_BUOY_BEACON_CLASSES = [
    'BOYLAT',
    'BCNLAT',
    'BOYCAR',
    'BCNCAR',
    'BOYSPP',
    'BCNSPP',
    'BOYSAW',
    'BCNSAW',
    'BOYISD',
    'BCNISD',
] as const;

/** Every S-57 point-mark class — the PARTITION of hazard-points ∪ navaids,
 *  so it can never drift from its subgroups (it IS their union). */
export const S57_POINT_MARK_CLASSES = [...S57_HAZARD_POINT_CLASSES, ...S57_NAVAID_CLASSES] as const;

export type S57PointMarkClass = (typeof S57_POINT_MARK_CLASSES)[number];

/**
 * Aids-to-navigation layers. Display-only — never affect routing,
 * never appear in the hazard report. Carried separately from
 * EncLayer because the hazard pipeline iterates EncLayer and we
 * don't want navaids walked into hazard processing.
 *
 * BOYLAT/BOYCAR are floating buoys; BCNLAT/BCNCAR are the
 * equivalent rigid beacons (poles, towers). Same colour logic per
 * IALA region; different physical structure on the chart.
 * BOYSPP/BCNSPP are special-purpose marks (yellow X topmark).
 * BOYSAW/BCNSAW are safe-water (fairway/landfall, RW stripes);
 * BOYISD/BCNISD are isolated-danger (BRB, two black balls) — two of
 * the five IALA families that were simply missing from the chart
 * until the 2026-07-12 audit (the RW buoy off a harbour entrance
 * rendered as blank water).
 */
// DERIVED from S57_NAVAID_CLASSES (not hand-mirrored) so the type can never
// drift from the runtime list — add a class in one place and both update
// (audit: EncNavaidLayer was a hand-maintained parallel union).
export type EncNavaidLayer = (typeof S57_NAVAID_CLASSES)[number];

/**
 * IALA buoyage region. Lateral mark colour conventions are
 * mirrored between the two regions: in IALA-A port-hand is red
 * and starboard-hand is green; in IALA-B the colours are
 * reversed (port-hand green, starboard-hand red). Cell IDs from
 * an IALA-B HO ship features that ALREADY follow IALA-B
 * convention — we have to render them with the swapped colours
 * so the user sees the same red/green they'd see physically.
 */
export type IalaRegion = 'A' | 'B';

/**
 * Map a 2-letter ENC source HO prefix (the first two characters
 * of the cell ID, e.g. "AU" / "US" / "JP") to the IALA region
 * that office's waters belong to.
 *
 * Source: IHO P-44 (IALA Maritime Buoyage System status). The
 * universe of "Region B" countries is small and well-defined:
 * the Americas, Japan, Korea, the Philippines.
 *
 * Default IALA-A — covers ~85% of the world's waters. Returning
 * a sane default when we don't recognise a prefix means a
 * mis-classified cell renders the wrong colours; that's acceptable
 * vs erroring out, and sailors notice colour mismatches with their
 * physical chart instantly.
 */
const IALA_B_PREFIXES: ReadonlySet<string> = new Set([
    'US', // United States (NOAA)
    'CA', // Canada (CHS)
    'MX', // Mexico
    'BR', // Brazil
    'AR', // Argentina
    'CL', // Chile
    'CO', // Colombia
    'EC', // Ecuador
    'PE', // Peru
    'UY', // Uruguay
    'VE', // Venezuela
    'JP', // Japan
    'KR', // South Korea
    'PH', // Philippines
    'PA', // Panama
    'CR', // Costa Rica
    'NI', // Nicaragua
    'CU', // Cuba
    'DO', // Dominican Republic
    'HT', // Haiti
    'JM', // Jamaica
    'TT', // Trinidad & Tobago
    'BS', // Bahamas
    'BB', // Barbados
    // Closing audit: known Region-B HOs the set omitted.
    'TW', // Taiwan
    'GT', // Guatemala
    'HN', // Honduras
    'SV', // El Salvador
    'BZ', // Belize
    'GY', // Guyana
    'SR', // Suriname
    'AG', // Antigua & Barbuda
    'DM', // Dominica
    'GD', // Grenada
    'KN', // St Kitts & Nevis
    'LC', // St Lucia
    'VC', // St Vincent & the Grenadines
    'PR', // Puerto Rico (NOAA-charted, US scheme)
    'VI', // US Virgin Islands
]);

export function ialaRegionForSourceHO(sourceHO: string | undefined): IalaRegion {
    // HO codes are EXACTLY two letters. Prefix-matching longer strings
    // is how 'cloud' (the desktop builder's registry placeholder) became
    // 'CL' = Chile = IALA B — and every red/green in Mooloolaba swapped
    // (Shane 2026-07-09: "VQG under the Red and QR under the Green").
    // Unknown/sentinel sources default to region A.
    if (!sourceHO || sourceHO.length !== 2) return 'A';
    return IALA_B_PREFIXES.has(sourceHO.toUpperCase()) ? 'B' : 'A';
}

/**
 * Resolve the display colour of a lateral mark given its CATLAM
 * code and the IALA region of the source cell. Encapsulates the
 * region inversion in one place so the renderer doesn't have to
 * carry case expressions.
 *
 * CATLAM (IHO S-57 — the value NAMES the preferred channel side, which is
 * the OPPOSITE of the hand the mark renders as):
 *   1 = port-hand
 *   2 = starboard-hand
 *   3 = preferred channel to STARBOARD — a modified PORT mark, so it renders
 *       port-side (red in region A); c===3 → the prefchan-STBD glyph below.
 *   4 = preferred channel to PORT — a modified STARBOARD mark, renders
 *       starboard-side (green in region A); c===4 → the prefchan-PORT glyph.
 *
 * Returns hex colour strings matched to the existing palette.
 */
export function lateralMarkColour(catlam: number | null | undefined, region: IalaRegion): string {
    const RED = '#dc2626';
    const GREEN = '#16a34a';
    const YELLOW = '#facc15'; // unspecified / special purpose
    if (catlam == null) return YELLOW;
    const c = Math.round(catlam);
    const isPortHand = c === 1 || c === 3;
    const isStbdHand = c === 2 || c === 4;
    if (isPortHand) return region === 'A' ? RED : GREEN;
    if (isStbdHand) return region === 'A' ? GREEN : RED;
    return YELLOW;
}

/**
 * Resolve the IALA seamark icon ID (registered by
 * components/map/seamarkIcons.ts) for a navaid feature. Lives here —
 * not in seamarkIcons.ts — so the merge-time decoration in
 * EncHazardService can pre-bake `_icon` without dragging mapbox-gl
 * into the service layer.
 *
 * Laterals: CATLAM 1/3 = port-hand, 2/4 = starboard-hand, with the
 * IALA-B colour inversion mirrored from `lateralMarkColour`. Buoys
 * get the can/cone hull glyphs; beacons get the triangle-on-a-stick.
 * Cardinals: CATCAM 1=N 2=E 3=S 4=W. Quadrant identity beats
 * structure fidelity, so cardinal beacons reuse the banded buoy
 * glyphs (the bands + double-cone topmark ARE the information).
 * Specials: yellow X buoy / yellow beacon.
 */
/** Case-defensive S-57 property read (2026-07-17 audit: `props.KEY ??
 *  props.key` was hand-repeated at ~50 display sites — one typo'd pair
 *  reads undefined and silently drops a chart attribute). ogr2ogr cells
 *  carry lowercase names; extractor cells carry uppercase. */
export function readS57(props: Record<string, unknown> | null | undefined, key: string): unknown {
    if (!props) return undefined;
    return props[key] ?? props[key.toLowerCase()];
}

export function encNavaidIconId(
    kind: Exclude<EncNavaidLayer, 'LIGHTS'>,
    props: Record<string, unknown> | null | undefined,
    region: IalaRegion,
): string {
    const p = props ?? {};
    if (kind === 'BOYLAT' || kind === 'BCNLAT') {
        const raw = readS57(p, 'CATLAM');
        const c = Math.round(Number(raw));
        const isBeacon = kind === 'BCNLAT';
        // Preferred-channel marks (3/4) get their BANDED hull on buoys —
        // the band is the "junction here" read (audit). Beacons fall back
        // to the hand-shape treatment below (band SVG is buoy-hulled).
        if (c === 3) {
            if (isBeacon) return region === 'A' ? 'sm-beacon-prefchan-stbd' : 'sm-beacon-prefchan-stbd-b';
            return region === 'A' ? 'sm-buoy-prefchan-stbd' : 'sm-buoy-prefchan-stbd-b';
        }
        if (c === 4) {
            if (isBeacon) return region === 'A' ? 'sm-beacon-prefchan-port' : 'sm-beacon-prefchan-port-b';
            return region === 'A' ? 'sm-buoy-prefchan-port' : 'sm-buoy-prefchan-port-b';
        }
        const isPortHand = c === 1 || c === 3;
        const isStbdHand = c === 2 || c === 4;
        if (isPortHand) {
            // Port-hand beacons carry the CAN (square) topmark — the
            // shape channel must disambiguate the hand for colour-blind
            // eyes; a triangle both sides contradicted the colours
            // (2026-07-12 audit).
            if (isBeacon) return region === 'A' ? 'sm-beacon-can-red' : 'sm-beacon-can-green';
            return region === 'A' ? 'sm-buoy-port' : 'sm-buoy-port-b';
        }
        if (isStbdHand) {
            if (isBeacon) return region === 'A' ? 'sm-beacon-green' : 'sm-beacon-red';
            return region === 'A' ? 'sm-buoy-starboard' : 'sm-buoy-starboard-b';
        }
        // Unknown CATLAM (audit #8): assert presence, not a hand — the old
        // defaults painted a port-hand can / yellow beacon the data never said.
        return 'sm-mark-unknown';
    }
    if (kind === 'BOYCAR' || kind === 'BCNCAR') {
        const raw = readS57(p, 'CATCAM');
        const c = Math.round(Number(raw));
        if (c === 1) return 'sm-cardinal-north';
        if (c === 2) return 'sm-cardinal-east';
        if (c === 3) return 'sm-cardinal-south';
        if (c === 4) return 'sm-cardinal-west';
        // Unknown CATCAM (audit #8): a NORTH glyph told the helmsman "pass
        // north" of a mark whose quadrant the data never carried — a south
        // cardinal rendered that way inverts the safe side.
        return 'sm-mark-unknown';
    }
    // Safe-water (RW stripes + red sphere) and isolated-danger (BRB +
    // two black balls) read the same afloat or fixed — glyph identity
    // beats structure fidelity, same call as the cardinals.
    if (kind === 'BOYSAW' || kind === 'BCNSAW') return 'sm-safe-water';
    if (kind === 'BOYISD' || kind === 'BCNISD') return 'sm-isolated-danger';
    // Special-purpose marks.
    return kind === 'BCNSPP' ? 'sm-beacon-yellow' : 'sm-special';
}

// ── Light character decoding (S-57 LITCHR / COLOUR) ───────────────

/**
 * S-57 LITCHR codes → standard chart abbreviations. Shared between
 * the merge-time `_lightLabel` pre-bake (EncHazardService) and the
 * feature popup, so the two never drift.
 */
export const LITCHR_LABELS: Record<string, string> = {
    '1': 'F', // fixed
    '2': 'Fl', // flashing
    '3': 'LFl', // long-flashing
    '4': 'Q', // quick
    '5': 'VQ', // very quick
    '6': 'UQ', // ultra quick
    '7': 'Iso', // isophased
    '8': 'Oc', // occulting
    '9': 'IQ', // interrupted quick
    '10': 'IVQ', // interrupted very quick
    '11': 'IUQ', // interrupted ultra quick
    '12': 'Mo', // morse
    '13': 'FFl', // fixed/flash
    '14': 'FlLFl', // flash/long-flash
    '15': 'OcFl', // occulting/flash
    '16': 'FLFl', // fixed/long-flash
    '17': 'Al.Oc', // alternating occulting
    '18': 'Al.LFl', // alternating long-flash
    '19': 'Al.Fl', // alternating flash
    '20': 'Al.Gr', // alternating group
    '25': 'Q+LFl',
    '26': 'VQ+LFl',
    '27': 'UQ+LFl',
    '28': 'Al',
    '29': 'Al.FFl',
};

/** S-57 COLOUR codes → chart letter for the light-character string. */
const LIGHT_COLOUR_LETTERS: Record<string, string> = {
    '1': 'W',
    '2': 'B',
    '3': 'R',
    '4': 'G',
    '5': 'Bu',
    '6': 'Y',
    '7': 'Gr',
    '9': 'Am',
    '11': 'Or',
    '12': 'Mg',
};

/**
 * S-57 COLOUR codes → display hex for a light flare/star glyph over
 * the day-palette chart. White lights render S-52-style as a
 * halo-backed warm yellow-white (#f0e030) — true #ffffff vanishes
 * over the pale deep-water band.
 */
/** Exported so the Chart Key's light-sector swatch is driven by the SAME hexes
 *  the sector arcs paint. It was hand-typed with the BUOY palette, which is a
 *  different set — notably white, which renders warm (#f0e030) on purpose so it
 *  reads on a pale chart (audit 2026-07-19). */
export const LIGHT_COLOUR_HEX: Record<string, string> = {
    '1': '#f0e030', // white (rendered yellow-white per S-52 day symbology)
    '3': '#ef4444', // red
    '4': '#22c55e', // green
    '5': '#3b82f6', // blue
    '6': '#fde047', // yellow
    '9': '#f59e0b', // amber
    '11': '#fb923c', // orange
};

/**
 * First-code parse of the comma-separated S-57 COLOUR string
 * ('1', '1,4', '2,6,2'…) → display hex. Returns null when unknown
 * so callers can coalesce to the yellow default. NOTE: first-code
 * is an approximation for multi-colour sector lights — keep the raw
 * COLOUR string in popups for verification (COLOUR_LIST in a later
 * extraction pass is the real fix).
 */
export function lightColourHex(colour: unknown): string | null {
    if (colour == null) return null;
    const first = String(colour).split(',')[0]?.trim();
    if (!first) return null;
    return LIGHT_COLOUR_HEX[first] ?? null;
}

function fmtLightNumber(v: unknown): string | null {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Stitch LITCHR / SIGGRP / COLOUR / SIGPER / HEIGHT / VALNMR into a
 * standard chart light-character string, e.g. 'Fl(2)G 5s 12m 8M'.
 * Missing parts are omitted gracefully (live coverage: LITCHR
 * 398/400, SIGPER 324/400). Returns null when there's no character
 * at all — the label layers filter on `_lightLabel` presence.
 */
export function buildLightCharacterLabel(props: Record<string, unknown> | null | undefined): string | null {
    const p = props ?? {};
    const litchrRaw = readS57(p, 'LITCHR');
    if (litchrRaw == null) return null;
    const chr = LITCHR_LABELS[String(litchrRaw).trim()];
    if (!chr) return null;

    const siggrpRaw = readS57(p, 'SIGGRP');
    const siggrp = typeof siggrpRaw === 'string' ? siggrpRaw.trim() : '';
    // '(1)' is the implicit single-flash group — charts omit it.
    const grp = siggrp && siggrp !== '(1)' ? siggrp : '';

    const colourFirst = String(readS57(p, 'COLOUR') ?? '')
        .split(',')[0]
        ?.trim();
    const colLetter = colourFirst ? (LIGHT_COLOUR_LETTERS[colourFirst] ?? '') : '';

    const parts: string[] = [`${chr}${grp}${colLetter}`];
    const sigper = fmtLightNumber(readS57(p, 'SIGPER'));
    if (sigper) parts.push(`${sigper}s`);
    const height = fmtLightNumber(readS57(p, 'HEIGHT'));
    if (height) parts.push(`${height}m`);
    const valnmr = fmtLightNumber(readS57(p, 'VALNMR'));
    if (valnmr) parts.push(`${valnmr}M`);
    return parts.join(' ');
}

/**
 * Layers we ship in the conversion result but treat as info-only.
 * Listed separately so type-checkers don't complain when the
 * hazard pipeline iterates EncLayer.
 */
export type EncInfoLayer = 'M_QUAL';

/**
 * Hazard type after layer normalisation. Used for UI labels and
 * downstream rendering. `coast` is a soft hazard surfaced only by
 * the proximity report — routes are never rerouted around it,
 * just flagged when they pass close.
 */
export type EncHazardType = 'land' | 'shallow' | 'obstruction' | 'wreck' | 'rock' | 'coast';

/**
 * S-57 CATZOC (Categories of Zone of Confidence) values for
 * M_QUAL polygons. Numeric IHO codes — we keep them as numbers
 * because that's what GDAL outputs.
 *
 * 1 = A1 — full systematic survey, ±5 m horizontal, ±0.5 m + 1% depth
 * 2 = A2 — full systematic survey, ±20 m horizontal, ±1.0 m + 2% depth
 * 3 = B  — full systematic survey, ±50 m horizontal, ±1.0 m + 2% depth
 * 4 = C  — partial / less rigorous survey, ±500 m horizontal, ±2.0 m + 5% depth
 * 5 = D  — poor / sparse soundings, worse than C
 * 6 = U  — unassessed — quality of survey not assessed
 *
 * Lower number = higher confidence. CATZOC C/D/U routes warrant a
 * "verify visually" warning to the user. CATZOC U is the danger
 * zone — Pacific atolls and remote shores are often U.
 */
export type EncCatzoc = 1 | 2 | 3 | 4 | 5 | 6;

/** Human-readable letter codes used in IHO publications. */
export const CATZOC_LABELS: Record<EncCatzoc, string> = {
    1: 'A1',
    2: 'A2',
    3: 'B',
    4: 'C',
    5: 'D',
    6: 'U',
};

/**
 * True if a route passing through `c` should surface a "verify
 * visually" warning. C/D/U zones have positional uncertainty of
 * 500 m or worse — small islets/reefs may be off-chart.
 */
export function isLowConfidenceCatzoc(c: EncCatzoc | null | undefined): boolean {
    if (c == null) return true; // No M_QUAL data → assume worst.
    return c >= 4;
}

// ── Hazard geometry ────────────────────────────────────────────────

/**
 * A single hazard extracted from one ENC layer.
 *
 * - For DEPARE we keep DRVAL1 (the minimum depth in the polygon).
 *   A polygon with DRVAL1 < HAZARD_DEPTH_M is treated as hazardous.
 * - For LNDARE the polygon is always a hazard regardless of depth.
 * - For OBSTRN/WRECKS we keep VALSOU when the obstruction has a
 *   sounding; nullish VALSOU is treated as "always hazard."
 * - For UWTROC we always treat the point as hazard (rocks don't go
 *   away).
 *
 * `geometry` is GeoJSON (`Polygon`, `MultiPolygon`, `Point`, or
 * `LineString` — the latter is unused in Phase 1 but reserved for
 * COALNE in Phase 2).
 */
export interface EncHazard {
    layer: EncLayer;
    geometry: Geometry;
    /**
     * Minimum depth in metres. Sourced from DEPARE.DRVAL1 or
     * OBSTRN/WRECKS.VALSOU. `null` means depth is unknown — caller
     * must treat as hazard regardless of vessel draft.
     *
     * NOTE: S-57 uses positive depths below sea level. We keep the
     * S-57 convention here (positive = depth) and convert at the
     * comparison point. (GEBCO uses negative for depth — opposite!)
     */
    minDepthM: number | null;
    /** Human-readable descriptor for UI/debug logs. */
    description?: string;
}

// ── Cell metadata (persisted to localStorage) ──────────────────────

/**
 * One imported ENC cell.
 *
 * The cell ID is the S-57 dataset name (e.g. "AU530150" for an
 * Australian cell). Edition + source HO let us de-duplicate when a
 * user re-imports an updated cell.
 */
export interface EncCell {
    /** S-57 dataset name (DSID/DSNM). */
    id: string;
    /** Source hydrographic office (AHO, NOAA, UKHO, NZ, etc.). */
    sourceHO: string;
    /** Edition number from S-57 DSID. */
    edition: number;
    /** S-57 issue date (ISO 8601). */
    issued: string;
    /** When the user imported this cell into the device. */
    importedAt: string;
    /** [minLon, minLat, maxLon, maxLat]. */
    bbox: [number, number, number, number];
    /** Path to GeoJSON blob on device filesystem (Capacitor). */
    geojsonPath: string;
    /** Total hazard count across all loaded layers (UI stat). */
    hazardCount: number;
    /**
     * CATZOC range present in the cell's M_QUAL coverage.
     * `[best, worst]` (smaller numbers = higher confidence).
     * Null when M_QUAL data was not present in the source cell.
     */
    catzocRange?: [EncCatzoc, EncCatzoc] | null;
    /**
     * Byte count of the imported GeoJSON. Used by `syncEncFromPi` as a
     * content-change signal: when a chart-set's underlying extraction
     * changes (e.g. the senc-extractor's rogue-triangle filter improves,
     * or AREA_EXT handling adds new features), the Pi emits the same
     * cellId+edition with a DIFFERENT size. Without this signal the
     * dedup key would be `cellId@edition` and iOS would never re-import
     * the cleaner version.
     *
     * Optional for backward compat — pre-2026-05-19 cells lack it and
     * are treated as "size unknown" → re-import on next sync.
     */
    sizeBytes?: number;
}

// ── Query result ───────────────────────────────────────────────────

/**
 * Result of a per-point hazard query.
 *
 * Three meaningful states:
 *  - `covered: false` — no ENC cell covers this point. Caller should
 *    fall back to GEBCO.
 *  - `covered: true, hazard: false` — point is inside an ENC cell
 *    but no hazard polygon contains it. Authoritative "clear water"
 *    answer; caller should NOT call GEBCO for this point.
 *  - `covered: true, hazard: true` — point is inside a hazard. Full
 *    detail in `hazardType` / `minDepthM`.
 *
 * `catzoc` is the M_QUAL CATZOC at the queried point, when the
 * cell ships M_QUAL data. Null means no M_QUAL polygon covers this
 * exact point (rare — most cells have full M_QUAL coverage).
 */
export interface EncHazardResult {
    covered: boolean;
    hazard: boolean;
    minDepthM: number | null;
    hazardType?: EncHazardType;
    cellId?: string;
    catzoc?: EncCatzoc | null;
    /** True when the ONLY basis for this result is spot sounding(s) — no
     *  area (DEPARE/DRGARE/land) or point/line hazard coverage under the
     *  point. A lone sounding is hazard EVIDENCE, not area coverage: if the
     *  draft re-eval clears it, the caller must fall through to GEBCO
     *  rather than treat the point as ENC-verified clear (burn-down
     *  2026-07-16: guard-radius SOUNDG hits were granting coverage). */
    soundingOnly?: boolean;
    /** Lateral near-miss: the SEGMENT passes within the chart's ZOC-scaled
     *  positional-uncertainty margin of a charted AREA hazard boundary it
     *  does NOT cross (burn-down 2026-07-18 finding #1: a validated route
     *  could graze a drying-bank polygon at 0 m with no caveat). ADVISORY
     *  ONLY — never a reroute, and NEVER a severity factor: it is set purely
     *  by `segmentAreaGraze`, folded on its OWN channel in querySegmentHazards
     *  (NOT via mergeHazardResults, which returns one winning result wholesale
     *  and would drop it). queryPoint never sets it. */
    graze?: EncAreaGraze;
}

/**
 * A lateral near-miss between a route segment and a charted AREA hazard
 * boundary the segment does NOT cross, when the clearance falls within the
 * chart's own horizontal positional uncertainty for the local ZOC. Surfaced
 * to the skipper as a "give wider berth / verify visually" advisory — it
 * converts chart positional uncertainty from an invisible assumption into a
 * visible caveat (burn-down 2026-07-18 finding #1). Never triggers a detour.
 */
export interface EncAreaGraze {
    /** Closest lateral clearance (m) from the segment to the AREA boundary. */
    clearanceM: number;
    /** ZOC-scaled positional-uncertainty margin (m) the clearance fell within
     *  (A1 ±5, A2 ±20, B ±50; C/D/U and no-M_QUAL capped — see zocMarginM). */
    marginM: number;
    /** CATZOC at the segment midpoint (null when no M_QUAL covers it). */
    catzoc: EncCatzoc | null;
    /** The grazed AREA hazard's type — 'land' (drying bank / islet / coast,
     *  the finding's scary case → louder advisory), 'shallow' (shoal depth
     *  area), or 'obstruction' (polygon OBSTRN). */
    type: EncHazardType;
}

// ── Spatial index entry (RBush format) ─────────────────────────────

/**
 * RBush requires entries to expose `minX/minY/maxX/maxY`. We
 * compute the bbox of each hazard's geometry once at index-build
 * time and carry the underlying hazard alongside.
 */
export interface BBoxEntry {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    hazard: EncHazard;
    cellId: string;
}

// ── Conversion pipeline (Pi → device) ──────────────────────────────

/**
 * Wire format returned by the Pi-cache `/api/charts/enc/convert`
 * endpoint. The Pi runs `ogr2ogr -f GeoJSON` on each layer of
 * interest, packages cell metadata, and ships this JSON back.
 *
 * Layers are returned as raw GeoJSON FeatureCollections so we can
 * stream/parse them lazily on the device.
 */
export interface EncConversionResult {
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
    layers: {
        DEPARE?: GeoJSON.FeatureCollection;
        LNDARE?: GeoJSON.FeatureCollection;
        OBSTRN?: GeoJSON.FeatureCollection;
        WRECKS?: GeoJSON.FeatureCollection;
        UWTROC?: GeoJSON.FeatureCollection;
        // Man-made allision structures (audit #3) — extracted for the hazard
        // model, WATLEV-gated in encHazardParse. Inert until cells are
        // re-extracted with these classes (see s57Classes ROUTING_CLASSES).
        SLCONS?: GeoJSON.FeatureCollection;
        DAMCON?: GeoJSON.FeatureCollection;
        PILPNT?: GeoJSON.FeatureCollection;
        /** Coastline LineStrings — used for proximity warnings only. */
        COALNE?: GeoJSON.FeatureCollection;
        /** Lights / lighthouses (point features). Display only. */
        LIGHTS?: GeoJSON.FeatureCollection;
        /** Lateral buoys (point features). Display only. */
        BOYLAT?: GeoJSON.FeatureCollection;
        /** Cardinal buoys (point features). Display only. */
        BOYCAR?: GeoJSON.FeatureCollection;
        /** Lateral beacons — rigid lateral marks. Display only. */
        BCNLAT?: GeoJSON.FeatureCollection;
        /** Cardinal beacons — rigid cardinal marks. Display only. */
        BCNCAR?: GeoJSON.FeatureCollection;
        /** Special-purpose buoys (yellow X). Display only. */
        BOYSPP?: GeoJSON.FeatureCollection;
        /** Special-purpose beacons (yellow X). Display only. */
        BCNSPP?: GeoJSON.FeatureCollection;
        /** Safe-water buoys (RW fairway/landfall marks). Display only. */
        BOYSAW?: GeoJSON.FeatureCollection;
        /** Safe-water beacons. Display only. */
        BCNSAW?: GeoJSON.FeatureCollection;
        /** Isolated-danger buoys (BRB, navigable water all round). Display only. */
        BOYISD?: GeoJSON.FeatureCollection;
        /** Isolated-danger beacons. Display only. */
        BCNISD?: GeoJSON.FeatureCollection;
        /** Depth contour lines (VALDCO metres). Display only. */
        DEPCNT?: GeoJSON.FeatureCollection;
        /** Zones of confidence (CATZOC). Info-only — not a hazard. */
        M_QUAL?: GeoJSON.FeatureCollection;
        /** Marked fairway polygons — inshore router prefers these cells. */
        FAIRWY?: GeoJSON.FeatureCollection;
        /** Dredged area polygons — same routing preference as FAIRWY. */
        DRGARE?: GeoJSON.FeatureCollection;
        /** Recommended tracks (line features). Display + future routing. */
        RECTRC?: GeoJSON.FeatureCollection;
        /** Spot soundings. SENC path: MultiPoint + `depths` property array;
         *  ogr2ogr path: MultiPoint25D (depth in the Z coordinate). Display
         *  only — exploded into labelled points at merge time. */
        SOUNDG?: GeoJSON.FeatureCollection;
        /** Named sea areas — bays/channels/passages/rivers carrying OBJNAM
         *  ("Mooloolah River"). Reduced to ONE label point per name at
         *  merge time; only the name ink renders, never the polygons. */
        SEAARE?: GeoJSON.FeatureCollection;
        /** Restricted area (RESTRN/CATREA). Caution-area polygon. */
        RESARE?: GeoJSON.FeatureCollection;
        /** Submarine cable area — no anchoring. Caution-area polygon. */
        CBLARE?: GeoJSON.FeatureCollection;
        /** Pipeline area — no anchoring. Caution-area polygon. */
        PIPARE?: GeoJSON.FeatureCollection;
        /** Seabed nature (NATSUR: sand/mud/rock). Anchoring-aid polygon. */
        SBDARE?: GeoJSON.FeatureCollection;
        /** Traffic Separation Scheme lane part (ORIENT). Info polygon. */
        TSSLPT?: GeoJSON.FeatureCollection;
        /** Caution area — "see the chart note". Info polygon. */
        CTNARE?: GeoJSON.FeatureCollection;
        /** TSS separation zone (between the lanes — keep OUT). */
        TSEZNE?: GeoJSON.FeatureCollection;
        /** Designated anchorage area. Info polygon. */
        ACHARE?: GeoJSON.FeatureCollection;
        /** Marine farm / aquaculture — nets and lines, keep clear. */
        MARCUL?: GeoJSON.FeatureCollection;
        TSELNE?: GeoJSON.FeatureCollection;
        TSSBND?: GeoJSON.FeatureCollection;
        PRCARE?: GeoJSON.FeatureCollection;
        DWRTPT?: GeoJSON.FeatureCollection;
    };
}

/** The caution / information AREA classes drawn as chart furniture (one
 *  CAUTION_AREAS collection, tagged `_caution`). 2026-07-16 audit; batch 2
 *  added CTNARE/TSEZNE/ACHARE/MARCUL (burn-down missing-classes item). */
export const CAUTION_AREA_CLASSES = [
    'RESARE',
    'CBLARE',
    'PIPARE',
    'SBDARE',
    'TSSLPT',
    'CTNARE',
    'TSEZNE',
    'ACHARE',
    'MARCUL',
    'TSELNE',
    'TSSBND',
    'PRCARE',
    'DWRTPT',
] as const;
export type CautionAreaClass = (typeof CAUTION_AREA_CLASSES)[number];

/**
 * Wire format for batch (multi-cell) conversion results. The Pi
 * always returns this shape from `/api/enc/result/:id` so the
 * client can handle single-cell uploads (`cells.length === 1`)
 * and ZIP uploads (`cells.length === N`) with the same code path.
 *
 * `skipped` lists cells the Pi could not convert — e.g. a corrupted
 * `.000` inside a multi-cell ZIP — so the UI can surface them
 * without aborting the whole batch.
 */
export interface EncConversionBatch {
    cells: EncConversionResult[];
    skipped?: { filename: string; error: string }[];
}

// ── Constants ──────────────────────────────────────────────────────

/**
 * Depth threshold at which a DEPARE polygon is treated as hazardous
 * (positive metres, S-57 convention). Anything shallower than this
 * is rejected by the routing validator.
 *
 * Matches the GEBCO threshold (`-15m`) flipped to S-57 convention.
 * Will become user-configurable (vessel draft + safety margin) in
 * Phase 3.
 */
export const ENC_HAZARD_DEPTH_M = 15;

/**
 * localStorage key prefix for cell metadata records.
 * One record per cell at `${ENC_METADATA_PREFIX}:${cellId}`.
 */
export const ENC_METADATA_PREFIX = 'thalassa.enc.cell';

/**
 * Capacitor Filesystem subdirectory for cached GeoJSON blobs.
 * One file per cell at `${ENC_GEOJSON_DIR}/${cellId}.geojson`.
 */
export const ENC_GEOJSON_DIR = 'enc-cells';
