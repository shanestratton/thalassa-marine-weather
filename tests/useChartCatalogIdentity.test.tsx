import { act, renderHook, waitFor } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import type { MutableRefObject } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChartCatalog } from '../components/map/useChartCatalog';
import { ChartCatalogService } from '../services/ChartCatalogService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

interface RasterSourceSpec {
    tiles: string[];
}

function mapHarness() {
    const sources = new Map<string, RasterSourceSpec>();
    const layers = new Set<string>();
    const map = {
        addSource: (id: string, source: RasterSourceSpec) => sources.set(id, source),
        getSource: (id: string) => sources.get(id),
        removeSource: (id: string) => sources.delete(id),
        addLayer: (layer: { id: string }) => layers.add(layer.id),
        getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
        removeLayer: (id: string) => layers.delete(id),
        isStyleLoaded: () => true,
        getStyle: () => ({ layers: [] }),
        setPaintProperty: () => undefined,
        fitBounds: () => undefined,
        flyTo: () => undefined,
    };
    return {
        mapRef: { current: map } as unknown as MutableRefObject<mapboxgl.Map | null>,
        sources,
    };
}

describe('useChartCatalog identity boundary', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(`chart-hook-a-${crypto.randomUUID()}`);
        ChartCatalogService.initialize();
        ChartCatalogService.updateLinzKey('account-a-chart-secret');
        ChartCatalogService.toggleSource('linz-charts');
    });

    it('replaces a rotated key and synchronously removes account A Mapbox sources on A→B', async () => {
        const { mapRef, sources } = mapHarness();
        const { result } = renderHook(() => useChartCatalog(mapRef, true));

        await waitFor(() =>
            expect(sources.get('chart-catalog-linz-charts')?.tiles[0]).toContain('account-a-chart-secret'),
        );

        act(() => {
            result.current.updateLinzKey('account-a-rotated-secret');
        });
        await waitFor(() =>
            expect(sources.get('chart-catalog-linz-charts')?.tiles[0]).toContain('account-a-rotated-secret'),
        );
        expect(sources.get('chart-catalog-linz-charts')?.tiles[0]).not.toContain('account-a-chart-secret');

        const staleUpdate = result.current.updateLinzKey;
        act(() => {
            setAuthIdentityScope(`chart-hook-b-${crypto.randomUUID()}`);
        });

        expect(sources.has('chart-catalog-linz-charts')).toBe(false);

        act(() => {
            staleUpdate('stale-account-a-secret');
            result.current.updateLinzKey('account-b-chart-secret');
            result.current.toggleSource('linz-charts');
        });
        await waitFor(() =>
            expect(sources.get('chart-catalog-linz-charts')?.tiles[0]).toContain('account-b-chart-secret'),
        );
        expect(sources.get('chart-catalog-linz-charts')?.tiles[0]).not.toContain('stale-account-a-secret');
        expect(
            ChartCatalogService.getSources(getAuthIdentityScope()).find((source) => source.id === 'linz-charts'),
        ).toMatchObject({
            enabled: true,
        });
    });
});
