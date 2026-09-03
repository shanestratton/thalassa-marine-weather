/**
 * CrewManagement — planning-row shaping: geometry preservation, one-row-per-
 * route pruning, and derived "(Passage)" rollups.
 *
 * Moved verbatim out of components/CrewManagement.tsx. These run on EVERY
 * paint (the cached fast paths included), which is why they live at module
 * scope rather than inside the component.
 */
import { buildTripPassageRollups, loadSavedTraces } from '../../services/routeTracer';
import { routeDistanceNm } from '../../services/passageSummarySchedule';
import { vesselCrewAboard } from '../../services/units';
import { type VoyageRow } from './types';

export const routeDayKey = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

/**
 * Carry already-attached route geometry forward onto a freshly-fetched row.
 *
 * reloadDropdown paints twice from bare DB `Voyage` objects before the phase
 * that attaches geometry runs. If that phase is cancelled — a concurrent
 * reload bumps the version guard — the rows are left downgraded, and the
 * Passage Planning summary shows "--" for Duration and Distance and
 * "Forecast unavailable" for Max Conditions, because every one of those is
 * derived from routeCoordinates.
 *
 * Merging instead of replacing means an aborted reload can only ever fail to
 * IMPROVE a row; it can never strip one. The fresh row still wins for every
 * server-owned field.
 */
export function preserveRouteGeometry(fresh: VoyageRow, previous: VoyageRow | undefined): VoyageRow {
    if (!previous) return fresh;
    return {
        ...fresh,
        departureCoords: fresh.departureCoords ?? previous.departureCoords,
        arrivalCoords: fresh.arrivalCoords ?? previous.arrivalCoords,
        routeCoordinates: fresh.routeCoordinates ?? previous.routeCoordinates,
        plannedRouteId: fresh.plannedRouteId ?? previous.plannedRouteId,
        distanceNm: fresh.distanceNm ?? previous.distanceNm,
        durationHours: fresh.durationHours ?? previous.durationHours,
    };
}

/**
 * ONE row per saved route (Shane 2026-08-27: "the list is doubling up and
 * sometimes even tripling up"). Every End-Voyage-then-replan cycle leaves a
 * planning row behind; they used to be hidden as unlinked, and the
 * 2026-08-26 link-healing resurrected them all — same route, many rows. Keep
 * the best row per canonical route: the skipper's current selection first,
 * then one that carries geometry, then a materialised voyage over a logbook
 * stub, then the most recently touched. Rows without a route link (manual
 * voyages) pass through untouched.
 *
 * Runs on EVERY paint — the cached fast paths included — so the first frame
 * and the settled list agree (Shane 2026-08-27: "ghost legs everywhere, but
 * they eventually go away and it becomes correct").
 */
export function pruneToBestRowPerRoute(
    rows: readonly VoyageRow[],
    traces: ReturnType<typeof loadSavedTraces>,
    selectedId: string,
): VoyageRow[] {
    const rowScore = (row: VoyageRow): number => {
        let score = 0;
        if (row.id === selectedId) score += 8;
        if ((row.routeCoordinates?.length ?? 0) >= 2) score += 4;
        if (!row.id.startsWith('logbook:')) score += 2;
        return score;
    };
    const rowStamp = (row: VoyageRow): number => Date.parse(row.updated_at ?? row.created_at ?? '') || 0;
    // A row can name its route two ways: saved_route_id on the row, or the
    // trace's passageVoyageId back-link naming the row. The remaining double
    // was one of each — same route, different key (Shane 2026-08-27
    // screenshot: two "(1st Leg)" rows).
    const traceByPassageVoyage = new Map<string, string>();
    for (const trace of traces) {
        if (trace.passageVoyageId) traceByPassageVoyage.set(trace.passageVoyageId, trace.id);
    }
    const routeKeyOf = (row: VoyageRow): string | undefined => {
        const base = row.saved_route_id?.trim() || traceByPassageVoyage.get(row.id);
        if (!base) return undefined;
        // Leg 1's trace id doubles as the trip id — a materialised passage
        // row must not collapse into leg 1's slot.
        return /\(passage\)/i.test(row.voyage_name) ? `trip:${base}` : base;
    };
    const bestByRoute = new Map<string, VoyageRow>();
    for (const row of rows) {
        const key = routeKeyOf(row);
        if (!key) continue;
        const existing = bestByRoute.get(key);
        if (
            !existing ||
            rowScore(row) > rowScore(existing) ||
            (rowScore(row) === rowScore(existing) && rowStamp(row) > rowStamp(existing))
        ) {
            bestByRoute.set(key, row);
        }
    }
    return rows.filter((row) => {
        const key = routeKeyOf(row);
        return !key || bestByRoute.get(key) === row;
    });
}

/**
 * Derived "(Passage)" rows (Shane-approved design 2026-08-04) — one per
 * multi-leg trip: the legs stitched, selectable exactly like any other
 * planning row. The `logbook:` id prefix reuses the materialise-on-select
 * path; saved_route_id is the trip's FIRST leg (its id IS the tripId — a
 * real trace), so the float plan waypoints and the Cast Off destination
 * seed both resolve. Suppressed once a materialised passage voyage exists
 * for the trip — and only a materialised PASSAGE row suppresses: leg 1's
 * trace id doubles as the trip id, so a plain leg row must not match
 * (Shane 2026-08-27, the vanishing "(Passage)" row).
 *
 * Shared with the cached fast paths so the passage heading exists from the
 * first frame, not only after the network pass.
 */
export function tripPassageRollupRows(
    traces: ReturnType<typeof loadSavedTraces>,
    ownRows: readonly VoyageRow[],
    vessel: { crewCount?: number; cruisingSpeed?: number } | null | undefined,
): VoyageRow[] {
    const rollupRows: VoyageRow[] = [];
    for (const rollup of buildTripPassageRollups(traces)) {
        if (ownRows.some((row) => row.saved_route_id === rollup.tripId && /\(passage\)/i.test(row.voyage_name)))
            continue;
        const routeCoordinates = rollup.points.map((point) => ({ lat: point.lat, lon: point.lon }));
        const distanceNm = routeDistanceNm(routeCoordinates) ?? undefined;
        const speedKt = vessel?.cruisingSpeed || 5.5;
        const durationHours = distanceNm ? distanceNm / speedKt : undefined;
        // DETERMINISTIC stamps (newest member leg), NOT Date.now(): a fresh
        // timestamp per reload made every pass produce a "different" row,
        // and downstream effects keyed on row content re-fired on each one —
        // churn this page cannot afford (see the storm-proofing note on the
        // reload listeners).
        const memberTraces = traces.filter((trace) => (trace.tripId ?? trace.id) === rollup.tripId);
        const newestIso = memberTraces.reduce(
            (acc, trace) => {
                const stamp = trace.updatedAt ?? trace.createdAt;
                return stamp > acc ? stamp : acc;
            },
            memberTraces[0]?.createdAt ?? new Date(0).toISOString(),
        );
        const newestMs = Date.parse(newestIso);
        const eta =
            durationHours && Number.isFinite(newestMs)
                ? new Date(newestMs + durationHours * 3_600_000).toISOString()
                : null;
        rollupRows.push({
            id: `logbook:${rollup.id}`,
            user_id: '',
            vessel_id: null,
            voyage_name: rollup.name,
            departure_port: rollup.originName,
            destination_port: rollup.destName,
            departure_time: newestIso,
            eta,
            crew_count: vesselCrewAboard(vessel),
            status: 'planning',
            weather_master_id: null,
            notes: null,
            created_at: newestIso,
            updated_at: newestIso,
            saved_route_id: rollup.tripId,
            departureCoords: routeCoordinates[0],
            arrivalCoords: routeCoordinates[routeCoordinates.length - 1],
            routeCoordinates,
            distanceNm,
            durationHours,
        } as VoyageRow);
    }
    return rollupRows;
}
