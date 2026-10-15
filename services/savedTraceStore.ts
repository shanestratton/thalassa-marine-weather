/**
 * Saved-trace storage (131-04, was 127-10): the route library on this device,
 * its deletion fences, the trip chain, and the one safe write of a route check.
 *
 * It lived in services/routeTracer.ts, which imports the routing engine
 * (engine/navGrid, InshoreRouter and through them the whole `router-engine`
 * chunk, about 110 KB compressed). The Log page's follow sheet, Cast Off, the
 * account sync and Plan Your Day only read or write the library, yet loading
 * it brought the engine into every start-up. Here it imports no engine code:
 * from the tracer, types only (they erase at build), so the router loads when
 * a route is planned, traced or checked, and not before.
 * tests/RouterEngineLazy131.test.ts holds the line.
 */
import { routeNameParts } from './routeNameParts';
import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import {
    normaliseTraceVerification,
    serialiseTraceVerificationNote,
    traceGeometryKey,
    type TraceVerification,
} from './traceVerification';
import { clearTraceCheckOutcome } from './traceCheckOutcomes';
import {
    normaliseAutoroutingProposalEvidence,
    type SavedAutoroutingProposalEvidence,
} from './autoroutingProposalEvidence';
import { chartFreeEvidence } from './chartFacts';
import type { TracePoint } from './routeTracer';

const log = createLogger('savedTraceStore');

// ── Saved routes: the library, its deletion fences ─────────────────────────

export interface SavedTrace {
    id: string;
    name: string;
    createdAt: string; // ISO
    /** Set on overwrite-saves — the cross-device merge keeps the newer copy. */
    updatedAt?: string;
    points: TracePoint[];
    // ── Multi-leg trip chain (Shane 2026-07-17: "we need to get our LEGS
    //    functioning") — legs of one trip share a tripId (= leg 1's own id);
    //    the chain is STRUCTURAL and is persisted through saved_routes. Names
    //    remain generated decoration plus a compatibility fallback for older
    //    rows created before the chain columns existed. ──
    /** Trip this leg belongs to — leg 1's id. Absent on standalone routes. */
    tripId?: string;
    /** 1-based position within the trip. */
    legOrdinal?: number;
    /** This leg's destination as the punter named it ("Woorim") — seeds the
     *  NEXT leg's name prefill without re-parsing the route name. */
    destName?: string;
    /** Exact planned-route mirror id in ship_logs. Unlike a route label this
     *  is safe to use for a delete cascade. */
    plannedRouteId?: string;
    /** Exact Passage Planning record backing this saved trace. */
    passageVoyageId?: string;
    /** Safety verdict for this exact geometry. Missing/invalid means the
     * route must be checked again before export, follow or Cast Off. */
    verification?: TraceVerification;
    /** Historical planned-only origin/check evidence, never navigation release. */
    proposalEvidence?: SavedAutoroutingProposalEvidence;
}

const TRACES_KEY = 'thalassa_traced_routes_v1';
const TRACE_TOMBSTONES_KEY = 'thalassa_traced_route_tombstones_v1';

/** A local deletion fence. Keeping this separately from saved_routes makes a
 * delete immediately authoritative even while the cloud tombstone is still
 * in flight; otherwise a simultaneous pull can put the old remote row back
 * into Plan before its delete reaches Supabase. */
export interface SavedTraceTombstone {
    deletedAt: string;
    plannedRouteId?: string;
    passageVoyageId?: string;
}

/**
 * The planner can intentionally return no Passage Planning row when a saved
 * trace is mirrored offline. Accept that nullable result at the tracer
 * boundary, while only persisting concrete ids into trace/tombstone storage.
 */
type TracePassageLinks = {
    plannedRouteId?: string;
    passageVoyageId?: string | null;
};

function tracesStorageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(TRACES_KEY, scope);
}

function traceTombstonesStorageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(TRACE_TOMBSTONES_KEY, scope);
}

function isFiniteIso(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Read only well-formed, account-scoped deletion fences. */
export function getSavedTraceTombstones(
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Record<string, SavedTraceTombstone> {
    try {
        if (!isAuthIdentityScopeCurrent(scope)) return {};
        const raw = localStorage.getItem(traceTombstonesStorageKey(scope));
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const tombstones: Record<string, SavedTraceTombstone> = {};
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue;
            const candidate = value as Partial<SavedTraceTombstone>;
            if (!isFiniteIso(candidate.deletedAt)) continue;
            tombstones[id] = {
                deletedAt: candidate.deletedAt,
                ...(typeof candidate.plannedRouteId === 'string' && candidate.plannedRouteId
                    ? { plannedRouteId: candidate.plannedRouteId }
                    : {}),
                ...(typeof candidate.passageVoyageId === 'string' && candidate.passageVoyageId
                    ? { passageVoyageId: candidate.passageVoyageId }
                    : {}),
            };
        }
        return tombstones;
    } catch {
        return {};
    }
}

function writeSavedTraceTombstones(
    tombstones: Record<string, SavedTraceTombstone>,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    localStorage.setItem(traceTombstonesStorageKey(scope), JSON.stringify(tombstones));
}

/** Clear a locally-recorded delete only when a deliberate new save uses the
 * same id. Normal route saves mint a fresh id, so a tombstone cannot vanish
 * just because another route was written. */
export function clearSavedTraceTombstone(id: string, scope: AuthIdentityScope = getAuthIdentityScope()): void {
    const traceId = id.trim();
    if (!traceId || !isAuthIdentityScopeCurrent(scope)) return;
    const tombstones = getSavedTraceTombstones(scope);
    if (!Object.prototype.hasOwnProperty.call(tombstones, traceId)) return;
    delete tombstones[traceId];
    try {
        writeSavedTraceTombstones(tombstones, scope);
    } catch {
        /* A stale tombstone is safer than resurrecting a deleted route. */
    }
}

/**
 * A planned-route mirror can finish after its canonical trace was deleted.
 * Preserve those exact ids on the existing deletion fence before attempting
 * cleanup, so an offline/late cleanup is retried on the next account sync
 * instead of becoming a permanent Passage Planning orphan.
 */
export function attachSavedTraceTombstoneLinks(
    id: string,
    links: TracePassageLinks,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): boolean {
    const traceId = id.trim();
    if (!traceId || !isAuthIdentityScopeCurrent(scope)) return false;
    const tombstones = getSavedTraceTombstones(scope);
    const previous = tombstones[traceId];
    if (!previous) return false;
    const next: SavedTraceTombstone = {
        ...previous,
        ...(links.plannedRouteId ? { plannedRouteId: links.plannedRouteId } : {}),
        ...(links.passageVoyageId ? { passageVoyageId: links.passageVoyageId } : {}),
    };
    try {
        writeSavedTraceTombstones({ ...tombstones, [traceId]: next }, scope);
        return true;
    } catch {
        // The immediate cleanup still runs. A missing retry record is less
        // ideal, but never turn this best-effort metadata write into a route
        // resurrection or a false success.
        return false;
    }
}

/** Remove deletion fences the account has already acknowledged remotely. */
export function clearSyncedSavedTraceTombstones(
    ids: Iterable<string>,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    const tombstones = getSavedTraceTombstones(scope);
    let changed = false;
    for (const id of ids) {
        if (Object.prototype.hasOwnProperty.call(tombstones, id)) {
            delete tombstones[id];
            changed = true;
        }
    }
    if (!changed) return;
    try {
        writeSavedTraceTombstones(tombstones, scope);
    } catch {
        /* Keep the in-memory result; the next sync can compact again. */
    }
}

/** Shared notification for every Saved Routes surface. */
export function notifySavedRoutesChanged(scope: AuthIdentityScope = getAuthIdentityScope()): void {
    if (!isAuthIdentityScopeCurrent(scope) || typeof window === 'undefined') return;
    try {
        window.dispatchEvent(
            new CustomEvent('thalassa:saved-routes-changed', {
                detail: { scopeKey: scope.key, scopeGeneration: scope.generation },
            }),
        );
    } catch {
        /* non-critical */
    }
}

// ── Trip-chain helpers (pure; names are paint, tripId/legOrdinal are glue) ──

/** "(2nd Leg)"-style badge — matched/stripped by the helpers below. */
const LEG_BADGE_RE = /\s*\((\d+)(?:st|nd|rd|th) Leg\)\s*$/i;

/** 1 → "1st Leg", 2 → "2nd Leg", 11 → "11th Leg", 23 → "23rd Leg". */
export function ordinalLegLabel(n: number): string {
    const tens = n % 100;
    const suffix =
        tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
    return `${n}${suffix} Leg`;
}

/** Remove a trailing "(Nth Leg)" badge (idempotent). */
export function stripLegBadge(name: string): string {
    return name.replace(LEG_BADGE_RE, '').trim();
}

/** Append the leg badge, replacing any existing one — re-saving a badged
 *  name never stacks "(2nd Leg) (2nd Leg)". */
export function withLegBadge(name: string, ordinal: number): string {
    return `${stripLegBadge(name)} (${ordinalLegLabel(ordinal)})`;
}

/** Ordinal parsed from the name badge — the cross-device fallback for routes
 *  whose structural fields were dropped by the cloud round-trip. */
export function legBadgeOrdinal(name: string): number | null {
    const m = LEG_BADGE_RE.exec(name);
    return m ? Number(m[1]) : null;
}

/** Last port in a directional route name (dash, arrow or "to"), badge
 *  stripped. Unspaced hyphens in localities such as Kippa-Ring survive. */
export function destNameFromRouteName(name: string): string | null {
    return routeNameParts(stripLegBadge(name))?.places.at(-1) ?? null;
}

/** Everything the tracer needs to open "plot the next leg of this trip":
 *  the chain identity, the next ordinal, the name prefill, and the LOCKED
 *  first pin (the previous leg's exact final coordinates — legs chain by
 *  position, not by name). */
export interface NextLegSeed {
    tripId: string;
    ordinal: number;
    fromName: string;
    anchor: TracePoint;
}

export function nextLegSeed(t: SavedTrace): NextLegSeed | null {
    if (!Array.isArray(t.points) || t.points.length < 2) return null;
    const last = t.points[t.points.length - 1];
    return {
        tripId: t.tripId ?? t.id,
        ordinal: (t.legOrdinal ?? legBadgeOrdinal(t.name) ?? 1) + 1,
        fromName: t.destName ?? destNameFromRouteName(t.name) ?? stripLegBadge(t.name),
        anchor: { lat: last.lat, lon: last.lon },
    };
}

/** One trip in the picker's eyes: its legs (ordinal-sorted) + a summary
 *  label. Standalone routes are a one-leg trip. */
export interface TripGroup {
    key: string;
    label: string;
    legs: SavedTrace[];
}

/** Trips touched this recently are kept newest first over the cap, checked or
 *  not: the same 30 days a route check stays green (traceFollowStatus). */
const SAVED_TRACE_CAP_RECENT_MS = 30 * 24 * 3_600_000;

function traceStamp(trace: SavedTrace): number {
    const stamp = Date.parse(trace.updatedAt ?? trace.createdAt);
    return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Retain a complete trip when enforcing the local route-library cap. The old
 * row-by-row slice could evict leg 1 while keeping leg 2, which is precisely
 * how a healthy trip became a stranded "2nd Leg" after a busy season.
 *
 * Over the cap (125-07), in this order, each pass newest first: the newest
 * trip (the write in hand) always stays; a trip holding a `protectedIds` route
 * (the one being followed) is never evicted; then trips holding a `pendingIds`
 * route (one the account has not acknowledged yet — the sync's offline saves,
 * the only copy there is); then every trip touched in the last 30 days, the
 * same window a check stays green, whatever its check state (a route built on
 * the desktop yesterday arrives here unchecked and must get its chance); and
 * only among OLDER trips do checked ones fill before unchecked ones. It used
 * to be purely oldest-first, which dropped a passage under way and its checks
 * with it (Shane's yellow legs, 2026-10-08). Output order is unchanged.
 */
export function capSavedTracesPreservingTrips(
    traces: readonly SavedTrace[],
    cap = 50,
    protectedIds: ReadonlySet<string> = new Set(),
    opts: { pendingIds?: ReadonlySet<string>; nowMs?: number } = {},
): SavedTrace[] {
    if (cap <= 0 || traces.length === 0) return [];

    const grouped = new Map<string, SavedTrace[]>();
    const encounterOrder: string[] = [];
    for (const trace of traces) {
        const key = trace.tripId ?? trace.id;
        const group = grouped.get(key);
        if (group) group.push(trace);
        else {
            grouped.set(key, [trace]);
            encounterOrder.push(key);
        }
    }

    const newestGroups = encounterOrder
        .map((key) => {
            const members = grouped.get(key)!;
            return { key, traces: members, stamp: Math.max(...members.map(traceStamp)) };
        })
        .sort((left, right) => right.stamp - left.stamp);

    // A trip is indivisible. A pathological >cap trip is still safer to
    // retain whole than to leave it structurally corrupt.
    type Group = (typeof newestGroups)[number];
    const keep = new Set<string>([newestGroups[0].key]);
    let count = newestGroups[0].traces.length;
    const nowMs = opts.nowMs ?? Date.now();
    const holds = (ids: ReadonlySet<string> | undefined) => (group: Group) =>
        !!ids && group.traces.some((t) => ids.has(t.id));
    const followed = holds(protectedIds);
    const pending = holds(opts.pendingIds);
    const recent = (group: Group) => nowMs - group.stamp <= SAVED_TRACE_CAP_RECENT_MS;
    const checked = (group: Group) => group.traces.some((t) => t.verification);
    for (const pass of [followed, pending, recent, checked, () => true]) {
        for (const group of newestGroups) {
            if (keep.has(group.key) || !pass(group)) continue;
            if (pass !== followed && count + group.traces.length > cap) continue;
            keep.add(group.key);
            count += group.traces.length;
        }
    }
    return newestGroups.filter((group) => keep.has(group.key)).flatMap((group) => group.traces);
}

/** stores/followRouteStore's persisted follow. Read here, not imported, so the
 *  route library never loads the follow store (and its weather router). */
const FOLLOW_ROUTE_KEY = 'thalassa_follow_route';

/** Ids of every leg of the trip being followed right now — exempt from the
 *  cap. A follow steers the trace's own pins (tracedRouteFollowGeometry), so
 *  the geometry finds it even when the follow carries a Cast Off voyage id. */
function followedTripIds(traces: readonly SavedTrace[], scope: AuthIdentityScope): Set<string> {
    try {
        const follow = JSON.parse(localStorage.getItem(authScopedStorageKey(FOLLOW_ROUTE_KEY, scope)) ?? 'null') as {
            isFollowing?: unknown;
            voyageId?: unknown;
            routeCoords?: unknown;
        } | null;
        if (follow?.isFollowing !== true) return new Set();
        const voyageId = typeof follow.voyageId === 'string' ? follow.voyageId.trim() : '';
        const coords = Array.isArray(follow.routeCoords) ? (follow.routeCoords as TracePoint[]) : [];
        const byId = (t: SavedTrace) =>
            !!voyageId && (t.id === voyageId || t.passageVoyageId === voyageId || t.plannedRouteId === voyageId);
        const key = traces.some(byId) ? '' : traceGeometryKey(coords);
        const hit = traces.find((t) => byId(t) || (!!key && traceGeometryKey(t.points) === key));
        if (!hit) return new Set();
        const trip = hit.tripId ?? hit.id;
        return new Set(traces.filter((t) => (t.tripId ?? t.id) === trip).map((t) => t.id));
    } catch {
        return new Set();
    }
}

function sameTraceContent(left: SavedTrace, right: SavedTrace): boolean {
    return (
        left.id === right.id &&
        left.name === right.name &&
        left.createdAt === right.createdAt &&
        left.updatedAt === right.updatedAt &&
        left.tripId === right.tripId &&
        left.legOrdinal === right.legOrdinal &&
        left.destName === right.destName &&
        left.plannedRouteId === right.plannedRouteId &&
        left.passageVoyageId === right.passageVoyageId &&
        JSON.stringify(left.verification ?? null) === JSON.stringify(right.verification ?? null) &&
        left.points.length === right.points.length &&
        left.points.every(
            (point, index) => point.lat === right.points[index]?.lat && point.lon === right.points[index]?.lon,
        )
    );
}

function sortTripLegs(legs: readonly SavedTrace[]): SavedTrace[] {
    return [...legs].sort((a, b) => {
        const ordinalA = a.legOrdinal ?? legBadgeOrdinal(a.name) ?? 1;
        const ordinalB = b.legOrdinal ?? legBadgeOrdinal(b.name) ?? 1;
        if (ordinalA !== ordinalB) return ordinalA - ordinalB;
        return traceStamp(a) - traceStamp(b);
    });
}

/**
 * Stamp one continuous run as either a standalone route or a properly rooted
 * chain. Geometry and exact Passage/Log links stay untouched; only the
 * structural metadata and generated leg badge change.
 */
function normaliseTripRun(legs: readonly SavedTrace[], updatedAt: string): SavedTrace[] {
    const ordered = sortTripLegs(legs);
    if (ordered.length === 0) return [];
    if (ordered.length === 1) {
        const only = ordered[0];
        return [
            {
                ...only,
                name: stripLegBadge(only.name),
                ...(only.destName ? { destName: only.destName } : {}),
                updatedAt,
                tripId: undefined,
                legOrdinal: undefined,
            },
        ];
    }
    const rootId = ordered[0].id;
    return ordered.map((leg, index) => {
        const ordinal = index + 1;
        return {
            ...leg,
            name: withLegBadge(leg.name, ordinal),
            tripId: rootId,
            legOrdinal: ordinal,
            destName: leg.destName ?? destNameFromRouteName(leg.name) ?? undefined,
            updatedAt,
        };
    });
}

/**
 * Recover a historical chain whose root row has already disappeared. Older
 * builds could delete leg 1 while leaving leg 2+ with the old tripId, and a
 * storage cap could create the same shape. Promote the lowest surviving leg
 * to the new root (or a standalone route when it is the sole survivor), so
 * Plan never has a stranded “2nd Leg”.
 *
 * The repair is pure. `loadSavedTraces()` uses it for immediate truthful UI;
 * sync persists and publishes the returned `changed` records cross-device.
 */
export function repairOrphanedSavedTraceChains(
    traces: readonly SavedTrace[],
    updatedAt?: string,
): SavedTraceDeleteRebase {
    const ids = new Set(traces.map((trace) => trace.id));
    const orphanedByTripId = new Map<string, SavedTrace[]>();
    for (const trace of traces) {
        if (!trace.tripId || ids.has(trace.tripId)) continue;
        const group = orphanedByTripId.get(trace.tripId) ?? [];
        group.push(trace);
        orphanedByTripId.set(trace.tripId, group);
    }
    if (orphanedByTripId.size === 0) return { traces: [...traces], changed: [] };

    const replacementById = new Map<string, SavedTrace>();
    for (const group of orphanedByTripId.values()) {
        // One deterministic tick past the newest known row makes a repair
        // win a newest-version merge without generating a fresh timestamp on
        // every read before the repaired copy has been persisted.
        const newestStamp = Math.max(...group.map(traceStamp));
        const repairStamp =
            updatedAt ?? (newestStamp > 0 ? new Date(newestStamp + 1).toISOString() : new Date().toISOString());
        for (const repaired of normaliseTripRun(group, repairStamp)) {
            replacementById.set(repaired.id, repaired);
        }
    }

    const repairedTraces = traces.map((trace) => replacementById.get(trace.id) ?? trace);
    const changed = repairedTraces.filter((trace) => {
        const previous = traces.find((candidate) => candidate.id === trace.id);
        return Boolean(previous && !sameTraceContent(previous, trace));
    });
    return { traces: repairedTraces, changed };
}

export interface SavedTraceDeleteRebase {
    traces: SavedTrace[];
    changed: SavedTrace[];
}

/**
 * Delete one leg without leaving a dangling trip root. When the first leg is
 * removed, its successor becomes leg 1. Removing a middle leg deliberately
 * splits the tail into a new trip: pretending two discontinuous sea paths
 * are still joined would make the locked starting pin lie.
 */
export function rebaseSavedTraceChainAfterDelete(
    traces: readonly SavedTrace[],
    removedId: string,
    updatedAt = new Date().toISOString(),
): SavedTraceDeleteRebase {
    const target = traces.find((trace) => trace.id === removedId);
    if (!target) return { traces: [...traces], changed: [] };

    const tripKey = target.tripId ?? target.id;
    const chain = sortTripLegs(
        traces.filter((trace) => trace.id === tripKey || trace.id === target.id || trace.tripId === tripKey),
    );
    const removedIndex = chain.findIndex((trace) => trace.id === removedId);
    if (removedIndex < 0) return { traces: traces.filter((trace) => trace.id !== removedId), changed: [] };

    const before = chain.slice(0, removedIndex);
    const after = chain.slice(removedIndex + 1);
    const replacementById = new Map<string, SavedTrace>();
    // Keeping the prefix and tail separate after a middle delete preserves
    // positional truth. First-leg deletion naturally has an empty prefix, so
    // every successor is promoted in one clean reindex.
    for (const replacement of [...normaliseTripRun(before, updatedAt), ...normaliseTripRun(after, updatedAt)]) {
        replacementById.set(replacement.id, replacement);
    }

    const next = traces
        .filter((trace) => trace.id !== removedId)
        .map((trace) => replacementById.get(trace.id) ?? trace);
    const changed = next.filter((trace) => {
        const previous = traces.find((candidate) => candidate.id === trace.id);
        return !!previous && !sameTraceContent(previous, trace);
    });
    return { traces: next, changed };
}

/** Group saved traces into trips (SHARED by the PLAN-page Trip box and the
 *  tracer card's "open a saved route" list, so the two can never drift —
 *  2026-07-17). Legs of one trip share tripId (= leg 1's id); order is
 *  preserved from the input so the caller controls newest-first, etc. */
export function groupTracesByTrip(traces: readonly SavedTrace[]): TripGroup[] {
    const groups = new Map<string, SavedTrace[]>();
    const order: string[] = [];
    for (const t of traces) {
        const key = t.tripId ?? t.id;
        const g = groups.get(key);
        if (g) g.push(t);
        else {
            groups.set(key, [t]);
            order.push(key);
        }
    }
    return order.map((key) => {
        const legs = sortTripLegs(groups.get(key)!);
        const first = legs[0];
        if (legs.length === 1) return { key, legs, label: stripLegBadge(first.name) };
        // A trip reads first origin – FINAL destination, the same rule as the
        // passage rollup. Leg 1's name is only the first hop (Shane 2026-09-08:
        // a Newport → Whitsundays passage was headed "Newport - Mackay").
        const last = legs[legs.length - 1];
        const origin = originNameFromRouteName(first.name) ?? stripLegBadge(first.name);
        const dest = last.destName ?? destNameFromRouteName(last.name) ?? stripLegBadge(last.name);
        return { key, legs, label: `${origin} - ${dest} (${legs.length} legs)` };
    });
}

/** First port in the shared directional naming convention, badge stripped. */
export function originNameFromRouteName(name: string): string | null {
    return routeNameParts(stripLegBadge(name))?.places[0] ?? null;
}

/** Standardised list label (Shane 2026-08-04): trip legs render as
 *  "<name> (Leg N)" derived from the STRUCTURAL ordinal — the stored
 *  "(2nd Leg)" badge stays in the name for cross-device compat, but it is
 *  paint; this is what every list shows. Standalone routes pass through. */
export function displayRouteLabel(t: Pick<SavedTrace, 'name' | 'tripId' | 'legOrdinal'>): string {
    const ordinal = t.tripId ? (t.legOrdinal ?? legBadgeOrdinal(t.name)) : null;
    if (!ordinal) return stripLegBadge(t.name);
    return `${stripLegBadge(t.name)} (Leg ${ordinal})`;
}

export const TRIP_PASSAGE_ID_PREFIX = 'trip-passage:';

/** One derived "(Passage)" rollup per multi-leg trip. */
export interface TripPassageRollup {
    /** `trip-passage:<tripId>` — the prefix marks it derived/read-only. */
    id: string;
    tripId: string;
    /** "<origin> - <final destination> (Passage)" */
    name: string;
    /** First leg's departure place name. */
    originName: string;
    /** Last leg's destination place name. */
    destName: string;
    /** All legs stitched, duplicated joint pins dropped. */
    points: TracePoint[];
    legCount: number;
    legIds: string[];
}

/**
 * Build the derived "(Passage)" rollup rows (Shane-approved design
 * 2026-08-04). DERIVED ON PURPOSE: a stored fourth copy would go stale the
 * day a leg is re-traced around weather — this is computed from the legs at
 * read time, never persisted, never synced, and not individually deletable
 * (delete the legs and it evaporates).
 */
export function buildTripPassageRollups(traces: readonly SavedTrace[]): TripPassageRollup[] {
    return groupTracesByTrip(traces)
        .filter((group) => group.legs.length >= 2)
        .map((group) => {
            const points: TracePoint[] = [];
            for (const leg of group.legs) {
                for (const p of leg.points) {
                    const prev = points[points.length - 1];
                    // Legs chain by position (healTripChain) — drop the
                    // duplicated joint pin where leg N+1 starts on leg N's end.
                    if (prev && Math.abs(prev.lat - p.lat) < 1e-7 && Math.abs(prev.lon - p.lon) < 1e-7) continue;
                    points.push({ lat: p.lat, lon: p.lon });
                }
            }
            const first = group.legs[0];
            const last = group.legs[group.legs.length - 1];
            const origin = originNameFromRouteName(first.name) ?? stripLegBadge(first.name);
            const dest = last.destName ?? destNameFromRouteName(last.name) ?? stripLegBadge(last.name);
            return {
                id: `${TRIP_PASSAGE_ID_PREFIX}${group.key}`,
                tripId: group.key,
                name: `${origin} - ${dest} (Passage)`,
                originName: origin,
                destName: dest,
                points,
                legCount: group.legs.length,
                legIds: group.legs.map((leg) => leg.id),
            };
        });
}

/**
 * Planned destination for leg N of the trip this voyage's saved route
 * belongs to. Pre-seeds Cast Off's "Arrive at Port" box and the next leg's
 * destination instead of leaving a blank field (Shane-approved design
 * 2026-08-04). Null when the route isn't a trip member or the leg is
 * beyond the plan.
 */
/**
 * Trip ordinal of the saved route itself — the anchor's own position in its
 * trip (structural field first, name badge as the cross-device fallback, 1
 * when the route is not a chained leg). Cast Off's first in-voyage leg must
 * seed from THIS, not a literal 1: a voyage whose route is trip leg 2 was
 * being handed leg 1's planned destination (Shane 2026-08-27: Cast Off
 * "always shows the newport - coral sea 1st leg"). A passage rollup's
 * saved_route_id is the tripId, which doubles as leg 1's trace id, so the
 * passage case still resolves to 1 here by construction.
 */
export function tripLegAnchorOrdinal(savedRouteId: string | null | undefined): number {
    if (!savedRouteId) return 1;
    const anchor = loadSavedTraces().find((t) => t.id === savedRouteId);
    if (!anchor) return 1;
    return anchor.legOrdinal ?? legBadgeOrdinal(anchor.name) ?? 1;
}

export function tripLegPlannedDestination(savedRouteId: string | null | undefined, legNumber: number): string | null {
    if (!savedRouteId || !Number.isFinite(legNumber) || legNumber < 1) return null;
    const traces = loadSavedTraces();
    const anchor = traces.find((t) => t.id === savedRouteId);
    if (!anchor) return null;
    const tripId = anchor.tripId ?? anchor.id;
    const legs = sortTripLegs(traces.filter((t) => (t.tripId ?? t.id) === tripId));
    const leg = legs.find((l, i) => (l.legOrdinal ?? legBadgeOrdinal(l.name) ?? i + 1) === legNumber);
    if (!leg) return null;
    return leg.destName ?? destNameFromRouteName(leg.name) ?? null;
}

/** Retro-badge (Shane's call, 2026-07-17): leg 1 earns its "(1st Leg)" badge
 *  the moment leg 2 is born — day-sail routes never carry trip baggage.
 *  Finds the trip's first leg (its id IS the tripId), stamps the structural
 *  fields and renames in place (same id → the cloud upsert updates the same
 *  row). Returns the renamed trace, or null when there was nothing to do. */
export function retroBadgeFirstLeg(tripId: string): SavedTrace | null {
    const first = loadSavedTraces().find((t) => t.id === tripId || (t.tripId === tripId && t.legOrdinal === 1));
    if (!first) return null;
    const alreadyBadged = LEG_BADGE_RE.test(first.name);
    const alreadyStamped = first.tripId === tripId && first.legOrdinal === 1;
    if (alreadyBadged && alreadyStamped) return null;
    const { trace } = saveTrace(withLegBadge(first.name, 1), first.points, {
        overwriteId: first.id,
        tripId,
        legOrdinal: 1,
        destName: first.destName ?? destNameFromRouteName(first.name) ?? undefined,
    });
    return trace;
}

/** AUTO-HEAL (Shane's call, 2026-07-17): edits to a leg's endpoint ripple
 *  into the NEXT leg's locked start, so the chain never gaps. Called after
 *  every save; walks successors transitively (leg 1's new endpoint moves
 *  leg 2's start; if that changed leg 2's endpoint too — it didn't, only
 *  point 0 moves — the walk stops). Returns a human line for the toast, or
 *  null when nothing needed healing. */
export function healTripChain(saved: SavedTrace): string | null {
    return healTripChainDetailed(saved)?.message ?? null;
}

/** healTripChain plus WHICH leg it moved — that leg's check is void now, so
 *  the caller queues it for a background re-check (build 124). */
export function healTripChainDetailed(saved: SavedTrace): { message: string; healedId: string } | null {
    const tripId = saved.tripId ?? undefined;
    if (!tripId) return null;
    const ordinal = saved.legOrdinal ?? legBadgeOrdinal(saved.name);
    if (!ordinal) return null;
    const next = loadSavedTraces().find((t) => t.tripId === tripId && t.legOrdinal === ordinal + 1);
    if (!next || next.points.length < 2) return null;
    const want = saved.points[saved.points.length - 1];
    const have = next.points[0];
    if (Math.abs(have.lat - want.lat) < 1e-7 && Math.abs(have.lon - want.lon) < 1e-7) return null;
    saveTrace(next.name, [{ lat: want.lat, lon: want.lon }, ...next.points.slice(1)], {
        overwriteId: next.id,
        tripId: next.tripId,
        legOrdinal: next.legOrdinal,
        destName: next.destName,
    });
    return { message: `"${next.name}" start moved to match`, healedId: next.id };
}

export function loadSavedTraces(scope: AuthIdentityScope = getAuthIdentityScope()): SavedTrace[] {
    try {
        // Deliberately do not read the former unscoped key. Its rows carry no
        // trustworthy owner, so adopting them into whichever account happens
        // to sign in next would turn an offline cache into a privacy leak.
        const raw = localStorage.getItem(tracesStorageKey(scope));
        if (!raw) return [];
        const read = JSON.parse(raw) as SavedTrace[];
        if (!Array.isArray(read)) return [];
        // 127-C-b: an older copy's chart facts are stripped as it is read and
        // the library is written back once (purge on contact).
        let stripped = false;
        const arr = read.map((trace) => {
            try {
                const kept = trace?.proposalEvidence && chartFreeEvidence(trace.proposalEvidence);
                if (!kept || kept === trace.proposalEvidence) return trace;
                stripped = true;
                return { ...trace, proposalEvidence: kept };
            } catch {
                return trace; // malformed evidence is refused below
            }
        });
        if (stripped) {
            try {
                writeSavedTraces(arr, scope);
            } catch {
                /* storage refused: the stripped copy is still what is shown */
            }
        }
        const tombstones = getSavedTraceTombstones(scope);
        const visible = arr
            .filter(
                (t) =>
                    t &&
                    typeof t.id === 'string' &&
                    !Object.prototype.hasOwnProperty.call(tombstones, t.id) &&
                    Array.isArray(t.points) &&
                    t.points.length >= 2,
            )
            .map((trace) => {
                const verification = normaliseTraceVerification(trace.verification, trace.points);
                const proposalEvidence = normaliseAutoroutingProposalEvidence(trace.proposalEvidence, trace.points);
                // Never present a corrupted/mismatched provider proposal as an
                // ordinary route by silently dropping its warning provenance.
                if (trace.proposalEvidence !== undefined && !proposalEvidence) return null;
                if (verification) return { ...trace, verification, ...(proposalEvidence ? { proposalEvidence } : {}) };
                const { verification: _invalid, ...safe } = trace;
                return { ...safe, ...(proposalEvidence ? { proposalEvidence } : {}) };
            })
            .filter((trace): trace is SavedTrace => trace !== null);
        return repairOrphanedSavedTraceChains(visible).traces;
    } catch {
        return [];
    }
}

/**
 * The one writer of the route library: capped (a followed trip exempt), and a
 * refused write never drops the library (125-07). Storage is required to keep
 * the old value when it refuses a new one; this checks that it did, and puts
 * the library back if it did not — it is the only copy of an offline save.
 * Throws on refusal so every caller reports it.
 */
function writeSavedTraces(
    traces: readonly SavedTrace[],
    scope: AuthIdentityScope,
    pendingIds?: ReadonlySet<string>,
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    const key = tracesStorageKey(scope);
    const payload = JSON.stringify(
        capSavedTracesPreservingTrips(traces, 50, followedTripIds(traces, scope), { pendingIds }),
    );
    const previous = localStorage.getItem(key);
    try {
        localStorage.setItem(key, payload);
    } catch (error) {
        try {
            if (previous !== null && localStorage.getItem(key) !== previous) localStorage.setItem(key, previous);
        } catch {
            /* nothing left to try; the caller still reports the refusal */
        }
        throw error;
    }
}

/** writeSavedTraces for callers outside this file (the account sync): false
 *  when storage refused, and the library is then exactly as it was.
 *  `pendingIds`: routes the account has not acknowledged yet (kept over the
 *  cap ahead of everything but the newest and followed trips). */
export function persistSavedTraceLibrary(
    traces: readonly SavedTrace[],
    scope: AuthIdentityScope,
    pendingIds?: ReadonlySet<string>,
): boolean {
    try {
        writeSavedTraces(traces, scope, pendingIds);
        return true;
    } catch {
        return false;
    }
}

/**
 * Adopt a saved route from the account onto THIS device, keeping its id.
 *
 * The route library lives in localStorage, so a route traced on one phone is
 * invisible on the next one — and after a reinstall, invisible on the same
 * one. Everything downstream keys off the saved-route id (follow links, the
 * verification envelope, the Cast Off gate), so the id must survive the hop.
 *
 * saveTrace's `overwriteId` cannot do this: it looks the id up in the LOCAL
 * store first, finds nothing in exactly this case, and mints a fresh id —
 * silently detaching the copy from the voyage that pointed at it.
 *
 * No verification is carried across. The envelope is a claim about a specific
 * boat's draft against a specific chart library, and neither of those is
 * necessarily true on the device now holding it. The route arrives unchecked
 * and the tracer's own gate decides — which is the honest outcome.
 */
export function adoptServerRoute(
    id: string,
    name: string,
    points: readonly TracePoint[],
    scope: AuthIdentityScope = getAuthIdentityScope(),
    extras: {
        tripId?: string;
        legOrdinal?: number;
        destName?: string;
        plannedRouteId?: string;
        passageVoyageId?: string;
        updatedAt?: string;
    } = {},
): SavedTrace | null {
    if (!id.trim() || points.length < 2) return null;
    const now = new Date().toISOString();
    const existing = loadSavedTraces(scope);
    const prior = existing.find((t) => t.id === id);
    // Trip chain + mirror ride along (2026-09-08): an adopted leg used to
    // arrive bare, so the second device's follow sheet listed a passage's
    // legs as unrelated day sails and its publish could not find the mirror.
    const tripId = extras.tripId ?? prior?.tripId;
    const legOrdinal = extras.legOrdinal ?? prior?.legOrdinal;
    const destName = extras.destName ?? prior?.destName;
    const plannedRouteId = extras.plannedRouteId ?? prior?.plannedRouteId;
    const passageVoyageId = extras.passageVoyageId ?? prior?.passageVoyageId;
    const trace: SavedTrace = {
        id,
        name: name.trim() || 'Saved route',
        createdAt: prior?.createdAt ?? now,
        updatedAt: extras.updatedAt ?? now,
        points: points.map((p) => ({ ...p })),
        ...(tripId ? { tripId } : {}),
        ...(legOrdinal ? { legOrdinal } : {}),
        ...(destName ? { destName } : {}),
        ...(plannedRouteId ? { plannedRouteId } : {}),
        ...(passageVoyageId ? { passageVoyageId } : {}),
    };
    const next = [trace, ...existing.filter((t) => t.id !== id)];
    try {
        writeSavedTraces(next, scope);
    } catch {
        return null;
    }
    notifySavedRoutesChanged(scope);
    return trace;
}

const PASSAGE_VOYAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bank a finished route check against a saved trace — the ONE safe write for
 * every check that lands outside the tracer's Save (build 124: the Log's ack
 * report, the tracer's auto-bank, the background re-check, server recovery).
 *
 *  - re-reads the store, so a check never lands on pins that moved while it
 *    ran (the envelope must still prove the CURRENT points);
 *  - never replaces a newer check with an older one;
 *  - says when storage refused it, rather than letting the row stay amber
 *    after a "successful" check on a full phone;
 *  - clears an older could-not-check record, and refreshes the passage
 *    mirror's durable copy WITHOUT timing, so the planned departure stands.
 *
 * The route's own updatedAt is kept, and its pins are never pushed: a bank is
 * not an edit. Going through saveTrace bumped updatedAt and upserted this
 * device's pins, so an automatic bank on a phone that had not synced since
 * another device moved (or deleted) the route won last-writer-wins and
 * reverted it. Since 125-07 the CHECK alone goes to saved_routes.verification
 * (once that column exists), and only onto the row revision this device
 * holds; syncSavedRoutes catches up anything that could not go then.
 * `syncColumn: false` is for a check that came FROM the column.
 */
export function bankTraceVerification(
    traceId: string,
    value: TraceVerification,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    opts: { refreshMirror?: boolean; syncColumn?: boolean } = {},
): { banked: boolean; reason?: 'scope' | 'gone' | 'moved' | 'older' | 'storage' } {
    if (!isAuthIdentityScopeCurrent(scope)) return { banked: false, reason: 'scope' };
    const all = loadSavedTraces(scope);
    const current = all.find((trace) => trace.id === traceId);
    if (!current) return { banked: false, reason: 'gone' };
    const verification = normaliseTraceVerification(value, current.points);
    if (!verification) return { banked: false, reason: 'moved' };
    if (current.verification && Date.parse(current.verification.checkedAt) >= Date.parse(verification.checkedAt)) {
        return { banked: false, reason: 'older' };
    }
    let persisted = false;
    try {
        writeSavedTraces(
            all.map((trace) => (trace.id === traceId ? { ...trace, verification } : trace)),
            scope,
        );
        const stored = loadSavedTraces(scope).find((trace) => trace.id === traceId);
        persisted =
            normaliseTraceVerification(stored?.verification, stored?.points)?.checkedAt === verification.checkedAt;
    } catch {
        /* quota — persisted stays false */
    }
    if (!persisted) return { banked: false, reason: 'storage' };
    clearTraceCheckOutcome(traceId, scope, verification.checkedAt);
    notifySavedRoutesChanged(scope);
    const voyageId = current.passageVoyageId?.trim();
    if (opts.refreshMirror !== false && voyageId && PASSAGE_VOYAGE_UUID.test(voyageId)) {
        const note = serialiseTraceVerificationNote(verification);
        void import('./VoyageService')
            .then(({ refreshSavedRouteVoyageVerification }) =>
                refreshSavedRouteVoyageVerification(voyageId, traceId, note),
            )
            .then((result) => {
                if (result?.error) log.warn(`check banked; passage mirror not refreshed (${result.error})`);
            })
            .catch((error) => log.warn('check banked; passage mirror refresh failed:', error));
    }
    const revision = current.updatedAt;
    if (opts.syncColumn !== false && scope.userId && revision) {
        void import('./savedRoutesSync')
            .then(({ pushSavedRouteVerification }) =>
                pushSavedRouteVerification(traceId, verification, revision, scope),
            )
            .catch((error) => log.warn('check banked; account copy not updated:', error));
    }
    return { banked: true };
}

/** persisted=false means storage refused (quota) — tell the skipper, don't
 *  flash "Saved ✓" over a trace that won't exist next session. `cloud`
 *  resolves with the account-push outcome so the UI can be equally honest
 *  about the desktop→phone hop ('signedout' = never left this browser). */
export function saveTrace(
    name: string,
    points: readonly TracePoint[],
    opts: {
        overwriteId?: string;
        tripId?: string;
        legOrdinal?: number;
        destName?: string;
        plannedRouteId?: string;
        passageVoyageId?: string;
        verification?: TraceVerification;
        proposalEvidence?: SavedAutoroutingProposalEvidence;
    } = {},
): { trace: SavedTrace; persisted: boolean; cloud: Promise<import('./savedRoutesSync').PushResult> } {
    const identity = getAuthIdentityScope();
    // Overwrite KEEPS the id: the local replace and the cloud upsert (also
    // keyed on id) then update the SAME route instead of minting a twin
    // (Shane 2026-07-15: "if I save it as the same name, it overwrites").
    const existing = opts.overwriteId ? loadSavedTraces(identity).find((t) => t.id === opts.overwriteId) : undefined;
    // Trip-chain fields: opts win, then the existing copy's — a plain
    // re-save of a chained leg must never shed its trip membership.
    const tripId = opts.tripId ?? existing?.tripId;
    const legOrdinal = opts.legOrdinal ?? existing?.legOrdinal;
    const destName = opts.destName ?? existing?.destName;
    const plannedRouteId = opts.plannedRouteId ?? existing?.plannedRouteId;
    const passageVoyageId = opts.passageVoyageId ?? existing?.passageVoyageId;
    // Preserve a prior check only while it still proves the exact geometry.
    // A moved waypoint silently drops it; MapHub supplies the freshly-earned
    // envelope after the replacement line has finished grading.
    const verification = normaliseTraceVerification(opts.verification ?? existing?.verification, points);
    const normalised = normaliseAutoroutingProposalEvidence(
        opts.proposalEvidence ?? existing?.proposalEvidence,
        points,
    );
    if (opts.proposalEvidence !== undefined && !normalised)
        throw new Error('Proposal evidence is incomplete or does not match these waypoints. Nothing was saved.');
    const proposalEvidence = normalised && chartFreeEvidence(normalised);
    const trace: SavedTrace = {
        // Random suffix: two saves in the same millisecond used to mint the
        // SAME id, and the by-id dedupe silently swallowed the first route
        // (surfaced by the trip-chain tests saving leg 1 + leg 2 back-to-back).
        id: existing?.id ?? `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() || `Trace ${new Date().toLocaleDateString('en-AU')}`,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        ...(existing ? { updatedAt: new Date().toISOString() } : {}),
        points: points.map((p) => ({ lat: p.lat, lon: p.lon })),
        ...(tripId ? { tripId } : {}),
        ...(legOrdinal ? { legOrdinal } : {}),
        ...(destName ? { destName } : {}),
        ...(plannedRouteId ? { plannedRouteId } : {}),
        ...(passageVoyageId ? { passageVoyageId } : {}),
        ...(verification ? { verification } : {}),
        ...(proposalEvidence ? { proposalEvidence } : {}),
    };
    // writeSavedTraces applies the cap (with the followed-trip exemption).
    const all = [trace, ...loadSavedTraces(identity).filter((t) => t.id !== trace.id)];
    let persisted = false;
    try {
        writeSavedTraces(all, identity);
        // A deliberate save with the same id is the only operation allowed to
        // revive a local tombstone. Clear it only AFTER the new payload is
        // durable; a failed write must leave the safer delete fence intact.
        clearSavedTraceTombstone(trace.id, identity);
        // Same-id overwrite: the OLD copy would satisfy a bare id check even
        // after quota refused the write — match the freshness stamp too.
        persisted = loadSavedTraces(identity).some(
            (t) => t.id === trace.id && (t.updatedAt ?? t.createdAt) === (trace.updatedAt ?? trace.createdAt),
        );
    } catch {
        /* quota — persisted stays false */
    }
    // Account sync (Phase 5.3): best-effort push so the route follows the
    // punter across devices — build on the desktop, sail on the phone.
    // ONLY when the local write stuck: repair paths mint a fresh random id
    // per attempt, so a quota-refused local write that still uploaded minted
    // a duplicate cloud row per retry (2026-08-04 audit).
    const cloudSnapshot: SavedTrace = JSON.parse(JSON.stringify(trace));
    const cloud = persisted
        ? import('./savedRoutesSync')
              .then(({ pushSavedRoute }) => pushSavedRoute(cloudSnapshot, identity))
              .catch(() => 'error' as const)
        : Promise.resolve('error' as const);
    if (persisted) notifySavedRoutesChanged(identity);
    return { trace, persisted, cloud };
}

/** A new planned itinerary is indivisible on this device: validate all rows,
 * write once, then publish once and start best-effort account sync. Existing
 * rows are retained verbatim; capacity refusal never evicts an older trip. */
export function saveTraceTrip(
    inputs: readonly {
        name: string;
        points: readonly TracePoint[];
        destName?: string;
        proposalEvidence: SavedAutoroutingProposalEvidence;
    }[],
    expectedScope: AuthIdentityScope,
): { traces: SavedTrace[]; persisted: boolean; cloud: Promise<import('./savedRoutesSync').PushResult[]> } {
    const assertScope = () => {
        if (!expectedScope.userId || !isAuthIdentityScopeCurrent(expectedScope))
            throw new Error('Your account changed. Nothing was saved.');
    };
    assertScope();
    if (!Array.isArray(inputs as unknown) || inputs.length < 1 || inputs.length > 2)
        throw new Error('A day itinerary must contain one or two complete routes.');
    const createdAt = new Date().toISOString();
    const batchId = `trace-${crypto.randomUUID()}`;
    const traces: SavedTrace[] = inputs.map((input, index) => {
        const name = input.name.trim();
        if (!name || name.length > 120) throw new Error('Enter route names between 1 and 120 characters.');
        const points = input.points.map(({ lat, lon }) => ({ lat, lon }));
        const normalised = normaliseAutoroutingProposalEvidence(input.proposalEvidence, points);
        if (!normalised)
            throw new Error('Proposal evidence is incomplete or does not match these waypoints. Nothing was saved.');
        const proposalEvidence = chartFreeEvidence(normalised);
        const destName = input.destName?.trim();
        if (destName !== undefined && (!destName || destName.length > 120))
            throw new Error('The route destination label is invalid. Nothing was saved.');
        return {
            id: index === 0 ? batchId : `${batchId}-${index + 1}`,
            name,
            points,
            createdAt,
            ...(inputs.length > 1 ? { tripId: batchId, legOrdinal: index + 1 } : {}),
            ...(destName ? { destName } : {}),
            proposalEvidence,
        };
    });
    const key = tracesStorageKey(expectedScope);
    // Do not turn an unreadable library into an empty library and overwrite it.
    const previous = localStorage.getItem(key);
    let stored: unknown;
    try {
        stored = previous === null ? [] : JSON.parse(previous);
    } catch {
        throw new Error('Saved Routes could not be read. Nothing was saved.');
    }
    if (!Array.isArray(stored)) throw new Error('Saved Routes could not be read. Nothing was saved.');
    if (stored.length + traces.length > 50)
        throw new Error('Saved Routes is full. Free space before saving the complete itinerary.');
    const tombstones = getSavedTraceTombstones(expectedScope);
    if (traces.some((trace) => stored.some((row) => row?.id === trace.id) || tombstones[trace.id]))
        throw new Error('A route identity conflicted. Retry saving the itinerary.');
    const payload = JSON.stringify([...traces, ...stored]);
    const cloudSnapshots: SavedTrace[] = JSON.parse(JSON.stringify(traces));
    assertScope();
    let persisted = false;
    try {
        localStorage.setItem(key, payload);
        persisted = localStorage.getItem(key) === payload;
    } catch {
        /* Quota refusal is atomic in localStorage; no row is pushed remotely. */
    }
    assertScope();
    const cloud = persisted
        ? import('./savedRoutesSync')
              .then(({ pushSavedRoute }) =>
                  Promise.all(
                      cloudSnapshots.map((trace) =>
                          isAuthIdentityScopeCurrent(expectedScope)
                              ? pushSavedRoute(trace, expectedScope).catch(() => 'error' as const)
                              : Promise.resolve('stale' as const),
                      ),
                  ),
              )
              .catch(() => cloudSnapshots.map(() => 'error' as const))
        : Promise.resolve(cloudSnapshots.map(() => 'error' as const));
    if (persisted) notifySavedRoutesChanged(expectedScope);
    return { traces, persisted, cloud };
}

/**
 * Attach the exact records created by PassagePlanSave to an already-persisted
 * trace. It is intentionally a separate mutation: tracer geometry saves
 * first (offline-first), then the compatibility mirror returns its ids later.
 */
export function linkTraceToPassage(
    id: string,
    links: TracePassageLinks,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): SavedTrace | null {
    const traceId = id.trim();
    if (!traceId || !isAuthIdentityScopeCurrent(expectedScope)) return null;
    const tombstones = getSavedTraceTombstones(expectedScope);
    if (Object.prototype.hasOwnProperty.call(tombstones, traceId)) return null;
    const traces = loadSavedTraces(expectedScope);
    const previous = traces.find((trace) => trace.id === traceId);
    if (!previous) return null;
    const linked: SavedTrace = {
        ...previous,
        ...(links.plannedRouteId ? { plannedRouteId: links.plannedRouteId } : {}),
        ...(links.passageVoyageId ? { passageVoyageId: links.passageVoyageId } : {}),
        updatedAt: new Date().toISOString(),
    };
    try {
        writeSavedTraces(
            traces.map((trace) => (trace.id === traceId ? linked : trace)),
            expectedScope,
        );
    } catch {
        return null;
    }
    void import('./savedRoutesSync')
        .then(({ pushSavedRoute }) => pushSavedRoute(linked, expectedScope))
        .catch(() => {});
    notifySavedRoutesChanged(expectedScope);
    return linked;
}

/**
 * Remove one saved trace locally, then tombstone it for the signed-in account.
 *
 * Callers that started an async operation should pass their captured scope so
 * an account switch cannot turn a late delete into a mutation of the next
 * skipper's route library.
 */
export function deleteTrace(id: string, expectedScope: AuthIdentityScope = getAuthIdentityScope()): boolean {
    const traceId = id.trim();
    const identity = expectedScope;
    if (!traceId || !isAuthIdentityScopeCurrent(identity)) return false;
    const current = loadSavedTraces(identity);
    const target = current.find((trace) => trace.id === traceId);
    if (!target) return false;
    const deletedAt = new Date().toISOString();
    const rebased = rebaseSavedTraceChainAfterDelete(current, traceId, deletedAt);
    try {
        // Fence first: sync may be running on another task, and must never
        // win a race by writing the soon-to-be-deleted remote row back here.
        const tombstones = getSavedTraceTombstones(identity);
        tombstones[traceId] = {
            deletedAt,
            ...(target.plannedRouteId ? { plannedRouteId: target.plannedRouteId } : {}),
            ...(target.passageVoyageId ? { passageVoyageId: target.passageVoyageId } : {}),
        };
        writeSavedTraceTombstones(tombstones, identity);
        writeSavedTraces(rebased.traces, identity);
    } catch {
        return false;
    }
    notifySavedRoutesChanged(identity);
    // Tombstone the deleted row and immediately publish every promoted leg;
    // one remote pull therefore observes a complete, contiguous chain.
    void import('./savedRoutesSync')
        .then(({ pushSavedRoute, pushSavedRouteDelete }) => {
            for (const trace of rebased.changed) void pushSavedRoute(trace, identity);
            return pushSavedRouteDelete(traceId, identity, deletedAt);
        })
        .catch(() => {});
    // The chart trace, its planned Log mirror, and its Passage Planning row
    // are a graph. The graph cleanup is deliberately async so the UI can
    // remove the route instantly, but it uses immutable ids rather than a
    // label/date heuristic and is retried after a late mirror save.
    void import('./savedRouteGraph')
        .then(({ deleteSavedRoutePassageGraph }) =>
            deleteSavedRoutePassageGraph(
                traceId,
                {
                    plannedRouteId: target.plannedRouteId,
                    passageVoyageId: target.passageVoyageId,
                },
                identity,
            ),
        )
        .catch(() => {});
    return true;
}
