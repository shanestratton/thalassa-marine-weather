/**
 * UX scorecard run 8, ownship-label: at a marina the own-ship dot and its
 * 'Stopped' chip sat on the town's place label ("Gla◯to Stopped"). The marker
 * is DOM, which Mapbox's label placement cannot see, so the hook keeps an
 * invisible symbol under it that takes the footprint in the collision index.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('mapbox-gl', () => ({ default: { Marker: class {} }, Marker: class {} }));
vi.mock('../services/GpsService', () => ({ GpsService: { watchPosition: vi.fn(), getCurrentPosition: vi.fn() } }));
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: { getLastPosition: vi.fn(() => null) } }));

import { raiseOwnshipObstacle, syncOwnshipObstacle } from '../components/map/useVesselTracker';

type Layer = { id: string; type: string; layout: Record<string, unknown> };

function fakeMap() {
    const images = new Map<string, { width: number; height: number; data: Uint8Array }>();
    const sources = new Map<string, { data: unknown; setData: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, Layer>();
    const map = {
        hasImage: (id: string) => images.has(id),
        addImage: vi.fn((id: string, image: { width: number; height: number; data: Uint8Array }) => {
            images.set(id, image);
        }),
        getSource: (id: string) => sources.get(id),
        addSource: vi.fn((id: string, spec: { data: unknown }) => {
            sources.set(id, { data: spec.data, setData: vi.fn() });
        }),
        getLayer: (id: string) => layers.get(id),
        addLayer: vi.fn((layer: Layer) => {
            layers.set(layer.id, layer);
        }),
        removeLayer: vi.fn((id: string) => {
            layers.delete(id);
        }),
        removeSource: vi.fn((id: string) => {
            sources.delete(id);
        }),
    };
    return { map, images, sources, layers };
}

describe('own-ship label obstacle', () => {
    it('places an invisible, always-placed symbol that blocks labels under the dot and its chip', () => {
        const { map, images, layers } = fakeMap();
        syncOwnshipObstacle(map as never, [151.26, -23.84]);

        const [image] = [...images.values()];
        expect(image.width).toBeGreaterThan(image.height);
        // Fully transparent: nothing is drawn.
        expect(image.data.every((byte) => byte === 0)).toBe(true);

        const [layer] = [...layers.values()];
        expect(layer.type).toBe('symbol');
        expect(layer.layout['icon-allow-overlap']).toBe(true);
        expect(layer.layout['icon-ignore-placement']).toBe(false);
        // The chip is to the right of the dot, so the box is too.
        expect(layer.layout['icon-anchor']).toBe('left');
    });

    it('moves with the fix, and leaves with the marker', () => {
        const { map, sources, layers } = fakeMap();
        syncOwnshipObstacle(map as never, [151.26, -23.84]);
        const [source] = [...sources.values()];
        syncOwnshipObstacle(map as never, [151.27, -23.85]);
        expect(source.setData).toHaveBeenCalledTimes(1);
        expect(map.addLayer).toHaveBeenCalledTimes(1);

        // The staleness tick only restores a wiped layer; it does not churn.
        syncOwnshipObstacle(map as never, [151.27, -23.85], true);
        expect(source.setData).toHaveBeenCalledTimes(1);

        syncOwnshipObstacle(map as never, null);
        expect(layers.size).toBe(0);
        expect(sources.size).toBe(0);
    });

    it('does nothing on a map without an image registry', () => {
        const { map } = fakeMap();
        const bare = { ...map, addImage: undefined };
        expect(() => syncOwnshipObstacle(bare as never, [151.26, -23.84])).not.toThrow();
        expect(map.addLayer).not.toHaveBeenCalled();
    });

    it('sits above the base style labels MapHub lifts over the imagery (UX scorecard run 9)', () => {
        // Placement runs top layer first: a town label lifted to the top of
        // the stack was placed before the obstacle and drew through the dot.
        const order = [
            { id: 'satellite-base-layer', type: 'raster', source: 'satellite' },
            { id: 'vessel-ownship-obstacle-symbol', type: 'symbol', source: 'vessel-ownship-obstacle' },
            { id: 'ais-names', type: 'symbol', source: 'ais' },
            { id: 'settlement-major-label', type: 'symbol', source: 'composite' },
            { id: 'settlement-minor-label', type: 'symbol', source: 'composite' },
            { id: 'route-labels', type: 'symbol', source: 'route' },
        ];
        const moveLayer = vi.fn((id: string, before?: string) => {
            const [layer] = order.splice(
                order.findIndex((l) => l.id === id),
                1,
            );
            order.splice(before ? order.findIndex((l) => l.id === before) : order.length, 0, layer);
        });
        const map = {
            getLayer: (id: string) => order.find((l) => l.id === id),
            getStyle: () => ({ layers: order.map((l) => ({ ...l })) }),
            moveLayer,
        };
        raiseOwnshipObstacle(map as never);
        expect(moveLayer).toHaveBeenCalledWith('vessel-ownship-obstacle-symbol', 'route-labels');
        expect(order.map((l) => l.id)).toEqual([
            'satellite-base-layer',
            'ais-names',
            'settlement-major-label',
            'settlement-minor-label',
            'vessel-ownship-obstacle-symbol',
            'route-labels',
        ]);
        // Already above every base label: no move, so no styledata loop.
        raiseOwnshipObstacle(map as never);
        expect(moveLayer).toHaveBeenCalledTimes(1);
    });
});
