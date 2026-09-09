/** Read-only reconciliation of old planned-log mirrors with editable saved routes.
 * Names, distances and endpoints only identify candidates to inspect. A missing
 * link is repaired for this picker only after the complete, ordered geometry
 * matches PLAN's direction-sensitive fingerprint. No records are rewritten.
 */
import type { ShipLogEntry } from '../types';
import type { SavedTrace } from './routeTracer';
import type { VoyageSummary } from './shiplog/VoyageSummary';
import { savedRouteGeometryFingerprint } from './savedRouteLibrary';
import { ROUTE_GEOMETRY_NOTES_PREFIX } from './shiplog/PassagePlanSave';

export function completePlannedRouteFingerprint(
    summary: VoyageSummary,
    entries: readonly ShipLogEntry[],
): string | null {
    const unique = new Map<string, ShipLogEntry>();
    for (const entry of entries) {
        if (entry.voyageId !== summary.voyageId || entry.source !== 'planned_route' || !entry.id) return null;
        unique.set(entry.id, entry);
    }
    if (!Number.isInteger(summary.entryCount) || summary.entryCount < 2 || unique.size !== summary.entryCount) {
        return null; // a partial/offline page cannot prove that two routes are the same
    }
    const ordered = [...unique.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (ordered.some((entry) => !Number.isFinite(Date.parse(entry.timestamp)))) return null;
    // PLAN prefers the stored curved line, not the sparse waypoint entries.
    const notes = ordered[0].notes;
    if (notes?.startsWith(ROUTE_GEOMETRY_NOTES_PREFIX)) {
        try {
            const encoded = notes.slice(ROUTE_GEOMETRY_NOTES_PREFIX.length).split('\n', 1)[0];
            if (encoded.length > 250_000) return null;
            const curve: unknown = JSON.parse(encoded);
            if (!Array.isArray(curve) || curve.some((point) => !Array.isArray(point) || point.length < 2)) return null;
            return savedRouteGeometryFingerprint(curve.map((point) => ({ lat: point[1], lon: point[0] })));
        } catch {
            return null;
        }
    }
    return savedRouteGeometryFingerprint(ordered.map((entry) => ({ lat: entry.latitude, lon: entry.longitude })));
}

/** Endpoints narrow the read budget, never establish identity. */
export function possibleUnlinkedRouteMirrors(
    summaries: readonly VoyageSummary[],
    links: ReadonlyMap<string, string>,
    traces: readonly SavedTrace[],
): VoyageSummary[] {
    return summaries.filter((summary) => {
        if (links.has(summary.voyageId) || !summary.isPlannedRoute) return false;
        // Canonical traces have at most 200 pins. Refuse an unbounded detail
        // load if corrupt summary metadata describes a whole recorded voyage.
        if (!Number.isInteger(summary.entryCount) || summary.entryCount < 2 || summary.entryCount > 400) return false;
        return traces.some((trace) => {
            const first = trace.points[0];
            const last = trace.points[trace.points.length - 1];
            if (!first || !last) return false;
            return (
                summary.firstLat !== null &&
                summary.firstLon !== null &&
                summary.lastLat !== null &&
                summary.lastLon !== null &&
                Math.abs(summary.firstLat - first.lat) < 0.001 &&
                Math.abs(summary.firstLon - first.lon) < 0.001 &&
                Math.abs(summary.lastLat - last.lat) < 0.001 &&
                Math.abs(summary.lastLon - last.lon) < 0.001
            );
        });
    });
}

export function reconcileFollowRouteMirrors(
    summaries: readonly VoyageSummary[],
    entryLinks: ReadonlyMap<string, string>,
    traces: readonly SavedTrace[],
    fingerprints: ReadonlyMap<string, string>,
): { summaries: VoyageSummary[]; links: Map<string, string>; geometryLinks: Map<string, string> } {
    const links = new Map(entryLinks);
    const tracesById = new Map(traces.map((trace) => [trace.id, trace]));
    const byGeometry = new Map<string, string[]>();
    for (const trace of traces) {
        if (trace.plannedRouteId && !links.has(trace.plannedRouteId)) links.set(trace.plannedRouteId, trace.id);
        if (trace.passageVoyageId && !links.has(trace.passageVoyageId)) links.set(trace.passageVoyageId, trace.id);
        const fingerprint = savedRouteGeometryFingerprint(trace.points);
        if (!fingerprint) continue;
        const ids = byGeometry.get(fingerprint) ?? [];
        ids.push(trace.id);
        byGeometry.set(fingerprint, ids);
    }
    for (const summary of summaries) {
        if (links.has(summary.voyageId)) continue;
        const fingerprint = fingerprints.get(summary.voyageId);
        const matches = fingerprint ? byGeometry.get(fingerprint) : undefined;
        // Distinct saved routes may deliberately share a line. An ambiguous
        // geometry match must never choose a different trip on the user's behalf.
        if (matches?.length === 1) links.set(summary.voyageId, matches[0]);
    }
    const geometryLinks = new Map(links);
    for (const summary of summaries) {
        const traceId = links.get(summary.voyageId);
        const trace = traceId ? tracesById.get(traceId) : undefined;
        if (
            trace &&
            summary.voyageId === trace.passageVoyageId &&
            summary.voyageId !== trace.plannedRouteId &&
            (!fingerprints.has(summary.voyageId) ||
                fingerprints.get(summary.voyageId) !== savedRouteGeometryFingerprint(trace.points))
        ) {
            // A passage anchor is enough to group a row, never to replace
            // the whole passage with its first leg when the skipper follows it.
            geometryLinks.delete(summary.voyageId);
        }
    }
    const mirrorTraceId = (summary: VoyageSummary): string | undefined => {
        if (!summary.isPlannedRoute) return undefined;
        const id = links.get(summary.voyageId);
        const trace = id ? tracesById.get(id) : undefined;
        if (!trace) return undefined;
        // The actual planning/sailed passage and its first leg may share an
        // anchor trace. That is a link, not proof that their journeys match.
        if (summary.voyageId === trace.passageVoyageId && summary.voyageId !== trace.plannedRouteId) return undefined;
        return id;
    };
    const winnerByTrace = new Map<string, VoyageSummary>();
    for (const summary of summaries) {
        const traceId = mirrorTraceId(summary);
        if (!traceId) continue;
        const previous = winnerByTrace.get(traceId);
        const canonicalMirror = tracesById.get(traceId)?.plannedRouteId;
        if (
            !previous ||
            summary.voyageId === canonicalMirror ||
            (previous.voyageId !== canonicalMirror &&
                ((Date.parse(summary.startedAt) || 0) > (Date.parse(previous.startedAt) || 0) ||
                    (summary.startedAt === previous.startedAt && summary.voyageId < previous.voyageId)))
        )
            winnerByTrace.set(traceId, summary);
    }
    return {
        summaries: summaries.filter((summary) => {
            const traceId = mirrorTraceId(summary);
            return !traceId || !winnerByTrace.has(traceId) || winnerByTrace.get(traceId) === summary;
        }),
        links,
        geometryLinks,
    };
}
