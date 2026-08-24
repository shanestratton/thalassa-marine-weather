/**
 * "at zoom level 9 there are too many sperm and they are travelling way too
 * fast. can we cut the number in half and slow them down and increment as the
 * zooms move out" (Shane 2026-08-23).
 *
 * Both complaints have the same cause, which is why one ramp fixes both.
 *
 * The advection step is in DEGREES per frame and was fixed. Screen pixels per
 * degree double with every zoom level, so an unchanged step is twice as fast
 * on screen at z9 as at z8 and 64x as fast as at z3. The particles were never
 * accelerating — the map was. Density has the mirror problem: 9 000 particles
 * across the Coral Sea at z3 is sparse, and the same 9 000 in one bay at z9 is
 * a swarm.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WIND_PARTICLE_BUDGET, windParticlesForZoom, windZoomFactor } from '../components/map/WindParticleLayer';

const src = readFileSync('components/map/WindParticleLayer.ts', 'utf8');

describe('windZoomFactor', () => {
    it('halves at the zoom he complained about', () => {
        expect(windZoomFactor(9)).toBe(0.5);
    });

    it('leaves the WIDE end exactly as it is today', () => {
        // The anchor that matters: he has never complained about z3-z5, so
        // nothing there may get slower or sparser. 1.0 is today's behaviour.
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
        expect(factors[0]).toBe(0.5);
        expect(factors.at(-1)).toBe(1);
    });

    it('does not keep halving past z9 — half is the floor', () => {
        // Zooming further in must not grind them to a stop; at some point the
        // particles are decoration and stillness reads as broken.
        expect(windZoomFactor(12)).toBe(0.5);
        expect(windZoomFactor(18)).toBe(0.5);
    });

    it("survives a nonsense zoom by falling back to today's behaviour", () => {
        // 1.0 is the pre-change behaviour, so a bad reading degrades to "as
        // it always was" rather than to an empty or frozen field.
        expect(windZoomFactor(Number.NaN)).toBe(1);
        expect(windZoomFactor(Infinity)).toBe(1);
        expect(windZoomFactor(-Infinity)).toBe(1);
    });
});

describe('windParticlesForZoom', () => {
    it('halves the population at z9 and restores it wide', () => {
        expect(windParticlesForZoom(9, 9000)).toBe(4500);
        expect(windParticlesForZoom(3, 9000)).toBe(9000);
        expect(windParticlesForZoom(6, 9000)).toBe(6750);
    });

    it('never exceeds the allocation it is given', () => {
        // The buffer is sized once for the maximum; this only ever draws less.
        for (const z of [-2, 0, 3, 6, 9, 14]) {
            expect(windParticlesForZoom(z, 9000)).toBeLessThanOrEqual(9000);
        }
    });

    it('always leaves at least one particle', () => {
        expect(windParticlesForZoom(9, 1)).toBeGreaterThanOrEqual(1);
    });
});

describe('wiring', () => {
    it('scales the step per frame, not just the count', () => {
        // If only the count moved, z9 would be less crowded and still sprint.
        expect(src).toContain('this.speedFactor = SPEED_FACTOR * windZoomFactor(zoom)');
        expect(src).toContain('x += u * this.speedFactor * cosLat');
        expect(src).not.toContain('x += u * SPEED_FACTOR * cosLat');
    });

    it('buckets the population on rounded zoom but keeps the step smooth', () => {
        // Respawning on every frame of a pinch would look like static.
        const fn = src.slice(src.indexOf('private syncZoomBudget'), src.indexOf('private respawnParticle'));
        expect(fn).toContain('const bucket = Math.round(zoom);');
        expect(fn).toContain('if (bucket === this.zoomBudgetFor) return;');
        // …and the step is set BEFORE that early return, so it tracks the
        // exact zoom rather than the bucket.
        expect(fn.indexOf('this.speedFactor =')).toBeLessThan(fn.indexOf('const bucket ='));
    });

    it('respawns slots on the way back in rather than teleporting them', () => {
        // An inactive slot holds a position from wherever it was last
        // simulated. Waking it mid-trail draws a streak across the ocean.
        const fn = src.slice(src.indexOf('private syncZoomBudget'), src.indexOf('private respawnParticle'));
        expect(fn).toContain('for (let i = this.activeParticles; i < next; i++) this.respawnParticle(i);');
    });

    it('uploads and draws only the active slice', () => {
        // This buffer is re-uploaded EVERY frame, so halving it at z9 is a
        // continuous saving, not a one-off.
        expect(src).toContain('const drawCount = active * TRAIL_LENGTH;');
        expect(src).toContain('gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.uploadView);');
        // The cached view exists so the frame loop does not allocate.
        expect(src).toContain('this.uploadView.length !== active * FLOATS_PER_PARTICLE');
    });

    it('reseeds the WHOLE buffer, not just what is active', () => {
        // A slot that is inactive now becomes active the moment the user
        // zooms out; it must not wake holding a position from the old grid.
        const fn = src.slice(src.indexOf('private respawnAllParticles'), src.indexOf('private respawnParticle'));
        expect(fn).toContain('i < NUM_PARTICLES');
    });

    it('keeps the worst-case frame budget where it was', () => {
        // The ceiling is unchanged — the ramp only ever draws less than it.
        expect(WIND_PARTICLE_BUDGET.bytesPerFrameHighTier).toBe(9000 * 18 * 5 * 4);
        expect(WIND_PARTICLE_BUDGET.bytesPerFrameTightZoom).toBe(4500 * 18 * 5 * 4);
        expect(WIND_PARTICLE_BUDGET.zoomFactorRange).toEqual([0.5, 1]);
    });
});
