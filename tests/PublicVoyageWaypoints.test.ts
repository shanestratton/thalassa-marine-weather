import { describe, expect, it } from 'vitest';
import { publicVoyageWaypoints } from '../src/publicVoyageWaypoints';
import type { VoyageLogWaypoint } from '../src/voyageLogApi';

function waypoint(name: string, hour: number, voyage_id?: string): VoyageLogWaypoint & { voyage_id?: string } {
    return {
        name,
        lat: -23 + hour / 100,
        lon: 151,
        timestamp: new Date(Date.UTC(2026, 8, 18, hour)).toISOString(),
        ...(voyage_id ? { voyage_id } : {}),
    };
}

describe('public voyage lifecycle markers', () => {
    it('keeps the earliest start and latest end for the current unkeyed API shape', () => {
        const start = waypoint('Voyage Start', 1);
        const resumed = waypoint('Voyage Start', 5);
        const firstEnd = waypoint('Voyage End', 9);
        const finalEnd = waypoint('Voyage End', 12);
        // Selection uses timestamps, including when records arrive out of order.
        expect(publicVoyageWaypoints([resumed, firstEnd, finalEnd, start], 'voyage-a')).toEqual([finalEnd, start]);
    });

    it('preserves every custom pin and leaves the original records untouched', () => {
        const start = waypoint('Voyage Start', 1);
        const resumed = waypoint('Voyage Start', 5);
        const firstMark = waypoint('Channel entrance', 6);
        const secondMark = waypoint('Channel entrance', 7);
        const input = Object.freeze([start, resumed, firstMark, secondMark].map((entry) => Object.freeze(entry)));
        const result = publicVoyageWaypoints(input, 'voyage-a');
        expect(result).toEqual([start, firstMark, secondMark]);
        expect(result[0]).toBe(start);
        expect(input).toHaveLength(4);
    });

    it('does not collapse separate voyages, even with identical marker timestamps', () => {
        const aStart = waypoint('Voyage Start', 1, 'voyage-a');
        const bStart = waypoint('Voyage Start', 1, 'voyage-b');
        const aEnd = waypoint('Voyage End', 12, 'voyage-a');
        const bEnd = waypoint('Voyage End', 12, 'voyage-b');
        expect(
            publicVoyageWaypoints([
                aStart,
                waypoint('Voyage Start', 5, 'voyage-a'),
                bStart,
                waypoint('Voyage Start', 6, 'voyage-b'),
                aEnd,
                bEnd,
            ]),
        ).toEqual([aStart, bStart, aEnd, bEnd]);
    });

    it('honours an explicit voyage ID over the selected-trip fallback', () => {
        const aStart = waypoint('Voyage Start', 1);
        const bStart = waypoint('Voyage Start', 2, 'voyage-b');
        expect(publicVoyageWaypoints([aStart, bStart, waypoint('Voyage Start', 5)], 'voyage-a')).toEqual([
            aStart,
            bStart,
        ]);
    });

    it('preserves ambiguous unkeyed legacy history that may contain several voyages', () => {
        const history = [
            waypoint('Voyage Start', 1),
            waypoint('Voyage End', 3),
            waypoint('Voyage Start', 8),
            waypoint('Voyage End', 12),
        ];
        expect(publicVoyageWaypoints(history)).toEqual(history);
    });

    it('preserves lifecycle markers with an unorderable timestamp', () => {
        const unknownStart = { ...waypoint('Voyage Start', 1), timestamp: 'unknown' };
        const start = waypoint('Voyage Start', 2);
        expect(publicVoyageWaypoints([unknownStart, start], 'voyage-a')).toEqual([unknownStart, start]);
    });

    it('keeps the first record when duplicated lifecycle timestamps tie', () => {
        const start = waypoint('Voyage Start', 1);
        const end = waypoint('Voyage End', 12);
        expect(publicVoyageWaypoints([start, { ...start }, end, { ...end }], 'voyage-a')).toEqual([start, end]);
    });

    it('leaves the all-diary empty waypoint response empty', () => {
        expect(publicVoyageWaypoints([])).toEqual([]);
    });
});
