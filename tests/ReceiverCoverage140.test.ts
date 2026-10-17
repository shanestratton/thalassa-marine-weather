import { describe, it, expect } from 'vitest';
import {
    parseReceiverCoverage,
    receiverCoverageFeatures,
    receiverCoverageWindow,
    receiverCoverageWords,
} from '../services/ais/receiverCoverage';
const now = 1800000000000;
const reply = {
    schema: 1,
    state: 'available',
    cells: ['v1:31:166', 'v1:31:0'],
    partial: false,
    asOf: now - 300000,
    expiresAt: now + 60000,
};
describe('coarse140 receiver coverage contract', () => {
    it('keeps actual fixed cell geometry separate from targets and exposes no contributor properties', () => {
        const parsed = parseReceiverCoverage(reply, now)!;
        expect(parsed).not.toBeNull();
        const features = receiverCoverageFeatures(parsed);
        expect(features.features).toHaveLength(2);
        expect(features.features[0].properties).toEqual({ cell: 'v1:31:166' });
        expect(features.features[0].geometry.coordinates[0]).toEqual([
            [152, -28],
            [154, -28],
            [154, -26],
            [152, -26],
            [152, -28],
        ]);
    });
    for (const patch of [
        { cells: ['v1:031:166'] },
        { cells: ['v1:31:166', 'v1:31:166'] },
        { cells: Array(257).fill('v1:31:166') },
        { asOf: now },
        { asOf: now - 700000 },
        { expiresAt: now },
        { expiresAt: now + 70000 },
        { ownerId: 'private' },
        { receiverCount: 3 },
        { coordinates: [153, -27] },
    ])
        it('refuses unavailable, private, oversized or untruthful reply ' + JSON.stringify(patch), () => {
            expect(parseReceiverCoverage({ ...reply, ...patch }, now)).toBeNull();
        });
    it('held is explicit and never paints data', () => {
        const held = { schema: 1, state: 'held', cells: [], partial: false };
        expect(parseReceiverCoverage(held, now)?.state).toBe('held');
        expect(parseReceiverCoverage({ ...held, cells: ['v1:31:166'] }, now)).toBeNull();
        expect(receiverCoverageWords({ state: 'available', partial: false, cells: 0, asOf: now - 300000 })).toContain(
            'No qualifying cells',
        );
        expect(receiverCoverageFeatures(parseReceiverCoverage(held, now)!).features).toEqual([]);
    });
    it('bounds world wrapping/dateline without treating a point as public receiver position', () => {
        const box = (w: number, s: number, e: number, n: number) => ({
            getWest: () => w,
            getSouth: () => s,
            getEast: () => e,
            getNorth: () => n,
        });
        expect(receiverCoverageWindow(box(179, -30, 183, -20))).toEqual([179, -30, -177, -20]);
        expect(receiverCoverageWindow(box(-200, -90, 200, 90))).toEqual([-180, -90, 180, 90]);
        expect(receiverCoverageWindow(box(0, 2, 1, 1))).toBeNull();
        expect(receiverCoverageWindow(box(NaN, 0, 1, 1))).toBeNull();
    });
});
