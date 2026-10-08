/**
 * Plan Your Day's sheet, build 124 — "Today on the water"
 * (components/dayPlanner/TodaySheet.tsx and its three nested screens).
 *
 * Shane, 2026-10-08: "ok, can you revamp the plan your day thing, it does
 * nothing of use at the moment claude. make it work please ;)". The sheet
 * opens straight onto today wherever the boat is, with no form: the morning,
 * afternoon and evening against her own limits, one headline, the light and
 * tide, and the best stops with leave, there and home times. A stop's detail
 * says how each time was worked out, and Plot on chart sets the Plan page's
 * departure and hands the chart straight pins. Every place is still listed
 * on a rough day, with its reason.
 *
 * The real engine and loader run against synthetic sources (seven models at
 * one point, route wind and sea, tides) and the real Whitsundays atlas tile;
 * only the I/O is fake. Times are the place's own (AEST here).
 */
import { readFileSync } from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TodaySheet, { type TodaySheetIO } from '../components/dayPlanner/TodaySheet';
import type { AtlasFeature } from '../services/dayPlanner/places';
import type { TodayLoaderDeps } from '../services/dayPlanner/todayLoader';
import type { BoatFix } from '../services/boatPositionChain';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { PLAN_DEPARTURE_EVENT, PLAN_DEPARTURE_KEY } from '../services/planDeparture';
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';
import type { VesselProfile } from '../types/vessel';
import { DEFAULT_VESSEL } from '../utils/defaultVessel';
import { H, MARINA, NOUMEA, NOW, fakeTodayDeps, type DayPlanScenario } from './helpers/dayPlanFixtures';

const QLD_TILE = JSON.parse(readFileSync('public/anchorages/qld/t-22e148.geojson', 'utf8')) as {
    features: AtlasFeature[];
};

/** A fictional skipper's own boat: configured, so no default-boat notice. */
const OWN_BOAT: VesselProfile = {
    ...DEFAULT_VESSEL,
    name: 'Fixture Yacht',
    length: 40,
    draft: 7.87,
    cruisingSpeed: 6,
};

const BOAT_FIX: BoatFix = { latitude: MARINA.lat, longitude: MARINA.lon, timestamp: NOW - 2 * H, rung: 'cloud' };

function io(
    over: Partial<TodaySheetIO> & { scenario?: DayPlanScenario; loader?: Partial<TodayLoaderDeps> } = {},
): TodaySheetIO & { loader: TodayLoaderDeps } {
    const base = fakeTodayDeps({ scenario: over.scenario, atlas: QLD_TILE.features });
    const loader = Object.fromEntries(
        Object.entries({ ...base, ...over.loader }).map(([k, f]) => [k, vi.fn(f as never)]),
    ) as unknown as TodayLoaderDeps;
    return {
        readBoat: async () => BOAT_FIX,
        readPhone: async () => null,
        geocode: async () => null,
        ...over,
        loader,
    };
}

function open(
    options: {
        vessel?: VesselProfile;
        usingDefaultVessel?: boolean;
        sheetIo?: ReturnType<typeof io>;
    } = {},
) {
    const handlers = { onClose: vi.fn(), onPlot: vi.fn(), onOpenVessel: vi.fn() };
    const sheetIo = options.sheetIo ?? io();
    render(
        <TodaySheet
            vessel={options.vessel ?? DEFAULT_VESSEL}
            usingDefaultVessel={options.usingDefaultVessel ?? true}
            {...handlers}
            io={sheetIo}
        />,
    );
    return { ...handlers, io: sheetIo, dialog: screen.getByRole('dialog', { name: 'Plan Your Day' }) };
}

const LEAVE_THERE_HOME = /^Leave \d\d:\d\d · there \d\d:\d\d · home \d\d:\d\d$/;

/** The stop rows on screen 1 once their route forecasts are in. */
async function stopRows(dialog: HTMLElement, count = 3) {
    const list = await within(dialog).findByRole('list', { name: 'Stops' });
    await waitFor(() => {
        const rows = within(list).getAllByRole('button');
        expect(rows).toHaveLength(count);
        for (const row of rows) expect(row.textContent).toMatch(/Leave \d\d:\d\d · there \d\d:\d\d/);
    });
    return within(list).getAllByRole('button');
}

beforeEach(async () => {
    setAuthIdentityScope(null);
    setAuthIdentityScope('fixture-skipper');
    await awaitSettingsLoaded();
    useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, comfortParams: undefined, polarData: undefined },
    });
    sessionStorage.clear();
});

afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
});

describe('Screen 1: today at the boat, with no form', () => {
    it('shows the day, one headline, the light and tide, and the best stops with leave, there and home', async () => {
        const { dialog, io: sources } = open();
        // The place is named from the atlas and the boat's report is dated.
        const place = await within(dialog).findByRole('button', { name: /^Plan from: .+, 2 h ago$/ });
        expect(place).toHaveAttribute('aria-haspopup', 'dialog');

        const day = await within(dialog).findByRole('list', { name: 'The day' });
        await waitFor(() =>
            expect(
                within(day)
                    .getAllByRole('listitem')
                    .map((c) => c.getAttribute('aria-label')),
            ).toEqual([
                expect.stringMatching(
                    /^Morning: south-east \d+( to \d+)? knots, gusts \d+, (inside|near) your limits$/,
                ),
                expect.stringMatching(/^Afternoon: south-east/),
                expect.stringMatching(/^Evening: south-east/),
            ]),
        );
        // Three day chips, each spoken with whether the models agree.
        const chips = within(within(dialog).getByRole('group', { name: 'Day' })).getAllByRole('button');
        expect(chips.map((c) => c.textContent)).toEqual(['Today', 'Fri', 'Sat']);
        expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
        expect(chips[1]).toHaveAccessibleName('Friday 9 October, Some spread');

        expect(within(dialog).getByTestId('day-plan-facts')).toHaveTextContent(
            /^☀ \d\d:\d\d–\d\d:\d\d · HW 10:52 · LW 17:03$/,
        );
        const rows = await stopRows(dialog);
        for (const row of rows) expect(row.querySelector('.today-stop-l2')!.textContent).toMatch(LEAVE_THERE_HOME);
        // Only the best three got their own route forecasts: one spread and one sea each.
        expect(sources.loader.loadRouteSpread).toHaveBeenCalledTimes(3);
        expect(sources.loader.loadRouteSea).toHaveBeenCalledTimes(3);

        // The default boat works, and says so.
        expect(within(dialog).getByRole('button', { name: 'Typical 6 kn boat: set yours in Vessel ›' })).toBeTruthy();
        // The models that answered are credited on the card.
        expect(within(dialog).getByTestId('day-plan-credit')).toHaveTextContent(
            /^Forecast: .*ECMWF.*JMA.* · Waves: Météo-France · Not a clearance$/,
        );
        expect(within(dialog).getByRole('button', { name: /^All places \(\d+\) ›$/ })).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: /^Bureau of Meteorology warnings/ })).toHaveTextContent(
            'BoM warnings ↗',
        );
    });

    it('a third stop row is there for a taller screen to show', async () => {
        const { dialog } = open();
        // The row count is the stylesheet's (2 under 640 px tall, 3 above): all three are drawn.
        const rows = await stopRows(dialog, 3);
        expect(rows).toHaveLength(3);
    });

    it('the default-boat notice opens Vessel', async () => {
        const { dialog, onOpenVessel } = open();
        fireEvent.click(
            await within(dialog).findByRole('button', { name: 'Typical 6 kn boat: set yours in Vessel ›' }),
        );
        expect(onOpenVessel).toHaveBeenCalledOnce();
    });

    it('her own boat gets no notice, and the planner never asks about the draft or the Auto switch', async () => {
        const { dialog } = open({ vessel: OWN_BOAT, usingDefaultVessel: false });
        await stopRows(dialog);
        expect(within(dialog).queryByText(/Typical 6 kn boat/)).toBeNull();
        expect(screen.queryByRole('dialog', { name: /draft/i })).toBeNull();
    });

    it('a rough day says Stay put and still lists the stops, with reasons', async () => {
        const { dialog } = open({ sheetIo: io({ scenario: 'over' }) });
        await waitFor(() =>
            expect(within(dialog).getByTestId('day-plan-headline')).toHaveTextContent(
                /^Stay put today: SE \d+(–\d+)? kn, gusts \d+, over your limits all day\./,
            ),
        );
        const list = await within(dialog).findByRole('list', { name: 'Stops' });
        await waitFor(() => expect(within(list).getAllByRole('button').length).toBeGreaterThanOrEqual(2));
        for (const row of within(list).getAllByRole('button'))
            expect(row.getAttribute('aria-label')).toMatch(/over your limits/);
    });

    it('offline: no forecast, stops by distance with the weather not checked, the light still shown', async () => {
        const { dialog } = open({
            vessel: OWN_BOAT,
            usingDefaultVessel: false,
            sheetIo: io({ scenario: 'offline' }),
        });
        await waitFor(() => expect(within(dialog).getByText('Offline: light and cached tides only')).toBeTruthy());
        const day = within(dialog).getByRole('list', { name: 'The day' });
        for (const cell of within(day).getAllByRole('listitem')) expect(cell).toHaveTextContent('No forecast');
        await waitFor(() => {
            const rows = within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('listitem');
            expect(rows.length).toBeGreaterThanOrEqual(2);
            for (const row of rows) expect(row.textContent).toMatch(/weather not checked/);
        });
        expect(within(dialog).getByTestId('day-plan-facts')).toHaveTextContent(/^☀ \d\d:\d\d–\d\d:\d\d/);
    });

    it('closes when the account changes, and the close button closes it', async () => {
        const first = open();
        fireEvent.click(within(first.dialog).getByRole('button', { name: 'Close' }));
        expect(first.onClose).toHaveBeenCalledOnce();
        cleanup();

        const second = open();
        act(() => setAuthIdentityScope('another-skipper'));
        expect(second.onClose).toHaveBeenCalled();
    });
});

describe('Stay and day', () => {
    it('Overnight times one way; another day chip plans that day', async () => {
        const { dialog } = open();
        await stopRows(dialog);
        const stay = within(dialog).getByRole('combobox', { name: 'Stay' });
        expect(within(dialog).getByText('Stay 2 h ▾')).toBeTruthy();
        expect([...stay.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
            '1 h ashore',
            '2 h ashore',
            '4 h ashore',
            'Overnight',
        ]);
        fireEvent.change(stay, { target: { value: 'overnight' } });
        expect(within(dialog).getByText('Overnight ▾')).toBeTruthy();
        await waitFor(() => {
            const rows = within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button');
            for (const row of rows)
                expect(row.querySelector('.today-stop-l2')!.textContent).toMatch(
                    /^Leave \d\d:\d\d · there \d\d:\d\d · (about \d+|\d+\.\d) NM$/,
                );
        });

        const friday = within(within(dialog).getByRole('group', { name: 'Day' })).getByRole('button', {
            name: /^Friday 9 October/,
        });
        fireEvent.click(friday);
        expect(friday).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(within(dialog).getByRole('button', { name: /^All places/ }));
        const places = await screen.findByRole('dialog', { name: /^Places near / });
        expect(within(places).getByRole('heading', { name: 'Not Friday' })).toBeTruthy();
    });
});

describe('Screen 2: a stop, and Plot on chart', () => {
    it('says how each time was worked out, and Plot on chart sets the departure and sends straight pins', async () => {
        const { dialog, onPlot } = open();
        const [first] = await stopRows(dialog);
        // Screen 1 shortens a reviewed stop's name to its place; the detail has it whole.
        const short = first.querySelector('.today-stop-name')!.textContent!;
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', { name: new RegExp(`^${short}`) });
        const name = within(detail).getByRole('heading', { level: 2 }).textContent!;
        expect(within(detail).getByText(/^Thu 8 Oct · times in AEST$/)).toBeTruthy();
        const rows = within(within(detail).getByRole('list', { name: 'How the day goes' })).getAllByRole('listitem');
        const text = rows.map((r) => r.textContent);
        expect(text[0]).toMatch(
            /^Leave \d\d:\d\d → there \d\d:\d\d \(.+, (sailing|beating|motoring|at cruising speed)/,
        );
        expect(text.some((t) => /^Ashore \d\d:\d\d–\d\d:\d\d · /.test(t!))).toBe(true);
        expect(text.some((t) => /^Home \d\d:\d\d → \d\d:\d\d/.test(t!))).toBe(true);
        expect(text.some((t) => /^(Light: home .+ before last light|Home in the last of the light)/.test(t!))).toBe(
            true,
        );
        expect(text.some((t) => /^About \d+ NM each way/.test(t!))).toBe(true);
        expect(
            within(detail).getByText(/Depth and tide over the route are not checked\. Not a clearance\.$/),
        ).toBeTruthy();

        // The leave chips: the window's departures, the best one marked.
        const leave = within(within(detail).getByRole('group', { name: 'Leave at' })).getAllByRole('button');
        const best = leave.find((b) => b.getAttribute('aria-pressed') === 'true')!;
        expect(best.textContent).toMatch(/^\d\d:\d\d best$/);

        const heard: Event[] = [];
        const listen = (e: Event) => heard.push(e);
        window.addEventListener(PLAN_DEPARTURE_EVENT, listen);
        fireEvent.click(within(detail).getByRole('button', { name: 'Plot on chart' }));
        window.removeEventListener(PLAN_DEPARTURE_EVENT, listen);

        expect(onPlot).toHaveBeenCalledOnce();
        const action = onPlot.mock.calls[0][0];
        expect(action).toMatchObject({ kind: 'plot-day', name: `Day out: ${name}`, stop: name });
        expect(action.points).toHaveLength(3);
        expect(action.points[0]).toEqual({ lat: MARINA.lat, lon: MARINA.lon });
        expect(action.points[2]).toEqual(action.points[0]);
        const stored = sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, getAuthIdentityScope()));
        expect(Number(stored)).toBeGreaterThan(NOW);
        expect(heard).toHaveLength(1);
    });

    it('a leave chip recomputes the detail in place; Back returns to the day', async () => {
        const { dialog } = open();
        const [first] = await stopRows(dialog);
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', {
            name: new RegExp(`^${first.querySelector('.today-stop-name')!.textContent!}`),
        });
        const chips = within(within(detail).getByRole('group', { name: 'Leave at' })).getAllByRole('button');
        const other = chips.find((b) => b.getAttribute('aria-pressed') !== 'true');
        if (other) {
            const at = other.textContent!.slice(0, 5);
            fireEvent.click(other);
            expect(other).toHaveAttribute('aria-pressed', 'true');
            expect(within(detail).getAllByRole('listitem')[0].textContent).toMatch(new RegExp(`^Leave ${at} → `));
        }
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        await waitFor(() => expect(detail.isConnected).toBe(false));
        expect(screen.getByRole('dialog', { name: 'Plan Your Day' })).toBeTruthy();
    });
});

describe('The landing tide', () => {
    it('is asked only when a reviewed stop with a Parks landing note opens, and says so when there is no curve', async () => {
        const { dialog, io: sources } = open();
        const rows = await stopRows(dialog);
        expect(sources.loader.loadTideCurve).not.toHaveBeenCalled();
        // Maureen's Cove's Parks note says mid to high tide (destinations.ts landingTide).
        const cove = rows.find((r) => r.querySelector('.today-stop-name')!.textContent!.startsWith('Maureen'))!;
        fireEvent.click(cove);
        const detail = await screen.findByRole('dialog', { name: /^Maureen/ });
        await waitFor(() => expect(sources.loader.loadTideCurve).toHaveBeenCalledTimes(1));
        expect(
            await within(detail).findByText('Landing: Queensland Parks say mid to high tide. No tide prediction here.'),
        ).toBeTruthy();
    });
});

describe('All places', () => {
    it('lists what fits today and, for every other place, a plain reason', async () => {
        const { dialog } = open();
        await stopRows(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: /^All places/ }));
        const places = await screen.findByRole('dialog', { name: /^Places near / });
        expect(within(places).getByRole('heading', { name: 'Fits today' })).toBeTruthy();
        expect(within(places).getByRole('heading', { name: 'Not today' })).toBeTruthy();
        // Nara Inlet is closed for the week (Queensland Parks), whatever the weather.
        expect(within(places).getByText(/^Nara Inlet( · .+)? · closed 6–15 Oct \(Queensland Parks\)$/)).toBeTruthy();
        fireEvent.click(within(places).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Places near / })).toBeNull());
    });
});

describe('Sources and limits', () => {
    it('names whose limits, which models answered and every source; Change edits Comfort and the plan follows', async () => {
        const { dialog } = open();
        await stopRows(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Sources and limits' }));
        const sources = await screen.findByRole('dialog', { name: 'Sources and limits' });
        expect(within(sources).getByTestId('day-plan-limits')).toHaveTextContent(
            /^Wind [\d.]+\/[\d.]+ kn · gusts [\d.]+\/[\d.]+ kn · sea [\d.]+\/[\d.]+ m \(from a typical cruiser\)$/,
        );
        expect(within(sources).getByText(/— 7 of 7 answered for today$/)).toBeTruthy();
        for (const credit of [
            /^Forecast data: /,
            'Waves: Météo-France (MFWAM)',
            'Tides: WorldTides, Harbour Gauge, metres above LAT, approx. ±0.3 m',
            'Places: © OpenStreetMap contributors (ODbL)',
            'Queensland anchorage atlas (OpenStreetMap + GBRMPA)',
            'Queensland Parks notes, CC BY 4.0, © State of Queensland',
            'Light: worked out on this phone',
        ])
            expect(within(sources).getByText(credit)).toBeTruthy();
        expect(within(sources).getByText(/^Not checked: depth and tide over the route/)).toBeTruthy();
        expect(within(sources).getByText('A planning aid. Cautions, not blocks. Not a clearance.')).toBeTruthy();
        expect(within(sources).getByRole('button', { name: /^Official warnings: Bureau of Meteorology/ })).toBeTruthy();

        fireEvent.click(within(sources).getByRole('button', { name: 'Change' }));
        // The Comfort settings themselves, in place.
        expect(within(sources).getByRole('button', { name: /Comfort/i })).toBeTruthy();
        act(() =>
            useSettingsStore.setState({
                settings: { ...useSettingsStore.getState().settings, comfortParams: { maxWindKts: 12 } },
            }),
        );
        expect(within(sources).getByTestId('day-plan-limits')).toHaveTextContent(
            /^Wind 9\.6\/12 kn · .*\(from your Comfort settings and a typical cruiser\)$/,
        );
    });
});

describe('Where from', () => {
    it('with no boat position it asks, and a typed lat, lon plans from there (Nouméa: no atlas, OSM only)', async () => {
        const sheetIo = io({ readBoat: async () => null });
        const { dialog } = open({ sheetIo });
        await waitFor(() =>
            expect(within(dialog).getByTestId('day-plan-headline')).toHaveTextContent('Where are you planning from?'),
        );
        for (const name of ['This phone', 'Saved place', 'Type a place'])
            expect(within(dialog).getByRole('button', { name })).toBeTruthy();
        // Everything else waits for a place.
        expect(within(dialog).queryByRole('list', { name: 'The day' })).toBeNull();
        expect(sheetIo.loader.querySpread).not.toHaveBeenCalled();

        fireEvent.click(within(dialog).getByRole('button', { name: 'Type a place' }));
        const picker = await screen.findByRole('dialog', { name: 'Plan from' });
        // Signed in but no report from her: the boat option says so.
        expect(within(picker).getByRole('button', { name: /^Boat/ })).toBeDisabled();
        expect(within(picker).getByText('No position from the boat in the last 24 h')).toBeTruthy();
        const field = within(picker).getByRole('textbox', { name: 'Type a place or lat, lon' });
        fireEvent.change(field, { target: { value: `${NOUMEA.lat}, ${NOUMEA.lon}` } });
        fireEvent.submit(field.closest('form')!);
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Plan from' })).toBeNull());
        await waitFor(() => expect(sheetIo.loader.querySpread).toHaveBeenCalledWith(NOUMEA.lat, NOUMEA.lon));
        expect(within(dialog).getByRole('button', { name: /^Plan from: 22\.28°S 166\.44°E/ })).toBeTruthy();
    });

    it('signed out, the boat option asks for a sign-in; a typed place goes through the geocoder', async () => {
        setAuthIdentityScope(null);
        const geocode = vi.fn(async () => ({ lat: -16.5, lon: 179.9, name: 'Fixture Bay' }));
        const sheetIo = io({ readBoat: async () => null, geocode });
        const { dialog } = open({ sheetIo });
        await within(dialog).findByRole('button', { name: 'Type a place' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Type a place' }));
        const picker = await screen.findByRole('dialog', { name: 'Plan from' });
        expect(within(picker).getByText('Sign in to see her position')).toBeTruthy();
        const field = within(picker).getByRole('textbox', { name: 'Type a place or lat, lon' });
        fireEvent.change(field, { target: { value: 'Fixture Bay' } });
        fireEvent.submit(field.closest('form')!);
        await waitFor(() => expect(geocode).toHaveBeenCalledWith('Fixture Bay', null));
        await waitFor(() => expect(sheetIo.loader.querySpread).toHaveBeenCalledWith(-16.5, 179.9));
        expect(within(dialog).getByRole('button', { name: /^Plan from: Fixture Bay/ })).toBeTruthy();
    });

    it('saved places with coordinates are offered, home port first', async () => {
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                homePort: 'Fixture Harbour',
                savedLocations: ['Fixture Harbour', 'Somewhere Unmapped', 'Fixture Reach'],
                savedLocationCoords: {
                    'Fixture Harbour': { lat: -20.3, lon: 148.75 },
                    'Fixture Reach': { lat: -20.2, lon: 148.9 },
                },
            },
        });
        const { dialog } = open();
        fireEvent.click(await within(dialog).findByRole('button', { name: /^Plan from: .+, 2 h ago$/ }));
        const picker = await screen.findByRole('dialog', { name: 'Plan from' });
        const options = within(picker)
            .getAllByRole('button')
            .map((b) => b.textContent)
            .filter((t) => /Fixture|Unmapped/.test(t ?? ''));
        expect(options).toEqual(['Home port · Fixture Harbour', 'Fixture Reach']);
    });
});
