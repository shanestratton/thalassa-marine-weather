import { beforeEach, describe, expect, it, vi } from 'vitest';

const precomputeMocks = vi.hoisted(() => ({
    preloadBathymetry: vi.fn(),
    computeIsochrones: vi.fn(),
    createWindFieldFromGrid: vi.fn(() => ({ wind: true })),
    exportToPolarData: vi.fn(() => ({ polar: true })),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../stores/WindStore', () => ({
    WindStore: { getState: () => ({ grid: { width: 1, height: 1 } }) },
}));
vi.mock('../services/weather/WindFieldAdapter', () => ({
    createWindFieldFromGrid: precomputeMocks.createWindFieldFromGrid,
}));
vi.mock('../services/SmartPolarStore', () => ({
    SmartPolarStore: { exportToPolarData: precomputeMocks.exportToPolarData },
}));
vi.mock('../services/defaultPolar', () => ({
    DEFAULT_CRUISING_POLAR: { fallback: true },
}));
vi.mock('../services/BathymetryCache', () => ({
    preloadBathymetry: precomputeMocks.preloadBathymetry,
}));
vi.mock('../services/IsochroneRouter', () => ({
    computeIsochrones: precomputeMocks.computeIsochrones,
}));

const departure = { lat: -27.5, lon: 153.1 };
const arrival = { lat: -26.4, lon: 153.2 };
const result = {
    routeCoordinates: [
        [153.1, -27.5],
        [153.2, -26.4],
    ],
    totalDistanceNM: 72,
    totalDurationHours: 12,
};

async function loadFor(userId = 'account-a') {
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(null);
    identity.setAuthIdentityScope(userId);
    const service = await import('../services/IsochronePrecomputeCache');
    return { identity, service };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    precomputeMocks.preloadBathymetry.mockResolvedValue({ depths: true });
    precomputeMocks.computeIsochrones.mockResolvedValue(result);
});

describe('IsochronePrecomputeCache identity ownership', () => {
    it('returns a completed route only to the exact identity generation that computed it', async () => {
        const { identity, service } = await loadFor();
        const accountA = identity.getAuthIdentityScope();

        await service.precomputeIsochrone(departure, arrival, '2026-07-23T00:00:00.000Z', accountA);

        expect(service.getPrecomputedRoute(departure.lat, departure.lon, arrival.lat, arrival.lon, accountA)).toBe(
            result,
        );
        expect(
            service.getPrecomputedRoute(departure.lat, departure.lon, arrival.lat, arrival.lon, accountA),
        ).toBeNull();
    });

    it('purges A cache synchronously before B can inspect matching private coordinates', async () => {
        const { identity, service } = await loadFor();
        await service.precomputeIsochrone(departure, arrival, '2026-07-23T00:00:00.000Z');

        identity.setAuthIdentityScope('account-b');

        expect(service.isPrecomputing()).toBe(false);
        expect(service.getPrecomputedRoute(departure.lat, departure.lon, arrival.lat, arrival.lon)).toBeNull();
    });

    it('does not let A finish a bathymetry wait and populate cache after switching to B', async () => {
        let resolveBathymetry!: (value: { depths: boolean }) => void;
        precomputeMocks.preloadBathymetry.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveBathymetry = resolve;
                }),
        );
        const { identity, service } = await loadFor();
        const accountA = identity.getAuthIdentityScope();

        const computing = service.precomputeIsochrone(departure, arrival, '2026-07-23T00:00:00.000Z', accountA);
        await vi.waitFor(() => expect(precomputeMocks.preloadBathymetry).toHaveBeenCalledOnce());

        identity.setAuthIdentityScope('account-b');
        resolveBathymetry({ depths: true });
        await computing;

        expect(precomputeMocks.computeIsochrones).not.toHaveBeenCalled();
        expect(service.getPrecomputedRoute(departure.lat, departure.lon, arrival.lat, arrival.lon)).toBeNull();
    });

    it('rejects a delayed A producer rather than relabelling it as B', async () => {
        const { identity, service } = await loadFor();
        const accountA = identity.getAuthIdentityScope();
        identity.setAuthIdentityScope('account-b');

        await service.precomputeIsochrone(departure, arrival, '2026-07-23T00:00:00.000Z', accountA);

        expect(precomputeMocks.preloadBathymetry).not.toHaveBeenCalled();
        expect(precomputeMocks.computeIsochrones).not.toHaveBeenCalled();
    });

    it('does not reuse a cache after logout and login to the same account key', async () => {
        const { identity, service } = await loadFor();
        const firstLogin = identity.getAuthIdentityScope();
        await service.precomputeIsochrone(departure, arrival, '2026-07-23T00:00:00.000Z', firstLogin);

        identity.setAuthIdentityScope(null);
        const secondLogin = identity.setAuthIdentityScope('account-a');

        expect(secondLogin.key).toBe(firstLogin.key);
        expect(secondLogin.generation).not.toBe(firstLogin.generation);
        expect(
            service.getPrecomputedRoute(departure.lat, departure.lon, arrival.lat, arrival.lon, secondLogin),
        ).toBeNull();
    });
});
