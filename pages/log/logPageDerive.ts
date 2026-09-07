/**
 * Derived-value bodies for LogPage — the pure insides of its useMemo calls,
 * lifted verbatim out of pages/LogPage.tsx. The useMemo calls (and therefore
 * the hook order) stay in the page; only the arithmetic moved.
 */

import type { ShipLogEntry } from '../../types';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import {
    collapseReversedRoutes,
    type CollapsedRoute,
    type ReversibleRoute,
} from '../../services/shiplog/collapseReversedRoutes';
import { orderSavedRouteRows, type SavedRouteOrderable } from '../../services/savedRouteOrder';
import {
    localTraceLinkByVoyageId,
    savedTraceFollowBlockReason,
    tripIdentityByTraceId,
    type TraceTripIdentity,
} from '../../services/traceDirectUseGate';
import {
    groupTracesByTrip,
    legBadgeOrdinal,
    loadSavedTraces,
    stripLegBadge,
    type SavedTrace,
} from '../../services/routeTracer';
import {
    NO_ENTRIES,
    type FollowPromptOrderedRow,
    type FollowPromptRow,
    type FollowSheetChoice,
    type MissingTripLeg,
} from './logPageTypes';

/** What the sheet reads off the trace store — injectable so the pure parts are testable. */
export interface FollowSheetDeps {
    tripByTraceId: () => ReadonlyMap<string, TraceTripIdentity>;
    traceLinkByVoyageId: () => ReadonlyMap<string, string>;
    blockReason: (savedRouteId: string) => string | null;
    traces: () => readonly SavedTrace[];
}

const liveDeps: FollowSheetDeps = {
    tripByTraceId: tripIdentityByTraceId,
    traceLinkByVoyageId: localTraceLinkByVoyageId,
    blockReason: savedTraceFollowBlockReason,
    traces: () => loadSavedTraces(),
};

/**
 * The Log is the factual record of where the boat has actually been.
 * Keep saved plans resident in the raw state — cast-off choices, followed
 * route geometry and planned-vs-sailed overlays still need them — but do
 * not present them as completed voyages. Check both summary classification
 * and entry source so offline-only plans (not yet in the summary RPC) are
 * excluded too.
 */
export function derivePlannedVoyageIds(
    entries: readonly ShipLogEntry[],
    summaries: readonly VoyageSummary[] | undefined,
): Set<string> {
    const ids = new Set<string>();
    for (const summary of summaries ?? []) {
        if (summary.isPlannedRoute && summary.voyageId) ids.add(summary.voyageId);
    }
    for (const entry of entries) {
        if (entry.source === 'planned_route' && entry.voyageId) ids.add(entry.voyageId);
    }
    return ids;
}

/** Latest trustworthy fix of the voyage being recorded, read off the entries. */
export function deriveCurrentFix(
    entries: readonly ShipLogEntry[],
    currentVoyageId: string | null | undefined,
): { lat: number; lon: number } | null {
    const vid = currentVoyageId;
    if (!vid) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.voyageId !== vid) continue;
        if (!e.latitude || !e.longitude) continue;
        if (e.latitude === 0 && e.longitude === 0) continue;
        return { lat: e.latitude, lon: e.longitude };
    }
    return null;
}

/** voyageId → savedRouteId, read off the resident plan entries (the link
 *  lives on entries, not summaries). */
export function derivePlannedRouteLinkIds(entries: readonly ShipLogEntry[]): Map<string, string> {
    const byVoyage = new Map<string, string>();
    for (const entry of entries) {
        if (!entry.voyageId || byVoyage.has(entry.voyageId)) continue;
        const sid = entry.savedRouteId;
        if (typeof sid === 'string' && sid.length > 0) byVoyage.set(entry.voyageId, sid);
    }
    return byVoyage;
}

/**
 * EVERY planned route reaches the sheet; ones the follow gate refuses render
 * disabled with the gate's reason on the row.
 *
 * Two link sources, because entries may not be resident on a fresh boot:
 * the entry rows when loaded, else the local trace store's own
 * plannedRouteId mirror. An ordinary plan (no trace link) has no gate to
 * fail and is always pickable.
 */
export function buildFollowSheetChoices(
    plannedChoices: readonly CollapsedRoute<VoyageSummary>[],
    plannedRouteLinkIds: ReadonlyMap<string, string>,
    deps: FollowSheetDeps = liveDeps,
): FollowSheetChoice[] {
    const traceLinks = deps.traceLinkByVoyageId();
    /* The sheet's rows are VoyageSummary, which carries no trip or leg
       identity — which is why this list was flat while the Plan page showed
       the same routes grouped. The trace store knows, and the row already
       resolves to a trace id, so the grouping costs one lookup and no
       guesswork (Shane 2026-08-30). */
    const trips = deps.tripByTraceId();
    return plannedChoices.map((choice) => {
        const vid = choice.summary.voyageId;
        const sid = plannedRouteLinkIds.get(vid) ?? traceLinks.get(vid);
        const trip = sid ? trips.get(sid) : undefined;
        return {
            ...choice,
            savedRouteId: sid ?? null,
            blockReason: sid ? deps.blockReason(sid) : null,
            ...(trip ?? {}),
        };
    });
}

/** The planned routes that are legs of a trip, by the same trace link the sheet resolves. */
function tripLegVoyageIds(
    summaries: readonly { voyageId: string }[],
    plannedRouteLinkIds: ReadonlyMap<string, string>,
    deps: FollowSheetDeps,
): Set<string> {
    const traceLinks = deps.traceLinkByVoyageId();
    const trips = deps.tripByTraceId();
    const out = new Set<string>();
    for (const s of summaries) {
        const sid = plannedRouteLinkIds.get(s.voyageId) ?? traceLinks.get(s.voyageId);
        if (sid && trips.has(sid)) out.add(s.voyageId);
    }
    return out;
}

/**
 * Fold there-and-back pairs into one choice — but never a leg of a trip.
 *
 * A passage's legs chain end-to-start, so a homeward leg is the exact reverse
 * of an outbound one, and the fold that was written for day sails ate the
 * last leg of Newport → Whitsundays under its own return (Shane 2026-09-08:
 * "it is not showing me the last leg?"). Legs stay where they are, unfolded;
 * everything else folds as before. Input order is preserved.
 */
export function collapseOutsideTrips<T extends ReversibleRoute>(
    summaries: readonly T[],
    plannedRouteLinkIds: ReadonlyMap<string, string>,
    fix: { lat: number; lon: number } | null,
    deps: FollowSheetDeps = liveDeps,
): CollapsedRoute<T>[] {
    const legIds = tripLegVoyageIds(summaries, plannedRouteLinkIds, deps);
    const folded = new Map(
        collapseReversedRoutes(
            summaries.filter((s) => !legIds.has(s.voyageId)),
            fix,
        ).map((c) => [c.summary.voyageId, c] as const),
    );
    const out: CollapsedRoute<T>[] = [];
    for (const s of summaries) {
        if (legIds.has(s.voyageId)) {
            out.push({ summary: s, reversible: false });
            continue;
        }
        const survivor = folded.get(s.voyageId);
        if (survivor) out.push(survivor);
    }
    return out;
}

/**
 * Legs of a trip the sheet shows that have no planned-route row to offer —
 * saved in Route Tracer, never mirrored into the log. Named in ordinal place
 * so the passage reads whole, with the fix one line away.
 */
export function missingTripLegs(
    choices: readonly FollowSheetChoice[],
    deps: FollowSheetDeps = liveDeps,
): MissingTripLeg[] {
    const tripIds = new Set<string>();
    const present = new Set<string>();
    for (const c of choices) {
        if (c.tripId) tripIds.add(c.tripId);
        if (c.savedRouteId) present.add(c.savedRouteId);
    }
    if (tripIds.size === 0) return [];
    const out: MissingTripLeg[] = [];
    for (const group of groupTracesByTrip(deps.traces())) {
        if (!tripIds.has(group.key)) continue;
        group.legs.forEach((leg, index) => {
            if (present.has(leg.id)) return;
            out.push({
                tripId: group.key,
                legOrdinal: leg.legOrdinal ?? legBadgeOrdinal(leg.name) ?? index + 1,
                name: stripLegBadge(leg.name),
                savedRouteId: leg.id,
                stamp: Date.parse(leg.updatedAt ?? leg.createdAt) || 0,
            });
        });
    }
    return out;
}

/**
 * The sheet's running order: passages first with their legs beneath, day
 * sails after, newest group first — the same arithmetic the Plan page and
 * Passage Planning use, from services/savedRouteOrder.
 *
 * A heading is emitted when a group's first leg appears. Legs whose trip
 * has no name resolved were already demoted to standalone upstream, so a
 * dog-leg arrow can never sit under nothing.
 */
export function buildFollowPromptRows(
    followPromptChoices: readonly FollowSheetChoice[],
    missing: readonly MissingTripLeg[] = [],
): FollowPromptRow[] {
    type ChoiceRow = FollowPromptOrderedRow & { missing?: undefined };
    type MissingRow = SavedRouteOrderable & { missing: MissingTripLeg; choice?: undefined };
    const tripNameByGroup = new Map<string, string>();
    for (const choice of followPromptChoices) {
        if (choice.tripId && choice.tripName) tripNameByGroup.set(choice.tripId, choice.tripName);
    }
    const ordered = orderSavedRouteRows<ChoiceRow | MissingRow>([
        ...followPromptChoices.map(
            (choice): ChoiceRow => ({
                choice,
                kind: choice.tripName ? ('leg' as const) : ('standalone' as const),
                groupKey: choice.tripId ?? choice.summary.voyageId,
                legOrdinal: choice.legOrdinal,
                stamp: Date.parse(choice.summary.startedAt) || 0,
            }),
        ),
        ...missing.map(
            (leg): MissingRow => ({
                missing: leg,
                kind: 'leg' as const,
                groupKey: leg.tripId,
                legOrdinal: leg.legOrdinal,
                stamp: leg.stamp,
            }),
        ),
    ]);
    const rows: FollowPromptRow[] = [];
    let openGroup: string | null = null;
    for (const row of ordered) {
        if (row.kind === 'leg' && row.groupKey !== openGroup) {
            const name = row.missing ? tripNameByGroup.get(row.groupKey) : row.choice.tripName;
            rows.push({ type: 'passage', key: `passage:${row.groupKey}`, name: name ?? row.missing?.name ?? '' });
        }
        openGroup = row.groupKey;
        if (row.missing)
            rows.push({ type: 'missing-leg', key: `missing:${row.missing.savedRouteId}`, leg: row.missing });
        else rows.push({ type: 'choice', key: row.choice.summary.voyageId, row });
    }
    return rows;
}

/** Live-recording card stats — one pass over the active voyage's entries. */
export function deriveLiveStats(
    entries: readonly ShipLogEntry[],
    currentVoyageId: string | null | undefined,
): {
    activeEntries: ShipLogEntry[];
    first: ShipLogEntry | undefined;
    dist: number;
    durationHrs: number;
    durationMins: number;
    liveAvgSpeed: number;
} {
    const activeEntries = currentVoyageId ? entries.filter((e) => e.voyageId === currentVoyageId) : NO_ENTRIES;
    let dist = 0;
    let first: ShipLogEntry | undefined;
    let firstMs = Infinity;
    let lastMs = -Infinity;
    let speedSum = 0;
    let speedN = 0;
    for (const e of activeEntries) {
        const d = e.cumulativeDistanceNM || 0;
        if (d > dist) dist = d;
        const t = new Date(e.timestamp).getTime();
        if (Number.isFinite(t)) {
            if (t < firstMs) {
                firstMs = t;
                first = e;
            }
            if (t > lastMs) lastMs = t;
        }
        if (e.speedKts && e.speedKts > 0) {
            speedSum += e.speedKts;
            speedN++;
        }
    }
    const durationMs = Number.isFinite(firstMs) && Number.isFinite(lastMs) ? lastMs - firstMs : 0;
    return {
        activeEntries,
        first,
        dist,
        durationHrs: Math.floor(durationMs / 3600000),
        durationMins: Math.floor((durationMs % 3600000) / 60000),
        liveAvgSpeed: speedN > 0 ? speedSum / speedN : 0,
    };
}

/** Voyage list — one pass over entries instead of one filter per card. */
export function deriveEntriesByVoyage(entries: readonly ShipLogEntry[]): Map<string, ShipLogEntry[]> {
    const m = new Map<string, ShipLogEntry[]>();
    for (const e of entries) {
        if (!e.voyageId) continue;
        const arr = m.get(e.voyageId);
        if (arr) arr.push(e);
        else m.set(e.voyageId, [e]);
    }
    return m;
}
