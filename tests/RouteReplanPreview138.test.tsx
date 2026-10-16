import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { useRouteReplanPreview, clearRouteReplanReference } from '../components/map/useRouteReplanPreview';
import { replan138Fixture } from './helpers/replan138Fixture';
import { readRouteReplan, setRouteReplan } from '../services/routing/routeReplanSession';
const api = vi.hoisted(() => ({ offer: vi.fn(), current: vi.fn(() => true) }));
vi.mock('../services/routing/routeReplan', () => ({
    offerRouteReplanCandidate: api.offer,
    replanContextCurrent: api.current,
}));
const fixture = replan138Fixture();
function setup() {
    const sources = new Set<string>(),
        layers = new Set<string>();
    const map = {
        getSource: vi.fn((id: string) => (sources.has(id) ? {} : undefined)),
        getLayer: vi.fn((id: string) => (layers.has(id) ? {} : undefined)),
        addSource: vi.fn((id: string) => sources.add(id)),
        addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
        removeLayer: vi.fn((id: string) => layers.delete(id)),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        on: vi.fn(),
        off: vi.fn(),
    };
    const input = {
        mapRef: { current: map as unknown as mapboxgl.Map },
        mapReady: true,
        tokenRef: { current: fixture.base.token },
        show: true,
        verified: false,
        geometryKey: null as string | null,
        departureTime: fixture.base.departureTime,
        speed: fixture.base.speed,
        result: { current: fixture.candidate.result },
        turns: { current: fixture.candidate.turns },
        caveats: [],
        cells: { current: [] as string[] },
        invalidate: vi.fn(),
    };
    return { input, map, sources, layers };
}
beforeEach(() => {
    vi.clearAllMocks();
    api.current.mockReturnValue(true);
    setRouteReplan({ phase: 'computing', base: fixture.base, candidate: null, message: null });
});
afterEach(cleanup);
describe('same-planner final-verdict bridge and original reference ownership', () => {
    it('does not offer any candidate before the exact displayed geometry is verified', async () => {
        const { input } = setup(),
            view = renderHook((value) => useRouteReplanPreview(value), { initialProps: input });
        expect(api.offer).not.toHaveBeenCalled();
        view.rerender({ ...input, verified: true, geometryKey: fixture.candidate.geometryKey });
        await waitFor(() =>
            expect(api.offer).toHaveBeenCalledWith(
                fixture.base.token,
                expect.objectContaining({
                    geometryKey: fixture.candidate.geometryKey,
                    result: fixture.candidate.result,
                }),
            ),
        );
    });
    it('retires a ready candidate immediately when its displayed verdict or clock changes', () => {
        setRouteReplan({ phase: 'ready', base: fixture.base, candidate: fixture.candidate, message: null });
        const { input } = setup();
        renderHook(() =>
            useRouteReplanPreview({
                ...input,
                verified: true,
                geometryKey: fixture.candidate.geometryKey,
                departureTime: '2099-01-01T00:00:00Z',
            }),
        );
        expect(readRouteReplan().phase).toBe('error');
        expect(readRouteReplan().candidate).toBeNull();
    });
    it('keeps the exact original user geometry in a separately owned layer and removes it on unmount', () => {
        const { input, map } = setup(),
            view = renderHook(() => useRouteReplanPreview(input));
        expect(map.addSource).toHaveBeenCalledWith(
            'underway-replan-original',
            expect.objectContaining({
                data: expect.objectContaining({ properties: { role: 'original-followed-route' } }),
            }),
        );
        view.unmount();
        expect(map.removeLayer).toHaveBeenCalledWith('underway-replan-original-line');
        expect(map.removeSource).toHaveBeenCalledWith('underway-replan-original');
    });
    it('can synchronously remove a retained reference during the parent account-change callback', () => {
        const { input, map } = setup();
        renderHook(() => useRouteReplanPreview(input));
        act(() => clearRouteReplanReference(map as unknown as mapboxgl.Map));
        expect(map.removeLayer).toHaveBeenCalledOnce();
        expect(map.removeSource).toHaveBeenCalledOnce();
    });
});
