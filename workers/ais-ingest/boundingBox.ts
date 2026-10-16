/**
 * LEGACY AISSTREAM SOCKET BOUNDS ONLY.
 *
 * The default used to be the whole planet — [[-90,-180],[90,180]] — which is
 * every AIS-equipped vessel on Earth, tens of thousands of ships, each
 * rewritten to a Micro's disk on every flush. That is where 34,661,184 rows
 * and ~1.8 TB of writes came from (measured 2026-08-18). The app asks
 * for a bounded nearby view, so an unbounded global socket is pure cost.
 *
 * Build135 moves AISHub to fleetAishub.ts: persisted claims and rotating
 * coarse interests, with one global request per minute across replicas.
 * This file no longer controls the AISHub aggregate's coverage.
 *
 * The punter crowd-feed (/fleet-feed) is deliberately NOT bounded by it: a
 * contributor anywhere on earth is credited and their sentences land in the
 * pond. Contribution is global; aggregate fill follows active fleet interests
 * under its own byte, row, write, time and licensing limits.
 *
 * Default is the Australian east coast and the Coral Sea out to the islands:
 * Torres Strait to Bass Strait, past the reef and Lord Howe, and far enough
 * east (172°) to cover a Brisbane–Noumea or Vanuatu passage. It was 162° until
 * 2026-08-24, which stopped roughly halfway across the Coral Sea and dropped
 * New Caledonia, Vanuatu and Norfolk Island outside AIS coverage mid-crossing.
 *
 * These historical legacy bounds are independent of any user's yacht or
 * cruising ground. AISStream is disabled when its key is absent. Operators
 * must not use a global legacy subscription to bypass the fleet budget.
 */
export const DEFAULT_BOUNDING_BOXES = '[[[-44,140],[-9,172]]]';

/**
 * Parse the override defensively, because this runs at module top level: an
 * unguarded JSON.parse on a mistyped dashboard field takes the whole worker
 * down before it can log why, and a container that will not boot is a much
 * worse outcome than a box that is the wrong shape.
 *
 * A bad override falls back to the default and says so loudly. The shape is
 * checked too, not just the JSON, so a wrongly nested legacy socket override
 * cannot silently produce an invalid subscription.
 */
export function parseBoundingBoxes(raw: string | undefined): number[][][] {
    const fallback = JSON.parse(DEFAULT_BOUNDING_BOXES) as number[][][];
    if (!raw || !raw.trim()) return fallback;
    try {
        const parsed = JSON.parse(raw) as unknown;
        const ok =
            Array.isArray(parsed) &&
            parsed.length > 0 &&
            parsed.every(
                (box) =>
                    Array.isArray(box) &&
                    box.length === 2 &&
                    box.every(
                        (corner) => Array.isArray(corner) && corner.length === 2 && corner.every(Number.isFinite),
                    ),
            );
        if (!ok) {
            console.error(
                '[AIS] BOUNDING_BOXES is not [[[latMin,lonMin],[latMax,lonMax]], ...] — ignoring it and using the default',
                DEFAULT_BOUNDING_BOXES,
            );
            return fallback;
        }
        return parsed as number[][][];
    } catch (e) {
        console.error(
            '[AIS] BOUNDING_BOXES is not valid JSON — ignoring it and using the default',
            DEFAULT_BOUNDING_BOXES,
            e instanceof Error ? e.message : e,
        );
        return fallback;
    }
}

/** Resolve the box in force, and say where it came from. */
export function resolveBoundingBoxes(raw: string | undefined): {
    boxes: number[][][];
    source: 'BOUNDING_BOXES env override' | 'code default';
} {
    const boxes = parseBoundingBoxes(raw);
    return { boxes, source: raw?.trim() ? 'BOUNDING_BOXES env override' : 'code default' };
}
