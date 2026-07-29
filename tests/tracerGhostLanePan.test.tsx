import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Ghost lanes are the "trace out of the marina" affordance: curated fairways
 * near where you are about to start, drawn dotted grey.
 *
 * They are gated behind a primitive key so a rescan cannot fire on every pin
 * edit — that gate is load-bearing, because ghostLanes is a dependency of the
 * 385-line trace-layer sync and a fresh array there costs a full setData pass.
 * But with NO pins down the key is the constant 'centre', so nothing could
 * notice a pan: the ghosts stayed wherever the tracer happened to open, however
 * far you sailed the map afterwards.
 *
 * These tests pin both halves — that a real pan rescans, and that the gate
 * still refuses everything it refused before.
 */

const h = vi.hoisted(() => ({ scans: [] as [number, number, number, number][], stableIds: false }));

vi.mock('../services/routeTracer', () => ({
    curatedLanesNear: (bbox: [number, number, number, number]) => {
        h.scans.push(bbox);
        const id = h.stableIds ? 'lane-fixed' : `lane@${bbox[0].toFixed(2)},${bbox[1].toFixed(2)}`;
        return [{ id, points: [] }];
    },
}));
vi.mock('../services/communityRoutes', () => ({ communityLanesNear: () => Promise.resolve([]) }));

import { useTracerGhostLanes } from '../components/map/useTracerGhostLanes';

function makeMap() {
    const handlers: Record<string, (() => void)[]> = {};
    let centre = { lat: 0, lng: 0 };
    return {
        map: {
            getCenter: () => centre,
            on: (evt: string, fn: () => void) => ((handlers[evt] ||= []).push(fn), undefined),
            off: (evt: string, fn: () => void) => {
                handlers[evt] = (handlers[evt] || []).filter((f) => f !== fn);
            },
        },
        panTo: (lat: number, lng: number) => {
            centre = { lat, lng };
            (handlers.moveend || []).forEach((f) => f());
        },
        moveendCount: () => (handlers.moveend || []).length,
    };
}

describe('ghost lanes follow the map when no pins are down', () => {
    it('rescans after a pan that leaves the scanned box', () => {
        h.scans.length = 0;
        const m = makeMap();
        renderHook(() => useTracerGhostLanes({ current: m.map } as never, true, []));
        expect(h.scans).toHaveLength(1);

        act(() => m.panTo(5, 5)); // far away — a genuinely new start area
        expect(h.scans).toHaveLength(2);
        expect(h.scans[1][1]).toBeCloseTo(5 - 0.05, 5);
    });

    it('ignores a small pan that stays inside the scanned box', () => {
        h.scans.length = 0;
        const m = makeMap();
        renderHook(() => useTracerGhostLanes({ current: m.map } as never, true, []));
        expect(h.scans).toHaveLength(1);

        act(() => m.panTo(0.01, 0.01)); // well within the 0.05 box
        expect(h.scans).toHaveLength(1);
    });

    it('never attaches the listener once a pin is down — the key already tracks it', () => {
        h.scans.length = 0;
        const m = makeMap();
        renderHook(() => useTracerGhostLanes({ current: m.map } as never, true, [{ lat: 1, lon: 1 }]));
        expect(h.scans).toHaveLength(1);
        expect(m.moveendCount()).toBe(0);
    });

    it('removes the listener on unmount', () => {
        h.scans.length = 0;
        const m = makeMap();
        const view = renderHook(() => useTracerGhostLanes({ current: m.map } as never, true, []));
        expect(m.moveendCount()).toBe(1);
        view.unmount();
        expect(m.moveendCount()).toBe(0);
    });

    it('keeps the previous array identity when a rescan finds the same lanes', () => {
        // A fresh array with identical contents is still a NEW identity, and
        // ghostLanes is a dep of the trace-layer sync — handing it one would
        // cost a full setData pass for no visible change.
        h.scans.length = 0;
        h.stableIds = true;
        try {
            const m = makeMap();
            const view = renderHook(() => useTracerGhostLanes({ current: m.map } as never, true, []));
            const before = view.result.current;
            act(() => m.panTo(5, 5));
            expect(h.scans).toHaveLength(2); // it really did rescan
            expect(view.result.current).toBe(before); // ...and changed nothing
        } finally {
            h.stableIds = false;
        }
    });

    it('does hand over a new array when the pan finds different lanes', () => {
        h.scans.length = 0;
        const m = makeMap();
        const view = renderHook(() => useTracerGhostLanes({ current: m.map } as never, true, []));
        const before = view.result.current;
        act(() => m.panTo(5, 5));
        expect(view.result.current).not.toBe(before);
    });
});
