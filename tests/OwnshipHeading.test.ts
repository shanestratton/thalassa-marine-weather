import { describe, expect, it } from 'vitest';
import { resolveOwnshipDirection } from '../components/map/ownshipDirection';
const now = 1_000_000;
const metric = (value: number | null, age = 0) => ({ value, lastUpdated: now - age, freshness: 'live' });
const position = { timestamp: now, heading: 270, speed: 0 };
describe('ownship bow heading versus travel direction', () => {
    it.each([0, 90, 180, 359])('uses fresh true heading %s even when stopped', (degrees) => {
        expect(
            resolveOwnshipDirection(
                position,
                true,
                { headingTrue: metric(degrees), cog: metric(270), sog: metric(0) },
                now,
            ),
        ).toEqual({ source: 'heading', degrees });
    });
    it('falls back to fresh COG including north only when moving', () => {
        expect(resolveOwnshipDirection(position, true, { cog: metric(0), sog: metric(4) }, now)).toEqual({
            source: 'course',
            degrees: 0,
        });
        expect(resolveOwnshipDirection(position, true, { cog: metric(270), sog: metric(0.4) }, now).source).toBe(
            'unknown',
        );
    });
    it('does not reuse unqualified heading or a cached marker bearing', () => {
        expect(resolveOwnshipDirection(position, true, {}, now).source).toBe('unknown');
    });
    it.each([
        metric(80, 14_000),
        metric(80, -6000),
        metric(NaN),
        metric(360),
        metric(-1),
        metric(null),
        { ...metric(80), freshness: 'dead' },
    ])('rejects stale/invalid compass values', (headingTrue) => {
        expect(resolveOwnshipDirection(position, true, { headingTrue }, now).source).toBe('unknown');
    });
    it('requires fresh position, course and speed independently', () => {
        expect(
            resolveOwnshipDirection({ ...position, timestamp: now - 14_000 }, true, { headingTrue: metric(90) }, now)
                .source,
        ).toBe('unknown');
        expect(resolveOwnshipDirection(position, true, { cog: metric(90, 14_000), sog: metric(4) }, now).source).toBe(
            'unknown',
        );
        expect(resolveOwnshipDirection(position, true, { cog: metric(90), sog: metric(4, 14_000) }, now).source).toBe(
            'unknown',
        );
    });
    it('uses phone course only while moving, never the yacht compass for an ashore phone', () => {
        expect(resolveOwnshipDirection(position, false, { headingTrue: metric(90) }, now).source).toBe('unknown');
        expect(
            resolveOwnshipDirection({ ...position, speed: 2, heading: 0 }, false, { headingTrue: metric(90) }, now),
        ).toEqual({ source: 'course', degrees: 0 });
        expect(resolveOwnshipDirection({ ...position, speed: 2, timestamp: now - 31_000 }, false, {}, now).source).toBe(
            'unknown',
        );
    });
});
