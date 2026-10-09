/**
 * Sounding sheet · layout fixture (build 125, SND). The real sheet with the
 * app's CSS and its real two-call fetch path through the proxy, answered here
 * with fictional numbers only:
 *  - trades:    off Martinique, UTC−4: a trade lid at 925–850 hPa, a 70 kt jet.
 *  - inversion: off Monterey, UTC−7: an 8 °C subsidence inversion, no jet.
 *  - gale:      the central North Sea, UTC+2: unstable (CAPE 650), a trough coming.
 *  - front:     off southern Chile, UTC−3: stable and saturated to 500 hPa, a
 *               trough coming; southern-hemisphere barbs.
 *
 * ?scenario=trades|inversion|gale|front  &units=metric|imperial|kmh
 * &palette=dark|day|night  &state=ok|unavailable|needs-update|error
 * &top=<px>&bottom=<px> (the device's safe-area insets)  &fonts=wide
 *
 * env() is 0 in a desktop browser, so the device's real insets are painted
 * where the app's env() would put them: the overlay's band and the tab bar.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The sounding fixture is available only through the development server.');

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
const state = params.get('state') ?? 'ok';
const scenarioName = (params.get('scenario') ?? 'trades') as keyof typeof SCENARIOS;

/** p, T °C, Td °C, height m, wind km/h, from °. */
type Level = [number, number, number, number, number, number];
interface Scenario {
    lat: number;
    lon: number;
    offsetH: number;
    surface: { t: number; td: number; mslp: number; kmh: number; dir: number; cape: number };
    levels: Level[];
    /** 500 hPa height change over 24 h (m). */
    z500Day: number;
}

const SCENARIOS = {
    trades: {
        lat: 14.5,
        lon: -61,
        offsetH: -4,
        surface: { t: 27, td: 22, mslp: 1014, kmh: 28, dir: 85, cape: 60 },
        levels: [
            [1000, 25.5, 21, 125, 32, 85],
            [925, 21, 18, 795, 38, 90],
            [850, 18.5, 5, 1535, 25, 100],
            [700, 9.5, -8, 3165, 22, 140],
            [500, -5.5, -30, 5885, 30, 250],
            [300, -31, -55, 9660, 80, 260],
            [250, -41, -62, 10960, 130, 245],
        ],
        z500Day: 38,
    },
    inversion: {
        lat: 36.5,
        lon: -122,
        offsetH: -7,
        surface: { t: 15, td: 12, mslp: 1016, kmh: 22, dir: 310, cape: 0 },
        levels: [
            [1000, 13.5, 11.5, 135, 20, 310],
            [925, 21.5, 2, 800, 15, 330],
            [850, 20, -5, 1520, 15, 340],
            [700, 8, -15, 3140, 25, 300],
            [500, -12, -35, 5820, 40, 280],
            [300, -38, -50, 9500, 60, 270],
            [250, -48, -58, 10800, 70, 270],
        ],
        z500Day: -80,
    },
    gale: {
        lat: 56,
        lon: 3,
        offsetH: 2,
        surface: { t: 11, td: 8, mslp: 992, kmh: 65, dir: 225, cape: 650 },
        levels: [
            [1000, 12, 9, -60, 60, 220],
            [925, 5, 3, 620, 70, 230],
            [850, 0, -2, 1280, 80, 240],
            [700, -11, -14, 2800, 90, 245],
            [500, -30, -34, 5310, 120, 250],
            [300, -52, -58, 8780, 170, 255],
            [250, -55, -62, 10010, 200, 255],
        ],
        z500Day: -150,
    },
    front: {
        lat: -42.5,
        lon: -75.5,
        offsetH: -3,
        surface: { t: 10, td: 9.6, mslp: 990, kmh: 55, dir: 320, cape: 5 },
        levels: [
            [1000, 10.5, 10.3, -80, 60, 340],
            [925, 7, 6.4, 560, 75, 330],
            [850, 3, 2.3, 1220, 80, 320],
            [700, -5, -6.2, 2740, 95, 310],
            [500, -23, -24.5, 5100, 120, 300],
            [300, -47, -55, 8650, 150, 290],
            [250, -54, -62, 9850, 160, 290],
        ],
        z500Day: -120,
    },
} satisfies Record<string, Scenario>;

const scenario: Scenario = SCENARIOS[scenarioName] ?? SCENARIOS.trades;
const rhFor = (t: number, td: number) =>
    Math.min(100, 100 * Math.exp((17.625 * td) / (243.04 + td) - (17.625 * t) / (243.04 + t)));

function proxyAnswer(body: { params: Record<string, string | number> }) {
    const hours = Number(body.params.forecast_hours);
    const t0 = Math.floor(Date.now() / 3_600_000) * 3600;
    const time = Array.from({ length: hours }, (_, i) => t0 + i * 3600);
    const hourly: Record<string, unknown> = { time };
    const s = scenario.surface;
    const diurnal = (i: number) => 1.5 * Math.sin(((i + scenario.offsetH) / 24) * 2 * Math.PI);
    for (const name of String(body.params.hourly).split(',')) {
        const m = /^(\w+?)_(\d+)hPa$/.exec(name);
        const lv = m ? scenario.levels.find((l) => l[0] === Number(m[2])) : undefined;
        const series = (i: number): number | null => {
            if (state === 'unavailable' && m) return null;
            if (lv) {
                const [p, t, td, z, kmh, dir] = lv;
                if (m![1] === 'temperature') return t + (p >= 850 ? diurnal(i) / 2 : 0);
                if (m![1] === 'relative_humidity') return rhFor(t, td);
                if (m![1] === 'geopotential_height') return p === 500 ? z + (scenario.z500Day * i) / 24 : z;
                if (m![1] === 'wind_speed') return kmh;
                if (m![1] === 'wind_direction') return dir;
            }
            if (name === 'temperature_2m') return s.t + diurnal(i);
            if (name === 'dew_point_2m') return s.td;
            if (name === 'pressure_msl') return s.mslp;
            if (name === 'wind_speed_10m') return s.kmh;
            if (name === 'wind_direction_10m') return s.dir;
            if (name === 'cape') return s.cape;
            return null;
        };
        hourly[name] = time.map((_, i) => series(i));
    }
    return {
        latitude: Number(body.params.latitude),
        longitude: Number(body.params.longitude),
        elevation: 0,
        utc_offset_seconds: scenario.offsetH * 3600,
        hourly,
    };
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/functions/v1/proxy-openmeteo') && typeof init?.body === 'string') {
        if (state === 'needs-update') return new Response('{"error":"Invalid request"}', { status: 400 });
        if (state === 'error') return new Response('{"error":"Weather upstream unavailable"}', { status: 502 });
        return new Response(JSON.stringify(proxyAnswer(JSON.parse(init.body))), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    return new Response(JSON.stringify({ error: 'Sounding fixture: network disabled.' }), { status: 503 });
};

// The house fixtures' root size: the band the spec measures is 4rem + 1rem of 16 px. (The app's own
// fluid root is 13 px at 320 wide, which leaves the sheet more room than this, never less.)
document.documentElement.style.fontSize = '16px';
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}
const palette = (params.get('palette') ?? 'dark') as 'dark' | 'day' | 'night';
if (palette === 'day') document.documentElement.classList.add('display-light');
const insetTop = Math.max(0, Number(params.get('top')) || 0);
const insetBottom = Math.max(0, Number(params.get('bottom')) || 0);
const insets = document.createElement('style');
insets.textContent = `[data-sounding-overlay] { padding-top: max(1rem, ${insetTop}px) !important; padding-bottom: calc(4rem + ${insetBottom}px + 1rem) !important; }`;
document.head.append(insets);

const UNITS = {
    metric: { speed: 'kts', temp: 'C', length: 'm' },
    imperial: { speed: 'mph', temp: 'F', length: 'ft' },
    kmh: { speed: 'kmh', temp: 'C', length: 'm' },
} as const;

const { SoundingSheet } = await import('../../components/sounding/SoundingSheet');

function Fixture() {
    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-900 text-white">
            <p className="absolute left-4 text-sm font-bold" style={{ top: Math.max(16, insetTop) }}>
                OBS · sounding fixture
            </p>
            <SoundingSheet
                lat={scenario.lat}
                lon={scenario.lon}
                units={UNITS[(params.get('units') ?? 'metric') as keyof typeof UNITS] ?? UNITS.metric}
                palette={palette}
                onClose={() => undefined}
            />
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
