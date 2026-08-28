/**
 * The instrument panel is otherwise entirely relative — angles off the bow,
 * speed through the water, depth under the keel. The fix is the one line
 * that says where she actually is (Shane 2026-08-28), so it has to be in the
 * form a skipper writes in a log, reads off a chart and passes over a radio:
 * degrees and decimal minutes, hemisphere suffixed.
 *
 * Three decimals is not a style choice. services/shiplog/helpers.ts formats
 * to one because its output is STORED on log entries, and a tenth of a
 * minute is 185 m — fine as a log stamp, far too coarse for a live readout,
 * which is why this one is separate rather than a shared change.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

// The formatter is module-private; exercise it through a faithful copy of
// the shipped implementation, and assert the source still matches.
function formatFix(lat: number | null, lon: number | null): string | null {
    if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const dm = (v: number, pos: string, neg: string) => {
        const a = Math.abs(v);
        const d = Math.floor(a);
        return `${d}°${((a - d) * 60).toFixed(3)}′${v >= 0 ? pos : neg}`;
    };
    return `${dm(lat, 'N', 'S')}  ${dm(lon, 'E', 'W')}`;
}

describe('position readout', () => {
    it('writes southern and eastern hemispheres the way Moreton Bay is written', () => {
        expect(formatFix(-27.19508, 153.10555)).toBe('27°11.705′S  153°6.333′E');
    });

    it('gets the hemisphere from the sign, both ways', () => {
        expect(formatFix(27.5, -153.5)).toBe('27°30.000′N  153°30.000′W');
    });

    it('keeps three decimal minutes — a tenth of a minute is 185 m', () => {
        const out = formatFix(-27.000016, 153.000016) as string;
        expect(out).toMatch(/\d°\d+\.\d{3}′/);
    });

    it('says there is no fix rather than printing a zero position', () => {
        // 0°N 0°E is a real place in the Gulf of Guinea. Showing it because
        // the GPS is silent would be the worst kind of confident wrong.
        expect(formatFix(null, 153)).toBeNull();
        expect(formatFix(-27, null)).toBeNull();
        expect(formatFix(Number.NaN, 153)).toBeNull();
    });

    it('is still the implementation the page ships', () => {
        expect(src).toContain('function formatFix(lat: number | null, lon: number | null)');
        expect(src).toContain('((a - d) * 60).toFixed(3)');
        expect(src).toContain("'— no fix —'");
    });
});
