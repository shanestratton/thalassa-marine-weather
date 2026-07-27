/**
 * Public Voyage Log trip catalogue helpers.
 *
 * A public trip is always an actual recorded voyage — never an unsailed
 * `planned_…` route. A linked plan can be shown with that trip after cast-off,
 * without revealing the skipper's future route library.
 */

export const PUBLIC_ALL_DIARY_TRIP_ID = 'all-diary';
export const PUBLIC_LATEST_TRIP_ID = 'latest';

export interface PublicTripPoint {
    voyage_id?: unknown;
    timestamp?: unknown;
    cumulative_distance_nm?: unknown;
}

export interface PublicTrip {
    id: string;
    kind: 'track' | 'all-diary';
    label: string;
    started_at: string | null;
    ended_at: string | null;
    active: boolean;
    point_count: number;
    distance_nm: number | null;
    has_route: boolean;
}

function timestampMs(value: unknown): number {
    const ms = Date.parse(typeof value === 'string' ? value : '');
    return Number.isFinite(ms) ? ms : -Infinity;
}

function tripLabel(startedAt: string | null, active: boolean): string {
    if (!startedAt) return active ? 'Live track' : 'Recorded track';
    const date = new Date(startedAt);
    const dateLabel = Number.isFinite(date.getTime())
        ? date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'Unknown date';
    return active ? `Live track · ${dateLabel}` : `Track · ${dateLabel}`;
}

/**
 * Build a compact, newest-first selector catalogue from already-authorised
 * track points. Points without a stable voyage id are deliberately omitted:
 * grouping all legacy null IDs together would invent a fictional passage.
 */
export function buildPublicTripCatalogue(
    points: PublicTripPoint[],
    activeVoyageId: string | null,
    linkedPlanVoyageIds: ReadonlySet<string> = new Set<string>(),
): PublicTrip[] {
    const groups = new Map<string, PublicTripPoint[]>();
    for (const point of points) {
        const id = typeof point.voyage_id === 'string' ? point.voyage_id.trim() : '';
        if (!id || id.startsWith('planned_')) continue;
        const group = groups.get(id) ?? [];
        group.push(point);
        groups.set(id, group);
    }

    const trips: PublicTrip[] = [];
    for (const [id, group] of groups) {
        const ordered = [...group].sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp));
        const first = ordered[0];
        const last = ordered[ordered.length - 1];
        const startedAt = typeof first.timestamp === 'string' ? first.timestamp : null;
        const endedAt = typeof last.timestamp === 'string' ? last.timestamp : null;
        const active = id === activeVoyageId;
        const distanceNm = ordered.reduce<number | null>((maximum, point) => {
            const value = typeof point.cumulative_distance_nm === 'number' ? point.cumulative_distance_nm : null;
            if (value === null || !Number.isFinite(value) || value < 0) return maximum;
            return maximum === null ? value : Math.max(maximum, value);
        }, null);
        trips.push({
            id,
            kind: 'track',
            label: tripLabel(startedAt, active),
            started_at: startedAt,
            ended_at: endedAt,
            active,
            point_count: group.length,
            distance_nm: distanceNm === null ? null : Math.round(distanceNm * 10) / 10,
            has_route: linkedPlanVoyageIds.has(id),
        });
    }

    return trips.sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return timestampMs(right.ended_at) - timestampMs(left.ended_at);
    });
}

export function allDiaryPublicTrip(): PublicTrip {
    return {
        id: PUBLIC_ALL_DIARY_TRIP_ID,
        kind: 'all-diary',
        label: 'All diary entries',
        started_at: null,
        ended_at: null,
        active: false,
        point_count: 0,
        distance_nm: null,
        has_route: false,
    };
}

/** Resolve a requested selector value against the authorised trip catalogue. */
export function resolvePublicTripSelection(
    trips: PublicTrip[],
    requested: string | null,
): { mode: 'legacy' | 'all-diary' | 'track'; trip: PublicTrip | null } | null {
    if (requested === null) return { mode: 'legacy', trip: null };
    if (requested === '' || requested === PUBLIC_LATEST_TRIP_ID) {
        const latest = trips.find((trip) => trip.kind === 'track') ?? null;
        return latest ? { mode: 'track', trip: latest } : { mode: 'all-diary', trip: allDiaryPublicTrip() };
    }
    if (requested === PUBLIC_ALL_DIARY_TRIP_ID) return { mode: 'all-diary', trip: allDiaryPublicTrip() };
    const trip = trips.find((candidate) => candidate.kind === 'track' && candidate.id === requested) ?? null;
    return trip ? { mode: 'track', trip } : null;
}
