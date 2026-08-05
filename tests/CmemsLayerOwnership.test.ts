import { afterEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import {
    addCmemsLayerAndProveOwnership,
    deactivateCmemsLayerAndProveSafe,
    isCmemsLayerAbsent,
    monitorCmemsLayerDeactivation,
    removeCmemsLayerAndProveAbsent,
} from '../components/map/cmemsLayerOwnership';
import { toast } from '../components/Toast';

const ID = 'cmems-test-layer';

function mapWithRegistry() {
    const registry = new Map<string, unknown>();
    const handlers = new Map<string, () => void>();
    let visibility: string | undefined;
    const map = {
        getLayer: vi.fn((id: string) => registry.get(id)),
        addLayer: vi.fn((layer: { id: string }) => {
            if (!registry.has(layer.id)) registry.set(layer.id, layer);
        }),
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
        map: map as unknown as mapboxgl.Map,
        registry,
        setVisibility: (value: string) => {
            visibility = value;
        },
        handlers,
        raw: map,
    };
}

describe('CMEMS Mapbox ownership proofs', () => {
    afterEach(() => {
        toast.clear();
        vi.restoreAllMocks();
    });

    it('requires a non-throwing removal and a post-removal absence proof', () => {
        const { map, registry, raw } = mapWithRegistry();
        registry.set(ID, { id: ID });

        expect(removeCmemsLayerAndProveAbsent(map, ID)).toBe(true);
        expect(raw.removeLayer).toHaveBeenCalledWith(ID);
        expect(isCmemsLayerAbsent(map, ID)).toBe(true);

        registry.set(ID, { id: ID });
        raw.removeLayer.mockImplementationOnce((id: string) => {
            registry.delete(id);
            throw new Error('throw after mutation');
        });
        expect(removeCmemsLayerAndProveAbsent(map, ID)).toBe(false);
    });

    it('fails replacement closed on lookup errors while still proving a user-off hidden fallback', () => {
        const throwingLookup = mapWithRegistry();
        throwingLookup.registry.set(ID, { id: ID });
        throwingLookup.raw.getLayer.mockImplementation(() => {
            throw new Error('style changing');
        });
        expect(removeCmemsLayerAndProveAbsent(throwingLookup.map, ID)).toBe(false);
        expect(deactivateCmemsLayerAndProveSafe(throwingLookup.map, ID)).toBe('hidden');

        const residue = mapWithRegistry();
        residue.registry.set(ID, { id: ID });
        residue.raw.removeLayer.mockImplementation(() => undefined);
        expect(deactivateCmemsLayerAndProveSafe(residue.map, ID)).toBe('hidden');
        expect(residue.raw.setLayoutProperty).toHaveBeenCalledWith(ID, 'visibility', 'none');
    });

    it('uses the proven hidden fallback when removeLayer throws without mutation', () => {
        const blocked = mapWithRegistry();
        blocked.registry.set(ID, { id: ID });
        blocked.raw.removeLayer.mockImplementation(() => {
            throw new Error('style mutation rejected');
        });

        expect(removeCmemsLayerAndProveAbsent(blocked.map, ID)).toBe(false);
        expect(deactivateCmemsLayerAndProveSafe(blocked.map, ID)).toBe('hidden');
        expect(blocked.raw.setLayoutProperty).toHaveBeenCalledWith(ID, 'visibility', 'none');
    });

    it('accepts a mount only when Mapbox returns the exact candidate identity', () => {
        const registered = mapWithRegistry();
        const candidate = { id: ID, type: 'custom', renderingMode: '2d' } as mapboxgl.CustomLayerInterface;
        expect(addCmemsLayerAndProveOwnership(registered.map, ID, candidate)).toBe(true);
        expect(registered.raw.getLayer(ID)).toBe(candidate);

        const duplicateReturn = mapWithRegistry();
        const oldLayer = { id: ID, type: 'custom' };
        duplicateReturn.raw.addLayer.mockImplementation(() => {
            duplicateReturn.registry.set(ID, oldLayer);
        });
        expect(addCmemsLayerAndProveOwnership(duplicateReturn.map, ID, candidate)).toBe(false);
        expect(duplicateReturn.registry.has(ID)).toBe(false);
        expect(duplicateReturn.raw.removeLayer).toHaveBeenCalledWith(ID);
    });

    it('synchronously rolls back a throw-after-register candidate before Retry', () => {
        const partial = mapWithRegistry();
        const candidate = { id: ID, type: 'custom', renderingMode: '2d' } as mapboxgl.CustomLayerInterface;
        partial.raw.addLayer.mockImplementationOnce((layer: { id: string }) => {
            partial.registry.set(layer.id, layer);
            throw new Error('onAdd failed');
        });

        expect(addCmemsLayerAndProveOwnership(partial.map, ID, candidate)).toBe(false);
        expect(partial.registry.has(ID)).toBe(false);
        expect(deactivateCmemsLayerAndProveSafe(partial.map, ID)).toBe('absent');
    });

    it('retries an unsafe user-off teardown at the next Mapbox style boundary', () => {
        const blocked = mapWithRegistry();
        blocked.registry.set(ID, { id: ID });
        blocked.raw.removeLayer.mockImplementation(() => {
            throw new Error('blocked');
        });
        blocked.raw.setLayoutProperty.mockImplementation(() => {
            throw new Error('blocked');
        });
        const onSafe = vi.fn();
        const dismiss = vi.spyOn(toast, 'dismiss');
        const persistentError = vi.spyOn(toast, 'persistentError');

        monitorCmemsLayerDeactivation(blocked.map, ID, 'Currents', onSafe);
        expect(persistentError).toHaveBeenCalledWith(
            expect.stringMatching(/may still be visible\. Do not rely/i),
            expect.objectContaining({ label: 'Retry' }),
        );
        expect(blocked.handlers.has('styledata')).toBe(true);
        expect(blocked.handlers.has('idle')).toBe(true);
        expect(onSafe).not.toHaveBeenCalled();

        blocked.raw.removeLayer.mockImplementation(() => undefined);
        blocked.raw.setLayoutProperty.mockImplementation((_id: string, _property: string, value: string) => {
            blocked.setVisibility(value);
        });
        blocked.handlers.get('styledata')?.();
        expect(onSafe).toHaveBeenCalledWith('hidden');
        expect(blocked.handlers.has('idle')).toBe(true);
        expect(dismiss).not.toHaveBeenCalled();

        blocked.raw.removeLayer.mockImplementation((id: string) => {
            blocked.registry.delete(id);
        });
        blocked.handlers.get('idle')?.();
        expect(onSafe).toHaveBeenLastCalledWith('absent');
        expect(dismiss).toHaveBeenCalledOnce();
        expect(blocked.handlers.size).toBe(0);
    });

    it('dismisses the owned cleanup notice when an effect disposes its monitor early', () => {
        const blocked = mapWithRegistry();
        blocked.registry.set(ID, { id: ID });
        blocked.raw.removeLayer.mockImplementation(() => {
            throw new Error('blocked');
        });
        blocked.raw.setLayoutProperty.mockImplementation(() => {
            throw new Error('blocked');
        });
        const dismiss = vi.spyOn(toast, 'dismiss');

        const dispose = monitorCmemsLayerDeactivation(blocked.map, ID, 'Currents', vi.fn());
        dispose();
        dispose();

        expect(dismiss).toHaveBeenCalledOnce();
        expect(blocked.handlers.size).toBe(0);
    });
});
