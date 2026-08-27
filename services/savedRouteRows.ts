/**
 * savedRouteRows — the Plan page's saved routes ARE the passage list.
 *
 * Shane's rule (2026-08-27): "a route is not removed from the list in the
 * cast off list or the passage planning page, unless it is removed from the
 * plan page — that should be our truth for the passage list."
 *
 * Before this, both lists were VOYAGE-ROW-first: a route appeared because a
 * `voyages` row with status='planning' existed, or because a logbook mirror
 * could be found for it. Every one of those is a lifecycle artefact, not the
 * route itself, so a live saved route could vanish four different ways —
 * End Voyage flipped its row to 'completed'; a tracer-only save (signed out,
 * offline, or caught by the duplicate-label guard) never minted a row at
 * all; a route synced from another device arrived with no local mirror; and
 * `adoptServerRoute` deliberately builds a trace with no links whatsoever.
 *
 * The fix is to run the list the other way round: after the row-derived
 * passes have had their say, every canonical trace with no representation
 * gets a stub. The stub materialises into a real voyage row on select, the
 * same way the derived "(Passage)" rollups already do.
 *
 * The deletion fence is inherited, not re-implemented: `loadSavedTraces`
 * already filters tombstoned ids, so a deleted route is absent from the
 * input and can never grow a stub. Deleting on the Plan page remains the
 * one way a route leaves these lists.
 */
import type { Voyage } from './VoyageService';
import type { SavedTrace } from './routeTracer';
import { destNameFromRouteName, originNameFromRouteName } from './routeTracer';
import { routeDistanceNm } from './passageSummarySchedule';
import { serialiseTraceVerificationNote } from './traceVerification';
import { vesselCrewAboard } from './units';

/** Route geometry carried alongside a planning row so the passage cards do
 *  not have to guess it from the globally cached chart route. */
export interface SavedRouteGeometry {
    departureCoords?: { lat: number; lon: number };
    arrivalCoords?: { lat: number; lon: number };
    routeCoordinates?: Array<{ lat: number; lon: number }>;
    /** Underlying planned-route log voyage. Distinct from this voyage-row ID. */
    plannedRouteId?: string;
    distanceNm?: number;
    durationHours?: number;
    /** True when this voyage belongs to a captain who shared it with us. */
    isShared?: boolean;
    sharedOwnerEmail?: string;
}

export type SavedRouteRow = Voyage & SavedRouteGeometry;

interface VesselShape {
    crewCount?: number;
    cruisingSpeed?: number;
}

/**
 * Stub ids keep the `logbook:` prefix every materialise-on-select path
 * already branches on (nothing parses the suffix), with a `trace:` infix so
 * the source is legible in a log line and can never collide with a
 * `planned_*` mirror id.
 */
export const TRACE_STUB_ID_PREFIX = 'logbook:trace:';

export function traceStubId(traceId: string): string {
    return `${TRACE_STUB_ID_PREFIX}${traceId}`;
}

/** The Cast Off verification envelope, which rides into `createVoyage` as
 *  `notes`. Without it a stub-materialised row casts off with a "not
 *  verified" caution even when the trace was checked. */
export function traceVerificationNote(trace: SavedTrace | undefined | null): string | undefined {
    return trace?.verification ? serialiseTraceVerificationNote(trace.verification) : undefined;
}

/**
 * Which canonical routes do these rows already stand for?
 *
 * Mirrors the picker's dedupe keying: a "(Passage)" row stands for the TRIP,
 * never for leg 1 — whose trace id doubles as the trip id. Missing that
 * distinction would suppress leg 1's own row every time a passage existed.
 */
function representedRouteIds(rows: readonly SavedRouteRow[]): Set<string> {
    const out = new Set<string>();
    for (const row of rows) {
        const base = row.saved_route_id?.trim();
        if (!base || /\(passage\)/i.test(row.voyage_name)) continue;
        out.add(base);
    }
    return out;
}

/**
 * A stub row for every canonical trace the existing rows do not already
 * show. Deterministic in every field — a fresh timestamp per reload would
 * make each pass emit "different" rows and re-fire the content-keyed
 * effects this page coalesces so carefully.
 */
export function buildTraceStubRows(
    traces: readonly SavedTrace[],
    existingRows: readonly SavedRouteRow[],
    vessel: VesselShape | null | undefined,
): SavedRouteRow[] {
    const represented = representedRouteIds(existingRows);
    const rowIds = new Set(existingRows.map((row) => row.id));
    const speedKt = vessel?.cruisingSpeed || 5.5;
    const crew = vesselCrewAboard(vessel);
    const out: SavedRouteRow[] = [];

    for (const trace of traces) {
        if (represented.has(trace.id)) continue;
        // The trace's own back-link naming a live row is representation too.
        if (trace.passageVoyageId && rowIds.has(trace.passageVoyageId)) continue;
        const routeCoordinates = (trace.points ?? []).filter(
            (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
        );
        if (routeCoordinates.length < 2) continue; // not a route yet

        const distanceNm = routeDistanceNm(routeCoordinates) ?? undefined;
        const durationHours = distanceNm ? distanceNm / speedKt : undefined;
        const stamp = trace.updatedAt ?? trace.createdAt;
        const stampMs = Date.parse(stamp);
        const eta =
            durationHours && Number.isFinite(stampMs)
                ? new Date(stampMs + durationHours * 3_600_000).toISOString()
                : null;

        out.push({
            id: traceStubId(trace.id),
            user_id: '',
            vessel_id: null,
            // The trace's STORED name, verbatim — the same shape a real
            // voyage row carries, because createVoyage was fed exactly this
            // at save time. Deliberately not displayRouteLabel(): that
            // renders the list form "A - B (Leg 2)", while the picker strips
            // and re-adds the stored "(2nd Leg)" badge itself, so passing the
            // list form through would double it ("… (Leg 2) (2nd Leg)").
            voyage_name: trace.name,
            departure_port: originNameFromRouteName(trace.name) ?? null,
            destination_port: trace.destName ?? destNameFromRouteName(trace.name) ?? null,
            departure_time: stamp,
            eta,
            crew_count: crew,
            status: 'planning',
            weather_master_id: null,
            notes: null,
            created_at: trace.createdAt,
            updated_at: stamp,
            saved_route_id: trace.id,
            departureCoords: routeCoordinates[0],
            arrivalCoords: routeCoordinates[routeCoordinates.length - 1],
            routeCoordinates,
            ...(trace.plannedRouteId ? { plannedRouteId: trace.plannedRouteId } : {}),
            distanceNm,
            durationHours,
        } as SavedRouteRow);
    }
    return out;
}
