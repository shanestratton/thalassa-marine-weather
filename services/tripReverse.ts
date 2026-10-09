/**
 * Reversing legs and trips (Shane 2026-10-07: "if i wanted to reverse the legs
 * of a route, it is not possible to do, unless i do the entire route (passage)
 * all at once").
 *
 * THE RULE: reverse always makes something new and never edits an existing
 * plan. A trip is a chain of independent saved rows (tripId + legOrdinal, the
 * "(Nth Leg)" badge as fallback, each leg welded to the last by position), and
 * any outbound row may be the one a boat is following. Flipping leg 2 inside
 * its own trip would leave both neighbours pointing at the wrong end of it and
 * rewrite a plan someone may be steering by, so:
 *
 *  - ⇄ on an opened leg makes a return COPY: places flipped, trip badges and
 *    chain fields gone, and no verification carried over (grading depends on
 *    direction, so the reversed line is unchecked until it is checked).
 *  - In a "Plot the next leg" draft, whose first pin is locked, ⇄ fills the
 *    slot with a saved leg that ARRIVES at that pin, reversed so it departs
 *    from it (slotCandidates + reversedLegForSlot). Only an EMPTY slot: a
 *    leg that has been saved keeps its lock on screen, and ⇄ there makes a
 *    copy like anywhere else (reverseTapDecision, legInSlot).
 *  - "⇄ Plan the return trip" builds a NEW trip home, one checked leg at a time
 *    (components/map/useReturnTripFlow.ts) from the same two primitives.
 *  - overwriteBlockReason stops the one path that used to reach an outbound
 *    row anyway: a reversed draft whose name still matched the stored leg.
 *
 * Pure: no React, no storage writes. Every function here is a decision.
 */
import { calculateDistance } from '../utils/navigationCalculations';
import { SAME_PLACE_NM } from './shiplog/collapseReversedRoutes';
import { reversedLegName, stripRouteBadges } from './routeNameParts';
import {
    buildTripPassageRollups,
    destNameFromRouteName,
    displayRouteLabel,
    groupTracesByTrip,
    legBadgeOrdinal,
    type NextLegSeed,
    type SavedTrace,
    type TracePoint,
    type TripGroup,
} from './routeTracer';

/** A reversed leg joins the previous arrival when its end lands this close —
 *  the berth-scale "same place" the Log already uses for there-and-back pairs.
 *  Pin 0 is then moved onto the exact anchor; anything further is refused with
 *  a reason rather than bridged by an invented connecting segment. */
export const REVERSE_JOIN_NM = SAME_PLACE_NM;

/** Endpoint match for "this line is that line reversed". */
const SAME_PIN_DEG = 1e-6;

const first = (points: readonly TracePoint[]): TracePoint => points[0];
const last = (points: readonly TracePoint[]): TracePoint => points[points.length - 1];

function samePin(a: TracePoint, b: TracePoint, tolerance = SAME_PIN_DEG): boolean {
    return Math.abs(a.lat - b.lat) <= tolerance && Math.abs(a.lon - b.lon) <= tolerance;
}

export function distanceNM(a: TracePoint, b: TracePoint): number {
    return calculateDistance(a.lat, a.lon, b.lat, b.lon);
}

/** The reminder every reversed line carries until it is saved as its own. The
 *  grader reads depth, land and marks both ways; it does not read traffic
 *  separation lanes, tidal gates or the way a light's sectors face. */
export function reversalNote(sourceLabel: string): string {
    return `Reversed from ${sourceLabel} — check traffic lanes, tidal gates and lights for this direction`;
}

/** Where the reversal came from, kept with the draft so the note survives a
 *  reload. `end` is the reversed line's arrival: the note stays only while the
 *  draft still arrives there, so Undo past the reversal or a re-plotted ending
 *  retires it instead of mislabelling a different line. */
export interface ReversalMark {
    label: string;
    end: TracePoint;
}

export function activeReversalNote(points: readonly TracePoint[], mark: ReversalMark | null): string | null {
    if (!mark || points.length < 2) return null;
    return distanceNM(last(points), mark.end) <= REVERSE_JOIN_NM ? reversalNote(mark.label) : null;
}

/** A leg of a trip: structurally, or by its "(Nth Leg)" badge when the cloud
 *  shed the structural fields. */
export function isChainedLeg(trace: Pick<SavedTrace, 'tripId' | 'name'>): boolean {
    return !!trace.tripId || legBadgeOrdinal(trace.name) !== null;
}

function legOrdinalOf(trace: SavedTrace): number {
    return trace.legOrdinal ?? legBadgeOrdinal(trace.name) ?? 1;
}

/**
 * `points` is `existing` driven the other way: each end lands on the other's
 * start. A loop (start = end) swaps its ends trivially, so for one the second
 * pin decides which way round it runs.
 */
export function isReversalOf(points: readonly TracePoint[], existing: readonly TracePoint[]): boolean {
    if (points.length < 2 || existing.length < 2) return false;
    if (!samePin(first(points), last(existing)) || !samePin(last(points), first(existing))) return false;
    if (!samePin(first(existing), last(existing))) return true;
    if (points.length < 3 || existing.length < 3) return false;
    const towardReverse = distanceNM(points[1], existing[existing.length - 2]);
    const towardForward = distanceNM(points[1], existing[1]);
    return towardReverse < towardForward;
}

/** Exact reverse, pin for pin — a leg's "reverse twin". Shared with the
 *  add-a-leg picker (services/tripLegAdd.ts), which excludes it too. */
export function isExactReverse(points: readonly TracePoint[], other: readonly TracePoint[]): boolean {
    if (points.length !== other.length || points.length < 2) return false;
    return points.every((point, index) => samePin(point, other[other.length - 1 - index]));
}

function samePoints(points: readonly TracePoint[], other: readonly TracePoint[]): boolean {
    return (
        points.length === other.length &&
        points.length >= 2 &&
        points.every((point, index) => samePin(point, other[index], 1e-9))
    );
}

/** The trip a trip key or any of its leg ids belongs to. */
export function findTripGroup(traces: readonly SavedTrace[], tripIdOrLegId: string): TripGroup | null {
    return (
        groupTracesByTrip(traces).find(
            (group) => group.key === tripIdOrLegId || group.legs.some((leg) => leg.id === tripIdOrLegId),
        ) ?? null
    );
}

/** Trip label without its "(3 legs)" count — for sentences. */
export function tripName(group: TripGroup): string {
    return stripRouteBadges(group.label);
}

/**
 * Outbound leg ids in the order the boat comes home: leg K first, leg 1 last.
 * K is a 1-based position in the trip (the Trip · Legs row number) and
 * defaults to the final leg; out-of-range values clamp.
 */
export function returnTripOrder(group: TripGroup, fromPosition?: number): string[] {
    const count = group.legs.length;
    if (count === 0) return [];
    const k = Math.min(count, Math.max(1, Math.trunc(fromPosition ?? count)));
    return group.legs
        .slice(0, k)
        .map((leg) => leg.id)
        .reverse();
}

/**
 * The saved row that already IS leg `seed.ordinal` of trip `seed.tripId`
 * (structural ordinal, or the "(Nth Leg)" badge when the cloud shed it). A
 * locked-start draft keeps its anchor after Save, so this is how the tracer
 * tells an empty slot from a saved leg that is still on screen.
 */
export function legInSlot(
    traces: readonly SavedTrace[],
    seed: Pick<NextLegSeed, 'tripId' | 'ordinal'>,
): SavedTrace | null {
    return (
        traces.find((trace) => (trace.tripId ?? trace.id) === seed.tripId && legOrdinalOf(trace) === seed.ordinal) ??
        null
    );
}

/** What one tap of ⇄ does to the draft on screen. */
export type ReverseTap =
    /** Flip the draft into a return copy. `detach` drops the locked start in
     *  the same edit: the draft is a saved leg, not an empty slot. */
    | { kind: 'copy'; detach: boolean; source: { label: string; unchanged: string } | null }
    /** An empty locked-start slot: saved legs arriving at the pin, best first. */
    | { kind: 'fill'; candidates: SavedTrace[] }
    /** An empty locked-start slot that nothing saved arrives at. */
    | { kind: 'no-candidates' }
    /** The slot is already saved and the draft holds no line to reverse. */
    | { kind: 'slot-taken'; occupant: SavedTrace; ordinal: number }
    | { kind: 'nothing' };

/**
 * ⇄, decided. An empty "Plot the next leg" slot is filled with a saved leg
 * reversed. Anything else, including a chained leg that has been saved and
 * still shows its lock, becomes a reversed copy. Filling a slot that is
 * already saved would add a second leg N to the outbound trip, and its
 * rollup would jump between the two (2026-10-07 review).
 */
export function reverseTapDecision(input: {
    traces: readonly SavedTrace[];
    anchor: NextLegSeed | null;
    points: readonly TracePoint[];
    preferTripId?: string | null;
}): ReverseTap {
    const { traces, anchor, points } = input;
    const occupant = anchor ? legInSlot(traces, anchor) : null;
    if (anchor && !occupant) {
        const candidates = slotCandidates(traces, anchor.anchor, {
            previousLeg: previousLegFor(traces, anchor),
            preferTripId: input.preferTripId ?? null,
        });
        return candidates.length > 0 ? { kind: 'fill', candidates } : { kind: 'no-candidates' };
    }
    if (points.length < 2) {
        return occupant && anchor ? { kind: 'slot-taken', occupant, ordinal: anchor.ordinal } : { kind: 'nothing' };
    }
    // Unsaved edits to a saved leg still name the stored leg as the source:
    // it is the one that stays unchanged.
    const source =
        describeReversalSource(traces, points) ?? (occupant ? describeReversalSource(traces, occupant.points) : null);
    return { kind: 'copy', detach: !!occupant, source };
}

/** The leg a chained draft departs from: the trip member one place earlier. */
export function previousLegFor(traces: readonly SavedTrace[], seed: NextLegSeed): SavedTrace | null {
    const members = traces.filter((trace) => (trace.tripId ?? trace.id) === seed.tripId && trace.points.length >= 2);
    const byOrdinal = members.find((trace) => legOrdinalOf(trace) === seed.ordinal - 1);
    if (byOrdinal) return byOrdinal;
    return members.find((trace) => samePin(last(trace.points), seed.anchor, 1e-7)) ?? null;
}

/**
 * Saved legs and routes that could fill a locked-start slot reversed: those
 * whose LAST pin is within REVERSE_JOIN_NM of the locked start. The previous
 * leg (the one the slot departs from — reversing it just goes back) and its
 * exact reverse twin are excluded. Legs of `preferTripId` (the trip being
 * reversed) come first, then the nearest join, then the newest.
 */
export function slotCandidates(
    traces: readonly SavedTrace[],
    anchor: TracePoint,
    options: { previousLeg?: SavedTrace | null; preferTripId?: string | null; excludeIds?: readonly string[] } = {},
): SavedTrace[] {
    const excluded = new Set(options.excludeIds ?? []);
    const previous = options.previousLeg ?? null;
    if (previous) excluded.add(previous.id);
    const stamp = (trace: SavedTrace): number => {
        const value = Date.parse(trace.updatedAt ?? trace.createdAt);
        return Number.isFinite(value) ? value : 0;
    };
    return traces
        .filter(
            (trace) =>
                Array.isArray(trace.points) &&
                trace.points.length >= 2 &&
                !excluded.has(trace.id) &&
                !(previous && isExactReverse(trace.points, previous.points)) &&
                distanceNM(last(trace.points), anchor) <= REVERSE_JOIN_NM,
        )
        .map((trace) => ({
            trace,
            preferred: !!options.preferTripId && (trace.tripId ?? trace.id) === options.preferTripId,
            gap: distanceNM(last(trace.points), anchor),
        }))
        .sort((a, b) => {
            if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
            if (Math.abs(a.gap - b.gap) > 1e-9) return a.gap - b.gap;
            return stamp(b.trace) - stamp(a.trace);
        })
        .map(({ trace }) => trace);
}

export interface ReversedSlot {
    /** The source's pins in reverse, pin 0 moved onto the exact anchor. */
    points: TracePoint[];
    /** Places flipped, trip badges gone. */
    name: string;
    destName: string | null;
    /** Note label for the source ("Bay Point - Sandy Cove (Leg 2)"). */
    sourceLabel: string;
}

/**
 * One saved leg dropped into a locked-start slot the other way round. Null
 * when the source does not arrive within REVERSE_JOIN_NM of the anchor. It
 * never copies verification or Auto proposal evidence: both are bound to the
 * exact outbound point order.
 */
export function reversedLegForSlot(source: SavedTrace, anchor: TracePoint): ReversedSlot | null {
    if (!Array.isArray(source.points) || source.points.length < 2) return null;
    if (distanceNM(last(source.points), anchor) > REVERSE_JOIN_NM) return null;
    const points = [...source.points].reverse().map((point) => ({ lat: point.lat, lon: point.lon }));
    points[0] = { lat: anchor.lat, lon: anchor.lon };
    const name = reversedLegName(source.name);
    return { points, name, destName: destNameFromRouteName(name), sourceLabel: displayRouteLabel(source) };
}

/** Reversed copy of a whole saved line — return leg 1, or ⇄ on an opened leg. */
export function reversedCopyOf(source: Pick<SavedTrace, 'points' | 'name'>): { points: TracePoint[]; name: string } {
    return {
        points: [...source.points].reverse().map((point) => ({ lat: point.lat, lon: point.lon })),
        name: reversedLegName(source.name),
    };
}

/**
 * What the draft on screen is, when it is exactly a stored line: the label
 * for its reversal note and the sentence that tells the skipper the original
 * stays as it was. Null for a line that is not stored as it stands.
 */
export function describeReversalSource(
    traces: readonly SavedTrace[],
    points: readonly TracePoint[],
): { label: string; unchanged: string } | null {
    if (points.length < 2) return null;
    const saved = traces.find((trace) => samePoints(trace.points, points));
    if (saved) {
        const label = displayRouteLabel(saved);
        if (isChainedLeg(saved)) {
            const group = findTripGroup(traces, saved.id);
            const position = group ? group.legs.findIndex((leg) => leg.id === saved.id) + 1 : legOrdinalOf(saved);
            return {
                label,
                unchanged: group
                    ? `Leg ${position} of ${tripName(group)} is unchanged`
                    : `Leg ${position} is unchanged`,
            };
        }
        return { label, unchanged: `${label} is unchanged` };
    }
    const rollup = buildTripPassageRollups(traces).find((candidate) => samePoints(candidate.points, points));
    if (rollup) {
        return {
            label: rollup.name,
            unchanged: `the ${rollup.legCount} legs of ${stripRouteBadges(rollup.name)} are unchanged`,
        };
    }
    return null;
}

/** What the follow store knows about the line the boat is steering by. */
export interface FollowSnapshot {
    isFollowing: boolean;
    voyageId: string | null;
    routeCoords: readonly TracePoint[];
}

/** Saved routes that are, or back, the plan being followed: linked through
 *  the mirror ids they carry, or matching the followed line end to end. */
export function followedSavedRouteIds(traces: readonly SavedTrace[], follow: FollowSnapshot | null): Set<string> {
    const ids = new Set<string>();
    if (!follow || (!follow.isFollowing && !follow.voyageId)) return ids;
    const coords = follow.routeCoords ?? [];
    for (const trace of traces) {
        if (
            follow.voyageId &&
            (trace.plannedRouteId === follow.voyageId || trace.passageVoyageId === follow.voyageId)
        ) {
            ids.add(trace.id);
            continue;
        }
        if (
            coords.length >= 2 &&
            trace.points.length >= 2 &&
            samePin(first(trace.points), first(coords)) &&
            samePin(last(trace.points), last(coords))
        ) {
            ids.add(trace.id);
        }
    }
    return ids;
}

/**
 * Why saving this draft over `existing` (same name, so Save would offer
 * "Overwrite?") must be refused, or null when an overwrite is legitimate.
 *
 * 1. The draft is `existing` reversed, and `existing` is a trip leg or the
 *    followed route. This was a real corruption path: a leg whose name has no
 *    separator ("Bay run (2nd Leg)", or any title in a script the separators
 *    don't cover) kept its name through ⇄, so a second tap reversed leg 2 in
 *    place, kept its trip fields, and healTripChain dragged leg 3's start back
 *    to leg 1's arrival.
 * 2. The draft is a chained leg, and `existing` is not this leg of this trip.
 *    Overwriting would pull a row of another trip (or another position) into
 *    this one — the separator-less name collision again, from the other side.
 */
export function overwriteBlockReason(
    existing: SavedTrace,
    points: readonly TracePoint[],
    context: { anchor?: NextLegSeed | null; followedIds?: ReadonlySet<string> } = {},
): string | null {
    const name = stripRouteBadges(existing.name) || existing.name;
    const followed = context.followedIds?.has(existing.id) ?? false;
    if ((isChainedLeg(existing) || followed) && isReversalOf(points, existing.points)) {
        return `That's ${name} reversed — give the return run its own name`;
    }
    const anchor = context.anchor ?? null;
    if (anchor) {
        const sameTrip = (existing.tripId ?? existing.id) === anchor.tripId;
        if (!sameTrip || legOrdinalOf(existing) !== anchor.ordinal) {
            return `${existing.name} is ${
                isChainedLeg(existing)
                    ? `leg ${legOrdinalOf(existing)} of ${sameTrip ? 'this' : 'another'} trip`
                    : 'another route'
            } — give this leg its own name`;
        }
    }
    return null;
}

/**
 * The guided "Plan the return trip" cursor, kept with the tracer draft so a
 * reload or an edit to the outbound trip does not lose the skipper's place.
 * It holds ids only; every step re-reads the outbound leg it needs, so an
 * edited source is honoured and a deleted one ends the flow out loud.
 */
export interface ReturnPlan {
    /** Trip being reversed (its leg 1 id). */
    sourceTripId: string;
    /** "Harbour - Cape Grey", for sentences. */
    sourceLabel: string;
    /** Outbound leg ids in return order: leg K first, leg 1 last. */
    sourceLegIds: string[];
    /** Index into sourceLegIds of the next return leg to open. While
     *  chainFromId is null it is also the 1-based number of the leg on screen. */
    nextIndex: number;
    /** The saved return leg the next one departs from. Null until the leg on
     *  screen has been saved. */
    chainFromId: string | null;
}

export function parseReturnPlan(value: unknown): ReturnPlan | null {
    if (!value || typeof value !== 'object') return null;
    const plan = value as Partial<ReturnPlan>;
    const ids = plan.sourceLegIds;
    if (
        typeof plan.sourceTripId !== 'string' ||
        !plan.sourceTripId ||
        typeof plan.sourceLabel !== 'string' ||
        !Array.isArray(ids) ||
        ids.length < 2 ||
        !ids.every((id) => typeof id === 'string' && id.length > 0) ||
        typeof plan.nextIndex !== 'number' ||
        !Number.isInteger(plan.nextIndex) ||
        plan.nextIndex < 1 ||
        plan.nextIndex > ids.length ||
        (plan.chainFromId !== null && (typeof plan.chainFromId !== 'string' || !plan.chainFromId))
    ) {
        return null;
    }
    return {
        sourceTripId: plan.sourceTripId,
        sourceLabel: plan.sourceLabel,
        sourceLegIds: [...ids],
        nextIndex: plan.nextIndex,
        chainFromId: plan.chainFromId,
    };
}

export function parseReversalMark(value: unknown): ReversalMark | null {
    if (!value || typeof value !== 'object') return null;
    const mark = value as Partial<ReversalMark>;
    const end = mark.end as Partial<TracePoint> | undefined;
    return typeof mark.label === 'string' &&
        mark.label.trim() &&
        end &&
        Number.isFinite(end.lat) &&
        Number.isFinite(end.lon) &&
        Math.abs(end.lat!) <= 90 &&
        Math.abs(end.lon!) <= 180
        ? { label: mark.label, end: { lat: end.lat!, lon: end.lon! } }
        : null;
}
