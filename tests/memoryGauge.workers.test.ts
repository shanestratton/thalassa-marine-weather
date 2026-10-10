/**
 * An iOS memory warning sheds the route worker's grids too (127-ROUTE-W
 * decision 12). Routes now build their grids in the route worker, so the
 * main thread's navGridCache is empty while up to 48 MB of route grids sit in
 * the worker: the warning that trims the main cache must reach the worker as
 * well. The host's half (trim a busy worker, end an idle one) is in
 * tests/routeWorkerHost.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    warning: null as null | (() => void),
    trimNavGridCache: vi.fn(),
    clearIndexCache: vi.fn(),
    trimRouteWorkers: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true },
    registerPlugin: () => ({
        read: async () => ({ availableMB: 900 }),
        addListener: async (_event: string, listener: () => void) => {
            m.warning = listener;
            return { remove: async () => {} };
        },
    }),
}));
vi.mock('../services/engine/navGrid', () => ({ trimNavGridCache: m.trimNavGridCache }));
vi.mock('../services/enc/encIndexCache', () => ({ clearIndexCache: m.clearIndexCache }));
vi.mock('../services/routing/routeWorkerHost', () => ({ trimRouteWorkers: m.trimRouteWorkers }));

import { __resetMemoryGaugeForTest, refreshAvailableMemory } from '../services/native/memoryGauge';

describe('a memory warning', () => {
    it("trims the main thread's grids, the hazard indexes and the route worker's grids", async () => {
        __resetMemoryGaugeForTest();
        await refreshAvailableMemory();
        expect(m.warning).toBeTypeOf('function');
        m.warning!();
        await vi.waitFor(() => expect(m.trimRouteWorkers).toHaveBeenCalledTimes(1));
        expect(m.trimNavGridCache).toHaveBeenCalledWith(0);
        expect(m.clearIndexCache).toHaveBeenCalledTimes(1);
    });
});
