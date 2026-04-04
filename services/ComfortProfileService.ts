/**
 * ComfortProfileService — Voyage comfort threshold management.
 *
 * Stores per-voyage comfort limits: max wind, max wave height,
 * preferred wind angle, night sailing preference.
 * Used by WeatherWindowService to score departure windows.
 */

export interface ComfortProfile {
    maxWindKts: number;
    maxWaveM: number;
    preferredAngle: 'any' | 'following' | 'quarter' | 'broad_reach' | 'no_beating';
    nightSailing: boolean;
    configured: boolean;
}

const STORAGE_KEY = 'thalassa_comfort_profile';

const DEFAULT_PROFILE: ComfortProfile = {
    maxWindKts: 25,
    maxWaveM: 2.5,
    preferredAngle: 'any',
    nightSailing: true,
    configured: false,
};

export const ANGLE_LABELS: Record<ComfortProfile['preferredAngle'], string> = {
    any: 'Any Wind Angle',
    following: 'Following Seas (0–45°)',
    quarter: 'Quarter (45–90°)',
    broad_reach: 'Broad Reach (90–135°)',
    no_beating: 'No Beating (avoid >135°)',
};

export const ComfortProfileService = {
    /** Load the stored comfort profile (voyage-specific if id given) */
    load(voyageId?: string): ComfortProfile {
        const key = voyageId ? `${STORAGE_KEY}_${voyageId}` : STORAGE_KEY;
        try {
            const raw = localStorage.getItem(key);
            if (raw) return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
            // Fallback to global
            if (voyageId) {
                const global = localStorage.getItem(STORAGE_KEY);
                if (global) return { ...DEFAULT_PROFILE, ...JSON.parse(global), configured: false };
            }
        } catch {
            /* ignore */
        }
        return { ...DEFAULT_PROFILE };
    },

    /** Save the comfort profile */
    save(profile: ComfortProfile, voyageId?: string): void {
        const key = voyageId ? `${STORAGE_KEY}_${voyageId}` : STORAGE_KEY;
        try {
            localStorage.setItem(key, JSON.stringify({ ...profile, configured: true }));
            // Also save as global default
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...profile, configured: true }));
        } catch {
            /* ignore */
        }
    },
};
