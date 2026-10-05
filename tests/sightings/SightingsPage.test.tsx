/**
 * The Sightings page: the crew feed (live, with this phone's unsent ones
 * merged in), the public feed (three hours late, on a grid, anonymous unless
 * credited), Mine (list, map, life list), and every state: signed out, not
 * pushed yet, offline, empty, waiting to send.
 *
 * Fictional people and boats: Wren Hollis skippers the Kittiwake Run, Tamsin
 * Reyes crews for her.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicSighting, ServerSightingRow } from '../../services/sightings/types';

vi.mock('../../services/supabase', () => ({ supabase: null }));
vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../services/sightings/photoStrip', () => ({ stripAndCompressPhoto: async (file: Blob) => file }));
vi.mock('../../services/ShipLogService', () => ({
    ShipLogService: { resolveActiveVoyageId: async () => undefined, resolveActiveBoatId: async () => undefined },
}));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => ({ user: null }) } }));
vi.mock('../../components/SignInScreen', () => ({
    SignInScreen: ({ prompt }: { prompt: string }) => (
        <div role="dialog" aria-label="Sign in">
            {prompt}
        </div>
    ),
}));
vi.mock('../../components/sightings/SightingsMap', () => ({
    default: ({ items }: { items: Array<{ id: string }> }) => (
        <div data-testid="map-stub">{items.length} on the map</div>
    ),
    SightingsMap: () => null,
}));
const capture = vi.hoisted(() => ({ next: null as unknown }));
vi.mock('../../services/sightings/sightingContext', () => ({
    // Never answers unless a test hands it a context.
    captureSightingContext: () => (capture.next ? Promise.resolve(capture.next) : new Promise(() => undefined)),
}));

const feed = vi.hoisted(() => ({
    crew: {
        rows: [] as unknown[],
        unavailable: false,
        fromCache: false,
        fetchedAt: 1 as number | null,
    },
    pub: { rows: [] as unknown[], unavailable: false },
    species: [] as unknown[],
    serverUnavailable: false,
    publicCalls: [] as unknown[],
}));
vi.mock('../../services/sightings/sightingSync', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../services/sightings/sightingSync')>()),
    scheduleSightingDrain: vi.fn(),
    ensureSightingSyncTriggers: vi.fn(),
    pullMySightings: vi.fn(async () => ({ pulled: 0, unavailable: feed.serverUnavailable })),
    sightingsServerUnavailable: () => feed.serverUnavailable,
    fetchCrewSightings: vi.fn(async () => ({ ...feed.crew })),
    fetchBoatSpecies: vi.fn(async () => ({
        rows: feed.species,
        unavailable: false,
        fromCache: false,
        fetchedAt: Date.now(),
        complete: true,
    })),
    subscribeCrewSightings: vi.fn(() => () => undefined),
    fetchPublicSightings: vi.fn(async (box: unknown) => {
        feed.publicCalls.push(box);
        return { rows: feed.pub.rows, unavailable: feed.pub.unavailable, fromCache: false, fetchedAt: Date.now() };
    }),
    sightingPhotoUrl: vi.fn(async () => null),
}));
vi.mock('../../services/sightings/catalogue', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../services/sightings/catalogue')>();
    const json = JSON.parse(readFileSync(resolve(process.cwd(), 'data/sightings/species-qld-gbr.v1.json'), 'utf8'));
    const parsed = actual.parseCatalogue(json);
    return { ...actual, loadCatalogue: async () => parsed };
});
const sessionBox = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../hooks/sightings/useSightingsSession', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../hooks/sightings/useSightingsSession')>()),
    useSightingsSession: () => sessionBox.current,
}));

import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { logSighting, editSighting } from '../../services/sightings/sightingService';
import {
    listLocalSightings,
    memoryBackend,
    putLocalSighting,
    setSightingStoreBackend,
} from '../../services/sightings/sightingStore';
import { subscribeCrewSightings } from '../../services/sightings/sightingSync';
import { useUIStore } from '../../stores/uiStore';
import { useWeatherStore } from '../../stores/weatherStore';
import { SightingsPage } from '../../components/sightings/SightingsPage';
import type { SightingsSession } from '../../hooks/sightings/useSightingsSession';

const WREN = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const TAMSIN = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const KITTIWAKE_RUN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const signedIn: SightingsSession = {
    userId: WREN,
    ownBoatId: KITTIWAKE_RUN,
    ownBoatName: 'Kittiwake Run',
    crewing: null,
    crewVessels: [],
    ownCrewCount: 1,
};
const signedOut: SightingsSession = {
    userId: null,
    ownBoatId: null,
    ownBoatName: null,
    crewing: null,
    crewVessels: [],
    ownCrewCount: null,
};

function crewRow(over: Partial<ServerSightingRow> = {}): ServerSightingRow {
    return {
        id: 'b6f0c1d2-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
        observer_id: TAMSIN,
        vessel_owner_id: WREN,
        boat_id: KITTIWAKE_RUN,
        voyage_id: null,
        visibility: 'crew',
        taxon_group: 'turtle',
        scientific_name: 'Chelonia mydas',
        vernacular_name: 'Green turtle',
        taxon_rank: 'species',
        individual_count: 1,
        count_is_estimate: false,
        has_calf: false,
        behavior: null,
        observed_distance_m: null,
        event_date: minutesAgo(40),
        created_at: minutesAgo(39),
        updated_at: minutesAgo(39),
        decimal_latitude: -20.0712,
        decimal_longitude: 148.9013,
        position_accuracy_m: 10,
        coordinate_uncertainty_in_meters: 15,
        position_source: 'bus',
        position_fix_at: minutesAgo(40),
        sampling_protocol: 'opportunistic vessel-based observation',
        sea_temp_c: 24.4,
        sea_temp_source: 'instrument',
        water_depth_m: 12,
        depth_reference: 'below-keel',
        wind_speed_kts: 11,
        wind_dir_deg: 120,
        wind_source: 'forecast',
        wave_height_m: 0.8,
        wx_model: 'ecmwf_ifs025',
        sog_kts: 5.1,
        cog_deg: 350,
        heading_deg: null,
        occurrence_remarks: 'Surfaced twice off the bow.',
        photo_paths: [],
        observer_display: 'Tamsin',
        credit_public: false,
        basis_of_record: 'HumanObservation',
        client_version: 'thalassa/test',
        ...over,
    };
}

const context = {
    capturedAt: now,
    position: {
        latitude: -20.2567,
        longitude: 148.9512,
        source: 'pi' as const,
        fixAt: now,
        accuracyM: 10,
        uncertaintyM: 10,
        ashore: false,
    },
    boatSilent: false,
    samplingProtocol: 'opportunistic vessel-based observation' as const,
    seaTempC: null,
    seaTempSource: null,
    waterDepthM: null,
    depthReference: null,
    windSpeedKts: null,
    windDirDeg: null,
    windSource: null,
    waveHeightM: null,
    wxModel: null,
    sogKts: null,
    cogDeg: null,
    headingDeg: null,
};

async function logOwn(group: 'whale' | 'dolphin', species?: { sci: string; name: string }, minutes = 10) {
    const record = await logSighting({
        group,
        eventAt: now - minutes * 60_000,
        context,
        vessel: { vesselOwnerId: WREN, boatId: KITTIWAKE_RUN, voyageId: null },
        visibility: 'crew',
    });
    if (species) {
        await editSighting(record.id, { scientific_name: species.sci });
        const { setSightingDisplayName } = await import('../../services/sightings/sightingService');
        await setSightingDisplayName(record.id, species.name);
    }
    return record;
}

async function renderPage(onBack = vi.fn()) {
    const view = render(
        <SightingsPage onBack={onBack} backLabel="Back to Scuttlebutt" breadcrumbs={['Scuttlebutt', 'Sightings']} />,
    );
    await screen.findByRole('tablist', { name: 'Sightings' });
    return { view, onBack };
}

async function openTab(name: 'Crew' | 'Public' | 'Mine') {
    await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: new RegExp(name) }));
    });
}

beforeEach(() => {
    localStorage.clear();
    setSightingStoreBackend(memoryBackend());
    setAuthIdentityScope(WREN);
    sessionBox.current = signedIn;
    feed.crew = { rows: [], unavailable: false, fromCache: false, fetchedAt: now };
    feed.pub = { rows: [], unavailable: false };
    feed.species = [];
    feed.serverUnavailable = false;
    feed.publicCalls = [];
    capture.next = null;
    vi.mocked(subscribeCrewSightings).mockClear();
    useUIStore.setState({ isOffline: false });
    useWeatherStore.setState({
        weatherData: { coordinates: { lat: -20.27, lon: 148.95 } } as never,
    });
});

afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('the page', () => {
    it('is titled Sightings, says whose boat, and Back names Scuttlebutt', async () => {
        const { onBack } = await renderPage();
        expect(screen.getByRole('heading', { level: 1, name: 'Sightings' })).toBeInTheDocument();
        expect(screen.getByText('Kittiwake Run · 1 crew')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Back to Scuttlebutt' }));
        expect(onBack).toHaveBeenCalled();
        // Opening the page retires the Scuttlebutt card's 'New' badge.
        expect(localStorage.getItem('thalassa_sightings_seen_v1')).toBe('1');
    });

    it('has three real tabs, arrow keys move between them, and the choice is remembered', async () => {
        await renderPage();
        const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
        expect(tabs.map((t) => t.textContent)).toEqual(['Crew', 'Public', 'Mine']);
        expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs[0].id);
        await act(async () => {
            fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
        });
        expect(screen.getByRole('tab', { name: /Public/ })).toHaveAttribute('aria-selected', 'true');
        expect(localStorage.getItem('thalassa_sightings_tab_v1')).toBe('public');
        for (const tab of within(screen.getByRole('tablist')).getAllByRole('tab')) {
            expect(tab.className).toContain('sg-seg-btn');
        }
    });

    it('opens the quick log from Log a sighting', async () => {
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: 'Log a sighting' }));
        expect(await screen.findByRole('dialog', { name: 'What did you see?' })).toBeInTheDocument();
    });
});

describe('crew feed', () => {
    it('lists the crew’s sightings live, with this phone’s unsent one merged in at once', async () => {
        feed.crew.rows = [crewRow()];
        await logOwn('whale', { sci: 'Megaptera novaeangliae', name: 'Humpback whale' });
        await renderPage();
        expect(await screen.findByText('Green turtle')).toBeInTheDocument();
        expect(screen.getByText('Humpback whale')).toBeInTheDocument();
        expect(screen.getByText(/^Tamsin · /)).toBeInTheDocument();
        expect(screen.getByText(/^You · /)).toBeInTheDocument();
        expect(screen.getByText('Live from the crew')).toBeInTheDocument();
        // The unsent one is counted, and says so at the top.
        expect(screen.getByTestId('sightings-waiting')).toHaveTextContent('1 waiting to send');
        expect(screen.getByText('This week').parentElement).toHaveTextContent('2');
        // ...and on its own row, so you know which one.
        expect(
            screen.getByRole('button', { name: /^Humpback whale\. You · .*\. Waiting to send$/ }),
        ).toBeInTheDocument();
    });

    it('shows your own sighting once, as this phone has it, when the server has an older copy', async () => {
        const record = await logOwn('whale', { sci: 'Megaptera novaeangliae', name: 'Humpback whale' });
        await editSighting(record.id, { individual_count: 3 });
        feed.crew.rows = [
            crewRow({
                id: record.id,
                observer_id: WREN,
                observer_display: null,
                taxon_group: 'whale',
                scientific_name: 'Megaptera novaeangliae',
                vernacular_name: 'Humpback whale',
                individual_count: 1,
            }),
        ];
        await renderPage();
        expect(await screen.findByText('Humpback whale × 3')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /^Humpback whale/ })).toHaveLength(1);
    });

    it('shows a crew row read-only, with each value’s source and the forecast model credited', async () => {
        feed.crew.rows = [crewRow()];
        await renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Green turtle/ }));
        const detail = await screen.findByRole('dialog', { name: 'Green turtle' });
        expect(detail).toHaveTextContent('logged by Tamsin');
        expect(detail).toHaveTextContent('Boat GPS · ±15 m · the boat, not the animal');
        expect(detail).toHaveTextContent('Forecast data: ECMWF');
        expect(detail).toHaveTextContent('Surfaced twice off the bow.');
        expect(within(detail).queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(within(detail).queryByRole('button', { name: 'Delete' })).toBeNull();
    });

    it('lets you delete your own, after asking', async () => {
        await logOwn('dolphin');
        await renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /^Dolphin/ }));
        const detail = await screen.findByRole('dialog', { name: 'Dolphin' });
        fireEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
        expect(within(detail).getByText(/It goes from your crew’s feed and the public map too/)).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
        });
        await waitFor(async () => expect(await listLocalSightings(WREN)).toHaveLength(0));
    });

    it('drops a sent sighting you delete from the crew feed at once, before the server hears', async () => {
        const record = await logOwn('dolphin');
        await putLocalSighting({ ...record, sync: { ...record.sync, state: 'synced', op: null, serverKnown: true } });
        feed.crew.rows = [
            crewRow({
                id: record.id,
                observer_id: WREN,
                observer_display: null,
                taxon_group: 'dolphin',
                scientific_name: null,
                vernacular_name: null,
            }),
        ];
        await renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /^Dolphin/ }));
        const detail = await screen.findByRole('dialog', { name: 'Dolphin' });
        fireEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
        await act(async () => {
            fireEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
        });
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Dolphin/ })).toBeNull());
        // Still on the phone as a deletion for the outbox to send.
        expect((await listLocalSightings(WREN)).map((r) => r.sync.op)).toEqual(['delete']);
    });

    it('says sharing is not switched on yet when the server has no sightings', async () => {
        feed.crew = { rows: [], unavailable: true, fromCache: false, fetchedAt: null };
        feed.serverUnavailable = true;
        await renderPage();
        expect(await screen.findByTestId('sightings-not-pushed')).toHaveTextContent('Sharing isn’t switched on yet');
        expect(screen.queryByText('Live from the crew')).toBeNull();
        // No live channel on a table that is not there yet.
        expect(subscribeCrewSightings).not.toHaveBeenCalled();
    });

    it('opens the live channel once the first fetch shows the server has sightings', async () => {
        feed.crew.rows = [crewRow()];
        await renderPage();
        await screen.findByText('Green turtle');
        await waitFor(() => expect(subscribeCrewSightings).toHaveBeenCalledTimes(1));
        expect(vi.mocked(subscribeCrewSightings).mock.calls[0][0]).toBe(WREN);
    });

    it('offline: the last copy, and when it was fetched', async () => {
        useUIStore.setState({ isOffline: true });
        feed.crew = { rows: [crewRow()], unavailable: false, fromCache: true, fetchedAt: now - 30 * 60_000 };
        await renderPage();
        expect(await screen.findByText(/^Offline · crew feed from /)).toBeInTheDocument();
        expect(screen.getByText('Green turtle')).toBeInTheDocument();
    });

    it('with no boat says how to get one', async () => {
        sessionBox.current = { ...signedIn, ownBoatId: null, ownBoatName: null };
        localStorage.setItem('thalassa_sightings_tab_v1', 'crew');
        await renderPage();
        expect(await screen.findByTestId('sightings-no-boat')).toHaveTextContent('accept a skipper’s invite');
    });

    it('shows a crew member the skipper’s boat', async () => {
        sessionBox.current = {
            ...signedIn,
            userId: TAMSIN,
            ownBoatId: null,
            ownBoatName: null,
            crewing: { ownerId: WREN, vesselName: 'Kittiwake Run', role: 'deckhand', lastAcceptedAt: '' },
            crewVessels: [{ ownerId: WREN, vesselName: 'Kittiwake Run', role: 'deckhand', lastAcceptedAt: '' }],
        };
        setAuthIdentityScope(TAMSIN);
        feed.crew.rows = [crewRow()];
        await renderPage();
        expect(screen.getByText('Kittiwake Run · crew')).toBeInTheDocument();
        expect(await screen.findByText(/^You · /)).toBeInTheDocument();
    });
});

describe('public feed', () => {
    const pubRow = (over: Partial<PublicSighting> = {}): PublicSighting => ({
        sighting_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        taxon_group: 'whale',
        scientific_name: 'Megaptera novaeangliae',
        vernacular_name: 'Humpback whale',
        taxon_rank: 'species',
        individual_count: 3,
        has_calf: false,
        event_time: new Date(now - 4 * 3_600_000).toISOString(),
        latitude: -20.255,
        longitude: 148.955,
        uncertainty_m: 790,
        generalised: false,
        credit: null,
        ...over,
    });

    it('explains the delay, is anonymous unless credited, and shows the grid size', async () => {
        feed.pub.rows = [
            pubRow({ credit: 'salt-and-light' }),
            pubRow({
                sighting_id: 'b',
                taxon_group: 'turtle',
                scientific_name: 'Chelonia mydas',
                vernacular_name: 'Green turtle',
                individual_count: 1,
                uncertainty_m: 7850,
                generalised: true,
                // The server never credits a row on the 8 km grid.
                credit: null,
            }),
        ];
        await renderPage();
        await openTab('Public');
        expect(screen.getByTestId('public-explainer')).toHaveTextContent('3 hours behind, on purpose.');
        expect(screen.getByTestId('public-explainer')).toHaveTextContent('no log-handle credit on the 8 km grid');
        expect(await screen.findByText(/^salt-and-light · 4 h ago · ~1 km area$/)).toBeInTheDocument();
        expect(screen.getByText(/^A Thalassa sailor · 4 h ago · ~8 km area$/)).toBeInTheDocument();
        expect(screen.getByText('2 this week')).toBeInTheDocument();
    });

    it('says where the public feed is centred', async () => {
        useWeatherStore.setState({
            weatherData: { coordinates: { lat: -20.27, lon: 148.95 }, locationName: 'Airlie Beach' } as never,
        });
        await renderPage();
        await openTab('Public');
        expect(screen.getByTestId('public-centre')).toHaveTextContent('Around Airlie Beach');
    });

    it('asks the server for a smaller box when the radius shrinks', async () => {
        await renderPage();
        await openTab('Public');
        await waitFor(() => expect(feed.publicCalls).toHaveLength(1));
        const wide = feed.publicCalls[0] as { north: number; south: number };
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '25 km' }));
        });
        await waitFor(() => expect(feed.publicCalls).toHaveLength(2));
        const narrow = feed.publicCalls[1] as { north: number; south: number };
        expect(narrow.north - narrow.south).toBeLessThan(wide.north - wide.south);
        expect(screen.getByRole('button', { name: '25 km' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('offline says it needs a connection', async () => {
        useUIStore.setState({ isOffline: true });
        await renderPage();
        await openTab('Public');
        expect(screen.getByText('Public sightings need a connection')).toBeInTheDocument();
        expect(feed.publicCalls).toHaveLength(0);
    });

    it('opens a public row with only what the server gave', async () => {
        feed.pub.rows = [pubRow()];
        await renderPage();
        await openTab('Public');
        fireEvent.click(await screen.findByRole('button', { name: /Humpback whale × 3/ }));
        const detail = await screen.findByRole('dialog', { name: 'Humpback whale' });
        expect(detail).toHaveTextContent('public sightings are blurred, and shown 3 hours late');
        expect(within(detail).queryByRole('button', { name: 'Edit' })).toBeNull();
    });
});

describe('mine', () => {
    it('signed out: logging still works on this phone; the crew and public tabs ask you to sign in', async () => {
        setAuthIdentityScope(null);
        sessionBox.current = signedOut;
        await renderPage();
        // First visit with no boat lands on Mine.
        expect(screen.getByRole('tab', { name: /Mine/ })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByTestId('sightings-empty')).toHaveTextContent('No sightings yet');
        await openTab('Crew');
        expect(screen.getByTestId('sightings-signed-out')).toHaveTextContent('Sign in to see your crew’s sightings');
        fireEvent.click(within(screen.getByTestId('sightings-signed-out')).getByRole('button', { name: 'Sign in' }));
        expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
    });

    it('lists yours with what still has to happen, maps them, and counts species once named', async () => {
        await logOwn('whale', { sci: 'Megaptera novaeangliae', name: 'Humpback whale' }, 30);
        await logOwn('dolphin', { sci: 'Tursiops aduncus', name: 'Indo-Pacific bottlenose dolphin' }, 20);
        await logOwn('whale', undefined, 10);
        await renderPage();
        await openTab('Mine');
        expect(await screen.findAllByText('Waiting to send')).toHaveLength(3);
        fireEvent.click(screen.getByRole('button', { name: 'Map' }));
        expect(await screen.findByTestId('map-stub')).toHaveTextContent('3 on the map');
        fireEvent.click(screen.getByRole('button', { name: 'Life list' }));
        const life = await screen.findByTestId('life-list');
        expect(life).toHaveTextContent('Kittiwake Run’s species');
        // The group-only whale is not a species.
        expect(within(life).getByText('2')).toBeInTheDocument();
        expect(life).toHaveTextContent('First: Humpback whale');
        fireEvent.click(within(life).getByRole('button', { name: 'Me' }));
        expect(life).toHaveTextContent('My species');
    });

    it("counts the boat's life list all time, not just the crew feed's 30 days", async () => {
        feed.species = [
            {
                id: 'c0ffee00-0000-4000-8000-000000000040',
                scientific_name: 'Dugong dugon',
                taxon_group: 'dugong',
                vernacular_name: 'Dugong',
                event_date: new Date(now - 40 * 24 * 3_600_000).toISOString(),
            },
        ];
        await logOwn('whale', { sci: 'Megaptera novaeangliae', name: 'Humpback whale' });
        await renderPage();
        await openTab('Mine');
        fireEvent.click(screen.getByRole('button', { name: 'Life list' }));
        const life = await screen.findByTestId('life-list');
        await waitFor(() => expect(within(life).getByText('2')).toBeInTheDocument());
        expect(life).toHaveTextContent('First: Dugong');
    });

    it('offers to adopt what was logged signed out', async () => {
        setAuthIdentityScope(null);
        await logSighting({
            group: 'dolphin',
            eventAt: now,
            context,
            vessel: { vesselOwnerId: null, boatId: null, voyageId: null },
            visibility: 'private',
        });
        setAuthIdentityScope(WREN);
        await renderPage();
        await openTab('Mine');
        const card = await screen.findByText('1 logged while signed out');
        expect(card).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add them to my account' }));
        });
        expect(await screen.findByText('1 added to your account, Private.')).toBeInTheDocument();
        expect((await listLocalSightings(WREN))[0].row.visibility).toBe('private');
    });
});

describe('waiting for a position, or refused', () => {
    async function logNoFix(minutes: number) {
        return logSighting({
            group: 'dolphin',
            eventAt: now - minutes * 60_000,
            context: null,
            vessel: { vesselOwnerId: WREN, boatId: KITTIWAKE_RUN, voyageId: null },
            visibility: 'crew',
        });
    }

    it('counts it at the top, and a recent one is retried right from the Mine row', async () => {
        await logNoFix(2);
        await renderPage();
        expect(await screen.findByTestId('sightings-needs-position')).toHaveTextContent('1 needs a position');
        fireEvent.click(
            within(screen.getByTestId('sightings-needs-position')).getByRole('button', { name: 'Show me' }),
        );
        expect(screen.getByRole('tab', { name: /Mine/ })).toHaveAttribute('aria-selected', 'true');
        expect(await screen.findByText('Needs a position: open to add it')).toBeInTheDocument();
        capture.next = context;
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Retry the position' }));
        });
        await waitFor(async () => expect((await listLocalSightings(WREN))[0].sync.state).toBe('pending'));
        await waitFor(() => expect(screen.queryByTestId('sightings-needs-position')).toBeNull());
    });

    it('an old one says plainly that the position now stands in, in the detail', async () => {
        await logNoFix(90);
        await renderPage();
        await openTab('Mine');
        // No row button for an old one: the detail explains first.
        expect(screen.queryByRole('button', { name: 'Retry the position' })).toBeNull();
        fireEvent.click(await screen.findByRole('button', { name: /^Dolphin/ }));
        const box = await screen.findByTestId('needs-position');
        expect(box).toHaveTextContent('It stays on this phone, unsent, until it has one.');
        expect(box).toHaveTextContent('Only if you haven’t moved far since');
        capture.next = context;
        await act(async () => {
            fireEvent.click(within(box).getByRole('button', { name: 'Use position now' }));
        });
        await waitFor(async () => expect((await listLocalSightings(WREN))[0].sync.state).toBe('pending'));
    });

    it('a refused one says why and can be tried again', async () => {
        const record = await logOwn('dolphin');
        await putLocalSighting({ ...record, sync: { ...record.sync, state: 'failed', lastError: '23514 check' } });
        await renderPage();
        expect(await screen.findByTestId('sightings-not-sent')).toHaveTextContent('1 not sent');
        await openTab('Mine');
        fireEvent.click(await screen.findByRole('button', { name: /^Dolphin/ }));
        const box = await screen.findByTestId('not-sent');
        expect(box).toHaveTextContent('The server didn’t accept it');
        await act(async () => {
            fireEvent.click(within(box).getByRole('button', { name: 'Try again' }));
        });
        await waitFor(async () => expect((await listLocalSightings(WREN))[0].sync.state).toBe('pending'));
    });
});
