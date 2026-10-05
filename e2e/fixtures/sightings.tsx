/**
 * Sightings · layout fixture. The real Sightings page, quick log sheet,
 * Scuttlebutt card and Log page pill with the app's CSS, against fictional
 * data only (the Kittiwake Run, skipper Wren Hollis, crew Tamsin Reyes).
 *
 * No network at all: every fetch is answered here. Supabase REST calls get
 * this file's rows (honouring the observer/boat filters), or the "not pushed
 * yet" codes, or a network failure; the bundled species list is the only
 * request that reaches the dev server. Storage is page-only.
 *
 * ?screen=page|quick|scuttlebutt|logpill|logentry  &tab=crew|public|mine
 * &mode=dark|light|night  &pane=true  &auth=signed-out
 * &feed=live|notpushed|offline|empty|stuck  &position=boat|silent|none
 * (stuck: two sightings waiting for a position, one recent, one old, and
 * one the server refused)
 */
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatChannel } from '../../services/ChatService';
import type { LocalSighting, PublicSighting, ServerSightingRow, SightingRow } from '../../services/sightings/types';
import type { SightingContext } from '../../services/sightings/sightingContext';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The sightings fixture is available only through the development server.');

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
const screenName = params.get('screen') ?? 'page';
const mode = params.get('mode') ?? 'dark';
const pane = params.get('pane') === 'true';
const signedOut = params.get('auth') === 'signed-out';
const feed = params.get('feed') ?? 'live';
const position = params.get('position') ?? 'boat';
const tab = params.get('tab');
document.documentElement.classList.toggle('display-light', mode === 'light');
if (tab) localStorage.setItem('thalassa_sightings_tab_v1', tab);
if (params.get('seen') !== 'false') localStorage.setItem('thalassa_sightings_seen_v1', '1');

const WREN = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const TAMSIN = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const KITTIWAKE_RUN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function serverRow(id: string, observer: string, over: Partial<ServerSightingRow>): ServerSightingRow {
    return {
        id,
        observer_id: observer,
        vessel_owner_id: WREN,
        boat_id: KITTIWAKE_RUN,
        voyage_id: 'voyage_1759620000000_kr01',
        visibility: 'crew',
        taxon_group: 'whale',
        scientific_name: null,
        vernacular_name: null,
        taxon_rank: null,
        individual_count: 1,
        count_is_estimate: false,
        has_calf: false,
        behavior: null,
        observed_distance_m: null,
        event_date: ago(30),
        created_at: ago(29),
        updated_at: ago(29),
        decimal_latitude: -20.2635,
        decimal_longitude: 148.9733,
        position_accuracy_m: 10,
        coordinate_uncertainty_in_meters: 14,
        position_source: 'bus',
        position_fix_at: ago(30),
        sampling_protocol: 'opportunistic vessel-based observation',
        sea_temp_c: 24.1,
        sea_temp_source: 'instrument',
        water_depth_m: 18.4,
        depth_reference: 'below-keel',
        wind_speed_kts: 14,
        wind_dir_deg: 135,
        wind_source: 'instrument',
        wave_height_m: 1.2,
        wx_model: 'ecmwf_ifs025',
        sog_kts: 6.2,
        cog_deg: 42,
        heading_deg: 40,
        occurrence_remarks: null,
        photo_paths: [],
        observer_display: observer === WREN ? 'Wren' : 'Tamsin',
        credit_public: false,
        basis_of_record: 'HumanObservation',
        client_version: 'thalassa/fixture',
        ...over,
    };
}

const SERVER_ROWS: ServerSightingRow[] = [
    serverRow('0d8b3c6e-1f2a-4b5c-9d7e-8f9a0b1c2d3e', WREN, {
        taxon_group: 'whale',
        scientific_name: 'Megaptera novaeangliae',
        vernacular_name: 'Humpback whale',
        individual_count: 2,
        has_calf: true,
        behavior: 'Breaching',
        observed_distance_m: 500,
        event_date: ago(18),
        occurrence_remarks: 'Mother and calf, calf breaching twice. We stopped and drifted.',
    }),
    serverRow('1e9c4d7f-2a3b-4c5d-8e6f-9a0b1c2d3e4f', TAMSIN, {
        taxon_group: 'turtle',
        scientific_name: 'Chelonia mydas',
        vernacular_name: 'Green turtle',
        visibility: 'public',
        event_date: ago(150),
        decimal_latitude: -20.0712,
        decimal_longitude: 148.9013,
    }),
    serverRow('2fa05e80-3b4c-4d5e-9f70-0b1c2d3e4f5a', WREN, {
        taxon_group: 'seabird',
        scientific_name: 'Sula leucogaster',
        vernacular_name: 'Brown booby',
        individual_count: 6,
        behavior: 'Following the boat',
        event_date: ago(290),
        decimal_latitude: -20.1489,
        decimal_longitude: 148.9902,
    }),
    serverRow('3ab16f91-4c5d-4e6f-8a81-1c2d3e4f5a6b', TAMSIN, {
        taxon_group: 'dolphin',
        individual_count: 5,
        event_date: ago(380),
        decimal_latitude: -20.1023,
        decimal_longitude: 148.9551,
    }),
    serverRow('4bc27a02-5d6e-4f70-9b92-2d3e4f5a6b7c', TAMSIN, {
        taxon_group: 'fish',
        scientific_name: 'Scomberomorus commerson',
        vernacular_name: 'Spanish mackerel',
        event_date: ago(60 * 26),
        decimal_latitude: -20.3011,
        decimal_longitude: 149.0102,
    }),
];

const PUBLIC_ROWS: PublicSighting[] = [
    ['whale', 'Megaptera novaeangliae', 'Humpback whale', 3, 190, 790, false, null, -20.255, 148.955],
    ['turtle', 'Chelonia mydas', 'Green turtle', 1, 250, 7850, true, null, -20.05, 148.95],
    ['seabird', 'Fregata ariel', 'Lesser frigatebird', 2, 310, 790, false, 'salt-and-light', -20.145, 148.985],
    ['shark_ray', 'Mobula alfredi', 'Reef manta ray', 1, 370, 7850, true, null, -20.25, 149.05],
    ['dugong', 'Dugong dugon', 'Dugong', 1, 60 * 27, 7850, true, null, -20.35, 148.85],
    // Group only: always the coarse grid (it may be named a threatened species later).
    ['whale', null, null, 1, 60 * 30, 7850, true, null, -20.25, 148.95],
].map(([group, sci, name, count, minutes, unc, gen, credit, lat, lon], i) => ({
    sighting_id: `5cd38b13-6e7f-4a81-8ca3-3e4f5a6b7c8${i}`,
    taxon_group: group as PublicSighting['taxon_group'],
    scientific_name: sci as string | null,
    vernacular_name: name as string | null,
    taxon_rank: sci ? 'species' : null,
    individual_count: count as number,
    has_calf: false,
    event_time: ago(minutes as number),
    latitude: lat as number,
    longitude: lon as number,
    uncertainty_m: unc as number,
    generalised: gen as boolean,
    credit: credit as string | null,
}));

// ── the network: answered here, never sent ──
const originalFetch = window.fetch.bind(window);
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin === location.origin && url.pathname.includes('species-qld-gbr')) return originalFetch(input, init);
    if (url.pathname.includes('/rest/v1/')) {
        if (feed === 'offline') throw new TypeError('Failed to fetch');
        if (feed === 'notpushed') {
            const rpc = url.pathname.includes('/rpc/');
            return json(
                rpc
                    ? { code: 'PGRST202', message: 'Could not find the function' }
                    : { code: 'PGRST205', message: 'Could not find the table' },
                404,
            );
        }
        if (url.pathname.endsWith('/rpc/get_public_sightings')) return json(feed === 'empty' ? [] : PUBLIC_ROWS);
        if (url.pathname.endsWith('/rest/v1/sightings')) {
            if (method !== 'GET') return new Response(null, { status: method === 'POST' ? 201 : 204 });
            if (feed === 'empty') return json([]);
            const observer = url.searchParams.get('observer_id')?.replace(/^eq\./, '');
            const owner = url.searchParams.get('vessel_owner_id')?.replace(/^eq\./, '');
            return json(
                SERVER_ROWS.filter(
                    (r) =>
                        (!observer || r.observer_id === observer) &&
                        (!owner || r.vessel_owner_id === owner) &&
                        (observer || r.visibility !== 'private'),
                ),
            );
        }
        return json([]);
    }
    return json({ error: 'Sightings fixture: network disabled.' }, 503);
};

const [
    { setAuthIdentityScope },
    { setSightingStoreBackend, memoryBackend, putLocalSighting, putSightingMeta },
    { localFromServer },
    { useSettingsStore, awaitSettingsLoaded },
    { useWeatherStore },
    { useUIStore },
    { PanePortalScope },
    { NIGHT_SCRIM_Z_INDEX },
    { SightingsPage },
    { QuickLogSheet },
    { ChannelList },
    { LiveVoyageCard },
    { LogSightingEntry },
    { parseCatalogue },
] = await Promise.all([
    import('../../services/authIdentityScope'),
    import('../../services/sightings/sightingStore'),
    import('../../services/sightings/sightingSync'),
    import('../../stores/settingsStore'),
    import('../../stores/weatherStore'),
    import('../../stores/uiStore'),
    import('../../context/PanePortalContext'),
    import('../../components/ui/OverlayPortal'),
    import('../../components/sightings/SightingsPage'),
    import('../../components/sightings/QuickLogSheet'),
    import('../../components/chat/ChannelList'),
    import('../../pages/log/LiveVoyageCard'),
    import('../../components/sightings/LogSightingEntry'),
    import('../../services/sightings/catalogue'),
]);

setSightingStoreBackend(memoryBackend());
setAuthIdentityScope(signedOut ? null : WREN);
await awaitSettingsLoaded();
useSettingsStore.setState({
    activeVesselId: signedOut ? null : KITTIWAKE_RUN,
    settings: {
        ...useSettingsStore.getState().settings,
        vessel: {
            name: 'Kittiwake Run',
            type: 'sail',
            length: 40,
            beam: 13,
            draft: 6.2,
            displacement: 20000,
            maxWaveHeight: 10,
            cruisingSpeed: 6,
        },
    },
});
useWeatherStore.setState({
    weatherData: {
        coordinates: { lat: -20.27, lon: 148.95 },
        locationName: 'Airlie Beach',
        generatedAt: new Date().toISOString(),
    } as never,
});
useUIStore.setState({ isOffline: feed === 'offline', currentView: 'sightings' });

// This phone's copies: Wren's server rows (synced), plus unsent ones when offline.
if (!signedOut) {
    await putSightingMeta(WREN, 'own-crew-count', 1);
    for (const row of SERVER_ROWS.filter((r) => r.observer_id === WREN)) {
        await putLocalSighting(localFromServer(row, WREN));
    }
    if (feed === 'offline') {
        await putSightingMeta(WREN, `crew-feed:${WREN}`, {
            ownerId: WREN,
            fetchedAt: NOW - 47 * 60_000,
            rows: SERVER_ROWS,
        });
        for (const [i, group] of (['dolphin', 'seabird', 'whale'] as const).entries()) {
            const synced = localFromServer(
                serverRow(`6de49c24-7f80-4b92-8db4-4f5a6b7c8d9${i}`, WREN, {
                    taxon_group: group,
                    event_date: ago(5 + i * 7),
                }),
                WREN,
            );
            const pending: LocalSighting = {
                ...synced,
                sync: {
                    state: 'pending',
                    op: 'insert',
                    serverKnown: false,
                    attempts: 1,
                    lastError: null,
                    nextAttemptAt: null,
                },
                serverUpdatedAt: null,
            };
            await putLocalSighting(pending);
        }
    }
    if (feed === 'stuck') {
        const stuck = [
            ['8a0f6b46-9102-4db4-8fd6-6b7c8d9e0f1a', 'dolphin', 3, 'needs-position', null],
            ['9b1a7c57-a213-4ec5-90e7-7c8d9e0f1a2b', 'turtle', 130, 'needs-position', null],
            ['ac2b8d68-b324-4fd6-81f8-8d9e0f1a2b3c', 'seabird', 75, 'failed', '23514 new row violates check'],
        ] as const;
        for (const [id, group, minutes, state, lastError] of stuck) {
            const base = localFromServer(serverRow(id, WREN, { taxon_group: group, event_date: ago(minutes) }), WREN);
            const noFix = state === 'needs-position';
            await putLocalSighting({
                ...base,
                row: noFix
                    ? {
                          ...base.row,
                          decimal_latitude: null,
                          decimal_longitude: null,
                          position_accuracy_m: null,
                          coordinate_uncertainty_in_meters: null,
                          position_source: null,
                          position_fix_at: null,
                      }
                    : base.row,
                sync: { state, op: 'insert', serverKnown: false, attempts: 0, lastError, nextAttemptAt: null },
                serverUpdatedAt: null,
            });
        }
    }
} else if (feed !== 'empty') {
    const row = serverRow('7ef5ad35-8091-4ca3-9ec5-5a6b7c8d9e0f', WREN, {
        taxon_group: 'dolphin',
        individual_count: 3,
        event_date: ago(12),
    });
    const local = localFromServer(row, WREN);
    const signedOutRow: SightingRow = {
        ...local.row,
        observer_id: null,
        vessel_owner_id: null,
        boat_id: null,
        visibility: 'private',
    };
    await putLocalSighting({
        ...local,
        ownerUserId: null,
        row: signedOutRow,
        sync: {
            state: 'held',
            op: 'insert',
            serverKnown: false,
            attempts: 0,
            lastError: 'signed-out',
            nextAttemptAt: null,
        },
    });
}

// The quick log's context: the boat's GPS via the Pi, or silent, or nothing.
const catalogue = parseCatalogue(
    await (await originalFetch(new URL('../../data/sightings/species-qld-gbr.v1.json', import.meta.url))).json(),
);
function fixtureContext(): SightingContext {
    const base: SightingContext = {
        capturedAt: NOW,
        position: {
            latitude: -20.2635,
            longitude: 148.9733,
            source: 'pi',
            fixAt: NOW,
            accuracyM: 10,
            uncertaintyM: 13,
            ashore: false,
        },
        boatSilent: false,
        samplingProtocol: 'opportunistic vessel-based observation',
        seaTempC: 24.1,
        seaTempSource: 'instrument',
        waterDepthM: 18.4,
        depthReference: 'below-keel',
        windSpeedKts: 14,
        windDirDeg: 135,
        windSource: 'instrument',
        waveHeightM: 1.2,
        wxModel: 'ecmwf_ifs025',
        sogKts: 6.2,
        cogDeg: 42,
        headingDeg: 40,
    };
    if (position === 'silent')
        return { ...base, boatSilent: true, position: { ...base.position!, source: 'phone', accuracyM: 8 } };
    if (position === 'none') return { ...base, position: null };
    return base;
}
const quickDeps = {
    captureContext: async () => fixtureContext(),
    loadCatalogue: async () => catalogue,
    resolveRecording: async () => (signedOut ? null : { voyageId: 'voyage_1759620000000_kr01', boatId: KITTIWAKE_RUN }),
    observerDisplay: async () => 'Wren',
};

const CHANNELS = [
    ['nw', 'Neighbourhood Watch', 'Maritime safety alerts'],
    ['general', 'General', 'Anything nautical'],
].map(
    ([id, name, description]) =>
        ({
            id,
            name,
            description,
            icon: '💬',
            is_private: false,
            is_global: true,
            status: 'active',
            created_at: ago(9000),
        }) as unknown as ChatChannel,
);
const noop = () => undefined;

const liveStats = {
    activeEntries: [],
    first: undefined,
    dist: 12.4,
    durationHrs: 2,
    durationMins: 18,
    liveAvgSpeed: 5.4,
    departedAt: ago(138),
};

function Body() {
    const expand = useRef<HTMLButtonElement>(null);
    const shrink = useRef<HTMLButtonElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    if (screenName === 'scuttlebutt') {
        return (
            <div className="h-full overflow-y-auto">
                <div className="px-4 pt-4 pb-2">
                    <h1 className="ui-page-title text-xl font-extrabold uppercase tracking-wider text-white">
                        Scuttlebutt
                    </h1>
                    <p className="text-xs uppercase tracking-widest text-gray-300">Sailor chat</p>
                </div>
                <ChannelList
                    channels={CHANNELS}
                    onOpenChannel={noop}
                    onRequestAccess={noop}
                    isMod={false}
                    showProposalForm={false}
                    setShowProposalForm={noop}
                    proposalIcon=""
                    setProposalIcon={noop}
                    proposalName=""
                    setProposalName={noop}
                    proposalDesc=""
                    setProposalDesc={noop}
                    proposalIsPrivate={false}
                    setProposalIsPrivate={noop}
                    proposalSent={false}
                    onProposeChannel={noop}
                    memberChannelIds={new Set()}
                    proposalParentId={null}
                    setProposalParentId={noop}
                    hasCrewInvited
                    vesselName="Kittiwake Run"
                />
            </div>
        );
    }
    if (screenName === 'logentry') {
        // The Log page when this phone is not recording: the pill tops the voyage list.
        return (
            <div className="flex h-full flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
                <div className="px-4 pt-4 pb-1">
                    <h1 className="ui-page-title text-xl font-extrabold uppercase tracking-wider text-white">
                        Ship’s Log
                    </h1>
                    <p className="text-xs uppercase tracking-widest text-gray-300">Not recording</p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                    <LogSightingEntry />
                    {['Airlie Beach → Cid Harbour', 'Shute Harbour → Airlie Beach'].map((name) => (
                        <div key={name} className="mb-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                            <div className="text-sm font-black text-white">{name}</div>
                            <div className="mt-1 text-xs text-slate-400">12.4 nm · 2 h 18 m</div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    if (screenName === 'logpill') {
        return (
            <div className="flex h-full flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
                <div className="px-4 pt-4 pb-1">
                    <h1 className="ui-page-title text-xl font-extrabold uppercase tracking-wider text-white">
                        Ship’s Log
                    </h1>
                    <p className="text-xs uppercase tracking-widest text-gray-300">
                        Recording · Airlie Beach → Cid Harbour
                    </p>
                </div>
                <LiveVoyageCard
                    liveStats={liveStats}
                    engineGroupId="engine"
                    engineRunning={false}
                    toggleEngine={noop}
                    liveMapExpanded={params.get('expanded') === 'true'}
                    showTrackMap={false}
                    followedRouteCoords={[]}
                    liveFix={{ lat: -20.2635, lon: 148.9733 }}
                    currentFix={{ lat: -20.2635, lon: 148.9733 }}
                    openLiveMap={noop}
                    closeLiveMap={noop}
                    expandLiveMapRef={expand as React.RefObject<HTMLButtonElement>}
                    shrinkLiveMapRef={shrink as React.RefObject<HTMLButtonElement>}
                    liveMapDialogRef={dialog as React.RefObject<HTMLDivElement>}
                    liveMapTitleId="live-map-title"
                />
            </div>
        );
    }
    return (
        <>
            <SightingsPage onBack={noop} backLabel="Back to Scuttlebutt" breadcrumbs={['Scuttlebutt', 'Sightings']} />
            {screenName === 'quick' && <QuickLogSheet openedAt={NOW} onClose={noop} deps={quickDeps} />}
        </>
    );
}

function Fixture() {
    const frame = useRef<HTMLElement>(null);
    return (
        <main className="relative flex h-dvh w-full overflow-hidden bg-slate-950 text-white" data-mode={mode}>
            <div
                className={`flex min-h-0 w-full flex-1 ${pane ? 'gap-2 p-2 pb-[calc(4rem+env(safe-area-inset-bottom)+8px)]' : ''}`}
            >
                {pane && (
                    <aside
                        className="min-w-0 flex-1 rounded-2xl bg-slate-900 p-4 text-slate-300"
                        aria-label="Companion pane"
                    >
                        The Glass (companion pane)
                    </aside>
                )}
                <PanePortalScope enabled={pane} paneId="sightings-fixture" frameRef={frame}>
                    <section
                        ref={frame}
                        data-testid="page-frame"
                        data-split-pane={pane ? 'sightings-fixture' : undefined}
                        className={
                            pane
                                ? 'relative h-full min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/25 bg-slate-950'
                                : 'absolute inset-0'
                        }
                    >
                        <div
                            className="absolute inset-x-0 top-0"
                            style={
                                pane
                                    ? ({
                                          '--split-page-overhang': 'calc(4.5rem + env(safe-area-inset-bottom))',
                                          height: 'calc(100% + var(--split-page-overhang))',
                                      } as React.CSSProperties)
                                    : { height: '100%' }
                            }
                        >
                            <Body />
                        </div>
                    </section>
                </PanePortalScope>
            </div>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, 4rem above the home indicator. */}
            <nav
                aria-label="Main"
                data-testid="app-bottom-nav"
                className="fixed right-0 bottom-0 left-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{
                    background: mode === 'light' ? '#f8fafc' : 'rgb(10, 15, 20)',
                    borderColor: 'rgba(56, 189, 248, 0.12)',
                }}
            >
                <div className="mx-auto flex h-16 items-center justify-around px-4 text-xs font-bold text-slate-400">
                    <span>The Glass</span>
                    <span>Obs</span>
                    <span>Plan</span>
                    <span className={screenName.startsWith('log') ? 'text-sky-400' : ''}>Log</span>
                    <span className={screenName.startsWith('log') ? '' : 'text-sky-400'}>Vessel</span>
                </div>
            </nav>
            {mode === 'night' && (
                <div
                    className="pointer-events-none fixed inset-0"
                    data-testid="night-scrim"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { __sightingsFixtureReady: true });
