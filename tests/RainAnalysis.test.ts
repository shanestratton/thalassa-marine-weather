/**
 * The rain card's claims, tested against a fixed clock.
 *
 * These pin the honesty rules extracted into rainAnalysis.ts after the
 * 2026-08-20 audit. The one that matters most is the first: a feed whose
 * every frame has elapsed must say so — the old code analysed the past and
 * Math.max(1, negative) pinned a false "Rain in 1 min" through every
 * 60-second tick until the next half-hour refresh. On a boat, "rain in
 * 1 minute" is an instruction to act. It must never be a rounding artefact.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRain, RAIN_THRESHOLD } from '../components/dashboard/rainAnalysis';

const NOW = Date.parse('2026-08-20T02:00:00Z');

/** Build a feed of 1-minute frames from `startOffsetMin` relative to NOW. */
const feed = (intensities: number[], startOffsetMin = 0) =>
    intensities.map((intensity, i) => ({
        time: new Date(NOW + (startOffsetMin + i) * 60_000).toISOString(),
        intensity,
    }));

describe('an expired feed never claims rain', () => {
    it('reports out-of-date, not "Rain in 1 min"', () => {
        // 60 rainy minutes, all of them 30-90 minutes in the past.
        const stale = feed(Array(60).fill(5), -90);
        const a = analyzeRain(stale, { now: NOW });
        expect(a.expired).toBe(true);
        expect(a.hasRain).toBe(false);
        expect(a.frames).toHaveLength(0);
        expect(a.headline).toBe('Rain Data Out Of Date');
        expect(a.headline).not.toMatch(/Rain in \d+ min/);
    });

    it('stays honest through subsequent ticks (the pin was permanent)', () => {
        const stale = feed(Array(60).fill(5), -90);
        for (const minutesLater of [1, 5, 30]) {
            const a = analyzeRain(stale, { now: NOW + minutesLater * 60_000 });
            expect(a.expired).toBe(true);
            expect(a.headline).not.toMatch(/Rain in \d+ min/);
        }
    });

    it('"Rain stopping in 1 min" cannot pin either', () => {
        // Currently-raining shape, fully elapsed.
        const stale = feed([5, 5, 0.1, 0.1], -30);
        const a = analyzeRain(stale, { now: NOW });
        expect(a.expired).toBe(true);
        expect(a.headline).not.toMatch(/stopping/i);
    });
});

describe('countdowns come from timestamps against the live clock', () => {
    it('rain 12 minutes out reads "Rain in 12 min"', () => {
        const a = analyzeRain(feed([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 4]), { now: NOW });
        expect(a.headline).toBe('Rain in 12 min');
        expect(a.hasRain).toBe(true);
    });

    it('the same feed read 5 minutes later says 7', () => {
        const a = analyzeRain(feed([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 4]), { now: NOW + 5 * 60_000 });
        expect(a.headline).toBe('Rain in 7 min');
    });

    it('currently raining with a dry frame ahead says stopping', () => {
        const a = analyzeRain(feed([5, 5, 5, 0.1, 0.1]), { now: NOW });
        expect(a.isCurrentlyRaining).toBe(true);
        expect(a.headline).toBe('Rain stopping in 3 min');
    });
});

describe('frames are future-only and indices point into them', () => {
    it('elapsed minutes fall out of frames', () => {
        // 10 past minutes, 20 future ones.
        const a = analyzeRain(feed(Array(30).fill(0), -10), { now: NOW });
        // One minute of grace for the frame in progress.
        expect(a.frames.length).toBeGreaterThanOrEqual(20);
        expect(a.frames.length).toBeLessThanOrEqual(21);
    });

    it('peakIdx indexes the frames array, not the raw feed', () => {
        // Peak at raw index 15; the first ~10 minutes have elapsed. If peakIdx
        // were still rendered against the raw array, the Peak marker would sit
        // ~10 bars early — the drift the audit caught in the modal.
        const intensities = Array(30).fill(0.4);
        intensities[15] = 9;
        const a = analyzeRain(feed(intensities, -10), { now: NOW });
        expect(a.frames[a.peakIdx].intensity).toBe(9);
    });

    it('firstRainIdx agrees with the frames array too', () => {
        const intensities = Array(30).fill(0);
        intensities[18] = 2; // first rain at raw index 18, after 10 elapsed
        const a = analyzeRain(feed(intensities, -10), { now: NOW });
        expect(a.frames[a.firstRainIdx].intensity).toBe(2);
        expect(a.frames.slice(0, a.firstRainIdx).every((f) => f.intensity < RAIN_THRESHOLD)).toBe(true);
    });
});

describe('the dry verdict states the window it actually checked', () => {
    it('a fresh 4-hour feed says hours', () => {
        const a = analyzeRain(feed(Array(240).fill(0)), { now: NOW });
        expect(a.headline).toBe('No rain expected next 4 hours');
    });

    it('an aged 60-minute feed only vouches for the remainder', () => {
        // Fetched 29 min ago: last bucket runs to +31 min from now.
        const a = analyzeRain(feed(Array(60).fill(0), -29), { now: NOW });
        expect(a.headline).toBe('No rain expected next 31 min');
    });

    it('never rounds the window up — 2 h 30 checked reads 2\u00bd hours, not 3', () => {
        const a = analyzeRain(feed(Array(150).fill(0)), { now: NOW });
        expect(a.headline).toBe('No rain expected next 2\u00bd hours');
    });

    it('a 3\u00bd-hour span is not "4 hours"', () => {
        const a = analyzeRain(feed(Array(210).fill(0)), { now: NOW });
        expect(a.headline).toBe('No rain expected next 3\u00bd hours');
    });

    it('rain through the whole checked span claims only that span', () => {
        // 20 wet minutes left of an aged feed is not "rain for the next hour".
        const a = analyzeRain(feed(Array(60).fill(5), -40), { now: NOW });
        expect(a.isCurrentlyRaining).toBe(true);
        expect(a.headline).toMatch(/^Rain for the next 2[01] min$/);
    });

    it('a frozen provider countdown is never the headline', () => {
        const a = analyzeRain(feed(Array(60).fill(0)), {
            now: NOW,
            rainSummary: 'Light Rain in 37 min',
        });
        expect(a.headline).not.toContain('37');
    });
});

describe('no data is not a forecast', () => {
    it('empty while loading', () => {
        const a = analyzeRain([], { now: NOW, status: 'loading' });
        expect(a.headline).toBe('Rain Forecast Loading…');
        expect(a.hasRain).toBe(false);
    });

    it('empty after error', () => {
        const a = analyzeRain([], { now: NOW, status: 'error' });
        expect(a.headline).toBe('Rain Forecast Unavailable');
        expect(a.expired).toBe(false);
    });
});
