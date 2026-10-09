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
// too-late | noumea | tromso | thunder. Opened at 06:30 on Thursday 8 October 2026 at
// Airlie Beach, except too-late (16:00 that day) and tromso (08:00 CEST on
// 21 June 2026, under the midnight sun). noumea and tromso are worldwide
// starts: OpenStreetMap places only, no Queensland atlas, no coastline.
// thunder is the default boat on a light morning with thunder in three models
// from noon: the window headline at its longest, over the default-boat notice.
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
    | 'thunder';
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
];
const mode: Mode = MODES.find((m) => m === params.get('mode')) ?? 'normal';
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

const [{ setAuthIdentityScope }, { awaitSettingsLoaded }, { PanePortalScope }, sheetModule, data] = await Promise.all([
    import('../../services/authIdentityScope'),
    import('../../stores/settingsStore'),
    import('../../context/PanePortalContext'),
    import('../../components/dayPlanner/TodaySheet'),
    import('../../tests/helpers/dayPlanFixtures'),
]);
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
const start = mode === 'noumea' ? data.NOUMEA : mode === 'tromso' ? TROMSO : data.MARINA;
const worldwide = mode === 'noumea' || mode === 'tromso';
// Tromsø's OpenStreetMap cells were cached three days ago: used, with their date.
const mappedMs = nowMs - 72 * data.H;
const loader = data.fakeTodayDeps({
    scenario: mode === 'over' || mode === 'offline' || mode === 'split' || mode === 'thunder' ? mode : 'normal',
    nowMs,
    atlas: worldwide ? [] : atlas,
    osm:
        mode === 'noumea'
            ? [
                  data.osmAnchorage(910001, 'Fixture Anse', { lat: -22.33, lon: 166.42 }),
                  data.osmAnchorage(910002, 'Fixture Baie', { lat: -22.36, lon: 166.55 }),
                  data.osmAnchorage(910003, 'Fixture Îlot', { lat: -22.41, lon: 166.38 }),
              ]
            : mode === 'tromso'
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
const io = {
    loader,
    readBoat: async () =>
        mode === 'no-position'
            ? null
            : { latitude: start.lat, longitude: start.lon, timestamp: nowMs - 2 * data.H, rung: 'cloud' as const },
    readPhone: async () => null,
    geocode: async () => null,
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
                        <TodaySheet
                            vessel={vessel}
                            usingDefaultVessel={defaultBoat}
                            onClose={() => setOpen(false)}
                            onPlot={(action) => {
                                fixture.plotted.push(action);
                                setOpen(false);
                            }}
                            onOpenVessel={() => fixture.openedVessel++}
                            io={io}
                        />
                    )}
                </section>
            </PanePortalScope>
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
