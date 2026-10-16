import { describe, expect, it } from 'vitest';
import { anchorZonePosition, parseAnchorSafeArea } from '../utils/anchorSafeZone';
import { validAreaReport as validateAreaReport } from '../supabase/functions/anchor-relay/safeArea';
const validAreaReport = (stored: unknown, revision: unknown, payload: Record<string, unknown>, gpsAvailable: boolean) =>
    validateAreaReport(stored, revision, payload, gpsAvailable, 'boat-a');
const anchor = { latitude: -27, longitude: 179.99999 },
    frame = { ...anchor, radiusM: 60 };
const zone = {
    version: 1,
    kind: 'polygon',
    anchor,
    vertices: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
    ].map(([x, y]) => anchorZonePosition(anchor, x, y)!),
};
const area = parseAnchorSafeArea({ version: 1, frame, zone })!;
const revision = '11111111-1111-4111-8111-111111111111';
const report = {
    anchor,
    swingRadius: 60,
    vessel: anchor,
    isAlarm: false,
    safeZone: area.zone,
    safeZoneWatch: 'pi',
    safeAreaRevision: revision,
    safeAreaVesselId: 'boat-a',
};
describe('relay owner-authorised boundary contract', () => {
    it('accepts the exact area UUID/frame and retains legacy circle reports', () => {
        expect(validAreaReport(area, revision, report, true)).toBe(true);
        expect(validAreaReport(null, null, { anchor, swingRadius: 60, vessel: anchor, isAlarm: false }, true)).toBe(
            true,
        );
    });
    it('refuses stale A/B/A UUIDs, omitted or malformed areas, changed anchor/radius and an unverified publisher', () => {
        for (const patch of [
            { safeAreaRevision: '22222222-2222-4222-8222-222222222222' },
            { safeZone: undefined },
            { safeZone: { version: 2 } },
            { anchor: { ...anchor, longitude: 0 } },
            { swingRadius: 80 },
            { safeZoneWatch: 'phone' },
            { safeAreaVesselId: 'boat-b' },
            { safeAreaVesselId: undefined },
        ])
            expect(validAreaReport(area, revision, { ...report, ...patch }, true)).toBe(false);
        expect(validAreaReport({ ...area, version: 9 }, revision, report, true)).toBe(false);
        expect(validAreaReport(null, null, report, true)).toBe(false);
    });
    it('leaves distinct-fix confirmation on the Pi, while refusing an impossible inside-area drag flag', () => {
        const outside = { ...report, vessel: anchorZonePosition(anchor, 25, 0)! };
        expect(validAreaReport(area, revision, outside, true)).toBe(true);
        expect(validAreaReport(area, revision, { ...outside, isAlarm: true }, true)).toBe(true);
        expect(validAreaReport(area, revision, { ...report, isAlarm: true }, true)).toBe(false);
        expect(validAreaReport(area, revision, { ...report, vessel: { latitude: NaN, longitude: 0 } }, true)).toBe(
            false,
        );
    });
    it('allows an exactly bound no-fix status to raise GPS-lost without inventing a position', () => {
        expect(validAreaReport(area, revision, { ...report, vessel: undefined, isAlarm: undefined }, false)).toBe(true);
        expect(validAreaReport(area, revision, { ...report, safeAreaRevision: 'old' }, false)).toBe(false);
    });
    it('binds an explicit circle-only revision to the authorised anchor and radius', () => {
        const circle = { version: 1, frame, zone: null };
        const circleReport = { ...report, safeZone: null };
        expect(validAreaReport(circle, revision, circleReport, true)).toBe(true);
        for (const patch of [
            { anchor: { ...anchor, longitude: 0 } },
            { swingRadius: 61 },
            { safeAreaRevision: 'old' },
            { safeZone: area.zone },
        ])
            expect(validAreaReport(circle, revision, { ...circleReport, ...patch }, true)).toBe(false);
        expect(
            validAreaReport(
                circle,
                revision,
                { ...circleReport, vessel: anchorZonePosition(anchor, 70, 0)!, isAlarm: true },
                true,
            ),
        ).toBe(true);
        expect(validAreaReport(circle, revision, { ...circleReport, isAlarm: true }, true)).toBe(false);
    });
    it('requires the exact selected-vessel binding even for no-fix status', () => {
        expect(validateAreaReport(area, revision, report, false, 'boat-b')).toBe(false);
        expect(validateAreaReport(area, revision, report, false, undefined)).toBe(false);
        expect(validateAreaReport(area, revision, { ...report, safeAreaVesselId: null }, false, null)).toBe(true);
    });
});
