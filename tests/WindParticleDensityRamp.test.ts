/**
 * THE WIND LAYER THE APP ACTUALLY RENDERS.
 *
 * Read this before touching wind particles. There are two implementations:
 *
 *   components/map/WindParticleLayer.ts  — a WebGL layer instantiated ONLY by
 *       components/map/ThalassaMap.tsx, which nothing imports. Dead code.
 *   components/map/MapboxVelocityOverlay.tsx — the leaflet-velocity bridge
 *       rendered by MapHub, which IS the OBS page. THIS ONE.
 *
 * Three consecutive rounds of "fewer / slower / smaller particles" (Shane
 * 2026-08-23, 08-27, 08-28) were applied to the dead one and shipped no
 * visible change, because its tests are source-text assertions that read the
 * dead file happily. This suite exists so the density contract is pinned to
 * the layer on screen.
 *
 * leaflet-velocity sizes its population from CANVAS PIXEL AREA:
 *     particuleCount = round(canvas.width * canvas.height * particleMultiplier)
 * There is no zoom term, so without a ramp the same number of particles is
 * drawn over an ocean at z3 and over a bay at z9 — which is exactly why the
 * tight end looked like a swarm.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { zoomScaledParticleMultiplier, zoomCompensatedVelocityScale } from '../components/map/MapboxVelocityOverlay';

const BASE = 1 / 150;
const overlay = readFileSync('components/map/MapboxVelocityOverlay.tsx', 'utf8');

describe('particle density ramp (the real layer)', () => {
    it('leaves the wide end exactly as it shipped', () => {
        // z3 is the look Shane signed off on; nothing there may get sparser.
        expect(zoomScaledParticleMultiplier(3)).toBeCloseTo(BASE, 12);
        expect(zoomScaledParticleMultiplier(0)).toBeCloseTo(BASE, 12);
        expect(zoomScaledParticleMultiplier(-5)).toBeCloseTo(BASE, 12);
    });

    it('quarters the density at z9', () => {
        expect(zoomScaledParticleMultiplier(9)).toBeCloseTo(BASE * 0.25, 12);
    });

    it('slides monotonically between, so a pinch has no step change', () => {
        const values = [3, 4, 5, 6, 7, 8, 9].map(zoomScaledParticleMultiplier);
        for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThan(values[i - 1]);
    });

    it('continues thinning smoothly through harbour zoom without emptying the field', () => {
        let previous = zoomScaledParticleMultiplier(9);
        for (let z = 9.1; z <= 22; z += 0.1) {
            const next = zoomScaledParticleMultiplier(z);
            expect(next).toBeLessThan(previous);
            expect(next * 390 * 844).toBeGreaterThan(40);
            previous = next;
        }
        expect(zoomScaledParticleMultiplier(9.001)).toBeCloseTo(zoomScaledParticleMultiplier(9), 5);
    });

    it('degrades to the shipped density on a nonsense zoom', () => {
        // Every non-finite reading degrades to "as it shipped", so a bad
        // zoom can never empty the field — same contract the other ramps use.
        expect(zoomScaledParticleMultiplier(Number.NaN)).toBeCloseTo(BASE, 12);
        expect(zoomScaledParticleMultiplier(Infinity)).toBeCloseTo(BASE, 12);
        expect(zoomScaledParticleMultiplier(-Infinity)).toBeCloseTo(BASE, 12);
    });
});

describe('the ramp is actually wired into the renderer', () => {
    it('is handed to every layer-creation path, not just one', () => {
        // A multiplier computed and never passed is the failure mode this
        // whole file exists to catch.
        expect(overlay).not.toMatch(/particleMultiplier:\s*1\s*\/\s*150/);
        expect(overlay).toContain('particleMultiplier,');
        const creations = overlay.match(/createVelocityLayer\(/g) ?? [];
        expect(creations.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
    });

    it('is re-applied on zoom alongside the speed scale', () => {
        // start() re-reads particuleCount, so density must be handed over in
        // the same breath as velocityScale or zooming thins the motion and
        // leaves the swarm.
        const sync = overlay.slice(overlay.indexOf('const syncFull'));
        expect(sync).toContain('windy.velocityScale = zoomCompensatedVelocityScale(zRaw)');
        expect(sync).toContain('windy.particleMultiplier = zoomScaledParticleMultiplier(zRaw)');
    });

    it('slows apparent pixel speed at every zoom, including projection magnification', () => {
        const pixels = (z: number) => zoomCompensatedVelocityScale(z) * Math.pow(2, 0.2 * (z - 3));
        for (let z = 4; z <= 22; z++) expect(pixels(z)).toBeLessThan(pixels(z - 1));
        expect(pixels(22)).toBeGreaterThan(pixels(3) * 0.05);
        expect(zoomCompensatedVelocityScale(NaN)).toBe(zoomCompensatedVelocityScale(3));
    });
    it('normal Wind no longer imposes a zoom-in ceiling at 9', () => {
        const weather = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
        const wind = weather.slice(weather.indexOf('} else if (hasWind) {'), weather.indexOf('// No weather layer'));
        expect(wind).toContain('map.setMaxZoom(22)');
        expect(wind).not.toContain('map.setMaxZoom(9)');
    });
});
