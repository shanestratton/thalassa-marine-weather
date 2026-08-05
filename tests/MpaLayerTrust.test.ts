import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const { fetchVerified } = vi.hoisted(() => ({ fetchVerified: vi.fn() }));

vi.mock('../services/weather/api/mpaDataset', () => ({
    fetchVerifiedMpaGeoJson: fetchVerified,
    getVerifiedMpaDatasetStatus: () => ({ sourceDate: '2024-06-01T00:00:00Z' }),
}));

import {
    buildMpaAttribution,
    deactivateMpaLayerAndProveSafe,
    isMpaLayerUnmounted,
    mountMpaLayer,
    MPA_FILL_ID,
    MPA_OUTLINE_ID,
    MPA_SOURCE_ID,
    unmountMpaLayer,
} from '../components/map/MpaLayer';

function fakeMap({ withOldPresentation = false }: { withOldPresentation?: boolean } = {}) {
    const sources = new Map<string, unknown>();
    const layers = new Map<string, unknown>();
    const visibility = new Map<string, string>();
    if (withOldPresentation) {
        sources.set(MPA_SOURCE_ID, { generation: 'old' });
        layers.set(MPA_FILL_ID, { id: MPA_FILL_ID });
        layers.set(MPA_OUTLINE_ID, { id: MPA_OUTLINE_ID });
    }
    return {
        getSource: vi.fn((id: string) => sources.get(id)),
        addSource: vi.fn((id: string, source: unknown) => sources.set(id, source)),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        getStyle: vi.fn(() => ({ layers: [] })),
        getLayer: vi.fn((id: string) => layers.get(id)),
        addLayer: vi.fn((layer: { id: string }) => layers.set(layer.id, layer)),
        removeLayer: vi.fn((id: string) => layers.delete(id)),
        setLayoutProperty: vi.fn((id: string, property: string, value: string) => {
            if (property === 'visibility') visibility.set(id, value);
        }),
        getLayoutProperty: vi.fn((id: string, property: string) =>
            property === 'visibility' ? visibility.get(id) : undefined,
        ),
    };
}

describe('MPA map trust integration', () => {
    beforeEach(() => fetchVerified.mockReset());

    it('does not add a source or layer when verification fails', async () => {
        fetchVerified.mockResolvedValue(null);
        const map = fakeMap();
        await expect(mountMpaLayer(map as never)).resolves.toBe(false);
        expect(map.addSource).not.toHaveBeenCalled();
        expect(map.addLayer).not.toHaveBeenCalled();
    });

    it('hands Mapbox only an already verified in-memory object, never a URL', async () => {
        const collection = { type: 'FeatureCollection', features: [] };
        fetchVerified.mockResolvedValue(collection);
        const map = fakeMap();
        await expect(mountMpaLayer(map as never)).resolves.toBe(true);
        expect(map.addSource).toHaveBeenCalledWith(
            'mpa-aus-source',
            expect.objectContaining({ type: 'geojson', data: collection }),
        );
        const sourceArg = map.addSource.mock.calls[0]?.[1] as { data: unknown };
        expect(sourceArg.data).not.toEqual(expect.any(String));
        const layerContracts = JSON.stringify(map.addLayer.mock.calls);
        expect(layerContracts).toContain('protection_class');
        expect(layerContracts).toContain('multiple_use');
        expect(layerContracts).not.toContain('restriction');
        expect(layerContracts).not.toContain('no_take');
    });

    it('uses only static trusted CAPAD/licence links and a validated source date in attribution', () => {
        const attribution = buildMpaAttribution('2024-06-01T00:00:00Z<script>');
        expect(attribution).toContain('https://www.dcceew.gov.au/environment/land/nrs/science/capad');
        expect(attribution).toContain('https://creativecommons.org/licenses/by/4.0/');
        expect(attribution).toContain('rel="noopener noreferrer"');
        expect(attribution).toContain('source 2024-06-01');
        expect(attribution).not.toContain('<script>');
    });

    it.each(['removeLayer', 'removeSource'] as const)(
        'refuses to mount a replacement when %s throws and stale artifacts remain',
        async (failingMethod) => {
            const collection = { type: 'FeatureCollection', features: [] };
            const map = fakeMap({ withOldPresentation: true });
            map[failingMethod].mockImplementation(() => {
                throw new Error(`${failingMethod} failed`);
            });

            expect(unmountMpaLayer(map as never)).toBe(false);
            expect(isMpaLayerUnmounted(map as never)).toBe(false);
            expect(deactivateMpaLayerAndProveSafe(map as never)).toBe('hidden');
            await expect(mountMpaLayer(map as never, {}, collection as never)).resolves.toBe(false);
            expect(map.addSource).not.toHaveBeenCalled();
            expect(map.addLayer).not.toHaveBeenCalled();
        },
    );

    it('periodically revalidates while visible, tears down on null, and guards handler attachment', () => {
        const source = readFileSync('components/map/useMpaLayer.ts', 'utf8');
        expect(source).toMatch(/setTimeout\(\(\) => void revalidate\(\), MPA_CACHE_TTL_MS \+ 100\)/);
        expect(source).toMatch(/if \(!data\) \{\s*failClosed\(/);
        expect(source).toContain('onVisibilityChange?.(false)');
        expect(source).toContain('releaseMpaDataset()');
        expect(source).toContain('requestController.abort(');
        expect(source).toContain('MPA replacement teardown could not prove complete artifact removal');
        expect(source).toContain('isMpaLayerMounted(map)');
        expect(source).toContain('closeBtn.focus()');
        expect(source).toContain("popup.on('close', () => map.getCanvas().focus())");
        expect(source).toMatch(/if \(handlersRef\.current\.click\) return/);
        expect(source).toMatch(/catch \(error\) \{[\s\S]*failClosed\('MPA style or trust refresh failed closed'/);
    });

    it('uses a readable dark surface and unmounts the old generation before replacement allocation', () => {
        const hook = readFileSync('components/map/useMpaLayer.ts', 'utf8');
        const loader = readFileSync('services/weather/api/mpaDataset.ts', 'utf8');
        const css = readFileSync('index.css', 'utf8');
        expect(css).toMatch(/\.mpa-popup \.mapboxgl-popup-content \{[\s\S]*background: rgba\(15, 23, 42/);
        expect(hook).toContain('unmountPresentation();');
        expect(loader).toContain('beforeGenerationAsset?.(manifest.generation);');
        expect(loader.indexOf('beforeGenerationAsset?.(manifest.generation);')).toBeLessThan(
            loader.indexOf('const asset = await fetchBoundedPublisherBytes('),
        );
    });
});
