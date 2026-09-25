import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyageLogData, VoyageLogEntry, VoyageLogInstruments } from '../src/voyageLogApi';

const mocks = vi.hoisted(() => ({
    fetchVoyageLog: vi.fn(),
    fetchPublicInstruments: vi.fn(),
    mapMount: vi.fn(),
    mapProps: vi.fn(),
}));
vi.mock('../src/voyageLogApi', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/voyageLogApi')>()),
    fetchVoyageLog: mocks.fetchVoyageLog,
    fetchPublicInstruments: mocks.fetchPublicInstruments,
    parseVoyageLogParams: () => ({ handle: 'serene-summer' }),
}));
vi.mock('../src/components/TopNav', () => ({ default: () => null }));
vi.mock('../src/components/VoyageProgressBar', () => ({ VoyageProgressBar: () => null }));
vi.mock('../src/components/PhotoLightbox', () => ({ PhotoLightbox: () => null }));
vi.mock('../src/components/PublicDiaryComments', () => ({
    PublicDiaryComments: ({ handle, entryId }: { handle: string; entryId: string }) => (
        <div data-testid="guest-comments" data-handle={handle} data-entry-id={entryId} />
    ),
}));
vi.mock('../src/components/MapContainer', () => ({
    default: function MockMap(props: { entries: VoyageLogEntry[]; onEntryClick: (e: VoyageLogEntry) => void }) {
        const { entries, onEntryClick } = props;
        mocks.mapProps(props);
        React.useEffect(() => mocks.mapMount(), []);
        return <button onClick={() => onEntryClick(entries[0])}>Open diary marker</button>;
    },
}));

import ThalassaDashboard from '../src/ThalassaDashboard';
import { VoyageLogError } from '../src/voyageLogApi';

const NOW = Date.parse('2026-09-08T00:00:00Z');
const INSTRUMENTS: VoyageLogInstruments = {
    updated_at: new Date(NOW).toISOString(),
    source: 'pi',
    sog: 0,
    cog: 43,
    heading: 43,
    stw: 0,
    tws: 8,
    twa: 39,
    twd: 82,
    aws: 8,
    awa: 39,
    depth: 7,
    water_temp: 24,
    baro: 1019,
    voltage: 12.8,
    rpm: 0,
    heel: 12.3,
    heel_at: new Date(NOW - 20_000).toISOString(),
    pitch: 1,
    rudder: 0,
};
const ENTRY: VoyageLogEntry = {
    id: 'entry-1',
    title: 'Turtles at Musgrave',
    body: 'A quiet morning in the lagoon.',
    mood: 'good',
    photos: [],
    location_name: 'Lady Musgrave Island',
    latitude: -23.9,
    longitude: 152.4,
    weather_summary: '',
    weather_data: null,
    tags: [],
    created_at: new Date(NOW).toISOString(),
    voyage_id: 'trip-1',
    author: null,
};
const DATA: VoyageLogData = {
    vessel: { name: 'Serene Summer', type: 'sail', model: 'Tayana 55' },
    scope: 'personal',
    destination: null,
    trips: [
        {
            id: 'trip-1',
            kind: 'track',
            label: 'Lady Musgrave',
            started_at: new Date(NOW).toISOString(),
            ended_at: null,
            active: true,
            point_count: 1,
            distance_nm: 0,
            has_route: true,
        },
        {
            id: 'all-diary',
            kind: 'all-diary',
            label: 'All diary entries',
            started_at: null,
            ended_at: null,
            active: false,
            point_count: 0,
            distance_nm: null,
            has_route: false,
        },
    ],
    selected_trip: 'trip-1',
    entries: [ENTRY],
    track: [],
    telemetry: null,
    instruments_shared: true,
    instruments: INSTRUMENTS,
    nearby_vessels: [],
    passage: {
        voyage_id: 'trip-1',
        plan_line: [
            [153, -27],
            [152.4, -23.9],
        ],
    },
    generated_at: new Date(NOW).toISOString(),
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.fetchVoyageLog.mockReset().mockResolvedValue(DATA);
    mocks.fetchPublicInstruments.mockReset().mockImplementation(() => new Promise(() => {}));
    mocks.mapMount.mockClear();
    mocks.mapProps.mockClear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const desktopViews = () => within(screen.getByRole('group', { name: 'Side panel view' }));
const choose = (name: 'Instruments' | 'Diary') => fireEvent.click(desktopViews().getByRole('button', { name }));
const mobileViews = () => within(screen.getByRole('navigation', { name: 'Voyage views' }));
const chooseMobile = (name: 'Map' | 'Instruments' | 'Diary') =>
    fireEvent.click(mobileViews().getByRole('button', { name }));

function mockViewport(initialWidth = 390, initialHeight = 844) {
    let width = initialWidth;
    let height = initialHeight;
    const queries = new Map<string, MediaQueryList>();
    const matches = (query: string) =>
        query === '(max-width: 1023px)'
            ? width <= 1023
            : query === '(max-width: 1023px) and (max-height: 500px)' && width <= 1023 && height <= 500;
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => {
            if (!queries.has(query)) {
                const target = new EventTarget();
                queries.set(query, {
                    get matches() {
                        return matches(query);
                    },
                    media: query,
                    onchange: null,
                    addListener: vi.fn(),
                    removeListener: vi.fn(),
                    addEventListener: target.addEventListener.bind(target),
                    removeEventListener: target.removeEventListener.bind(target),
                    dispatchEvent: target.dispatchEvent.bind(target),
                } as MediaQueryList);
            }
            return queries.get(query)!;
        }),
    );
    return (nextWidth: number, nextHeight: number) => {
        const previous = new Map([...queries].map(([query, media]) => [query, media.matches]));
        width = nextWidth;
        height = nextHeight;
        for (const [query, media] of queries) {
            if (previous.get(query) !== media.matches) {
                media.dispatchEvent(Object.assign(new Event('change'), { matches: media.matches, media: query }));
            }
        }
    };
}

async function openPage() {
    await act(async () => {
        render(<ThalassaDashboard />);
    });
}
const expectDiaryOnly = () => {
    expect(screen.getByRole('heading', { name: ENTRY.title })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Onboard instruments' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Instrument sharing status' })).not.toBeInTheDocument();
    expect(desktopViews().getByRole('button', { name: 'Diary', pressed: true })).toBeInTheDocument();
};

describe('public voyage Instruments / Diary switch', () => {
    it.each([390, 1280])('keeps a just-recorded trip and its diary without a planned route at %s px', async (width) => {
        mockViewport(width, 844);
        const recorded: VoyageLogData = {
            ...DATA,
            passage: null,
            instruments_shared: false,
            instruments: null,
            trips: DATA.trips.map((trip) => ({ ...trip, has_route: false })),
            track: [
                { lat: -20.07, lon: 148.93 },
                { lat: -20.25, lon: 148.81 },
            ] as VoyageLogData['track'],
        };
        mocks.fetchVoyageLog.mockResolvedValue(recorded);
        await openPage();
        expect(mocks.fetchVoyageLog.mock.calls.map((call) => call[1])).toEqual(['latest']);
        expect(screen.getByRole('combobox', { name: 'Choose a voyage to view' })).toHaveValue('latest');
        expect(document.getElementById('voyage-map')).not.toHaveClass('hidden');
        if (width < 1024) {
            expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
            chooseMobile('Diary');
        }
        expect(screen.getByRole('heading', { name: ENTRY.title })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'All trips & diary' })).not.toBeInTheDocument();
        expect(mocks.mapMount).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(mocks.fetchVoyageLog.mock.calls.every((call) => call[1] === 'latest')).toBe(true);
        expect(mocks.mapMount).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        'opens the phone diary with no route, including latest already resolving all-diary: %s',
        async (latestAlreadyAllDiary) => {
            mockViewport(390, 844);
            mocks.fetchVoyageLog.mockImplementation(async (_handle: string, trip: string) => ({
                ...DATA,
                passage: null,
                selected_trip: latestAlreadyAllDiary || trip === 'all-diary' ? 'all-diary' : 'trip-1',
            }));
            await openPage();
            expect(mobileViews().getByRole('button', { name: 'Diary', pressed: true })).toBeInTheDocument();
            expect(screen.getByRole('heading', { name: ENTRY.title })).toBeInTheDocument();
            expect(screen.getByRole('complementary')).not.toHaveClass('hidden');
            expect(document.getElementById('voyage-map')).toHaveClass('hidden');
            expect(mocks.mapMount).toHaveBeenCalledTimes(1);

            chooseMobile('Map');
            await act(async () => vi.advanceTimersByTimeAsync(120_000));
            expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
            expect(document.getElementById('voyage-map')).not.toHaveClass('hidden');
            expect(mocks.mapMount).toHaveBeenCalledTimes(1);
        },
    );

    it('defaults a route-less latest trip to all public entries in newest-first order', async () => {
        const oldest = { ...ENTRY, id: 'oldest', title: 'Oldest entry', created_at: '2026-09-01T00:00:00Z' };
        const middle = { ...ENTRY, id: 'middle', title: 'Middle entry', created_at: '2026-09-05T00:00:00Z' };
        const allEntries = Object.freeze([oldest, ENTRY, middle]);
        mocks.fetchVoyageLog.mockImplementation(async (_handle: string, trip: string) =>
            trip === 'all-diary'
                ? { ...DATA, passage: null, selected_trip: 'all-diary', entries: allEntries }
                : { ...DATA, passage: null },
        );
        await openPage();
        expect(mocks.fetchVoyageLog.mock.calls.map((call) => call[1])).toEqual(['latest', 'all-diary']);
        expect(screen.getByRole('combobox', { name: 'Choose a voyage to view' })).toHaveValue('all-diary');
        expect(screen.getByRole('heading', { name: 'All trips & diary' })).toBeInTheDocument();
        expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
            ENTRY.title,
            middle.title,
            oldest.title,
        ]);
        expect(allEntries.map((item) => item.id)).toEqual(['oldest', ENTRY.id, 'middle']);
    });

    it('does not override a subsequent explicit Latest choice or its no-route refreshes', async () => {
        mocks.fetchVoyageLog.mockImplementation(async (_handle: string, trip: string) => ({
            ...DATA,
            passage: null,
            selected_trip: trip === 'all-diary' ? 'all-diary' : 'trip-1',
        }));
        await openPage();
        expect(screen.getByRole('combobox', { name: 'Choose a voyage to view' })).toHaveValue('all-diary');
        await act(async () =>
            fireEvent.change(screen.getByRole('combobox', { name: 'Choose a voyage to view' }), {
                target: { value: 'latest' },
            }),
        );
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(screen.getByRole('combobox', { name: 'Choose a voyage to view' })).toHaveValue('latest');
        expect(mocks.fetchVoyageLog.mock.calls.map((call) => call[1])).toEqual([
            'latest',
            'all-diary',
            'latest',
            'latest',
        ]);
    });

    it.each([true, false])(
        'shows all shared trips and diary pins together on the phone (explicit choice: %s)',
        async (explicit) => {
            mockViewport(390, 844);
            const older = { ...ENTRY, id: 'earlier-story', title: 'Earlier trip story', voyage_id: 'old-trip' };
            const historyTrack = [
                { lat: -27, lon: 153, voyage_id: 'old-trip', timestamp: '2026-09-01T00:00:00Z' },
                { lat: -26, lon: 152, voyage_id: 'old-trip', timestamp: '2026-09-01T01:00:00Z' },
                { lat: -20.2, lon: 148.9, voyage_id: 'trip-1', timestamp: '2026-09-08T00:00:00Z' },
                { lat: -20.1, lon: 148.8, voyage_id: 'trip-1', timestamp: '2026-09-08T01:00:00Z' },
            ];
            mocks.fetchVoyageLog.mockImplementation(async (_handle: string, trip: string) =>
                trip === 'all-diary'
                    ? { ...DATA, selected_trip: 'all-diary', entries: [ENTRY, older], track: historyTrack }
                    : { ...DATA, passage: explicit ? DATA.passage : null },
            );
            await openPage();
            if (explicit)
                await act(async () =>
                    fireEvent.change(screen.getByRole('combobox', { name: 'Choose a voyage to view' }), {
                        target: { value: 'all-diary' },
                    }),
                );
            expect(screen.getByRole('option', { name: 'All trips & diary' })).toBeInTheDocument();
            expect(screen.getByRole('combobox', { name: 'Choose a voyage to view' })).toHaveValue('all-diary');
            expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
            expect(mocks.mapProps).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    allTrips: true,
                    track: historyTrack,
                    entries: [ENTRY, older],
                    passageLine: null,
                    destination: null,
                    telemetry: null,
                    nearbyVessels: [],
                }),
            );
            chooseMobile('Diary');
            expect(screen.getByRole('heading', { name: 'All trips & diary' })).toBeInTheDocument();
            expect(screen.getByRole('heading', { name: older.title })).toBeInTheDocument();
            expect(mocks.mapMount).toHaveBeenCalledOnce();
        },
    );

    it('retains the routed-trip starting view and never changes it when a later poll loses the route', async () => {
        await openPage();
        expect(mocks.fetchVoyageLog).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('combobox', { name: 'Choose a voyage to view' })).toHaveValue('latest');
        expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        mocks.fetchVoyageLog.mockResolvedValue({ ...DATA, passage: null });
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(screen.getByRole('combobox', { name: 'Choose a voyage to view' })).toHaveValue('latest');
        expect(mocks.fetchVoyageLog.mock.calls.every((call) => call[1] === 'latest')).toBe(true);
    });

    it('a delayed full response cannot change a newer instrument consent answer or stop its panel', async () => {
        mocks.fetchPublicInstruments.mockResolvedValue(DATA);
        await openPage();
        let complete!: (data: VoyageLogData) => void;
        mocks.fetchVoyageLog.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        await act(async () => vi.advanceTimersByTimeAsync(70_000));
        await act(async () => complete({ ...DATA, instruments_shared: false }));
        expect(desktopViews().getByRole('button', { name: 'Instruments', pressed: true })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        mocks.fetchPublicInstruments.mockResolvedValue({ ...DATA, instruments_shared: false });
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(screen.getByRole('region', { name: 'Instrument sharing status' })).toBeInTheDocument();
    });

    it('refreshes heel and trim across a minute, then expires a stopped source', async () => {
        let sourceStopped = false;
        let at = NOW;
        mocks.fetchPublicInstruments.mockImplementation(async () => {
            if (!sourceStopped) at = Date.now();
            return {
                ...DATA,
                instruments: {
                    ...INSTRUMENTS,
                    updated_at: new Date(Date.now()).toISOString(),
                    heel_at: new Date(at).toISOString(),
                    pitch_at: new Date(at).toISOString(),
                },
            };
        });
        await openPage();
        fireEvent.click(screen.getByRole('button', { name: 'Heel', pressed: false }));
        for (let i = 0; i < 15; i++) {
            await act(async () => vi.advanceTimersByTimeAsync(5_000));
            expect(screen.getByText('Heel', { selector: 'dt' }).parentElement!).toHaveTextContent('12.3');
            expect(screen.getByRole('button', { name: 'Heel', pressed: true })).toBeInTheDocument();
        }
        expect(mocks.fetchVoyageLog).toHaveBeenCalledTimes(2);
        sourceStopped = true;
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(
            within(screen.getByText('Heel', { selector: 'dt' }).parentElement!).getByLabelText('Unavailable'),
        ).toBeInTheDocument();
        expect(
            within(screen.getByText('Pitch', { selector: 'dt' }).parentElement!).getByLabelText('Unavailable'),
        ).toBeInTheDocument();
    });

    it('keeps Trim selected through a failed instrument request and recovery', async () => {
        mocks.fetchPublicInstruments.mockResolvedValue(DATA);
        await openPage();
        fireEvent.click(screen.getByRole('button', { name: 'Trim' }));
        mocks.fetchPublicInstruments.mockRejectedValueOnce(new Error('offline'));
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(screen.getByText('Connection lost')).toBeInTheDocument();
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(screen.getByRole('button', { name: 'Trim', pressed: true })).toBeInTheDocument();
    });

    it('shows shared instruments first and mounts only the selected content without remounting the map', async () => {
        await openPage();
        expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: ENTRY.title })).not.toBeInTheDocument();
        expect(desktopViews().getByRole('button', { name: 'Instruments', pressed: true })).toBeInTheDocument();
        const toggle = screen.getByRole('group', { name: 'Side panel view' });
        expect(toggle.parentElement?.nextElementSibling?.id).toBe('voyage-panel-content');

        choose('Diary');
        expectDiaryOnly();
        choose('Instruments');
        expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: ENTRY.title })).not.toBeInTheDocument();
        expect(mocks.mapMount).toHaveBeenCalledTimes(1);
    });

    it.each([false, undefined])(
        'defaults to Diary without consent (%s) and never reveals retained readings',
        async (shared) => {
            mocks.fetchVoyageLog.mockResolvedValue({ ...DATA, instruments_shared: shared });
            await openPage();
            expectDiaryOnly();
            choose('Instruments');
            expect(screen.getByRole('region', { name: 'Instrument sharing status' })).toBeInTheDocument();
            expect(screen.queryByRole('region', { name: 'Onboard instruments' })).not.toBeInTheDocument();
            expect(screen.queryByRole('heading', { name: ENTRY.title })).not.toBeInTheDocument();
        },
    );

    it('withdraws retained readings when a poll revokes sharing, without showing diary alongside the notice', async () => {
        await openPage();
        choose('Instruments');
        mocks.fetchVoyageLog.mockResolvedValue({ ...DATA, instruments_shared: false });
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(screen.getByRole('region', { name: 'Instrument sharing status' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Onboard instruments' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: ENTRY.title })).not.toBeInTheDocument();
    });

    it('keeps the chosen Diary view across polling, folding and reopening', async () => {
        await openPage();
        choose('Diary');
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expectDiaryOnly();
        fireEvent.click(screen.getByRole('button', { name: 'Hide log entries' }));
        expect(screen.queryByRole('group', { name: 'Side panel view' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show log entries' }));
        expectDiaryOnly();
    });

    it('opens diary detail from a map marker even with the Instruments panel folded', async () => {
        await openPage();
        fireEvent.click(screen.getByRole('button', { name: 'Hide instruments' }));
        fireEvent.click(screen.getByRole('button', { name: 'Open diary marker' }));
        expectDiaryOnly();
        expect(screen.getByRole('button', { name: 'Back to all entries' })).toBeInTheDocument();
        expect(screen.getByText(ENTRY.body)).toBeInTheDocument();
        choose('Instruments');
        expect(screen.queryByText(ENTRY.body)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Back to all entries' })).not.toBeInTheDocument();
        choose('Diary');
        expect(screen.getByText(ENTRY.body)).toBeInTheDocument();
    });

    it.each(['trip-1', 'all-diary'])(
        'omits current instruments immediately on explicit %s selection, even if its request fails',
        async (trip) => {
            await openPage();
            mocks.fetchVoyageLog.mockRejectedValue(new VoyageLogError(429, 'Try again later'));
            await act(async () =>
                fireEvent.change(screen.getByRole('combobox', { name: 'Choose a voyage to view' }), {
                    target: { value: trip },
                }),
            );
            expectDiaryOnly();
            expect(desktopViews().getByRole('button', { name: 'Instruments' })).toBeDisabled();
            mocks.fetchVoyageLog.mockResolvedValue(DATA);
            await act(async () =>
                fireEvent.change(screen.getByRole('combobox', { name: 'Choose a voyage to view' }), {
                    target: { value: 'latest' },
                }),
            );
            expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        },
    );

    it('starts on all entries at the berth while still offering shared instruments', async () => {
        mocks.fetchVoyageLog.mockResolvedValue({
            ...DATA,
            passage: null,
            selected_trip: 'all-diary',
            trips: [DATA.trips[1]],
        });
        await openPage();
        expectDiaryOnly();
        expect(screen.getByRole('heading', { name: 'All trips & diary' })).toBeInTheDocument();
        expect(mocks.fetchVoyageLog).toHaveBeenCalledTimes(1);
        expect(desktopViews().getByRole('button', { name: 'Instruments' })).toBeEnabled();
        choose('Instruments');
        expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        expect(desktopViews().getByRole('button', { name: 'Instruments' })).toBeEnabled();
        expect(screen.queryByRole('heading', { name: ENTRY.title })).not.toBeInTheDocument();
    });

    it('keeps empty instrument data in its honest waiting state instead of inserting a diary', async () => {
        mocks.fetchVoyageLog.mockResolvedValue({ ...DATA, instruments: null });
        await openPage();
        expect(screen.getByText('Waiting for the next report from the boat.')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: ENTRY.title })).not.toBeInTheDocument();
        choose('Diary');
        expectDiaryOnly();
    });

    it('does not revive expired sensors when reopening between the parent clock ticks', async () => {
        await openPage();
        choose('Diary');
        await act(async () => vi.advanceTimersByTimeAsync(15_000));
        choose('Instruments');
        fireEvent.click(screen.getByText('More instruments'));
        const heelReading = screen.getByText('Heel', { selector: 'dt' }).parentElement!;
        expect(within(heelReading).getByLabelText('Unavailable')).toBeInTheDocument();
        expect(heelReading).not.toHaveTextContent('12.3');
    });

    it('resets the content scroll when switching panels without moving the switch into the scroll area', async () => {
        await openPage();
        const content = document.getElementById('voyage-panel-content')!;
        content.scrollTop = 700;
        choose('Diary');
        expect(content.scrollTop).toBe(0);
        expect(within(content).queryByRole('group', { name: 'Side panel view' })).not.toBeInTheDocument();
    });
});

describe('public voyage mobile views', () => {
    beforeEach(() => {
        mockViewport();
        mocks.fetchPublicInstruments.mockResolvedValue(DATA);
    });

    it('opens on Map and keeps the fast instrument feed asleep through the full voyage refresh', async () => {
        await openPage();
        expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
        expect(document.getElementById('voyage-map')).not.toHaveClass('hidden');
        expect(screen.getByRole('complementary')).toHaveClass('hidden');
        expect(mocks.fetchPublicInstruments).not.toHaveBeenCalled();

        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(mocks.fetchVoyageLog).toHaveBeenCalledTimes(2);
        expect(mocks.fetchPublicInstruments).not.toHaveBeenCalled();
        expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
    });

    it('floats compact voyage context over Map and keeps Diary and Instruments one tap away', async () => {
        await openPage();
        const header = screen.getByTestId('public-voyage-header');
        expect(header).toHaveAttribute('data-overlay', 'true');
        expect(header).toHaveClass('absolute');
        expect(
            mobileViews()
                .getAllByRole('button')
                .map((button) => button.textContent?.trim()),
        ).toEqual(['Map', 'Diary', 'Instruments']);
        chooseMobile('Diary');
        expect(header).toHaveAttribute('data-overlay', 'false');
        expect(header).not.toHaveClass('absolute');
        chooseMobile('Map');
        fireEvent.click(screen.getByRole('button', { name: 'Expand map' }));
        expect(header).toHaveClass('hidden');
        fireEvent.click(screen.getByRole('button', { name: 'Restore page header' }));
        expect(header).not.toHaveClass('hidden');
        expect(mocks.mapMount).toHaveBeenCalledTimes(1);
    });

    it('polls only while Instruments is selected and preserves the map through every view', async () => {
        await openPage();
        const map = document.getElementById('voyage-map');
        const marker = screen.getByRole('button', { name: 'Open diary marker' });

        await act(async () => chooseMobile('Instruments'));
        expect(mobileViews().getByRole('button', { name: 'Instruments', pressed: true })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        expect(map).toHaveClass('hidden', 'lg:block');
        expect(screen.getByRole('complementary')).not.toHaveClass('hidden');
        expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(2);

        chooseMobile('Map');
        expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
        expect(map).not.toHaveClass('hidden');
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(2);

        chooseMobile('Diary');
        expect(mobileViews().getByRole('button', { name: 'Diary', pressed: true })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: ENTRY.title })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Onboard instruments' })).not.toBeInTheDocument();
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(2);
        expect(document.getElementById('voyage-map')).toBe(map);
        expect(screen.getByRole('button', { name: 'Open diary marker' })).toBe(marker);
        expect(mocks.mapMount).toHaveBeenCalledTimes(1);
    });

    it('aborts an in-flight instrument request when returning to Map', async () => {
        mocks.fetchPublicInstruments.mockImplementation(() => new Promise(() => {}));
        await openPage();
        chooseMobile('Instruments');
        const signal = mocks.fetchPublicInstruments.mock.calls[0][1] as AbortSignal;
        expect(signal.aborted).toBe(false);
        chooseMobile('Map');
        expect(signal.aborted).toBe(true);
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(1);
    });

    it('opens a map marker in Diary detail and leaves the instrument feed asleep', async () => {
        await openPage();
        const marker = screen.getByRole('button', { name: 'Open diary marker' });
        marker.focus();
        fireEvent.click(marker);
        expect(mobileViews().getByRole('button', { name: 'Diary', pressed: true })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Diary content' })).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Back to all entries' })).toBeInTheDocument();
        expect(screen.getByText(ENTRY.body)).toBeInTheDocument();
        expect(screen.getByTestId('guest-comments')).toHaveAttribute('data-handle', 'serene-summer');
        expect(screen.getByTestId('guest-comments')).toHaveAttribute('data-entry-id', ENTRY.id);
        expect(screen.getByRole('complementary')).not.toHaveClass('hidden');
        expect(document.getElementById('voyage-map')).toHaveClass('hidden');
        expect(mocks.fetchPublicInstruments).not.toHaveBeenCalled();
        expect(mocks.mapMount).toHaveBeenCalledTimes(1);
    });

    it.each(['trip-1', 'all-diary'])(
        'disables current instruments for explicit %s selection even while its request fails',
        async (trip) => {
            await openPage();
            await act(async () => chooseMobile('Instruments'));
            mocks.fetchVoyageLog.mockRejectedValue(new VoyageLogError(429, 'Try again later'));
            await act(async () =>
                fireEvent.change(screen.getByRole('combobox', { name: 'Choose a voyage to view' }), {
                    target: { value: trip },
                }),
            );
            expect(mobileViews().getByRole('button', { name: 'Instruments' })).toBeDisabled();
            expect(
                mobileViews().getByRole('button', { name: trip === 'all-diary' ? 'Map' : 'Diary', pressed: true }),
            ).toBeInTheDocument();
            expect(screen.queryByRole('region', { name: 'Onboard instruments' })).not.toBeInTheDocument();
            await act(async () => vi.advanceTimersByTimeAsync(30_000));
            expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(1);
            chooseMobile('Map');
            expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
            chooseMobile('Diary');
            expect(screen.getByRole('heading', { name: ENTRY.title })).toBeInTheDocument();
        },
    );

    it('can open Instruments on a phone after the desktop panel was folded', async () => {
        const resize = mockViewport(1024, 768);
        await openPage();
        fireEvent.click(screen.getByRole('button', { name: 'Hide instruments' }));
        expect(document.getElementById('voyage-side-panel')).not.toBeInTheDocument();
        expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(1);

        act(() => resize(390, 844));
        expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(1);
        await act(async () => chooseMobile('Instruments'));
        expect(mobileViews().getByRole('button', { name: 'Instruments', pressed: true })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        expect(screen.getByRole('complementary')).not.toHaveClass('hidden');
        expect(mocks.fetchPublicInstruments).toHaveBeenCalledTimes(2);
        expect(mocks.mapMount).toHaveBeenCalledTimes(1);
    });

    it('keeps a wide landscape phone on Map with its header restored by the map control', async () => {
        mockViewport(844, 390);
        await openPage();
        const selectionHeader = screen.getByRole('region', { name: 'Voyage selection' }).parentElement;
        expect(mobileViews().getByRole('button', { name: 'Map', pressed: true })).toBeInTheDocument();
        expect(selectionHeader).toHaveClass('hidden');
        expect(mocks.fetchPublicInstruments).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Restore page header', pressed: true }));
        expect(selectionHeader).not.toHaveClass('hidden');
        expect(screen.getByRole('button', { name: 'Expand map', pressed: false })).toBeInTheDocument();
        chooseMobile('Diary');
        expect(mobileViews().getByRole('button', { name: 'Diary', pressed: true })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: ENTRY.title })).toBeInTheDocument();
        expect(mocks.mapMount).toHaveBeenCalledTimes(1);
    });
});
