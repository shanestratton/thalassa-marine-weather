import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The tracer's pin listeners are bound ONCE, when a marker record is created,
 * and are never rebound — that is the reconciliation design that stopped the
 * chart going unresponsive at high pin counts.
 *
 * useTraceDraft re-mints `setCapturedCoords` on every auth identity change,
 * and each dispatcher captures its own scope and early-returns unless that
 * scope is still current. So a marker created before a sign-in held a
 * dispatcher that had quietly become a no-op. Mapbox had already moved the
 * marker and "Snapped onto the lead" had already flashed, so the drag looked
 * like it worked — then the pin snapped back on the next render, with nothing
 * logged anywhere.
 *
 * These tests drive the real hook with a fake Mapbox marker and pull the
 * dragend handler back out, which is the only way to exercise a
 * bound-once listener.
 */

const h = vi.hoisted(() => {
    const markers: InstanceType<typeof FakeMarker>[] = [];
    class FakeMarker {
        handlers: Record<string, () => void> = {};
        lngLat = { lng: 0, lat: 0 };
        el: HTMLElement;
        draggable = false;
        constructor(opts: { element: HTMLElement }) {
            this.el = opts.element;
            markers.push(this);
        }
        setLngLat(v: [number, number]) {
            this.lngLat = { lng: v[0], lat: v[1] };
            return this;
        }
        getLngLat() {
            return this.lngLat;
        }
        addTo() {
            return this;
        }
        remove() {
            return this;
        }
        setDraggable(v: boolean) {
            this.draggable = v;
            return this;
        }
        on(evt: string, fn: () => void) {
            this.handlers[evt] = fn;
            return this;
        }
        /** Simulate the skipper letting go of a dragged pin. */
        drop(lat: number, lon: number) {
            this.lngLat = { lng: lon, lat };
            this.handlers.dragend?.();
        }
    }
    return { markers, FakeMarker };
});
const markers = h.markers;

vi.mock('mapbox-gl', () => ({ default: { Marker: h.FakeMarker } }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../services/routeTracer', () => ({ snapTraceTapToLead: () => null }));

import { useTracerPinMarkers } from '../components/map/useTracerPinMarkers';

type Pin = { lat: number; lon: number };

function setup() {
    markers.length = 0;
    const map = { getZoom: () => 14 };
    const mapRef = { current: map as never };

    // Stands in for useTraceDraft: every identity change mints a NEW
    // dispatcher, and every superseded one silently early-returns — exactly
    // what isAuthIdentityScopeCurrent does inside updateDraft.
    let liveScope = 'scope-A';
    const applied: Pin[][] = [];
    const makeDispatcher = (scope: string) => (action: Pin[] | ((prev: Pin[]) => Pin[])) => {
        if (scope !== liveScope) return; // superseded identity — the silent no-op
        const prev = applied.length ? applied[applied.length - 1] : [{ lat: 1, lon: 1 }];
        applied.push(typeof action === 'function' ? action(prev) : action);
    };

    const props = {
        mapRef,
        tracerCtxRef: { current: null },
        coordCaptureMode: true,
        capturedCoords: [{ lat: 1, lon: 1 }] as Pin[],
        setCapturedCoords: makeDispatcher('scope-A') as never,
        selectedPin: null,
        setSelectedPin: vi.fn(),
        setInsertAfter: vi.fn(),
        insertAfterRef: { current: null },
        legAnchor: null,
        flashTraceFeedback: vi.fn(),
    };

    const view = renderHook((p: typeof props) => useTracerPinMarkers(p), { initialProps: props });
    return {
        view,
        props,
        applied,
        signIn: () => {
            liveScope = 'scope-B';
        },
        makeDispatcher,
    };
}

describe('tracer pin drag survives an auth identity change', () => {
    it('applies a drag on the marker created under the current identity', () => {
        const { applied } = setup();
        expect(markers).toHaveLength(1);
        act(() => markers[0].drop(2, 2));
        expect(applied).toHaveLength(1);
        expect(applied[0][0]).toEqual({ lat: 2, lon: 2 });
    });

    it('still applies the drag after the dispatcher is re-minted', () => {
        const { view, props, applied, signIn, makeDispatcher } = setup();
        expect(markers).toHaveLength(1);
        const bornBeforeSignIn = markers[0];

        // Sign-in: the old dispatcher is now a no-op and a new one arrives.
        signIn();
        act(() => {
            view.rerender({ ...props, setCapturedCoords: makeDispatcher('scope-B') as never });
        });

        // The record — and therefore its dragend listener — is REUSED, not
        // rebuilt, because the pin array did not change.
        expect(markers).toHaveLength(1);
        expect(markers[0]).toBe(bornBeforeSignIn);

        act(() => bornBeforeSignIn.drop(3, 3));

        // Before the fix this array stayed empty: the listener called the
        // scope-A dispatcher, which returned without writing, and the pin
        // snapped back on the next render.
        expect(applied).toHaveLength(1);
        expect(applied[0][0]).toEqual({ lat: 3, lon: 3 });
    });
});
