import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const markerHarness = vi.hoisted(() => {
    const instances: FakeMarker[] = [];

    class FakeMarker {
        map: unknown = null;
        removed = false;
        lngLat: [number, number] | null = null;

        constructor() {
            instances.push(this);
        }

        setLngLat(value: [number, number]) {
            this.lngLat = value;
            return this;
        }

        addTo(map: unknown) {
            this.map = map;
            return this;
        }

        remove() {
            this.removed = true;
            return this;
        }
    }

    return { FakeMarker, instances };
});

vi.mock('mapbox-gl', () => ({ default: { Marker: markerHarness.FakeMarker } }));
vi.mock('../stores/WindStore', () => ({ WindStore: { getState: () => ({ grid: null }) } }));
vi.mock('../services/authIdentityScope', () => ({
    isAuthIdentityScopeCurrent: () => true,
    subscribeAuthIdentityScope: () => vi.fn(),
}));

import { useConsensusMatrix } from '../components/map/useConsensusMatrix';
import { useMapFitRequest } from '../components/map/useMapFitRequest';
import { usePinViewMode } from '../components/map/usePinViewMode';
import { consumeMapFit, requestMapFit } from '../stores/MapFitTargetStore';

type ReplaceableMapRef = { current: unknown };
type MapRefProps = { mapRef: ReplaceableMapRef };

describe('map hook dependency safety', () => {
    beforeEach(() => {
        markerHarness.instances.length = 0;
        consumeMapFit();
        delete window.__thalassaPinView;
    });

    afterEach(() => {
        consumeMapFit();
        delete window.__thalassaPinView;
    });

    it('uses the current map ref when creating a consensus playhead', () => {
        const passage = {
            isoResultRef: { current: null },
            routeAnalysis: null,
            departureTime: null,
        };
        const initialProps: MapRefProps = { mapRef: { current: null } };
        const rendered = renderHook(
            ({ mapRef }: MapRefProps) =>
                useConsensusMatrix({ mapRef: mapRef as never, passage: passage as never, setIsoProgress: vi.fn() }),
            { initialProps },
        );
        const currentMap = {};
        const currentProps: MapRefProps = { mapRef: { current: currentMap } };

        rendered.rerender(currentProps);
        act(() => rendered.result.current.handleScrubPosition(-27.47, 153.03));

        expect(markerHarness.instances).toHaveLength(1);
        expect(markerHarness.instances[0].map).toBe(currentMap);
        expect(markerHarness.instances[0].lngLat).toEqual([153.03, -27.47]);
    });

    it('re-subscribes fit requests to a replacement map ref', () => {
        const initialProps: MapRefProps = { mapRef: { current: null } };
        const rendered = renderHook(({ mapRef }: MapRefProps) => useMapFitRequest(mapRef as never, true), {
            initialProps,
        });
        const map = { fitBounds: vi.fn(), flyTo: vi.fn() };
        const currentProps: MapRefProps = { mapRef: { current: map } };

        rendered.rerender(currentProps);
        act(() => requestMapFit({ bbox: [152.9, -27.6, 153.2, -27.3], paddingPx: 72, maxZoom: 10 }));

        expect(map.fitBounds).toHaveBeenCalledWith(
            [
                [152.9, -27.6],
                [153.2, -27.3],
            ],
            { padding: 72, maxZoom: 10, duration: 1200, essential: true },
        );
    });

    it('creates the pin marker when a live map ref replaces an empty one', () => {
        window.__thalassaPinView = {
            lat: -27.47,
            lng: 153.03,
            identity: { key: 'user:u1', userId: 'u1', generation: 0 },
        };
        const setIsPinView = vi.fn();
        const weather = {
            userLayers: new Set(),
            activeLayers: new Set(),
            setActiveLayer: vi.fn(),
            toggleLayer: vi.fn(),
        };
        const initialProps = {
            mapRef: { current: null } as ReplaceableMapRef,
            ownedPinViewRef: { current: null },
            pinMarkerRef: { current: null },
        };
        const rendered = renderHook(
            (props: typeof initialProps) =>
                usePinViewMode({
                    mapRef: props.mapRef as never,
                    mapReady: true,
                    isPinView: true,
                    setIsPinView,
                    ownedPinViewRef: props.ownedPinViewRef as never,
                    pinMarkerRef: props.pinMarkerRef as never,
                    weather: weather as never,
                    cycloneVisible: false,
                    setCycloneVisible: vi.fn(),
                    squallVisible: false,
                    setSquallVisible: vi.fn(),
                }),
            { initialProps },
        );
        const map = { flyTo: vi.fn() };
        const currentProps = {
            mapRef: { current: map } as ReplaceableMapRef,
            ownedPinViewRef: { current: null },
            pinMarkerRef: { current: null },
        };

        rendered.rerender(currentProps);

        expect(markerHarness.instances).toHaveLength(1);
        expect(markerHarness.instances[0].map).toBe(map);
        expect(currentProps.ownedPinViewRef.current).toBe(window.__thalassaPinView);
        expect(currentProps.pinMarkerRef.current).toBe(markerHarness.instances[0]);
        expect(map.flyTo).toHaveBeenCalledWith({ center: [153.03, -27.47], zoom: 7, duration: 1200 });
    });
});
