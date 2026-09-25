import type { VoyageLogTrackPoint } from './voyageLogApi';

/** Separate real voyages even when multiple recorders' timestamps interleave.
 * Unknown legacy runs stay separate; invalid fixes never bridge a gap. */
export function publicTrackSegments(track: readonly VoyageLogTrackPoint[]): [number, number][][] {
    const groups = new Map<string, VoyageLogTrackPoint[]>();
    let legacyRun = 0;
    let previousVoyage: string | null | undefined;
    for (const point of track) {
        const voyage = point.voyage_id?.trim() || null;
        if (voyage !== previousVoyage) legacyRun += 1;
        previousVoyage = voyage;
        if (voyage?.startsWith('planned_')) continue;
        const key = voyage ? `voyage:${voyage}` : `legacy:${legacyRun}`;
        const group = groups.get(key) ?? [];
        group.push(point);
        groups.set(key, group);
    }
    const segments: [number, number][][] = [];
    for (const group of groups.values()) {
        const sorted = [...group].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        let segment: [number, number][] = [];
        for (const point of sorted) {
            if (
                !Number.isFinite(point.lat) ||
                !Number.isFinite(point.lon) ||
                Math.abs(point.lat) > 90 ||
                Math.abs(point.lon) > 180 ||
                (point.lat === 0 && point.lon === 0)
            ) {
                if (segment.length >= 2) segments.push(segment);
                segment = [];
            } else {
                segment.push([point.lon, point.lat]);
            }
        }
        if (segment.length >= 2) segments.push(segment);
    }
    return segments;
}
