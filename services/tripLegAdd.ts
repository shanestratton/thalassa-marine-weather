/**
 * Adding leg 2, 3, 4… of a trip from any saved route or any leg of a past
 * trip (126-16a; Shane 2026-10-09: "it is very difficult to add a leg from a
 * previous trip or route, we need to be able to do that easily not just the
 * first leg. but the 2nd and 3rd and 4th etc.").
 *
 * THE RULE: an added leg is a COPY. It opens in the tracer with its first pin
 * locked on the previous leg's arrival, and the tracer's own Save checks it and
 * writes it (the release gate, the Log mirror and the Passage Planning row in
 * one go). The copy holds pins and a name only. It never carries the source's
 * id, chain fields, Log or Passage ids, check or Auto evidence: carrying the
 * ids would make deleting the copy cascade into the source's Log rows
 * (deleteTrace → deleteSavedRoutePassageGraph), and a check is bound to the
 * exact line it graded.
 *
 * The join, by great-circle distance from the source's start to the lock:
 *  - within REVERSE_JOIN_NM (0.25 NM, berth scale): pin 0 moves onto the lock;
 *  - up to LEG_JOIN_MAX_NM (2 NM): the lock becomes a new first pin, a joining
 *    run the route check grades like any other leg (land, depth, hazards);
 *  - further: not offered, and the picker says how far it starts.
 * This deliberately differs from the return-trip flow's "never bridge": there
 * the app picks the line; here the skipper picked it and sees the run before
 * Save.
 *
 * Pure: no React, no storage writes. Every function here is a decision.
 */
import { reversedLegName, stripRouteBadges } from './routeNameParts';
import {
    destNameFromRouteName,
    displayRouteLabel,
    groupTracesByTrip,
    legBadgeOrdinal,
    nextLegSeed,
    type NextLegSeed,
    type SavedTrace,
    type TracePoint,
    type TripGroup,
} from './routeTracer';
import { REVERSE_JOIN_NM, distanceNM, findTripGroup, isExactReverse, legInSlot, tripName } from './tripReverse';

/** Furthest a source may start from the lock and still be offered. */
export const LEG_JOIN_MAX_NM = 2;
/** The on-device route library's cap (capSavedTracesPreservingTrips's default). */
export const SAVED_ROUTE_LIBRARY_CAP = 50;
/** Every added leg is a row: say so as the library nears its cap. */
export const LIBRARY_WARN_AT = 45;
/** "Further away" lists the nearest few; the search finds the rest. */
const FURTHER_AWAY_MAX = 20;

export type LegDirection = 'forward' | 'reverse';

export interface LegJoin {
    /** 'snap': pin 0 moved onto the lock. 'run': a new first pin, a joining run. */
    kind: 'snap' | 'run';
    nm: number;
}

export interface LegCopy {
    /** The source's pins ({lat, lon} only), the other way round for 'reverse',
     *  starting exactly on the lock. */
    points: TracePoint[];
    /** Trip badges gone; places flipped for 'reverse'. */
    name: string;
    destName: string | null;
    /** What was copied, for the flash and the reversal note. */
    sourceLabel: string;
    join: LegJoin;
}

export interface LegCopyRefusal {
    refused: true;
    gapNm: number;
    /** 'far': starts beyond LEG_JOIN_MAX_NM. 'one-place': nothing left but the lock. */
    why: 'far' | 'one-place';
}

const first = (points: readonly TracePoint[]): TracePoint => points[0];
const last = (points: readonly TracePoint[]): TracePoint => points[points.length - 1];
const samePlace = (a: TracePoint, b: TracePoint, deg = 1e-9): boolean =>
    Math.abs(a.lat - b.lat) <= deg && Math.abs(a.lon - b.lon) <= deg;

function joinFor(gapNm: number): LegJoin | null {
    if (!Number.isFinite(gapNm)) return null;
    if (gapNm <= REVERSE_JOIN_NM) return { kind: 'snap', nm: gapNm };
    if (gapNm <= LEG_JOIN_MAX_NM) return { kind: 'run', nm: gapNm };
    return null;
}

function ordinalOf(trace: Pick<SavedTrace, 'legOrdinal' | 'name'>): number {
    return trace.legOrdinal ?? legBadgeOrdinal(trace.name) ?? 1;
}

/**
 * The copy of `source` that goes into a locked slot at `anchor`, or why not.
 * See the join rule above.
 */
export function legCopyForSlot(
    source: Pick<SavedTrace, 'points' | 'name' | 'tripId' | 'legOrdinal' | 'destName'>,
    anchor: TracePoint,
    direction: LegDirection,
): LegCopy | LegCopyRefusal {
    const pins = Array.isArray(source.points) ? source.points : [];
    const base = (direction === 'reverse' ? [...pins].reverse() : pins).map((p) => ({ lat: p.lat, lon: p.lon }));
    if (base.length < 2) return { refused: true, gapNm: Number.POSITIVE_INFINITY, why: 'one-place' };
    const gapNm = distanceNM(first(base), anchor);
    const join = joinFor(gapNm);
    if (!join) return { refused: true, gapNm, why: 'far' };
    const lock = { lat: anchor.lat, lon: anchor.lon };
    const points = join.kind === 'snap' ? [lock, ...base.slice(1)] : [lock, ...base];
    if (points.every((p) => samePlace(p, lock))) return { refused: true, gapNm, why: 'one-place' };
    const name = direction === 'reverse' ? reversedLegName(source.name) : stripRouteBadges(source.name);
    return {
        points,
        name,
        destName: destNameFromRouteName(name) ?? (direction === 'forward' ? (source.destName ?? null) : null),
        sourceLabel: displayRouteLabel(source),
        join,
    };
}

/** Accents and case folded, as the trip and route searches compare text:
 *  NFD with the combining marks stripped, so "cadiz" finds "Cádiz", plus the
 *  letters NFD does not split ("tromso" finds "Tromsø", "lodz" finds "Łódź"). */
const FOLD: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };
export function normaliseSearch(text: string): string {
    return text
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLocaleLowerCase()
        .replace(/[øæœßłđðþı]/g, (c) => FOLD[c] ?? c)
        .replace(/\s+/g, ' ')
        .trim();
}

/** A trip matches when its label or any leg's name holds the query. */
export function tripMatches(group: TripGroup, query: string): boolean {
    const wanted = normaliseSearch(query);
    if (!wanted) return true;
    return [group.label, ...group.legs.map((leg) => leg.name)].some((text) => normaliseSearch(text).includes(wanted));
}

export function routeLengthNm(points: readonly TracePoint[]): number {
    let nm = 0;
    for (let i = 1; i < points.length; i++) nm += distanceNM(points[i - 1], points[i]);
    return nm;
}

function stamp(trace: SavedTrace): number {
    const value = Date.parse(trace.updatedAt ?? trace.createdAt);
    return Number.isFinite(value) ? value : 0;
}

/** Trips, newest first by the latest stamp of any leg. A single route is a
 *  one-leg trip (groupTracesByTrip). */
export function tripsByNewest(traces: readonly SavedTrace[]): TripGroup[] {
    return groupTracesByTrip(traces)
        .map((group) => ({ group, newest: Math.max(...group.legs.map(stamp)) }))
        .sort((a, b) => b.newest - a.newest)
        .map(({ group }) => group);
}

/** One line the picker can offer as the next leg. */
export interface AddLegRow {
    trace: SavedTrace;
    direction: LegDirection;
    /** Distance from the end that would sail first to the lock. */
    gapNm: number;
    /** How it joins; null for a row too far away to offer. */
    join: LegJoin | null;
    /** "your saved route", or "leg 2 of Lyttelton - Akaroa". */
    sourceText: string;
    /** The source's own length. */
    lengthNm: number;
}

export interface AddLegSections {
    /** Saved lines starting at the lock, sailed as they are. */
    startsHere: AddLegRow[];
    /** Saved lines ending at the lock, sailed the other way. */
    endsHere: AddLegRow[];
    /** The rest, nearer end first, at most FURTHER_AWAY_MAX: shown, not offered. */
    furtherAway: AddLegRow[];
}

/**
 * What can be the leg after `after`, from its arrival. `after` itself and its
 * exact reverse twin are left out (sailing either just goes back), as are rows
 * with no line. Each section runs nearest first, then newest. `query` matches a
 * route's name or its trip's label, accents and case folded.
 */
export function addLegSections(traces: readonly SavedTrace[], after: SavedTrace, query = ''): AddLegSections {
    const sections: AddLegSections = { startsHere: [], endsHere: [], furtherAway: [] };
    const seed = nextLegSeed(after);
    if (!seed) return sections;
    const anchor = seed.anchor;
    const placeOf = new Map<string, { position: number; group: TripGroup }>();
    for (const group of groupTracesByTrip(traces)) {
        group.legs.forEach((leg, index) => placeOf.set(leg.id, { position: index + 1, group }));
    }
    const wanted = normaliseSearch(query);
    for (const trace of traces) {
        if (!Array.isArray(trace.points) || trace.points.length < 2) continue;
        if (trace.id === after.id || isExactReverse(trace.points, after.points)) continue;
        const place = placeOf.get(trace.id);
        if (wanted && ![trace.name, place?.group.label ?? ''].some((text) => normaliseSearch(text).includes(wanted))) {
            continue;
        }
        const base = {
            trace,
            sourceText:
                place && place.group.legs.length > 1
                    ? `leg ${place.position} of ${tripName(place.group)}`
                    : 'your saved route',
            lengthNm: routeLengthNm(trace.points),
        };
        const forwardGap = distanceNM(first(trace.points), anchor);
        const reverseGap = distanceNM(last(trace.points), anchor);
        let offered = false;
        for (const [direction, gapNm, bucket] of [
            ['forward', forwardGap, sections.startsHere],
            ['reverse', reverseGap, sections.endsHere],
        ] as const) {
            const join = joinFor(gapNm);
            if (!join || 'refused' in legCopyForSlot(trace, anchor, direction)) continue;
            bucket.push({ ...base, direction, gapNm, join });
            offered = true;
        }
        if (!offered) {
            const reverse = reverseGap < forwardGap;
            sections.furtherAway.push({
                ...base,
                direction: reverse ? 'reverse' : 'forward',
                gapNm: reverse ? reverseGap : forwardGap,
                join: null,
            });
        }
    }
    const order = (a: AddLegRow, b: AddLegRow): number =>
        Math.abs(a.gapNm - b.gapNm) > 1e-9 ? a.gapNm - b.gapNm : stamp(b.trace) - stamp(a.trace);
    sections.startsHere.sort(order);
    sections.endsHere.sort(order);
    sections.furtherAway = sections.furtherAway.sort(order).slice(0, FURTHER_AWAY_MAX);
    return sections;
}

/**
 * Where an opened leg sits in its trip, so the tracer keeps it there: the
 * slot's seed with the lock on the leg's OWN first pin. For a welded leg that
 * is exactly the previous leg's arrival; a leg that starts off the chain keeps
 * its own start, so opening it moves nothing. Null for leg 1, a standalone
 * route, and a leg whose previous leg is not on this device: those open free.
 */
export function slotSeedForLeg(traces: readonly SavedTrace[], trace: SavedTrace): NextLegSeed | null {
    const tripId = trace.tripId;
    if (!tripId || !Array.isArray(trace.points) || trace.points.length < 2) return null;
    const ordinal = ordinalOf(trace);
    if (ordinal < 2) return null;
    const previous = traces.find(
        (t) =>
            t.id !== trace.id &&
            (t.tripId ?? t.id) === tripId &&
            ordinalOf(t) === ordinal - 1 &&
            Array.isArray(t.points) &&
            t.points.length >= 2,
    );
    const from = previous ? nextLegSeed(previous) : null;
    if (!from) return null;
    const start = first(trace.points);
    return { tripId, ordinal, fromName: from.fromName, anchor: { lat: start.lat, lon: start.lon } };
}

/** How far a slot's lock sits from the previous leg's arrival (0 when welded),
 *  or null when that leg is not on this device. */
export function slotGapNm(traces: readonly SavedTrace[], seed: NextLegSeed): number | null {
    const previous = traces.find(
        (t) => (t.tripId ?? t.id) === seed.tripId && ordinalOf(t) === seed.ordinal - 1 && t.points?.length >= 2,
    );
    return previous ? distanceNM(last(previous.points), seed.anchor) : null;
}

/** The gap in NM at each joint of a trip (legs.length - 1 of them). */
export function tripJoints(group: TripGroup): number[] {
    const joints: number[] = [];
    for (let i = 0; i + 1 < group.legs.length; i++) {
        const a = group.legs[i].points;
        const b = group.legs[i + 1].points;
        joints.push(a.length && b.length ? distanceNM(last(a), first(b)) : Number.POSITIVE_INFINITY);
    }
    return joints;
}

/**
 * "Plot the 4th leg →" on the chart: offered while the draft on screen IS the
 * saved last leg of its trip (locked, saved, no unsaved edits) and no trip home
 * is being built. Null otherwise.
 */
export function nextLegOffer(input: {
    savedTraces: readonly SavedTrace[];
    legAnchor: NextLegSeed | null;
    points: readonly TracePoint[];
    returnTrip: boolean;
}): { ordinal: number; fromName: string; afterId: string; tripKey: string } | null {
    const { savedTraces, legAnchor, points } = input;
    if (!legAnchor || input.returnTrip) return null;
    const saved = legInSlot(savedTraces, legAnchor);
    if (
        !saved ||
        saved.points.length !== points.length ||
        !saved.points.every((point, index) => samePlace(point, points[index]))
    ) {
        return null;
    }
    const group = findTripGroup(savedTraces, saved.id);
    if (!group || group.legs[group.legs.length - 1]?.id !== saved.id) return null;
    const seed = nextLegSeed(saved);
    return seed ? { ordinal: seed.ordinal, fromName: seed.fromName, afterId: saved.id, tripKey: group.key } : null;
}

/** The library note the add pane shows once the cap is near, or null. */
export function libraryRoomNote(count: number): string | null {
    return count >= LIBRARY_WARN_AT
        ? `${count} of ${SAVED_ROUTE_LIBRARY_CAP} routes on this phone. Older unchecked trips make room first.`
        : null;
}
