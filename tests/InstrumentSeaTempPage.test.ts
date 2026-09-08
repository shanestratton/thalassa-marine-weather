/**
 * The Sea temp page (Shane 2026-09-09: "add a sea water temp page, with all of
 * the beautiful trimmings as the other pages have").
 *
 * Two things this page could get wrong that would matter: showing a number
 * when the bus carries no water temperature (the barometer's and depth's
 * honesty rule), and calling a 0.1° wobble a trend.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    SEA_TEMP_MIN_SAMPLES,
    SEA_TEMP_STEADY_C,
    formatSeaTemp,
    formatSeaTempDelta,
    seaTempTrend,
} from '../components/nmea/seaTemp';

const page = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

describe('the Sea temp page in the instrument panel', () => {
    const section = page.slice(page.indexOf('── SECTION: SEA TEMP ──'), page.indexOf('── SECTION: HEADING ──'));

    it('sits after Depth, before Heading, and the dot rail knows it', () => {
        expect(section.length).toBeGreaterThan(0);
        expect(page.indexOf('── SECTION: DEPTH ──')).toBeLessThan(page.indexOf('── SECTION: SEA TEMP ──'));
        const rail = page.match(/const base = \[([^\]]+)\]/);
        expect(rail).not.toBeNull();
        const names = (rail as RegExpMatchArray)[1];
        expect(names).toContain("'Sea temp'");
        expect(names.indexOf("'Depth'")).toBeLessThan(names.indexOf("'Sea temp'"));
        expect(names).not.toContain("'Bells'");
    });

    it('reads the real water-temperature metric and keeps a record of it, like the other pages', () => {
        expect(page).toMatch(/const waterTemp = resolveMetric\(state\.waterTemp\)/);
        expect(page).toMatch(/const waterTempReal = useMetricHistory\(state\.waterTemp\)/);
        expect(section).toContain('formatSeaTemp(waterTemp.value, tempUnit)');
        expect(section).toContain('<Sparkline');
        expect(section).toContain('history={waterTempReal.history}');
        expect(section).toContain('<SectionPlate title="Sea temp" />');
    });

    it('is honest when the bus carries no water temperature', () => {
        expect(section).toContain('No water temperature on the bus');
        expect(section).toContain('Nothing here is invented.');
        // The number itself is a dash, never a zero, when the metric is dead.
        expect(formatSeaTemp(null, 'C')).toBe('--');
        expect(formatSeaTemp(undefined, 'F')).toBe('--');
        expect(formatSeaTemp(Number.NaN, 'C')).toBe('--');
    });

    it("shows the skipper's temperature unit", () => {
        expect(page).toMatch(/store\.settings\.units\?\.temp === 'F' \? 'F' : 'C'/);
        expect(formatSeaTemp(25.04, 'C')).toBe('25.0');
        expect(formatSeaTemp(25, 'F')).toBe('77.0');
        expect(formatSeaTempDelta(0.5, 'C')).toBe('+0.5');
        expect(formatSeaTempDelta(-1, 'F')).toBe('-1.8');
    });
});

describe('the sea-temperature trend', () => {
    it('says nothing on a short record', () => {
        expect(seaTempTrend([24, 25, 26])).toBeNull();
        expect(seaTempTrend(Array.from({ length: SEA_TEMP_MIN_SAMPLES - 1 }, (_, i) => 24 + i))).toBeNull();
    });

    it('calls a small wobble steady', () => {
        const flat = [25.0, 25.1, 25.0, 25.1, 25.0, 25.1, 25.1];
        const t = seaTempTrend(flat);
        expect(t?.direction).toBe('steady');
        expect(Math.abs(t?.deltaC ?? 99)).toBeLessThan(SEA_TEMP_STEADY_C);
        expect(t?.read).toMatch(/steady/i);
    });

    it('names warming and cooling water from the change over the record', () => {
        const warming = seaTempTrend([24.0, 24.2, 24.4, 24.6, 24.8, 25.0]);
        expect(warming?.direction).toBe('warming');
        expect(warming?.label).toBe('Warming');
        expect(warming?.read).toContain('+1.0°');
        const cooling = seaTempTrend([25.0, 24.8, 24.6, 24.4, 24.2, 24.0], 'F');
        expect(cooling?.direction).toBe('cooling');
        expect(cooling?.read).toContain('1.8°');
        expect(cooling?.read).not.toContain('-1.8');
    });
});
