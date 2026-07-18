/**
 * tideExtremesInterp — Unit tests
 *
 * Covers the shared half-cosine interpolation helper
 * (services/tides/extremesInterp.ts) and TideCurve hydration from
 * cached extremes (TideHeightService.buildTideCurve): provenance
 * labelling and the LAT datum guard.
 */

import { describe, it, expect } from 'vitest';
import { buildExtremesLookup, heightFromExtremes } from '../services/tides/extremesInterp';
import { buildTideCurve } from '../services/TideHeightService';
import type { WorldTidesResponse } from '../types/api';

const HOUR_MS = 3600 * 1000;

// A 0.4 m low at t=0 rising to a 2.0 m high 6 h later (semidiurnal-ish).
const LOW = { timeMs: 0, heightM: 0.4, type: 'Low' as const };
const HIGH = { timeMs: 6 * HOUR_MS, heightM: 2.0, type: 'High' as const };

// ── extremesInterp helper ────────────────────────────────────

describe('extremesInterp — half-cosine between extremes', () => {
    it('returns the exact midpoint height at half-period', () => {
        // (0.4 + 2.0) / 2 = 1.2 — the cos(π/2) term vanishes.
        expect(heightFromExtremes([LOW, HIGH], 3 * HOUR_MS)).toBe(1.2);
    });

    it('rises monotonically from low to high', () => {
        const heightAt = buildExtremesLookup([LOW, HIGH]);
        let prev = -Infinity;
        for (let t = 0; t <= 6 * HOUR_MS; t += 15 * 60 * 1000) {
            const h = heightAt(t);
            expect(h).not.toBeNull();
            expect(h as number).toBeGreaterThan(prev);
            prev = h as number;
        }
    });

    it('returns exact heights AT the extremes', () => {
        const heightAt = buildExtremesLookup([LOW, HIGH]);
        expect(heightAt(LOW.timeMs)).toBe(0.4);
        expect(heightAt(HIGH.timeMs)).toBe(2.0);
    });

    it('returns null outside the extremes window (no extrapolation)', () => {
        const heightAt = buildExtremesLookup([LOW, HIGH]);
        expect(heightAt(-1)).toBeNull();
        expect(heightAt(6 * HOUR_MS + 1)).toBeNull();
    });

    it('returns null with fewer than 2 extremes', () => {
        expect(heightFromExtremes([], 0)).toBeNull();
        expect(heightFromExtremes([LOW], LOW.timeMs)).toBeNull();
    });

    it('handles unsorted input', () => {
        expect(heightFromExtremes([HIGH, LOW], 3 * HOUR_MS)).toBe(1.2);
    });

    it('interpolates across multiple extremes (falling limb after the high)', () => {
        const nextLow = { timeMs: 12 * HOUR_MS, heightM: 0.6, type: 'Low' as const };
        const heightAt = buildExtremesLookup([LOW, HIGH, nextLow]);
        expect(heightAt(9 * HOUR_MS)).toBe((2.0 + 0.6) / 2);
        expect(heightAt(10 * HOUR_MS) as number).toBeLessThan(heightAt(8 * HOUR_MS) as number);
    });
});

// ── TideCurve hydration ──────────────────────────────────────

const BASE_DT = 1_750_000_000; // unix seconds

function extremesResponse(overrides: Partial<WorldTidesResponse> = {}): WorldTidesResponse {
    return {
        status: 200,
        requestDatum: 'LAT',
        responseDatum: 'LAT',
        station: { name: 'Brisbane Port Office', lat: -27.4667, lon: 153.033 },
        extremes: [
            { dt: BASE_DT, date: 'd0', height: 0.4, type: 'Low' },
            { dt: BASE_DT + 6 * 3600, date: 'd1', height: 2.0, type: 'High' },
            { dt: BASE_DT + 12 * 3600, date: 'd2', height: 0.6, type: 'Low' },
        ],
        ...overrides,
    };
}

describe('buildTideCurve — hydration from cached extremes', () => {
    it('builds an EXTREMES_INTERP curve when only extremes are present', () => {
        const curve = buildTideCurve(extremesResponse());
        expect(curve).not.toBeNull();
        expect(curve?.provenance).toBe('EXTREMES_INTERP');
        expect(curve?.heights).toEqual([]);
        expect(curve?.rangeMs).toEqual([BASE_DT * 1000, (BASE_DT + 12 * 3600) * 1000]);
        expect(curve?.stationName).toBe('Brisbane Port Office');
        // Half-cosine midpoint of the rising limb.
        expect(curve?.heightAt((BASE_DT + 3 * 3600) * 1000)).toBe(1.2);
        // No extrapolation beyond the fetched window.
        expect(curve?.heightAt((BASE_DT - 60) * 1000)).toBeNull();
    });

    it('builds a STATION_HEIGHTS curve when dense heights are present', () => {
        const curve = buildTideCurve(
            extremesResponse({
                heights: [
                    { dt: BASE_DT, date: 'h0', height: 1.0 },
                    { dt: BASE_DT + 1800, date: 'h1', height: 1.5 },
                ],
            }),
        );
        expect(curve?.provenance).toBe('STATION_HEIGHTS');
        // Linear midpoint between dense heights.
        expect(curve?.heightAt((BASE_DT + 900) * 1000)).toBeCloseTo(1.25, 12);
    });

    it('refuses a non-LAT datum (returns null, never converts)', () => {
        expect(buildTideCurve(extremesResponse({ requestDatum: 'MSL', responseDatum: 'MSL' }))).toBeNull();
    });

    it('refuses a response with no datum confirmation', () => {
        expect(buildTideCurve(extremesResponse({ requestDatum: undefined, responseDatum: undefined }))).toBeNull();
    });

    it('falls back to requestDatum when responseDatum is missing', () => {
        const curve = buildTideCurve(extremesResponse({ responseDatum: undefined }));
        expect(curve?.provenance).toBe('EXTREMES_INTERP');
    });

    it('returns null when neither heights nor ≥2 extremes exist', () => {
        expect(buildTideCurve(extremesResponse({ extremes: [] }))).toBeNull();
        expect(
            buildTideCurve(extremesResponse({ extremes: [{ dt: BASE_DT, date: 'd0', height: 0.4, type: 'Low' }] })),
        ).toBeNull();
    });
});

describe('extremesInterp — alternation + inversion guard (cycle-6 re-audit #4, safety)', () => {
    it('a same-type pair (HW,HW — a dropped/aliased extreme) refuses to interpolate', () => {
        const heightAt = buildExtremesLookup([
            { timeMs: 0, heightM: 2.0, type: 'High' as const },
            { timeMs: 6 * HOUR_MS, heightM: 2.0, type: 'High' as const },
        ]);
        expect(heightAt(3 * HOUR_MS)).toBeNull(); // no bogus near-HW credit across the trough
        expect(heightAt(0)).toBe(2.0); // exact-hit measured height still honoured
    });
    it('a physically inverted alternating pair (High below the Low) refuses too', () => {
        const heightAt = buildExtremesLookup([
            { timeMs: 0, heightM: 0.5, type: 'High' as const }, // "High" lower than the "Low"
            { timeMs: 6 * HOUR_MS, heightM: 2.0, type: 'Low' as const },
        ]);
        expect(heightAt(3 * HOUR_MS)).toBeNull();
    });
    it('a type-LESS pair still blends (stormglass display path is unaffected)', () => {
        const heightAt = buildExtremesLookup([
            { timeMs: 0, heightM: 0.4 },
            { timeMs: 6 * HOUR_MS, heightM: 2.0 },
        ]);
        expect(heightAt(3 * HOUR_MS)).toBe(1.2); // guard NOT triggered without types
    });
    it('a well-formed alternating pair is unaffected', () => {
        expect(heightFromExtremes([LOW, HIGH], 3 * HOUR_MS)).toBe(1.2);
    });
});
