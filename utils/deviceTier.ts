/**
 * deviceTier — coarse classification of the running device's capability,
 * used to scale particle counts and other CPU-heavy work to fit older
 * iPhones (8/SE) without compromising the experience on newer ones.
 *
 * Heuristic — runs once at module load:
 *   - hardwareConcurrency  ≤ 2 cores  → low  (iPhone 6/SE 1st gen)
 *   - hardwareConcurrency  ≤ 4 cores  → mid  (most iPhone 8 era)
 *   - dpr < 3                         → mid  (older retina)
 *   - deviceMemory ≤ 1 GB            → low
 *   - deviceMemory ≤ 2 GB            → mid
 *   - everything else                 → high (default — modern phones)
 *
 * Override via localStorage key `thalassa_device_tier` (low|mid|high)
 * for forced testing of degraded modes on a high-end device.
 *
 * Particle scale factor:
 *   low → 0.4  (40% of default count)
 *   mid → 0.7
 *   high → 1.0
 *
 * Used by:
 *   - components/map/CurrentParticleLayer.ts (NUM_PARTICLES)
 *   - components/map/WindParticleLayer.ts    (NUM_PARTICLES)
 *   - components/map/WindGLEngine.ts          (PARTICLE_RES)
 */

export type DeviceTier = 'low' | 'mid' | 'high';

const OVERRIDE_KEY = 'thalassa_device_tier';

let cached: DeviceTier | null = null;

/** Detect tier once and cache. Override beats heuristic. */
export function getDeviceTier(): DeviceTier {
    if (cached) return cached;

    // Manual override first.
    try {
        const v = (typeof localStorage !== 'undefined' && localStorage.getItem(OVERRIDE_KEY)) || '';
        if (v === 'low' || v === 'mid' || v === 'high') {
            cached = v;
            return v;
        }
    } catch {
        /* localStorage unavailable */
    }

    if (typeof navigator === 'undefined') {
        cached = 'high';
        return cached;
    }

    const cores = navigator.hardwareConcurrency ?? 4;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ram = (navigator as any).deviceMemory ?? 4;
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio ?? 2) : 2;

    if (cores <= 2 || ram <= 1) {
        cached = 'low';
    } else if (cores <= 4 || ram <= 2 || dpr < 3) {
        cached = 'mid';
    } else {
        cached = 'high';
    }
    return cached;
}

/** Multiplier to apply to particle counts and other density-scaling
 *  constants. 1.0 on top-tier hardware, 0.4 on bottom tier. */
export function particleScale(): number {
    const tier = getDeviceTier();
    return tier === 'low' ? 0.4 : tier === 'mid' ? 0.7 : 1.0;
}

/** Multiplier to apply to a 1D particle resolution (e.g. PARTICLE_RES
 *  for a 2D particle texture). Returns sqrt of particleScale so the
 *  total particle count matches particleScale × baseCount when the
 *  caller does PARTICLE_RES² to count particles. */
export function particleResScale(): number {
    return Math.sqrt(particleScale());
}
