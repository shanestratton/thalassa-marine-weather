/**
 * Weather inspect bubble · layout fixture (130-04, the sea in parts). The real
 * WeatherInspectPopup with the app's CSS, fed through the real point-weather
 * fetch path: proxy-openmeteo is answered here, the forecast half with
 * fictional numbers and the marine half with the trimmed real MFWAM + GFS Wave
 * replies in tests/fixtures/sea-partitions (credited in PROVENANCE.json).
 *
 * ?scenario=gulf|northsea|tahiti|anegada|whitsundays|superior|airlie
 * &units=metric|imperial  &vessel=none|sloop|cat  &buoy=1  &fonts=wide
 * &top=<px>&bottom=<px> (the device's safe-area insets)
 * &pending=1: the bubble as it first paints, the atmospherics in and the sea
 *   still in the air (the marine request never answers)
 * &root=app: the app's own fluid root (13 px at 320 wide) in place of the
 *   house fixtures' 16 px
 *
 * The bubble is drawn as Mapbox draws it anchored 'top' just under a tap at
 * the top of the band the screen leaves (env() is 0 in a desktop browser, so
 * the device's insets are painted where the app's env() would put them), and
 * the app's tab bar is at the foot: the spec checks the Save row ends above it.
 * Times: each scenario pins its own clock in the spec (page.clock), so "now"
 * falls inside its fixture's 24 hours.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import type { NearestBuoyResult } from '../../services/weather/buoys/types';
import type { VesselProfile } from '../../types';
import type { PointWeatherData } from '../../services/weather/pointWeather';

if (!import.meta.env.DEV)
    throw new Error('The weather inspect fixture is available only through the development server.');

class FixtureStorage implements Storage {
    private entries = new Map<string, string>();
    get length() {
        return this.entries.size;
    }
    clear() {
        this.entries.clear();
    }
    getItem(key: string) {
        return this.entries.get(String(key)) ?? null;
    }
    key(index: number) {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.entries.delete(String(key));
    }
    setItem(key: string, value: string) {
        this.entries.set(String(key), String(value));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });

const params = new URLSearchParams(location.search);

/** Fictional atmospherics; the sea is the real trimmed reply named by `file`. */
const SCENARIOS = {
    gulf: { file: 'gulf-of-lion', lat: 43.0, lon: 4.5, wind: [33, 345, 46], t: 17, p: 1009 },
    northsea: { file: 'north-sea', lat: 53.5, lon: 3.0, wind: [30, 290, 41], t: 12, p: 1004 },
    tahiti: { file: 'tahiti-windward', lat: -17.55, lon: -149.05, wind: [26, 100, 35], t: 26, p: 1013 },
    anegada: { file: 'anegada', lat: 18.9, lon: -64.3, wind: [31, 75, 40], t: 28, p: 1014 },
    whitsundays: { file: 'whitehaven', lat: -20.3, lon: 149.1, wind: [22, 120, 30], t: 25, p: 1016 },
    superior: { file: 'lake-superior', lat: 47.71, lon: -87.52, wind: [24, 330, 33], t: 8, p: 1011 },
    airlie: { file: 'airlie-beach', lat: -20.268, lon: 148.718, wind: [20, 125, 28], t: 26, p: 1016 },
} as const;
const scenario = SCENARIOS[(params.get('scenario') ?? 'gulf') as keyof typeof SCENARIOS] ?? SCENARIOS.gulf;

const VESSELS: Record<string, VesselProfile | undefined> = {
    none: undefined,
    // A fictional 34 ft sloop and a fictional 40 ft catamaran.
    sloop: {
        name: 'Fixture Sloop',
        type: 'sail',
        length: 34,
        beam: 11,
        draft: 5.5,
        displacement: 12000,
        maxWaveHeight: 10,
        cruisingSpeed: 6,
    },
    cat: {
        name: 'Fixture Cat',
        type: 'sail',
        hullType: 'catamaran',
        length: 40,
        beam: 22,
        draft: 4,
        displacement: 18000,
        maxWaveHeight: 10,
        cruisingSpeed: 7,
    },
};
const vessel = VESSELS[params.get('vessel') ?? 'none'];
const pending = params.get('pending') === '1';

const realFetch = window.fetch.bind(window);
const marineReply = await (await realFetch(`/tests/fixtures/sea-partitions/${scenario.file}-2026-10-14.json`)).json();

/** The hour containing `now` in the fixture's MFWAM columns, unsuffixed — what a `current` block answers. */
function currentFromHourly(): Record<string, number | null> {
    const time: number[] = marineReply.hourly.time;
    const now = Date.now() / 1000;
    let i = 0;
    for (let k = 0; k < time.length; k++) if (time[k] <= now) i = k;
    const out: Record<string, number | null> = { time: time[i] };
    for (const [key, values] of Object.entries(marineReply.hourly as Record<string, (number | null)[]>)) {
        if (key.endsWith('_meteofrance_wave')) out[key.replace('_meteofrance_wave', '')] = values[i];
    }
    return out;
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/functions/v1/proxy-openmeteo') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { operation: string; params: Record<string, string> };
        if (body.operation === 'forecast') {
            const [speed, dir, gust] = scenario.wind;
            return Response.json({
                current: {
                    temperature_2m: scenario.t,
                    relative_humidity_2m: 72,
                    wind_speed_10m: speed,
                    wind_direction_10m: dir,
                    wind_gusts_10m: gust,
                    pressure_msl: scenario.p,
                    cloud_cover: 40,
                },
            });
        }
        if (body.operation === 'marine') {
            if (pending) return new Promise<Response>(() => undefined);
            if (body.params.hourly) return Response.json(marineReply);
            return Response.json({
                latitude: marineReply.latitude,
                longitude: marineReply.longitude,
                current: currentFromHourly(),
            });
        }
    }
    return new Response(JSON.stringify({ error: 'Weather inspect fixture: network disabled.' }), { status: 503 });
};

// The house fixtures' root size (the app's fluid root is 13 px at 320 wide: more room, but
// anything sized in rem shrinks with it, so ?root=app keeps the app's own).
if (params.get('root') !== 'app') document.documentElement.style.fontSize = '16px';
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}
const insetTop = Math.max(0, Number(params.get('top')) || 0);
const insetBottom = Math.max(0, Number(params.get('bottom')) || 0);
const imperial = params.get('units') === 'imperial';
const units = imperial
    ? { waveHeight: 'ft' as const, distance: 'mi' as const }
    : { waveHeight: 'm' as const, distance: 'nm' as const };

/** A fictional buoy 23 NM off, measured 40 minutes ago: the longest line the bubble carries. */
const buoy: NearestBuoyResult | null =
    params.get('buoy') === '1'
        ? {
              status: 'found',
              distanceNm: 23.2,
              obs: {
                  key: 'ndbc:99901',
                  network: 'ndbc',
                  label: 'NDBC 99901',
                  owner: 'NDBC',
                  lat: scenario.lat + 0.3,
                  lon: scenario.lon + 0.2,
                  time: Date.now() - 40 * 60_000,
                  hsM: 1.42,
                  periodS: 9.1,
                  fromDeg: 135,
                  sstC: 19.5,
              },
          }
        : null;

const { WeatherInspectPopup } = await import('../../components/map/WeatherInspectPopup');
const { fetchPointWeather } = await import('../../services/weather/pointWeather');
const data: PointWeatherData | null = pending
    ? // The partial the bubble first paints from: the sea's request is never answered.
      await new Promise<PointWeatherData>((resolve) => {
          void fetchPointWeather(scenario.lat, scenario.lon, resolve);
      })
    : await fetchPointWeather(scenario.lat, scenario.lon);

const bandTop = Math.max(16, insetTop);

function Fixture() {
    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-800 text-white">
            <p className="absolute left-4 text-sm font-bold" style={{ top: Math.max(16, insetTop) - 14 }}>
                OBS · weather inspect fixture
            </p>
            {/* Where Mapbox puts a popup anchored 'top' under a tap at the top of the band:
                the tap, 8 px of offset and the 9 px tip. Mapbox pins the popup at 0,0 and moves
                it by transform, so it may be as wide as its 300 px maxWidth allows. */}
            <div
                data-testid="inspect-tap"
                className="weather-inspect-spot absolute"
                style={{ left: '50%', top: bandTop, transform: 'translate(-50%, -50%)' }}
            />
            <div
                className="mapboxgl-popup weather-inspect-popup mapboxgl-popup-anchor-top absolute flex flex-col"
                style={{
                    left: 0,
                    top: 0,
                    transform: `translate(calc(50vw - 50%), ${bandTop + 8 + 9}px)`,
                    maxWidth: 300,
                }}
            >
                <div className="mapboxgl-popup-content" data-testid="inspect-bubble" style={{ minWidth: 240 }}>
                    <WeatherInspectPopup
                        data={data}
                        loading={false}
                        onClose={() => undefined}
                        buoy={buoy}
                        units={units}
                        vessel={vessel}
                        onOpenSounding={() => undefined}
                        save={{
                            suggestedName: '20.2500°S, 149.0000°E',
                            savedAs: null,
                            onSave: () => undefined,
                            onUnsave: () => undefined,
                        }}
                    />
                </div>
            </div>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, 4rem above the home indicator. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t"
                style={{
                    background: 'rgb(10, 15, 20)',
                    borderColor: 'rgba(56, 189, 248, 0.12)',
                    paddingBottom: insetBottom,
                }}
            >
                <div className="mx-auto flex h-16 items-center justify-around px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span className="text-sky-300">OBS</span>
                    <span>PLAN</span>
                    <span>VESSEL</span>
                </div>
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
