/**
 * Honest From/To names for the public trip picker (Shane 2026-09-28: "the drop
 * down box with the tracks in it only shows dates and nm, could we make that
 * bang a bit more, with from and to").
 *
 * A name is only ever one the log already holds. Nothing is geocoded here and
 * no free text is mined: "Recovered GPS track · Newport to Gladstone" names no
 * departure, because "Newport" is prose, not a place field. The ladder, per
 * end of the trip:
 *
 *   1. The trip's OWN "<Place> · recovered departure|arrival" waypoint.
 *   2. Else the nearest "<Place> · recovered …" waypoint of ANY authorised
 *      trip within 0.25 nm of the trip's first/last fix (trips chain end to
 *      start, so yesterday's arrival names today's departure).
 *   3. Else the nearest published diary location_name within 0.25 nm, with
 *      the region-only names ("Queensland", "Australia") dropped and the
 *      ", Queensland" tail stripped.
 *   4. Else null — the client keeps its date label.
 *
 * A trip whose catalogue start may be the retention edge rather than its
 * departure (start_may_be_clipped) keeps rule 1 only for its From: the first
 * fix inside the window is a point partway through the passage, and a place
 * that happens to lie under it is not where the boat left from.
 *
 * Every candidate the caller passes must already be public: waypoints are
 * re-fenced here to the authorised catalogue ids and diary entries to
 * is_public === true, so a hidden trip's place can never be pinned onto a
 * public one even if a caller's query is widened by mistake.
 *
 * Pure: no I/O, no clock. The time-zone lookup is injected.
 */

/** Rule 2 and 3 radius. Measured live: every honest name sits within 0.19 nm. */
export const PUBLIC_TRIP_PLACE_RADIUS_NM = 0.25;
/** Longer than any place name; longer strings are prose, not a place. */
const MAX_PLACE_NAME_CHARS = 80;
/** Region-only diary names: true, but they name no place on a picker. */
const REGION_ONLY_NAMES = new Set(['queensland', 'australia']);
/** Degrees of latitude per nautical mile. */
const DEG_PER_NM = 1 / 60;
/**
 * How close to the public history edge a catalogue start must sit before it
 * may be that edge rather than a departure. The catalogue clips started_at to
 * the first row inside the window, and the gap before that row is one logging
 * interval: 10 min under way, but 6.8 h overnight on the 18 Sep trip. A real
 * start inside this band only loses a neighbour's or the diary's name for the
 * hours before it would be clipped anyway.
 */
export const PUBLIC_TRIP_START_EDGE_MS = 12 * 3_600_000;

export interface PublicTripFix {
    lat: number;
    lon: number;
}

export interface PublicTripPlaceTrip {
    id: string;
    /** Still under way: its last fix is where the boat is now, not an arrival. */
    active?: boolean;
    /** Its first fix may be the history edge, not the departure: see the ladder. */
    start_may_be_clipped?: boolean;
    first_fix: PublicTripFix | null;
    last_fix: PublicTripFix | null;
}

/** A ship_logs waypoint row, untyped because rows arrive as column bags. */
export interface PublicPlaceWaypoint {
    voyage_id: unknown;
    name: unknown;
    lat: unknown;
    lon: unknown;
    timestamp?: unknown;
}

/** A diary_entries row — only the columns this derivation needs. */
export interface PublicPlaceDiaryEntry {
    location_name: unknown;
    lat: unknown;
    lon: unknown;
    is_public: unknown;
}

export interface PublicTripPlaces {
    from_name: string | null;
    to_name: string | null;
    /** IANA zone at the trip's first fix. */
    time_zone: string | null;
}

export type PublicTimeZoneAt = (lat: number, lon: number) => string | null;

export const NO_PUBLIC_TRIP_PLACES: Readonly<PublicTripPlaces> = Object.freeze({
    from_name: null,
    to_name: null,
    time_zone: null,
});

function cleanText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/** A plausible, publishable position; null island is a missing fix. */
export function publicPlaceFix(lat: unknown, lon: unknown): PublicTripFix | null {
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return null;
    return { lat, lon };
}

/**
 * A ship_logs row fit to be a trip endpoint: the same trackworthy rules the
 * public track and the catalogue RPC apply (no manual entries, no planned
 * route, no COG turn pins, no implausible fix).
 */
export function publicTrackworthyFix(row: Record<string, unknown>): PublicTripFix | null {
    if (row.entry_type === 'manual') return null;
    if (row.source === 'planned_route') return null;
    const voyageId = typeof row.voyage_id === 'string' ? row.voyage_id.trim() : '';
    if (!voyageId || voyageId.startsWith('planned_')) return null;
    const name = typeof row.waypoint_name === 'string' ? row.waypoint_name : '';
    const notes = typeof row.notes === 'string' ? row.notes : '';
    if (name.startsWith('COG ') || notes.startsWith('Auto: COG')) return null;
    return publicPlaceFix(row.latitude, row.longitude);
}

/**
 * The waypoint rows among ship_logs rows (column bags), as ladder candidates.
 * Every recovered mark is timestamped exactly at its trip's first or last fix,
 * so the endpoint read already carries them; no separate scan is needed.
 * Planned-route rows are never a place the boat was.
 */
export function publicPlaceMarksFromRows(rows: readonly Record<string, unknown>[]): PublicPlaceWaypoint[] {
    const marks: PublicPlaceWaypoint[] = [];
    for (const row of rows) {
        if (row.entry_type !== 'waypoint' || row.source === 'planned_route') continue;
        if (typeof row.waypoint_name !== 'string' || !row.waypoint_name.trim()) continue;
        marks.push({
            voyage_id: row.voyage_id,
            name: row.waypoint_name,
            lat: row.latitude,
            lon: row.longitude,
            timestamp: row.timestamp,
        });
    }
    return marks;
}

/**
 * True when a catalogue started_at may be the public history edge (`since`)
 * rather than the trip's departure. Unparsable input answers false: there is
 * then no edge to be clipped by.
 */
export function publicTripStartMayBeClipped(
    startedAt: string | null | undefined,
    since: string | null | undefined,
    edgeMs: number = PUBLIC_TRIP_START_EDGE_MS,
): boolean {
    const start = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
    const edge = typeof since === 'string' ? Date.parse(since) : Number.NaN;
    if (!Number.isFinite(start) || !Number.isFinite(edge)) return false;
    return start - edge < edgeMs;
}

/** Great-circle distance in nautical miles (same sphere as the passage maths). */
export function distanceNm(a: PublicTripFix, b: PublicTripFix): number {
    const R = 6_371_000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return (2 * R * Math.asin(Math.min(1, Math.sqrt(h)))) / 1852;
}

/**
 * "<Place> · recovered departure|arrival" → the place and its role. Anything
 * else — Voyage Start/End, "Recovered GPS track · …", "App recording began ·
 * original mark" — names no place.
 */
export function recoveredWaypointPlace(name: unknown): { place: string; role: 'departure' | 'arrival' } | null {
    if (typeof name !== 'string') return null;
    const match = cleanText(name).match(/^(.+?) · recovered (departure|arrival)$/i);
    if (!match) return null;
    const place = cleanText(match[1]);
    if (!place || place.includes('·') || place.length > MAX_PLACE_NAME_CHARS) return null;
    return { place, role: match[2].toLowerCase() as 'departure' | 'arrival' };
}

/**
 * A diary location_name as a picker place, or null when it names no place.
 * The app writes "<place>, <state>" from its reverse geocoder, a bare state
 * when the geocoder had nothing finer, "Anchored in Nm of water — <place>"
 * under anchor watch, and a formatted coordinate when offline.
 */
export function publicDiaryPlaceName(locationName: unknown): string | null {
    if (typeof locationName !== 'string') return null;
    let name = cleanText(locationName);
    const anchored = name.match(/^Anchored in [^—]*—\s*(.+)$/i);
    if (anchored) name = cleanText(anchored[1]);
    else if (/^Anchored in /i.test(name)) return null;
    name = name.replace(/,\s*Australia$/i, '').trim();
    name = name.replace(/,\s*Queensland$/i, '').trim();
    if (!name || REGION_ONLY_NAMES.has(name.toLowerCase())) return null;
    // "20.2701°S, 148.7232°E" is a position, not a place.
    if (/\d/.test(name) && /^[\d\s.,°'"′″+\-NSEWnsew]+$/.test(name)) return null;
    return name.length <= MAX_PLACE_NAME_CHARS ? name : null;
}

/**
 * A safe, memoised IANA zone lookup. A lookup that throws or answers with a
 * zone the runtime cannot format yields null rather than a broken label.
 */
export function createPublicTimeZoneAt(lookup: (lat: number, lon: number) => string): PublicTimeZoneAt {
    const memo = new Map<string, string | null>();
    return (lat: number, lon: number): string | null => {
        const fix = publicPlaceFix(lat, lon);
        if (!fix) return null;
        const key = `${fix.lat},${fix.lon}`;
        if (memo.has(key)) return memo.get(key) ?? null;
        let zone: string | null = null;
        try {
            const candidate = lookup(fix.lat, fix.lon);
            if (typeof candidate === 'string' && candidate) {
                new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0);
                zone = candidate;
            }
        } catch {
            zone = null;
        }
        memo.set(key, zone);
        return zone;
    };
}

type Candidate = {
    name: string;
    fix: PublicTripFix;
    voyageId: string;
    role: 'departure' | 'arrival' | null;
    ms: number;
};

function nearestWithin(candidates: readonly Candidate[], at: PublicTripFix | null): string | null {
    if (!at) return null;
    let best: { name: string; distance: number } | null = null;
    for (const candidate of candidates) {
        const distance = distanceNm(at, candidate.fix);
        if (distance > PUBLIC_TRIP_PLACE_RADIUS_NM) continue;
        if (
            !best || distance < best.distance ||
            (distance === best.distance && candidate.name.localeCompare(best.name) < 0)
        ) {
            best = { name: candidate.name, distance };
        }
    }
    return best?.name ?? null;
}

/** Rule 1: the trip's own recovered mark for this end — the one nearest the fix, else the outermost in time. */
function ownRecovered(
    own: readonly Candidate[],
    role: 'departure' | 'arrival',
    at: PublicTripFix | null,
): string | null {
    const marks = own.filter((candidate) => candidate.role === role);
    if (marks.length === 0) return null;
    const ranked = [...marks].sort((left, right) => {
        if (at) {
            const byDistance = distanceNm(at, left.fix) - distanceNm(at, right.fix);
            if (byDistance !== 0) return byDistance;
        }
        const byTime = role === 'departure' ? left.ms - right.ms : right.ms - left.ms;
        if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
        return left.name.localeCompare(right.name);
    });
    return ranked[0].name;
}

/**
 * From/To names and the local zone for every authorised trip, keyed by trip id.
 * `trips` IS the authority: a waypoint whose voyage is not in it is ignored.
 */
export function derivePublicTripPlaces(
    trips: readonly PublicTripPlaceTrip[],
    waypoints: readonly PublicPlaceWaypoint[],
    diary: readonly PublicPlaceDiaryEntry[],
    timeZoneAt: PublicTimeZoneAt = () => null,
): Map<string, PublicTripPlaces> {
    const authorised = new Set(trips.map((trip) => trip.id));

    const marks: Candidate[] = [];
    for (const waypoint of waypoints) {
        const voyageId = typeof waypoint.voyage_id === 'string' ? waypoint.voyage_id.trim() : '';
        if (!voyageId || !authorised.has(voyageId)) continue;
        const recovered = recoveredWaypointPlace(waypoint.name);
        const fix = publicPlaceFix(waypoint.lat, waypoint.lon);
        if (!recovered || !fix) continue;
        const ms = typeof waypoint.timestamp === 'string' ? Date.parse(waypoint.timestamp) : Number.NaN;
        marks.push({ name: recovered.place, fix, voyageId, role: recovered.role, ms });
    }

    const diaryPlaces: Candidate[] = [];
    for (const entry of diary) {
        if (entry.is_public !== true) continue;
        const name = publicDiaryPlaceName(entry.location_name);
        const fix = publicPlaceFix(entry.lat, entry.lon);
        if (!name || !fix) continue;
        diaryPlaces.push({ name, fix, voyageId: '', role: null, ms: Number.NaN });
    }

    const places = new Map<string, PublicTripPlaces>();
    for (const trip of trips) {
        const own = marks.filter((mark) => mark.voyageId === trip.id);
        // A clipped start is a point partway through the passage: only the
        // trip's own departure mark can still say where it left from.
        const fromName = ownRecovered(own, 'departure', trip.first_fix) ??
            (trip.start_may_be_clipped
                ? null
                : (nearestWithin(marks, trip.first_fix) ?? nearestWithin(diaryPlaces, trip.first_fix)));
        // A trip still under way has not arrived anywhere: the place nearest
        // the boat right now is not its destination.
        const toName = trip.active ? null : (
            ownRecovered(own, 'arrival', trip.last_fix) ??
                nearestWithin(marks, trip.last_fix) ??
                nearestWithin(diaryPlaces, trip.last_fix)
        );
        places.set(trip.id, {
            from_name: fromName,
            to_name: toName,
            time_zone: trip.first_fix ? timeZoneAt(trip.first_fix.lat, trip.first_fix.lon) : null,
        });
    }
    return places;
}

/** Which of the handler's reads came back. */
export interface PublicTripPlaceReads {
    /** The endpoint rows, which also carry every recovered mark. */
    fixes: boolean;
    /** The published diary names near the ends (rule 3). */
    diary: boolean;
}

/**
 * The ladder over whatever the handler managed to read, never a different
 * name from the full ladder:
 *
 * - Endpoint rows unreadable: every name null (the zone, a fact about a fix
 *   the request already held, stays). A ladder without its marks could name
 *   an end from the diary that the marks would have named differently.
 * - Only the diary unreadable: the ladder without rule 3. Rule 3 runs only
 *   where rules 1 and 2 found nothing, so this can turn a name into null but
 *   never into another name.
 */
export function derivePublicTripPlacesFromReads(
    trips: readonly PublicTripPlaceTrip[],
    waypoints: readonly PublicPlaceWaypoint[],
    diary: readonly PublicPlaceDiaryEntry[],
    timeZoneAt: PublicTimeZoneAt,
    reads: PublicTripPlaceReads,
): Map<string, PublicTripPlaces> {
    const places = derivePublicTripPlaces(trips, waypoints, reads.diary ? diary : [], timeZoneAt);
    if (reads.fixes) return places;
    return new Map(
        [...places].map(([id, place]) => [id, { ...NO_PUBLIC_TRIP_PLACES, time_zone: place.time_zone }]),
    );
}

/**
 * PostgREST `or=` boxes around each endpoint, a little wider than the radius
 * so the exact great-circle test above has the final say. A box that would
 * cross the antimeridian drops its longitude bounds rather than miss.
 */
export function publicPlaceSearchBoxes(endpoints: readonly PublicTripFix[]): string[] {
    const pad = (PUBLIC_TRIP_PLACE_RADIUS_NM + 0.05) * DEG_PER_NM;
    const seen = new Set<string>();
    const boxes: string[] = [];
    for (const point of endpoints) {
        const fix = publicPlaceFix(point.lat, point.lon);
        if (!fix) continue;
        const latMin = Math.max(-90, fix.lat - pad);
        const latMax = Math.min(90, fix.lat + pad);
        const lonPad = pad / Math.max(Math.cos((fix.lat * Math.PI) / 180), 0.05);
        const lonMin = fix.lon - lonPad;
        const lonMax = fix.lon + lonPad;
        const parts = [`latitude.gte.${latMin.toFixed(6)}`, `latitude.lte.${latMax.toFixed(6)}`];
        if (lonMin >= -180 && lonMax <= 180) {
            parts.push(`longitude.gte.${lonMin.toFixed(6)}`, `longitude.lte.${lonMax.toFixed(6)}`);
        }
        const box = `and(${parts.join(',')})`;
        if (seen.has(box)) continue;
        seen.add(box);
        boxes.push(box);
    }
    return boxes;
}

/** Fixed-size slices, so id/timestamp lists never outgrow a request URL. */
export function inPublicPlaceBatches<T>(items: readonly T[], size: number): T[][] {
    if (!Number.isInteger(size) || size < 1) throw new Error('Invalid batch size');
    const batches: T[][] = [];
    for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
    return batches;
}
