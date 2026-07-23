export interface SegmentTrackPoint {
    voyage_id?: unknown;
}

function evenlySelect(indices: number[], count: number): number[] {
    if (count <= 0 || indices.length === 0) return [];
    if (indices.length <= count) return indices;
    const selected: number[] = [];
    for (let slot = 0; slot < count; slot += 1) {
        const position = count === 1 ? indices.length - 1 : Math.round((slot * (indices.length - 1)) / (count - 1));
        selected.push(indices[position]);
    }
    return [...new Set(selected)];
}

/**
 * Caps public-track payloads while preserving the first/last point of every
 * contiguous voyage segment. Internal telemetry calculations should continue
 * to use the full track; this is only the response projection.
 */
export function decimatePublicTrack<T extends SegmentTrackPoint>(points: T[], maxPoints: number): T[] {
    if (!Number.isInteger(maxPoints) || maxPoints < 2) return [];
    if (points.length <= maxPoints) return [...points];

    const boundaries = new Set<number>([0, points.length - 1]);
    for (let index = 1; index < points.length; index += 1) {
        if (points[index].voyage_id !== points[index - 1].voyage_id) {
            boundaries.add(index - 1);
            boundaries.add(index);
        }
    }

    const required = [...boundaries].sort((a, b) => a - b);
    if (required.length >= maxPoints) {
        return evenlySelect(required, maxPoints).map((index) => points[index]);
    }

    const candidates: number[] = [];
    for (let index = 1; index < points.length - 1; index += 1) {
        if (!boundaries.has(index)) candidates.push(index);
    }
    const sampled = evenlySelect(candidates, maxPoints - required.length);
    return [...required, ...sampled]
        .sort((a, b) => a - b)
        .slice(0, maxPoints)
        .map((index) => points[index]);
}
