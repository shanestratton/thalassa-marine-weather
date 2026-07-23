import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferenceMocks = vi.hoisted(() => ({
    values: new Map<string, string>(),
    get: vi.fn(),
    set: vi.fn(),
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: preferenceMocks.get,
        set: preferenceMocks.set,
    },
}));

async function loadModules(userId: string | null = 'account-a') {
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(userId);
    const basket = await import('../services/ChandleryBasketService');
    return { identity, basket };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    preferenceMocks.values.clear();
    preferenceMocks.get.mockImplementation(({ key }: { key: string }) =>
        Promise.resolve({ value: preferenceMocks.values.get(key) ?? null }),
    );
    preferenceMocks.set.mockImplementation(({ key, value }: { key: string; value: string }) => {
        preferenceMocks.values.set(key, value);
        return Promise.resolve();
    });
});

describe('ChandleryBasketService identity isolation', () => {
    it('swaps A and B baskets while ignoring the unattributed legacy key', async () => {
        const identity = await import('../services/authIdentityScope');
        const accountA = identity.setAuthIdentityScope('account-a');
        const accountBKey = identity.authScopedStorageKey('thalassa_chandlery_basket', {
            key: 'user:account-b',
            userId: 'account-b',
            generation: accountA.generation + 1,
        });
        preferenceMocks.values.set(
            identity.authScopedStorageKey('thalassa_chandlery_basket', accountA),
            JSON.stringify([{ productId: 'a-anchor', quantity: 1 }]),
        );
        preferenceMocks.values.set(accountBKey, JSON.stringify([{ productId: 'b-rope', quantity: 2 }]));
        preferenceMocks.values.set(
            'thalassa_chandlery_basket',
            JSON.stringify([{ productId: 'legacy-secret', quantity: 9 }]),
        );
        const basket = await import('../services/ChandleryBasketService');

        await expect(basket.loadBasket()).resolves.toEqual([{ productId: 'a-anchor', quantity: 1 }]);

        identity.setAuthIdentityScope('account-b');
        expect(basket.getBasket()).toEqual([]);
        await vi.waitFor(() => expect(basket.getBasket()).toEqual([{ productId: 'b-rope', quantity: 2 }]));

        identity.setAuthIdentityScope('account-a');
        expect(basket.getBasket()).toEqual([]);
        await vi.waitFor(() => expect(basket.getBasket()).toEqual([{ productId: 'a-anchor', quantity: 1 }]));
        expect(basket.getBasket().some((line) => line.productId === 'legacy-secret')).toBe(false);
    });

    it('does not let a late A load replace B', async () => {
        const { identity, basket } = await loadModules('account-a');
        const accountAKey = identity.authScopedStorageKey('thalassa_chandlery_basket');
        let resolveAccountA!: (value: { value: string }) => void;
        preferenceMocks.get.mockImplementation(({ key }: { key: string }) => {
            if (key === accountAKey) {
                return new Promise<{ value: string }>((resolve) => {
                    resolveAccountA = resolve;
                });
            }
            return Promise.resolve({
                value: JSON.stringify([{ productId: 'b-compass', quantity: 1 }]),
            });
        });

        const loadingA = basket.loadBasket();
        identity.setAuthIdentityScope('account-b');
        await vi.waitFor(() => expect(basket.getBasket()).toEqual([{ productId: 'b-compass', quantity: 1 }]));

        resolveAccountA({ value: JSON.stringify([{ productId: 'a-private', quantity: 4 }]) });
        await loadingA;
        expect(basket.getBasket()).toEqual([{ productId: 'b-compass', quantity: 1 }]);
    });

    it('aborts an A mutation that was waiting for hydration when B takes over', async () => {
        const { identity, basket } = await loadModules('account-a');
        const accountAKey = identity.authScopedStorageKey('thalassa_chandlery_basket');
        let resolveAccountA!: (value: { value: null }) => void;
        preferenceMocks.get.mockImplementation(({ key }: { key: string }) => {
            if (key === accountAKey) {
                return new Promise<{ value: null }>((resolve) => {
                    resolveAccountA = resolve;
                });
            }
            return Promise.resolve({ value: null });
        });

        const adding = basket.addToBasket('a-radio');
        identity.setAuthIdentityScope('account-b');
        await vi.waitFor(() => expect(preferenceMocks.get).toHaveBeenCalledTimes(2));
        resolveAccountA({ value: null });
        await adding;

        expect(basket.getBasket()).toEqual([]);
        expect(preferenceMocks.set).not.toHaveBeenCalledWith(expect.objectContaining({ key: accountAKey }));
    });

    it('writes a captured A snapshot only to A when identity changes during persistence', async () => {
        const { identity, basket } = await loadModules('account-a');
        await basket.loadBasket();
        const accountAKey = identity.authScopedStorageKey('thalassa_chandlery_basket');
        let resolveWrite!: () => void;
        preferenceMocks.set.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveWrite = resolve;
                }),
        );

        const adding = basket.addToBasket('a-binoculars');
        await vi.waitFor(() => expect(preferenceMocks.set).toHaveBeenCalledOnce());
        identity.setAuthIdentityScope('account-b');
        expect(basket.getBasket()).toEqual([]);
        resolveWrite();
        await adding;

        expect(preferenceMocks.set).toHaveBeenCalledWith({
            key: accountAKey,
            value: JSON.stringify([{ productId: 'a-binoculars', quantity: 1 }]),
        });
        expect(basket.getBasket()).toEqual([]);
    });
});
