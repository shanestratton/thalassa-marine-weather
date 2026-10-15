/**
 * Point meteogram · layout fixture (131-02). The real Meteogram with the
 * app's CSS and its real spread request through the proxy, answered here
 * with fictional numbers only: a week off Brisbane (UTC+10, no clock change),
 * a blow on Saturday, the wave forecast ending after three days, rain on
 * Sunday and a front on Tuesday, four models in the spread.
 *
 * ?open=<0-23>: the place's hour the sheet opens at (default 10: a 14 h
 * Friday and a 10 h Friday at the ends, the 131-02 review's case)
 * &units=metric|imperial  &top=<px>&bottom=<px> (the device's safe-area
 * insets)  &fonts=wide  &largeText
 *
 * env() is 0 in a desktop browser, so the device's real insets are painted
 * where the app's env() would put them: the overlay's band and the tab bar.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import type { HourlyForecast, UnitPreferences } from '../../types';

if (!import.meta.env.DEV) throw new Error('The meteogram fixture is available only through the development server.');

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
const H = 3_600_000;
const BRISBANE = { lat: -27.47, lon: 153.03 };
const OFFSET_H = 10;

// The phone's clock set to the asked-for hour in Brisbane on Fri 16 Oct 2026,
// half past, and running on from there.
const asked = Number(params.get('open') ?? 10);
const openAt = Number.isFinite(asked) ? Math.min(23, Math.max(0, Math.round(asked))) : 10;
const realNow = Date.now.bind(Date);
const skew = Date.UTC(2026, 9, 16, openAt - OFFSET_H, 30) - realNow();
Date.now = () => realNow() + skew;
const start = Math.floor(Date.now() / H) * H;

/** Open-Meteo's hours: bare stamps at the report's fixed offset, raw units (knots, feet, mm, hPa). */
const hourly: HourlyForecast[] = Array.from({ length: 170 }, (_, i) => {
    const wind = 12 + 13 * Math.exp(-(((i - 30) / 9) ** 2)) + 3 * Math.sin(i / 7);
    return {
        time: new Date(start + i * H + OFFSET_H * H).toISOString().slice(0, 16),
        windSpeed: wind,
        windGust: wind * 1.3,
        waveHeight: i < 72 ? 3 + 1.5 * Math.sin(i / 10) : null,
        swellPeriod: i < 72 ? 8 + 2 * Math.sin(i / 20) : null,
        precipitation: i >= 50 && i <= 56 ? 0.5 + 2.5 * Math.sin(((i - 50) / 6) * Math.PI) : 0,
        precipChance: 10 + 60 * Math.exp(-(((i - 53) / 6) ** 2)),
        pressure: i <= 100 ? 1016 : i <= 108 ? 1016 - 1.5 * (i - 100) : 1004 + 0.2 * (i - 108),
        temperature: 22,
        condition: 'Clear',
    } as HourlyForecast;
});

/** The spread: each model's wind, a knot or two from the next, on the comparison's epoch seconds. */
function proxyAnswer(body: { params: Record<string, string> }) {
    const hours = Number(body.params.forecast_hours);
    const t0 = Math.floor(Date.now() / H) * 3600;
    const time = Array.from({ length: hours }, (_, i) => t0 + i * 3600);
    const answer: Record<string, unknown> = { time };
    String(body.params.models)
        .split(',')
        .forEach((model, k) => {
            if (k > 3) return;
            for (const variable of String(body.params.hourly).split(',')) {
                answer[`${variable}_${model}`] = time.map((_, i) => 12 + 1.5 * (k - 1.5) + 6 * Math.sin((i + k) / 14));
            }
        });
    return { hourly: answer };
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/functions/v1/proxy-openmeteo') && typeof init?.body === 'string') {
        return new Response(JSON.stringify(proxyAnswer(JSON.parse(init.body))), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    return new Response(JSON.stringify({ error: 'Meteogram fixture: network disabled.' }), { status: 503 });
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
insets.textContent = `[data-meteogram-overlay] { padding-top: max(1rem, ${insetTop}px) !important; padding-bottom: calc(4rem + ${insetBottom}px + 1rem) !important; }`;
document.head.append(insets);

const UNITS: Record<string, UnitPreferences> = {
    metric: { speed: 'kts', temp: 'C', length: 'm', waveHeight: 'm', distance: 'nm' },
    imperial: { speed: 'mph', temp: 'F', length: 'ft', waveHeight: 'ft', distance: 'mi' },
};

const { Meteogram } = await import('../../components/weather/Meteogram');
const { MODERATE_WINDOW } = await import('../../services/vesselWindowThresholds');

function Fixture() {
    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-900 text-white">
            <p className="absolute left-4 text-sm font-bold" style={{ top: Math.max(16, insetTop) }}>
                THE GLASS · meteogram fixture
            </p>
            <Meteogram
                onClose={() => undefined}
                hourly={hourly}
                units={UNITS[params.get('units') ?? 'metric'] ?? UNITS.metric}
                limits={MODERATE_WINDOW}
                coordinates={BRISBANE}
                timeZone="Australia/Brisbane"
                utcOffset={OFFSET_H * 3600}
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
