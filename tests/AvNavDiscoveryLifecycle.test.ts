import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    scanNetwork: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => false,
    },
}));

vi.mock('../services/AvNavService', () => ({
    AvNavService: {
        scanNetwork: mocks.scanNetwork,
    },
}));

import { AvNavDiscoveryService } from '../services/AvNavDiscoveryService';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('AvNav discovery lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        AvNavDiscoveryService.stop();
    });

    it('does not let a cancelled scan complete a newer scan', async () => {
        const first = deferred();
        const second = deferred();
        mocks.scanNetwork.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

        const firstScan = AvNavDiscoveryService.scan();
        await vi.waitFor(() => expect(mocks.scanNetwork).toHaveBeenCalledTimes(1));

        AvNavDiscoveryService.stop();
        const secondScan = AvNavDiscoveryService.scan();
        await vi.waitFor(() => expect(mocks.scanNetwork).toHaveBeenCalledTimes(2));

        first.resolve();
        await firstScan;
        expect(AvNavDiscoveryService.getStatus()).toBe('scanning');

        second.resolve();
        await secondScan;
        expect(AvNavDiscoveryService.getStatus()).toBe('done');
    });
});
