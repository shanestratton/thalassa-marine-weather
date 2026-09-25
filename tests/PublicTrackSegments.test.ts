import { describe, expect, it } from 'vitest';
import { publicTrackSegments } from '../src/publicTrackSegments';
import type { VoyageLogTrackPoint } from '../src/voyageLogApi';

const point = (voyage: string | null, minute: number, lat: number, lon: number) =>
    ({
        voyage_id: voyage,
        timestamp: new Date(Date.UTC(2026, 8, 25, 0, minute)).toISOString(),
        lat,
        lon,
    }) as VoyageLogTrackPoint;

describe('whole-yacht public track segments', () => {
    it('keeps each trip complete and separate even when recorder timestamps interleave', () => {
        const source = Object.freeze([
            point('a', 0, -27, 153),
            point('b', 1, -21, 149),
            point('a', 2, -26, 152),
            point('b', 3, -20, 148),
        ]);
        expect(publicTrackSegments(source)).toEqual([
            [
                [153, -27],
                [152, -26],
            ],
            [
                [149, -21],
                [148, -20],
            ],
        ]);
        expect(source.map((p) => p.voyage_id)).toEqual(['a', 'b', 'a', 'b']);
    });

    it('sorts each voyage chronologically without changing the response', () => {
        expect(publicTrackSegments([point('a', 2, -26, 152), point('a', 0, -27, 153)])).toEqual([
            [
                [153, -27],
                [152, -26],
            ],
        ]);
    });

    it('does not join unrelated legacy runs across a known voyage', () => {
        expect(
            publicTrackSegments([
                point(null, 0, -27, 153),
                point(null, 1, -26, 152),
                point('known', 2, -21, 149),
                point('known', 3, -20, 148),
                point(null, 4, -19, 147),
                point(null, 5, -18, 146),
            ]),
        ).toHaveLength(3);
    });

    it('omits future plans and never bridges an invalid GPS fix', () => {
        expect(
            publicTrackSegments([
                point('planned_future', 0, -27, 153),
                point('planned_future', 1, -26, 152),
                point('a', 0, -21, 149),
                point('a', 1, -20, 148),
                point('a', 2, 0, 0),
                point('a', 3, -19, 147),
                point('a', 4, -18, 146),
            ]),
        ).toEqual([
            [
                [149, -21],
                [148, -20],
            ],
            [
                [147, -19],
                [146, -18],
            ],
        ]);
    });
});
