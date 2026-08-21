/**
 * The wind particle layer keeps its state on the CPU and re-uploads the whole
 * trail buffer to the GPU EVERY FRAME, so its cost is count × trail × 20
 * bytes per frame plus a CPU loop over every trail point. At 30 000 × 30 that
 * was 18 MB/frame — ~1 GB/s at 60 fps on a phone — and it is what "wind is
 * slow to load" actually felt like: the seconds after the grid landed were
 * spent choking on the animation (Shane 2026-08-22: "speed, speed and speed
 * … not too many and not too fast, but maintain the colouring").
 *
 * This pins the budget so the count cannot drift back up one "just a bit
 * denser" at a time.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WIND_PARTICLE_BUDGET } from '../components/map/WindParticleLayer';

describe('wind particle budget', () => {
    it('keeps the per-frame GPU upload under 4 MB at the high-end tier', () => {
        expect(WIND_PARTICLE_BUDGET.bytesPerFrameHighTier).toBeLessThanOrEqual(4 * 1024 * 1024);
        // And it must agree with its own inputs — a stale cached figure would
        // let the real upload grow while the test stayed green.
        expect(WIND_PARTICLE_BUDGET.bytesPerFrameHighTier).toBe(
            WIND_PARTICLE_BUDGET.baseParticles * WIND_PARTICLE_BUDGET.trailLength * 5 * 4,
        );
    });

    it('holds the count and trail at Windy-class numbers, not the old 30k×30', () => {
        expect(WIND_PARTICLE_BUDGET.baseParticles).toBeLessThanOrEqual(10_000);
        expect(WIND_PARTICLE_BUDGET.trailLength).toBeLessThanOrEqual(20);
        // Not so few that the field reads as empty at z9 on a phone.
        expect(WIND_PARTICLE_BUDGET.baseParticles).toBeGreaterThanOrEqual(5_000);
    });

    it('advects slower than the old sprint', () => {
        expect(WIND_PARTICLE_BUDGET.speedFactor).toBeLessThan(0.00025);
        expect(WIND_PARTICLE_BUDGET.speedFactor).toBeGreaterThan(0);
    });

    it('keeps the speed colour ramp — fewer particles must not mean less information', () => {
        // The ramp is per-particle speed in the fragment shader, independent
        // of count. If it is ever removed the layer stops saying how HARD it
        // is blowing, which is the one thing it exists to say.
        const src = readFileSync('components/map/WindParticleLayer.ts', 'utf8');
        expect(src).toContain('smoothstep(2.0, 40.0, v_speed)');
        expect(src).toContain('steel blue');
        expect(src).toContain('coral red');
    });
});
