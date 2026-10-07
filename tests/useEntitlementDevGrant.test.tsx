/**
 * The VITE_GRANT_ALL_FEATURES dev override reads its flag as a literal
 * `=== 'true'` (W1-FX item 4), the form production's define folds to a
 * constant so the override is compiled out of a public-beta build, and it
 * still follows vi.stubEnv in tests and .env.local in the dev server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// The public beta opens every tier (PUBLIC_BETA_ACCESS), so the tier gate is
// held shut here: what is left to decide the answer is the override alone.
vi.mock('../services/SubscriptionService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    canAccess: () => false,
}));

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

async function canUseGalley(flag: string): Promise<boolean> {
    vi.resetModules();
    vi.stubEnv('VITE_GRANT_ALL_FEATURES', flag);
    const { useEntitlement } = await import('../hooks/useEntitlement');
    return renderHook(() => useEntitlement('galley')).result.current;
}

describe('useEntitlement dev override', () => {
    it('"true" grants every feature the tier would refuse', async () => {
        expect(await canUseGalley('true')).toBe(true);
    });

    it.each(['false', '', 'yes', 'TRUE'])('%j leaves the tier gate in charge', async (flag) => {
        expect(await canUseGalley(flag)).toBe(false);
    });
});
