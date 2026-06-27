/**
 * Tests for the wind-over-tide judgement (the Glass-page tide flip).
 * This is safety-domain logic — a wrong "against vs with" inverts the warning.
 */
import { describe, it, expect } from 'vitest';
import {
    angleBetween,
    tidePhase,
    streamDirection,
    windVsTide,
    WIND_OVER_TIDE_WIND_KTS,
    WIND_OVER_TIDE_CURRENT_KTS,
} from '../services/tide/windOverTide';

describe('angleBetween', () => {
    it('is 0 for identical bearings', () => {
        expect(angleBetween(90, 90)).toBe(0);
    });
    it('is 180 for opposite bearings', () => {
        expect(angleBetween(0, 180)).toBe(180);
        expect(angleBetween(270, 90)).toBe(180);
    });
    it('wraps across 360', () => {
        expect(angleBetween(350, 10)).toBe(20);
        expect(angleBetween(10, 350)).toBe(20);
    });
    it('normalises out-of-range bearings', () => {
        expect(angleBetween(-10, 350)).toBe(0);
        expect(angleBetween(720, 0)).toBe(0);
    });
});

describe('tidePhase', () => {
    it('rising water is flood', () => {
        expect(tidePhase(1.0, 1.4)).toBe('flood');
    });
    it('falling water is ebb', () => {
        expect(tidePhase(1.4, 1.0)).toBe('ebb');
    });
    it('near-level water (high/low) is slack', () => {
        expect(tidePhase(2.0, 2.01)).toBe('slack');
        expect(tidePhase(2.0, 1.99)).toBe('slack');
    });
});

describe('streamDirection', () => {
    it('uses the flood direction on a flooding tide', () => {
        expect(streamDirection('flood', 45, null)).toBe(45);
    });
    it('reverses the flood direction on an ebbing tide', () => {
        expect(streamDirection('ebb', 45, null)).toBe(225);
        expect(streamDirection('ebb', 270, null)).toBe(90);
    });
    it('has no stream direction at slack (with a flood setting)', () => {
        expect(streamDirection('slack', 45, 120)).toBeNull();
    });
    it('falls back to the modelled current when no flood setting', () => {
        expect(streamDirection('flood', null, 120)).toBe(120);
        expect(streamDirection('ebb', null, 120)).toBe(120); // modelled current is already the live set
    });
    it('is null when neither flood setting nor modelled current is known', () => {
        expect(streamDirection('flood', null, null)).toBeNull();
    });
});

describe('windVsTide', () => {
    const strong = { windKts: 20, currentKts: 1.5 };

    it('flags WIND OVER TIDE when wind opposes the stream and both are strong', () => {
        // wind FROM north (0) → blows south; stream flows TOWARD north (0) → opposed.
        const r = windVsTide({ windDeg: 0, streamDeg: 0, ...strong });
        expect(r.relation).toBe('against');
        expect(r.windOverTide).toBe(true);
        expect(r.label).toMatch(/over tide/i);
    });

    it('is "with" (following) when wind and stream run the same way', () => {
        // wind FROM north (0) → blows south; stream flows TOWARD south (180) → same way.
        const r = windVsTide({ windDeg: 0, streamDeg: 180, ...strong });
        expect(r.relation).toBe('with');
        expect(r.windOverTide).toBe(false);
        expect(r.label).toMatch(/with the stream/i);
    });

    it('is "cross" at a beam angle', () => {
        const r = windVsTide({ windDeg: 90, streamDeg: 0, ...strong });
        expect(r.relation).toBe('cross');
        expect(r.windOverTide).toBe(false);
    });

    it('does NOT flag wind-over-tide when opposed but the wind is light', () => {
        const r = windVsTide({ windDeg: 0, streamDeg: 0, windKts: WIND_OVER_TIDE_WIND_KTS - 1, currentKts: 2 });
        expect(r.relation).toBe('against');
        expect(r.windOverTide).toBe(false);
    });

    it('does NOT flag wind-over-tide when opposed but the stream is weak', () => {
        const r = windVsTide({ windDeg: 0, streamDeg: 0, windKts: 25, currentKts: WIND_OVER_TIDE_CURRENT_KTS - 0.1 });
        expect(r.relation).toBe('against');
        expect(r.windOverTide).toBe(false);
    });

    it('returns unknown when the stream direction is unavailable', () => {
        const r = windVsTide({ windDeg: 0, streamDeg: null, windKts: 20, currentKts: 2 });
        expect(r.relation).toBe('unknown');
        expect(r.windOverTide).toBe(false);
    });

    it('end-to-end: flooding tide + user flood direction + opposing wind → chop', () => {
        // Flood runs toward 020°. Wind FROM 020° blows toward 200° — opposes the
        // flood stream → wind over tide.
        const stream = streamDirection('flood', 20, null);
        const r = windVsTide({ windDeg: 20, streamDeg: stream, windKts: 18, currentKts: 1.2, streamFromSetting: true });
        expect(r.relation).toBe('against');
        expect(r.windOverTide).toBe(true);
        expect(r.streamFromSetting).toBe(true);
    });
});
