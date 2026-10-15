import { describe, expect, it, vi } from 'vitest';
import { promoteTraceLayers, TRACE_LAYER_IDS } from '../components/map/isobarLayerSetup';

function chart(ids: readonly string[]) {
    const order = [...ids];
    const map = {
        getStyle: () => ({ layers: order.map((id) => ({ id })) }),
        getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
        moveLayer: vi.fn((id: string) => {
            order.splice(order.indexOf(id), 1);
            order.push(id);
        }),
    };
    return { order, map };
}

describe('trace promotion settles without style writes', () => {
    it('makes no moves on a correctly ordered full stack, including a later idle pass', () => {
        const { map } = chart(['water', ...TRACE_LAYER_IDS]);
        expect(promoteTraceLayers(map as never)).toEqual([]);
        expect(promoteTraceLayers(map as never)).toEqual([]);
        expect(map.moveLayer).not.toHaveBeenCalled();
    });

    it('keeps a correctly ordered partial stack quiet', () => {
        const { map } = chart(['water', 'trace-line-glow', 'trace-line-core']);
        expect(promoteTraceLayers(map as never)).toEqual([]);
        expect(map.moveLayer).not.toHaveBeenCalled();
    });

    it('raises a stack buried by a late chart layer, then stops writing', () => {
        const { map, order } = chart(['water', ...TRACE_LAYER_IDS, 'enc-vec-land']);
        expect(promoteTraceLayers(map as never)).toEqual([]);
        expect(order).toEqual(['water', 'enc-vec-land', ...TRACE_LAYER_IDS]);
        map.moveLayer.mockClear();
        expect(promoteTraceLayers(map as never)).toEqual([]);
        expect(map.moveLayer).not.toHaveBeenCalled();
    });

    it('repairs internal order even when the trace layers are already on top', () => {
        const { map, order } = chart(['water', ...[...TRACE_LAYER_IDS].reverse()]);
        promoteTraceLayers(map as never);
        expect(order).toEqual(['water', ...TRACE_LAYER_IDS]);
    });

    it('does nothing when no trace layers are mounted', () => {
        const { map } = chart(['water']);
        expect(promoteTraceLayers(map as never)).toEqual([]);
        expect(map.moveLayer).not.toHaveBeenCalled();
    });
});
