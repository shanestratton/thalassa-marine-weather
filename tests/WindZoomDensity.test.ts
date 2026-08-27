/**
 * Round one (Shane 2026-08-23): "at zoom level 9 there are too many sperm and
 * they are travelling way too fast. can we cut the number in half and slow
 * them down and increment as the zooms move out" — one linear ramp halved
 * count and step together at z9.
 *
 * Round two (Shane 2026-08-27): "a lot less wind sperm when we are zoomed at
 * level 9, and put it on a sliding scale to level 3?? ther is just way to
 * many. also we need to slow them down at zoom level 9 and sliding scale to
 * zoom 3" — the halving undershot. Count now ramps linearly to a QUARTER at
 * z9; the step halves per zoom level (1/64 at z9), cancelling the
 * pixels-per-degree doubling exactly so every zoom in [3, 9] moves at z3's
 * on-screen pace. The advection step is in DEGREES per frame; the particles
 * were never accelerating — the map was.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    WIND_PARTICLE_BUDGET,
    windParticlesForZoom,
    windStepZoomFactor,
    windZoomFactor,
} from '../components/map/WindParticleLayer';

const src = readFileSync('components/map/WindParticleLayer.ts', 'utf8');

describe('windZoomFactor (count)', () => {
    it('quarters at the zoom he complained about — twice', () => {
        expect(windZoomFactor(9)).toBe(0.25);
    });

    it('leaves the WIDE end exactly as it is today', () => {
        // The anchor that matters: he has never complained about z3 — nothing
        // there may get sparser. 1.0 is today's behaviour.
        expect(windZoomFactor(3)).toBe(1);
        expect(windZoomFactor(2)).toBe(1);
        expect(windZoomFactor(0)).toBe(1);
    });

    it('increments as the zooms move out, monotonically', () => {
        const zooms = [9, 8, 7, 6, 5, 4, 3];
        const factors = zooms.map(windZoomFactor);
        for (let i = 1; i < factors.length; i++) {
            expect(factors[i]).toBeGreaterThan(factors[i - 1]);
        }
        expect(factors[0]).toBe(0.25);
        expect(factors.at(-1)).toBe(1);
    });

    it('does not keep thinning past z9 — a quarter is the floor', () => {
        // Zooming further in must not empty the field; at some point the
        // particles are decoration and emptiness reads as broken.
        expect(windZoomFactor(12)).toBe(0.25);
        expect(windZoomFactor(18)).toBe(0.25);
    });

    it("survives a nonsense zoom by falling back to today's behaviour", () => {
        expect(windZoomFactor(Number.NaN)).toBe(1);
        expect(windZoomFactor(Infinity)).toBe(1);
        expect(windZoomFactor(-Infinity)).toBe(1);
    });
});

describe('windStepZoomFactor (speed)', () => {
    it('cancels the pixels-per-degree doubling: constant on-screen pace across z3–z9', () => {
        // Screen pixels per degree double each zoom level, so apparent speed
        // is step × 2^(z-3). Holding that product at 1 IS "z3's pace".
        for (const z of [3, 4, 5, 6, 7, 8, 9]) {
            expect(windStepZoomFactor(z) * Math.pow(2, z - 3)).toBeCloseTo(1, 10);
        }
    });

    it('is 1/64 at z9 and 1.0 at z3 — the wide end is untouched', () => {
        expect(windStepZoomFactor(9)).toBeCloseTo(1 / 64, 10);
        expect(windStepZoomFactor(3)).toBe(1);
        expect(windStepZoomFactor(0)).toBe(1);
    });

    it('clamps past z9 rather than grinding to a stop', () => {
        expect(windStepZoomFactor(12)).toBeCloseTo(1 / 64, 10);
        expect(windStepZoomFactor(18)).toBeCloseTo(1 / 64, 10);
    });

    it("survives a nonsense zoom by falling back to today's behaviour", () => {
        // Non-finite readings (NaN, ±Infinity) all degrade to "as it always
        // was" — same contract as the count ramp.
        expect(windStepZoomFactor(Number.NaN)).toBe(1);
        expect(windStepZoomFactor(Infinity)).toBe(1);
        expect(windStepZoomFactor(-Infinity)).toBe(1);
    });
});

describe('windParticlesForZoom', () => {
    it('quarters the population at z9 and restores it wide', () => {
        expect(windParticlesForZoom(9, 9000)).toBe(2250);
        expect(windParticlesForZoom(3, 9000)).toBe(9000);
        expect(windParticlesForZoom(6, 9000)).toBe(5625);
    });

    it('never exceeds the allocation it is given', () => {
        for (const z of [-2, 0, 3, 6, 9, 14]) {
            expect(windParticlesForZoom(z, 9000)).toBeLessThanOrEqual(9000);
        }
    });

    it('always leaves at least one particle', () => {
        expect(windParticlesForZoom(9, 1)).toBeGreaterThanOrEqual(1);
    });
});

describe('wiring', () => {
    it('scales the step per frame through the SPEED ramp, not the count ramp', () => {
        // If only the count moved, z9 would be less crowded and still sprint.
        expect(src).toContain('this.speedFactor = SPEED_FACTOR * windStepZoomFactor(zoom)');
        expect(src).toContain('x += u * this.speedFactor * cosLat');
        expect(src).not.toContain('x += u * SPEED_FACTOR * cosLat');
    });

    it('buckets the population on rounded zoom but keeps the step smooth', () => {
        const fn = src.slice(src.indexOf('private syncZoomBudget'), src.indexOf('private respawnParticle'));
        expect(fn).toContain('const bucket = Math.round(zoom);');
        expect(fn).toContain('if (bucket === this.zoomBudgetFor) return;');
        // …and the step is set BEFORE that early return, so it tracks the
        // exact zoom rather than the bucket.
        expect(fn.indexOf('this.speedFactor =')).toBeLessThan(fn.indexOf('const bucket ='));
    });

    it('respawns slots on the way back in rather than teleporting them', () => {
        const fn = src.slice(src.indexOf('private syncZoomBudget'), src.indexOf('private respawnParticle'));
        expect(fn).toContain('for (let i = this.activeParticles; i < next; i++) this.respawnParticle(i);');
    });

    it('uploads and draws only the active slice', () => {
        expect(src).toContain('const drawCount = active * TRAIL_LENGTH;');
        expect(src).toContain('gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.uploadView);');
        expect(src).toContain('this.uploadView.length !== active * FLOATS_PER_PARTICLE');
    });

    it('reseeds the WHOLE buffer, not just what is active', () => {
        const fn = src.slice(src.indexOf('private respawnAllParticles'), src.indexOf('private respawnParticle'));
        expect(fn).toContain('i < NUM_PARTICLES');
    });

    it('draws SMALLER marks as it zooms in, not bigger', () => {
        // The size ramp used to run the wrong way — 2.5px at z3 growing to
        // 5.0px at z10 — so the tight end drew the fattest marks on top of
        // being the most crowded. That is why z9 never looked like z3
        // (Shane 2026-08-28). All three ramps now agree in direction.
        const shader = src.slice(src.indexOf('gl_PointSize = mix('));
        expect(shader).toContain('mix(${WIND_POINT_SIZE_WIDE.toFixed(1)}, ${WIND_POINT_SIZE_TIGHT.toFixed(1)}');
        expect(src).not.toContain('gl_PointSize = mix(2.5, 5.0');
        // Tight end is the SMALL end, and the wide end is untouched.
        expect(WIND_PARTICLE_BUDGET.pointSizeRange[0]).toBeLessThan(WIND_PARTICLE_BUDGET.pointSizeRange[1]);
        expect(WIND_PARTICLE_BUDGET.pointSizeRange[1]).toBe(2.5);
        // Not so fine it disappears on a phone.
        expect(WIND_PARTICLE_BUDGET.pointSizeRange[0]).toBeGreaterThanOrEqual(1.5);
    });

    it('runs all three ramps over the same z3-z9 span', () => {
        // Count, speed and size must turn over together, or the field changes
        // character halfway through a pinch.
        const span = src.slice(src.indexOf('const WIND_ZOOM_TIGHT'), src.indexOf('const FLOATS_PER_TRAIL_PT'));
        expect(span).toContain('WIND_ZOOM_TIGHT = 9');
        expect(span).toContain('WIND_ZOOM_WIDE = 3');
        expect(src).toContain('(u_zoom - ${WIND_ZOOM_WIDE}.0) / ${(WIND_ZOOM_TIGHT - WIND_ZOOM_WIDE)}.0');
    });

    it('keeps the worst-case frame budget where it was', () => {
        // The ceiling is unchanged — the ramp only ever draws less than it.
        expect(WIND_PARTICLE_BUDGET.bytesPerFrameHighTier).toBe(9000 * 18 * 5 * 4);
        expect(WIND_PARTICLE_BUDGET.bytesPerFrameTightZoom).toBe(2250 * 18 * 5 * 4);
        expect(WIND_PARTICLE_BUDGET.zoomFactorRange).toEqual([0.25, 1]);
        expect(WIND_PARTICLE_BUDGET.stepFactorRange).toEqual([Math.pow(2, -6), 1]);
    });
});
