import { describe, expect, it } from 'vitest';
import { buildTrackRouteDraft, trackSegmentDistanceM } from '../services/routing/trackRouteDraft';
const at = 1_700_000_000_000;
const sample = (lat: number, lon: number, i: number) => ({ lat, lon, at: at + i * 60_000 });
describe('own track becomes a fresh bounded route draft', () => {
    it('keeps exact endpoints and order with a conservative displayed-line tolerance', () => {
        const input = Array.from({ length: 500 }, (_, i) =>
            sample(-27 + i * 0.00002, 153 + Math.sin(i / 80) * 0.002, i),
        );
        const draft = buildTrackRouteDraft(input);
        expect(draft.points[0]).toEqual({ lat: input[0].lat, lon: input[0].lon });
        expect(draft.points.at(-1)).toEqual({ lat: input.at(-1)!.lat, lon: input.at(-1)!.lon });
        expect(draft.points.length).toBeLessThanOrEqual(80);
        expect(draft.requiresChartCheck).toBe(true);
        for (const p of input)
            expect(
                Math.min(...draft.points.slice(1).map((b, i) => trackSegmentDistanceM(p, draft.points[i], b))),
            ).toBeLessThanOrEqual(30.000001);
        expect(
            draft.points.every(
                (p, i) =>
                    i === 0 ||
                    input.findIndex((q) => q.lat === p.lat && q.lon === p.lon) >
                        input.findIndex((q) => q.lat === draft.points[i - 1].lat && q.lon === draft.points[i - 1].lon),
            ),
        ).toBe(true);
    });
    it('never discards a complex bend merely to fit the budget', () => {
        expect(() =>
            buildTrackRouteDraft(
                Array.from({ length: 100 }, (_, i) => sample(-27 + (i % 2) * 0.002, 153 + i * 0.0001, i)),
            ),
        ).toThrow('more than 80 pins at 30 m');
    });
    it.each([
        [sample(-27, 153, 0), { ...sample(-27.001, 153.001, 1), at: at + 16 * 60_000 }],
        [sample(-27, 153, 0), sample(-27.001, 153.001, 0)],
        [sample(-27, 179.99, 0), sample(-27, -179.99, 1)],
        [sample(-27, 153, 0), sample(-28, 153, 1)],
        [sample(-27, 153, 0), sample(NaN, 153, 1)],
    ])('refuses missing or unreadable spans rather than inventing a connecting line', (...input) =>
        expect(() => buildTrackRouteDraft(input)).toThrow(),
    );
    it('strips borrowed metadata, deduplicates stationary samples and never mutates input', () => {
        const input = [
            sample(-27, 153, 0),
            sample(-27, 153, 1),
            { ...sample(-27.001, 153.001, 2), verification: { status: 'safe' }, constraint: 'chart-derived' },
        ];
        const before = JSON.stringify(input),
            draft = buildTrackRouteDraft(input);
        expect(draft.points).toEqual([
            { lat: -27, lon: 153 },
            { lat: -27.001, lon: 153.001 },
        ]);
        expect(JSON.stringify(input)).toBe(before);
        expect(Object.keys(draft.points[1]).sort()).toEqual(['lat', 'lon']);
    });
    it('rejects point and work capacity overflow', () =>
        expect(() =>
            buildTrackRouteDraft(Array.from({ length: 20_001 }, (_, i) => sample(-27, 153 + i * 1e-8, i))),
        ).toThrow('2–20,000'));
});
