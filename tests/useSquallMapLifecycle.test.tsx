import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    passthroughUrl: vi.fn(() => null),
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: { passthroughUrl: mocks.passthroughUrl },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import { useSquallMap } from '../components/map/useSquallMap';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function makeMap() {
    const sources = new Set<string>();
    const layers = new Set<string>();
    const map = {
        __ausNzMinZoom: 3,
        getSource: vi.fn((id: string) => (sources.has(id) ? {} : undefined)),
        getLayer: vi.fn((id: string) => (layers.has(id) ? {} : undefined)),
        addSource: vi.fn((id: string) => sources.add(id)),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
        removeLayer: vi.fn((id: string) => layers.delete(id)),
        getStyle: vi.fn(() => ({ layers: [] })),
        getContainer: vi.fn(() => document.createElement('div')),
        getMaxZoom: vi.fn(() => 22),
        setMaxZoom: vi.fn(),
        setMinZoom: vi.fn(),
        getZoom: vi.fn(() => 3),
        flyTo: vi.fn(),
        easeTo: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
    };
    return { map, sources, layers };
}

describe('useSquallMap request lifecycle', () => {
    beforeEach(() => {
        vi.stubEnv('VITE_SUPABASE_URL', 'https://thalassa.example');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('cannot mount an in-flight Chart snapshot after Plan suppresses the layer', async () => {
        const response = deferred<Response>();
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return response.promise;
        });
        vi.stubGlobal('fetch', fetchMock);
        const { map, sources, layers } = makeMap();

        const rendered = renderHook(({ visible }) => useSquallMap({ current: map as never }, true, visible), {
            initialProps: { visible: true },
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
        rendered.rerender({ visible: false });
        expect(signal.aborted).toBe(true);

        await act(async () => {
            response.resolve({
                ok: true,
                json: async () => ({ snapshot: 12345 }),
            } as Response);
            await response.promise;
            await Promise.resolve();
        });

        expect(sources.has('squall-rainbow-source')).toBe(false);
        expect(layers.has('squall-rainbow-layer')).toBe(false);
        expect(map.addSource).not.toHaveBeenCalled();
        expect(map.addLayer).not.toHaveBeenCalled();
    });
});
