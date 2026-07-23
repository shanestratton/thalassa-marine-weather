import { describe, expect, it } from 'vitest';
import { decimatePublicTrack } from '../supabase/functions/_shared/track-decimation';

describe('public voyage track decimation', () => {
    it('caps the response and keeps chronological first/last points', () => {
        const points = Array.from({ length: 100_000 }, (_, index) => ({ index, voyage_id: 'voyage-a' }));
        const result = decimatePublicTrack(points, 10_000);

        expect(result).toHaveLength(10_000);
        expect(result[0].index).toBe(0);
        expect(result.at(-1)?.index).toBe(99_999);
        expect(result.every((point, index) => index === 0 || point.index > result[index - 1].index)).toBe(true);
    });

    it('preserves both sides of voyage boundaries so separate passages never join', () => {
        const points = [
            ...Array.from({ length: 20 }, (_, index) => ({ index, voyage_id: 'a' })),
            ...Array.from({ length: 20 }, (_, offset) => ({ index: 20 + offset, voyage_id: 'b' })),
            ...Array.from({ length: 20 }, (_, offset) => ({ index: 40 + offset, voyage_id: null })),
        ];
        const result = decimatePublicTrack(points, 12);
        const indices = result.map((point) => point.index);

        expect(indices).toEqual(expect.arrayContaining([0, 19, 20, 39, 40, 59]));
        expect(result).toHaveLength(12);
    });

    it('returns a defensive copy for already-small tracks and rejects unsafe caps', () => {
        const points = [{ voyage_id: 'a' }, { voyage_id: 'a' }];
        expect(decimatePublicTrack(points, 10)).toEqual(points);
        expect(decimatePublicTrack(points, 10)).not.toBe(points);
        expect(decimatePublicTrack(points, 1)).toEqual([]);
        expect(decimatePublicTrack(points, Number.NaN)).toEqual([]);
    });
});
