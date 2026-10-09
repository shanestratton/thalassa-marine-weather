import React from 'react';
import { createRoot } from 'react-dom/client';
import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import type { UserSettings } from '../../types';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The anchor-antenna fixture is available only through the development server.');

/**
 * The GPS antenna aft of the bow (build 126, 126-07c), drawn by the real app
 * code at phone sizes:
 *
 *  - ?view=watch (default): the real Anchor Watch page, watching, marked at
 *    the boat's GPS with no heading to put it at the bow, so the line under the
 *    radar says so ("Marked at the GPS, 12 m aft of the bow…"). The watch
 *    itself is a fictional one off Lyttelton, New Zealand; the service only
 *    hands the page its snapshot. &units=ft for a feet skipper; &plain for the
 *    same watch marked by a phone (no line), to compare against.
 *  - ?view=vessel: the real Settings → Vessel tab, its Dimensions with "GPS
 *    antenna to bow" filled in for a 14 m boat.
 *  - &area=cable | many | none (build 126, 126-07d): the page opens on its
 *    setup view and is armed the way a skipper arms it (the real Sound Check,
 *    its audio stood in for); then the real chart-area check looks at the
 *    anchor through the real chart store and index. FICTIONAL areas are
 *    charted there in a synthetic cell that lives on this page only: a cable
 *    area (cable), or an area closed to entry, a cable area and a pipeline
 *    area (many: the note shows two and "+1 more"). none has no chart cell
 *    there (the page says so in a quiet line), to compare against.
 */

// Isolation BEFORE any application service loads: page-only storage, and no network.
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
    new Response(JSON.stringify({ error: 'Anchor-antenna fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';
const view = params.get('view') === 'vessel' ? 'vessel' : 'watch';
const length = params.get('units') === 'ft' ? 'ft' : 'm';

const [service, settingsModule, { WeatherProvider }, { AnchorWatchPage }, { VesselTab }, { AlarmAudioService }] =
    await Promise.all([
        import('../../services/AnchorWatchService'),
        import('../../stores/settingsStore'),
        import('../../context/WeatherContext'),
        import('../../components/AnchorWatchPage'),
        import('../../components/settings/VesselTab'),
        import('../../services/AlarmAudioService'),
    ]);

await settingsModule.awaitSettingsLoaded();
const FT = 0.3048;
const base = settingsModule.useSettingsStore.getState().settings;
const settings: UserSettings = {
    ...base,
    units: { ...base.units, length },
    vesselUnits: { length, beam: length, draft: length, displacement: length === 'm' ? 'kg' : 'lbs' },
    vessel: {
        ...(base.vessel ?? {}),
        name: 'Kotare',
        type: 'sail',
        length: 14 / FT,
        beam: 4.2 / FT,
        draft: 2.1 / FT,
        airDraft: 19 / FT,
        displacement: 9000,
        maxWaveHeight: 0,
        cruisingSpeed: 0,
        // 12 m aft of the bow, on the pushpit.
        gpsToBow: 39.37,
    } as UserSettings['vessel'],
};
settingsModule.useSettingsStore.setState({ settings });

// Marked at the boat's GPS with no fresh heading: the circle allows for the
// antenna twice over (24 m): 40 m of chain in 8 m, a 10 m margin.
const boat = { latitude: -43.61, longitude: 172.72 };
// &plain: the same watch marked by a phone (no allowance, no line), for comparison.
const plain = params.has('plain');
const config = {
    rodeLength: 40,
    waterDepth: 8,
    scopeRatio: 5,
    rodeType: 'chain' as const,
    safetyMargin: 10,
    ...(plain ? {} : { antennaAllowanceM: 24 }),
};
const snapshot: AnchorWatchSnapshot = {
    state: 'watching',
    anchorPosition: { ...boat, timestamp: Date.now() - 600_000 },
    vesselPosition: { ...boat, accuracy: 3, heading: 0, speed: 0, timestamp: Date.now() },
    swingRadius: service.calculateSwingRadius(config),
    distanceFromAnchor: 4,
    maxDistanceRecorded: 6,
    bearingToAnchor: 30,
    config,
    positionHistory: [],
    alarmTriggeredAt: null,
    alarmCause: null,
    watchStartedAt: Date.now() - 600_000,
    gpsAccuracy: 3,
    gpsQuality: 'precision',
    gpsQualityLabel: 'Precision GPS',
    guardianStatus: 'idle',
    setupError: null,
    gpsSource: plain ? 'native' : 'nmea',
    markedAtGps: !plain,
};
const areaCase = params.get('area');
if (areaCase) {
    // 126-07d: armed here, on this page. The anchor goes down at the boat when
    // the Sound Check is confirmed; the service only hands the page its watch.
    let current: AnchorWatchSnapshot = { ...snapshot, state: 'idle', anchorPosition: null, watchStartedAt: null };
    let listener: ((s: AnchorWatchSnapshot) => void) | null = null;
    Object.assign(service.AnchorWatchService, {
        restoreWatchState: async () => false,
        getSnapshot: () => current,
        subscribe: (next: (s: AnchorWatchSnapshot) => void) => {
            listener = next;
            return () => undefined;
        },
        setAnchor: async () => {
            const now = Date.now();
            current = { ...snapshot, anchorPosition: { ...boat, timestamp: now }, watchStartedAt: now };
            listener?.(current);
            return true;
        },
    });
    // The Sound Check plays the real alarm through this service; here it is silent.
    Object.assign(AlarmAudioService, {
        acquire: async () => 'anchor-area-fixture',
        release: async () => undefined,
        releaseEventually: () => undefined,
    });
    const box = (w: number, s: number, e: number, n: number) => ({
        type: 'Polygon' as const,
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    });
    const feature = (properties: Record<string, unknown>, w: number, s: number, e: number, n: number) => ({
        type: 'Feature' as const,
        properties,
        geometry: box(w, s, e, n),
    });
    const many = areaCase === 'many';
    if (areaCase !== 'none') {
        const { importCell } = await import('../../services/enc/EncHazardService');
        await importCell({
            cellId: 'ZZ5AREA1',
            sourceHO: 'ZZ',
            edition: 1,
            issued: '2026-10-10',
            bbox: [172.6, -43.7, 172.85, -43.5],
            layers: {
                CBLARE: { type: 'FeatureCollection', features: [feature({}, 172.7, -43.62, 172.74, -43.6)] },
                ...(many
                    ? {
                          RESARE: {
                              type: 'FeatureCollection',
                              features: [
                                  feature(
                                      { RESTRN: '7', OBJNAM: 'Fixture Exclusion Zone' },
                                      172.71,
                                      -43.615,
                                      172.73,
                                      -43.605,
                                  ),
                              ],
                          },
                          PIPARE: {
                              type: 'FeatureCollection',
                              features: [feature({}, 172.715, -43.612, 172.725, -43.608)],
                          },
                      }
                    : {}),
            },
        } as Parameters<typeof importCell>[0]);
    }
} else {
    // The watch is the service's; here it only hands the page its snapshot.
    Object.assign(service.AnchorWatchService, {
        restoreWatchState: async () => true,
        getSnapshot: () => snapshot,
        subscribe: (listener: (s: AnchorWatchSnapshot) => void) => {
            listener(snapshot);
            return () => undefined;
        },
    });
}

function TabBar() {
    // The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row above the
    // home-indicator inset, opaque.
    return (
        <nav
            aria-label="Main"
            className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
            style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
        >
            <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                <span>THE GLASS</span>
                <span>OBS</span>
                <span>PLAN</span>
                <span className="text-sky-300">VESSEL</span>
            </div>
        </nav>
    );
}

function Fixture() {
    if (view === 'vessel') {
        return (
            <main
                data-testid="vessel-settings"
                className="h-dvh overflow-y-auto bg-slate-950 px-4 pt-4 pb-24 text-white"
            >
                <VesselTab settings={settings} onSave={() => undefined} />
                <TabBar />
            </main>
        );
    }
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 text-white">
            <WeatherProvider>
                <AnchorWatchPage onBack={() => undefined} />
            </WeatherProvider>
            <TabBar />
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
