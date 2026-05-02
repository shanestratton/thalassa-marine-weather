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
    /**
     * Load the stored comfort profile.
     *
     * Resolution: voyage-specific key first, then the global default.
     * The vessel comfort profile is fundamentally per-boat (the user's
     * own thresholds for wind / wave / wind angle / night sailing) so
     * once they've configured it for ANY voyage we treat the global as
     * pre-configured for new voyages too. Without this carry-over the
     * Comfort Profile readiness card flips back to red whenever the
     * orphan auto-heal switches voyages — even though the user already
     * set their preferences.
     *
     * Save() always writes BOTH keys so the global stays in sync with
     * the latest per-voyage tweak.
     */
    load(voyageId?: string): ComfortProfile {
        const key = voyageId ? `${STORAGE_KEY}_${voyageId}` : STORAGE_KEY;
        try {
            const raw = localStorage.getItem(key);
            if (raw) return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
            // Fallback to global — inherit configured=true so the card
            // stays green across voyage switches.
            if (voyageId) {
                const global = localStorage.getItem(STORAGE_KEY);
                if (global) {
                    const parsed = JSON.parse(global);
                    return { ...DEFAULT_PROFILE, ...parsed };
                }
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
