import { describe, expect, it } from 'vitest';
import {
    lightningDistanceNm,
    lightningNearPush,
    parseLicensedLightning,
    reduceXweatherLightning,
} from '../services/weather/api/licensedLightningContract';

// Fictional provider-shaped pulses, not an observed storm or a provider sample.
const NOW = 1792230000000;
const pulse = (extra: Record<string, unknown> = {}) => ({
    id: 'fictional-pulse-1',
    loc: { lat: -27, long: 154 },
    ob: { timestamp: NOW / 1000 - 30, timestampMS: NOW - 30000, pulse: { type: 'cg', peakamp: -7000 } },
    ...extra,
});
const raw = (rows: unknown[] = [pulse()]) => ({ success: true, error: null, response: rows });
const read = (value = raw()) => reduceXweatherLightning(value, -27, 154, NOW);
describe('Licensed lightning original pulse and20NM contract', () => {
    it('preserves the original pulse time and polarity without using receipt as observation', () => {
        const result = read();
        expect(result.pulses[0]).toMatchObject({ time: NOW - 30000, polarity: 'negative', type: 'cg' });
        expect(result.receivedAt).toBe(NOW);
        expect(result.windowStart).toBe(NOW - 300000);
        expect(parseLicensedLightning(result, -27, 154, NOW)).toEqual(result);
    });
    it('keeps zero current as unknown polarity and accepts explicitly declared intracloud pulses', () => {
        const p = pulse();
        p.ob.pulse = { type: 'IC', peakamp: 0 };
        expect(read(raw([p])).pulses[0]).toMatchObject({ polarity: 'unknown', type: 'ic' });
    });
    it('keeps positive polarity and deduplicates an identical original', () => {
        const p = pulse();
        p.ob.pulse.peakamp = 1200;
        expect(read(raw([p, p])).pulses).toHaveLength(1);
        expect(read(raw([p])).pulses[0].polarity).toBe('positive');
    });
    it('rejects conflicting duplicate IDs instead of replacing an original', () => {
        const p = pulse();
        p.ob.pulse.peakamp = 1200;
        expect(() => read(raw([pulse(), p]))).toThrow('unavailable');
    });
    it.each([
        null,
        { success: false, error: null, response: [] },
        { success: true, error: { code: 403 }, response: [] },
        { success: true, error: null },
        { success: true, error: null, response: Array(1001).fill(pulse()) },
    ])('rejects unavailable, malformed and oversized provider replies %#', (value) => {
        expect(() => reduceXweatherLightning(value, -27, 154, NOW)).toThrow('unavailable');
    });
    it('leaves gaps for old, future and out-of-radius observations', () => {
        const old = pulse({ id: 'old' });
        old.ob.timestamp = NOW / 1000 - 301;
        old.ob.timestampMS = NOW - 301000;
        const future = pulse({ id: 'future' });
        future.ob.timestamp = NOW / 1000 + 1;
        future.ob.timestampMS = NOW + 1000;
        expect(read(raw([old, future, pulse({ loc: { lat: -29, long: 154 } })])).pulses).toEqual([]);
    });
    it('checks the original millisecond/second clocks and declared clock strings', () => {
        const p = pulse();
        p.ob.timestampMS += 1000;
        expect(() => read(raw([p]))).toThrow('unavailable');
        const clock = pulse();
        Object.assign(clock.ob, { dateTimeISO: new Date(NOW).toISOString() });
        expect(() => read(raw([clock]))).toThrow('unavailable');
    });
    it('refuses missing/fabricated pulse kinds and nonfinite coordinates', () => {
        for (const p of [
            pulse({ loc: { lat: NaN, long: 154 } }),
            pulse({ ob: { timestamp: NOW / 1000, pulse: { type: 'optical', peakamp: 0 } } }),
        ])
            expect(() => read(raw([p]))).toThrow('unavailable');
    });
    it('uses geodesic distances across the dateline and near poles', () => {
        expect(lightningDistanceNm(0, 179.99, 0, -179.99)).toBeLessThan(2);
        expect(lightningDistanceNm(89.99, 0, 89.99, 180)).toBeLessThan(2);
        expect(lightningDistanceNm(-27, 154, -27, 154)).toBe(0);
    });
    it('declares capped results and never converts a successful empty reply into a clear notice', () => {
        expect(read(raw(Array(1000).fill(pulse()))).truncated).toBe(true);
        expect(read(raw([])).pulses).toEqual([]);
        expect(
            lightningNearPush(read(raw([])), { lat: -27, lon: 154, originalAt: NOW, consent: true }, NOW),
        ).toBeNull();
    });
    it('requires current explicit consent, original position and the exact queried point for a push', () => {
        const result = read(),
            fix = { lat: -27, lon: 154, originalAt: NOW, consent: true };
        const notice = lightningNearPush(result, fix, NOW);
        expect(notice).toMatchObject({
            notification_type: 'lightning_nearby',
            title: 'Lightning within 20 NM',
            data: { source_at: NOW - 30000, expires_at: NOW + 60000 },
        });
        for (const extra of [{ consent: false }, { originalAt: NOW - 120001 }, { originalAt: NOW + 1 }, { lat: -26 }])
            expect(lightningNearPush(result, { ...fix, ...extra }, NOW)).toBeNull();
        expect(lightningNearPush(result, fix, NOW + 60001)).toBeNull();
    });
    it('revalidates reduced responses for exact location, original bounds, expiry and duplicated IDs', () => {
        const result = read();
        for (const extra of [
            { provider: 'goes-glm' },
            { radiusNm: 21 },
            { latitude: -26 },
            { receivedAt: NOW + 1 },
            { pulses: [...result.pulses, ...result.pulses] },
            { pulses: [{ ...result.pulses[0], time: NOW + 1 }] },
        ])
            expect(parseLicensedLightning({ ...result, ...extra }, -27, 154, NOW)).toBeNull();
        expect(parseLicensedLightning(result, -27, 154, NOW + 300000)).toBeNull();
    });
});
