import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { OffshoreCandidate, OffshoreJob } from '../services/routing/offshoreProtocol';
import type { OffshoreComparisonContext, OffshoreComparisonInputs } from '../components/map/useOffshoreComparison';
import type { VerifiedOffshoreCandidate } from '../services/routing/offshoreSelection';

const mock = vi.hoisted(() => ({ compare: vi.fn() }));
vi.mock('../services/routing/offshoreModelComparison', async (original) => ({
    ...(await original<typeof import('../services/routing/offshoreModelComparison')>()),
    compareOffshoreModels: mock.compare,
}));
import { useOffshoreComparison } from '../components/map/useOffshoreComparison';
import { OFFSHORE_COMPARISON_MODELS } from '../services/routing/offshoreModelComparison';

const raw: OffshoreCandidate = {
    verification: 'unverified-public-data',
    maxWindKts: 18,
    maxGustKts: 24,
    upwindPercent: 10,
    result: {
        route: [],
        routeCoordinates: [
            [-30, 0],
            [-29, 0],
        ],
        shallowFlags: [false, false],
        totalDistanceNM: 60,
        totalDurationHours: 10,
        arrivalTime: '2026-10-17T10:00:00Z',
        isochrones: [],
    },
};
const accepted: VerifiedOffshoreCandidate = {
    ...raw,
    verification: 'verified-final-geometry',
    hazardReport: null,
    result: {
        ...raw.result,
        routeCoordinates: [
            [-30, 0],
            [-29.5, 0.1],
            [-29, 0],
        ],
        totalDistanceNM: 62,
    },
};
function setup() {
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, unknown>();
    sources.set('route-line', { setData: vi.fn() });
    const map = {
        getSource: vi.fn((id: string) => sources.get(id)),
        getLayer: vi.fn((id: string) => layers.get(id)),
        addSource: vi.fn((id: string) => sources.set(id, { setData: vi.fn() })),
        addLayer: vi.fn((layer: { id: string }) => layers.set(layer.id, layer)),
        removeLayer: vi.fn((id: string) => layers.delete(id)),
        removeSource: vi.fn((id: string) => sources.delete(id)),
    };
    const ref = { current: map as unknown as mapboxgl.Map };
    const inputs = {
        base: {} as Omit<OffshoreJob, 'wind' | 'deadlineMs'>,
        bounds: { north: 2, south: -2, west: -32, east: -28 },
        environment: {},
    } as OffshoreComparisonInputs;
    const context: OffshoreComparisonContext = {
        isCurrent: () => true,
        load: vi.fn(async () => inputs),
        verify: vi.fn(async () => accepted),
        commit: vi.fn(),
    };
    const hook = renderHook(() => useOffshoreComparison(ref));
    act(() => hook.result.current.prepare(context));
    return { ...hook, context, map, sources, layers };
}
beforeEach(() => {
    mock.compare.mockReset().mockImplementation(async (options) => {
        const rows = OFFSHORE_COMPARISON_MODELS.map((model) => ({ model, status: 'candidate', candidate: raw }));
        for (const row of rows) {
            options.onGrid(row.model, {});
            options.onRow(row);
        }
        return rows;
    });
});
afterEach(() => vi.useRealTimers());
describe('comparison uses the existing verified passage transaction', () => {
    it('keeps reference lines unselectable and commits only final verified geometry', async () => {
        const h = setup();
        await act(() => h.result.current.view.start());
        expect(mock.compare).toHaveBeenCalledWith(
            expect.objectContaining({ commercialEnabled: true, deadlineMs: expect.any(Number) }),
        );
        const overlay = h.sources.get('offshore-model-comparison')!;
        const data = overlay.setData.mock.lastCall![0];
        expect(data.features).toHaveLength(4);
        expect(data.features.every((f: GeoJSON.Feature) => f.properties?.selectable === false)).toBe(true);
        expect(h.sources.get('route-line')!.setData).not.toHaveBeenCalled();
        await act(() => h.result.current.view.select('ecmwf'));
        expect(h.context.commit).toHaveBeenCalledWith(accepted, OFFSHORE_COMPARISON_MODELS[0]);
        expect(h.context.commit).not.toHaveBeenCalledWith(raw, expect.anything());
        expect(h.result.current.view.selected).toBe('ecmwf');
        h.unmount();
    });
    it('leaves the primary route untouched after a chart verification refusal', async () => {
        const h = setup();
        vi.mocked(h.context.verify).mockRejectedValue(new Error('Chart depth unavailable.'));
        await act(() => h.result.current.view.start());
        await act(() => h.result.current.view.select('gfs'));
        expect(h.context.commit).not.toHaveBeenCalled();
        expect(h.sources.get('route-line')!.setData).not.toHaveBeenCalled();
        expect(h.result.current.view.message).toContain('Chart depth unavailable');
        h.unmount();
    });
    it('ignores a verification which completes after clear/identity change and removes reference lines', async () => {
        const h = setup();
        let finish!: (value: VerifiedOffshoreCandidate) => void;
        vi.mocked(h.context.verify).mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await act(() => h.result.current.view.start());
        let pending!: Promise<void>;
        act(() => {
            pending = h.result.current.view.select('icon');
        });
        act(() => h.result.current.reset());
        await act(async () => {
            finish(accepted);
            await pending;
        });
        expect(h.context.commit).not.toHaveBeenCalled();
        expect(h.sources.has('offshore-model-comparison')).toBe(false);
        expect(h.result.current.view.rows).toEqual([]);
        h.unmount();
    });
    it('expires candidates when vessel/departure settings change', async () => {
        vi.useFakeTimers();
        const h = setup();
        await act(() => h.result.current.view.start());
        h.context.isCurrent = () => false;
        await act(() => vi.advanceTimersByTimeAsync(250));
        expect(h.result.current.view.ready).toBe(false);
        expect(h.result.current.view.rows).toEqual([]);
        expect(h.layers.has('offshore-model-comparison-lines')).toBe(false);
        h.unmount();
    });
    it('does not silently remove VIA waypoints or start a comparison in Satellite Mode', async () => {
        const h = setup();
        h.context.disabledReason = 'A VIA passage requires separate legs.';
        await act(() => h.result.current.view.start());
        expect(h.context.load).not.toHaveBeenCalled();
        expect(mock.compare).not.toHaveBeenCalled();
        h.unmount();
    });
});
