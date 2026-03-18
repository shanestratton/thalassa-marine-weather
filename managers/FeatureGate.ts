/**
 * FeatureGate — Centralised feature-locking utility
 *
 * Wraps SubscriptionManager to provide a simple, declarative API for
 * gating premium features. Add a feature to FEATURE_REGISTRY, then
 * guard it anywhere in the app with:
 *
 *   if (await isFeatureLocked('ais_guard_zone')) {
 *       triggerPaywall();
 *       return;
 *   }
 *
 * To unlock a feature for all users, just change its tier to 'free'.
 * To add a new premium feature, add one line to the registry.
 */

import { isPremiumUser, triggerPaywall, type SubscriptionStatus } from './SubscriptionManager';
import { createLogger } from '../utils/logger';

const log = createLogger('FeatureGate');

// --- TIER DEFINITIONS ---

/** Minimum subscription tier required to access a feature */
export type FeatureTier = 'free' | 'premium';

export interface FeatureDefinition {
    /** Human-readable name (shown in paywall prompts) */
    label: string;
    /** Minimum tier required */
    tier: FeatureTier;
    /** Short description of why it's premium (for upgrade prompts) */
    description?: string;
}

// --- FEATURE REGISTRY ---
// Single source of truth for what's free vs premium.
// To change a feature's tier, edit this one object.

export const FEATURE_REGISTRY = {
    // --- Navigation & Safety ---
    ais_guard_zone: {
        label: 'AIS Guard Zone',
        tier: 'premium',
        description: 'Set custom collision alert perimeters around your vessel',
    },
    vessel_intel: {
        label: 'Vessel Intelligence',
        tier: 'premium',
        description: 'Instant vessel identification with name, flag, photo, and dimensions',
    },
    anchor_watch_shore: {
        label: 'Shore Monitoring',
        tier: 'premium',
        description: 'Monitor your anchor from shore via real-time sync',
    },
    weather_routing: {
        label: 'Weather Routing',
        tier: 'premium',
        description: 'Isochrone-based optimal route planning with GRIB data',
    },
    passage_planning: {
        label: 'Passage Planning',
        tier: 'premium',
        description: 'Full passage analysis with depth, weather, and resource calculations',
    },

    // --- Weather ---
    stormglass_highres: {
        label: 'High-Res Weather',
        tier: 'premium',
        description: 'StormGlass + WeatherKit precision forecasts',
    },
    consensus_matrix: {
        label: 'Consensus Matrix',
        tier: 'premium',
        description: 'Multi-model weather comparison grid',
    },

    // --- Communication ---
    satellite_mode: {
        label: 'Satellite Mode',
        tier: 'premium',
        description: 'Bandwidth-conserving mode for Iridium GO! connections',
    },

    // --- Vessel Management ---
    maintenance_hub: {
        label: 'Maintenance Hub',
        tier: 'premium',
        description: 'Scheduled maintenance tracking with PDF export',
    },
    polar_performance: {
        label: 'Polar Performance',
        tier: 'premium',
        description: 'Smart polar analysis and performance tracking',
    },
    inventory_scanner: {
        label: 'Inventory Scanner',
        tier: 'premium',
        description: 'Barcode scanning for vessel inventory management',
    },

    // --- Export ---
    pdf_export: {
        label: 'PDF Export',
        tier: 'premium',
        description: 'Export voyage logs and maintenance records as PDF',
    },
    gpx_export: {
        label: 'GPX Export',
        tier: 'free', // GPX is free — PDF is premium
        description: 'Export tracks and routes as GPX files',
    },

    // --- Social ---
    crew_finder: {
        label: 'Crew Finder',
        tier: 'free',
        description: 'Browse and connect with crew',
    },
    marketplace: {
        label: 'Marketplace',
        tier: 'free',
        description: 'Buy and sell marine equipment',
    },
    chat: {
        label: 'Crew Talk',
        tier: 'free',
        description: 'Channel and direct messaging',
    },

    // --- Core (always free) ---
    weather_basic: {
        label: 'Weather Forecast',
        tier: 'free',
        description: 'OpenMeteo-powered weather forecasts',
    },
    ship_log: {
        label: "Ship's Log",
        tier: 'free',
        description: 'GPS tracking and voyage logging',
    },
    anchor_watch: {
        label: 'Anchor Watch',
        tier: 'free',
        description: 'Basic anchor monitoring with drag alarm',
    },
    diary: {
        label: "Captain's Diary",
        tier: 'free',
        description: 'Personal voyage journal',
    },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureName = keyof typeof FEATURE_REGISTRY;

// --- CORE API ---

/**
 * Check if a feature is locked for the current user.
 * Returns true if the feature requires premium and the user doesn't have it.
 *
 * Usage:
 *   if (await isFeatureLocked('ais_guard_zone')) {
 *       triggerPaywall();
 *       return;
 *   }
 */
export async function isFeatureLocked(feature: FeatureName): Promise<boolean> {
    const def = FEATURE_REGISTRY[feature];
    if (!def) {
        log.warn(`Unknown feature: ${feature}`);
        return false; // Unknown features default to unlocked (fail open)
    }

    // Free features are never locked
    if (def.tier === 'free') return false;

    // Premium features: check subscription
    const premium = await isPremiumUser();
    return !premium;
}

/**
 * Synchronous version — uses cached subscription status.
 * Falls back to unlocked if cache is empty (first load).
 * Prefer the async version for accuracy; use this for render-path checks
 * where you can't await.
 */
export function isFeatureLockedSync(feature: FeatureName): boolean {
    const def = FEATURE_REGISTRY[feature];
    if (!def || def.tier === 'free') return false;

    // Check cached premium status from SubscriptionManager
    // If no cache exists yet, default to unlocked (don't block UI on first render)
    try {
        const cached = localStorage.getItem('thalassa_subscription_cache');
        if (!cached) return false;
        const status = JSON.parse(cached) as { status: SubscriptionStatus };
        return status.status !== 'active' && status.status !== 'trial';
    } catch {
        return false;
    }
}

/**
 * Check + gate in one call. If locked, triggers the paywall and returns true.
 * Convenience wrapper for the common pattern.
 *
 * Usage:
 *   if (await guardFeature('pdf_export')) return; // paywall shown, bail out
 *   // ... proceed with export
 */
export async function guardFeature(feature: FeatureName): Promise<boolean> {
    const locked = await isFeatureLocked(feature);
    if (locked) {
        log.info(`Feature locked: ${feature}, triggering paywall`);
        triggerPaywall();
        return true;
    }
    return false;
}

/**
 * Get the feature definition (label, description, tier) for UI display.
 */
export function getFeatureInfo(feature: FeatureName): FeatureDefinition {
    return FEATURE_REGISTRY[feature];
}

/**
 * Get all premium features (for upgrade screen / feature comparison).
 */
export function getPremiumFeatures(): Array<{ key: FeatureName; def: FeatureDefinition }> {
    return (Object.entries(FEATURE_REGISTRY) as [FeatureName, FeatureDefinition][])
        .filter(([, def]) => def.tier === 'premium')
        .map(([key, def]) => ({ key, def }));
}

/**
 * Get all free features (for marketing / onboarding).
 */
export function getFreeFeatures(): Array<{ key: FeatureName; def: FeatureDefinition }> {
    return (Object.entries(FEATURE_REGISTRY) as [FeatureName, FeatureDefinition][])
        .filter(([, def]) => def.tier === 'free')
        .map(([key, def]) => ({ key, def }));
}
