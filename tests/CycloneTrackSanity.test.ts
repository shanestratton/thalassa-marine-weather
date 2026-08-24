/**
 * The entire-planet cone (Shane 2026-08-24: "a certain storm that has the
 * entire planet as its possible track").
 *
 * Track feeds spell longitude in [-180, 180], so a South Pacific storm
 * crossing the Date Line steps +179.5 → -179.8: a 0.7° move spelled as
 * -359.3°. Nothing unwrapped it — the Catmull-Rom spline interpolated through
 * the wrong 359°, and both cone renderers (the GL sleeve and the screen-space
 * SVG) inflated their error margins around a centreline that toured the
 * planet.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sanitizeTrackLongitudes } from '../components/map/useCycloneLayer';

const src = readFileSync('components/map/useCycloneLayer.ts', 'utf8');

describe('sanitizeTrackLongitudes', () => {
    it('unwraps a Date-Line crossing into a continuous 0.7° step', () => {
        const out = sanitizeTrackLongitudes([
            [178.9, -16.2],
            [179.5, -16.8],
            [-179.8, -17.3], // the sign flip
            [-179.1, -17.9],
        ]);
        expect(out).toHaveLength(4);
        // Continuous spelling: past +180, never back across the world.
        expect(out[2][0]).toBeCloseTo(180.2, 5);
        expect(out[3][0]).toBeCloseTo(180.9, 5);
        // Every successive step is now small — the property the spline needs.
        for (let i = 1; i < out.length; i++) {
            expect(Math.abs(out[i][0] - out[i - 1][0])).toBeLessThan(2);
        }
    });

    it('unwraps the westbound crossing too', () => {
        const out = sanitizeTrackLongitudes([
            [-179.2, -14],
            [179.6, -14.5], // stepping west across the line
        ]);
        expect(out[1][0]).toBeCloseTo(-180.4, 5);
    });

    it('cuts the track at a corrupt fix instead of drawing it', () => {
        // A null-island 0/0 in a Coral Sea track is not a fast storm, it is a
        // broken advisory row. The fastest recorded cyclones move ~1°/hour;
        // no unwrapping can make a 150° jump plausible. Cut, don't repair:
        // invented geometry on a safety display is worse than a shorter,
        // honest track.
        const out = sanitizeTrackLongitudes([
            [152.0, -18.0],
            [153.1, -18.6],
            [0, 0], // corrupt
            [154.0, -19.0],
        ]);
        expect(out).toHaveLength(2);
        expect(out[1]).toEqual([153.1, -18.6]);
    });

    it('cuts on non-finite and out-of-range fixes', () => {
        expect(
            sanitizeTrackLongitudes([
                [151, -20],
                [Number.NaN, -20.5],
                [152, -21],
            ]),
        ).toHaveLength(1);
        expect(
            sanitizeTrackLongitudes([
                [151, -20],
                [151.5, 94],
                [152, -21],
            ]),
        ).toHaveLength(1);
    });

    it('leaves an ordinary track byte-identical', () => {
        const track: [number, number][] = [
            [152.0, -18.0],
            [152.8, -18.9],
            [153.5, -19.7],
        ];
        expect(sanitizeTrackLongitudes(track)).toEqual(track);
    });

    it('keeps the planet impossible: no sanitized track spans more than a basin', () => {
        // The invariant itself, not an example: whatever the feed spells,
        // consecutive points differ by ≤30°, so a K-point track spans at most
        // 30(K-1)° — the spline and both cones inherit that bound.
        const nasty: [number, number][] = [
            [170, -15],
            [-170, -15], // wraps to 190
            [175, -16], // wraps back
            [-165, -17],
        ];
        const out = sanitizeTrackLongitudes(nasty);
        const lons = out.map(([lon]) => lon);
        expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(30 * (out.length - 1) + 1);
    });
});

describe('every track geometry consumer goes through the sanitizer', () => {
    it('covers the GL sleeve, the past-track line, the SVG tube and the SVG cone', () => {
        // Four call sites, because there were four independent raw consumers —
        // fixing only the GL sleeve would have left the screen-space SVG cone
        // still painting the planet, and that one is the shape Shane saw.
        const calls = [...src.matchAll(/sanitizeTrackLongitudes\(/g)];
        expect(calls.length).toBeGreaterThanOrEqual(5); // 4 uses + the definition
        // No geometry site consumes forecastTrack or c.track raw any more.
        expect(src).not.toMatch(/const trackCoords: \[number, number\]\[\] = c\.track\.map/);
        expect(src).not.toMatch(/const projected = c\.track\.map/);
    });
});
