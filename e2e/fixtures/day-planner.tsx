import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { VesselProfile } from '../../types/vessel';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The day-planner fixture is available only through the development server.');

// Install isolation BEFORE importing application services. Neither existing
// browser account state nor the synthetic identity can persist through this page.
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
const fixture = { synthetic: true, blockedRequests: [] as string[], providerCalls: 0 };
Object.assign(window, { __dayPlannerFixture: fixture });
// All application fetches are disabled, including same-origin development API
// proxies. Native ES-module loading still fetches the real source components.
window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    fixture.blockedRequests.push(url.pathname);
    return new Response(JSON.stringify({ error: 'Synthetic form fixture: network disabled.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
    });
};
const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'light' ? 'light' : 'dark';
const pane = params.get('pane') === 'true';
const missingPosition = params.get('position') === 'missing';
const signedOut = params.get('auth') === 'signed-out';
const frontDoor = params.get('surface') === 'plan';
const worldwide = params.get('region') === 'noumea';
document.documentElement.classList.toggle('display-light', mode === 'light');

const [{ setAuthIdentityScope }, { NmeaGpsProvider }, { piCache }, { CloudTelemetryService }, { supabase }] =
    await Promise.all([
        import('../../services/authIdentityScope'),
        import('../../services/NmeaGpsProvider'),
        import('../../services/PiCacheService'),
        import('../../services/CloudTelemetryService'),
        import('../../services/supabase'),
    ]);
setAuthIdentityScope(signedOut ? null : 'day-planner-synthetic-fixture');
Object.assign(NmeaGpsProvider, {
    getPosition: () =>
        missingPosition
            ? null
            : {
                  latitude: worldwide ? -22.278 : -20.258,
                  longitude: worldwide ? 166.439 : 148.815,
                  timestamp: Date.now(),
                  accuracy: 10,
                  heading: null,
                  speed: 0,
                  source: 'nmea',
                  satellites: 8,
                  hdop: 1,
                  fixQuality: 1,
              },
});
Object.assign(piCache, { getBaseUrl: () => null });
Object.assign(CloudTelemetryService, { readOnce: async () => null });
if (supabase) {
    supabase.auth.stopAutoRefresh();
    Object.assign(supabase.auth, {
        getSession: async () => ({
            data: {
                session: signedOut
                    ? null
                    : {
                          user: { id: 'day-planner-synthetic-fixture' },
                          access_token: 'fixture-only-not-a-token',
                      },
            },
            error: null,
        }),
    });
    Object.assign(supabase.functions, {
        invoke: async (_name: string, options: { body?: { action?: string } }) => {
            if (options.body?.action !== 'status') {
                fixture.providerCalls++;
                throw new Error('The synthetic form fixture must not calculate or save a route.');
            }
            return {
                data: {
                    enabled: false,
                    ready: false,
                    vesselProfile: false,
                    message: 'Synthetic form fixture: routing is disabled. No provider or account request was made.',
                },
                error: null,
            };
        },
    });
}

const [{ DayPlannerEntry }, { PanePortalScope }] = await Promise.all([
    import('../../components/dayPlanner/DayPlannerEntry'),
    import('../../context/PanePortalContext'),
]);
const vessel: VesselProfile = {
    name: 'Synthetic Whitsundays yacht',
    type: 'sail',
    hullType: 'monohull',
    length: 40,
    beam: 12,
    draft: 1.8 * 3.28084,
    airDraft: 50,
    displacement: 12000,
    cruisingSpeed: 6,
    maxWindSpeed: 20,
    maxWaveHeight: 6,
};
const rejectSavedPlan = () => {
    throw new Error('No saved plan exists in the form-only fixture.');
};
// Use the production Plan front door and its real context, without mounting
// SettingsProvider (which starts account/fleet sync). A loading settings gate
// suppresses weather initialization; only the in-memory synthetic vessel is used.
let planFrontDoor: React.ReactNode = null;
if (frontDoor) {
    const [{ RoutePlanner }, { WeatherProvider }, { awaitSettingsLoaded, useSettingsStore }, { useUIStore }] =
        await Promise.all([
            import('../../components/RoutePlanner'),
            import('../../context/WeatherContext'),
            import('../../stores/settingsStore'),
            import('../../stores/uiStore'),
        ]);
    await awaitSettingsLoaded();
    useSettingsStore.setState({
        settings: {
            ...useSettingsStore.getState().settings,
            vessel,
            mapboxToken: '',
            defaultLocation: undefined,
            defaultLocationCoords: undefined,
            displayMode: mode,
        },
        loading: true,
    });
    useUIStore.setState({ isOffline: true });
    setAuthIdentityScope(signedOut ? null : 'day-planner-synthetic-fixture');
    planFrontDoor = (
        <WeatherProvider>
            <RoutePlanner onTriggerUpgrade={() => undefined} />
        </WeatherProvider>
    );
}

function Fixture() {
    const frame = useRef<HTMLElement>(null);
    return (
        <main className="flex h-dvh w-full overflow-hidden bg-slate-950 text-white" data-mode={mode}>
            {pane && <aside className="w-1/2 shrink-0 bg-slate-900 p-4 text-slate-300">Companion tablet pane</aside>}
            <PanePortalScope enabled={pane} paneId="day-planner-fixture" frameRef={frame}>
                <section
                    ref={frame}
                    data-testid="day-planner-pane"
                    data-split-pane={pane ? 'day-planner-fixture' : undefined}
                    className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${frontDoor ? 'flex flex-col' : 'p-4'}`}
                >
                    {frontDoor ? (
                        // Match App's outer page scroller: short phones can
                        // scroll the existing cards above the pinned CTA.
                        <div className="h-full overflow-y-auto overflow-x-hidden">{planFrontDoor}</div>
                    ) : (
                        <>
                            <h1 className="mb-3 text-xl font-bold">Plan · local visual fixture</h1>
                            <p className="mb-5 text-xs text-slate-400">
                                Synthetic vessel, account and yacht coordinates. No real GPS, route calculations, chart
                                assertions or account writes. Storage exists only in this page.
                            </p>
                            <DayPlannerEntry vessel={vessel} mapboxToken="" onOpenSaved={rejectSavedPlan} />
                        </>
                    )}
                </section>
            </PanePortalScope>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
