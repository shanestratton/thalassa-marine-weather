import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { deactivateFailedCmemsRenderer } from '../components/map/cmemsLayerFailure';
import {
    cmemsRenderedLayerState,
    type CmemsGridRefreshState,
    type CmemsRenderOutcome,
} from '../components/map/useCmemsGridRefresh';
import { toast } from '../components/Toast';

const ID = 'cmems-test-renderer';

function mapWithRegistry() {
    const registry = new Map<string, unknown>([[ID, { id: ID }]]);
    const handlers = new Map<string, () => void>();
    let visibility: string | undefined;
    const raw = {
        getLayer: vi.fn((id: string) => registry.get(id)),
        removeLayer: vi.fn((id: string) => {
            registry.delete(id);
        }),
        setLayoutProperty: vi.fn((_id: string, _property: string, value: string) => {
            visibility = value;
        }),
        getLayoutProperty: vi.fn(() => visibility),
        on: vi.fn((event: string, handler: () => void) => {
            handlers.set(event, handler);
        }),
        off: vi.fn((event: string) => {
            handlers.delete(event);
        }),
    };
    return {
        map: raw as unknown as mapboxgl.Map,
        raw,
        registry,
        handlers,
        setVisibility: (value: string) => {
            visibility = value;
        },
    };
}

function failureOptions(map: mapboxgl.Map) {
    const clearOwnership = vi.fn();
    const outcomes: CmemsRenderOutcome[] = [];
    return {
        clearOwnership,
        outcomes,
        options: {
            map,
            layerId: ID,
            label: 'Currents',
            attempt: 7,
            verifiedStep: 3,
            sourceGeneration: 'g-safe-frame',
            clearOwnership,
            publish: (outcome: CmemsRenderOutcome) => outcomes.push(outcome),
        },
    };
}

describe('CMEMS renderer failure deactivation', () => {
    afterEach(() => {
        toast.clear();
        vi.restoreAllMocks();
    });

    it('clears ownership and reports absence only after synchronous removal is proven', () => {
        const harness = mapWithRegistry();
        const failure = failureOptions(harness.map);

        expect(deactivateFailedCmemsRenderer(failure.options)).toBeUndefined();
        expect(failure.clearOwnership).toHaveBeenCalledOnce();
        expect(failure.outcomes).toEqual([
            {
                phase: 'error',
                attempt: 7,
                verifiedStep: null,
                sourceGeneration: null,
            },
        ]);
        expect(harness.registry.has(ID)).toBe(false);
        expect(harness.handlers.size).toBe(0);
    });

    it('reports hidden while retaining ownership and monitors until strict absence', () => {
        const harness = mapWithRegistry();
        harness.raw.removeLayer.mockImplementation(() => {
            throw new Error('style mutation blocked');
        });
        const failure = failureOptions(harness.map);

        const dispose = deactivateFailedCmemsRenderer(failure.options);
        expect(dispose).toBeTypeOf('function');
        expect(failure.clearOwnership).not.toHaveBeenCalled();
        expect(failure.outcomes.at(-1)).toEqual({
            phase: 'hidden',
            attempt: 7,
            verifiedStep: 3,
            sourceGeneration: 'g-safe-frame',
        });
        expect(harness.handlers.has('idle')).toBe(true);

        harness.raw.removeLayer.mockImplementation((id: string) => {
            harness.registry.delete(id);
        });
        harness.handlers.get('idle')?.();

        expect(failure.clearOwnership).toHaveBeenCalledOnce();
        expect(failure.outcomes.at(-1)).toEqual({
            phase: 'error',
            attempt: 7,
            verifiedStep: null,
            sourceGeneration: null,
        });
        expect(harness.handlers.size).toBe(0);
    });

    it('reports the actual stale frame when neither removal nor hiding can be proven', () => {
        const harness = mapWithRegistry();
        harness.raw.removeLayer.mockImplementation(() => {
            throw new Error('style mutation blocked');
        });
        harness.raw.setLayoutProperty.mockImplementation(() => {
            throw new Error('visibility mutation blocked');
        });
        const failure = failureOptions(harness.map);

        deactivateFailedCmemsRenderer(failure.options);
        expect(failure.clearOwnership).not.toHaveBeenCalled();
        expect(failure.outcomes.at(-1)).toEqual({
            phase: 'stuck-visible',
            attempt: 7,
            verifiedStep: 3,
            sourceGeneration: 'g-safe-frame',
        });

        harness.raw.setLayoutProperty.mockImplementation((_id: string, _property: string, value: string) => {
            harness.setVisibility(value);
        });
        harness.handlers.get('styledata')?.();
        expect(failure.outcomes.at(-1)?.phase).toBe('hidden');
        expect(failure.clearOwnership).not.toHaveBeenCalled();
    });

    it('never describes a still-registered hidden renderer as absent', () => {
        const refresh = {
            phase: 'ready',
            grid: {} as CmemsGridRefreshState['grid'],
            requestedStep: 3,
            verifiedStep: 3,
            sourceGeneration: 'g-safe-frame',
            presentation: 'absent',
            attempt: 7,
            retry: vi.fn(),
        } satisfies CmemsGridRefreshState;
        const hidden: CmemsRenderOutcome = {
            phase: 'hidden',
            attempt: 7,
            verifiedStep: 3,
            sourceGeneration: 'g-safe-frame',
        };

        expect(cmemsRenderedLayerState(refresh, true, true, true, hidden)).toMatchObject({
            phase: 'error',
            presentation: 'hidden',
        });
        expect(cmemsRenderedLayerState(refresh, true, false, true, hidden)).toMatchObject({
            phase: 'idle',
            presentation: 'hidden',
        });
    });

    it('wires every CMEMS renderer hook through the same fail-closed catch path', () => {
        const hooks = [
            'useOceanCurrentParticleLayer.ts',
            'useOceanWaveParticleLayer.ts',
            'useSstRasterLayer.ts',
            'useChlRasterLayer.ts',
            'useSeaIceRasterLayer.ts',
            'useMldRasterLayer.ts',
        ];
        for (const hook of hooks) {
            const source = readFileSync(resolve(process.cwd(), 'components/map', hook), 'utf8');
            expect(source).toContain("import { deactivateFailedCmemsRenderer } from './cmemsLayerFailure';");
            expect(source.match(/return deactivateFailedCmemsRenderer\(\{/g)?.length).toBeGreaterThanOrEqual(4);
        }
    });
});
