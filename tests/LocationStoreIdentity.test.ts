import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadStore(userId: string | null = 'account-a') {
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(userId);
    const { LocationStore } = await import('../stores/LocationStore');
    return { identity, LocationStore };
}

beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('LocationStore transition fences', () => {
    it('does not let an older reverse-geocode result rename a newer selection', async () => {
        let resolveFetch!: (response: Response) => void;
        vi.stubGlobal(
            'fetch',
            vi.fn(
                () =>
                    new Promise<Response>((resolve) => {
                        resolveFetch = resolve;
                    }),
            ),
        );
        const { LocationStore } = await loadStore();

        const resolvingOldPin = LocationStore.setFromMapPin(-26.68, 153.12);
        LocationStore.setFromFavorite(-22.27, 166.44, 'Nouméa, New Caledonia');
        resolveFetch({
            ok: true,
            json: () =>
                Promise.resolve({
                    address: { city: 'Mooloolaba', state: 'Queensland' },
                }),
        } as Response);
        await resolvingOldPin;

        expect(LocationStore.getState()).toMatchObject({
            lat: -22.27,
            lon: 166.44,
            name: 'Nouméa, New Caledonia',
            source: 'favorite',
            isReversGeocoding: false,
        });
    });

    it('clears an account-selected destination immediately on identity change', async () => {
        const { identity, LocationStore } = await loadStore();
        LocationStore.setFromFavorite(-22.27, 166.44, 'Account A destination');

        identity.setAuthIdentityScope('account-b');

        expect(LocationStore.getState()).toMatchObject({
            lat: -27.47,
            lon: 153.02,
            name: 'Brisbane, QLD',
            source: 'initial',
            isReversGeocoding: false,
        });
    });

    it('preserves a physical GPS fix across account changes', async () => {
        const { identity, LocationStore } = await loadStore();
        LocationStore.setFromGPS(-27.2, 153.1, 'Scarborough, QLD');

        identity.setAuthIdentityScope('account-b');

        expect(LocationStore.getState()).toMatchObject({
            lat: -27.2,
            lon: 153.1,
            name: 'Scarborough, QLD',
            source: 'gps',
        });
    });

    it('drops reverse geocoding that resolves after the account changes', async () => {
        let resolveFetch!: (response: Response) => void;
        vi.stubGlobal(
            'fetch',
            vi.fn(
                () =>
                    new Promise<Response>((resolve) => {
                        resolveFetch = resolve;
                    }),
            ),
        );
        const { identity, LocationStore } = await loadStore();

        const resolving = LocationStore.setFromMapPin(-26.68, 153.12);
        identity.setAuthIdentityScope('account-b');
        resolveFetch({
            ok: true,
            json: () => Promise.resolve({ address: { city: 'Private A pin' } }),
        } as Response);
        await resolving;

        expect(LocationStore.getState().name).toBe('Brisbane, QLD');
        expect(LocationStore.getState().source).toBe('initial');
    });

    it('isolates a throwing subscriber so later subscribers still receive the reset', async () => {
        const { identity, LocationStore } = await loadStore();
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const healthy = vi.fn();
        const removeBroken = LocationStore.subscribe(() => {
            throw new Error('broken location consumer');
        });
        const removeHealthy = LocationStore.subscribe(healthy);

        identity.setAuthIdentityScope('account-b');

        expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ source: 'initial' }));
        removeBroken();
        removeHealthy();
        log.mockRestore();
    });
});
