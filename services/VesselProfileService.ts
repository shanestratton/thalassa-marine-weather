/**
 * VesselProfileService — Vessel performance profile management.
 *
 * Stores hull type, LOA, cruising speed, motoring speed.
 * Calculates hull speed (1.34 × √LWL) for realistic ETAs.
 * Persists to localStorage (instant) for passage planning use.
 */

export interface VesselProfile {
    vesselType: 'monohull' | 'catamaran' | 'power';
    loaFeet: number; // Length Overall in feet
    cruisingSpeedKts: number; // Typical cruising speed
    motoringSpeedKts: number; // Speed under motor
    comfortWindMaxKts: number; // Max acceptable wind
    configured: boolean;
}

const STORAGE_KEY = 'thalassa_vessel_profile';

const DEFAULT_PROFILE: VesselProfile = {
    vesselType: 'monohull',
    loaFeet: 38,
    cruisingSpeedKts: 6,
    motoringSpeedKts: 5.5,
    comfortWindMaxKts: 25,
    configured: false,
};

export const VesselProfileService = {
    /** Load the stored vessel profile */
    load(): VesselProfile {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
        } catch {
            /* ignore */
        }
        return { ...DEFAULT_PROFILE };
    },

    /** Save the vessel profile */
    save(profile: VesselProfile): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...profile, configured: true }));
        } catch {
            /* ignore */
        }
    },

    /** Calculate theoretical hull speed from LOA.
     *  Hull speed = 1.34 × √(LWL in feet)
     *  We estimate LWL ≈ LOA × 0.85 for sailboats, 0.9 for power */
    hullSpeed(profile: VesselProfile): number {
        const lwlFactor = profile.vesselType === 'power' ? 0.9 : 0.85;
        const lwl = profile.loaFeet * lwlFactor;
        return Math.round(1.34 * Math.sqrt(lwl) * 10) / 10;
    },

    /** Generate simplified speed lookup for different conditions */
    speedForConditions(profile: VesselProfile, windKts: number, isMotoring: boolean): number {
        if (isMotoring) return profile.motoringSpeedKts;

        // Simplified performance model — not polars, but realistic enough
        const base = profile.cruisingSpeedKts;
        const hull = VesselProfileService.hullSpeed(profile);

        if (windKts < 5) return profile.motoringSpeedKts * 0.9; // Ghosting → motor
        if (windKts < 10) return base * 0.7; // Light air
        if (windKts < 15) return base * 0.9; // Moderate
        if (windKts < 20) return base; // Ideal
        if (windKts < 25) return Math.min(base * 1.05, hull); // Strong
        if (windKts < 30) return base * 0.85; // Reefed
        return base * 0.65; // Heavy weather — deep reef or bare poles
    },
};
