import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAisStreamLayer } from '../components/map/useAisStreamLayer';

const mocks = vi.hoisted(() => ({
    fetchNearby: vi.fn(),
    batchLookup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/AisStreamService', () => ({
    AisStreamService: { fetchNearby: mocks.fetchNearby },
}));
vi.mock('../services/AisStore', () => ({
    AisStore: { toGeoJSON: () => ({ type: 'FeatureCollection', features: [] }) },
}));
vi.mock('../services/supabase', () => ({ supabase: {} }));
vi.mock('../components/map/useAisLayer', () => ({ onLocalAisChange: () => () => undefined }));
vi.mock('../stores/LocationStore', () => ({ LocationStore: { getState: () => ({ lat: 0, lon: 0 }) } }));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { getState: () => ({ sog: { value: 0 }, cog: { value: 0 } }) },
}));
vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: {
        checkFeatures: () => [],
        getState: () => ({ enabled: false, radiusNm: 1 }),
    },
}));
vi.mock('../services/VesselMetadataService', () => ({
    VesselMetadataService: {
        batchLookup: mocks.batchLookup,
        getVesselIntel: () => null,
        onDemandLookup: vi.fn(),
    },
}));
vi.mock('../managers/FeatureGate', () => ({ isFeatureLockedSync: () => true }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils/MmsiDecoder', () => ({ getMmsiFlag: () => '🏳️' }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ warn: vi.fn() }),
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function vesselFeature(mmsi: number): GeoJSON.Feature<GeoJSON.Point> {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [153, -27] },
        properties: { mmsi, sog: 0, cog: 0, nav_status: 0 },
    };
}

function makeMap() {
    const aisSource = { setData: vi.fn() };
    const trackSource = { setData: vi.fn() };
    const guardSource = { setData: vi.fn() };
    const sources: Record<string, { setData: ReturnType<typeof vi.fn> }> = {
        'ais-targets': aisSource,
        'ais-predicted-tracks': trackSource,
        'ais-guard-zone': guardSource,
    };
    const map = {
        getCenter: () => ({ lat: -27, lng: 153 }),
        getZoom: () => 12,
        getBounds: () => ({
            getWest: () => 150,
            getEast: () => 156,
            getSouth: () => -30,
            getNorth: () => -24,
        }),
        getSource: (id: string) => sources[id],
        getCanvas: () => ({ style: { cursor: '' } }),
        on: vi.fn(),
        off: vi.fn(),
    };
    return { map, aisSource };
}

describe('useAisStreamLayer request lifecycle', () => {
    afterEach(() => {
        mocks.fetchNearby.mockReset();
        mocks.batchLookup.mockClear();
    });

    it('accepts the new fetch after re-enable and rejects the older in-flight response', async () => {
        const first = deferred<{ type: 'FeatureCollection'; features: GeoJSON.Feature[] }>();
        const second = deferred<{ type: 'FeatureCollection'; features: GeoJSON.Feature[] }>();
        mocks.fetchNearby.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { map, aisSource } = makeMap();

        const { rerender, unmount } = renderHook(({ enabled }) => useAisStreamLayer(map as never, enabled), {
            initialProps: { enabled: true },
        });
        await waitFor(() => expect(mocks.fetchNearby).toHaveBeenCalledTimes(1));

        rerender({ enabled: false });
        rerender({ enabled: true });
        await waitFor(() => expect(mocks.fetchNearby).toHaveBeenCalledTimes(2));
        aisSource.setData.mockClear();

        await act(async () => {
            first.resolve({ type: 'FeatureCollection', features: [vesselFeature(111_111_111)] });
            await first.promise;
        });
        expect(aisSource.setData).not.toHaveBeenCalled();

        await act(async () => {
            second.resolve({ type: 'FeatureCollection', features: [vesselFeature(222_222_222)] });
            await second.promise;
        });
        await waitFor(() => expect(aisSource.setData).toHaveBeenCalled());

        const written = aisSource.setData.mock.calls.at(-1)?.[0] as GeoJSON.FeatureCollection;
        expect(written.features.map((feature) => feature.properties?.mmsi)).toEqual([222_222_222]);
        expect(mocks.batchLookup).toHaveBeenCalledWith([222_222_222]);
        unmount();
    });
});
