import { describe, expect, it } from 'vitest';
import {
    getActiveLayerFrameZoom,
    LAYER_FRAME_ZOOM,
    LAYER_MIN_ZOOM,
    type WeatherLayer,
} from '../components/map/mapConstants';
import { RAINVIEWER_NATIVE_MAX_ZOOM } from '../services/weather/api/rainviewerTiles';

describe('weather-layer framing zooms', () => {
    it('opens wind at z9 local-first, rain at its regional z5 frame', () => {
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

    // ── Framing zoom vs zoom floor are different questions ────────────
    // They shared a number once: wind's floor was max(LAYER_FRAME_ZOOM.wind, 3),
    // which was right only because the frame also happened to be 3. Moving the
    // frame to z9 moved the floor with it and pinned the chart at one zoom
    // level — the map would not zoom out at all.
    it('lets wind open local at z9 while still pinching out to z3', () => {
        expect(LAYER_FRAME_ZOOM.wind).toBe(9);
        expect(LAYER_MIN_ZOOM.wind).toBe(3);
        expect(LAYER_MIN_ZOOM.velocity).toBe(3);
        // The floor must be strictly below the frame, or there is no range to
        // zoom through — that IS the bug, expressed as an invariant.
        expect(LAYER_MIN_ZOOM.wind!).toBeLessThan(LAYER_FRAME_ZOOM.wind!);
    });

    it('keeps pressure derived so its frame and floor cannot drift apart', () => {
        // Pressure genuinely opens at its widest, and when these two
        // disagreed the floor silently won and the framing ease looked like it
        // never fired. Derived, not duplicated.
        expect(LAYER_MIN_ZOOM.pressure).toBe(LAYER_FRAME_ZOOM.pressure);
    });

    it('keeps rain within one step of RainViewer native tiles', () => {
        // Rain's frame is a dial Shane is still turning (z5 → z8 → z5 across
        // 22-23 Aug). This is the constraint that does NOT move: past
        // RAINVIEWER_NATIVE_MAX_ZOOM (7) Mapbox overzooms the z7 image, so a
        // closer frame buys VIEW, not detail — and beyond z8 it is purely
        // magnifying the same pixels.
        expect(LAYER_FRAME_ZOOM.rain!).toBeLessThanOrEqual(RAINVIEWER_NATIVE_MAX_ZOOM + 1);
    });
});
