import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTideStationLayer } from '../components/map/useTideStationLayer';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function makeMap() {
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const sourceHistory: Array<{ setData: ReturnType<typeof vi.fn> }> = [];
    const layers = new Set<string>();
    const map = {
        addSource: vi.fn((id: string) => {
            const source = { setData: vi.fn() };
            sources.set(id, source);
            sourceHistory.push(source);
        }),
        getSource: vi.fn((id: string) => sources.get(id)),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
        getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
        removeLayer: vi.fn((id: string) => layers.delete(id)),
        getZoom: vi.fn(() => 8),
        getCenter: vi.fn(() => ({ lat: -27.4698, lng: 153.0251 })),
        on: vi.fn(),
        off: vi.fn(),
        queryRenderedFeatures: vi.fn(() => []),
    };
    return { map, sources, sourceHistory };
}

describe('useTideStationLayer Plan lifecycle', () => {
    beforeEach(() => {
        vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                const body = JSON.stringify({
                    stations: [
                        {
                            id: 'brisbane-bar',
                            name: 'Brisbane Bar',
                            lat: -27.35,
                            lon: 153.17,
                            distance: 20,
                        },
                    ],
                });
                return new Response(body, {
                    status: 200,
                    headers: { 'content-length': String(body.length) },
                });
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('re-seeds the recreated Chart source after Plan suppression at the same viewport', async () => {
        const { map, sources, sourceHistory } = makeMap();
        const mapRef = { current: map as never };
        const rendered = renderHook(({ visible }) => useTideStationLayer(mapRef, true, visible), {
            initialProps: { visible: true },
        });

        await waitFor(() => expect(sourceHistory[0]?.setData).toHaveBeenCalled());
        const populated = sourceHistory[0].setData.mock.calls.at(-1)?.[0];

        rendered.rerender({ visible: false });
        expect(sources.has('tide-stations')).toBe(false);

        rendered.rerender({ visible: true });
        expect(sourceHistory).toHaveLength(2);
        expect(sourceHistory[1].setData).toHaveBeenCalledWith(populated);
    });
});
