import { describe, it, expect } from 'vitest';
import { getMoonPhaseData } from '../components/dashboard/tide/CelestialComponents';

describe('CelestialComponents — getMoonPhaseData', () => {
    // ── Basic output structure ──────────────────────────────────

    it('returns phaseName, illumination, and phaseRatio', () => {
        const result = getMoonPhaseData(new Date());
        expect(result).toHaveProperty('phaseName');
        expect(result).toHaveProperty('illumination');
        expect(result).toHaveProperty('phaseRatio');
    });

    it('phaseRatio is between 0 and 1', () => {
        const result = getMoonPhaseData(new Date());
        expect(result.phaseRatio).toBeGreaterThanOrEqual(0);
        expect(result.phaseRatio).toBeLessThan(1);
    });

    it('illumination is between 0 and 1', () => {
        const result = getMoonPhaseData(new Date());
        expect(result.illumination).toBeGreaterThanOrEqual(0);
        expect(result.illumination).toBeLessThanOrEqual(1);
    });

    // ── Known moon phases ──────────────────────────────────────

    it('known new moon returns ~0 illumination', () => {
        // Jan 6, 2000 12:24 UTC was a known new moon
        const result = getMoonPhaseData(new Date('2000-01-06T12:24:00Z'));
        expect(result.illumination).toBeLessThan(0.05);
        expect(result.phaseName).toBe('New Moon');
    });

    it('~14.76 days after new moon is full moon', () => {
        // Half a synodic month (~14.76 days) after known new moon
        const newMoon = new Date('2000-01-06T12:24:00Z');
        const fullMoon = new Date(newMoon.getTime() + 14.765 * 24 * 60 * 60 * 1000);
        const result = getMoonPhaseData(fullMoon);
        expect(result.illumination).toBeGreaterThan(0.95);
        expect(result.phaseName).toBe('Full Moon');
    });

    it('~7.4 days after new moon is first quarter', () => {
        const newMoon = new Date('2000-01-06T12:24:00Z');
        const firstQ = new Date(newMoon.getTime() + 7.38 * 24 * 60 * 60 * 1000);
        const result = getMoonPhaseData(firstQ);
        expect(result.illumination).toBeGreaterThan(0.4);
        expect(result.illumination).toBeLessThan(0.6);
        expect(result.phaseName).toBe('First Quarter');
    });

    it('~22.15 days after new moon is last quarter', () => {
        const newMoon = new Date('2000-01-06T12:24:00Z');
        const lastQ = new Date(newMoon.getTime() + 22.15 * 24 * 60 * 60 * 1000);
        const result = getMoonPhaseData(lastQ);
        expect(result.illumination).toBeGreaterThan(0.4);
        expect(result.illumination).toBeLessThan(0.6);
        expect(result.phaseName).toBe('Last Quarter');
    });

    // ── Determinism ─────────────────────────────────────────────

    it('same date always produces same result', () => {
        const date = new Date('2026-03-15T12:00:00Z');
        const r1 = getMoonPhaseData(date);
        const r2 = getMoonPhaseData(date);
        expect(r1).toEqual(r2);
    });

    // ── Phase name coverage ──────────────────────────────────

    it('covers all 8 phase names across a full cycle', () => {
        const phases = new Set<string>();
        const newMoon = new Date('2000-01-06T12:24:00Z');
        for (let d = 0; d < 30; d++) {
            const date = new Date(newMoon.getTime() + d * 24 * 60 * 60 * 1000);
            phases.add(getMoonPhaseData(date).phaseName);
        }
        expect(phases.size).toBe(8);
        expect(phases.has('New Moon')).toBe(true);
        expect(phases.has('Waxing Crescent')).toBe(true);
        expect(phases.has('First Quarter')).toBe(true);
        expect(phases.has('Waxing Gibbous')).toBe(true);
        expect(phases.has('Full Moon')).toBe(true);
        expect(phases.has('Waning Gibbous')).toBe(true);
        expect(phases.has('Last Quarter')).toBe(true);
        expect(phases.has('Waning Crescent')).toBe(true);
    });

    // ── Edge cases ──────────────────────────────────────────────

    it('handles date before known epoch', () => {
        const result = getMoonPhaseData(new Date('1990-01-01T00:00:00Z'));
        expect(result.phaseRatio).toBeGreaterThanOrEqual(0);
        expect(result.phaseRatio).toBeLessThan(1);
        expect(result.phaseName.length).toBeGreaterThan(0);
    });

    it('handles far future date', () => {
        const result = getMoonPhaseData(new Date('2100-06-15T00:00:00Z'));
        expect(result.phaseRatio).toBeGreaterThanOrEqual(0);
        expect(result.phaseRatio).toBeLessThan(1);
    });
});
