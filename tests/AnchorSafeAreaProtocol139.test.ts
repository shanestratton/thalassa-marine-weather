import { describe, expect, it } from 'vitest';
import {
    anchorZonePosition,
    parseAnchorBoundary,
    parseAnchorSafeArea,
    sameAnchorSafeArea,
} from '../utils/anchorSafeZone';
const frame = { latitude: -27, longitude: 179.99999, radiusM: 60 };
const zone = {
    version: 1,
    kind: 'polygon',
    anchor: { latitude: frame.latitude, longitude: frame.longitude },
    vertices: [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
    ].map(([x, y]) => anchorZonePosition(frame, x, y)!),
};
const envelope = { version: 1, frame, zone };
describe('strict owner-authorised safe-area envelope', () => {
    it('normalizes a bounded immutable envelope independently of object field order', () => {
        const parsed = parseAnchorSafeArea(envelope)!;
        expect(parsed.zone.kind).toBe('polygon');
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(
            sameAnchorSafeArea(parsed, {
                zone,
                frame: { longitude: frame.longitude, radiusM: 60, latitude: frame.latitude },
                version: 1,
            }),
        ).toBe(true);
    });
    it.each([
        null,
        {},
        { ...envelope, version: 2 },
        { ...envelope, extra: true },
        { ...envelope, frame: { ...frame, extra: true } },
        { ...envelope, frame: { ...frame, longitude: 0 } },
        { ...envelope, frame: { ...frame, radiusM: 10 } },
    ])('refuses unknown or incompatible frame/zone input %j', (value) => {
        expect(parseAnchorSafeArea(value)).toBeNull();
        expect(sameAnchorSafeArea(value, envelope)).toBe(false);
    });
    it('keeps the explicit circle value distinct from any custom area', () => {
        expect(sameAnchorSafeArea(null, undefined)).toBe(true);
        expect(sameAnchorSafeArea(envelope, null)).toBe(false);
    });
    it('binds an explicit circle to its exact frame instead of accepting an unframed null clear', () => {
        const circle = { version: 1, frame, zone: null };
        expect(parseAnchorBoundary(circle)).toEqual(circle);
        expect(parseAnchorBoundary(null)).toBeNull();
        expect(parseAnchorSafeArea(circle)).toBeNull();
        expect(sameAnchorSafeArea(circle, null)).toBe(false);
        expect(sameAnchorSafeArea(circle, { ...circle, frame: { ...frame, radiusM: 61 } })).toBe(false);
        expect(sameAnchorSafeArea(circle, { ...circle, frame: { ...frame, longitude: 0 } })).toBe(false);
        expect(parseAnchorBoundary({ ...circle, frame: { ...frame, radiusM: NaN } })).toBeNull();
        expect(parseAnchorBoundary({ ...circle, extra: true })).toBeNull();
    });
});
