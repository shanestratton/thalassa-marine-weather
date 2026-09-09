import type { Voyage } from './VoyageService';
import type { SavedTrace } from './routeTracer';
import { buildTraceStubRows, TRACE_STUB_ID_PREFIX } from './savedRouteRows';

const SETUP_ID_PREFIX = 'castoff-setup:';

/** A preflight choice is not a voyage until the skipper confirms Cast Off. */
export function isUnsavedCastOffSetup(voyage: Pick<Voyage, 'id'>): boolean {
    return voyage.id.startsWith(SETUP_ID_PREFIX) || voyage.id.startsWith(TRACE_STUB_ID_PREFIX);
}

export function createCastOffSetup(
    details: Pick<Voyage, 'voyage_name' | 'departure_port' | 'destination_port' | 'crew_count'>,
    ownerId: string | null,
): Voyage {
    const timestamp = new Date().toISOString();
    return {
        ...details,
        id: `${SETUP_ID_PREFIX}${crypto.randomUUID()}`,
        user_id: ownerId ?? '',
        vessel_id: null,
        departure_time: null,
        eta: null,
        status: 'planning',
        weather_master_id: null,
        notes: null,
        created_at: timestamp,
        updated_at: timestamp,
    };
}

/**
 * Cast Off offers saved routes, not a history of abandoned setup screens.
 * Legacy planning rows stay intact: they may own crew or planning records,
 * so hiding an unlinked setup here must never become a database deletion.
 * Explicit selections arriving from Passage Planning are handled separately.
 */
export function castOffRouteChoices(
    planningRows: readonly Voyage[],
    traces: readonly SavedTrace[],
    vessel: Parameters<typeof buildTraceStubRows>[2],
): Voyage[] {
    const traceByVoyage = new Map(
        traces.filter((trace) => trace.passageVoyageId).map((trace) => [trace.passageVoyageId!, trace.id]),
    );
    const routes = new Map<string, Voyage>();
    for (const row of planningRows) {
        if (row.status !== 'planning') continue;
        const routeId = row.saved_route_id?.trim() || traceByVoyage.get(row.id);
        if (!routeId) continue;
        // A complete passage and its first leg share a trace ID, but are
        // different choices. Never merge by name or destination alone.
        const key = `${/\(passage\)/i.test(row.voyage_name) ? 'passage:' : 'route:'}${routeId}`;
        const previous = routes.get(key);
        if (
            !previous ||
            (Date.parse(row.updated_at || row.created_at) || 0) >
                (Date.parse(previous.updated_at || previous.created_at) || 0)
        ) {
            routes.set(key, { ...row, saved_route_id: routeId });
        }
    }
    const saved = [...routes.values()];
    return [...saved, ...buildTraceStubRows(traces, saved, vessel)];
}
