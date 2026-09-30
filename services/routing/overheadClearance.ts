/**
 * overheadClearance — can this mast pass under that bridge, overhead cable,
 * overhead pipe or overhead conveyor? PURE: no React, no I/O, no storage. The router (the grid's
 * low-clearance bars, tryInshoreRouteInner) and the lead overlay
 * (leadReview / leadCompiler) both decide it here, so they agree.
 *
 * Owner decisions (Shane, 2026-09-29/30), binding:
 *   • a structure whose vertical clearance is below the vessel's air draft
 *     plus CLEARANCE_MARGIN_M BLOCKS;
 *   • a structure with NO charted clearance blocks (unknown is never
 *     passable), and an estimated clearance counts as unknown;
 *   • with the air draft UNSET, every bridge and overhead line blocks: its
 *     clearance cannot be checked against anything. The only air draft is the
 *     vessel profile's (services/units.ts vesselAirDraftMetres; 18 m for
 *     Serene Summer, masthead with antennas).
 *
 * The margin is 1 m: the clearance a mast needs over its measured height for
 * a VHF whip flexing, a wake or swell lifting the boat under the span, and a
 * profile measured to the nearest foot. It is on top of the chart's own
 * clearance datum (AU ENCs give VERCLR above HAT, already the high-water
 * case); nothing here credits the tide.
 *
 * Which clearance (S-57 attributes): the LOWEST charted of VERCLR (vertical
 * clearance, fixed), VERCCL (clearance, closed) and VERCSA (safe vertical
 * clearance — the electrical safety distance below an overhead power line).
 * VERCOP (clearance, open) NEVER counts, and on an opening bridge neither
 * does VERCLR: only VERCCL (or VERCSA) says what the span clears closed.
 *
 * Opening bridges (CATBRG 2 opening, 3 swing, 4 lifting, 5 bascule, 6 pontoon,
 * 7 draw, 8 transporter) block unless their CLOSED clearance already clears
 * the mast. Chosen because the app cannot know whether, when or on how much
 * notice a span opens, or whether it is staffed at all, and a route that
 * depends on an opening the skipper cannot confirm is not a route. "Unless
 * the data says otherwise" is exactly that: a charted closed clearance tall
 * enough that the bridge never needs to open.
 */
import type { Feature, Polygon, Position } from 'geojson';
import { isS57ChartProps } from '../enc/types';

/** Metres a mast needs over its air draft to pass (see the header). */
export const CLEARANCE_MARGIN_M = 1;

/** The S-57 structures a mast passes under. CONVYR (an overhead conveyor —
 * a loading gantry over a wharf approach, VERCLR / VERCSA) joined in round 2
 * (2026-09-30). */
export type ClearanceStructureLayer = 'BRIDGE' | 'CBLOHD' | 'PIPOHD' | 'CONVYR';
export const CLEARANCE_STRUCTURE_LAYERS: readonly ClearanceStructureLayer[] = ['BRIDGE', 'CBLOHD', 'PIPOHD', 'CONVYR'];

/** Why a structure blocks this vessel (null from clearanceBlock: it passes). */
export type ClearanceBlock = 'air-draft-unset' | 'opening-bridge' | 'clearance-unknown' | 'too-low';

export interface StructureClearance {
    /** The governing vertical clearance, metres; null when none is charted. */
    clearanceM: number | null;
    /** An opening bridge: only a clearance charted for it CLOSED counts. */
    opening: boolean;
    /** Somebody's estimate, not a charted or surveyed value: unknown. */
    estimated?: boolean;
}

/** S-57 CATBRG values for bridges with a moving span. */
const OPENING_CATBRG: ReadonlySet<number> = new Set([2, 3, 4, 5, 6, 7, 8]);

const clearanceValue = (raw: unknown): number | null => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
};

/** CATBRG as the codes it lists: a number, '4', '1,4' (SENC lists) or ['4'] (ogr2ogr). */
function catbrgCodes(raw: unknown): number[] {
    if (typeof raw === 'number') return Number.isFinite(raw) ? [raw] : [];
    if (typeof raw === 'string') return (raw.match(/\d+/g) ?? []).map(Number);
    if (Array.isArray(raw)) return raw.flatMap(catbrgCodes);
    return [];
}

/** The clearance facts of one chart structure (see the header). */
export function chartStructureClearance(
    layer: ClearanceStructureLayer,
    props: Record<string, unknown> | null | undefined,
): StructureClearance {
    const p = props ?? {};
    const opening = layer === 'BRIDGE' && catbrgCodes(p.CATBRG).some((c) => OPENING_CATBRG.has(c));
    // An opening span counts only what it is charted to clear CLOSED: VERCCL
    // (and a VERCSA, if a producer gives one). A producer that puts VERCLR on
    // an opening span may mean its OPEN clearance, so VERCLR alone leaves the
    // closed clearance unknown and the bridge blocks (decision 5; Phase 2a
    // round-2 review, 2026-09-30 — a lifting bridge charted VERCLR 30 with no
    // VERCCL passed an 18 m mast).
    const fields = opening ? [p.VERCCL, p.VERCSA] : [p.VERCLR, p.VERCCL, p.VERCSA];
    const charted = fields.map(clearanceValue).filter((v): v is number => v !== null);
    return { clearanceM: charted.length > 0 ? Math.min(...charted) : null, opening };
}

/** An air draft the profile actually gives (metres), or null. */
export function usableAirDraftM(airDraftM: number | null | undefined): number | null {
    return typeof airDraftM === 'number' && Number.isFinite(airDraftM) && airDraftM > 0 ? airDraftM : null;
}

/**
 * Why this structure blocks a mast of `airDraftM`, or null when it passes:
 * the charted clearance is at least air draft + margin (an opening bridge:
 * its closed clearance).
 */
export function clearanceBlock(
    c: StructureClearance,
    airDraftM: number | null | undefined,
    marginM = CLEARANCE_MARGIN_M,
): ClearanceBlock | null {
    const air = usableAirDraftM(airDraftM);
    if (air === null) return 'air-draft-unset';
    const known = c.clearanceM !== null && c.estimated !== true;
    if (known && (c.clearanceM as number) >= air + marginM - 1e-9) return null;
    if (c.opening) return 'opening-bridge';
    return known ? 'too-low' : 'clearance-unknown';
}

// ── Bars: the footprint the grid hard-blocks for this vessel ─────────

/** Plain-words structure kind carried on a bar (and read by the refusal). */
export type ClearanceStructureKind = 'bridge' | 'overhead cable' | 'overhead pipe' | 'overhead conveyor';

export interface ClearanceBarProperties {
    /** The engine's low-clearance class: blocked, hardBlocked, clearanceBarred. */
    _class: 'low-clearance';
    /** 'chart' — an S-57 structure; 'curated' — public/notices/bridges-au.json. */
    _source: 'chart' | 'curated';
    _structure: ClearanceStructureKind;
    _block: ClearanceBlock;
    _clearanceM: number | null;
    _airDraftM: number | null;
    _marginM: number;
    _name?: string;
    _rcid?: number;
    _bridgeId?: string;
    _estimated?: boolean;
    /** The structure's own lines ([lon, lat]; an area's rings), for the exact
     * "does the route pass under it" test. Shared by every bar of one
     * structure. */
    _span: Position[][];
    /** The structure is an area: a route vertex inside a ring is under it. */
    _area?: boolean;
}

export type ClearanceBar = Feature<Polygon, ClearanceBarProperties>;

/** Half-width of a bar either side of a structure line. 30 m (a 60 m bar):
 * the engine rasterises polygons by CELL-CENTRE sampling on a ~50 m grid, so
 * anything narrower can slip between cell centres and block nothing (the
 * same figure the curated bridge bars use). */
export const CLEARANCE_BAR_HALF_WIDTH_M = 30;

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/**
 * A rectangle `halfWidthM` either side of the segment a→b, extended
 * `endPadM` past each end. Chart structure lines run abutment to abutment,
 * so they get no end pad (a pad would eat into a neighbouring span's
 * opening); the curated file's OSM ways stop at the water's edge and keep
 * lowBridges' 15 m.
 */
export function segmentBarPolygon(a: Position, b: Position, halfWidthM: number, endPadM = 0): Polygon {
    const midLat = (a[1] + b[1]) / 2;
    const mx = mPerLon(midLat);
    let dx = (b[0] - a[0]) * mx;
    let dy = (b[1] - a[1]) * M_PER_LAT;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
        // A degenerate segment: a square around the point.
        dx = 1;
        dy = 0;
        endPadM = Math.max(endPadM, halfWidthM);
    } else {
        dx /= len;
        dy /= len;
    }
    const px = -dy;
    const py = dx;
    const toLL = (ex: number, ey: number): [number, number] => [a[0] + ex / mx, a[1] + ey / M_PER_LAT];
    const ax = -dx * endPadM;
    const ay = -dy * endPadM;
    const bx = (b[0] - a[0]) * mx + dx * endPadM;
    const by = (b[1] - a[1]) * M_PER_LAT + dy * endPadM;
    const ring: [number, number][] = [
        toLL(ax + px * halfWidthM, ay + py * halfWidthM),
        toLL(bx + px * halfWidthM, by + py * halfWidthM),
        toLL(bx - px * halfWidthM, by - py * halfWidthM),
        toLL(ax - px * halfWidthM, ay - py * halfWidthM),
    ];
    ring.push(ring[0]);
    return { type: 'Polygon', coordinates: [ring] };
}

const finitePos = (c: unknown): c is Position =>
    Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);

/** A structure's lines (an area's rings) and whether it is an area. */
function structureLines(geometry: Feature['geometry'] | null | undefined): { lines: Position[][]; area: boolean } {
    if (!geometry || !('coordinates' in geometry) || !Array.isArray(geometry.coordinates)) {
        return { lines: [], area: false };
    }
    const clean = (line: unknown): Position[] => (Array.isArray(line) ? line.filter(finitePos) : []);
    const c = geometry.coordinates as unknown[];
    switch (geometry.type) {
        case 'Point':
            return { lines: finitePos(c) ? [[c, c]] : [], area: false };
        case 'MultiPoint':
            return { lines: c.filter(finitePos).map((p) => [p, p]), area: false };
        case 'LineString':
            return { lines: [clean(c)].filter((l) => l.length >= 1), area: false };
        case 'MultiLineString':
            return { lines: c.map(clean).filter((l) => l.length >= 1), area: false };
        case 'Polygon':
            return { lines: c.map(clean).filter((l) => l.length >= 2), area: true };
        case 'MultiPolygon':
            return {
                lines: c.flatMap((poly) => (Array.isArray(poly) ? poly.map(clean) : [])).filter((l) => l.length >= 2),
                area: true,
            };
        default:
            return { lines: [], area: false };
    }
}

/** An S-57 chart feature (the extractor's acronym, classCode or OBJL —
 * services/enc/types.ts isS57ChartProps, shared with the grid). */
const isChartFeature = (props: Record<string, unknown>): boolean => isS57ChartProps(props);

const STRUCTURE_KIND: Record<ClearanceStructureLayer, ClearanceStructureKind> = {
    BRIDGE: 'bridge',
    CBLOHD: 'overhead cable',
    PIPOHD: 'overhead pipe',
    CONVYR: 'overhead conveyor',
};

/** Bars for one blocking structure: a 60 m band along every line (an area's
 * rings) and, for an area, the area itself. */
function barsFor(lines: Position[][], area: boolean, props: ClearanceBarProperties, endPadM = 0): ClearanceBar[] {
    const out: ClearanceBar[] = [];
    for (const line of lines) {
        if (line.length === 1) {
            out.push({
                type: 'Feature',
                properties: props,
                geometry: segmentBarPolygon(line[0], line[0], CLEARANCE_BAR_HALF_WIDTH_M),
            });
            continue;
        }
        for (let i = 0; i < line.length - 1; i++) {
            out.push({
                type: 'Feature',
                properties: props,
                geometry: segmentBarPolygon(line[i], line[i + 1], CLEARANCE_BAR_HALF_WIDTH_M, endPadM),
            });
        }
    }
    if (area) {
        for (const ring of lines) {
            if (ring.length < 4) continue;
            out.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });
        }
    }
    return out;
}

/**
 * The low-clearance bars for the chart's bridges, overhead cables, overhead
 * pipes and overhead conveyors that block a mast of `airDraftM` (null: unset — every one
 * blocks). A passable structure gives none. Chart features only.
 */
export function chartClearanceBars(
    structures: Partial<Record<ClearanceStructureLayer, readonly Feature[] | undefined>>,
    airDraftM: number | null | undefined,
): ClearanceBar[] {
    const air = usableAirDraftM(airDraftM);
    const out: ClearanceBar[] = [];
    for (const layer of CLEARANCE_STRUCTURE_LAYERS) {
        for (const f of structures[layer] ?? []) {
            const p = (f?.properties ?? {}) as Record<string, unknown>;
            if (!isChartFeature(p)) continue;
            const { lines, area } = structureLines(f.geometry);
            if (lines.length === 0) continue;
            const clearance = chartStructureClearance(layer, p);
            const block = clearanceBlock(clearance, air);
            if (block === null) continue;
            const rcid = typeof p.rcid === 'number' && Number.isFinite(p.rcid) ? p.rcid : undefined;
            const name = typeof p.OBJNAM === 'string' && p.OBJNAM.trim() !== '' ? p.OBJNAM.trim() : undefined;
            const props: ClearanceBarProperties = {
                _class: 'low-clearance',
                _source: 'chart',
                _structure: STRUCTURE_KIND[layer],
                _block: block,
                _clearanceM: clearance.clearanceM,
                _airDraftM: air,
                _marginM: CLEARANCE_MARGIN_M,
                ...(name ? { _name: name } : {}),
                ...(rcid !== undefined ? { _rcid: rcid } : {}),
                _span: lines,
                ...(area ? { _area: true } : {}),
            };
            out.push(...barsFor(lines, area, props));
        }
    }
    return out;
}

/** A curated bridge (public/notices/bridges-au.json, services/lowBridges). */
export interface CuratedBridgeLike {
    id: string;
    name: string;
    clearanceM: number | null;
    estimated?: boolean;
    span: [number, number][];
}

/**
 * The same verdict for the curated bridge file, which stays an extra source
 * beside the chart: its OSM ways stop at the water's edge, so its bars keep
 * the 15 m end pad lowBridges always gave them.
 */
export function curatedClearanceBars(
    bridges: readonly CuratedBridgeLike[],
    airDraftM: number | null | undefined,
): ClearanceBar[] {
    const air = usableAirDraftM(airDraftM);
    const out: ClearanceBar[] = [];
    for (const b of bridges) {
        const span = (b.span ?? []).filter(finitePos) as Position[];
        if (span.length < 2) continue;
        const clearanceM = clearanceValue(b.clearanceM);
        const block = clearanceBlock({ clearanceM, opening: false, estimated: b.estimated === true }, air);
        if (block === null) continue;
        const ends = [span[0], span[span.length - 1]];
        out.push(
            ...barsFor(
                [ends],
                false,
                {
                    _class: 'low-clearance',
                    _source: 'curated',
                    _structure: 'bridge',
                    _block: block,
                    _clearanceM: clearanceM,
                    _airDraftM: air,
                    _marginM: CLEARANCE_MARGIN_M,
                    _name: b.name,
                    _bridgeId: b.id,
                    ...(b.estimated ? { _estimated: true } : {}),
                    _span: [span],
                },
                15,
            ),
        );
    }
    return out;
}

// ── Does a route pass under one? ─────────────────────────────────────

/**
 * Do segments a→b and c→d meet — crossing, TOUCHING (a vertex exactly on the
 * other segment) or overlapping collinear? Round-3 review (2026-09-30): the
 * strict test missed a route vertex lying exactly on a structure's line, the
 * splices' own case (a snap can land a vertex on the chart's line).
 */
function segmentsCross(a: Position, b: Position, c: Position, d: Position): boolean {
    const o = (p: Position, q: Position, r: Position): number =>
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    // A turn this small against both lengths is a straight line (degrees²).
    const eps = 1e-12 * Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(d[0] - c[0], d[1] - c[1]);
    const sgn = (v: number): number => (v > eps ? 1 : v < -eps ? -1 : 0);
    const d1 = sgn(o(c, d, a));
    const d2 = sgn(o(c, d, b));
    const d3 = sgn(o(a, b, c));
    const d4 = sgn(o(a, b, d));
    if (d1 * d2 > 0 || d3 * d4 > 0) return false;
    if (d1 !== 0 || d2 !== 0 || d3 !== 0 || d4 !== 0) return true;
    // Collinear: they meet when their extents overlap.
    const overlap = (i: 0 | 1): boolean =>
        Math.max(Math.min(a[i], b[i]), Math.min(c[i], d[i])) <= Math.min(Math.max(a[i], b[i]), Math.max(c[i], d[i]));
    return overlap(0) && overlap(1);
}

/** Metres from point p to segment a→b (local equirectangular frame). */
function pointSegmentM(p: Position, a: Position, b: Position): number {
    const mx = mPerLon(p[1]);
    const ax = (a[0] - p[0]) * mx;
    const ay = (a[1] - p[1]) * M_PER_LAT;
    const dx = (b[0] - a[0]) * mx;
    const dy = (b[1] - a[1]) * M_PER_LAT;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
}

function ringContains(ring: readonly Position[], lon: number, lat: number): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

const isBar = (f: Feature | null | undefined): f is Feature<Polygon, ClearanceBarProperties> => {
    const p = f?.properties as Partial<ClearanceBarProperties> | null | undefined;
    return p?._class === 'low-clearance' && Array.isArray(p._span);
};

/**
 * The first low-clearance bar whose STRUCTURE the polyline passes under — a
 * segment crossing the structure's line, or (an area) a vertex inside it —
 * or null. Exact, not sampled: a route that only runs near a bridge is not
 * under it. Bars without their structure's lines (none this module makes)
 * are skipped.
 */
export function polylineCrossesClearanceBar(
    polyline: readonly (readonly [number, number])[],
    features: readonly (Feature | null | undefined)[],
): Feature<Polygon, ClearanceBarProperties> | null {
    const seen = new Set<Position[][]>();
    for (const f of features) {
        if (!isBar(f)) continue;
        const span = f.properties._span;
        if (seen.has(span)) continue;
        seen.add(span);
        for (const line of span) {
            if (line.length === 0) continue;
            // A structure charted as a POINT (its line degenerate): under it
            // is within the bar's half-width of it (round-3 review,
            // 2026-09-30 — a zero-length line is never "crossed", so the gate
            // could not see it on an off-grid splice).
            if (line.every((q) => q[0] === line[0][0] && q[1] === line[0][1])) {
                for (let i = 0; i + 1 < polyline.length; i++) {
                    const a = polyline[i] as unknown as Position;
                    const b = polyline[i + 1] as unknown as Position;
                    if (pointSegmentM(line[0], a, b) < CLEARANCE_BAR_HALF_WIDTH_M) return f;
                }
                continue;
            }
            for (let i = 0; i + 1 < polyline.length; i++) {
                const a = polyline[i] as unknown as Position;
                const b = polyline[i + 1] as unknown as Position;
                for (let j = 0; j + 1 < line.length; j++) {
                    if (segmentsCross(a, b, line[j], line[j + 1])) return f;
                }
            }
            if (f.properties._area && line.length >= 4) {
                for (const p of polyline) if (ringContains(line, p[0], p[1])) return f;
            }
        }
    }
    return null;
}

/**
 * The properties of the low-clearance bar at [lon, lat] (the one containing
 * it; failing that, the nearest by its first vertex), or null when there are
 * no bars. For naming the structure behind a grid cell the engine refused to
 * carve or saw a route circumvent. Bars made before Part B carry no reason;
 * clearanceRefusalMessage keeps their original wording.
 */
export function clearanceBarAt(
    features: readonly (Feature | null | undefined)[],
    lon: number,
    lat: number,
): Record<string, unknown> | null {
    let nearest: Record<string, unknown> | null = null;
    let nearestD = Infinity;
    for (const f of features) {
        const p = f?.properties as Record<string, unknown> | null | undefined;
        if (!p || p._class !== 'low-clearance' || !f?.geometry) continue;
        const g = f.geometry;
        const polys =
            g.type === 'Polygon'
                ? [g.coordinates as Position[][]]
                : g.type === 'MultiPolygon'
                  ? (g.coordinates as Position[][][])
                  : [];
        for (const poly of polys) {
            const outer = poly[0];
            if (!outer || outer.length < 3) continue;
            if (ringContains(outer, lon, lat) && !poly.slice(1).some((h) => ringContains(h, lon, lat))) return p;
            const d = Math.hypot((outer[0][0] - lon) * mPerLon(lat), (outer[0][1] - lat) * M_PER_LAT);
            if (d < nearestD) {
                nearestD = d;
                nearest = p;
            }
        }
    }
    return nearest;
}

// ── The refusal, in plain words ──────────────────────────────────────

const metres = (m: number): string => `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)} m`;

/**
 * Why no mast-safe route exists, naming the structure and the reason. `where`
 * 'channel': it blocks the only channel between the points; 'here': the route
 * would pass it. A bar that carries no reason (made before Part B) keeps the
 * original fixed-bridge wording.
 */
export function clearanceRefusalMessage(
    props: Partial<ClearanceBarProperties> | Record<string, unknown> | null | undefined,
    where: 'channel' | 'here' = 'channel',
): string {
    const p = (props ?? {}) as Partial<ClearanceBarProperties>;
    const place = where === 'channel' ? 'the only channel between these points' : 'the channel here';
    const fix = 'Move the pin to water on this side of it, or check your air draft in Vessel settings.';
    if (!p._block) {
        return where === 'channel'
            ? 'No mast-safe route: a fixed bridge with less clearance than your air draft blocks the only channel between these points. Move the pin to water on the seaward side of the bridge, or check your air draft in Vessel settings.'
            : 'No mast-safe route: a fixed bridge with less clearance than your air draft blocks the channel here. Move the pin to water on the seaward side of the bridge, or check your air draft in Vessel settings.';
    }
    const kind = p._structure ?? 'bridge';
    const charted = p._source === 'chart' ? 'charted ' : '';
    const what = p._name ? `the ${kind} "${p._name}"` : `a ${charted}${kind}`;
    const margin = metres(p._marginM ?? CLEARANCE_MARGIN_M);
    switch (p._block) {
        case 'too-low':
            return `No mast-safe route: ${what} has ${metres(p._clearanceM ?? 0)} clearance, less than your ${metres(p._airDraftM ?? 0)} air draft plus a ${margin} margin, and it crosses ${place}. ${fix}`;
        case 'clearance-unknown':
            return `No mast-safe route: ${what} crosses ${place} and the chart gives no clearance for it${p._estimated ? ' (only an estimate)' : ''}, so it is treated as too low for your mast. ${fix}`;
        case 'opening-bridge':
            return `No mast-safe route: ${what} is an opening bridge across ${place}${p._clearanceM !== null && p._clearanceM !== undefined ? `, with ${metres(p._clearanceM)} clearance closed` : ''}. The app cannot know when it opens, so it is treated as closed. ${fix}`;
        case 'air-draft-unset':
        default:
            return `No mast-safe route: ${what} crosses ${place} and your air draft is not set, so its clearance cannot be checked. Set your air draft in Vessel settings.`;
    }
}
