import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapboxVelocityOverlay } from '../components/map/MapboxVelocityOverlay';
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
    listenerCount: (event: string) => number;
    listeners: Map<string, Set<MapHandler>>;
    map: {
        getCenter: ReturnType<typeof vi.fn>;
        getContainer: ReturnType<typeof vi.fn>;
        getZoom: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        project: ReturnType<typeof vi.fn>;
    };
}

function createMapboxHarness(): MapboxHarness {
    const container = document.createElement('div');
    container.dataset.testMapboxVelocity = 'true';
    document.body.appendChild(container);
    const listeners = new Map<string, Set<MapHandler>>();
    const map = {
        getCenter: vi.fn(() => ({ lat: -27, lng: 153 })),
        getContainer: vi.fn(() => container),
        getZoom: vi.fn(() => 5),
        off: vi.fn(),
        on: vi.fn(),
        project: vi.fn(() => ({ x: 100, y: 80 })),
    };
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
        listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
        listeners,
        map,
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
        expect(mapbox.listenerCount('zoom')).toBe(1);

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
        expect(mapbox.listenerCount('zoom')).toBe(2);
        expect(mapbox.listenerCount('zoomend')).toBe(1);
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
});
