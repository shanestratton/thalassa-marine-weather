import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    userId: 'account-a' as string | null,
    getCurrentUserId: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        rpc: mocks.rpc,
    },
    getCurrentUserId: mocks.getCurrentUserId,
}));

import { clearCache, getCachedSubscriptionStatus, getSubscriptionStatus } from '../managers/SubscriptionManager';
import { isFeatureLockedSync } from '../managers/FeatureGate';

describe('subscription identity boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearCache();
        localStorage.clear();
        setAuthIdentityScope(null);
        mocks.userId = 'account-a';
        mocks.getCurrentUserId.mockImplementation(async () => mocks.userId);
        setAuthIdentityScope('account-a');
        mocks.rpc.mockResolvedValue({
            data: {
                subscription_status: 'free',
                trial_start_date: null,
                subscription_expiry: null,
            },
            error: null,
        });
    });

    it('discards account A entitlement data that resolves after B becomes active', async () => {
        let resolveProfile!: (value: {
            data: {
                subscription_status: string;
                trial_start_date: null;
                subscription_expiry: null;
            };
            error: null;
        }) => void;
        mocks.rpc.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveProfile = resolve;
            }),
        );

        const pending = getSubscriptionStatus();
        await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('ensure_own_user_entitlement'));

        mocks.userId = 'account-b';
        setAuthIdentityScope('account-b');
        resolveProfile({
            data: {
                subscription_status: 'active',
                trial_start_date: null,
                subscription_expiry: null,
            },
            error: null,
        });

        await expect(pending).resolves.toMatchObject({ status: 'free' });
        expect(getCachedSubscriptionStatus()).toBeNull();
        expect(isFeatureLockedSync('vessel_intel')).toBe(true);
    });

    it('keeps synchronous premium features locked until this account is verified', async () => {
        localStorage.setItem(
            'thalassa_subscription_cache',
            JSON.stringify({ status: 'active', userId: 'some-old-account' }),
        );
        expect(isFeatureLockedSync('vessel_intel')).toBe(true);

        mocks.rpc.mockResolvedValueOnce({
            data: {
                subscription_status: 'active',
                trial_start_date: null,
                subscription_expiry: null,
            },
            error: null,
        });
        await expect(getSubscriptionStatus()).resolves.toMatchObject({ status: 'active' });
        expect(isFeatureLockedSync('vessel_intel')).toBe(false);

        mocks.userId = 'account-b';
        setAuthIdentityScope('account-b');
        expect(getCachedSubscriptionStatus()).toBeNull();
        expect(isFeatureLockedSync('vessel_intel')).toBe(true);
    });
});
