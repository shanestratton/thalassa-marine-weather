import { beforeEach, describe, expect, it, vi } from 'vitest';

const enc = vi.hoisted(() => ({
    importCell: vi.fn(),
    listCells: vi.fn(),
    getPlatform: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: enc.getPlatform,
        isNativePlatform: vi.fn().mockReturnValue(false),
        isPluginAvailable: vi.fn().mockReturnValue(false),
    },
}));
vi.mock('../services/enc/EncHazardService', () => ({ importCell: enc.importCell }));
vi.mock('../services/enc/EncCellMetadata', () => ({ listCells: enc.listCells }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

const flagKey = 'thalassa.enc.samplesImported.v7';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    enc.getPlatform.mockReturnValue('web');
    enc.listCells.mockReturnValue([]);
    enc.importCell.mockResolvedValue(undefined);
});

async function bootstrap() {
    return import('../services/enc/bootstrapEncSamples');
}

describe('bootstrapEncSamplesIfNeeded', () => {
    it('skips all storage and network work after a completed bootstrap', async () => {
        localStorage.setItem(flagKey, '1');
        vi.stubGlobal('fetch', vi.fn());
        const { bootstrapEncSamplesIfNeeded } = await bootstrap();

        await bootstrapEncSamplesIfNeeded();

        expect(fetch).not.toHaveBeenCalled();
        expect(enc.listCells).not.toHaveBeenCalled();
        expect(enc.importCell).not.toHaveBeenCalled();
    });

    it('is single-flight and latches only after importing a valid bundled cell', async () => {
        const blob = {
            cellId: 'US5GA22M',
            sourceHO: 'NOAA',
            edition: 7,
            layers: { DEPARE: { type: 'FeatureCollection', features: [] } },
        };
        let release!: (response: { ok: boolean; status: number; text: () => Promise<string> }) => void;
        vi.stubGlobal(
            'fetch',
            vi.fn(
                () =>
                    new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((resolve) => {
                        release = resolve;
                    }),
            ),
        );
        const { bootstrapEncSamplesIfNeeded } = await bootstrap();

        const first = bootstrapEncSamplesIfNeeded();
        const second = bootstrapEncSamplesIfNeeded();
        expect(first).toBe(second);
        release({ ok: true, status: 200, text: async () => JSON.stringify(blob) });
        await first;

        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith('/enc-samples/US5GA22M.geojson');
        expect(enc.importCell).toHaveBeenCalledWith(blob);
        expect(localStorage.getItem(flagKey)).toBe('1');
    });

    it.each([
        {
            name: 'missing bundle',
            response: { ok: false, status: 404, text: async () => '' },
        },
        {
            name: 'invalid JSON',
            response: { ok: true, status: 200, text: async () => '{bad json' },
        },
        {
            name: 'malformed cell',
            response: { ok: true, status: 200, text: async () => JSON.stringify({ cellId: 'US5GA22M' }) },
        },
    ])('leaves the retry flag clear for a $name', async ({ response }) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        const { bootstrapEncSamplesIfNeeded } = await bootstrap();

        await expect(bootstrapEncSamplesIfNeeded()).resolves.toBeUndefined();

        expect(enc.importCell).not.toHaveBeenCalled();
        expect(localStorage.getItem(flagKey)).toBeNull();
    });

    it('contains fetch and import failures so startup can continue and retry later', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('bundle unavailable')));
        const { bootstrapEncSamplesIfNeeded } = await bootstrap();

        await expect(bootstrapEncSamplesIfNeeded()).resolves.toBeUndefined();
        expect(localStorage.getItem(flagKey)).toBeNull();

        vi.resetModules();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                text: async () =>
                    JSON.stringify({
                        cellId: 'US5GA22M',
                        sourceHO: 'NOAA',
                        edition: 7,
                        layers: { DEPARE: {} },
                    }),
            }),
        );
        enc.importCell.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
        const fresh = await bootstrap();
        await expect(fresh.bootstrapEncSamplesIfNeeded()).resolves.toBeUndefined();
        expect(localStorage.getItem(flagKey)).toBeNull();
    });
});
