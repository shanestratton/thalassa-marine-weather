import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { TraceLegVerdict } from '../../services/routeTracer';
import type { VoyagePlan, VesselProfile } from '../../types';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The chart-words fixture is available only through the development server.');

// Charts stay on the boat (127-C-b): the words a skipper reads where chart
// facts were not kept, inside the app shell with the real tab bar. Page-only
// storage and no network. Fictional places, cells and figures (the repo is
// public): Nouméa and Tromsø over protected charts (OC-99-ZZTEST, ZZ5TEST1),
// the Chesapeake over an open NOAA chart (US5XX01M), where nothing changes.
//
// ?view=legs | sweep | caveats — the Route tracer's leg rows, the departure
//   planner on a plan opened again, and RoutePlanner's saved-plan notes.
// &place=noumea | chesapeake | tromso   &mode=dark | light | night
// &root=app (the app's fluid root)   &largeText   &fonts=wide   &pane=true
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
    new Response(JSON.stringify({ error: 'Chart-words fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
const view = (['legs', 'sweep', 'caveats'] as const).find((v) => v === params.get('view')) ?? 'legs';
const place = (['noumea', 'chesapeake', 'tromso'] as const).find((p) => p === params.get('place')) ?? 'noumea';
const mode = params.get('mode') === 'light' ? 'light' : params.get('mode') === 'night' ? 'night' : 'dark';
const pane = params.get('pane') === 'true';
document.documentElement.classList.toggle('display-light', mode === 'light');
document.documentElement.style.fontSize = params.has('largeText')
    ? '24px'
    : params.get('root') === 'app'
      ? 'clamp(13px, 4vw, 17px)'
      : '16px';
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}

const [
    { setAuthIdentityScope },
    { awaitSettingsLoaded, useSettingsStore },
    { PanePortalScope },
    { TracerWaypointList },
    { DepartureSweepSheet },
    { savedInshoreRouteCaveats },
    { chartFreeVoyagePlan, stubLegVerdict, TRACE_LAND_CROSSING_MESSAGE },
    { NIGHT_SCRIM_Z_INDEX },
] = await Promise.all([
    import('../../services/authIdentityScope'),
    import('../../stores/settingsStore'),
    import('../../context/PanePortalContext'),
    import('../../components/map/tracer/TracerWaypointList'),
    import('../../components/passage/DepartureSweepSheet'),
    import('../../components/map/inshoreRouteNotice'),
    import('../../services/chartFacts'),
    import('../../components/ui/OverlayPortal'),
]);
setAuthIdentityScope('chart-words-synthetic-fixture');
await awaitSettingsLoaded();

const DRAFT_FT = 7.87;
const vessel: VesselProfile = {
    name: 'Fictional sloop',
    type: 'sail',
    length: 40,
    beam: 13,
    draft: DRAFT_FT,
    displacement: 20000,
    maxWaveHeight: 10,
    cruisingSpeed: 6,
    draftConfirmedFt: DRAFT_FT,
};
useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, vessel } });

const PLACES = {
    noumea: { lat: -22.27, lon: 166.41, cell: 'OC-99-ZZTEST', from: 'Port Moselle', to: 'Ilot Maitre' },
    tromso: { lat: 69.65, lon: 18.95, cell: 'ZZ5TEST1', from: 'Tromsø havn', to: 'Kvaløya' },
    chesapeake: { lat: 38.95, lon: -76.45, cell: 'US5XX01M', from: 'Annapolis', to: 'Whitehall Bay' },
};
const at = PLACES[place];
const pins = [0, 1, 2, 3, 4].map((i) => ({ lat: at.lat - i * 0.012, lon: at.lon + i * 0.011 }));
const line = pins.map((p) => [p.lon, p.lat] as [number, number]);

const leg = (
    grade: TraceLegVerdict['grade'],
    message: string | null,
    minDepthM: number,
    needsTide = false,
): TraceLegVerdict => ({
    grade,
    issues: message ? [{ severity: grade === 'clear' ? 'info' : grade, message, at: pins[1] }] : [],
    minDepthM,
    minAt: pins[1],
    needsTide,
    nudge: null,
    nudgeTo: null,
});
const full: TraceLegVerdict[] = [
    leg('clear', null, 6.4),
    leg('caution', 'thin water — 1.6 m charted at low tide', 1.6),
    leg('caution', 'needs +0.4 m tide over the bar', 2.5, true),
    leg('danger', TRACE_LAND_CROSSING_MESSAGE, 0),
];
// Over licensed charts the bank keeps grade stubs; NOAA legs come back whole.
const verdicts = place === 'chesapeake' ? full : full.map(stubLegVerdict);

const plan: VoyagePlan = {
    origin: at.from,
    destination: at.to,
    departureDate: '2026-10-11T07:00:00.000Z',
    originCoordinates: pins[0],
    destinationCoordinates: pins[4],
    distanceApprox: '3.1 NM',
    durationApprox: '0.6 hours',
    overview: 'Inshore passage',
    waypoints: [],
    routeGeoJSON: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: line },
        properties: {
            source: 'inshore-router',
            distanceNM: 3.1,
            cellsUsed: [at.cell],
            shallowRuns: [
                { startSeg: 1, endSeg: 2, lengthM: 420, minDepthM: 1.6, midLat: pins[2].lat, midLon: pins[2].lon },
            ],
            structuresUnknownCells: [at.cell],
            pinOffWater: { destination: 'drying' },
            dryRuns: [
                {
                    startSeg: 2,
                    startT: 0.2,
                    endSeg: 2,
                    endT: 0.6,
                    lengthM: 280,
                    mid: [pins[2].lon, pins[2].lat],
                    place: 'the Fictive Bank',
                    shallowestM: -0.6,
                    deepestM: 0.4,
                    draftM: 2.4,
                    needM: 2.9,
                    tide: { topM: 1.6, days: 14 },
                },
            ],
        },
    },
    __inshoreRouting: {
        status: 'success',
        cellsUsed: [at.cell],
        distanceNM: 3.1,
        caveats: [
            'Red on this route: the Fictive Bank dries 0.6 m and you need 2.9 m (2.40 m draft + 0.50 m under the keel).',
            'Bridges and power lines not checked on this chart — known bridges are. Check the chart for anything overhead against your air draft before you pass under it.',
        ],
    },
} as VoyagePlan;
// The plan as a relaunch reads it back from the device.
const reopened = chartFreeVoyagePlan(plan);

const panel = mode === 'light' ? 'bg-white text-slate-900' : 'bg-slate-900/95 text-white';

// The tracer card is MapHub's (w-72), clamped to the screen so that large
// text (a 24 px root makes w-72 432 px) measures the words, not the card.
function Body() {
    if (view === 'legs')
        return (
            <div
                data-fixture-card
                className={`map-tracer-card absolute left-3 top-3 bottom-3 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-amber-500/30 shadow-2xl ${panel}`}
            >
                <div className="border-b border-white/10 px-3 py-2 text-xs font-black">
                    🧭 Trace route ({pins.length})
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <TracerWaypointList
                        capturedCoords={pins}
                        legVerdicts={verdicts}
                        tideLabels={place === 'chesapeake' ? { 2: 'clears 09:10–13:30 today' } : {}}
                        tideAnchor={null}
                        departureMs={null}
                        departureLabel={null}
                        mapRef={{ current: null }}
                        pulseMarkHalo={() => undefined}
                        onRegradeStub={() => undefined}
                    />
                </div>
            </div>
        );
    if (view === 'sweep')
        return (
            <DepartureSweepSheet
                open
                onClose={() => undefined}
                voyagePlan={reopened}
                vessel={vessel}
                onAccept={() => undefined}
            />
        );
    const caveats = savedInshoreRouteCaveats(reopened);
    return (
        <div className="absolute inset-x-3 top-3">
            {/* RoutePlanner's saved-plan notes, as RoutePlanner.tsx draws them. */}
            <div
                className="pointer-events-auto mt-1.5 w-full px-4 py-2 rounded-xl bg-slate-900/90 border border-amber-500/20 backdrop-blur-xs"
                role="note"
                data-testid="plan-route-caveats"
            >
                {caveats.map((c) => (
                    <p key={c} className="text-[11px] leading-snug text-amber-100/90">
                        {c}
                    </p>
                ))}
            </div>
        </div>
    );
}

function Fixture() {
    const frame = useRef<HTMLElement>(null);
    return (
        <main
            className={`flex h-dvh w-full overflow-hidden font-sans ${
                mode === 'light' ? 'bg-slate-200 text-slate-900' : 'bg-slate-950 text-white'
            } ${pane ? 'gap-2 bg-black p-2 pb-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)]' : 'pb-16'}`}
        >
            {pane && (
                <aside className="min-w-0 flex-1 rounded-2xl bg-slate-900 p-4 text-slate-300">
                    Companion tablet pane
                </aside>
            )}
            <PanePortalScope enabled={pane} paneId="chart-words-fixture" frameRef={frame}>
                <section
                    ref={frame}
                    data-testid="chart-words-pane"
                    data-split-pane={pane ? 'chart-words-fixture' : undefined}
                    className={
                        pane
                            ? 'relative h-full min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/25'
                            : 'relative min-h-0 min-w-0 flex-1 overflow-hidden'
                    }
                >
                    <Body />
                </section>
            </PanePortalScope>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row
                above the home-indicator inset, opaque. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{
                    background: mode === 'light' ? '#f8fafc' : 'rgb(10, 15, 20)',
                    borderColor: 'rgba(56, 189, 248, 0.12)',
                }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span className="text-sky-300">PLAN</span>
                    <span>VESSEL</span>
                </div>
            </nav>
            {mode === 'night' && (
                <div
                    aria-hidden="true"
                    data-testid="night-scrim"
                    className="pointer-events-none fixed inset-0"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                />
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
(window as unknown as { __chartWordsReady?: boolean }).__chartWordsReady = true;
