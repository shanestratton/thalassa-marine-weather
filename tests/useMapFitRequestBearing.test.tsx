/**
 * "Show me on the map" fits keep the chart's orientation (127-11a, audit A8).
 * Mapbox's fitBounds turns the chart to 0 unless told; on a turned chart the
 * mode would then turn it straight back. The ENC cell manager's fit (and any
 * other requestMapFit) passes the mode's bearing; north up it passes 0.
 * The cell box is fictional (a Brittany-like approach).
 */
import { cleanup, renderHook } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMapFitRequest } from '../components/map/useMapFitRequest';
import { requestMapFit } from '../stores/MapFitTargetStore';
import { setChartOrientation } from '../components/map/chartOrientation';

function chart(bearing: number) {
    const map = { fitBounds: vi.fn(), flyTo: vi.fn(), getBearing: () => bearing };
    return { map, ref: { current: map as unknown as mapboxgl.Map } };
}

afterEach(() => {
    setChartOrientation({ turning: false, target: null });
    cleanup();
});

describe('useMapFitRequest on a turned chart', () => {
    it('north up: the fit says bearing 0', () => {
        const c = chart(0);
        renderHook(() => useMapFitRequest(c.ref, true));
        requestMapFit({ bbox: [-4.8, 48.2, -4.3, 48.5] });
        expect(c.map.fitBounds).toHaveBeenCalledOnce();
        expect(c.map.fitBounds.mock.calls[0][1]).toMatchObject({ bearing: 0, retainPadding: false });
    });

    it('a turning mode: the fit keeps the mode’s target, never a snap north', () => {
        setChartOrientation({ turning: true, target: 118 });
        const c = chart(110);
        renderHook(() => useMapFitRequest(c.ref, true));
        requestMapFit({ bbox: [-4.8, 48.2, -4.3, 48.5] });
        expect(c.map.fitBounds.mock.calls[0][1]).toMatchObject({ bearing: 118 });
    });
});
