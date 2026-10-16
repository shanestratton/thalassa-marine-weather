import { act, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ accepted: false, read: vi.fn() }));
vi.mock('../services/enc/noaaAgreement', () => ({
    noaaAgreementAccepted: async () => {
        h.read();
        return h.accepted;
    },
}));
import { ChartCatalogService, chartSourceCovers } from '../services/ChartCatalogService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useChartCatalog } from '../components/map/useChartCatalog';
import { applyEncOnlyBase } from '../components/map/encOnlyBase';
import { CATEGORY_DETAIL } from '../components/map/chartDisplayCategory';
import { applyChartDetailLevel } from '../components/map/encDetailScrubber';
import { ENC_VEC_LAYERS } from '../components/map/encLayerIds';
function harness() {
    const sources = new Map<string, unknown>(),
        layers = new Map<string, { id: string; type: string; source?: string }>(),
        visibility = new Map<string, string>(),
        paint = new Map<string, unknown>();
    const listeners = new Map<string, Set<() => void>>();
    let bounds = [-77, 36, -76, 37];
    const map = {
        getBounds: () => ({
            getWest: () => bounds[0],
            getSouth: () => bounds[1],
            getEast: () => bounds[2],
            getNorth: () => bounds[3],
        }),
        on: (event: string, fn: () => void) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(fn);
        },
        off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn),
        addSource: (id: string, s: unknown) => sources.set(id, s),
        getSource: (id: string) => sources.get(id),
        removeSource: (id: string) => sources.delete(id),
        addLayer: (l: { id: string; type: string; source?: string }) => layers.set(l.id, l),
        getLayer: (id: string) => layers.get(id),
        removeLayer: (id: string) => layers.delete(id),
        getStyle: () => ({ layers: [...layers.values()] }),
        getLayoutProperty: (id: string) => visibility.get(id),
        setLayoutProperty: (id: string, _p: string, v: string) => visibility.set(id, v),
        getPaintProperty: (id: string, p: string) => paint.get(id + p),
        setPaintProperty: (id: string, p: string, v: unknown) => paint.set(id + p, v),
        getFilter: () => null,
        setFilter: () => undefined,
    };
    return {
        map: map as unknown as mapboxgl.Map,
        ref: { current: map } as unknown as MutableRefObject<mapboxgl.Map | null>,
        sources,
        layers,
        visibility,
        camera: (b: number[]) => {
            bounds = b;
            listeners.get('moveend')?.forEach((fn) => fn());
        },
    };
}
beforeEach(() => {
    h.accepted = false;
    localStorage.clear();
    setAuthIdentityScope('paper-' + crypto.randomUUID());
    ChartCatalogService.initialize();
});
describe('official chart presentation controls', () => {
    it('gates even previously selected NOAA images on current account consent, then pauses all images in Satellite Mode', async () => {
        ChartCatalogService.toggleSource('noaa-ncds');
        const m = harness();
        const rendered = renderHook(({ paused }) => useChartCatalog(m.ref, true, true, false, paused), {
            initialProps: { paused: false },
        });
        expect(m.sources.size).toBe(0);
        expect(rendered.result.current.sources.find((s) => s.id === 'noaa-ncds')?.enabled).toBe(true);
        await act(async () => {
            await vi.dynamicImportSettled();
        });
        act(() => {
            h.accepted = true;
            rendered.result.current.refreshConsent();
        });
        await act(async () => {
            await vi.dynamicImportSettled();
        });
        expect(m.sources.has('chart-catalog-noaa-ncds')).toBe(true);
        rendered.rerender({ paused: true });
        expect(m.sources.size).toBe(0);
        rendered.rerender({ paused: false });
        expect(m.sources.size).toBe(1);
        act(() => setAuthIdentityScope('paper-b-' + crypto.randomUUID()));
        expect(m.sources.size).toBe(0);
    });
    it('does not query/remove the camera to show paper charts, and removes a selected regional source when the camera leaves it', async () => {
        const m = harness();
        ChartCatalogService.toggleSource('linz-charts');
        const rendered = renderHook(() => useChartCatalog(m.ref, true));
        expect(m.sources.size).toBe(0);
        act(() => m.camera([174, -42, 175, -41]));
        expect(m.sources.has('chart-catalog-linz-charts')).toBe(true);
        act(() => m.camera([150, -35, 151, -34]));
        expect(m.sources.size).toBe(0);
        expect(rendered.result.current.sources.find((s) => s.id === 'linz-charts')!.enabled).toBe(true);
    });
    it('recognizes camera world copies and US date-line coverage without offering NOAA in Europe/Australia', () => {
        const noaa = ChartCatalogService.getSources().find((s) => s.id === 'noaa-ncds')!;
        expect(chartSourceCovers(noaa, [178, 50, -178, 53])).toBe(true);
        expect(chartSourceCovers(noaa, [283, 36, 284, 37])).toBe(true);
        expect(chartSourceCovers(noaa, [0, 50, 1, 51])).toBe(false);
        expect(chartSourceCovers(noaa, [150, -35, 151, -34])).toBe(false);
    });
    it('ENC only hides basemap sources and restores prior visibility; navigation/safety layers and cached chart source stay intact', () => {
        const m = harness();
        m.layers.set('land', { id: 'land', type: 'background' });
        m.layers.set('roads', { id: 'roads', type: 'line', source: 'composite' });
        m.layers.set('enc-vec-hazards', { id: 'enc-vec-hazards', type: 'circle', source: 'licensed-cell-ram-only' });
        m.layers.set('route', { id: 'route', type: 'line', source: 'route' });
        m.visibility.set('roads', 'none');
        expect(applyEncOnlyBase(m.map, true)).toBe(true);
        expect(m.visibility.get('land')).toBe('none');
        expect(m.visibility.has('enc-vec-hazards')).toBe(false);
        expect(m.visibility.has('route')).toBe(false);
        expect(applyEncOnlyBase(m.map, true)).toBe(false);
        applyEncOnlyBase(m.map, false);
        expect(m.visibility.get('land')).toBe('visible');
        expect(m.visibility.get('roads')).toBe('none');
    });
    it('all three category presets preserve the existing safety floor, including isolated-danger pointers', () => {
        const m = harness();
        const floor = [ENC_VEC_LAYERS.DEPARE, ENC_VEC_LAYERS.BOYISD, ENC_VEC_LAYERS.BCNISD];
        for (const id of floor) m.layers.set(id, { id, type: 'fill', source: 'chart' });
        for (const category of Object.values(CATEGORY_DETAIL)) {
            applyChartDetailLevel(m.map, category);
            for (const id of floor) expect(m.visibility.get(id)).not.toBe('none');
        }
    });
});
