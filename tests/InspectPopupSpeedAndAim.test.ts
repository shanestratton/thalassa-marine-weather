/**
 * The inspect bubble: quicker, and pointing at something.
 *
 * Shane, 2026-09-05: "we need to fix up the Inspect layer. i would like it to
 * be quicker. and when you select a spot to Inspect, can we have a little
 * arrow on the box that comes up to show you exactly where the spot is."
 *
 * QUICKER had three separate causes, all of them ours rather than the network's.
 * There was NO CACHE and NO DEDUPE in fetchPointWeather, so every tap paid full
 * latency — including a double tap and the back-and-forth of comparing two
 * spots. And Promise.allSettled held the whole answer behind the SLOWER of the
 * two requests, so the bubble sat on a spinner with wind, pressure and
 * temperature already in hand.
 *
 * POINTING AT SOMETHING: the popup's own tip was `display: none`, and the
 * bubble is offset 8px and flips side near a screen edge — so it floated with
 * nothing tying it to the water it described.
 *
 * The honesty constraint that comes with painting early: a marine block that
 * has not answered yet must read as 'pending', never as 'land' or
 * 'unavailable'. Those are three different facts and the punter can tell.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const point = strip(read('services/weather/pointWeather.ts'));
const hook = strip(read('components/map/useWeatherInspectPopup.tsx'));
const popup = strip(read('components/map/WeatherInspectPopup.tsx'));
const css = read('index.css');

describe('point weather is cached and deduped', () => {
    it('serves a repeat tap on the same cell from memory', () => {
        expect(point).toMatch(/const POINT_CACHE_TTL_MS = 10 \* 60 \* 1000;/);
        expect(point).toMatch(/const hit = pointCache\.get\(key\);/);
        expect(point).toMatch(/if \(hit && Date\.now\(\) - hit\.at < POINT_CACHE_TTL_MS\) return hit\.data;/);
    });

    it('rounds to a cell coarser than the model grid it is asking', () => {
        // 0.01 degrees is ~1.1 km. Two taps inside that are the same question.
        expect(point).toMatch(/lat\.toFixed\(2\)\},\$\{lon\.toFixed\(2\)\}/);
    });

    it('joins an in-flight request instead of opening a second socket', () => {
        expect(point).toMatch(/const existing = inflight\.get\(key\);/);
        expect(point).toMatch(/if \(existing\) return existing;/);
        // And clears it however the request ends.
        expect(point).toMatch(/finally \{\s*inflight\.delete\(key\);/);
    });

    it('bounds the cache, so panning a coast cannot grow it forever', () => {
        expect(point).toMatch(/const POINT_CACHE_MAX = 120;/);
        expect(point).toMatch(/pointCache\.delete\(oldest\)/);
    });
});

describe('the atmospherics do not wait for the sea', () => {
    it('reports the forecast half as soon as it lands', () => {
        expect(point).toMatch(/onPartial\?: \(partial: PointWeatherData\) => void/);
        expect(point).toMatch(/marineStatus: 'pending'/);
        // allSettled over BOTH would reinstate the wait.
        expect(point).not.toContain('Promise.allSettled');
    });

    it('still fires both requests together — this is not serialisation', () => {
        const load = point.slice(point.indexOf('async function loadPointWeather'));
        const forecast = load.indexOf('const forecastPromise = fetchForecastPoint');
        const marine = load.indexOf('const marinePromise = fetchMarinePoint');
        expect(forecast).toBeGreaterThan(-1);
        expect(marine).toBeGreaterThan(forecast);
        // Both created before either is awaited.
        expect(marine).toBeLessThan(load.indexOf('await forecastPromise'));
    });

    it('never lets an early marine rejection surface as unhandled', () => {
        // Nothing awaits it for a second or two; without this it is an
        // unhandled rejection in that window.
        expect(point).toMatch(/const marineSettled = marinePromise\.then\(/);
    });

    it('the popup paints from the partial', () => {
        expect(hook).toMatch(/fetchPointWeather\(lat, lon, \(partial\) => \{/);
        const cb = hook.slice(hook.indexOf('fetchPointWeather(lat, lon, (partial)'));
        expect(cb.slice(0, 400)).toContain('view.loading = false;');
        // The staleness guard still applies to the partial.
        expect(cb.slice(0, 400)).toContain('inspectRootRef.current !== root');
    });

    it('says "loading", not "land", while the sea is still coming', () => {
        expect(popup).toMatch(/const marinePending = data\?\.marineStatus === 'pending';/);
        expect(popup).toContain('Sea state loading');
        // The three states stay three different sentences.
        expect(popup).toContain("data?.marineStatus === 'land'");
        expect(popup).toContain("data?.marineStatus === 'unavailable'");
    });
});

describe('the bubble points at the spot', () => {
    it('shows the popup tip instead of hiding it', () => {
        const block = css.slice(css.indexOf('.weather-inspect-popup .mapboxgl-popup-tip'));
        expect(block.slice(0, 200)).toContain('display: block');
        expect(block.slice(0, 200)).not.toContain('display: none');
    });

    it('colours the tip for every anchor, because the bubble flips', () => {
        // Mapbox builds the tip from border colours on a zero-size box, so the
        // side that shows depends on which way the popup opened.
        for (const anchor of ['anchor-top', 'anchor-bottom', 'anchor-left', 'anchor-right']) {
            expect(css, anchor).toContain(`.weather-inspect-popup.mapboxgl-popup-${anchor} .mapboxgl-popup-tip`);
        }
    });

    it('also marks the exact coordinate, so an offset bubble is unambiguous', () => {
        expect(hook).toMatch(/new mapboxgl\.Marker\(\{ element: spotEl, anchor: 'center' \}\)/);
        expect(hook).toMatch(/\.setLngLat\(\[lon, lat\]\)/);
        expect(css).toContain('.weather-inspect-spot');
        // A ring, not a blob — the pixel being reported stays visible.
        expect(css.slice(css.indexOf('.weather-inspect-spot'), css.indexOf('.weather-inspect-spot') + 300)).toContain(
            'border-radius: 9999px',
        );
    });

    it('clears the marker on BOTH close paths, or it strands on the chart', () => {
        // closeOnClick fires the popup's own close without going through
        // closeWeatherInspect.
        const closes = hook.match(/inspectSpotRef\.current = null;/g) ?? [];
        expect(closes.length).toBeGreaterThanOrEqual(2);
    });
});
