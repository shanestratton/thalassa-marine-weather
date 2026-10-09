/**
 * The weather bubble where the chart draws the point (126-18).
 *
 * A polar place's gold pin is drawn at 85°, just inside Web Mercator's edge,
 * because the chart cannot show anything nearer the pole. Its tap asks for the
 * weather at the TRUE point but must open the bubble, and its spot, on the
 * pin: Mapbox does not clamp a popup's latitude, so at 88° the bubble sat tens
 * of thousands of pixels above the world, and the tap looked dead. Every other
 * tap (the sea, a tracer gesture) passes no drawn point: there, the bubble
 * stays on the point itself. Fictional places only.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';

const made = vi.hoisted(() => ({
    popups: [] as Array<{ lngLat: [number, number] | null }>,
    spots: [] as Array<{ lngLat: [number, number] | null }>,
    asked: [] as Array<[number, number]>,
    buoys: [] as Array<[number, number]>,
}));

vi.mock('mapbox-gl', () => {
    class Popup {
        lngLat: [number, number] | null = null;
        constructor() {
            made.popups.push(this);
        }
        setLngLat(lngLat: [number, number]) {
            this.lngLat = [lngLat[0], lngLat[1]];
            return this;
        }
        setDOMContent() {
            return this;
        }
        addTo() {
            return this;
        }
        on() {
            return this;
        }
        remove() {
            return this;
        }
    }
    class Marker {
        lngLat: [number, number] | null = null;
        constructor() {
            made.spots.push(this);
        }
        setLngLat(lngLat: [number, number]) {
            this.lngLat = [lngLat[0], lngLat[1]];
            return this;
        }
        addTo() {
            return this;
        }
        remove() {
            return this;
        }
    }
    return { default: { Popup, Marker }, Popup, Marker };
});
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) }));
vi.mock('../components/map/WeatherInspectPopup', () => ({ WeatherInspectPopup: () => null }));
vi.mock('../services/weather/pointWeather', () => ({
    fetchPointWeather: (lat: number, lon: number) => {
        made.asked.push([lat, lon]);
        return new Promise(() => {});
    },
}));
vi.mock('../services/weather/buoys/feed', () => ({
    findNearestWaveBuoy: (lat: number, lon: number) => {
        made.buoys.push([lat, lon]);
        return new Promise(() => {});
    },
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { useWeatherInspectPopup } from '../components/map/useWeatherInspectPopup';

function openBubble() {
    const mapRef = { current: {} as mapboxgl.Map };
    const view = renderHook(() => useWeatherInspectPopup(mapRef, { current: {} }, vi.fn()));
    return view.result.current.showWeatherInspect;
}

/** Let the lazy chunks (the forecast, the buoys) resolve. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    made.popups.length = 0;
    made.spots.length = 0;
    made.asked.length = 0;
    made.buoys.length = 0;
});

describe('the weather bubble for a point the chart draws elsewhere', () => {
    it('a polar place: the forecast at 88° N, the bubble and its spot on the pin at 85°', async () => {
        openBubble()(88, 30, { lat: 85, lon: 30 });
        expect(made.popups.map((popup) => popup.lngLat)).toEqual([[30, 85]]);
        expect(made.spots.map((spot) => spot.lngLat)).toEqual([[30, 85]]);
        await settle();
        expect(made.asked).toEqual([[88, 30]]);
        expect(made.buoys).toEqual([[88, 30]]);
    });

    it('any other tap: the bubble on the point itself', async () => {
        openBubble()(-36.84, 174.76);
        expect(made.popups.map((popup) => popup.lngLat)).toEqual([[174.76, -36.84]]);
        expect(made.spots.map((spot) => spot.lngLat)).toEqual([[174.76, -36.84]]);
        await settle();
        expect(made.asked).toEqual([[-36.84, 174.76]]);
    });
});
