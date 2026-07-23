import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCachedSubscriptionStatus: vi.fn(),
    isPremiumUser: vi.fn(),
    triggerPaywall: vi.fn(),
}));

vi.mock('../managers/SubscriptionManager', () => mocks);

import { isFeatureLocked, isFeatureLockedSync, type FeatureName } from '../managers/FeatureGate';

describe('FeatureGate runtime safety', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCachedSubscriptionStatus.mockReturnValue({ status: 'active' });
        mocks.isPremiumUser.mockResolvedValue(true);
    });

    it('fails closed for a stale or misspelled runtime feature key', async () => {
        const unknown = 'future_paid_feature' as FeatureName;

        expect(isFeatureLockedSync(unknown)).toBe(true);
        await expect(isFeatureLocked(unknown)).resolves.toBe(true);
        expect(mocks.isPremiumUser).not.toHaveBeenCalled();
    });
});
