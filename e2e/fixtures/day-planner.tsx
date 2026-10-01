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
const fixture = {
    synthetic: true,
    blockedRequests: [] as string[],
    providerCalls: 0,
    catalogueRequests: [] as { name: string; args: Record<string, unknown> }[],
};
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
const catalogueMode = params.get('catalogue');
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
    // Synthetic public RPC payloads exercise the real parser, adapter and picker.
    // They are created in memory; every other application network path stays blocked.
    const catalogueId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const stamp = Date.now();
    const summary = {
        entry_id: catalogueId(1),
        version: 1,
        kind: 'trip',
        name: 'Synthetic island visit with a deliberately long departure and destination name for narrow phone screens',
        summary:
            'Synthetic source reference used to inspect the catalogue picker. No real route or destination is approved.',
        latitude: worldwide ? -22.278 : -20.258,
        longitude: worldwide ? 166.439 : 148.815,
        distance_nm: 0,
        status: 'published',
        review_status: 'reviewed',
        reviewed_at: new Date(stamp - 60_000).toISOString(),
        review_due_at: new Date(stamp + 86_400_000).toISOString(),
    };
    const detail = {
        ...summary,
        reviewer_label: 'Synthetic fixture editor',
        review_scope: 'Synthetic layout data only; no source review or navigation verification.',
        evidence: [
            {
                source_url: 'https://example.com/synthetic-catalogue-source-for-mobile-containment',
                source_label: 'Synthetic source with a deliberately long description to verify mobile text wrapping',
                retrieved_at: new Date(stamp - 120_000).toISOString(),
                licence: 'Synthetic fixture value only; no real licence asserted',
                licence_url: 'https://example.com/synthetic-licence',
                attribution: 'Synthetic fixture',
                scope: 'Layout checks only',
            },
        ],
        limitations: [
            'Synthetic reference only. Approach, shore access, shelter, current conditions and mooring availability remain unverified.',
        ],
        activities: [],
        origin_destination_id: catalogueId(2),
        origin_destination_version: 1,
        destination_id: catalogueId(3),
        destination_version: 1,
        trip_id: null,
        trip_version: null,
        direction: null,
        checkpoints: null,
        variants: [
            {
                entry_id: catalogueId(4),
                version: 1,
                direction: 'outbound',
                name: 'Synthetic outbound reference with a long label to check narrow-phone select containment',
            },
            ...(catalogueMode === 'missing-return'
                ? []
                : [
                      {
                          entry_id: catalogueId(5),
                          version: 1,
                          direction: 'return',
                          name: 'Synthetic separately reviewed return reference with a long label',
                      },
                  ]),
        ],
        variants_truncated: false,
    };
    Object.assign(supabase, {
        rpc: (name: string, args: Record<string, unknown>) => {
            fixture.catalogueRequests.push({ name, args });
            const data =
                name === 'nearby_cruising_catalogue'
                    ? catalogueMode
                        ? [summary]
                        : []
                    : name === 'cruising_catalogue_detail' && args.p_id === catalogueId(1) && args.p_version === 1
                      ? detail
                      : null;
            const response = Promise.resolve({ data, error: null });
            return Object.assign(response, {
                abortSignal: (signal: AbortSignal) =>
                    signal.aborted
                        ? Promise.reject(new DOMException('Synthetic read cancelled', 'AbortError'))
                        : response,
            });
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
    // Confirmed, so Plan Your Day opens at once; the ask itself is
    // browser-tested in draft-confirm-layout.spec.ts.
    draftConfirmedFt: 1.8 * 3.28084,
    airDraft: 50,
    displacement: 12000,
    cruisingSpeed: 6,
    maxWindSpeed: 20,
    maxWaveHeight: 6,
};
const rejectSavedPlan = () => {
    throw new Error('No saved plan exists in the form-only fixture.');
};
const rejectUpgrade = () => {
    throw new Error('Upgrade is not part of the form-only fixture.');
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
    // That scope switch reloads settings and drops the seeded vessel, so the
    // front door ran on no profile at all. Plan Your Day now asks for a draft
    // when there is none, so put the synthetic (confirmed) vessel back.
    await awaitSettingsLoaded();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, vessel } });
    planFrontDoor = (
        <WeatherProvider>
            <RoutePlanner onTriggerUpgrade={() => undefined} />
        </WeatherProvider>
    );
} else {
    // Plan Your Day opens once the ACTIVE profile's draft is confirmed, so the
    // in-memory store carries the same synthetic (confirmed) vessel.
    const { awaitSettingsLoaded, useSettingsStore } = await import('../../stores/settingsStore');
    await awaitSettingsLoaded();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, vessel } });
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
                            <DayPlannerEntry
                                vessel={vessel}
                                mapboxToken=""
                                onOpenSaved={rejectSavedPlan}
                                isPro
                                onUpgrade={rejectUpgrade}
                            />
                        </>
                    )}
                </section>
            </PanePortalScope>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
