/**
 * Derived-value bodies for LogPage — the pure insides of its useMemo calls,
 * lifted verbatim out of pages/LogPage.tsx. The useMemo calls (and therefore
 * the hook order) stay in the page; only the arithmetic moved.
 */

import type { ShipLogEntry } from '../../types';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import type { CollapsedRoute } from '../../services/shiplog/collapseReversedRoutes';
import { orderSavedRouteRows } from '../../services/savedRouteOrder';
import {
    localTraceLinkByVoyageId,
    savedTraceFollowBlockReason,
    tripIdentityByTraceId,
} from '../../services/traceDirectUseGate';
import { NO_ENTRIES, type FollowPromptOrderedRow, type FollowPromptRow, type FollowSheetChoice } from './logPageTypes';

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
): FollowSheetChoice[] {
    const traceLinks = localTraceLinkByVoyageId();
    /* The sheet's rows are VoyageSummary, which carries no trip or leg
       identity — which is why this list was flat while the Plan page showed
       the same routes grouped. The trace store knows, and the row already
       resolves to a trace id, so the grouping costs one lookup and no
       guesswork (Shane 2026-08-30). */
    const trips = tripIdentityByTraceId();
    return plannedChoices.map((choice) => {
        const vid = choice.summary.voyageId;
        const sid = plannedRouteLinkIds.get(vid) ?? traceLinks.get(vid);
        const trip = sid ? trips.get(sid) : undefined;
        return {
            ...choice,
            savedRouteId: sid ?? null,
            blockReason: sid ? savedTraceFollowBlockReason(sid) : null,
            ...(trip ?? {}),
        };
    });
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
export function buildFollowPromptRows(followPromptChoices: readonly FollowSheetChoice[]): FollowPromptRow[] {
    const ordered = orderSavedRouteRows<FollowPromptOrderedRow>(
        followPromptChoices.map((choice) => ({
            choice,
            kind: choice.tripName ? ('leg' as const) : ('standalone' as const),
            groupKey: choice.tripId ?? choice.summary.voyageId,
            legOrdinal: choice.legOrdinal,
            stamp: Date.parse(choice.summary.startedAt) || 0,
        })),
    );
    const rows: FollowPromptRow[] = [];
    let openGroup: string | null = null;
    for (const row of ordered) {
        if (row.kind === 'leg' && row.groupKey !== openGroup) {
            rows.push({ type: 'passage', key: `passage:${row.groupKey}`, name: row.choice.tripName as string });
        }
        openGroup = row.groupKey;
        rows.push({ type: 'choice', key: row.choice.summary.voyageId, row });
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
