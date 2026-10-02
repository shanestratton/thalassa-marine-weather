/**
 * Final-route safety audits that operate on the source vector geometry.
 *
 * The navigation grid deliberately has a handful of tightly scoped rescue
 * mechanisms for chart-alignment errors around marina entrances. Those
 * mechanisms must never turn a sustained run across charted land into a
 * route. Sampling the emitted polyline against the original vectors gives us
 * an independent engine-boundary veto after every grid carve and splice.
 */
import type { FeatureCollection, LineString, MultiLineString, MultiPolygon, Polygon, Position } from 'geojson';
import type { InshoreLayers, NavGrid } from './types';
import { geometryBbox, haversineM, latLonToGrid, pointInGeometry, segmentGeometryDistanceM } from './geometry';
import { UNKNOWN_OPEN } from './constants';
import { navLineLeads } from '../leadingLine';
import { navLinesOnWater } from '../routing/leadLandClip';
import {
    backstopVerdict,
    bandClaimOf,
    finestBandBeatsLand,
    isAuthoritativeOsmWater,
    isBackstopOsmWater,
    type BandClaim,
    type ChartWaterProbe,
} from './chartWaterEvidence';
import { isS57ChartProps, readS57 } from '../enc/types';

type AreaGeometry = Polygon | MultiPolygon;

interface IndexedArea {
    geometry: AreaGeometry;
    bbox: [number, number, number, number];
}

interface IndexedLine {
    coordinates: Position[];
    bbox: [number, number, number, number];
}

export interface HardLandAudit {
    maxRunM: number;
    totalM: number;
    sampledIntervals: number;
    maxRunStart?: [number, number];
    maxRunEnd?: [number, number];
    /** Every run, by where it lies along the line (metres from the first
     *  vertex) and its middle ([lon, lat]) — so a caller can tell a run at a
     *  pin's own edge from one across the way (2026-10-01). */
    runs: HardLandRun[];
    /** The line's length as sampled, metres. */
    lengthM: number;
}

export interface HardLandRun {
    fromM: number;
    toM: number;
    lengthM: number;
    mid: [number, number];
}

/** A longer exact-LNDARE run is not a marina-mouth alignment error. */
export const MAX_UNVOUCHED_HARD_LAND_RUN_M = 500;

/** An indexed area carrying the value `pick` read from its feature. */
interface TaggedArea<T> extends IndexedArea {
    tag: T;
}

function indexTaggedAreas<T>(
    collections: Array<FeatureCollection | undefined>,
    pick: (props: Record<string, unknown> | null) => T | undefined,
    /** Keep only the areas whose bbox meets this one ([w, s, e, n]). */
    within?: readonly [number, number, number, number],
): TaggedArea<T>[] {
    const indexed: TaggedArea<T>[] = [];
    for (const collection of collections) {
        for (const feature of collection?.features ?? []) {
            const geometry = feature.geometry;
            if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
            const tag = pick(feature.properties as Record<string, unknown> | null);
            if (tag === undefined) continue;
            const bbox = geometryBbox(geometry);
            if (within && (bbox[2] < within[0] || bbox[0] > within[2] || bbox[3] < within[1] || bbox[1] > within[3]))
                continue;
            indexed.push({ geometry, bbox, tag });
        }
    }
    return indexed;
}

/** The tags of every area containing the point. */
function tagsAt<T>(lon: number, lat: number, areas: readonly TaggedArea<T>[]): T[] {
    const out: T[] = [];
    for (const area of areas) {
        const [minLon, minLat, maxLon, maxLat] = area.bbox;
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
        if (pointInGeometry(lon, lat, area.geometry)) out.push(area.tag);
    }
    return out;
}

function pointInIndexedAreas(lon: number, lat: number, areas: readonly IndexedArea[]): boolean {
    for (const area of areas) {
        const [minLon, minLat, maxLon, maxLat] = area.bbox;
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
        if (pointInGeometry(lon, lat, area.geometry)) return true;
    }
    return false;
}

function indexLines(collections: Array<FeatureCollection | undefined>): IndexedLine[] {
    const indexed: IndexedLine[] = [];
    for (const collection of collections) {
        for (const feature of collection?.features ?? []) {
            const geometry = feature.geometry;
            if (!geometry || (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString')) continue;
            const lines =
                geometry.type === 'LineString'
                    ? [(geometry as LineString).coordinates]
                    : (geometry as MultiLineString).coordinates;
            for (const coordinates of lines) {
                if (coordinates.length < 2) continue;
                let minLon = Infinity;
                let minLat = Infinity;
                let maxLon = -Infinity;
                let maxLat = -Infinity;
                for (const [lon, lat] of coordinates) {
                    minLon = Math.min(minLon, lon);
                    minLat = Math.min(minLat, lat);
                    maxLon = Math.max(maxLon, lon);
                    maxLat = Math.max(maxLat, lat);
                }
                indexed.push({ coordinates, bbox: [minLon, minLat, maxLon, maxLat] });
            }
        }
    }
    return indexed;
}

function pointToSegmentM(lon: number, lat: number, a: Position, b: Position): number {
    const refLat = ((lat + a[1] + b[1]) / 3) * (Math.PI / 180);
    const mx = 111_320 * Math.cos(refLat);
    const my = 111_320;
    const px = lon * mx;
    const py = lat * my;
    const ax = a[0] * mx;
    const ay = a[1] * my;
    const bx = b[0] * mx;
    const by = b[1] * my;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointNearVouchedLine(lon: number, lat: number, lines: readonly IndexedLine[], corridorM = 125): boolean {
    const dLat = corridorM / 111_320;
    const dLon = corridorM / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    for (const line of lines) {
        const [minLon, minLat, maxLon, maxLat] = line.bbox;
        if (lon < minLon - dLon || lon > maxLon + dLon || lat < minLat - dLat || lat > maxLat + dLat) continue;
        for (let i = 1; i < line.coordinates.length; i++) {
            if (pointToSegmentM(lon, lat, line.coordinates[i - 1], line.coordinates[i]) <= corridorM) return true;
        }
    }
    return false;
}

/**
 * Is this POINT charted hard land — inside chart land paint with no water
 * evidence there (OSM-vouched water, or decision-1 water: a finer never-drying
 * band beating the land paint)? The audit's own polygon rule below, for one
 * point, WITHOUT the 125 m lead / canal corridor (a lead beside a pin does not
 * make the pin water). The engine asks it of each pin (round 2, 2026-09-30):
 * a pin in decision-1 water is shallow water, not "on land", so the route runs
 * to it; a pin on hard land keeps today's nearest-water ending. Returns a
 * predicate, memoized per layer set, so the strict, relaxed and fine passes
 * of one route index the layers once.
 */
const hardLandMemo = new WeakMap<InshoreLayers, (lon: number, lat: number) => boolean>();

export function hardLandAtPoint(layers: InshoreLayers): (lon: number, lat: number) => boolean {
    const hit = hardLandMemo.get(layers);
    if (hit) return hit;
    const test = buildHardLandAtPoint(layers);
    hardLandMemo.set(layers, test);
    return test;
}

function buildHardLandAtPoint(layers: InshoreLayers): (lon: number, lat: number) => boolean {
    const land = indexTaggedAreas<number | null>([layers.LNDARE], (p) =>
        typeof p?._scaleRank === 'number' ? p._scaleRank : null,
    );
    if (land.length === 0) return () => false;
    const osmWater = indexTaggedAreas<true>([layers.DEPARE, layers.FAIRWY], (p) =>
        isAuthoritativeOsmWater(p) ? true : undefined,
    );
    const bands = indexTaggedAreas<BandClaim>([layers.DEPARE, layers.DRGARE], (p) => bandClaimOf(p) ?? undefined);
    return (lon, lat) => {
        const landRanks = tagsAt(lon, lat, land);
        if (landRanks.length === 0) return false;
        if (pointInIndexedAreas(lon, lat, osmWater)) return false;
        return !finestBandBeatsLand(tagsAt(lon, lat, bands), landRanks);
    };
}

/**
 * The satellite land check's chart evidence (2026-10-02, Coral Sea Marina →
 * Daydream Island): what the route's own layers — the installed cells as the
 * engine merged them, ranked, plus the OSM water it injected — say at a
 * point (chartWaterEvidence.backstopVerdict). services/routing/landBackstop
 * ignores a NOAA ETOPO "land" sample only where this answers 'water', and
 * passes over one it answers 'osm-water' (neutral).
 *
 * Indexed once, eagerly, and only the areas meeting `within` (the route's
 * bbox): the probe rides the route result, so it must not keep every merged
 * feature of the route's window alive with it.
 */
export function backstopChartWaterProbe(
    layers: InshoreLayers,
    within?: readonly [number, number, number, number],
): ChartWaterProbe {
    const land = indexTaggedAreas<number | null>(
        [layers.LNDARE],
        (p) => (typeof p?._scaleRank === 'number' ? p._scaleRank : null),
        within,
    );
    // Navigable OSM water only — no ponds, no Mapbox / satellite water
    // (chartWaterEvidence.isBackstopOsmWater) — and it is neutral, never
    // 'water' (backstopVerdict).
    const osmWater = indexTaggedAreas<true>(
        [layers.DEPARE, layers.FAIRWY],
        (p) => (isBackstopOsmWater(p) ? true : undefined),
        within,
    );
    const bands = indexTaggedAreas<BandClaim>(
        [layers.DEPARE, layers.DRGARE],
        (p) => bandClaimOf(p) ?? undefined,
        within,
    );
    return (lon, lat) =>
        backstopVerdict(pointInIndexedAreas(lon, lat, osmWater), tagsAt(lon, lat, bands), tagsAt(lon, lat, land));
}

/**
 * Measure continuous emitted-route runs that sit inside charted LNDARE without
 * water evidence there. Polygonal water evidence is the grid's own
 * (services/engine/chartWaterEvidence.ts): OSM-vouched engineered water, or —
 * owner decision 1 — an S-57 DEPARE / DRGARE band charted at a strictly finer
 * scale than the finest land paint on the spot that never dries. Those points
 * are the sources disagreeing (caution-worthy, not unambiguously land).
 * Everything else — a drying, undepthed, equal-scale, coarser or unranked
 * band, a bare bathymetry-derived band, a FAIRWY (a route area, not a depth)
 * — leaves the land paint standing: an exact hard-land hit.
 *
 * Phase 2a review (2026-09-30): this used to vouch ANY DEPARE, DRGARE or
 * FAIRWY overlap, so the independent veto could not catch the land the
 * grid's old chart-FAIRWY/DRGARE rescue reopened.
 */
export function auditUnvouchedHardLand(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    sampleStepM = 25,
): HardLandAudit {
    // Land paint with its fineness rank (null: unranked — unknown).
    const land = indexTaggedAreas<number | null>([layers.LNDARE], (p) =>
        typeof p?._scaleRank === 'number' ? p._scaleRank : null,
    );
    if (land.length === 0 || polyline.length < 2) {
        return { maxRunM: 0, totalM: 0, sampledIntervals: 0, runs: [], lengthM: 0 };
    }
    // OSM-vouched water (the promoted river polygons in FAIRWY carry the same
    // OSM tags as their DEPARE copies; an S-57 FAIRWY never qualifies).
    const osmWater = indexTaggedAreas<true>([layers.DEPARE, layers.FAIRWY], (p) =>
        isAuthoritativeOsmWater(p) ? true : undefined,
    );
    // S-57 depth bands, each with its decision-1 claim.
    const bands = indexTaggedAreas<BandClaim>([layers.DEPARE, layers.DRGARE], (p) => bandClaimOf(p) ?? undefined);
    const waterUnderLand = (lon: number, lat: number, landRanks: readonly (number | null)[]): boolean =>
        pointInIndexedAreas(lon, lat, osmWater) || finestBandBeatsLand(tagsAt(lon, lat, bands), landRanks);
    // These line layers are explicit navigation evidence. The grid carves or
    // prefers a narrow corridor around them, so the independent vector audit
    // must honour the same physical-water claim without treating all relaxed
    // land nearby as water.
    // A clearing line (NAVLNE CATNAV 1) is the edge of a danger and a transit
    // (CATNAV 2) is a bearing: neither is evidence of water, so only leads
    // (navLineLeads) vouch here.
    // And a lead vouches only where it is ON WATER (Phase 1): a leading line's
    // extension over land towards its marks ashore — or any lead drawn over
    // LNDARE with no chart water under it — is not evidence that the land
    // beside it is water. Leads (NAVLINE, RECTRC) are cut to their on-water
    // spans with the lead compiler's rule (chart water only). The grid clips
    // against its own cell verdict instead (navGrid Pass 5b), which also
    // counts the OSM canal carve and OSM-vouched water; this audit vouches
    // those on its own (DEPARE polygons above, CANAL lines below), so a route
    // through such a channel passes without the lead's help.
    const navLeads = layers.NAVLINE
        ? { ...layers.NAVLINE, features: navLinesOnWater(navLineLeads(layers.NAVLINE.features), layers) }
        : undefined;
    const tracks = layers.RECTRC
        ? { ...layers.RECTRC, features: navLinesOnWater(layers.RECTRC.features, layers) }
        : undefined;
    const wetLines = indexLines([layers.CANAL, navLeads, tracks, layers.NTMBAR]);
    const stepM = Math.max(5, sampleStepM);
    let runM = 0;
    let maxRunM = 0;
    let totalM = 0;
    let sampledIntervals = 0;
    let runStart: [number, number] | undefined;
    let maxRunStart: [number, number] | undefined;
    let maxRunEnd: [number, number] | undefined;
    // Each run's extent along the line, and the samples it holds (its middle
    // is the middle sample).
    const runs: HardLandRun[] = [];
    let runFromM = 0;
    let runSamples: [number, number][] = [];
    let alongM = 0;
    const closeRun = (): void => {
        if (runSamples.length === 0) return;
        runs.push({
            fromM: runFromM,
            toM: runFromM + runM,
            lengthM: runM,
            mid: runSamples[Math.floor(runSamples.length / 2)],
        });
        runSamples = [];
    };

    for (let i = 1; i < polyline.length; i++) {
        const [lonA, latA] = polyline[i - 1];
        const [lonB, latB] = polyline[i];
        const segmentM = haversineM(latA, lonA, latB, lonB);
        const intervals = Math.max(1, Math.ceil(segmentM / stepM));
        const intervalM = segmentM / intervals;
        for (let s = 0; s < intervals; s++) {
            // Midpoint sampling measures each complete interval and avoids
            // double-counting shared vertices across adjacent segments.
            const t = (s + 0.5) / intervals;
            const lon = lonA + (lonB - lonA) * t;
            const lat = latA + (latB - latA) * t;
            const landRanks = tagsAt(lon, lat, land);
            const hardLand =
                landRanks.length > 0 &&
                !waterUnderLand(lon, lat, landRanks) &&
                !pointNearVouchedLine(lon, lat, wetLines);
            sampledIntervals++;
            if (hardLand) {
                if (runSamples.length === 0) runFromM = alongM;
                runSamples.push([lon, lat]);
                runStart ??= [lon, lat];
                runM += intervalM;
                totalM += intervalM;
                if (runM > maxRunM) {
                    maxRunM = runM;
                    maxRunStart = runStart;
                    maxRunEnd = [lon, lat];
                }
            } else {
                closeRun();
                runM = 0;
                runStart = undefined;
            }
            alongM += intervalM;
        }
    }
    closeRun();

    return { maxRunM, totalM, sampledIntervals, maxRunStart, maxRunEnd, runs, lengthM: alongM };
}

/**
 * Metres of hard land a route crosses AWAY from a pin's own edge (2026-10-01):
 * a run that touches an end whose pin is off the water (on land or a drying
 * bank, or trimmed back to the water's edge) is that pin's own ground, and
 * the route says so; every other run is land the route crosses. Auto refuses
 * any of it (services/autoroutingThalassa): the engine's 500 m veto above
 * lets a shorter run through, and the localized relax retry can make one
 * (a 400 m land wall beside a far-snapped pin).
 */
export function hardLandAwayFromPinEdges(
    audit: Pick<HardLandAudit, 'runs' | 'lengthM'>,
    edgeEnds: { origin: boolean; destination: boolean },
    slackM = 30,
): { metres: number; at: [number, number] | null } {
    let metres = 0;
    let worst: HardLandRun | null = null;
    for (const run of audit.runs) {
        if (edgeEnds.origin && run.fromM <= slackM) continue;
        if (edgeEnds.destination && run.toM >= audit.lengthM - slackM) continue;
        metres += run.lengthM;
        if (!worst || run.lengthM > worst.lengthM) worst = run;
    }
    return { metres, at: worst ? worst.mid : null };
}

/**
 * The engine's no-evidence rule for one grid cell — no chart band, no OSM
 * water, no protection vouches there is water, and nothing but a lead's
 * corridor prefers it (routeInshore isUnvouchedIdx under the strict policy).
 * Shared so a PROMOTED Seaway route is held to the same rule (round-3 review,
 * 2026-09-30).
 */
export function isUnvouchedCell(grid: NavGrid, idx: number): boolean {
    return (
        grid.unvouched !== undefined &&
        grid.unvouched[idx] === 1 &&
        grid.cells[idx] === UNKNOWN_OPEN &&
        // A lead's corridor prefers a cell without vouching for its depth.
        (grid.preferred[idx] === 0 || grid.leadOnlyPreferred?.[idx] === 1)
    );
}

/** No-evidence water along a polyline, sampled every half cell (≥ 25 m) as
 * the engine's own sweep does: the longest run, the total, and which segments
 * touch it. Runs carry across vertices; out-of-grid samples count as none. */
export function unvouchedAlong(
    grid: NavGrid,
    polyline: readonly (readonly [number, number])[],
): { maxRunM: number; totalM: number; segMask: boolean[] } {
    const segMask: boolean[] = new Array(Math.max(0, polyline.length - 1)).fill(false);
    const cellM = grid.dLat * 110_540;
    const stepM = Math.max(25, cellM / 2);
    let runM = 0;
    let maxRunM = 0;
    let totalM = 0;
    for (let i = 1; i < polyline.length; i++) {
        const [lonA, latA] = polyline[i - 1];
        const [lonB, latB] = polyline[i];
        const segM = haversineM(latA, lonA, latB, lonB);
        const steps = Math.max(1, Math.ceil(segM / stepM));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const { x, y } = latLonToGrid(grid, latA + (latB - latA) * t, lonA + (lonB - lonA) * t);
            const inGrid = x >= 0 && y >= 0 && x < grid.width && y < grid.height;
            if (inGrid && isUnvouchedCell(grid, y * grid.width + x)) {
                segMask[i - 1] = true;
                if (s === 0) continue; // the shared vertex was counted with the last segment
                runM += segM / steps;
                totalM += segM / steps;
                if (runM > maxRunM) maxRunM = runM;
            } else if (s > 0) {
                runM = 0;
            }
        }
    }
    return { maxRunM, totalM, segMask };
}

/**
 * The FINAL geometry against the chart's own hazards (round-3 review,
 * 2026-09-30). The grid blocks every cell an OBSTRN / WRECKS / UWTROC buffer
 * touches, but several things write around it: the endpoint and
 * component-bridge carves (now barred from charted hazard cells), smoothing
 * chords between cell centres, and every splice that rides off the grid —
 * leads and RECTRC snaps validate against LAND only, on purpose, so a lead is
 * never vetoed by the wreck it guides past (2026-06-11). Per segment: true
 * where it passes within `bufferM` of a charted point hazard, or through or
 * within `bufferM` of a charted hazard area (exactly, against its rings —
 * round-2 review fix-up 2, 2026-10-03), whose depth over it is unknown or
 * shallower than `needM` — the lead review's own test (leadReview
 * LEAD_HAZARD_BUFFER_M).
 * The engine flags those segments caution (red outside a marked channel)
 * rather than refusing the route. Synthetic router furniture (clearance bars,
 * mark discs, OSM reefs) carries no S-57 identity and is not read.
 */
export function hazardBufferSegments(
    polyline: readonly (readonly [number, number])[],
    layers: InshoreLayers,
    bufferM: number,
    needM: number,
): boolean[] {
    const segs: boolean[] = new Array(Math.max(0, polyline.length - 1)).fill(false);
    if (segs.length === 0) return segs;
    const points: [number, number][] = [];
    const areas: (Polygon | MultiPolygon)[] = [];
    for (const fcol of [layers.OBSTRN, layers.WRECKS, layers.UWTROC]) {
        for (const f of fcol?.features ?? []) {
            const props = f.properties as Record<string, unknown> | null;
            if (!f.geometry || !isS57ChartProps(props)) continue;
            const raw = readS57(props, 'VALSOU');
            const valsou =
                typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
            if (Number.isFinite(valsou) && valsou >= needM - 1e-9) continue; // charted deep enough over it
            const g = f.geometry;
            if (g.type === 'Point') points.push(g.coordinates as [number, number]);
            else if (g.type === 'MultiPoint') for (const c of g.coordinates) points.push(c as [number, number]);
            else if (g.type === 'Polygon' || g.type === 'MultiPolygon') areas.push(g);
        }
    }
    if (points.length === 0 && areas.length === 0) return segs;
    const lat0 = polyline[0][1];
    const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110_540;
    const padLon = bufferM / kx;
    const padLat = bufferM / ky;
    const areaBoxes = areas.map((a) => ({ a, b: geometryBbox(a) }));
    for (let i = 0; i + 1 < polyline.length; i++) {
        const [ax, ay] = polyline[i];
        const [bx, by] = polyline[i + 1];
        const minX = Math.min(ax, bx) - padLon;
        const maxX = Math.max(ax, bx) + padLon;
        const minY = Math.min(ay, by) - padLat;
        const maxY = Math.max(ay, by) + padLat;
        const dx = (bx - ax) * kx;
        const dy = (by - ay) * ky;
        const l2 = dx * dx + dy * dy;
        for (const [px, py] of points) {
            if (px < minX || px > maxX || py < minY || py > maxY) continue;
            const qx = (px - ax) * kx;
            const qy = (py - ay) * ky;
            const t = l2 > 0 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / l2)) : 0;
            if (Math.hypot(qx - t * dx, qy - t * dy) < bufferM) {
                segs[i] = true;
                break;
            }
        }
        if (segs[i] || areaBoxes.length === 0) continue;
        // An area gets the same keep-out a point does, measured exactly
        // (round-2 review fix-up 2, 2026-10-03): it used to be a point-in-area
        // test every 10 m, so a line 1 m beside foul ground that covers and
        // uncovers, or across a strip of it narrower than 10 m between two
        // samples, was clear of every hazard's buffer — and GRID_ONLY then
        // drew it green. Through the area, or within `bufferM` of its rings.
        for (const { a, b } of areaBoxes) {
            if (b[2] < minX || b[0] > maxX || b[3] < minY || b[1] > maxY) continue;
            if (segmentGeometryDistanceM(polyline[i], polyline[i + 1], a, kx, ky) < bufferM) {
                segs[i] = true;
                break;
            }
        }
    }
    return segs;
}
