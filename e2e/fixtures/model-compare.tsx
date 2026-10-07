/**
 * Ten-day model comparison · layout fixture. The real sheet
 * (ModelComparisonMatrix) with the app's CSS and its real two-request fetch
 * path, answered here by a stubbed proxy with fictional numbers only: a point
 * off Faial in the Azores, seven models, each ending where it did
 * through the proxy on 2026-10-07 (ICON 167 h, UKMO 155 h, GEM 227 h).
 *
 * ?tab=wind|dir|gust|wave|vis …  &top=<px>&bottom=<px> (the device's safe-area
 * insets)  &fonts=wide  &largeText  &state=ready|failed
 *
 * env() is 0 in a desktop browser, so the device's real insets are painted
 * where the app's env() would put them: the overlay's band and the tab bar.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The model-compare fixture is available only through the development server.');

// Isolation BEFORE any application service loads: page-only storage, and the
// one network call the sheet makes answered here.
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
const failed = params.get('state') === 'failed';
const HOUR_S = 3600;
const LAST_HOUR: Record<string, number> = { dwd_icon: 166, ukmo_global_deterministic_10km: 154, gem_seamless: 226 };
/** No gust from AIFS or JMA, visibility only from UKMO and GFS, UV only from GFS. */
const PUBLISHES: Record<string, string[]> = {
    wind_gusts_10m: ['dwd_icon', 'ecmwf_ifs025', 'ukmo_global_deterministic_10km', 'gfs_seamless', 'gem_seamless'],
    visibility: ['ukmo_global_deterministic_10km', 'gfs_seamless'],
    uv_index: ['gfs_seamless'],
};
/** Each variable's level, how far it swings over the ten days, and how far
 *  apart neighbouring models sit: realistic magnitudes, so BARO draws
 *  four-digit ticks and values and DIR a spread of tens of degrees. */
const SHAPE: Record<string, [base: number, swing: number, apart: number]> = {
    wind_speed_10m: [14, 5, 1],
    wind_gusts_10m: [19, 7, 1.5],
    wind_direction_10m: [230, 40, 6],
    pressure_msl: [1016, 8, 1.2],
    temperature_2m: [19, 3, 0.4],
    relative_humidity_2m: [78, 10, 3],
    precipitation: [0.4, 0.4, 0.1],
    visibility: [24_000, 6_000, 2_000],
    uv_index: [4, 3, 0.3],
    wave_height: [1.8, 0.6, 0.15],
    wave_period: [9, 2, 0.4],
};

function proxyAnswer(body: { operation: string; params: Record<string, string> }) {
    const hours = Number(body.params.forecast_hours);
    const t0 = Math.floor(Date.now() / 3_600_000) * HOUR_S;
    const time = Array.from({ length: hours }, (_, i) => t0 + i * HOUR_S);
    const hourly: Record<string, unknown> = { time };
    String(body.params.models)
        .split(',')
        .forEach((model, k) => {
            for (const variable of String(body.params.hourly).split(',')) {
                if (PUBLISHES[variable] && !PUBLISHES[variable].includes(model)) continue;
                const last = LAST_HOUR[model] ?? hours - 1;
                const [base, swing, apart] = SHAPE[variable] ?? [10, 3, 1];
                hourly[`${variable}_${model}`] = time.map((_, i) =>
                    i > last ? null : Math.max(0, base + apart * (k - 3) + swing * Math.sin((i + 2 * k) / 14)),
                );
            }
        });
    return { hourly };
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!failed && url.endsWith('/functions/v1/proxy-openmeteo') && typeof init?.body === 'string') {
        return new Response(JSON.stringify(proxyAnswer(JSON.parse(init.body))), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    return new Response(JSON.stringify({ error: 'Model-compare fixture: network disabled.' }), { status: 503 });
};

document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';
// The Linux CI runner draws DejaVu Sans, far wider than the Mac's face:
// Verdana here, DejaVu Sans there, the same wraps on both.
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}
const insetTop = Math.max(0, Number(params.get('top')) || 0);
const insetBottom = Math.max(0, Number(params.get('bottom')) || 0);
const insets = document.createElement('style');
insets.textContent = `[role="presentation"]:has(> [aria-labelledby="model-comparison-title"]) { padding-top: max(1rem, ${insetTop}px) !important; padding-bottom: calc(4rem + ${insetBottom}px + 1rem) !important; }`;
document.head.append(insets);

const { ModelComparisonMatrix } = await import('../../components/dashboard/ModelComparisonMatrix');
type Tab = NonNullable<React.ComponentProps<typeof ModelComparisonMatrix>['initialParam']>;

function Fixture() {
    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-900 text-white">
            <p className="absolute left-4 text-sm font-bold" style={{ top: Math.max(16, insetTop) }}>
                THE GLASS · model comparison fixture
            </p>
            <ModelComparisonMatrix
                visible
                onClose={() => undefined}
                selectedModel="ecmwf_ifs025"
                initialParam={(params.get('tab') ?? 'wind') as Tab}
                coordinates={{ lat: 38.52, lon: -28.7 }}
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
                    <span className="text-sky-300">THE GLASS</span>
                    <span>OBS</span>
                    <span>PLAN</span>
                    <span>VESSEL</span>
                </div>
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
