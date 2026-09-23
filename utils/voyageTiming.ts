import type { ShipLogEntry } from '../types';

// Sparse historical tracks retain their recorded span if there is not enough
// evidence to estimate departure. Dense historical tracks can exclude dock time.
const DEPARTURE_TIMING_SINCE = Date.parse('2026-09-23T00:00:00Z');

/** GPS-estimated push-off, not the time the skipper armed recording.
 * Keep every recorded point. Require three moving fixes spanning 30 seconds
 * and 30 metres, with distance actually accruing when that data is available.
 * A stop or a 20-minute GPS gap breaks confirmation; once departed, later
 * stops do not reset the passage clock. No route/forecast coordinates enter it.
 * Mirrored by get_voyage_summaries for unloaded and cross-device log cards.
 */
export function voyageDepartureTime(entries: readonly ShipLogEntry[]): string | null {
    const sorted = entries
        .filter((e) => Number.isFinite(Date.parse(e.timestamp)))
        .slice()
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    // Imported tracks and plans have their own timestamps, not our ready-to-record phase.
    if (sorted.some((e) => e.source && e.source !== 'device')) return sorted[0]?.timestamp ?? null;

    let first: ShipLogEntry | undefined;
    let previousMs = -Infinity;
    let samples = 0;
    for (const entry of sorted) {
        const ms = Date.parse(entry.timestamp);
        if (ms === previousMs) continue; // duplicate/offline replay is not another GPS fix
        const moving =
            Number.isFinite(entry.latitude) &&
            Math.abs(entry.latitude) <= 90 &&
            Number.isFinite(entry.longitude) &&
            Math.abs(entry.longitude) <= 180 &&
            !(entry.latitude === 0 && entry.longitude === 0) &&
            typeof entry.speedKts === 'number' &&
            entry.speedKts >= 0.8 &&
            entry.speedKts <= 80;
        if (!moving || ms - previousMs > 20 * 60_000) {
            first = undefined;
            samples = 0;
        }
        previousMs = ms;
        if (!moving) continue;
        first ??= entry;
        samples += 1;
        if (samples < 3 || ms - Date.parse(first.timestamp) < 30_000) continue;

        const rad = Math.PI / 180;
        const a =
            Math.sin(((entry.latitude - first.latitude) * rad) / 2) ** 2 +
            Math.cos(first.latitude * rad) *
                Math.cos(entry.latitude * rad) *
                Math.sin(((entry.longitude - first.longitude) * rad) / 2) ** 2;
        const metres = 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, a)));
        const hasTotals = Number.isFinite(first.cumulativeDistanceNM) && Number.isFinite(entry.cumulativeDistanceNM);
        if (metres >= 30 && (!hasTotals || entry.cumulativeDistanceNM! > first.cumulativeDistanceNM!)) {
            return first.timestamp;
        }
    }
    return sorted[0] && Date.parse(sorted[0].timestamp) < DEPARTURE_TIMING_SINCE ? sorted[0].timestamp : null;
}

/** Consistent, non-rounded-up durations for cards, records and career totals. */
export function formatVoyageDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const minutes = Math.floor(ms / 60_000);
    const hours = Math.floor(minutes / 60);
    if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    return `${hours}h ${minutes % 60}m`;
}

/** undefined = legacy summary without departure evidence; null = not departed. */
export function voyageElapsedMs(voyage: { startedAt: string; endedAt: string; departedAt?: string | null }): number {
    if (voyage.departedAt === null) return 0;
    const start = Date.parse(voyage.departedAt ?? voyage.startedAt);
    const end = Date.parse(voyage.endedAt);
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

type TimingSummary = { entryCount: number; startedAt: string; endedAt: string; departedAt?: string | null };

/** A partial resident tail must never restart a departure already established
 * by the cloud. It can confirm a departure newer than a pending cloud snapshot.
 */
export function mergeVoyageDepartureTime(server: TimingSummary, local: TimingSummary): string | null | undefined {
    if (server.departedAt) return server.departedAt;
    if (local.entryCount >= server.entryCount && Date.parse(local.startedAt) <= Date.parse(server.startedAt)) {
        return local.departedAt;
    }
    if (server.departedAt === null && local.departedAt && Date.parse(local.endedAt) > Date.parse(server.endedAt)) {
        return local.departedAt;
    }
    return server.departedAt;
}
