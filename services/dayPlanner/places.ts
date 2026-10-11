/**
 * places — where Plan Your Day's stops come from (build 124, "Today on the
 * water"). Pure: todayLoader.ts fetches the sources, this merges them.
 *
 * WORLDWIDE FIRST. Every start gets OpenStreetMap anchorages from at most four
 * coarse one-degree reference cells (only the cells leave the phone, never the
 * boat's position). Queensland adds the offline anchorage atlas with its baked
 * land fetch and GBRMPA no-anchoring areas; it wins the dedupe (both use the
 * same osm-node ids). Inside a reviewed region the Whitsundays stops are
 * joined on top by anchorage id: display name, the "Parks" tag, activities,
 * closures and the landing note. The skipper's own saved routes give a real
 * distance where one joins the start to a stop.
 *
 * ONE PLACE, ONE ROW, AND THE REVIEWED STOPS ALWAYS RANKED. The same name
 * within 2.5 NM is one place mapped twice (the atlas has Cid Harbour as an OSM
 * node and as GBRMPA's designated anchorage). Every place with a baked land
 * table is ranked (127-PYD-4: the 40-nearest cap left Butterfly, Blue Pearl,
 * Nelly and Cateran unranked at Airlie); only OpenStreetMap points that need
 * a coastline ray-cast are held to the 40 nearest. Reviewed stops always are.
 *
 * WHAT IS NEVER A DESTINATION: a marina (it only names the start and feeds the
 * "leaving a marina" line), a passage, channel, sound or flats the atlas marks
 * as no anchorage (likelyAnchorage false; not listed at all, unless reviewed),
 * a no-anchoring area or an OpenStreetMap point that
 * reports a restriction (both go to Not today with "no anchoring here"), an
 * approximate way/relation centre, a mooring, and anything under a mile from
 * the start. Closures depend on the planned date, so they are applied by
 * splitClosed() before anything is scored, never baked in here.
 *
 * SHELTER IS LAND ONLY. Atlas points carry their baked land table; OpenStreetMap
 * points get one ray-cast against the OSM coastline (km → NM, capped at 15).
 * No coastline, no table: the stop reads "Shelter not known". Reefs are never
 * counted as shelter.
 *
 * DISTANCE IS SAID HONESTLY. A saved route gives its own length. Otherwise the
 * straight line is stretched: × 1.15 clear of the coastline, × 1.4 when the
 * line crosses it, × 1.3 when the coastline is unknown — and it is always
 * "about".
 */
import type { AnchorageProps } from '../anchorages/AnchorageService';
import {
    referenceTiles,
    validCachedReference,
    type CruisingPoint,
    type ReferenceTile,
} from '../anchorages/cruisingReference';
import { routeLengthNm } from '../routeProgress';
import { assessFetch, type Segment } from '../weather/shelter/shelterGeometry';
import { calculateDistance } from '../../utils/navigationCalculations';
import {
    SHARED_DESTINATION_NOTES,
    type CompassPoint,
    type DayPlannerActivity,
    type DayPlannerDestination,
} from './destinations';
import { DAY_PLANNER_REGIONS, findDayPlannerRegion, type DayPlannerRegion } from './regions';

/** Only this many OpenStreetMap points needing a ray-cast are ranked; the rest are named in All places. */
export const PLACE_LIMIT = 40;
/** Closer than this to the start is not a day out. */
export const NEAR_START_NM = 1;
/** A saved route's ends, a start's name and a marina are matched within this. */
export const JOIN_NM = 0.5;
/** An OpenStreetMap place retrieved longer ago than this is shown with its date. */
export const MAPPED_DATED_AFTER_MS = 24 * 60 * 60_000;
export const REACH_MAX_NM = 30;
export const REACH_MIN_NM = 3;
export const MAX_REFERENCE_TILES = 4;
export const DISTANCE_FACTORS = Object.freeze({ clear: 1.15, crosses: 1.4, unknown: 1.3 });
/** The land fetch table is capped where the atlas caps its own. */
export const FETCH_CAP_NM = 15;
const NM_KM = 1.852;
/** The same name this close is the same place, mapped twice. */
export const SAME_PLACE_NM = 2.5;
const sameNameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type AtlasFeature = GeoJSON.Feature<GeoJSON.Point, AnchorageProps>;
/** 'routed': the stop she opened, routed on her charts (127-PYD-2), on the plan only, never a candidate's. */
export type DistanceBasis = 'saved' | 'routed' | 'clear' | 'crosses' | 'unknown';

export interface LatLon {
    lat: number;
    lon: number;
}

export interface NamedPoint extends LatLon {
    id: string;
    name: string;
}

export interface SavedRouteLike {
    name: string;
    points: readonly LatLon[];
}

export interface SavedRouteMatch {
    name: string;
    /** Oriented start → stop, whichever way round it was saved. */
    points: LatLon[];
    lengthNm: number;
}

export interface DistanceEstimate {
    basis: DistanceBasis;
    /** The stretch on a straight line; 1 for a saved route. */
    factor: number;
    straightNm: number;
    /** One way, NM: the saved route's length, or the stretched straight line. */
    nm: number;
    route?: SavedRouteMatch;
}

/** A routed leg (127-PYD-2): the engine's line start → stop, its own distance; memory only. */
export type RoutedLeg = DistanceEstimate & { basis: 'routed'; route: SavedRouteMatch };

export interface PlaceClosure {
    fromDate: string;
    throughDate: string;
    reason: string;
    sourceUrl: string;
}

/** What a reviewed stop adds. The reviewer is named from its source label. */
export interface ReviewedStop {
    destinationId: string;
    /** "Queensland Parks": who reviewed it, for the tag and the reasons. */
    parks: string;
    activities: readonly DayPlannerActivity[];
    closures: readonly PlaceClosure[];
    landingTide?: 'mid-to-high';
    /** The stop's own notes from its source, access first: shown on its
     *  detail (Cid Harbour's shark warning, Chance Bay's south-easterlies).
     *  The catalogue's shared boilerplate is left out: "Not a clearance" and
     *  Sources' "Not checked" say it once. */
    accessNotes: readonly string[];
    uncertaintyNotes: readonly string[];
    /** Winds its access note says make access difficult: the stop is held at "Some chop" in them. */
    accessWinds?: readonly CompassPoint[];
    sourceLabel: string;
    sourceUrl: string;
}

export interface PlaceCandidate extends LatLon {
    id: string;
    name: string;
    source: 'atlas' | 'osm';
    /** 36 sectors × 10°, NM to the first land; null = shelter not known. */
    fetchLandNM: readonly number[] | null;
    straightNm: number;
    distance: DistanceEstimate;
    reviewed?: ReviewedStop;
    /** An OpenStreetMap place retrieved over 24 h ago: when it was mapped. */
    mappedAtMs?: number;
}

export interface PlaceExclusion {
    id: string;
    name: string;
    reason: string;
    straightNm: number;
}

export interface GatherPlacesInput {
    start: LatLon;
    nowMs: number;
    /** Places further than this in a straight line are left out. */
    radiusNm: number;
    atlas: readonly AtlasFeature[];
    /** loadReferenceTile answers, stale ones included. */
    osm: readonly { points: readonly CruisingPoint[]; stale?: boolean }[];
    /** OSM coastline round the start; null when it could not be loaded. */
    coastline: readonly Segment[] | null;
    savedRoutes?: readonly SavedRouteLike[];
    regions?: readonly DayPlannerRegion[];
}

export interface GatheredPlaces {
    /** At most PLACE_LIMIT, nearest first; the reviewed stops always among them. */
    candidates: PlaceCandidate[];
    /** No anchoring, or beyond the nearest PLACE_LIMIT; nearest first. */
    excluded: PlaceExclusion[];
    /** Atlas marinas in range: never destinations. */
    marinas: NamedPoint[];
    /** Every named point, marinas included, for naming the start. */
    named: NamedPoint[];
    /** The oldest retrieval of a dated OpenStreetMap place in use, or null. */
    mapDataFromMs: number | null;
    region: DayPlannerRegion | null;
    coastlineKnown: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validPoint = (p: Partial<LatLon> | null | undefined): p is LatLon =>
    !!p && finite(p.lat) && finite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
const longitude = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;
const distanceNm = (a: LatLon, b: LatLon) => calculateDistance(a.lat, a.lon, b.lat, b.lon);
const table36 = (t: unknown): number[] | null =>
    Array.isArray(t) && t.length === 36 && t.every((v) => finite(v) && v >= 0) ? (t as number[]) : null;

// ── Reach and the reference cells ──────────────────────────────

/**
 * How far a stop can be, in a straight line, and still fit the day: half the
 * sailing time (there and back) at cruising speed for a day trip, all of it
 * less an hour for an overnight stay, both over the 1.15 clear-water stretch.
 */
export function reachRadiusNm(cruiseKts: number, usableH: number, stay: number | 'overnight'): number {
    const raw =
        stay === 'overnight'
            ? (cruiseKts * (usableH - 1)) / DISTANCE_FACTORS.clear
            : (cruiseKts * (usableH - stay)) / 2 / DISTANCE_FACTORS.clear;
    if (!Number.isFinite(raw)) return REACH_MIN_NM;
    return Math.max(REACH_MIN_NM, Math.min(REACH_MAX_NM, raw));
}

/** At most four existing one-degree reference cells, nearest first. Precise
 *  positions stay on the phone; only the public coarse cells are asked for. */
export function dayPlanTiles(start: LatLon, radiusNm: number): { tiles: ReferenceTile[]; truncated: boolean } {
    if (!validPoint(start) || Math.abs(start.lat) > 80 || !(radiusNm > 0)) return { tiles: [], truncated: false };
    const deltaLat = radiusNm / 60;
    const deltaLon = deltaLat / Math.cos((start.lat * Math.PI) / 180);
    const choices: { tile: ReferenceTile; distance: number; centreDistance: number }[] = [];
    for (
        let south = Math.floor(Math.max(-80, start.lat - deltaLat));
        south <= Math.floor(Math.min(80, start.lat + deltaLat));
        south++
    ) {
        for (let west = Math.floor(start.lon - deltaLon); west <= Math.floor(start.lon + deltaLon); west++) {
            const centre = { lat: south + 0.5, lon: longitude(west + 0.5) };
            const nearest = {
                lat: Math.max(south, Math.min(south + 1, start.lat)),
                lon: longitude(Math.max(west, Math.min(west + 1, start.lon))),
            };
            const distance = distanceNm(start, nearest);
            if (distance > radiusNm + 0.1) continue;
            const [tile] = referenceTiles(
                { west: centre.lon, east: centre.lon, south: centre.lat, north: centre.lat },
                9,
            );
            if (tile) choices.push({ tile, distance, centreDistance: distanceNm(start, centre) });
        }
    }
    choices.sort(
        (a, b) =>
            a.distance - b.distance || a.centreDistance - b.centreDistance || a.tile.key.localeCompare(b.tile.key),
    );
    return {
        tiles: choices.slice(0, MAX_REFERENCE_TILES).map(({ tile }) => tile),
        truncated: choices.length > MAX_REFERENCE_TILES,
    };
}

// ── Shelter and distance ───────────────────────────────────────

/** Land-only fetch, 36 sectors, NM to the first coastline (15 = open). Null without a coastline. */
export function landFetchTableNm(lat: number, lon: number, coastline: readonly Segment[] | null): number[] | null {
    if (!coastline) return null;
    const { fetchByBearingKm } = assessFetch(lat, lon, coastline as Segment[], {
        maxKm: FETCH_CAP_NM * NM_KM,
    });
    return fetchByBearingKm.map((km) => Math.min(FETCH_CAP_NM, Math.round((km / NM_KM) * 10) / 10));
}

/** Does the straight line a → b cross any coastline segment? Planar, about a. */
export function crossesCoastline(a: LatLon, b: LatLon, coastline: readonly Segment[]): boolean {
    const cos = Math.cos((a.lat * Math.PI) / 180) || 1e-6;
    const local = (lon: number, lat: number): [number, number] => [longitude(lon - a.lon) * cos, lat - a.lat];
    const [bx, by] = local(b.lon, b.lat);
    const minX = Math.min(0, bx);
    const maxX = Math.max(0, bx);
    const minY = Math.min(0, by);
    const maxY = Math.max(0, by);
    const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) =>
        (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
    for (const seg of coastline) {
        if (!seg || seg.length !== 2) continue;
        const [cx, cy] = local(seg[0][0], seg[0][1]);
        const [dx, dy] = local(seg[1][0], seg[1][1]);
        if (Math.max(cx, dx) < minX || Math.min(cx, dx) > maxX || Math.max(cy, dy) < minY || Math.min(cy, dy) > maxY)
            continue;
        const d1 = cross(cx, cy, dx, dy, 0, 0);
        const d2 = cross(cx, cy, dx, dy, bx, by);
        const d3 = cross(0, 0, bx, by, cx, cy);
        const d4 = cross(0, 0, bx, by, dx, dy);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
    return false;
}

/** A saved route whose ends lie within half a mile of start and stop, either way round; the shortest wins. */
export function matchSavedRoute(
    start: LatLon,
    stop: LatLon,
    routes: readonly SavedRouteLike[] | undefined,
): SavedRouteMatch | null {
    let best: SavedRouteMatch | null = null;
    for (const route of routes ?? []) {
        const points = (route?.points ?? []).filter(validPoint).map((p) => ({ lat: p.lat, lon: p.lon }));
        if (points.length < 2) continue;
        const first = points[0];
        const last = points[points.length - 1];
        let oriented: LatLon[] | null = null;
        if (distanceNm(first, start) <= JOIN_NM && distanceNm(last, stop) <= JOIN_NM) oriented = points;
        else if (distanceNm(last, start) <= JOIN_NM && distanceNm(first, stop) <= JOIN_NM)
            oriented = [...points].reverse();
        if (!oriented) continue;
        const lengthNm = routeLengthNm(oriented);
        if (!(lengthNm > 0)) continue;
        if (!best || lengthNm < best.lengthNm) best = { name: String(route.name ?? ''), points: oriented, lengthNm };
    }
    return best;
}

/** One way, start → stop, with the basis said out loud. */
export function distanceEstimate(
    start: LatLon,
    stop: LatLon,
    coastline: readonly Segment[] | null,
    saved?: SavedRouteMatch | null,
): DistanceEstimate {
    const straightNm = distanceNm(start, stop);
    if (saved) return { basis: 'saved', factor: 1, straightNm, nm: saved.lengthNm, route: saved };
    const basis: DistanceBasis = !coastline
        ? 'unknown'
        : crossesCoastline(start, stop, coastline)
          ? 'crosses'
          : 'clear';
    const factor = DISTANCE_FACTORS[basis];
    return { basis, factor, straightNm, nm: straightNm * factor };
}

// ── Closures ───────────────────────────────────────────────────

function dateParts(date: string): [number, number, number] | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "6–15 Oct", "28 Sep–3 Oct", "6 Oct". */
export function dateRangeLabel(from: string, through: string): string {
    const a = dateParts(from);
    const b = dateParts(through);
    if (!a || !b) return `${from}–${through}`;
    const mon = (p: [number, number, number]) => MONTHS[p[1] - 1];
    if (from === through) return `${a[2]} ${mon(a)}`;
    if (a[0] === b[0] && a[1] === b[1]) return `${a[2]}–${b[2]} ${mon(a)}`;
    if (a[0] === b[0]) return `${a[2]} ${mon(a)}–${b[2]} ${mon(b)}`;
    return `${a[2]} ${mon(a)} ${a[0]}–${b[2]} ${mon(b)} ${b[0]}`;
}

/** "closed 6–15 Oct (Queensland Parks)" when a known closure covers the local date, else null. */
export function closureOn(candidate: Pick<PlaceCandidate, 'reviewed'>, date: string): string | null {
    const reviewed = candidate.reviewed;
    if (!reviewed) return null;
    const closure = reviewed.closures.find((c) => c.fromDate <= date && date <= c.throughDate);
    return closure ? `closed ${dateRangeLabel(closure.fromDate, closure.throughDate)} (${reviewed.parks})` : null;
}

/** Closures first, before anything is scored: a closed stop is listed with its reason and never ranked. */
export function splitClosed(
    candidates: readonly PlaceCandidate[],
    date: string,
): { open: PlaceCandidate[]; closed: PlaceExclusion[] } {
    const open: PlaceCandidate[] = [];
    const closed: PlaceExclusion[] = [];
    for (const candidate of candidates) {
        const reason = closureOn(candidate, date);
        if (reason) closed.push({ id: candidate.id, name: candidate.name, reason, straightNm: candidate.straightNm });
        else open.push(candidate);
    }
    return { open, closed };
}

// ── Naming the start ───────────────────────────────────────────

/** "20.27°S 148.72°E". */
export function formatLatLon(lat: number, lon: number): string {
    return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
}

function nearestWithin<P extends LatLon>(start: LatLon, points: readonly P[], withinNm: number): P | null {
    let best: P | null = null;
    let bestNm = Infinity;
    for (const p of points) {
        if (!validPoint(p)) continue;
        const nm = distanceNm(start, p);
        if (nm <= withinNm && nm < bestNm) {
            best = p;
            bestNm = nm;
        }
    }
    return best;
}

/** The nearest named atlas or OSM point (marinas included) within half a
 *  mile; else a saved place within half a mile; else the position. */
export function nameStart(
    start: LatLon,
    named: readonly (LatLon & { name: string })[],
    savedPlaces: readonly (LatLon & { name: string })[],
): string {
    const place =
        nearestWithin(
            start,
            named.filter((p) => !!p.name?.trim()),
            JOIN_NM,
        ) ??
        nearestWithin(
            start,
            savedPlaces.filter((p) => !!p.name?.trim()),
            JOIN_NM,
        );
    return place ? place.name.trim() : formatLatLon(start.lat, start.lon);
}

/** The marina the start is in or beside, for the "leaving a marina" line. */
export function marinaNear(start: LatLon, marinas: readonly NamedPoint[]): NamedPoint | null {
    return nearestWithin(start, marinas, JOIN_NM);
}

// ── The merge ──────────────────────────────────────────────────

/** Explicit restrictions never become suggested anchorages; free text is read conservatively. */
function restricted(point: CruisingPoint): boolean {
    return (
        !!point.restrictionNotes?.length ||
        /(?:^|[;,])\s*(?:no|private|restricted|military|customers|permit|permission|destination)\s*(?:$|[;,])/i.test(
            point.access,
        ) ||
        /\b(?:private|restricted|military|no\s+access|(?:permit|permission)\s+required)\b/i.test(point.access) ||
        /\b(?:no[ -]?anchor(?:ing|age)?|(?:do\s+not|must\s+not|not\s+permitted\s+to|not\s+allowed\s+to)\s+anchor|anchor(?:ing|age)?\s+(?:is\s+)?(?:not\s+(?:allowed|permitted)|prohibited|forbidden|banned)|private|no\s+access|restricted|exclusion\s+zone|closed)\b/i.test(
            point.notes,
        )
    );
}

interface RawPlace extends LatLon {
    id: string;
    name: string;
    source: 'atlas' | 'osm';
    fetchLandNM: readonly number[] | null;
    noAnchoring: boolean;
    mappedAtMs?: number;
    /** Its land table came with it (the atlas's, or a cached one): no ray-cast, so never capped. */
    baked: boolean;
}

function reviewedOf(destination: DayPlannerDestination): ReviewedStop {
    return {
        destinationId: destination.id,
        parks: destination.sourceLabel.split(' · ')[0].trim() || destination.sourceLabel,
        activities: destination.activities,
        closures: destination.knownClosures ?? [],
        ...(destination.landingTide ? { landingTide: destination.landingTide } : {}),
        accessNotes: destination.accessNotes.filter((note) => !SHARED_DESTINATION_NOTES.has(note)),
        uncertaintyNotes: destination.uncertaintyNotes.filter((note) => !SHARED_DESTINATION_NOTES.has(note)),
        ...(destination.accessWinds?.length ? { accessWinds: [...destination.accessWinds] } : {}),
        sourceLabel: destination.sourceLabel,
        sourceUrl: destination.sourceUrl,
    };
}

function regionAt(start: LatLon, regions: readonly DayPlannerRegion[]): DayPlannerRegion | null {
    try {
        return findDayPlannerRegion(start, regions) ?? null;
    } catch {
        // Overlapping or invalid registry data fails closed: no reviewed extras.
        return null;
    }
}

export function gatherPlaces(input: GatherPlacesInput): GatheredPlaces {
    const { start, nowMs, radiusNm, coastline } = input;
    const empty: GatheredPlaces = {
        candidates: [],
        excluded: [],
        marinas: [],
        named: [],
        mapDataFromMs: null,
        region: null,
        coastlineKnown: !!coastline,
    };
    if (!validPoint(start) || !(radiusNm > 0)) return empty;
    const region = regionAt(start, input.regions ?? DAY_PLANNER_REGIONS);
    // A JOIN on the anchorage id: a reviewed stop needs its mapped record (the
    // atlas ships offline, so in Queensland it is there).
    const reviewedByAnchorage = new Map<string, DayPlannerDestination>(
        (region?.destinations ?? []).map((destination) => [destination.anchorageId, destination]),
    );
    const byId = new Map<string, RawPlace>();
    const notPlaces = new Set<string>();
    const marinas: NamedPoint[] = [];
    const named: NamedPoint[] = [];

    for (const feature of input.atlas) {
        const props = feature?.properties;
        const [lon, lat] = feature?.geometry?.coordinates ?? [];
        if (!props || typeof props.id !== 'string' || !validPoint({ lat, lon })) continue;
        const point = { id: props.id, name: (props.name ?? '').trim(), lat, lon };
        if (point.name) named.push(point);
        if (props.kind === 'marina') {
            if (distanceNm(start, point) <= radiusNm) marinas.push({ ...point, name: point.name || 'Marina' });
            continue;
        }
        if (props.kind !== 'anchorage' && props.kind !== 'designated_anchorage') continue;
        // "Molle Channel", "Unsafe Pass": the atlas's own word that they are no place to stop.
        if (props.likelyAnchorage === false && !reviewedByAnchorage.has(props.id)) {
            notPlaces.add(props.id);
            continue;
        }
        if (byId.has(props.id)) continue;
        const fetchLandNM = table36(props.fetchLandNM);
        byId.set(props.id, {
            ...point,
            name: point.name || 'Mapped anchorage',
            source: 'atlas',
            fetchLandNM,
            noAnchoring: !!props.noAnchoring,
            baked: !!fetchLandNM,
        });
    }

    for (const result of input.osm) {
        for (const point of result?.points ?? []) {
            if (!validCachedReference(point) || !Array.isArray(point.restrictionNotes)) continue;
            const node = /^osm-node([1-9]\d*)$/.exec(point.id)?.[1];
            if (
                !node ||
                point.approximate ||
                point.kind !== 'anchorage' ||
                point.sourceUrl !== `https://www.openstreetmap.org/node/${node}`
            )
                continue;
            if (point.name.trim())
                named.push({ id: point.id, name: point.name.trim(), lat: point.lat, lon: point.lon });
            // The atlas wins: same id, baked tables, GBRMPA areas (and its no-place-to-stop names).
            if (byId.has(point.id) || notPlaces.has(point.id)) continue;
            const retrievedAt = Date.parse(point.retrievedAt);
            const cached = table36(point.fetchLandNM);
            byId.set(point.id, {
                id: point.id,
                name: point.name.trim() || 'Mapped anchorage',
                lat: point.lat,
                lon: point.lon,
                source: 'osm',
                fetchLandNM: cached ?? landFetchTableNm(point.lat, point.lon, coastline),
                noAnchoring: restricted(point),
                baked: !!cached,
                ...(Number.isFinite(retrievedAt) && nowMs - retrievedAt >= MAPPED_DATED_AFTER_MS
                    ? { mappedAtMs: retrievedAt }
                    : {}),
            });
        }
    }

    const excluded: PlaceExclusion[] = [];
    const anchorable: (RawPlace & { straightNm: number; mappedName: string; reviewed: boolean })[] = [];
    for (const place of byId.values()) {
        const straightNm = distanceNm(start, place);
        if (straightNm < NEAR_START_NM || straightNm > radiusNm) continue;
        const destination = reviewedByAnchorage.get(place.id);
        const name = destination?.name ?? place.name;
        if (place.noAnchoring) {
            excluded.push({ id: place.id, name, reason: 'no anchoring here', straightNm });
            continue;
        }
        anchorable.push({ ...place, name, straightNm, mappedName: place.name, reviewed: !!destination });
    }
    // One place, one row: the atlas holds Cid Harbour twice (the OSM node and
    // GBRMPA's designated anchorage, 1.1 NM apart). The reviewed record wins,
    // then an OpenStreetMap node, then the nearer.
    const preference = (p: (typeof anchorable)[number]) => (p.reviewed ? 0 : p.id.startsWith('osm-node') ? 1 : 2);
    anchorable.sort((a, b) => preference(a) - preference(b) || a.straightNm - b.straightNm || a.id.localeCompare(b.id));
    const kept: typeof anchorable = [];
    for (const place of anchorable) {
        const key = sameNameKey(place.mappedName);
        if (key && kept.some((k) => sameNameKey(k.mappedName) === key && distanceNm(k, place) <= SAME_PLACE_NM))
            continue;
        kept.push(place);
    }
    // The reviewed stops and every place with a baked table are ranked; the
    // nearest OpenStreetMap points needing a ray-cast fill up to the 40 (in the
    // Whitsundays the 40 nearest mapped bays all lie inside 16 NM, and left
    // Butterfly, Blue Pearl, Nelly and Cateran "not ranked").
    kept.sort((a, b) => a.straightNm - b.straightNm || a.id.localeCompare(b.id));
    const always = kept.filter((p) => p.reviewed || p.baked);
    const others = kept.filter((p) => !p.reviewed && !p.baked);
    const room = Math.max(0, PLACE_LIMIT - always.filter((p) => !p.baked).length);
    for (const place of others.slice(room)) {
        excluded.push({
            id: place.id,
            name: place.name,
            reason: `not ranked — ${PLACE_LIMIT} closer places checked first`,
            straightNm: place.straightNm,
        });
    }
    const ranked = [...always, ...others.slice(0, room)].sort(
        (a, b) => a.straightNm - b.straightNm || a.id.localeCompare(b.id),
    );
    const candidates: PlaceCandidate[] = ranked.map((place) => {
        const destination = reviewedByAnchorage.get(place.id);
        const saved = matchSavedRoute(start, place, input.savedRoutes);
        return {
            id: place.id,
            name: place.name,
            lat: place.lat,
            lon: place.lon,
            source: place.source,
            fetchLandNM: place.fetchLandNM,
            straightNm: place.straightNm,
            distance: distanceEstimate(start, place, coastline, saved),
            ...(destination ? { reviewed: reviewedOf(destination) } : {}),
            ...(place.mappedAtMs !== undefined ? { mappedAtMs: place.mappedAtMs } : {}),
        };
    });
    excluded.sort((a, b) => a.straightNm - b.straightNm || a.id.localeCompare(b.id));
    const dated = candidates.flatMap((c) => (c.mappedAtMs !== undefined ? [c.mappedAtMs] : []));
    return {
        candidates,
        excluded,
        marinas,
        named,
        mapDataFromMs: dated.length ? Math.min(...dated) : null,
        region,
        coastlineKnown: !!coastline,
    };
}
