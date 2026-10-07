/**
 * useEntitlement — React hook that returns whether the current user can
 * access a gated feature based on their subscription tier.
 *
 * Thin wrapper around `canAccess` from SubscriptionService — the value
 * here is reactivity (re-renders when the user upgrades/downgrades) plus
 * a clean call-site that doesn't have to import the tier separately.
 *
 * Usage:
 *   const canUseGalley = useEntitlement('galley');
 *   if (!canUseGalley) return <PaywallGate feature="galley" />;
 *
 * Dev override: if `VITE_GRANT_ALL_FEATURES=true` is set in .env.local,
 * always returns true. Useful when testing UI flows without juggling
 * the user's tier in dev tools.
 */
import { useSettingsStore } from '../stores/settingsStore';
import { canAccess, type Feature } from '../services/SubscriptionService';

// A literal comparison, so production's define ("false" in the public-beta
// profile) folds it to a constant and the override is compiled out
// (tests/BundleStructuralTrims.test.ts). Exactly 'true' switches it on.
const DEV_GRANT_ALL = import.meta.env.VITE_GRANT_ALL_FEATURES === 'true';

export function useEntitlement(feature: Feature): boolean {
    const tier = useSettingsStore((s) => s.settings.subscriptionTier);
    if (DEV_GRANT_ALL) return true;
    return canAccess(tier, feature);
}
