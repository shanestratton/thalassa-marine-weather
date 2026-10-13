import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The day-planner fixture is available only through the development server.');

// Plan Your Day, "Today on the water" (build 124), on synthetic sources: the
// real sheet, engine and loader, fed by fake I/O (seven models at one point,
// route wind and sea, tides) and the real Whitsundays atlas tile from public/.
// Page-only storage and no network: nothing here reaches an account, a
// provider or a boat. Fictional vessel, identity and places outside Queensland.
//
// ?mode= normal | split | over | offline | no-position | default-boat |
// too-late | noumea | tromso | thunder | routed | no-route | no-chart. Opened at 06:30 on Thursday 8 October 2026 at
// Airlie Beach, except too-late (16:00 that day) and tromso (08:00 CEST on
// 21 June 2026, under the midnight sun). noumea and tromso are worldwide
// starts: OpenStreetMap places only, no Queensland atlas, no coastline.
// thunder is the default boat on a light morning with thunder in three models
// from noon: the window headline at its longest, over the default-boat notice.
//
// Routing the stop she opens (127-PYD-2): ?owner=1 is the owner's account (a
// fictional one: `io.ownerAccount`), the only one offered "Route round the
// land" in 127. `io.routeStop` is the real routeStop over a fake provider: a
// synthetic line bent between her pins, no network, its stages held for
// ?hold= ms (default 1500) so the sheet can be scrolled while it "routes", and
// a fixed 6.4 s wall time. routed is an ordinary Airlie day with Auto route
// (trial) on; no-route the same with it off; no-chart starts at Nouméa, where
// the provider has no chart for the stop (the global sentence); tromso, for
// the owner, is Auto's charts-from-the-Pi refusal with no Pi paired.
// ?draft=ask leaves her draft unconfirmed, so the tap asks first. ?refuse=bucket
// (with ?pi=1, a Pi paired), ?refuse=fill or ?refuse=pack is one of Auto's long
// refusals, whole: its charts-from-the-Pi sentence, a cloud fill that failed
// (its 60 chars), or a pin far from water with the harbour water not downloaded.
// ?coast=ring makes every estimate its longest (below).
//
// The routed line on the chart (127-PYD-3): "Show route on chart" opens Auto's chart in its day-plan
// mode over the sheet, with a stub Auto provider (ready, never calculates) and no Mapbox network, so
// its chart may say it could not load; "Use on the main chart" lands in `plotted` as a routed plot-day
// action, and "Plot by hand" as a frame action with no pins.
//
// The leave window (127-PYD-11): routed-tide routes a line of 20 vertices a leg with a shallow bit on its
// bend and a pin that dries at the stop, over an interpolated (approx) synthetic tide whose low water is
// 4 h 45 after the page opens (10 h at Nouméa): its longest row, red sentence and all. routed-notide is the same line with
// no tide at all ("Tide not known"). routed reads an ordinary curve. ?place=noumea starts either at Nouméa.
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
const realFetch = window.fetch.bind(window);
const fixture = { blockedRequests: [] as string[], plotted: [] as unknown[], openedVessel: 0 };
Object.assign(window, { __dayPlannerFixture: fixture });
window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    fixture.blockedRequests.push(url.pathname);
    return new Response(JSON.stringify({ error: 'Day-planner fixture: network disabled.' }), { status: 503 });
};

const params = new URLSearchParams(location.search);
type Mode =
    | 'normal'
    | 'split'
    | 'over'
    | 'offline'
    | 'no-position'
    | 'default-boat'
    | 'too-late'
    | 'noumea'
    | 'tromso'
    | 'thunder'
    | 'routed'
    | 'no-route'
    | 'no-chart'
    | 'routed-tide'
    | 'routed-notide';
const MODES: Mode[] = [
    'normal',
    'split',
    'over',
    'offline',
    'no-position',
    'default-boat',
    'too-late',
    'noumea',
    'tromso',
    'thunder',
    'routed',
    'no-route',
    'no-chart',
    'routed-tide',
    'routed-notide',
];
const mode: Mode = MODES.find((m) => m === params.get('mode')) ?? 'normal';
const owner = params.get('owner') === '1';
const pane = params.get('pane') === 'true';
const light = params.get('display') === 'light';
document.documentElement.classList.toggle('display-light', light);
// Large text: the root size the draft and Move-anchor fixtures use for the same check.
// root=app: the app's own fluid root on a phone (index.css), 13 px on a 320 SE, 15 on a 375, 17 on a Pro Max.
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
    sheetModule,
    data,
    { routeStop },
    { DraftConfirmModal },
    { AutoroutingProviderContext },
] = await Promise.all([
    import('../../services/authIdentityScope'),
    import('../../stores/settingsStore'),
    import('../../context/PanePortalContext'),
    import('../../components/dayPlanner/TodaySheet'),
    import('../../tests/helpers/dayPlanFixtures'),
    import('../../services/dayPlanner/stopRoute'),
    import('../../components/vessel/DraftConfirmModal'),
    import('../../components/autorouting/AutoroutingProviderContext'),
]);
// Auto's chart reads its provider for its status and the satellite check's Retry; it never calculates here.
const autoProvider = {
    status: () => ({ enabled: true, ready: true }),
    calculate: async () => {
        throw new Error('Plan Your Day fixture: the route chart never calculates.');
    },
};
if (owner) {
    // The app's auth store (the sheet's Sources screen pulls it in) settles this session-less page to
    // signed out a beat after load. The owner's synthetic identity is set after that, as a sign-in
    // would be, so his sheet opens signed in. (The other modes keep the page as it always loaded.)
    const { useAuthStore } = await import('../../stores/authStore');
    await new Promise<void>((done) => {
        let stop = () => {};
        const timer = setTimeout(done, 5000);
        const check = () => {
            if (!useAuthStore.getState().authChecked) return;
            clearTimeout(timer);
            stop();
            done();
        };
        stop = useAuthStore.subscribe(check);
        check();
    });
}
setAuthIdentityScope('day-planner-synthetic-fixture');
await awaitSettingsLoaded();
const TodaySheet = sheetModule.default;
const { DEFAULT_VESSEL } = await import('../../utils/defaultVessel');
const atlas = await realFetch('/anchorages/qld/t-22e148.geojson')
    .then((r) => r.json())
    .then((tile: { features: never[] }) => tile.features)
    .catch(() => []);

const TROMSO = { lat: 69.6496, lon: 18.956 };
const nowMs = mode === 'too-late' ? Date.UTC(2026, 9, 8, 6) : mode === 'tromso' ? Date.UTC(2026, 5, 21, 6) : data.NOW;
// no-chart is Nouméa's day, routed by the owner.
const at = mode === 'no-chart' || params.get('place') === 'noumea' ? 'noumea' : mode;
const start = at === 'noumea' ? data.NOUMEA : at === 'tromso' ? TROMSO : data.MARINA;
const worldwide = at === 'noumea' || at === 'tromso';
// Tromsø's OpenStreetMap cells were cached three days ago: used, with their date.
const mappedMs = nowMs - 72 * data.H;
const loader = data.fakeTodayDeps({
    scenario: mode === 'over' || mode === 'offline' || mode === 'split' || mode === 'thunder' ? mode : 'normal',
    nowMs,
    atlas: worldwide ? [] : atlas,
    osm:
        at === 'noumea'
            ? [
                  data.osmAnchorage(910001, 'Fixture Anse', { lat: -22.33, lon: 166.42 }),
                  data.osmAnchorage(910002, 'Fixture Baie', { lat: -22.36, lon: 166.55 }),
                  data.osmAnchorage(910003, 'Fixture Îlot', { lat: -22.41, lon: 166.38 }),
              ]
            : at === 'tromso'
              ? [
                    data.osmAnchorage(920001, 'Fixture Vika', { lat: 69.7, lon: 18.83 }, mappedMs),
                    data.osmAnchorage(920002, 'Fixture Sund', { lat: 69.6, lon: 19.1 }, mappedMs),
                    data.osmAnchorage(920003, 'Fixture Hamna', { lat: 69.76, lon: 19.12 }, mappedMs),
                ]
              : [],
    // No tide prediction for these fictional stops: the facts line says so.
    // Too late opens on Friday, so it has Friday's tides too (a lunar day on).
    ...(mode === 'tromso'
        ? { tides: null }
        : mode === 'too-late'
          ? {
                tides: [
                    ...data.TIDES,
                    ...data.TIDES.map((t) => ({
                        ...t,
                        time: new Date(Date.parse(t.time) + 24.84 * data.H).toISOString(),
                    })),
                ],
            }
          : {}),
});
// ?coast=ring: a synthetic shore ringing the start (about 1 NM out), so every straight line
// "crosses land" and each estimate reads "(straight line, longer round land)", its longest.
if (params.get('coast') === 'ring')
    loader.loadCoastline = async () =>
        Array.from({ length: 24 }, (_, i): [[number, number], [number, number]] => {
            const at = (k: number): [number, number] => [
                start.lon + 0.02 * Math.cos((k * Math.PI) / 12),
                start.lat + 0.017 * Math.sin((k * Math.PI) / 12),
            ];
            return [at(i), at(i + 1)];
        });
// The tide along a routed line (127-PYD-11): a synthetic semidiurnal curve, low water 4 h 45 after the page
// opens (0.5 m) between 3.5 m highs, on whatever clock the start keeps (at Nouméa's shorter hops, 10 h after,
// so her morning clears); none in routed-notide.
const lowWaterMs = nowMs + (at === 'noumea' ? 10 : 4.75) * data.H;
const tidal = mode === 'routed-tide' || mode === 'routed-notide';
loader.loadRouteTideCurve = async () =>
    mode === 'routed-notide'
        ? null
        : {
              heights: [],
              provenance: mode === 'routed-tide' ? 'EXTREMES_INTERP' : 'STATION_HEIGHTS',
              heightAt: (t: number) => 2 - 1.5 * Math.cos((2 * Math.PI * (t - lowWaterMs)) / (12.42 * data.H)),
              rangeMs: [nowMs - 48 * data.H, nowMs + 96 * data.H],
              stationName: 'Fixture Gauge',
          };
// A day the models split, for a skipper whose own limits are high enough that
// the split, not the gusts, is the story (her Comfort settings: 30 kn, gusts 40).
if (mode === 'split') {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, comfortParams: { maxWindKts: 30, maxGustKts: 40 } } });
}
const defaultBoat = mode === 'default-boat' || mode === 'thunder';
const vessel = defaultBoat
    ? DEFAULT_VESSEL
    : { ...DEFAULT_VESSEL, name: 'Synthetic yacht', length: 40, draft: 7.87, cruisingSpeed: 6 };
// The owner's boat, as the app's store holds it: her draft confirmed unless ?draft=ask, and Auto route
// (trial) on except in no-route. A tester's store is left as it loads (the switch off).
if (owner) {
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({
        settings: {
            ...settings,
            vessel:
                params.get('draft') === 'ask' ? vessel : { ...vessel, draftConfirmedFt: vessel.draft, airDraft: 59 },
            autorouteTrialEnabled: mode !== 'no-route',
        },
    });
}
const hold = Number(params.get('hold') ?? 1500);
const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Plan Your Day closed the page.', 'AbortError'));
        });
    });
const { THALASSA_BUCKET_UNREACHABLE } = await import('../../services/autoroutingThalassa');
// Each route reads 0 then 6400: "Routed in 6.4 s".
let clockReads = 0;
const io = {
    loader,
    readBoat: async () =>
        mode === 'no-position'
            ? null
            : { latitude: start.lat, longitude: start.lon, timestamp: nowMs - 2 * data.H, rung: 'cloud' as const },
    readPhone: async () => null,
    geocode: async () => null,
    // Her one fictional voyage end, read "on the phone" (127-PYD-4): Cid Harbour, or Nouméa's Fixture Baie.
    voyageEnds: async () =>
        worldwide ? (at === 'noumea' ? [{ lat: -22.36, lon: 166.551 }] : []) : [{ lat: -20.2452, lon: 148.9484 }],
    // No chart on this fixture phone: every pin reads "depth not checked".
    pinDepths: async (points: readonly unknown[]) =>
        points.map(() => ({ covered: false, hazard: false, minDepthM: null })),
    ownerAccount: async () => owner,
    routeStop: (
        req: Parameters<typeof routeStop>[0],
        opts: { signal: AbortSignal; onProgress?: (words: string) => void },
    ) =>
        routeStop(req, opts, {
            clock: () => (clockReads++ % 2) * 6400,
            piPaired: async () => params.get('pi') === '1',
            calculate: async (request, signal, onProgress) => {
                // The real provider says its first words once its module and the router's have loaded.
                await wait(400, signal);
                onProgress?.('Following deep water…');
                await wait(300, signal);
                if (mode === 'no-chart') throw new Error('No installed chart covers the destination.');
                if (mode === 'tromso' || params.get('refuse') === 'bucket')
                    throw new Error(THALASSA_BUCKET_UNREACHABLE);
                if (params.get('refuse') === 'pack')
                    throw new Error(
                        "No route by water to your destination: the nearest water Thalassa could reach is 650 m from the pin. Nothing changed. The harbour water for the destination couldn't be downloaded just now; try again shortly.",
                    );
                if (params.get('refuse') === 'fill')
                    throw new Error(
                        `Couldn't fetch the missing charts (${'Synthetic fixture: the chart shelf did not answer in time'.padEnd(60, '.')}). Check your connection and sign-in, then try again. Nothing changed.`,
                    );
                onProgress?.('Routing round the land…');
                await wait(hold, signal);
                onProgress?.('Checking the route…');
                await wait(300, signal);
                const { departure: a, destination: b } = request;
                const bend: [number, number] = [(a.lon + b.lon) / 2 + 0.03, (a.lat + b.lat) / 2 - 0.04];
                // A synthetic line bent between her pins; no chart behind it. The tide modes have 20 vertices a
                // leg, as a real route has many: the sweep times each shallow bit at its own leg's end.
                const corners: [number, number][] = [[a.lon, a.lat], bend, [b.lon, b.lat]];
                const coordinates = tidal
                    ? corners.flatMap(([lon, lat], i) =>
                          i === 2
                              ? [[lon, lat] as [number, number]]
                              : Array.from(
                                    { length: 20 },
                                    (_, k) =>
                                        [
                                            lon + ((corners[i + 1][0] - lon) * k) / 20,
                                            lat + ((corners[i + 1][1] - lat) * k) / 20,
                                        ] as [number, number],
                                ),
                      )
                    : corners;
                const last = coordinates.length - 2;
                // Its shallow bit on the bend: 1.9 m charted, so her 2.40 m draft + 0.5 m needs 1.0 m of tide.
                const onBend = { lengthM: 556, minDepthM: 1.9, midLat: bend[1], midLon: bend[0] };
                return {
                    id: 'thalassa-fixture',
                    coordinates,
                    warnings: [],
                    createdAt: new Date(nowMs).toISOString(),
                    provider: 'Thalassa',
                    engine: {
                        stateMask: coordinates.slice(1).map(() => 'green' as const),
                        shallowRuns: tidal
                            ? [
                                  { ...onBend, startSeg: 18, endSeg: 21, minAtLat: bend[1], minAtLon: bend[0] },
                                  // And red no tide clears: the stop's pin dries.
                                  {
                                      startSeg: last,
                                      endSeg: last,
                                      lengthM: 120,
                                      minDepthM: -0.4,
                                      midLat: b.lat,
                                      midLon: b.lon,
                                      endpointTail: 'destination' as const,
                                      dryTail: true as const,
                                  },
                              ]
                            : [{ ...onBend, startSeg: 1, endSeg: 1 }],
                        cellsUsed: ['OC-99-SYN001'],
                        distanceNM: 16.5,
                        elapsedMs: 4100,
                        backstop: 'verified',
                    },
                };
            },
        }),
};

function Fixture() {
    const frame = useRef<HTMLElement>(null);
    const [open, setOpen] = useState(true);
    return (
        <main
            className={`flex h-dvh w-full overflow-hidden bg-slate-950 text-white ${
                // The app's split view (App.tsx): both frames end above the tab bar.
                pane ? 'gap-2 bg-black p-2 pb-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)]' : ''
            }`}
        >
            {pane && (
                <aside className="min-w-0 flex-1 rounded-2xl bg-slate-900 p-4 text-slate-300">
                    Companion tablet pane
                </aside>
            )}
            <PanePortalScope enabled={pane} paneId="day-planner-fixture" frameRef={frame}>
                <section
                    ref={frame}
                    data-testid="day-planner-pane"
                    data-split-pane={pane ? 'day-planner-fixture' : undefined}
                    className={
                        pane
                            ? 'relative h-full min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/25 bg-slate-950 p-4'
                            : 'relative min-h-0 min-w-0 flex-1 overflow-hidden p-4'
                    }
                >
                    <h1 className="ui-page-title">Plan</h1>
                    <button
                        type="button"
                        className="mt-4 min-h-11 rounded-xl bg-white/10 px-4"
                        onClick={() => setOpen(true)}
                    >
                        Plan Your Day
                    </button>
                    {open && (
                        <AutoroutingProviderContext.Provider value={autoProvider}>
                            <TodaySheet
                                vessel={vessel}
                                usingDefaultVessel={defaultBoat}
                                mapboxToken="pk.fixture"
                                onClose={() => setOpen(false)}
                                onPlot={(action) => {
                                    fixture.plotted.push(action);
                                    setOpen(false);
                                }}
                                onOpenVessel={() => fixture.openedVessel++}
                                io={io}
                            />
                        </AutoroutingProviderContext.Provider>
                    )}
                </section>
            </PanePortalScope>
            {/* App mounts the one draft modal (127-PYD-2 asks through it). */}
            <DraftConfirmModal />
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row
                above the home-indicator inset, opaque. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span className="text-sky-300">PLAN</span>
                    <span>VESSEL</span>
                </div>
            </nav>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
