import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    boundedOverlayGeoJson,
    useOwnedGeoJsonOverlay,
    type OwnedGeoJsonOverlayOptions,
} from '../components/map/useOwnedGeoJsonOverlay';
import { ownedVectorFixture } from './helpers/ownedVectorFixture';
import { toast } from '../components/Toast';

vi.mock('../components/Toast', () => ({ toast: { persistentError: vi.fn(() => 1), dismiss: vi.fn() } }));
const data = (): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: {
                type: 'MultiLineString',
                coordinates: [
                    [
                        [1, 2],
                        [3, 4],
                    ],
                    [
                        [3, 4],
                        [4, 4],
                    ],
                    [
                        [3, 4],
                        [4, 3],
                    ],
                ],
            },
            properties: { kind: 'geostrophic', speedMps: 0.25 },
        },
    ],
});
const layers: OwnedGeoJsonOverlayOptions['layers'] = [
    { suffix: 'vectors', specification: { type: 'line', paint: { 'line-color': '#38bdf8' } } },
];
function options(f: ReturnType<typeof ownedVectorFixture>): OwnedGeoJsonOverlayOptions {
    return {
        namespace: 'observed-ssh-arrows',
        label: 'Observed arrows',
        credit: 'Original source credit',
        enabled: true,
        owner: f.view,
        revision: 'original-generation',
        sourceCurrent: f.view.isCurrent,
        createData: vi.fn(data),
        layers,
        maxFeatures: 96,
        maxVertices: 576,
        refreshOnMoveEnd: true,
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('caller-owned bounded point/line snapshots', () => {
    it('copies only bounded point/line coordinates and plain original properties', () => {
        const original = data(),
            snapshot = boundedOverlayGeoJson(original, 96, 576);
        expect(snapshot).toEqual(original);
        original.features[0].properties!.speedMps = 99;
        (original.features[0].geometry as GeoJSON.MultiLineString).coordinates[0][0][0] = 99;
        expect(snapshot.features[0].properties!.speedMps).toBe(0.25);
        expect((snapshot.features[0].geometry as GeoJSON.MultiLineString).coordinates[0][0]).toEqual([1, 2]);
        expect(boundedOverlayGeoJson({ type: 'FeatureCollection', features: [] }, 96, 576).features).toEqual([]);
    });
    it.each([NaN, Infinity, 181, -181])('rejects invalid longitude %s before publishing', (value) => {
        const original = data();
        (original.features[0].geometry as GeoJSON.MultiLineString).coordinates[0][0][0] = value;
        expect(() => boundedOverlayGeoJson(original, 96, 576)).toThrow(/coordinate/);
    });
    it.each([NaN, Infinity, 85.05112879, -85.05112879])('rejects Mercator-unsafe latitude %s', (value) => {
        const original = data();
        (original.features[0].geometry as GeoJSON.MultiLineString).coordinates[0][0][1] = value;
        expect(() => boundedOverlayGeoJson(original, 96, 576)).toThrow(/coordinate/);
    });
    it('refuses feature/vertex/property/geometry bounds and sparse arrays', () => {
        expect(() => boundedOverlayGeoJson(data(), 96, 5)).toThrow(/coordinate/);
        expect(() =>
            boundedOverlayGeoJson({ type: 'FeatureCollection', features: Array(97).fill(data().features[0]) }, 96, 576),
        ).toThrow(/feature/);
        const original = data();
        original.features[0].properties = { nested: { hidden: true } };
        expect(() => boundedOverlayGeoJson(original, 96, 576)).toThrow(/property/);
        original.features[0].properties = { text: 'x'.repeat(257) };
        expect(() => boundedOverlayGeoJson(original, 96, 576)).toThrow(/property/);
        original.features[0].properties = {};
        original.features[0].geometry = { type: 'Polygon', coordinates: [] };
        expect(() => boundedOverlayGeoJson(original, 96, 576)).toThrow(/geometry/);
        expect(() => boundedOverlayGeoJson({ type: 'FeatureCollection', features: Array(1) }, 96, 576)).toThrow(
            /feature/,
        );
    });
    it('enforces the aggregate byte cap independently of feature and vertex counts', () => {
        const feature: GeoJSON.Feature = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`key${index}`, 'x'.repeat(256)])),
        };
        expect(() =>
            boundedOverlayGeoJson({ type: 'FeatureCollection', features: Array(6032).fill(feature) }, 6032, 120028),
        ).toThrow(/byte/);
    });
});

describe('shared vector ownership and viewport lifecycle', () => {
    it('coalesces many moveend events into one new bounded frame and no geometry history', () => {
        const f = ownedVectorFixture(),
            config = options(f);
        const hook = renderHook(() => useOwnedGeoJsonOverlay(f.mapRef, true, config));
        expect(config.createData).toHaveBeenCalledTimes(1);
        act(() => f.map.emit('sourcedata', { sourceId: 'observed-ssh-arrows-source', sourceDataType: 'metadata' }));
        expect(hook.result.current).toBe('ready');
        act(() => {
            for (let i = 0; i < 30; i++) f.map.emit('moveend');
            vi.advanceTimersByTime(100);
        });
        expect(config.createData).toHaveBeenCalledTimes(2);
        expect(f.map.sources.size).toBe(1);
        expect(f.map.getStyle().layers.filter((layer) => layer.id.startsWith('observed-ssh-arrows'))).toHaveLength(1);
        expect(hook.result.current).toBe('loading');
        hook.unmount();
        expect(f.map.sources.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('refuses a source retired during frame construction, before any publication', () => {
        const f = ownedVectorFixture(),
            config = options(f);
        const hook = renderHook(() =>
            useOwnedGeoJsonOverlay(f.mapRef, true, {
                ...config,
                createData: () => {
                    f.retire();
                    return data();
                },
            }),
        );
        expect(hook.result.current).toBe('unavailable');
        expect(f.map.addSource).not.toHaveBeenCalled();
    });
    it('refuses queued viewport work after source retirement and ignores late worker completion', () => {
        const f = ownedVectorFixture(),
            config = options(f);
        const hook = renderHook(() => useOwnedGeoJsonOverlay(f.mapRef, true, config));
        act(() => f.map.emit('moveend'));
        f.retire();
        act(() => vi.advanceTimersByTime(100));
        act(() => f.map.emit('sourcedata', { sourceId: 'observed-ssh-arrows-source', sourceDataType: 'metadata' }));
        expect(config.createData).toHaveBeenCalledTimes(1);
        expect(f.map.sources.size).toBe(0);
        expect(hook.result.current).toBe('unavailable');
    });
    it('retires the exact owner and revision before a changed cohort may appear', () => {
        const f = ownedVectorFixture(),
            config = options(f);
        const hook = renderHook(({ value }) => useOwnedGeoJsonOverlay(f.mapRef, true, value), {
            initialProps: { value: config },
        });
        const old = f.map.sources.get('observed-ssh-arrows-source');
        hook.rerender({ value: { ...config, owner: {}, revision: 'new-generation' } });
        expect(f.map.sources.get('observed-ssh-arrows-source')).not.toBe(old);
        expect(f.map.sources.size).toBe(1);
        expect(hook.result.current).toBe('loading');
    });
    it('holds corrupt/oversized factories and invalid namespace/spec without publishing', () => {
        const f = ownedVectorFixture(),
            config = options(f);
        const invalid: OwnedGeoJsonOverlayOptions = {
            ...config,
            createData: () => {
                throw new Error('Bounds unavailable');
            },
        };
        const hook = renderHook(({ value }) => useOwnedGeoJsonOverlay(f.mapRef, true, value), {
            initialProps: { value: invalid },
        });
        expect(hook.result.current).toBe('unavailable');
        expect(f.map.addSource).not.toHaveBeenCalled();
        hook.rerender({ value: { ...config, namespace: '../../foreign' } });
        expect(hook.result.current).toBe('unavailable');
        expect(f.map.addSource).not.toHaveBeenCalled();
    });
    it('never hides a foreign layer collision or drops its attributed warning on user-off', () => {
        const f = ownedVectorFixture(),
            config = options(f);
        f.map.addLayer({ id: 'observed-ssh-arrows-vectors', source: 'foreign', type: 'line' });
        const hook = renderHook(({ value }) => useOwnedGeoJsonOverlay(f.mapRef, true, value), {
            initialProps: { value: config },
        });
        hook.rerender({ value: { ...config, enabled: false } });
        expect(hook.result.current).toBe('stuck-visible');
        expect(f.map.removeLayer).not.toHaveBeenCalled();
        expect(f.map.setLayoutProperty).not.toHaveBeenCalled();
        expect(toast.persistentError).toHaveBeenCalledWith(
            expect.stringContaining('Original source credit'),
            expect.anything(),
        );
        act(() => f.map.emit('remove'));
        expect(hook.result.current).toBe('off');
    });
});
