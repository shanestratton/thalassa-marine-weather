import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ensureWindHeatmapLayerOrder,
    getWindHeatmapBeforeLayerId,
    guardVelocityLayerStartup,
    MapboxVelocityOverlay,
} from '../components/map/MapboxVelocityOverlay';
import type { VelocityGribRecord } from '../components/map/windVelocityFrame';
import type { WindGrid } from '../services/weather/windGridEncoding';

type MapHandler = () => void;

interface MockVelocityLayer {
    _windy: {
        setData: ReturnType<typeof vi.fn>;
    };
    addTo: ReturnType<typeof vi.fn>;
}

interface MockLeafletMap {
    __layers: Set<MockVelocityLayer>;
    getPane: ReturnType<typeof vi.fn>;
    hasLayer: ReturnType<typeof vi.fn>;
    invalidateSize: ReturnType<typeof vi.fn>;
    latLngToContainerPoint: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    removeLayer: ReturnType<typeof vi.fn>;
    setView: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
    let releasePlugin!: () => void;
    const pluginGate = new Promise<void>((resolve) => {
        releasePlugin = resolve;
    });
    const leafletMaps: MockLeafletMap[] = [];
    const velocityLayers: MockVelocityLayer[] = [];

    const velocityLayer = vi.fn((_: { data: VelocityGribRecord[] }) => {
        const layer: MockVelocityLayer = {
            _windy: { setData: vi.fn() },
            addTo: vi.fn(),
        };
        layer.addTo.mockImplementation((map: MockLeafletMap) => {
            map.__layers.add(layer);
            return layer;
        });
        velocityLayers.push(layer);
        return layer;
    });

    const map = vi.fn(() => {
        const panes = {
            tilePane: { style: {} },
            mapPane: { style: {} },
        };
        const leafletMap: MockLeafletMap = {
            __layers: new Set(),
            getPane: vi.fn((name: keyof typeof panes) => panes[name] ?? null),
            hasLayer: vi.fn(),
            invalidateSize: vi.fn(),
            latLngToContainerPoint: vi.fn(() => ({ x: 100, y: 80 })),
            remove: vi.fn(),
            removeLayer: vi.fn(),
            setView: vi.fn(),
        };
        leafletMap.hasLayer.mockImplementation((layer: MockVelocityLayer) => leafletMap.__layers.has(layer));
        leafletMap.removeLayer.mockImplementation((layer: MockVelocityLayer) => {
            leafletMap.__layers.delete(layer);
            return leafletMap;
        });
        leafletMap.remove.mockImplementation(() => {
            leafletMap.__layers.clear();
        });
        leafletMap.setView.mockReturnValue(leafletMap);
        leafletMaps.push(leafletMap);
        return leafletMap;
    });

    return {
        leaflet: {
            map,
            velocityLayer,
        },
        leafletMaps,
        logger: {
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        },
        pluginGate,
        releasePlugin,
        velocityLayers,
    };
});

vi.mock('leaflet', () => ({
    default: mocks.leaflet,
}));

vi.mock('leaflet-velocity-ts', async () => {
    await mocks.pluginGate;
    return {};
});

vi.mock('../utils/createLogger', () => ({
    createLogger: () => mocks.logger,
}));

interface MapboxHarness {
    container: HTMLDivElement;
    emit: (event: string) => void;
    layers: Map<string, unknown>;
    listenerCount: (event: string) => number;
    listeners: Map<string, Set<MapHandler>>;
    sources: Map<string, { options: unknown; updateImage: ReturnType<typeof vi.fn> }>;
    map: {
        addLayer: ReturnType<typeof vi.fn>;
        addSource: ReturnType<typeof vi.fn>;
        getCenter: ReturnType<typeof vi.fn>;
        getContainer: ReturnType<typeof vi.fn>;
        getLayer: ReturnType<typeof vi.fn>;
        getSource: ReturnType<typeof vi.fn>;
        getStyle: ReturnType<typeof vi.fn>;
        getZoom: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        project: ReturnType<typeof vi.fn>;
        removeLayer: ReturnType<typeof vi.fn>;
        removeSource: ReturnType<typeof vi.fn>;
    };
}

function createMapboxHarness(zoom = 5): MapboxHarness {
    const container = document.createElement('div');
    container.dataset.testMapboxVelocity = 'true';
    document.body.appendChild(container);
    const listeners = new Map<string, Set<MapHandler>>();
    const sources = new Map<string, { options: unknown; updateImage: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, unknown>();
    const map = {
        addLayer: vi.fn(),
        addSource: vi.fn(),
        getCenter: vi.fn(() => ({ lat: -27, lng: 153 })),
        getContainer: vi.fn(() => container),
        getLayer: vi.fn(),
        getSource: vi.fn(),
        getStyle: vi.fn(() => ({ layers: [{ id: 'place-label', type: 'symbol' }] })),
        getZoom: vi.fn(() => zoom),
        off: vi.fn(),
        on: vi.fn(),
        project: vi.fn(() => ({ x: 100, y: 80 })),
        removeLayer: vi.fn(),
        removeSource: vi.fn(),
    };
    map.addSource.mockImplementation((id: string, options: unknown) => {
        sources.set(id, { options, updateImage: vi.fn() });
        return map;
    });
    map.getSource.mockImplementation((id: string) => sources.get(id));
    map.addLayer.mockImplementation((layer: { id: string }) => {
        layers.set(layer.id, layer);
        return map;
    });
    map.getLayer.mockImplementation((id: string) => layers.get(id));
    map.removeLayer.mockImplementation((id: string) => {
        layers.delete(id);
        return map;
    });
    map.removeSource.mockImplementation((id: string) => {
        sources.delete(id);
        return map;
    });
    map.on.mockImplementation((event: string, handler: MapHandler) => {
        const handlers = listeners.get(event) ?? new Set<MapHandler>();
        handlers.add(handler);
        listeners.set(event, handlers);
        return map;
    });
    map.off.mockImplementation((event: string, handler: MapHandler) => {
        const handlers = listeners.get(event);
        handlers?.delete(handler);
        if (handlers?.size === 0) listeners.delete(event);
        return map;
    });

    return {
        container,
        emit: (event: string) => {
            for (const handler of [...(listeners.get(event) ?? [])]) handler();
        },
        layers,
        listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
        listeners,
        map,
        sources,
    };
}

function windGrid(value: number, refTime: string): WindGrid {
    return {
        u: [new Float32Array([value]), new Float32Array([value + 1])],
        v: [new Float32Array([-value]), new Float32Array([-(value + 1)])],
        speed: [new Float32Array([value]), new Float32Array([value + 1])],
        width: 1,
        height: 1,
        lats: [-27],
        lons: [153],
        north: -27,
        south: -27,
        west: 153,
        east: 153,
        totalHours: 2,
        refTime,
    };
}

function invalidGrid(): WindGrid {
    return {
        ...windGrid(99, 'invalid'),
        u: [],
        v: [],
        speed: [],
        totalHours: 0,
    };
}

function heatmapGrid(): WindGrid {
    return {
        u: [new Float32Array([2, 4, 6, 8]), new Float32Array([4, 6, 8, 10])],
        v: [new Float32Array([1, 3, 5, 7]), new Float32Array([3, 5, 7, 9])],
        speed: [new Float32Array([2, 4, 6, 8]), new Float32Array([4, 6, 8, 10])],
        width: 2,
        height: 2,
        lats: [-28, -26],
        lons: [152, 154],
        north: -26,
        south: -28,
        west: 152,
        east: 154,
        totalHours: 2,
        refTime: 'heatmap',
    };
}

function velocityDataFromCreateCall(index: number): VelocityGribRecord[] {
    const options = mocks.leaflet.velocityLayer.mock.calls[index]?.[0] as { data: VelocityGribRecord[] } | undefined;
    if (!options) throw new Error(`Missing velocityLayer create call ${index}`);
    return options.data;
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.querySelectorAll('[data-test-mapbox-velocity="true"]').forEach((element) => element.remove());
});

describe('MapboxVelocityOverlay React lifecycle', () => {
    it('keeps the z3 static field above the opaque hybrid base after MapHub reorders imagery', () => {
        const ids = ['water', 'place-label', 'wind-heatmap-layer', 'hybrid-base-layer', 'enc-vec-depth'];
        const moveLayer = vi.fn((id: string, beforeId?: string) => {
            const current = ids.indexOf(id);
            if (current >= 0) ids.splice(current, 1);
            const before = beforeId ? ids.indexOf(beforeId) : -1;
            ids.splice(before >= 0 ? before : ids.length, 0, id);
        });
        const map = {
            getLayer: (id: string) => (ids.includes(id) ? { id } : undefined),
            getLayoutProperty: (id: string, property: string) =>
                id === 'hybrid-base-layer' && property === 'visibility' ? 'visible' : undefined,
            getStyle: () => ({
                layers: ids.map((id) => ({
                    id,
                    type: id === 'place-label' ? 'symbol' : id === 'hybrid-base-layer' ? 'raster' : 'fill',
                })),
            }),
            moveLayer,
        };

        // First-symbol anchoring would have returned place-label, which is
        // underneath the Hybrid raster in this real MapHub ordering.
        expect(getWindHeatmapBeforeLayerId(map as never)).toBe('enc-vec-depth');
        ensureWindHeatmapLayerOrder(map as never);
        expect(ids).toEqual(['water', 'place-label', 'hybrid-base-layer', 'wind-heatmap-layer', 'enc-vec-depth']);
        expect(moveLayer).toHaveBeenCalledWith('wind-heatmap-layer', 'enc-vec-depth');

        // The guarded reassertion is quiet once the ordering is correct, so
        // MapHub's styledata healer cannot be turned into a feedback loop.
        ensureWindHeatmapLayerOrder(map as never);
        expect(moveLayer).toHaveBeenCalledTimes(1);
    });

    it('does not let the velocity plugin stop before its delayed animation bucket exists', () => {
        const bucket = { clear: vi.fn() };
        const originalStop = vi.fn(() => {
            // This reproduces the third-party failure from the device:
            // `this.animationBucket.clear()` before its delayed start.
            windy.animationBucket!.clear();
        });
        const windy: {
            animationBucket?: typeof bucket;
            stop: () => void;
        } = { stop: originalStop };
        const layer = {
            _windy: undefined as typeof windy | undefined,
            onDrawLayer: vi.fn(() => {
                layer._windy = windy;
            }),
        };

        guardVelocityLayerStartup(layer as never);
        layer.onDrawLayer();

        expect(() => windy.stop()).not.toThrow();
        expect(originalStop).not.toHaveBeenCalled();

        windy.animationBucket = bucket;
        windy.stop();
        expect(originalStop).toHaveBeenCalledOnce();
        expect(bucket.clear).toHaveBeenCalledOnce();
    });

    it('keeps the selected grid and Mapbox listeners correct across both arrival orders, clears, and remounts', async () => {
        const mapbox = createMapboxHarness();
        const firstModel = windGrid(11, 'ecmwf');
        const selectedModel = windGrid(22, 'icon');
        const recoveredModel = windGrid(33, 'gfs');
        const afterPluginModel = windGrid(44, 'arpege');

        const view = render(
            <MapboxVelocityOverlay mapboxMap={mapbox.map as never} visible windGrid={firstModel} windHour={0} />,
        );

        // Grid-before-plugin: the React grid effect has run, but no Leaflet
        // map/layer can exist until the deliberately deferred plugin resolves.
        expect(mocks.leaflet.map).not.toHaveBeenCalled();
        expect(mocks.leaflet.velocityLayer).not.toHaveBeenCalled();
        expect(mapbox.listenerCount('zoom')).toBe(0);
        expect(mapbox.listenerCount('zoomend')).toBe(1);

        await act(async () => {
            mocks.releasePlugin();
            await mocks.pluginGate;
            await Promise.resolve();
        });

        await waitFor(() => expect(mocks.leaflet.map).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(mocks.leaflet.velocityLayer).toHaveBeenCalledTimes(1));
        expect(velocityDataFromCreateCall(0)[0].data).toEqual([11]);
        expect(velocityDataFromCreateCall(0)[1].data).toEqual([-11]);

        const firstLeafletMap = mocks.leafletMaps[0];
        const firstLayer = mocks.velocityLayers[0];
        expect(firstLayer.addTo).toHaveBeenCalledWith(firstLeafletMap);

        // A selected-model change updates the existing layer instead of
        // leaving the previous model on screen or creating a duplicate layer.
        view.rerender(
            <MapboxVelocityOverlay mapboxMap={mapbox.map as never} visible windGrid={selectedModel} windHour={0} />,
        );
        await waitFor(() => expect(firstLayer._windy.setData).toHaveBeenCalledOnce());
        const selectedData = firstLayer._windy.setData.mock.calls[0]?.[0] as VelocityGribRecord[];
        expect(selectedData[0].data).toEqual([22]);
        expect(selectedData[1].data).toEqual([-22]);
        expect(mocks.leaflet.velocityLayer).toHaveBeenCalledTimes(1);

        // A plugin update failure must clear the previous model rather than
        // leaving it painted under the newly-selected model label.
        firstLayer._windy.setData.mockImplementationOnce(() => {
            throw new Error('renderer update failed');
        });
        view.rerender(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                windGrid={windGrid(23, 'failed-update')}
                windHour={0}
            />,
        );
        await waitFor(() => expect(firstLeafletMap.removeLayer).toHaveBeenCalledWith(firstLayer));
        expect((mapbox.container.firstElementChild as HTMLElement | null)?.style.opacity).toBe('0');
        expect(mocks.logger.error).toHaveBeenCalledOnce();

        // WindStore null is passed through MapHub as undefined. It must remove
        // the selected model immediately and hide the particle container.
        view.rerender(
            <MapboxVelocityOverlay mapboxMap={mapbox.map as never} visible windGrid={undefined} windHour={0} />,
        );
        await waitFor(() => expect(firstLeafletMap.removeLayer).toHaveBeenCalledWith(firstLayer));
        expect((mapbox.container.firstElementChild as HTMLElement | null)?.style.opacity).toBe('0');

        // A valid grid can recover after the clear.
        view.rerender(
            <MapboxVelocityOverlay mapboxMap={mapbox.map as never} visible windGrid={recoveredModel} windHour={0} />,
        );
        await waitFor(() => expect(mocks.leaflet.velocityLayer).toHaveBeenCalledTimes(2));
        const recoveredLayer = mocks.velocityLayers[1];
        expect(velocityDataFromCreateCall(1)[0].data).toEqual([33]);

        // The overlay has no error prop; its error boundary is a grid that
        // cannot be converted. Exercise that distinct non-null path as well
        // as WindStore-null/undefined.
        view.rerender(
            <MapboxVelocityOverlay mapboxMap={mapbox.map as never} visible windGrid={invalidGrid()} windHour={0} />,
        );
        await waitFor(() => expect(firstLeafletMap.removeLayer).toHaveBeenCalledWith(recoveredLayer));
        expect((mapbox.container.firstElementChild as HTMLElement | null)?.style.opacity).toBe('0');

        expect(mapbox.listenerCount('move')).toBe(1);
        expect(mapbox.listenerCount('moveend')).toBe(2);
        expect(mapbox.listenerCount('zoom')).toBe(1);
        expect(mapbox.listenerCount('zoomend')).toBe(2);
        expect(mapbox.listenerCount('resize')).toBe(1);
        const firstMountHandlers = new Set([...mapbox.listeners.values()].flatMap((handlers) => [...handlers]));

        // Schedule the old mount's deferred snap, then tear the effect down by
        // toggling visibility. Advancing time must not call into its old map.
        vi.useFakeTimers();
        act(() => mapbox.emit('moveend'));
        const firstSetViewCount = firstLeafletMap.setView.mock.calls.length;
        view.rerender(
            <MapboxVelocityOverlay mapboxMap={mapbox.map as never} visible={false} windGrid={undefined} windHour={0} />,
        );
        expect(mapbox.listeners.size).toBe(0);
        expect(firstLeafletMap.remove).toHaveBeenCalledOnce();
        expect(mapbox.container.children).toHaveLength(0);
        act(() => vi.advanceTimersByTime(301));
        expect(firstLeafletMap.setView).toHaveBeenCalledTimes(firstSetViewCount);
        vi.useRealTimers();

        // Plugin-before-grid: remount the overlay after the plugin is cached,
        // establish Leaflet with no data, then deliver the grid reactively.
        view.rerender(
            <MapboxVelocityOverlay mapboxMap={mapbox.map as never} visible windGrid={undefined} windHour={0} />,
        );
        await waitFor(() => expect(mocks.leaflet.map).toHaveBeenCalledTimes(2));
        expect(mocks.leaflet.velocityLayer).toHaveBeenCalledTimes(2);
        for (const handlers of mapbox.listeners.values()) {
            for (const handler of handlers) expect(firstMountHandlers.has(handler)).toBe(false);
        }

        view.rerender(
            <MapboxVelocityOverlay mapboxMap={mapbox.map as never} visible windGrid={afterPluginModel} windHour={0} />,
        );
        await waitFor(() => expect(mocks.leaflet.velocityLayer).toHaveBeenCalledTimes(3));
        expect(velocityDataFromCreateCall(2)[0].data).toEqual([44]);
        expect(velocityDataFromCreateCall(2)[1].data).toEqual([-44]);

        const secondLeafletMap = mocks.leafletMaps[1];
        view.unmount();
        expect(mapbox.listeners.size).toBe(0);
        expect(secondLeafletMap.remove).toHaveBeenCalledOnce();
        expect(mapbox.container.children).toHaveLength(0);
        expect(mocks.logger.error).toHaveBeenCalledOnce();
    });

    it('keeps the particle engine fully unmounted until animation is enabled', async () => {
        const mapbox = createMapboxHarness();
        const mapCallsBefore = mocks.leaflet.map.mock.calls.length;
        const view = render(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                particlesEnabled={false}
                windGrid={windGrid(18, 'icon')}
                windHour={0}
            />,
        );

        expect(mocks.leaflet.map).toHaveBeenCalledTimes(mapCallsBefore);
        // The static field renderer owns one style-load listener and one
        // coalesced ordering listener. No Leaflet/particle listeners or
        // overlay DOM are mounted while motion is disabled.
        expect(mapbox.listenerCount('style.load')).toBe(1);
        expect(mapbox.listenerCount('styledata')).toBe(1);
        expect(mapbox.listeners.size).toBe(2);
        expect(mapbox.container.children).toHaveLength(0);

        view.rerender(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                particlesEnabled
                windGrid={windGrid(18, 'icon')}
                windHour={0}
            />,
        );

        await waitFor(() => expect(mocks.leaflet.map).toHaveBeenCalledTimes(mapCallsBefore + 1));
        const leafletMap = mocks.leafletMaps[mapCallsBefore];
        expect(mapbox.listeners.size).toBeGreaterThan(0);

        view.rerender(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                particlesEnabled={false}
                windGrid={windGrid(18, 'icon')}
                windHour={0}
            />,
        );

        await waitFor(() => expect(leafletMap.remove).toHaveBeenCalledOnce());
        expect(mapbox.listenerCount('style.load')).toBe(1);
        expect(mapbox.listenerCount('styledata')).toBe(1);
        expect(mapbox.listeners.size).toBe(2);
        expect(mapbox.container.children).toHaveLength(0);

        view.unmount();
        expect(mapbox.listeners.size).toBe(0);
    });

    it('keeps the static wind field behind directional flow at z3', async () => {
        const canvasContext = () =>
            ({
                createImageData: (width: number, height: number) => ({
                    data: new Uint8ClampedArray(width * height * 4),
                }),
                drawImage: vi.fn(),
                imageSmoothingEnabled: false,
                imageSmoothingQuality: 'low',
                putImageData: vi.fn(),
                scale: vi.fn(),
                translate: vi.fn(),
            }) as unknown as CanvasRenderingContext2D;
        const getContext = vi
            .spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockImplementation(() => canvasContext());
        const toDataUrl = vi
            .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
            .mockReturnValue('data:image/png;base64,wind-field');

        try {
            const mapbox = createMapboxHarness(3);
            const mapCallsBefore = mocks.leaflet.map.mock.calls.length;
            const velocityCallsBefore = mocks.leaflet.velocityLayer.mock.calls.length;
            const view = render(
                <MapboxVelocityOverlay
                    mapboxMap={mapbox.map as never}
                    visible
                    particlesEnabled
                    windGrid={heatmapGrid()}
                    windHour={0}
                />,
            );

            await waitFor(() => expect(mapbox.sources.get('wind-heatmap-src')).toBeDefined());
            expect(mapbox.layers.get('wind-heatmap-layer')).toMatchObject({
                id: 'wind-heatmap-layer',
                type: 'raster',
            });
            expect(mapbox.map.addLayer).toHaveBeenCalledWith(expect.any(Object), 'place-label');
            await waitFor(() => expect(mocks.leaflet.map).toHaveBeenCalledTimes(mapCallsBefore + 1));
            await waitFor(() => expect(mocks.leaflet.velocityLayer).toHaveBeenCalledTimes(velocityCallsBefore + 1));

            const source = mapbox.sources.get('wind-heatmap-src');
            if (!source) throw new Error('Expected the static wind source');
            const sourceAdds = mapbox.map.addSource.mock.calls.length;
            view.rerender(
                <MapboxVelocityOverlay
                    mapboxMap={mapbox.map as never}
                    visible
                    particlesEnabled
                    windGrid={heatmapGrid()}
                    windHour={1}
                />,
            );

            await waitFor(() => expect(source.updateImage).toHaveBeenCalledOnce());
            expect(mapbox.map.addSource).toHaveBeenCalledTimes(sourceAdds);

            // A base-style change deletes custom sources/layers without
            // changing the forecast grid. The z3 heatmap remains the stable
            // speed read beneath the directional particle flow, so it must
            // return on style.load rather than waiting for a later pan or
            // scrubber update.
            expect(mapbox.listenerCount('style.load')).toBe(1);
            mapbox.layers.clear();
            mapbox.sources.clear();
            act(() => mapbox.emit('style.load'));
            await waitFor(() => expect(mapbox.sources.get('wind-heatmap-src')).toBeDefined());
            expect(mapbox.map.addSource).toHaveBeenCalledTimes(sourceAdds + 1);
            expect(mocks.leaflet.map).toHaveBeenCalledTimes(mapCallsBefore + 1);

            view.unmount();
            expect(mapbox.sources.size).toBe(0);
            expect(mapbox.layers.size).toBe(0);
            expect(mapbox.listenerCount('style.load')).toBe(0);
        } finally {
            getContext.mockRestore();
            toDataUrl.mockRestore();
        }
    });
});
