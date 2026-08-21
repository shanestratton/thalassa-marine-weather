import { describe, expect, it } from 'vitest';
import { getActiveLayerFrameZoom, LAYER_FRAME_ZOOM, type WeatherLayer } from '../components/map/mapConstants';

describe('weather-layer framing zooms', () => {
    it('opens wind and its legacy alias at z9, while rain retains its regional z5 frame', () => {
        expect(LAYER_FRAME_ZOOM.wind).toBe(9);
        expect(LAYER_FRAME_ZOOM.velocity).toBe(9);
        expect(LAYER_FRAME_ZOOM.rain).toBe(5);
        // Local-first (Shane 2026-08-22), reversing the z3 synoptic frame.
        // This also drives WindDataController onto the fine local grid, which
        // is what makes wind paint quickly — see mapConstants for the why.
        expect(getActiveLayerFrameZoom(new Set<WeatherLayer>(['wind']))).toBe(9);
        expect(getActiveLayerFrameZoom(new Set<WeatherLayer>(['velocity']))).toBe(9);
        expect(getActiveLayerFrameZoom(new Set<WeatherLayer>(['rain']))).toBe(5);
    });

    it('leaves the other weather-layer frames unchanged', () => {
        expect(LAYER_FRAME_ZOOM.currents).toBe(7.5);
        expect(LAYER_FRAME_ZOOM.pressure).toBe(2);
    });

    it('leaves an ordinary chart boot free to use its normal zoom', () => {
        expect(getActiveLayerFrameZoom(new Set())).toBeUndefined();
    });
});
