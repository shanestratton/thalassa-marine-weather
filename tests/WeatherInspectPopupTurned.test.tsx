/**
 * The tap bubble's wind arrow on a turned chart (127-11a, audit A11).
 *
 * The bubble is a mapboxgl.Popup: it stays upright on screen while the chart
 * turns. Its arrow turned by the wind's true direction alone, so on a chart
 * turned to Track up it pointed the wrong way across the water. It now
 * subtracts the chart's bearing, read when the bubble opens and on every
 * 'rotate', through a CSS variable on the bubble (no React re-render per
 * frame). The reading is fictional (a Chesapeake-like spot).
 */
import { render } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const made = vi.hoisted(() => ({
    popups: [] as Array<{ content: HTMLElement | null; close: Array<() => void> }>,
}));

vi.mock('mapbox-gl', () => {
    class Popup {
        content: HTMLElement | null = null;
        close: Array<() => void> = [];
        constructor() {
            made.popups.push(this);
        }
        setLngLat() {
            return this;
        }
        setDOMContent(node: HTMLElement) {
            this.content = node;
            return this;
        }
        addTo() {
            return this;
        }
        on(event: string, handler: () => void) {
            if (event === 'close') this.close.push(handler);
            return this;
        }
        remove() {
            for (const handler of this.close) handler();
            return this;
        }
    }
    class Marker {
        setLngLat() {
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
vi.mock('../services/weather/pointWeather', () => ({ fetchPointWeather: () => new Promise(() => {}) }));
vi.mock('../services/weather/buoys/feed', () => ({ findNearestWaveBuoy: () => new Promise(() => {}) }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { useWeatherInspectPopup } from '../components/map/useWeatherInspectPopup';
import { WeatherInspectPopup } from '../components/map/WeatherInspectPopup';
import type { PointWeatherData } from '../services/weather/pointWeather';

function turnableMap(bearing: number) {
    const handlers = new Map<string, Set<() => void>>();
    const map = {
        bearing,
        getBearing: () => map.bearing,
        on: vi.fn((event: string, fn: () => void) => {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)!.add(fn);
        }),
        off: vi.fn((event: string, fn: () => void) => handlers.get(event)?.delete(fn)),
        turn(to: number) {
            map.bearing = to;
            handlers.get('rotate')?.forEach((fn) => fn());
        },
        listening: (event: string) => handlers.get(event)?.size ?? 0,
    };
    return map;
}

beforeEach(() => {
    made.popups.length = 0;
});

describe('the bubble’s wind arrow subtracts the chart’s bearing', () => {
    it('the arrow is turned by the wind less the bubble’s --chart-bearing (0 when unset: north up as before)', () => {
        const data = {
            lat: 38.6,
            lon: -76.4,
            fetchedAt: Date.UTC(2026, 9, 7),
            marineStatus: 'available',
            windSpeedKmh: 18.52,
            windDirectionDeg: 300,
            windGustsKmh: 27.78,
            pressureMsl: 1014,
            temperatureC: 16,
            humidity: 70,
            cloudCover: 20,
            waveHeightM: null,
            wavePeriodS: null,
            waveDirectionDeg: null,
            swellHeightM: null,
            swellPeriodS: null,
            swellDirectionDeg: null,
        } as unknown as PointWeatherData;
        const { container } = render(<WeatherInspectPopup data={data} loading={false} onClose={vi.fn()} />);
        const arrow = [...container.querySelectorAll('svg')].find((svg) =>
            svg.innerHTML.includes('M12 19V5M5 12l7-7 7 7'),
        )!;
        expect(arrow.style.transform).toBe('rotate(calc(480deg - var(--chart-bearing, 0deg)))');
    });

    it('the bubble carries the bearing when it opens, follows every turn, and lets go when it closes', () => {
        const map = turnableMap(30);
        const mapRef = { current: map as unknown as mapboxgl.Map };
        const view = renderHook(() => useWeatherInspectPopup(mapRef, { current: {} }, vi.fn()));
        view.result.current.showWeatherInspect(38.6, -76.4);
        const bubble = made.popups[0].content!;
        expect(bubble.style.getPropertyValue('--chart-bearing')).toBe('30deg');
        map.turn(75);
        expect(bubble.style.getPropertyValue('--chart-bearing')).toBe('75deg');
        view.result.current.closeWeatherInspect();
        expect(map.listening('rotate')).toBe(0);
    });
});
