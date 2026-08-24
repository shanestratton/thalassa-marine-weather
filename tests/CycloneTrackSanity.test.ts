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

import { projectTrackContinuously } from '../components/map/useCycloneLayer';

/**
 * THE THIRD ROUND, and the post-mortem of the second. map.project() wraps
 * each longitude into [-180, 180] independently — so ANY spelling of a
 * genuinely antimeridian-crossing track straddles the wrap boundary
 * somewhere, and round two's uniform re-spell merely moved WHERE. With the
 * camera at -116 (ISELLE selected), LALA's shift computed to zero and the
 * split survived, exactly as Shane's phone screenshot showed.
 *
 * projectTrackContinuously projects ONE wrapped anchor through Mapbox and
 * places every other point by mercator delta — only one point ever touches
 * the x-wrap, so a continuous input cannot split, whatever the camera.
 */
describe('projectTrackContinuously', () => {
    /** A faithful stub of the mercator project() INCLUDING its wrap —
     *  wrapping is the behaviour under test. */
    const stubMap = (centerLng: number, zoom: number) => ({
        getZoom: () => zoom,
        project: ([lon, lat]: [number, number]) => {
            const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
            const world = 512 * Math.pow(2, zoom);
            return {
                x: ((wrapped - centerLng) / 360) * world + 640,
                y: 360 - (lat / 90) * 200, // shape irrelevant; lat-only
            } as never;
        },
    });

    const LALA_SANE: [number, number][] = [
        [-175.5, 33.9],
        [-179.0, 36.6],
        [-180.5, 38.2],
        [-182.1, 39.8],
    ];

    const maxStep = (pts: { x: number }[]) => {
        let m = 0;
        for (let i = 1; i < pts.length; i++) m = Math.max(m, Math.abs(pts[i].x - pts[i - 1].x));
        return m;
    };

    it('holds LALA together at the ISELLE camera that defeated round two', () => {
        // camera -116.9, z2.1 — the exact configuration in the screenshot.
        const px = projectTrackContinuously(stubMap(-116.9, 2.1) as never, LALA_SANE);
        expect(maxStep(px)).toBeLessThan(100); // a split is ~worldPx ≈ 2194
    });

    it('holds it together at the dev camera from round two’s false pass', () => {
        const px = projectTrackContinuously(stubMap(107.3, 3) as never, LALA_SANE);
        expect(maxStep(px)).toBeLessThan(150);
    });

    it('holds it together at a camera ON the antimeridian', () => {
        const px = projectTrackContinuously(stubMap(180, 4) as never, LALA_SANE);
        expect(maxStep(px)).toBeLessThan(300);
    });

    it('is exact for an ordinary in-range track', () => {
        const track: [number, number][] = [
            [152, -27],
            [153, -26],
        ];
        const m = stubMap(150, 5);
        const px = projectTrackContinuously(m as never, track);
        const direct = track.map((p) => (m.project as (q: [number, number]) => { x: number; y: number })(p));
        expect(px[0].x).toBeCloseTo(direct[0].x, 6);
        expect(px[1].x).toBeCloseTo(direct[1].x, 6);
        expect(px[1].y).toBeCloseTo(direct[1].y, 6);
    });
});

describe('both SVG projection sites use the continuous projector', () => {
    it('past tube and forecast cone both project through the continuous projector', () => {
        const srcNow = readFileSync('components/map/useCycloneLayer.ts', 'utf8');
        const sites = [...srcNow.matchAll(/projectTrackContinuously\(map, sane/g)];
        expect(sites.length).toBe(2);
        // No SVG site may call map.project on track points directly any more —
        // its per-point wrap is the whole bug.
        expect(srcNow).not.toMatch(/px: map\.project\(lonLat\)/);
        // The GL sleeve stays UNRESPELLED on purpose: the GeoJSON pipeline
        // handles continuous spellings correctly, and respelling there would
        // couple stored geometry to a transient camera position.
        const sleeve = srcNow.slice(
            srcNow.indexOf('function addProbabilitySleeve'),
            srcNow.indexOf('const SLEEVE_SOURCE') + 400,
        );
        expect(sleeve).not.toContain('respellTrackForProjection');
    });
});

describe('the probability sleeve follows the SELECTION', () => {
    it('draws one storm — selected first, geo-closest fallback — never a loop', () => {
        const srcNow = readFileSync('components/map/useCycloneLayer.ts', 'utf8');
        // The old shape: a loop writing every storm into ONE shared source, so
        // the last array member always won — NARRA's cone under LALA's card,
        // measured live. The loop must not come back.
        expect(srcNow).not.toMatch(/for \(const c of cyclones\) \{\s*\n\s*addProbabilitySleeve/);
        expect(srcNow).toContain('const sleeveStorm = selectedStormRef.current');
        // ...and stepping storms re-draws it with the card.
        const sel = srcNow.slice(srcNow.indexOf('hud.appendChild(createStormBadgeStatic(selectedStorm));'));
        expect(sel.slice(0, 400)).toContain('addProbabilitySleeve(map, selectedStorm);');
    });
});
