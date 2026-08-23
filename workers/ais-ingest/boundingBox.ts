/**
 * WHERE TO LISTEN.
 *
 * The default used to be the whole planet — [[-90,-180],[90,180]] — which is
 * every AIS-equipped vessel on Earth, tens of thousands of ships, each
 * rewritten to a Micro's disk on every flush. That is where 34,661,184 rows
 * and ~1.8 TB of writes came from (measured 2026-08-18). The app never asks
 * for vessels more than 100 NM from the boat (vessels-nearby caps radius at
 * 100), so ingesting the Pacific is pure cost.
 *
 * THIS BOX IS NOT AISSTREAM-ONLY — the thing that is easy to get wrong.
 * Two consumers read it:
 *   · the aisstream subscription below (BoundingBoxes), and
 *   · the AISHub aggregate poller, which turns BOUNDING_BOXES[0] into the
 *     latmin/lonmin/latmax/lonmax of its API query.
 * So this rectangle decides what the shared pond CONTAINS, from whichever
 * upstream is alive. Narrow it and you are not just trimming a dead feed.
 *
 * The punter crowd-feed (/fleet-feed) is deliberately NOT bounded by it: a
 * contributor anywhere on earth is credited and their sentences land in the
 * pond. Contribution is global; aggregate fill is boxed. A punter outside the
 * box still sees their own receiver and any nearby punter — they just get no
 * AISHub fill around them.
 *
 * Default is the Australian east coast and the Coral Sea out to the islands:
 * Torres Strait to Bass Strait, past the reef and Lord Howe, and far enough
 * east (172°) to cover a Brisbane–Noumea or Vanuatu passage. It was 162° until
 * 2026-08-24, which stopped roughly halfway across the Coral Sea and dropped
 * New Caledonia, Vanuatu and Norfolk Island outside AIS coverage mid-crossing.
 *
 * Still OUTSIDE by choice, because it is water we do not sail and the box's
 * width is the cost driver: Western Australia, the NT coast, and New Zealand.
 * Override with BOUNDING_BOXES for a different cruising ground; a deliberately
 * global subscription still works, it is just no longer what you get by
 * accident. Format is [[[latMin,lonMin],[latMax,lonMax]], ...] as aisstream
 * expects.
 */
export const DEFAULT_BOUNDING_BOXES = '[[[-44,140],[-9,172]]]';

/**
 * Parse the override defensively, because this runs at module top level: an
 * unguarded JSON.parse on a mistyped dashboard field takes the whole worker
 * down before it can log why, and a container that will not boot is a much
 * worse outcome than a box that is the wrong shape.
 *
 * A bad override falls back to the default and says so loudly. The shape is
 * checked too, not just the JSON — the AISHub poller indexes [0][0]/[1][1]
 * directly, so a well-formed but wrongly-nested array (`[[-44,140],[-9,172]]`,
 * one bracket short, which is the easy typo) would otherwise sail through
 * parsing and produce undefined bounds at query time.
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
                    box.every((corner) => Array.isArray(corner) && corner.length === 2 && corner.every(Number.isFinite)),
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
