/**
 * SubscriptionService — Central subscription tier & feature gating.
 *
 * Three tiers (annual billing):
 *   - Free Crew    ($0)      — basic weather, browse chandlery, crew finder
 *   - First Mate   ($49.95)  — GPS tracking, DMs, AI advice, full weather
 *   - Skipper      ($79.95)  — full feature set inc. route planning, passage legs, galley
 *
 * Usage:
 *   import { canAccess } from '../services/SubscriptionService';
 *   if (!canAccess(tier, 'routePlanner')) { showUpgradeModal(); }
 */

import type { SubscriptionTier } from '../types/settings';

// ── Tier Metadata ─────────────────────────────────────────────

export const TIER_INFO: Record<
    SubscriptionTier,
    {
        label: string;
        shortLabel: string;
        priceAnnual: number;
        priceMonthly: string;
        color: string;
        badge: string;
    }
> = {
    free: {
        label: 'Deckhand',
        shortLabel: 'Deckhand',
        priceAnnual: 0,
        priceMonthly: 'Free',
        color: '#9ca3af', // gray-400
        badge: 'DECKHAND',
    },
    crew: {
        label: 'First Mate',
        shortLabel: 'First Mate',
        priceAnnual: 49.95,
        priceMonthly: '$4.16',
        color: '#22d3ee', // cyan-400
        badge: 'FIRST MATE',
    },
    owner: {
        label: 'Skipper',
        shortLabel: 'Skipper',
        priceAnnual: 79.95,
        priceMonthly: '$6.66',
        color: '#f59e0b', // amber-500
        badge: 'SKIPPER',
    },
};

// ── Feature Definitions ───────────────────────────────────────

/**
 * All gated features in Thalassa.
 * Each feature has a minimum tier required.
 */
export type Feature =
    | 'weatherFull' // 10-day forecast (free = 3-day)
    | 'weatherCharts' // All chart tabs (free = first 3)
    | 'routePlanner' // Route calculation
    | 'passagePlanning' // Full passage plan cards
    | 'passageLegs' // Multi-stop leg tracking
    | 'shipLog' // Full logbook write access
    | 'shipLogRead' // Read-only logbook
    | 'vesselProfile' // Vessel setup & management
    | 'castOff' // Voyage start/end
    | 'galley' // Meal planning
    | 'gpsTracking' // GPS track logging
    | 'crewTalkWrite' // Send messages in Crew Talk
    | 'chandleryPost' // Post listings in Chandlery
    | 'crewFinderCaptain' // Post as captain looking for crew
    | 'directMessages' // DMs & pin drops
    | 'communityDownload' // Download community tracks
    | 'communityShare' // Share own tracks
    | 'aiAdvice' // Captain's AI advice
    | 'anchorWatch' // Anchor watch alarm
    | 'polars' // Polar diagrams & smart polars
    | 'piCache'; // Raspberry Pi local cache server

/**
 * Minimum tier required for each feature.
 * Features not listed here are available to all tiers.
 */
const FEATURE_GATES: Record<Feature, SubscriptionTier> = {
    weatherFull: 'crew',
    weatherCharts: 'crew',
    routePlanner: 'owner',
    passagePlanning: 'owner',
    passageLegs: 'owner',
    shipLog: 'owner',
    shipLogRead: 'crew',
    vesselProfile: 'owner',
    castOff: 'owner',
    galley: 'owner',
    gpsTracking: 'crew',
    crewTalkWrite: 'crew',
    chandleryPost: 'crew',
    crewFinderCaptain: 'owner',
    directMessages: 'crew',
    communityDownload: 'crew',
    communityShare: 'owner',
    aiAdvice: 'crew',
    anchorWatch: 'crew',
    polars: 'owner',
    piCache: 'owner',
};

// ── Tier Ranking ──────────────────────────────────────────────

const TIER_RANK: Record<SubscriptionTier, number> = {
    free: 0,
    crew: 1,
    owner: 2,
};

// ── Public API ────────────────────────────────────────────────

/**
 * Check if a subscription tier has access to a feature.
 *
 * @example
 *   canAccess('free', 'routePlanner')  // false
 *   canAccess('crew', 'gpsTracking')   // true
 *   canAccess('owner', 'routePlanner') // true
 */
export function canAccess(tier: SubscriptionTier, feature: Feature): boolean {
    const required = FEATURE_GATES[feature];
    return TIER_RANK[tier] >= TIER_RANK[required];
}

/**
 * Get the minimum tier required for a feature.
 */
export function requiredTier(feature: Feature): SubscriptionTier {
    return FEATURE_GATES[feature];
}

/**
 * Get the display label for a tier.
 */
export function tierLabel(tier: SubscriptionTier): string {
    return TIER_INFO[tier].label;
}

/**
 * Check if subscription is expired.
 */
export function isExpired(expiryDate?: string): boolean {
    if (!expiryDate) return false; // Free tier has no expiry
    return new Date(expiryDate) < new Date();
}

/**
 * Get the effective tier, accounting for expiry.
 * If a paid tier has expired, falls back to 'free'.
 */
export function effectiveTier(tier: SubscriptionTier, expiryDate?: string): SubscriptionTier {
    if (tier === 'free') return 'free';
    return isExpired(expiryDate) ? 'free' : tier;
}

/**
 * Backward-compat: derive isPro from tier.
 * Returns true for crew and owner (any paid tier).
 */
export function tierIsPro(tier: SubscriptionTier): boolean {
    return tier !== 'free';
}
