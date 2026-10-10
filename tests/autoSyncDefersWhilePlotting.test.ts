import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The Pi auto-sync pulls up to 20 ENC cells. That is a background convenience;
 * the route tracer is not.
 *
 * From Shane's device log, taken while plotting: `blobCache=15 cells/44.8MB`,
 * which is 93% of EncCellStore's 48 MB cap — and that file documents parsed heap
 * as ~3× the text figure, so ~134 MB resident — with
 * `autoSyncFromPi pulling OC-61-351824 (4/20)` and an OSM overlay fetch running
 * against it at the same time. The webview being reclaimed reloads it, and
 * uiStore seeds currentView from bootView at module scope, so the skipper lands
 * back on the dashboard. It looks exactly like a crash and leaves no crash log.
 *
 * Same reasoning as the existing 10 s boot deferral: wait for calm water.
 */

const h = vi.hoisted(() => ({
    syncEncFromPi: vi.fn(async () => ({ pulled: 0, failed: 0, skipped: 0 })),
    isAvailable: vi.fn(() => true),
    getCurrentPosition: vi.fn(async () => null),
    listPiInstalledCharts: vi.fn(async () => [] as unknown[]),
    registerFromPiIndex: vi.fn(() => 0),
    pulls: vi.fn(),
}));

vi.mock('../services/EncImportService', () => ({
    syncEncFromPi: h.syncEncFromPi,
    listPiInstalledCharts: h.listPiInstalledCharts,
    registerFromPiIndex: h.registerFromPiIndex,
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: h.isAvailable,
        viaRemoteAccess: false,
        baseUrl: 'https://pi.local:3001',
        ping: async () => ({ reachable: true }),
        onStatusChange: () => () => undefined,
    },
}));
vi.mock('../services/piTls', () => ({
    piRequest: async (options: { url: string }) => {
        h.pulls(options.url);
        throw new Error('no blob pulls in this test');
    },
    piPairingFetch: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    isPinnedTransportAvailable: () => true,
}));
vi.mock('../services/GpsService', () => ({
    GpsService: { getCurrentPositionIfGranted: h.getCurrentPosition },
}));

import { autoSyncFromPiIfPossible } from '../services/enc/autoSyncFromPi';

const setTracer = (active: boolean) =>
    window.dispatchEvent(new CustomEvent('thalassa:tracer-active', { detail: { active } }));

describe('autoSyncFromPi — defers while the skipper is plotting', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setTracer(false);
    });

    it('does not pull cells while the tracer is active', async () => {
        setTracer(true);
        await autoSyncFromPiIfPossible();
        expect(h.syncEncFromPi).not.toHaveBeenCalled();
    });

    it('deferring does NOT burn the throttle slot — the next call after Done runs', async () => {
        // This is the property that makes the deferral safe rather than a
        // silent disable: if the skip stamped lastAttemptMs, finishing a trace
        // would leave the sync blocked for another five minutes.
        setTracer(true);
        await autoSyncFromPiIfPossible();
        expect(h.syncEncFromPi).not.toHaveBeenCalled();

        setTracer(false);
        await autoSyncFromPiIfPossible();
        expect(h.syncEncFromPi).toHaveBeenCalledTimes(1);
    });

    // 127-C-c decision 7a: the boat registry (metadata only) is the tracer's
    // own call, so it never waits for this deferral — only blob pulls do.
    it('with the tracer open at launch the boat registry still registers, and no blob is pulled', async () => {
        localStorage.setItem(
            'thalassa_pi_pairing_v1',
            JSON.stringify({ deviceId: 'pi-fixture', publicKeySpki: 'key', boatName: 'Nordlys av Tromsø' }),
        );
        const rows = [{ cellId: 'OC-99-ZZ0700', sourceHO: 'ZZ' }];
        h.listPiInstalledCharts.mockResolvedValueOnce(rows);
        setTracer(true);
        await autoSyncFromPiIfPossible();
        const { ensureBoatRegistry, boatRegistryState } = await import('../services/enc/piCellSync');
        expect(await ensureBoatRegistry()).toBe('loaded');
        expect(boatRegistryState()).toBe('loaded');
        expect(h.registerFromPiIndex).toHaveBeenCalledWith(rows);
        expect(h.syncEncFromPi).not.toHaveBeenCalled();
        expect(h.pulls).not.toHaveBeenCalled();
        localStorage.removeItem('thalassa_pi_pairing_v1');
    });

    it('still skips when the Pi is unreachable, tracer or no tracer', async () => {
        h.isAvailable.mockReturnValueOnce(false);
        await autoSyncFromPiIfPossible();
        expect(h.syncEncFromPi).not.toHaveBeenCalled();
    });
});
