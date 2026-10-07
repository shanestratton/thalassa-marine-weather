/**
 * "Her wind vs the models" · layout fixture. The real card (ModelCheckCard,
 * in the real OverlayPortal) with the app's CSS, every string from the real
 * buildModelCheckView, against fictional readings only: a yacht in Quiberon
 * Bay, Brittany, with made-up model numbers.
 *
 * ?state=ranked|averaged|marina|worst|diroff|only|noneclose|loading|offline|failed|
 *        ratelimited|nomodels|offseries|phone|noreading|stale|undated|ahead|
 *        apparent|noposition|details
 * &unit=kts|mph|kmh|mps  &top=<px>&bottom=<px> (the device's safe-area insets)
 * &pane=true (the iPad split view)  &fonts=wide  &largeText
 *
 * env() is 0 in a desktop browser, so the device's real insets are painted
 * where the app's env() would put them: the overlay's band and the tab bar.
 * window.__modelCheckFixture.set(state, unit) redraws without a reload;
 * <html data-model-check-shown="state:unit"> says which is on screen.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RouteSpread } from '../../services/routeForecastSpread';
import type {
    HerAssessment,
    HerReading,
    HerRefusal,
    HerSession,
    ModelCheckView,
    ModelCheckViewInput,
    ModelSeriesState,
} from '../../components/map/boatModelCheck';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The model-check fixture is available only through the development server.');

// Isolation BEFORE any application service loads: page-only storage, no network.
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
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Model-check fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';
// The Linux CI runner draws DejaVu Sans, far wider than the Mac's face:
// Verdana here, DejaVu Sans there, the same wraps on both.
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}
const pane = params.get('pane') === 'true';
const insetTop = Math.max(0, Number(params.get('top')) || 0);
const insetBottom = Math.max(0, Number(params.get('bottom')) || 0);
if (!pane) {
    const insets = document.createElement('style');
    insets.textContent = `[data-model-check] { padding-top: max(1rem, ${insetTop}px) !important; padding-bottom: calc(4rem + ${insetBottom}px + 1rem) !important; }`;
    document.head.append(insets);
}

const [{ ModelCheckCard }, check, { parseRouteSpread }, { PanePortalScope }] = await Promise.all([
    import('../../components/map/ModelCheckAtBoat'),
    import('../../components/map/boatModelCheck'),
    import('../../services/routeForecastSpread'),
    import('../../context/PanePortalContext'),
]);
const { EMPTY_SESSION, MODEL_CHECK_MODELS, buildModelCheckView } = check;
const [ICON, ECMWF, AIFS, UKMO, JMA] = MODEL_CHECK_MODELS;

// ── Fictional data ──────────────────────────────────────────────

const HOUR = 3_600_000;
/** 14:40Z on a fictional October afternoon. */
const T = Date.UTC(2026, 9, 7, 14, 40, 0);
const QUIBERON = { lat: 47.48, lon: -3.05 };

type Values = { kt: number | null; dir?: number };
function spreadAt(models: Record<string, Values>, centreMs = T): RouteSpread {
    const hours = [-2, -1, 0, 1, 2].map((h) => Math.floor(centreMs / HOUR) * HOUR + h * HOUR);
    const hourly: Record<string, unknown> = { time: hours.map((ms) => ms / 1000) };
    for (const [id, m] of Object.entries(models)) {
        hourly[`wind_speed_10m_${id}`] = hours.map(() => m.kt);
        hourly[`wind_direction_10m_${id}`] = hours.map(() => m.dir ?? 225);
    }
    return parseRouteSpread([{ alongNm: 0, ...QUIBERON }], [{ hourly }], MODEL_CHECK_MODELS, 0, T);
}
function reading(over: Partial<HerReading> = {}): HerReading {
    return {
        kt: 14,
        at: T,
        lane: 'gateway',
        fromDeg: null,
        ...QUIBERON,
        sogKts: 6.2,
        currentKts: 0.8,
        ...over,
    };
}
/** Readings over `minutes`, newest at T. */
function over(minutes: number, speeds: number[], extra: Partial<HerReading>): HerSession {
    const n = speeds.length;
    const readings = speeds.map((kt, i) =>
        reading({ kt, at: T - minutes * 60_000 + (i * minutes * 60_000) / (n - 1), ...extra }),
    );
    return { followKey: 'boat', lane: readings[0].lane, readings };
}
const ready = (spread: RouteSpread): ModelSeriesState => ({ state: 'ready', spread });
const okFor = (session: HerSession): HerAssessment => ({
    ok: true,
    reading: session.readings[session.readings.length - 1],
});

const RANKED_SESSION: HerSession = {
    followKey: 'boat',
    lane: 'gateway',
    readings: [reading({ fromDeg: 210, currentKts: null })],
};
const RANKED_SPREAD = spreadAt({
    [ICON]: { kt: 14.5, dir: 205 },
    [ECMWF]: { kt: 11, dir: 215 },
    [AIFS]: { kt: 17.5, dir: 200 },
    [UKMO]: { kt: 22, dir: 190 },
    [JMA]: { kt: 9, dir: 230 },
});

function viewFor(state: string, unit: string): { view: ModelCheckView; details: boolean } {
    const base: Omit<ModelCheckViewInput, 'assessment' | 'session' | 'series'> = {
        follow: 'boat',
        speedUnit: unit,
        lengthUnit: 'm',
        airDraftFt: undefined,
        chartModel: 'icon',
    };
    const refused = (refusal: HerRefusal) =>
        buildModelCheckView({
            ...base,
            assessment: { ok: false, refusal },
            session: EMPTY_SESSION,
            series: null,
        });
    const herWith = (series: ModelSeriesState | null) =>
        buildModelCheckView({ ...base, assessment: okFor(RANKED_SESSION), session: RANKED_SESSION, series });
    const ranked = () => herWith(ready(RANKED_SPREAD));
    switch (state) {
        case 'details':
            return { view: ranked(), details: true };
        case 'averaged':
        case 'marina': {
            // The Pi over the boat LAN, five minutes: under way, or alongside in a marina (the shelter note).
            const session = over(5, [15.5, 16, 16.4, 15.8, 16.2, 16.1], {
                lane: 'lan',
                sogKts: state === 'marina' ? 0.2 : 5.5,
                currentKts: null,
            });
            const spread = spreadAt({
                [ICON]: { kt: 13, dir: 300 },
                [ECMWF]: { kt: 15.4, dir: 290 },
                [AIFS]: { kt: 16.8, dir: 295 },
                [UKMO]: { kt: 19, dir: 285 },
                [JMA]: { kt: null },
            });
            return {
                view: buildModelCheckView({
                    ...base,
                    airDraftFt: 18 * 3.28084,
                    assessment: okFor(session),
                    session,
                    series: ready(spread),
                }),
                details: false,
            };
        }
        case 'worst': {
            // Averaged, three models too close to call, one with no wind, current under her, a tall mast in feet.
            const session = over(6, [17, 18.5, 18, 19, 17.5, 18, 18], {
                fromDeg: 250,
                sogKts: 7.5,
                currentKts: 2.2,
            });
            const spread = spreadAt({
                [ICON]: { kt: 18.6, dir: 245 },
                [ECMWF]: { kt: 17.2, dir: 255 },
                [AIFS]: { kt: 26, dir: 250 },
                [UKMO]: { kt: 19.9, dir: 240 },
                [JMA]: { kt: null },
            });
            return {
                view: buildModelCheckView({
                    ...base,
                    lengthUnit: 'ft',
                    airDraftFt: 18 * 3.28084,
                    assessment: okFor(session),
                    session,
                    series: ready(spread),
                }),
                details: false,
            };
        }
        case 'diroff': {
            const session: HerSession = {
                followKey: 'boat',
                lane: 'gateway',
                readings: [reading({ kt: 12, fromDeg: 90 })],
            };
            const spread = spreadAt({
                [ICON]: { kt: 12, dir: 150 },
                [ECMWF]: { kt: 15, dir: 95 },
                [AIFS]: { kt: 11, dir: 85 },
                [UKMO]: { kt: 13, dir: 200 },
                [JMA]: { kt: 9, dir: 100 },
            });
            return {
                view: buildModelCheckView({ ...base, assessment: okFor(session), session, series: ready(spread) }),
                details: false,
            };
        }
        case 'only': {
            const session: HerSession = {
                followKey: 'boat',
                lane: 'cloud',
                readings: [reading({ kt: 11, lane: 'cloud', currentKts: null })],
            };
            return {
                view: buildModelCheckView({
                    ...base,
                    assessment: okFor(session),
                    session,
                    series: ready(spreadAt({ [UKMO]: { kt: 13, dir: 260 } })),
                }),
                details: false,
            };
        }
        case 'noneclose': {
            const session: HerSession = {
                followKey: 'boat',
                lane: 'gateway',
                readings: [reading({ kt: 27, fromDeg: 240 })],
            };
            const spread = spreadAt({
                [ICON]: { kt: 15, dir: 235 },
                [ECMWF]: { kt: 14, dir: 245 },
                [AIFS]: { kt: 16, dir: 240 },
                [UKMO]: { kt: 18, dir: 230 },
                [JMA]: { kt: 12, dir: 250 },
            });
            return {
                view: buildModelCheckView({ ...base, assessment: okFor(session), session, series: ready(spread) }),
                details: false,
            };
        }
        case 'loading':
            return { view: herWith(null), details: false };
        case 'offline':
            return { view: herWith({ state: 'offline' }), details: false };
        case 'failed':
            return { view: herWith({ state: 'failed', retryInMs: 3 * 60_000 }), details: false };
        case 'ratelimited':
            return { view: herWith({ state: 'rate-limited', retryInMs: 30 * 60_000 }), details: false };
        case 'nomodels':
            return { view: herWith({ state: 'no-models' }), details: false };
        case 'offseries':
            return { view: herWith(ready(spreadAt({ [ICON]: { kt: 14 } }, T - 30 * HOUR))), details: false };
        case 'phone':
            return { view: refused({ kind: 'phone' }), details: false };
        case 'noreading':
            return { view: refused({ kind: 'no-reading' }), details: false };
        case 'stale':
            return { view: refused({ kind: 'stale', ageMs: 2 * 60_000 }), details: false };
        case 'undated':
            return { view: refused({ kind: 'undated' }), details: false };
        case 'ahead':
            return { view: refused({ kind: 'ahead', aheadMs: 2 * 60_000 }), details: false };
        case 'apparent':
            return { view: refused({ kind: 'apparent-only' }), details: false };
        case 'noposition':
            return { view: refused({ kind: 'no-position' }), details: false };
        default:
            return { view: ranked(), details: false };
    }
}

// ── The page ────────────────────────────────────────────────────

type Shown = { state: string; unit: string };
let show: ((next: Shown) => void) | null = null;
Object.assign(window, {
    __modelCheckFixture: { set: (state: string, unit: string) => show?.({ state, unit }) },
});

const noop = () => {};

function Fixture() {
    const [shown, setShown] = useState<Shown>({
        state: params.get('state') ?? 'ranked',
        unit: params.get('unit') ?? 'kts',
    });
    const frame = useRef<HTMLElement>(null);
    useEffect(() => {
        show = setShown;
        return () => {
            show = null;
        };
    }, []);
    useEffect(() => {
        document.documentElement.dataset.modelCheckShown = `${shown.state}:${shown.unit}`;
    }, [shown]);
    const { view, details } = viewFor(shown.state, shown.unit);
    const card = (
        <ModelCheckCard view={view} details={details} onToggleDetails={noop} onClose={noop} speedUnit={shown.unit} />
    );
    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-900 text-white">
            <div
                aria-hidden="true"
                className="absolute inset-0 opacity-20"
                style={{
                    backgroundImage:
                        'linear-gradient(#64748b 1px, transparent 1px), linear-gradient(90deg, #64748b 1px, transparent 1px)',
                    backgroundSize: '44px 44px',
                }}
            />
            {pane ? (
                <div
                    className="absolute inset-0 flex gap-2 px-2"
                    style={{ paddingTop: insetTop + 8, paddingBottom: 64 + insetBottom + 8 }}
                >
                    <aside
                        className="min-w-0 flex-1 rounded-2xl bg-slate-900 p-4 text-slate-300"
                        aria-label="Companion pane"
                    >
                        The Glass (companion pane)
                    </aside>
                    <PanePortalScope enabled paneId="model-check-fixture" frameRef={frame}>
                        <section
                            ref={frame}
                            data-split-pane="model-check-fixture"
                            className="relative h-full min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/25 bg-slate-950"
                        >
                            <p className="p-4 text-xs font-bold text-slate-400">OBS (pane)</p>
                            {card}
                        </section>
                    </PanePortalScope>
                </div>
            ) : (
                <>
                    <p className="absolute left-4 text-sm font-bold" style={{ top: Math.max(16, insetTop) }}>
                        OBS · model check fixture
                    </p>
                    {card}
                </>
            )}
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
