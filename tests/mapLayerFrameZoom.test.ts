import { describe, expect, it } from 'vitest';
import { getActiveLayerFrameZoom, LAYER_FRAME_ZOOM, type WeatherLayer } from '../components/map/mapConstants';

describe('weather-layer framing zooms', () => {
    it('opens both wind aliases at the regional z5 frame', () => {
        expect(LAYER_FRAME_ZOOM.wind).toBe(5);
        expect(LAYER_FRAME_ZOOM.velocity).toBe(5);
        expect(getActiveLayerFrameZoom(new Set<WeatherLayer>(['wind']))).toBe(5);
        expect(getActiveLayerFrameZoom(new Set<WeatherLayer>(['velocity']))).toBe(5);
    });

    it('leaves the other weather-layer frames unchanged', () => {
        expect(LAYER_FRAME_ZOOM.currents).toBe(7.5);
        expect(LAYER_FRAME_ZOOM.rain).toBe(7.5);
        expect(LAYER_FRAME_ZOOM.pressure).toBe(2);
    });

    it('leaves an ordinary chart boot free to use its normal zoom', () => {
        expect(getActiveLayerFrameZoom(new Set())).toBeUndefined();
    });
});
