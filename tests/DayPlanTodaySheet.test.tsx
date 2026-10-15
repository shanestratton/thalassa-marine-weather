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
 *
 * Build 127 (127-PYD-1, "say why"): a ✕ row shows its reason on screen, the
 * stop page opens on its verdict, the day chips carry her limits' glyph (never
 * the models' agreement glyphs), line icons replace the emoji, a reviewed stop
 * is tagged "Local notes", and the credit names only the sources that answered.
 *
 * 127-PYD-3: the stop page's main button follows the route: Route round the
 * land, Finding the way…, Show route on chart (Auto's chart over the sheet,
 * lazily loaded; mocked here), Plot your saved route, or Plot by hand (her
 * start and the stop as two marks, never a straight line).
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
import { resolveDayPlanLimits } from '../services/dayPlanner/today';
import {
    H,
    MARINA,
    NOUMEA,
    NOW,
    fakeTodayDeps,
    osmAnchorage,
    pointBlock,
    routeSpread,
    type DayPlanScenario,
} from './helpers/dayPlanFixtures';
import { routeStop, type StopRouteDeps, type StopRouteRequest } from '../services/dayPlanner/stopRoute';
import type { AutoroutingTrialRequest, AutoroutingTrialRoute } from '../types/autorouting';
import { DraftConfirmModal } from '../components/vessel/DraftConfirmModal';

// Auto's chart (127-PYD-3) is a Mapbox map: the sheet's side of it is tested here with a stand-in that
// keeps the props it was given; tests/AutoroutingTrialWorkspace.test.tsx tests the chart's own day-plan mode.
// Its satellite Retry is played by two buttons: land after all (Auto's words), or the checked copy.
// `hold` keeps it loading (a thrown promise suspends, as a slow chunk does), so the fallback shows.
const chart = vi.hoisted(() => ({
    props: null as null | import('../components/autorouting/AutoroutingTrialWorkspace').AutoroutingTrialWorkspaceProps,
    hold: null as null | Promise<void>,
    land: 'Satellite relief shows land near 20.270° S, 148.930° E. The route is not shown. Nothing changed.',
}));
vi.mock('../components/autorouting/AutoroutingTrialWorkspace', () => ({
    AutoroutingTrialWorkspace: (
        props: import('../components/autorouting/AutoroutingTrialWorkspace').AutoroutingTrialWorkspaceProps,
    ) => {
        if (chart.hold) throw chart.hold;
        chart.props = props;
        const day = props.dayPlan!;
        return (
            <div role="dialog" aria-label={`Route chart: ${day.stopName}`}>
                <button type="button" onClick={() => day.onUseOnMainChart(day.proposal)}>
                    Use on the main chart
                </button>
                <button type="button" onClick={() => day.onRechecked(chart.land)}>
                    Retry finds land
                </button>
                <button
                    type="button"
                    onClick={() =>
                        day.onRechecked({
                            ...day.proposal,
                            engine: { ...day.proposal.engine!, backstop: 'verified', backstopReason: undefined },
                        })
                    }
                >
                    Retry clears it
                </button>
                {/* A recalculated line under the same stop (127-PYD-11's leave window keys on the line). */}
                <button
                    type="button"
                    onClick={() =>
                        day.onRechecked({
                            ...day.proposal,
                            coordinates: day.proposal.coordinates.map(([lon, lat]) => [lon + 0.3, lat]),
                        })
                    }
                >
                    Recalculate finds another line
                </button>
                <button type="button" onClick={props.onClose}>
                    Back to Plan Your Day
                </button>
            </div>
        );
    },
}));

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

/** A stop's times, short so they can be big (126-17c): leave → arrive · back home. */
const TIMES_BACK = /^\d\d:\d\d → \d\d:\d\d · back \d\d:\d\d$/;

/** The stop rows on screen 1 once their route forecasts are in. */
async function stopRows(dialog: HTMLElement, count = 3) {
    const list = await within(dialog).findByRole('list', { name: 'Stops' });
    await waitFor(() => {
        const rows = within(list).getAllByRole('button');
        expect(rows).toHaveLength(count);
        for (const row of rows) expect(row.textContent).toMatch(/\d\d:\d\d → \d\d:\d\d · /);
    });
    return within(list).getAllByRole('button');
}

/** A stop page's title, from the name its row shows (a reviewed stop's page has it whole). */
const titled = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/** All places, once it can open (127-PYD-5: every planned place in it is a button). */
async function toPlaces(dialog: HTMLElement) {
    const link = await within(dialog).findByRole('button', { name: /^All places/ });
    await waitFor(() => expect(link).toBeEnabled());
    fireEvent.click(link);
    return screen.findByRole('dialog', { name: /^Places near / });
}

/** The list under one of All places' headings. */
const placesUnder = (places: HTMLElement, heading: string) =>
    within(places).getByRole('heading', { name: heading }).nextElementSibling as HTMLElement;

/** A place's row in All places, by the name it shows, whichever heading it is under. */
const placeRow = (places: HTMLElement, name: string) =>
    within(places)
        .getAllByRole('button')
        .find((b) => b.querySelector('.today-stop-name')?.textContent === name);

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
        // The place is named from the atlas and the boat's report is dated; whose age it is, in words for
        // VoiceOver and by the boat's line icon on screen ("boat 2 h ago" is cut on a 390 or 430 phone).
        const place = await within(dialog).findByRole('button', { name: /^Plan from: .+, boat 2 h ago$/ });
        expect(place).toHaveAttribute('aria-haspopup', 'dialog');
        expect(place.textContent).toMatch(/ · 2 h ago▾$/);
        // A line icon, not an emoji (127-PYD-1).
        expect(place.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(place.querySelector('svg')).not.toBeNull();

        const day = await within(dialog).findByRole('list', { name: 'The day' });
        await waitFor(() =>
            expect(
                within(day)
                    .getAllByRole('listitem')
                    .map((c) => c.getAttribute('aria-label')),
            ).toEqual([
                expect.stringMatching(
                    /^Morning: south-east \d+( to \d+)? knots, gusts \d+, (inside|near) your wind limits$/,
                ),
                expect.stringMatching(/^Afternoon: south-east/),
                expect.stringMatching(/^Evening: south-east/),
            ]),
        );
        // Three day chips, each with that day's best part in her limits' glyph (127-PYD-1: one glyph
        // language, never the models' agreement fork), and spoken with it and whether the models agree.
        const chips = within(within(dialog).getByRole('group', { name: 'Day' })).getAllByRole('button');
        expect(chips.map((c) => c.textContent)).toEqual(['≈Today', '≈Fri', '≈Sat']);
        for (const chip of chips) {
            expect(chip.querySelector('svg')).toBeNull();
            expect(chip.querySelector('[aria-hidden="true"]')).toHaveAttribute('data-level', 'near');
        }
        expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
        expect(chips[1]).toHaveAccessibleName('Friday 9 October, near your wind limits at best, Some spread');

        expect(within(dialog).getByTestId('day-plan-facts')).toHaveTextContent(
            /^☀ \d\d:\d\d–\d\d:\d\d · HW 10:52 · LW 17:03$/,
        );
        const rows = await stopRows(dialog);
        for (const row of rows) expect(row.querySelector('.today-stop-l2')!.textContent).toMatch(TIMES_BACK);
        // A reviewed stop's tag says what it marks, in words a skipper anywhere reads (127-PYD-1): the best
        // fit wears no pick tag (127-PYD-4), so a reviewed one there keeps "Local notes".
        expect(rows[0].querySelector('.today-pick')).toBeNull();
        expect(rows[0].querySelector('.today-tag')).toHaveTextContent(/^Local notes$/);
        expect(within(dialog).queryByText('Parks')).toBeNull();
        // Five got their own route forecasts, the card's three and two backups (127-PYD-4): one spread and one sea each.
        expect(sources.loader.loadRouteSpread).toHaveBeenCalledTimes(5);
        expect(sources.loader.loadRouteSea).toHaveBeenCalledTimes(5);

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

    // 126-17c (Shane, offered "07:00 → 10:28 · back 15:57" so the times can grow: "your pick").
    it('a stop shows its times short, and VoiceOver hears them in words, never "right arrow"', async () => {
        const { dialog } = open();
        const rows = await stopRows(dialog);
        for (const row of rows) {
            const [leave, arrive, home] = row.querySelector('.today-stop-l2')!.textContent!.match(/\d\d:\d\d/g)!;
            expect(row.querySelector('.today-stop-l2')!.textContent).toBe(`${leave} → ${arrive} · back ${home}`);
            expect(row).toHaveAccessibleName(
                expect.stringContaining(`. Leave ${leave}, arrive ${arrive}, back home ${home}. `),
            );
            expect(row.getAttribute('aria-label')).not.toMatch(/→/);
        }
        fireEvent.change(within(dialog).getByRole('combobox', { name: 'Stay' }), { target: { value: 'overnight' } });
        await waitFor(() => {
            for (const row of within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button')) {
                expect(row.querySelector('.today-stop-l2')!.textContent).toMatch(
                    /^\d\d:\d\d → \d\d:\d\d · (about \d+|\d+\.\d) NM$/,
                );
                expect(row).toHaveAccessibleName(
                    expect.stringMatching(
                        /\. Leave \d\d:\d\d, arrive \d\d:\d\d, (about \d+|\d+\.\d) nautical miles\. /,
                    ),
                );
            }
        });
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
        // Each ✕ row says why on screen, where its times were, and VoiceOver hears it once (127-PYD-1).
        await waitFor(() => {
            for (const row of within(list).getAllByRole('button'))
                expect(row.querySelector('.today-stop-l2')!.textContent).toMatch(/^SE \d+ kn on the way$/);
        });
        for (const row of within(list).getAllByRole('button')) {
            const why = row.querySelector('.today-stop-l2')!.textContent!;
            expect(row.querySelector('.today-stop-glyph')).toHaveTextContent('✕');
            expect(row.getAttribute('aria-label')).toMatch(new RegExp(`\\. over your limits: ${why}$`));
            expect(row.getAttribute('aria-label')!.match(/over your limits/g)).toHaveLength(1);
        }
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
        expect(within(dialog).getByTestId('day-plan-headline')).toHaveTextContent(
            'No forecast for today: places shown, weather not checked.',
        );
        // The credit names only what answered: no models, and no wave model either (127-PYD-1).
        expect(within(dialog).getByTestId('day-plan-credit')).toHaveTextContent(
            /^No forecast loaded · Not a clearance$/,
        );
        for (const row of within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button'))
            expect(row.getAttribute('aria-label')!.match(/weather not checked/g)).toHaveLength(1);
        // Sources credits only what answered too: no wave model offline.
        fireEvent.click(within(dialog).getByRole('button', { name: 'Sources and limits' }));
        const sources = await screen.findByRole('dialog', { name: 'Sources and limits' });
        expect(within(sources).getByText('Light: worked out on this phone')).toBeTruthy();
        expect(within(sources).queryByText(/MFWAM|Waves:/)).toBeNull();
    });

    it('a Plan page departure never hides the morning, nor makes 06:30 "too late"', async () => {
        // 17:00 today, left on the Plan page by another passage (or an earlier Plot on chart).
        sessionStorage.setItem(
            authScopedStorageKey(PLAN_DEPARTURE_KEY, getAuthIdentityScope()),
            String(NOW + 10.5 * H),
        );
        const { dialog } = open();
        const rows = await stopRows(dialog);
        expect(within(dialog).getByTestId('day-plan-headline').textContent).not.toMatch(/Too late/);
        const chips = within(within(dialog).getByRole('group', { name: 'Day' })).getAllByRole('button');
        expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
        for (const row of rows) expect(row.querySelector('.today-stop-l2')!.textContent).toMatch(/^0[7-9]:/);
    });

    it('thunder shows in the part it falls in, in the headline in place of the clause it causes, and on its rows', async () => {
        const { dialog } = open({ sheetIo: io({ scenario: 'thunder' }) });
        const day = await within(dialog).findByRole('list', { name: 'The day' });
        await waitFor(() => expect(within(day).getAllByRole('listitem')[1]).toHaveTextContent(/Thunder$/));
        expect(within(day).getAllByRole('listitem')[1].getAttribute('aria-label')).toMatch(
            /near your wind limits, thunder in 3 of 7 models$/,
        );
        // The bolt, not ≈, where thunder holds the part at Near (127-PYD-1), drawn so it keeps ≈'s width.
        expect(within(day).getAllByRole('listitem')[1].querySelector('.today-cell-wind svg.today-bolt')).not.toBeNull();
        expect(within(day).getAllByRole('listitem')[1].querySelector('.today-cell-wind')).not.toHaveTextContent('≈');
        expect(within(day).getAllByRole('listitem')[0]).toHaveTextContent(/Inside$/);
        expect(within(dialog).getByTestId('day-plan-headline')).toHaveTextContent(
            /^Morning's your window: inside your wind limits until about 12:00, then thunder in 3 of 7 models\.$/,
        );
        // A stop home into the afternoon's thunder says so where its times were; one home before noon
        // keeps its times (127-PYD-4: the card is no longer three ✕ when a short hop fits).
        const list = await within(dialog).findByRole('list', { name: 'Stops' });
        await waitFor(() => {
            const rows = within(list).getAllByRole('button');
            expect(rows.some((row) => row.querySelector('.today-stop-glyph')!.textContent === '✕')).toBe(true);
            for (const row of rows)
                expect(row.querySelector('.today-stop-l2')!.textContent).toMatch(
                    row.querySelector('.today-stop-glyph')!.textContent === '✕'
                        ? /^⚡ Thunder on the way home$/
                        : TIMES_BACK,
                );
        });
    });

    it('places that could not be read say so: never an empty list that reads as fitting', async () => {
        const fail = async () => {
            throw new Error('Overpass unavailable');
        };
        const { dialog } = open({ sheetIo: io({ loader: { loadAtlas: fail, loadReferenceTile: fail } }) });
        expect(await within(dialog).findByText("Places didn't load: OpenStreetMap didn't answer.")).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: /^All places/ })).toBeDisabled();
        expect(within(dialog).queryByRole('list', { name: 'Stops' })).toBeNull();
    });

    it('while OpenStreetMap is still answering (no atlas here) it says it is finding places', async () => {
        const { dialog } = open({
            sheetIo: io({ loader: { loadAtlas: async () => [], loadReferenceTile: () => new Promise(() => {}) } }),
        });
        await waitFor(() => expect(within(dialog).getByTestId('day-plan-headline').textContent).toMatch(/kn/));
        expect(within(dialog).getByTestId('day-plan-places')).toHaveTextContent('Finding places…');
        expect(within(dialog).getByRole('button', { name: /^All places/ })).toBeDisabled();
        expect(within(dialog).getByTestId('day-plan-headline').textContent).not.toMatch(/No anchorages mapped/);
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
                    /^\d\d:\d\d → \d\d:\d\d · (about \d+|\d+\.\d) NM$/,
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

/** A list's rows, as they read. */
const listed = (list: HTMLElement) =>
    within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent!);

describe('Screen 2: a stop, and Plot by hand', () => {
    it('opens as a plan read at a glance, every row a tap away; Plot by hand sends two marks, never a line', async () => {
        const { dialog, onPlot } = open();
        const [first] = await stopRows(dialog);
        // Screen 1 shortens a reviewed stop's name to its place; the detail has it whole.
        const short = first.querySelector('.today-stop-name')!.textContent!;
        const times = first.querySelector('.today-stop-l2')!.textContent!;
        const shelter = first.querySelector('.today-stop-shelter')!.textContent!.replace(/^\s*· /, '');
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', { name: new RegExp(`^${short}`) });
        const name = within(detail).getByRole('heading', { level: 2 }).textContent!;
        expect(within(detail).getByText(/^Thu 8 Oct · times in AEST$/)).toBeTruthy();
        // 132-PYD-8: its level at the top, in its colour, with the reason (127-PYD-1): never an ordinary-looking plan.
        const level = detail.querySelector('.today-level')!;
        expect(level).toHaveTextContent(/^≈ Near your limits: SE \d+ kn on the way$/);
        expect(level).toHaveAttribute('data-level', 'near');
        // The way: the distance and how it was measured, and the marina she leaves.
        expect(listed(within(detail).getByRole('list', { name: 'The way' }))).toEqual([
            expect.stringMatching(/^About \d+ NM each way \(/),
            'Leaving a marina: check its approach depth against the tide before you go.',
        ]);
        // The times big: the same as her row on screen 1, what each leg takes under them.
        const cells = within(within(detail).getByRole('list', { name: 'Times' })).getAllByRole('listitem');
        const at = cells.map((cell) => cell.querySelector('.today-times-at')!.textContent);
        expect(`${at[0]} → ${at[1]} · back ${at[2]}`).toBe(times);
        expect(cells[0]).toHaveTextContent(/^Leave \d\d:\d\d \d+ (h|min)( \d\d)? there$/);
        expect(cells[1]).toHaveTextContent(/^Ashore \d\d:\d\d to \d\d:\d\d$/);
        expect(cells[2]).toHaveTextContent(/^Home \d\d:\d\d \d+ (h|min)( \d\d)? back$/);
        // Up to four facts: shelter (her row's word), the sea, the light to spare, and her local notes.
        const facts = listed(within(detail).getByRole('list', { name: 'At a glance' }));
        expect(facts.length).toBeLessThanOrEqual(4);
        expect(facts.slice(0, 3)).toEqual([
            shelter,
            expect.stringMatching(/^(Sea [\d.–]+ m|Sea not checked|No sea reading)$/),
            expect.stringMatching(/^☀ (\d+ h( \d\d)?|\d+ min) to spare$/),
        ]);
        // How each time was worked out: a tap away, closed as it opens, every row as it was.
        const more = detail.querySelector('details.today-how') as HTMLDetailsElement;
        expect(more.open).toBe(false);
        expect(within(more).getByText('How each time was worked out').tagName).toBe('SUMMARY');
        const rows = within(within(more).getByRole('list', { name: 'How the day goes' })).getAllByRole('listitem');
        const text = rows.map((r) => r.textContent!);
        // Why it is here first (127-PYD-4), then the rows, then the polar and wind the times were sailed on.
        expect(rows[0]).toHaveAttribute('data-why', 'true');
        expect(text[0]).toMatch(/^In the lee of the SE breeze · /);
        expect(text[1]).toMatch(
            /^Leave \d\d:\d\d → there \d\d:\d\d \(.+, (sailing|beating|motoring|at cruising speed)/,
        );
        expect(text.some((t) => /^Ashore \d\d:\d\d–\d\d:\d\d · /.test(t))).toBe(true);
        expect(text.some((t) => /^Home \d\d:\d\d → \d\d:\d\d/.test(t))).toBe(true);
        expect(text.some((t) => /^(Light: home .+ before last light|Home in the last of the light)/.test(t))).toBe(
            true,
        );
        expect(text.some((t) => /^Sea/.test(t))).toBe(true);
        expect(text.at(-1)).toMatch(/^Times from .+ wind\. No current\.$/);
        // Each thing once: the level, the distance and the marina line are not repeated in the details.
        expect(text).not.toContain(level.textContent);
        expect(detail.textContent!.match(/NM each way \(/g)).toHaveLength(1);
        expect(detail.textContent!.match(/Leaving a marina/g)).toHaveLength(1);
        // What is not checked stays on the page.
        expect(detail.querySelector('.today-footnote')).toHaveTextContent(
            /^Depth and tide over the route are not checked\. Not a clearance\.$/,
        );

        // The leave chips: the window's departures, the best one marked.
        const leave = within(within(detail).getByRole('group', { name: 'Leave at' })).getAllByRole('button');
        const best = leave.find((b) => b.getAttribute('aria-pressed') === 'true')!;
        expect(best.textContent).toMatch(/^\d\d:\d\d best$/);

        const heard: Event[] = [];
        const listen = (e: Event) => heard.push(e);
        window.addEventListener(PLAN_DEPARTURE_EVENT, listen);
        // The primary button: AA white on its cyan in dark as in light (127-PYD-1). A tester (not the
        // owner in 127) is offered no routing: Plot by hand (127-PYD-3).
        expect(within(detail).queryByRole('button', { name: 'Plot on chart' })).toBeNull();
        expect(within(detail).getByRole('button', { name: 'Plot by hand' })).toHaveClass('today-primary');
        fireEvent.click(within(detail).getByRole('button', { name: 'Plot by hand' }));
        window.removeEventListener(PLAN_DEPARTURE_EVENT, listen);

        expect(onPlot).toHaveBeenCalledOnce();
        const action = onPlot.mock.calls[0][0];
        expect(action).toMatchObject({ kind: 'plot-day', name: `Day out: ${name}`, stop: name });
        // No pins and no line of any kind: her start and the stop, and nothing about routing.
        expect(action.points).toEqual([]);
        expect(action.frame).toMatchObject({
            from: { lat: MARINA.lat, lon: MARINA.lon },
            to: { name },
            why: '',
        });
        expect(action.routed).toBeUndefined();
        const stored = sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, getAuthIdentityScope()));
        expect(Number(stored)).toBeGreaterThan(NOW);
        expect(heard).toHaveLength(1);
    });

    it('her imported polar is sailed as the routers sail it, and the detail says the times are from its own figures (125-08)', async () => {
        // A fictional Expedition-style export (first row 38°), chosen as her polar.
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                polarSource: 'factory',
                polarSource_type: 'file_import',
                polarBoatModel: 'Fair Wind 2025.pol',
                polarData: {
                    windSpeeds: [6, 8, 10, 12, 16, 20, 25],
                    angles: [38, 45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180],
                    matrix: [
                        [3.6, 4.4, 5.0, 5.4, 5.8, 6.0, 6.0],
                        [4.2, 5.0, 5.6, 6.0, 6.4, 6.6, 6.6],
                        [4.6, 5.4, 6.0, 6.4, 6.8, 7.0, 7.0],
                        [4.9, 5.8, 6.4, 6.8, 7.2, 7.4, 7.4],
                        [5.2, 6.1, 6.8, 7.2, 7.6, 7.9, 8.0],
                        [5.3, 6.3, 7.0, 7.4, 7.9, 8.3, 8.5],
                        [5.2, 6.3, 7.0, 7.5, 8.0, 8.6, 9.0],
                        [5.0, 6.1, 6.9, 7.4, 8.0, 8.7, 9.3],
                        [4.5, 5.6, 6.5, 7.1, 7.8, 8.6, 9.4],
                        [3.8, 4.9, 5.8, 6.5, 7.3, 8.1, 9.0],
                        [3.3, 4.3, 5.2, 5.9, 6.8, 7.6, 8.4],
                        [3.0, 4.0, 4.8, 5.5, 6.4, 7.2, 8.0],
                    ],
                },
            },
        });
        const { dialog } = open();
        const [first] = await stopRows(dialog);
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', {
            name: new RegExp(`^${first.querySelector('.today-stop-name')!.textContent}`),
        });
        expect(within(detail).getByText(/^Times from your polar's own figures in .+ wind\. No current\./)).toBeTruthy();
    });

    it("a reviewed stop keeps its own Parks notes whole on the page, one per line, never folded away: Cid Harbour's sharks", async () => {
        const { dialog } = open();
        await stopRows(dialog);
        // Four hours ashore in this trade, Cid Harbour is the best fit (127-PYD-4 picks by the day).
        fireEvent.change(within(dialog).getByRole('combobox', { name: 'Stay' }), { target: { value: '4h' } });
        const rows = await stopRows(dialog);
        const cid = rows.find((r) => r.querySelector('.today-stop-name')!.textContent === 'Cid Harbour')!;
        fireEvent.click(cid);
        const detail = await screen.findByRole('dialog', { name: /^Cid Harbour/ });
        // 132-PYD-8: "Local notes" among its facts, amber as on its row, and the notes themselves under them.
        const facts = within(detail).getByRole('list', { name: 'At a glance' });
        expect(within(facts).getByText('Local notes')).toHaveAttribute('data-notes');
        const notes = within(detail).getByRole('list', { name: 'Local notes' });
        const items = listed(notes);
        expect(items[0]).toMatch(/^Do not swim in Cid Harbour: Queensland Parks warns of dangerous sharks/);
        expect(items.some((t) => /The harbour reference is not a beach landing/.test(t))).toBe(true);
        for (const li of within(notes)
            .getAllByRole('listitem')
            .filter((li) => !li.textContent!.startsWith('Landing')))
            expect(li).toHaveAttribute('data-parks');
        // On the page, not in the details she has to open; and said once.
        expect(notes.closest('details')).toBeNull();
        expect(detail.textContent!.match(/Do not swim in Cid Harbour/g)).toHaveLength(1);
    });

    it("a stop whose route weather failed shows no times anywhere: it says the weather wasn't checked", async () => {
        const fail = async () => {
            throw new Error('proxy 503');
        };
        const { dialog, onPlot } = open({
            sheetIo: io({ loader: { loadRouteSpread: fail, loadRouteForecast: fail } }),
        });
        const list = await within(dialog).findByRole('list', { name: 'Stops' });
        await waitFor(() => {
            const rows = within(list).getAllByRole('button');
            expect(rows).toHaveLength(3);
            // The row says why, where its times would be (127-PYD-1).
            for (const row of rows)
                expect(row.querySelector('.today-stop-l2')!.textContent).toBe("Weather didn't load");
        });
        fireEvent.click(within(list).getAllByRole('button')[0]);
        const detail = await screen.findByRole('dialog', {
            name: new RegExp(
                `^${within(list).getAllByRole('button')[0].querySelector('.today-stop-name')!.textContent}`,
            ),
        });
        // Where the times would be (132-PYD-8), and no times anywhere.
        expect(within(detail).getByText("Weather not checked: the forecast along the way didn't load.")).toHaveClass(
            'today-untimed',
        );
        expect(within(detail).queryByRole('list', { name: 'Times' })).toBeNull();
        expect(within(detail).queryByRole('group', { name: 'Leave at' })).toBeNull();
        expect(within(detail).queryByText(/^Leave \d\d:\d\d → /)).toBeNull();
        expect(detail.querySelector('.today-footnote')).toHaveTextContent(/^No times without a forecast\./);
        // Plot by hand still works, but sets no departure from a walk in no wind.
        fireEvent.click(within(detail).getByRole('button', { name: 'Plot by hand' }));
        expect(onPlot).toHaveBeenCalledOnce();
        expect(sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, getAuthIdentityScope()))).toBeNull();
    });

    it('a stop over her limits in the area with no route weather opens on its verdict, then says why there are no times', async () => {
        const fail = async () => {
            throw new Error('proxy 503');
        };
        const { dialog } = open({
            sheetIo: io({ scenario: 'over', loader: { loadRouteSpread: fail, loadRouteForecast: fail } }),
        });
        const list = await within(dialog).findByRole('list', { name: 'Stops' });
        await waitFor(() => {
            const rows = within(list).getAllByRole('button');
            expect(rows.length).toBeGreaterThanOrEqual(2);
            for (const row of rows)
                expect(row.querySelector('.today-stop-l2')!.textContent).toMatch(/^SE \d+ kn in the area$/);
        });
        const first = within(list).getAllByRole('button')[0];
        const why = first.querySelector('.today-stop-l2')!.textContent!;
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', {
            name: new RegExp(`^${first.querySelector('.today-stop-name')!.textContent}`),
        });
        const level = detail.querySelector('.today-level')!;
        expect(level).toHaveTextContent(`✕ Over your limits: ${why}`);
        expect(level).toHaveAttribute('data-level', 'over');
        // Then why there are no times, where they would be.
        expect(level.parentElement!.querySelector('.today-untimed')).toHaveTextContent(
            "Weather not checked: the forecast along the way didn't load.",
        );
        // Why it is here, from the area wind only (no sail, no times: the weather along the way failed).
        const items = within(within(detail).getByRole('list', { name: 'How the day goes' })).getAllByRole('listitem');
        expect(items[0]).toHaveAttribute('data-why', 'true');
        expect(items[0].textContent).not.toMatch(/under way|both ways/);
        expect(within(detail).queryByText(/^Leave \d\d:\d\d → /)).toBeNull();
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
        expect(other).toBeTruthy();
        const at = other!.textContent!.slice(0, 5);
        fireEvent.click(other!);
        expect(other).toHaveAttribute('aria-pressed', 'true');
        // The big leave time (132-PYD-8), and its row a tap away.
        expect(
            within(within(detail).getByRole('list', { name: 'Times' })).getAllByRole('listitem')[0],
        ).toHaveTextContent(new RegExp(`^Leave ${at} `));
        expect(within(detail).getByText(/^Leave \d\d:\d\d → there /).textContent).toMatch(
            new RegExp(`^Leave ${at} → `),
        );
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        await waitFor(() => expect(detail.isConnected).toBe(false));
        expect(screen.getByRole('dialog', { name: 'Plan Your Day' })).toBeTruthy();
    });

    it('overnight, its times are leave and at anchor until 09:00 tomorrow, with no home (132-PYD-8)', async () => {
        const { dialog } = open();
        await stopRows(dialog);
        fireEvent.change(within(dialog).getByRole('combobox', { name: 'Stay' }), { target: { value: 'overnight' } });
        const list = within(dialog).getByRole('list', { name: 'Stops' });
        await waitFor(() =>
            expect(within(list).getAllByRole('button')[0].querySelector('.today-stop-l2')).toHaveTextContent(
                /^\d\d:\d\d → \d\d:\d\d · .+ NM$/,
            ),
        );
        const first = within(list).getAllByRole('button')[0];
        const times = first.querySelector('.today-stop-l2')!.textContent!.match(/\d\d:\d\d/g)!;
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', {
            name: titled(first.querySelector('.today-stop-name')!.textContent!),
        });
        expect(listed(within(detail).getByRole('list', { name: 'Times' }))).toEqual([
            expect.stringMatching(new RegExp(`^Leave ${times[0]} `)),
            `At anchor ${times[1]} to 09:00 tomorrow`,
        ]);
        expect(
            within(detail)
                .getByText(/^At anchor \d\d:\d\d → 09:00 tomorrow · /)
                .closest('details'),
        ).not.toBeNull();
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
        // Said once (127-PYD-1): the note names the tide, the row gives the window, or says there is none; both
        // on the page with the notes (132-PYD-8).
        const window = await within(detail).findByText('Landing window: no tide prediction here.');
        expect(window.closest('ul')).toBe(within(detail).getByRole('list', { name: 'Local notes' }));
        expect(detail.textContent!.match(/mid-? to high[- ]tide/g)).toHaveLength(1);
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
        // Beyond the five the weather along the way was not checked: on the area wind (127-PYD-5), its times,
        // the basis said once in the heading, and never listed as fitting.
        expect(within(places).getByRole('heading', { name: 'On the area wind' })).toBeTruthy();
        expect(within(places).queryByText(/route weather not checked/)).toBeNull();
        // Nara Inlet is closed for the week (Queensland Parks), whatever the weather.
        expect(within(places).getByText(/^Nara Inlet( · .+)? · closed 6–15 Oct \(Queensland Parks\)$/)).toBeTruthy();
        fireEvent.click(within(places).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Places near / })).toBeNull());
    });
});

// ── 127-PYD-5: every place opens ──────────────────────────────
//
// Shane, 2026-10-10: "why does it only ever show the same 3 destinations." The
// card holds three; every other place in All places opens too: at once on the
// area wind, then on the weather along the way (two requests, once per place).

describe('Every place opens (127-PYD-5)', () => {
    it('every planned place is a compact button under its heading; a closed place stays a plain line', async () => {
        const { dialog } = open();
        await stopRows(dialog);
        const places = await toPlaces(dialog);
        for (const heading of ['Fits today', 'On the area wind', 'Not today'])
            expect(within(places).getByRole('heading', { name: heading })).toBeTruthy();
        const fits = within(placesUnder(places, 'Fits today')).getAllByRole('button');
        const area = within(placesUnder(places, 'On the area wind')).getAllByRole('button');
        expect(fits.length).toBeGreaterThan(0);
        expect(area.length).toBeGreaterThan(5);
        for (const row of [...fits, ...area]) {
            expect(row).toHaveAttribute('aria-haspopup', 'dialog');
            // Compact (decision 3): no tag, and line 2 is its times (or a ✕ row's reason), the basis never on it.
            expect(row.querySelector('.today-tag')).toBeNull();
            expect(row.querySelector('.today-stop-l2')!.textContent).not.toMatch(/not checked|area wind/);
        }
        for (const row of area.filter((r) => /→/.test(r.querySelector('.today-stop-l2')!.textContent!)))
            expect(row.getAttribute('aria-label')!.match(/\(area wind\)/g)).toHaveLength(1);
        for (const row of fits) expect(row.getAttribute('aria-label')).not.toMatch(/area wind/);
        // Nara Inlet is closed this week: nothing to plan, its reason on a plain line.
        const nara = within(places).getByText(/^Nara Inlet( · .+)? · closed 6–15 Oct \(Queensland Parks\)$/);
        expect(nara.closest('button')).toBeNull();
        // Every ranked place opens: what stays a plain line is what has nothing to plan (closed, no anchoring,
        // not ranked, or out of the day's light at her speed).
        for (const line of places.querySelectorAll('li.today-place-line'))
            expect(line.textContent).toMatch(
                /closed |no anchoring here|not ranked|at your speed|too far|in the last of the light|no daylight/,
            );
    });

    it('a place beyond the five opens at once on the area wind, asks its weather along the way once, and Back returns to the list', async () => {
        // The five answer at once; a later ask waits until it is let go.
        const fake = fakeTodayDeps({ atlas: QLD_TILE.features });
        let release!: () => void;
        const held = new Promise<void>((done) => (release = done));
        let asks = 0;
        const sheetIo = io({
            loader: {
                loadRouteSpread: async (coords, ids) => {
                    if (++asks > 5) await held;
                    return fake.loadRouteSpread(coords, ids);
                },
            },
        });
        const { dialog } = open({ sheetIo });
        await stopRows(dialog);
        expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(5);
        let places = await toPlaces(dialog);
        const row = within(placesUnder(places, 'On the area wind')).getAllByRole('button')[0];
        const name = row.querySelector('.today-stop-name')!.textContent!;
        fireEvent.click(row);
        const detail = await screen.findByRole('dialog', { name: titled(name) });
        // At once: its times on the area wind, said so, while the weather along the way loads (2 requests).
        expect(within(detail).getByText('Checking the weather along the way…')).toBeTruthy();
        expect(within(detail).getByText(/^Leave \d\d:\d\d → there \d\d:\d\d \(/)).toBeTruthy();
        expect(within(detail).getByText('Sea: not checked on the area wind')).toBeTruthy();
        expect(within(detail).getByText(/ on the area wind \(.+\)\. No current\./)).toBeTruthy();
        await waitFor(() => expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(6));
        expect(sheetIo.loader.loadRouteSea).toHaveBeenCalledTimes(6);
        await act(async () => release());
        await waitFor(() => expect(within(detail).queryByText('Checking the weather along the way…')).toBeNull());
        expect(within(detail).queryByText(/on the area wind/)).toBeNull();
        expect(within(detail).getByText(/ in .+ wind\. No current\./)).toBeTruthy();
        // Back is the list she came from, focus on her place, now checked along the way.
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        places = await screen.findByRole('dialog', { name: /^Places near / });
        const back = placeRow(places, name)!;
        await waitFor(() => expect(document.activeElement).toBe(back));
        expect(placesUnder(places, 'On the area wind').contains(back)).toBe(false);
        // A second tap asks nothing more.
        fireEvent.click(back);
        await screen.findByRole('dialog', { name: titled(name) });
        expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(6);
        expect(sheetIo.loader.loadRouteSea).toHaveBeenCalledTimes(6);
    });

    it('on a day over her limits, a place in Not today opens on its reason, then its times', async () => {
        const { dialog } = open({ sheetIo: io({ scenario: 'over' }) });
        await waitFor(() =>
            expect(within(dialog).getByTestId('day-plan-headline')).toHaveTextContent(/^Stay put today/),
        );
        const places = await toPlaces(dialog);
        const rows = within(placesUnder(places, 'Not today')).getAllByRole('button');
        expect(rows.length).toBeGreaterThan(5);
        const row = rows.find((b) => /in the area$/.test(b.querySelector('.today-stop-l2')!.textContent!))!;
        const why = row.querySelector('.today-stop-l2')!.textContent!;
        expect(row.querySelector('.today-stop-glyph')).toHaveTextContent('✕');
        fireEvent.click(row);
        const detail = await screen.findByRole('dialog', {
            name: titled(row.querySelector('.today-stop-name')!.textContent!),
        });
        const level = detail.querySelector('.today-level')!;
        // Its reason first: the area wind's, or by now the weather along the way's (asked as it opened).
        expect(why).toMatch(/^SE \d+ kn in the area$/);
        expect(level).toHaveTextContent(/^✕ Over your limits: SE \d+ kn (in the area|on the way)$/);
        expect(level).toHaveAttribute('data-level', 'over');
        expect(within(detail).getByText(/^Leave \d\d:\d\d → there \d\d:\d\d \(/)).toBeTruthy();
        // Nara Inlet, closed whatever the weather, is still a plain line.
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        const list = await screen.findByRole('dialog', { name: /^Places near / });
        expect(
            within(list)
                .getByText(/^Nara Inlet( · .+)? · closed /)
                .closest('button'),
        ).toBeNull();
    });

    it('a thunder afternoon still has places to open, each with its reason first', async () => {
        const { dialog } = open({ sheetIo: io({ scenario: 'thunder' }) });
        await within(dialog).findByRole('list', { name: 'Stops' });
        fireEvent.change(within(dialog).getByRole('combobox', { name: 'Stay' }), { target: { value: '4h' } });
        const places = await toPlaces(dialog);
        const rows = [...places.querySelectorAll<HTMLElement>('button.today-stop')];
        expect(rows.length).toBeGreaterThan(3);
        const bolt = rows.find((b) => b.querySelector('.today-stop-l2')!.textContent === '⚡ Thunder on the way home');
        expect(bolt).toBeTruthy();
        fireEvent.click(bolt!);
        const detail = await screen.findByRole('dialog', {
            name: titled(bolt!.querySelector('.today-stop-name')!.textContent!),
        });
        expect(detail.querySelector('.today-level')).toHaveTextContent(
            /^✕ Over your limits: thunder in \d of 7 models on the way home$/,
        );
    });

    it('a place opened from the list stays open while the card changes behind it', async () => {
        // Everything waits; the card's first pick then meets 30 kn on the way, and a checked backup takes its slot.
        const fake = fakeTodayDeps({ atlas: QLD_TILE.features });
        let release!: () => void;
        const held = new Promise<void>((done) => (release = done));
        let asks = 0;
        const sheetIo = io({
            loader: {
                loadRouteSpread: async (coords, ids) => {
                    const first = ++asks === 1;
                    await held;
                    return first
                        ? routeSpread(coords, 30, Math.floor(NOW / H) * H, NOW)
                        : fake.loadRouteSpread(coords, ids);
                },
            },
        });
        const { dialog } = open({ sheetIo });
        const card = () =>
            [...dialog.querySelectorAll('.today-col-b .today-stops .today-stop-name')].map((n) => n.textContent);
        await waitFor(() => expect(card()).toHaveLength(3));
        const before = card();
        const places = await toPlaces(dialog);
        const row = within(placesUnder(places, 'On the area wind'))
            .getAllByRole('button')
            .find((b) => /→/.test(b.querySelector('.today-stop-l2')!.textContent!))!;
        const name = row.querySelector('.today-stop-name')!.textContent!;
        fireEvent.click(row);
        const detail = await screen.findByRole('dialog', { name: titled(name) });
        await act(async () => release());
        await waitFor(() => expect(card()).not.toEqual(before));
        expect(card()[0]).not.toBe(before[0]);
        expect(detail.isConnected).toBe(true);
        expect(screen.getByRole('dialog', { name: titled(name) })).toBe(detail);
        await waitFor(() => expect(within(detail).queryByText('Checking the weather along the way…')).toBeNull());
    });

    it('"On the area wind" heads only rows on the area wind: the five still checking sit under "Weather not checked"', async () => {
        let release!: () => void;
        const held = new Promise<void>((done) => (release = done));
        const fake = fakeTodayDeps({ atlas: QLD_TILE.features });
        const sheetIo = io({
            loader: {
                loadRouteSpread: async (coords, ids) => {
                    await held;
                    return fake.loadRouteSpread(coords, ids);
                },
            },
        });
        const { dialog } = open({ sheetIo });
        await waitFor(() => expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(5));
        const places = await toPlaces(dialog);
        const l2 = (heading: string) =>
            within(placesUnder(places, heading))
                .getAllByRole('button')
                .map((b) => b.querySelector('.today-stop-l2')!.textContent!);
        const checking = l2('Weather not checked');
        expect(checking.length).toBeGreaterThanOrEqual(3);
        for (const text of checking) expect(text).toMatch(/^About \d+ NM · checking the route$/);
        for (const text of l2('On the area wind')) expect(text).not.toMatch(/checking the route|weather not checked/);
        await act(async () => release());
        await waitFor(() => expect(within(places).queryByRole('heading', { name: 'Weather not checked' })).toBeNull());
    });

    it('a place beyond the five whose weather along the way fails keeps its area-wind times, and says so', async () => {
        // The five answer; every later ask fails (a proxy 5xx at anchor, on a flaky link).
        const fake = fakeTodayDeps({ atlas: QLD_TILE.features });
        let asks = 0;
        const sheetIo = io({
            loader: {
                loadRouteSpread: async (coords, ids) => {
                    if (++asks > 5) throw new Error('proxy 503');
                    return fake.loadRouteSpread(coords, ids);
                },
                loadRouteForecast: async () => {
                    throw new Error('proxy 503');
                },
            },
        });
        const { dialog } = open({ sheetIo });
        await stopRows(dialog);
        let places = await toPlaces(dialog);
        const row = within(placesUnder(places, 'On the area wind')).getAllByRole('button')[0];
        const name = row.querySelector('.today-stop-name')!.textContent!;
        const times = row.querySelector('.today-stop-l2')!.textContent!;
        expect(times).toMatch(TIMES_BACK);
        fireEvent.click(row);
        const detail = await screen.findByRole('dialog', { name: titled(name) });
        await waitFor(() => expect(sheetIo.loader.loadRouteForecast).toHaveBeenCalledOnce());
        // Its times stay, on the area wind, and the page says the weather along the way did not load.
        expect(
            await within(detail).findByText("Weather along the way didn't load: times on the area wind."),
        ).toBeTruthy();
        expect(within(detail).queryByText('Checking the weather along the way…')).toBeNull();
        expect(within(detail).getByText(/^Leave \d\d:\d\d → there \d\d:\d\d \(/)).toBeTruthy();
        expect(within(detail).queryByText(/No times without a forecast/)).toBeNull();
        // Back in the list it is where it was, with the same times: not "Not today" for a network failure.
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        places = await screen.findByRole('dialog', { name: /^Places near / });
        const back = placeRow(places, name)!;
        expect(placesUnder(places, 'On the area wind').contains(back)).toBe(true);
        expect(back.querySelector('.today-stop-l2')).toHaveTextContent(times);
    });

    it('on a day over her limits with a gap, no place in All places wears a ✓ or ≈; each gap opens on why', async () => {
        // A blow all day but 07:00-13:00 at Airlie (the engine's gap day), a 1 h stay.
        const gapFrom = Date.UTC(2026, 9, 7, 21);
        const gapTo = Date.UTC(2026, 9, 8, 3);
        const blow = pointBlock(Math.floor(NOW / H) * H, (m, t) =>
            t >= gapFrom && t < gapTo ? { kts: 9 + (m % 3), dir: 135 } : { kts: 27 + (m % 3), dir: 135, gust: 36 },
        );
        const sheetIo = io({ loader: { querySpread: async () => ({ atmos: blow, marine: null }) } });
        const { dialog } = open({ sheetIo });
        fireEvent.change(await within(dialog).findByRole('combobox', { name: 'Stay' }), { target: { value: '1h' } });
        await waitFor(() =>
            expect(within(dialog).getByTestId('day-plan-headline')).toHaveTextContent(/^Stay put today/),
        );
        const places = await toPlaces(dialog);
        // The five's weather along the way in (theirs are gaps too).
        await waitFor(() => expect(within(places).queryByText(/checking the route/)).toBeNull());
        const rows = [...places.querySelectorAll<HTMLElement>('button.today-stop')];
        expect(rows.length).toBeGreaterThan(5);
        for (const r of rows)
            expect(['inside', 'near'], r.getAttribute('aria-label')!).not.toContain(r.getAttribute('data-level'));
        const gaps = rows.filter((r) =>
            /^Over your limits most of the day \(a gap: leave \d\d:\d\d\)$/.test(
                r.querySelector('.today-stop-l2')!.textContent!,
            ),
        );
        // The five's and the places on the area wind alike.
        expect(gaps.length).toBeGreaterThan(5);
        for (const r of gaps) {
            expect(placesUnder(places, 'Not today').contains(r)).toBe(true);
            expect(r.querySelector('.today-stop-glyph')).toHaveTextContent('✕');
            expect(r).toHaveAttribute('data-level', 'over');
        }
        // A card stop that found the gap (checked along the way, so its row stays a gap as it opens).
        const card = [...dialog.querySelectorAll<HTMLElement>('.today-col-b button.today-stop')].find((b) =>
            ['inside', 'near'].includes(b.getAttribute('data-level')!),
        )!;
        const name = card.querySelector('.today-stop-name')!.textContent!;
        expect(gaps).toContain(placeRow(places, name));
        fireEvent.click(placeRow(places, name)!);
        const detail = await screen.findByRole('dialog', { name: titled(name) });
        // Decision 4: its page leads with why it is not today, then the gap's times.
        const level = detail.querySelector('.today-level')!;
        expect(level).toHaveTextContent(/^✕ Over your limits most of the day \(a gap: leave \d\d:\d\d\)$/);
        expect(level).toHaveAttribute('data-level', 'over');
        expect(within(detail).getByRole('list', { name: 'Times' })).toHaveTextContent(/^Leave \d\d:\d\d /);
        expect(within(detail).getByText(/^Leave \d\d:\d\d → there \d\d:\d\d \(/)).toBeTruthy();
        // Said once: the rows a tap away do not say it again.
        expect(listed(within(detail).getByRole('list', { name: 'How the day goes' }))).not.toContain(level.textContent);
    });

    it('a page whose place leaves the list as OpenStreetMap answers goes back to All places', async () => {
        // Five fictional atlas bays with no land table, then forty nearer OpenStreetMap points: past the 40,
        // the bays are "not ranked".
        const bays = [0, 1, 2, 3, 4].map(
            (i): AtlasFeature => ({
                type: 'Feature',
                properties: {
                    id: `atlas-fictional-${i}`,
                    name: `Fictional Bay ${i}`,
                    kind: 'anchorage',
                    likelyAnchorage: true,
                } as AtlasFeature['properties'],
                geometry: { type: 'Point', coordinates: [MARINA.lon + 0.1 + i * 0.02, MARINA.lat - 0.05] },
            }),
        );
        const osm = Array.from({ length: 40 }, (_, i) =>
            osmAnchorage(9600 + i, `Fictional Node ${i}`, {
                lat: MARINA.lat - 0.02 - (i % 8) * 0.004,
                lon: MARINA.lon + 0.03 + Math.floor(i / 8) * 0.004,
            }),
        );
        let release!: () => void;
        const held = new Promise<void>((done) => (release = done));
        const sheetIo = io({
            loader: {
                loadAtlas: async () => bays,
                loadReferenceTile: async () => {
                    await held;
                    return { points: osm, stale: false };
                },
            },
        });
        const { dialog } = open({ sheetIo });
        const places = await toPlaces(dialog);
        fireEvent.click(placeRow(places, 'Fictional Bay 4')!);
        const detail = await screen.findByRole('dialog', { name: /^Fictional Bay 4/ });
        await act(async () => release());
        await waitFor(() => expect(detail.isConnected).toBe(false));
        // Back on the list she came from, where it now says why it is not there.
        const list = await screen.findByRole('dialog', { name: /^Places near / });
        expect(within(list).getByText(/^Fictional Bay 4 · not ranked/)).toBeTruthy();
    });

    it('a new start forgets the places she opened at the old one: only its own five are asked', async () => {
        const was = useSettingsStore.getState().settings;
        useSettingsStore.setState({
            settings: {
                ...was,
                homePort: 'Fixture Harbour',
                savedLocations: ['Fixture Harbour'],
                savedLocationCoords: { 'Fixture Harbour': { lat: -20.3, lon: 148.75 } },
            },
        });
        try {
            const sheetIo = io();
            const { dialog } = open({ sheetIo });
            await stopRows(dialog);
            let places = await toPlaces(dialog);
            // Three places beyond the five, opened and closed: two requests each.
            const names = within(placesUnder(places, 'On the area wind'))
                .getAllByRole('button')
                .slice(0, 3)
                .map((b) => b.querySelector('.today-stop-name')!.textContent!);
            for (const name of names) {
                fireEvent.click(placeRow(places, name)!);
                const detail = await screen.findByRole('dialog', { name: titled(name) });
                fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
                places = await screen.findByRole('dialog', { name: /^Places near / });
            }
            await waitFor(() => expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(8));
            fireEvent.click(within(places).getByRole('button', { name: 'Close' }));
            fireEvent.click(within(dialog).getByRole('button', { name: /^Plan from: / }));
            const picker = await screen.findByRole('dialog', { name: 'Plan from' });
            fireEvent.click(within(picker).getByRole('button', { name: /Fixture Harbour/ }));
            await waitFor(() =>
                expect(within(dialog).getByRole('button', { name: /^Plan from: Fixture Harbour/ })).toBeTruthy(),
            );
            await stopRows(dialog);
            await waitFor(() => expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(13));
            await act(async () => {
                await new Promise((done) => setTimeout(done, 50));
            });
            // The new start's five, and nothing she opened at the old one.
            expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(13);
            expect(sheetIo.loader.loadRouteSea).toHaveBeenCalledTimes(13);
        } finally {
            useSettingsStore.setState({ settings: was });
        }
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
        // The Comfort settings themselves, in place, starting from the limits in
        // force (a typical cruiser's here), gusts included: never 35 kt / 4 m.
        const limits = resolveDayPlanLimits(undefined, DEFAULT_VESSEL, true);
        expect(within(sources).getByRole('button', { name: /Comfort/i })).toHaveTextContent(
            `≤${limits.wind.poor}kt · gusts ≤${limits.gust.poor}kt · ≤${limits.wave.poor}m`,
        );
        expect(within(sources).getByRole('slider', { name: 'Max acceptable wind speed' })).toHaveValue(
            String(limits.wind.poor),
        );
        expect(within(sources).getByRole('slider', { name: 'Max acceptable gust' })).toHaveValue(
            String(limits.gust.poor),
        );
        expect(within(sources).getByRole('slider', { name: 'Max acceptable wave height' })).toHaveValue(
            String(limits.wave.poor),
        );
        expect(within(sources).getByText('Sliders you haven’t moved show a typical cruiser’s limits.')).toBeTruthy();
        // The angle bands are the router's alone.
        expect(within(sources).queryByText(/Acceptable Wind Angles/i)).toBeNull();
        fireEvent.change(within(sources).getByRole('slider', { name: 'Max acceptable gust' }), {
            target: { value: '22' },
        });
        expect(useSettingsStore.getState().settings.comfortParams?.maxGustKts).toBe(22);
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
        // Line icons, not emoji (127-PYD-1).
        for (const name of [/^Boat/, 'This phone']) {
            const option = within(picker).getByRole('button', { name });
            expect(option.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
            expect(option.querySelector('svg')).not.toBeNull();
        }
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
        fireEvent.click(await within(dialog).findByRole('button', { name: /^Plan from: .+, boat 2 h ago$/ }));
        const picker = await screen.findByRole('dialog', { name: 'Plan from' });
        const options = within(picker)
            .getAllByRole('button')
            .map((b) => b.textContent)
            .filter((t) => /Fixture|Unmapped/.test(t ?? ''));
        expect(options).toEqual(['Home port · Fixture Harbour', 'Fixture Reach']);
    });
});

// ── Different places, picked for a reason (build 127, 127-PYD-4) ──

describe('Different places, picked for a reason', () => {
    const notCovered = async (points: readonly { lat: number; lon: number }[]) =>
        points.map(() => ({ covered: false, hazard: false, minDepthM: null }));

    it('checks the weather along the way for five, shows three, and tags every row but the best fit', async () => {
        const pinDepths = vi.fn(notCovered);
        const sheetIo = io({ voyageEnds: async () => null, pinDepths });
        const { dialog } = open({ vessel: OWN_BOAT, usingDefaultVessel: false, sheetIo });
        const rows = await stopRows(dialog);
        await waitFor(() => expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(5));
        expect(sheetIo.loader.loadRouteSea).toHaveBeenCalledTimes(5);
        expect(rows[0].querySelector('.today-pick')).toBeNull();
        for (const row of rows.slice(1))
            expect(row.querySelector('.today-pick')?.textContent).toMatch(
                /^(Other way|Closer|Short hop|More shelter)$/,
            );
        // No history on the phone: never "New to you".
        expect(dialog.textContent).not.toMatch(/New to you/);
        // Her charts are asked about the five pins once, in memory.
        await waitFor(() => expect(pinDepths).toHaveBeenCalledTimes(1));
        expect(pinDepths.mock.calls[0][0]).toHaveLength(5);
    });

    it('with her voyage ends on the phone, a place none of them ended at can be "New to you"; the default boat is not depth-checked', async () => {
        // First without her history: the stop the other way.
        const first = open({ sheetIo: io({ voyageEnds: async () => null, pinDepths: notCovered }) });
        const other = (await stopRows(first.dialog))[1].querySelector('.today-stop-name')!.textContent!;
        cleanup();
        // Then with a voyage of hers ended there: the third is somewhere none did, and says so.
        const at = QLD_TILE.features.find((f) => f.properties.name === other)!.geometry.coordinates;
        const voyageEnds = vi.fn(async () => [{ lat: at[1], lon: at[0] }]);
        const pinDepths = vi.fn(notCovered);
        const { dialog } = open({ sheetIo: io({ voyageEnds, pinDepths }) });
        await waitFor(async () => {
            const rows = await stopRows(dialog);
            expect(rows.map((r) => r.querySelector('.today-pick')?.textContent)).toContain('New to you');
        });
        expect(voyageEnds).toHaveBeenCalledOnce();
        expect(pinDepths).not.toHaveBeenCalled();
    });

    it('her own boat with no draft set is not depth-checked against the 2.5 m stand-in', async () => {
        const pinDepths = vi.fn(notCovered);
        const sheetIo = io({ voyageEnds: async () => null, pinDepths });
        open({ vessel: { ...OWN_BOAT, draft: 0 }, usingDefaultVessel: false, sheetIo });
        await waitFor(() => expect(sheetIo.loader.loadRouteSpread).toHaveBeenCalledTimes(5));
        expect(pinDepths).not.toHaveBeenCalled();
    });

    it('a stop opened from the card stays open when the backups land: its page is found by id', async () => {
        const sheetIo = io({ voyageEnds: async () => null, pinDepths: notCovered });
        const { dialog } = open({ vessel: OWN_BOAT, usingDefaultVessel: false, sheetIo });
        const rows = await stopRows(dialog);
        const name = rows[2].querySelector('.today-stop-name')!.textContent!;
        fireEvent.click(rows[2]);
        const detail = await screen.findByRole('dialog', { name: new RegExp(`^${name}`) });
        const why = within(detail).getByRole('list', { name: 'How the day goes' }).querySelector('[data-why]');
        expect(why?.textContent).toMatch(/\S/);
        expect(screen.getByRole('dialog', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    });
});

// ── 127-PYD-2: Plan Your Day routes the stop she opens ─────────
//
// Shane, 2026-10-10: "when you select somewhere, and plot on the chart. it goes
// direct. straight over hills. rocks, other boats, land, sea, air, you name it
// … so can we incorporate the autorouting into the plan your day thingy." His
// account only in 127, a "Route round the land" tap, and the routing time shown
// to him. The provider here is a fake behind the real routeStop: its words,
// its timing and its queue are the real ones. Fictional owner account.

describe('Route round the land (127-PYD-2)', () => {
    const CONFIRMED: VesselProfile = { ...OWN_BOAT, draftConfirmedFt: 7.87, airDraft: 59 };

    /** A routed line from the request's own pins, bent round a fictional headland. */
    const routedProposal = ({ departure: a, destination: b }: AutoroutingTrialRequest): AutoroutingTrialRoute => ({
        id: 'thalassa-fixture',
        coordinates: [
            [a.lon, a.lat],
            [(a.lon + b.lon) / 2, Math.min(a.lat, b.lat) - 0.06],
            [b.lon, b.lat],
        ],
        warnings: [],
        createdAt: new Date(NOW).toISOString(),
        provider: 'Thalassa',
        engine: {
            stateMask: ['green', 'green'],
            shallowRuns: [{ startSeg: 1, endSeg: 1, lengthM: 556, minDepthM: 1.9, midLat: 0, midLon: 0 }],
            cellsUsed: ['OC-99-SYN001'],
            distanceNM: 16.5,
            elapsedMs: 4100,
            backstop: 'verified',
        },
    });

    type Calculate = NonNullable<StopRouteDeps['calculate']>;
    /** The sheet's routeStop: the real one, over a fake provider and a clock that reads 6.4 s per route. */
    function routing(calculate: Calculate) {
        let reads = 0;
        const calls: { req: StopRouteRequest; signal: AbortSignal }[] = [];
        const fn = vi.fn((req: StopRouteRequest, opts: { signal: AbortSignal; onProgress?: (w: string) => void }) => {
            calls.push({ req, signal: opts.signal });
            return routeStop(req, opts, {
                calculate,
                clock: () => (reads++ % 2) * 6400,
                piPaired: async () => false,
            });
        });
        return { fn, calls };
    }
    const routes = (calculate: Calculate = async (r) => routedProposal(r)) => routing(calculate);

    function setStore(vessel: VesselProfile | undefined, autorouteTrialEnabled = true) {
        act(() => {
            useSettingsStore.setState({
                settings: { ...useSettingsStore.getState().settings, vessel, autorouteTrialEnabled },
            });
        });
    }

    async function openStop(
        options: {
            owner?: boolean;
            route?: ReturnType<typeof routes>;
            vessel?: VesselProfile;
            usingDefaultVessel?: boolean;
            routeOnOpen?: boolean;
            extra?: React.ReactNode;
            loader?: Partial<TodayLoaderDeps>;
            /** False when the route weather fails: the rows have no times to wait for (a string: what they say). */
            timed?: boolean | string;
        } = {},
    ) {
        const route = options.route ?? routes();
        const sheetIo = io({
            ...(options.loader ? { loader: options.loader } : {}),
            voyageEnds: async () => null,
            pinDepths: async (points) => points.map(() => ({ covered: false, hazard: false, minDepthM: null })),
            ownerAccount: async () => options.owner ?? true,
            routeStop: route.fn,
            ...(options.routeOnOpen !== undefined ? { routeOnOpen: options.routeOnOpen } : {}),
        });
        const handlers = { onClose: vi.fn(), onPlot: vi.fn(), onOpenVessel: vi.fn() };
        render(
            <>
                <TodaySheet
                    vessel={options.vessel ?? CONFIRMED}
                    usingDefaultVessel={options.usingDefaultVessel ?? false}
                    {...handlers}
                    io={sheetIo}
                />
                {options.extra}
            </>,
        );
        const dialog = screen.getByRole('dialog', { name: 'Plan Your Day' });
        const [first] =
            options.timed === false || typeof options.timed === 'string'
                ? await waitFor(() => {
                      const rows = within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button');
                      expect(rows[0].querySelector('.today-stop-l2')).toHaveTextContent(
                          typeof options.timed === 'string' ? options.timed : "Weather didn't load",
                      );
                      return rows;
                  })
                : await stopRows(dialog);
        const name = first.querySelector('.today-stop-name')!.textContent!;
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', { name: new RegExp(`^${name}`) });
        return { ...handlers, dialog, detail, name, route, io: sheetIo };
    }
    const routeRow = (detail: HTMLElement) => detail.querySelector<HTMLElement>('li[data-route]');

    beforeEach(() => setStore(CONFIRMED));
    afterEach(() => setStore(undefined, false));

    it('owner: one button, a tap routes once, the row says each stage, then the route, the time and the routed times', async () => {
        const route = routes(async (req, signal, onProgress) => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            onProgress?.('Following deep water…');
            await new Promise((resolve) => setTimeout(resolve, 30));
            onProgress?.('Routing round the land…');
            await new Promise((resolve) => setTimeout(resolve, 30));
            return routedProposal(req);
        });
        const { detail, dialog, io: sources, name } = await openStop({ route });
        // Before the tap: the estimate, and what routing will take.
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent('Not routed yet: takes a few seconds.'));
        expect(within(detail).getByText(/^About \d+ NM each way/)).toBeTruthy();
        expect(within(detail).queryByRole('button', { name: /^Plot / })).toBeNull();
        const button = within(detail).getByRole('button', { name: 'Route round the land' });
        expect(button).toHaveClass('today-primary');
        expect(route.fn).not.toHaveBeenCalled();

        fireEvent.click(button);
        expect(route.fn).toHaveBeenCalledOnce();
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/^Finding the way round the land…/));
        // The seconds are the row's own, unspoken: VoiceOver hears the stage only.
        expect(routeRow(detail)!.querySelector('[aria-live]')?.textContent).toBe('Finding the way round the land');
        expect(routeRow(detail)!.querySelector('[aria-hidden="true"]')).toBeTruthy();
        // While it routes the main button says so, and waits (127-PYD-3).
        expect(within(detail).getByRole('button', { name: 'Finding the way…' })).toBeDisabled();
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/^Routing round the land/));

        await waitFor(() =>
            expect(routeRow(detail)).toHaveTextContent('Routed on your charts · 16.5 NM each way · 0.3 NM shallow'),
        );
        // His account: the time it took (decision 2's reading), for the sheet's life.
        expect(within(detail).getByText('Routed in 6.4 s · router 4.1 s')).toBeTruthy();
        // The distance is said once: the route row is the distance row.
        expect(within(detail).queryByText(/NM each way \(/)).toBeNull();
        expect(
            within(detail).getByText(/^Route from your charts: draft 2\.40 m \+ 0\.5 m under the keel/),
        ).toBeTruthy();
        // The chosen leave reached the provider (the best departure, as no chip was tapped).
        expect(route.calls[0].req).toMatchObject({ draftM: expect.closeTo(2.4, 2), stopName: name.split(' · ')[0] });
        expect(route.calls[0].req.departureMs).toBeGreaterThan(NOW);
        // The wind along the routed line is asked for once (2 proxy calls): five stops + the route.
        await waitFor(() => expect(sources.loader.loadRouteSpread).toHaveBeenCalledTimes(6));
        expect(sources.loader.loadRouteSea).toHaveBeenCalledTimes(6);
        const asked = vi.mocked(sources.loader.loadRouteSpread).mock.calls[5][0];
        expect(asked).toHaveLength(3);

        // Back on the card: the routed times, with the route mark, while the sheet is open.
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        await waitFor(() => {
            const row = within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button')[0];
            expect(row.querySelector('.today-route-mark')).toBeTruthy();
        });
        // Re-opened, the route is there at once: no second run.
        fireEvent.click(within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button')[0]);
        const again = await screen.findByRole('dialog', { name: new RegExp(`^${name}`) });
        expect(routeRow(again)).toHaveTextContent('Routed on your charts · 16.5 NM each way');
        expect(route.fn).toHaveBeenCalledOnce();
    });

    it('a tester sees no route row, no button and no timing line; nothing is routed', async () => {
        const route = routes();
        const { detail } = await openStop({ owner: false, route });
        expect(routeRow(detail)).toBeNull();
        expect(within(detail).queryByRole('button', { name: 'Route round the land' })).toBeNull();
        expect(within(detail).getByRole('button', { name: 'Plot by hand' })).toBeTruthy();
        expect(detail.textContent).not.toMatch(/rout(e|ed|ing) round the land|Routed in|Show route/i);
        expect(route.fn).not.toHaveBeenCalled();
    });

    it('Auto route (trial) off: the row says so and turns the same switch on in place; the page stays open', async () => {
        setStore(CONFIRMED, false);
        const { detail } = await openStop();
        const link = await within(detail).findByRole('button', {
            name: 'Turn on Auto route (trial) to route round the land. (also in Settings → Preferences)',
        });
        fireEvent.click(link);
        await waitFor(() => expect(useSettingsStore.getState().settings.autorouteTrialEnabled).toBe(true));
        expect(detail.isConnected).toBe(true);
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent('Not routed yet: takes a few seconds.'));
    });

    it('the default boat: set her draft first, and the link opens Vessel', async () => {
        const { detail, onOpenVessel } = await openStop({ vessel: DEFAULT_VESSEL, usingDefaultVessel: true });
        fireEvent.click(
            await within(detail).findByRole('button', { name: "Set your boat's draft to route round the land." }),
        );
        expect(onOpenVessel).toHaveBeenCalledOnce();
    });

    it('a draft not confirmed: the tap asks once, above the stop page; cancelled, the row says so, and the next tap asks again', async () => {
        setStore({ ...CONFIRMED, draftConfirmedFt: undefined });
        const route = routes();
        const { detail } = await openStop({ route, extra: <DraftConfirmModal /> });
        const button = await within(detail).findByRole('button', { name: 'Route round the land' });
        fireEvent.click(button);
        const ask = await screen.findByRole('dialog', { name: 'Check your draft' });
        // The stop page steps below the draft modal while it asks.
        expect(detail.closest('[data-overlay-layer]')).toHaveAttribute('data-overlay-layer', 'modal');
        expect(ask.closest('[data-overlay-layer]') ?? ask).toHaveAttribute('data-overlay-layer', 'nested');
        fireEvent.click(within(ask).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent('Confirm your draft to route round the land.'));
        expect(route.fn).not.toHaveBeenCalled();
        expect(detail.closest('[data-overlay-layer]')).toHaveAttribute('data-overlay-layer', 'nested');

        fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
        const again = await screen.findByRole('dialog', { name: 'Check your draft' });
        fireEvent.click(within(again).getByRole('button', { name: /^Confirm / }));
        await waitFor(() => expect(route.fn).toHaveBeenCalledOnce());
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/^Routed on your charts/));
    });

    it('a draft confirmed after her page has closed starts nothing', async () => {
        setStore({ ...CONFIRMED, draftConfirmedFt: undefined });
        const route = routes();
        const { detail } = await openStop({ route, extra: <DraftConfirmModal /> });
        fireEvent.click(await within(detail).findByRole('button', { name: 'Route round the land' }));
        const ask = await screen.findByRole('dialog', { name: 'Check your draft' });
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        await waitFor(() => expect(detail.isConnected).toBe(false));
        fireEvent.click(within(ask).getByRole('button', { name: /^Confirm / }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull());
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(route.fn).not.toHaveBeenCalled();
    });

    it('signed out: sign in first', async () => {
        act(() => setAuthIdentityScope(null));
        const { detail } = await openStop();
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent('Sign in to route round the land.'));
        expect(within(detail).queryByRole('button', { name: /Sign in/ })).toBeNull();
    });

    it('no chart at an end: the global sentence, the estimate stays, and Plot by hand frames it with that reason', async () => {
        const route = routes(async () => {
            throw new Error('No installed chart covers the destination.');
        });
        const { detail, name, onPlot } = await openStop({ route });
        fireEvent.click(await within(detail).findByRole('button', { name: 'Route round the land' }));
        const place = name.split(' · ')[0];
        await waitFor(() =>
            expect(routeRow(detail)).toHaveTextContent(
                `No chart for ${place} on this phone: add charts for this area to route round the land.`,
            ),
        );
        expect(detail.textContent).not.toMatch(/\bPi\b/);
        expect(within(detail).getByText(/^About \d+ NM each way/)).toBeTruthy();
        expect(within(detail).getByText(/^No route after 6\.4 s$/)).toBeTruthy();
        fireEvent.click(within(detail).getByRole('button', { name: 'Plot by hand' }));
        const action = onPlot.mock.calls[0][0];
        expect(action.points).toEqual([]);
        expect(action.frame.why).toBe(
            `No chart for ${place} on this phone: add charts for this area to route round the land.`,
        );
    });

    it("an engine refusal is Auto's sentence, whole", async () => {
        const refusal = 'Route not possible: a bridge with 12.0 m clearance blocks your 18.0 m air draft.';
        const route = routes(async () => {
            throw new Error(refusal);
        });
        const { detail } = await openStop({ route });
        fireEvent.click(await within(detail).findByRole('button', { name: 'Route round the land' }));
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(refusal));
    });

    it('closing the page while it routes ends that route; re-opened, the button is back and a tap starts afresh', async () => {
        const route = routes(
            (_req, signal) =>
                new Promise((_resolve, reject) =>
                    signal!.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))),
                ),
        );
        const { detail, dialog, name } = await openStop({ route });
        fireEvent.click(await within(detail).findByRole('button', { name: 'Route round the land' }));
        await waitFor(() => expect(route.calls).toHaveLength(1));
        fireEvent.click(within(detail).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(detail.isConnected).toBe(false));
        expect(route.calls[0].signal.aborted).toBe(true);

        fireEvent.click(within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button')[0]);
        const again = await screen.findByRole('dialog', { name: new RegExp(`^${name}`) });
        expect(routeRow(again)).toHaveTextContent('Not routed yet: takes a few seconds.');
        fireEvent.click(within(again).getByRole('button', { name: 'Route round the land' }));
        await waitFor(() => expect(route.calls).toHaveLength(2));
        expect(route.calls[1].signal.aborted).toBe(false);
    });

    it('her saved route that joins the two still wins: no routing call, no route row', async () => {
        const route = routes();
        const sheetIo = io({
            voyageEnds: async () => null,
            pinDepths: async (points) => points.map(() => ({ covered: false, hazard: false, minDepthM: null })),
            ownerAccount: async () => true,
            routeStop: route.fn,
        });
        // A saved route of hers from the marina to every place in the tile (fictional names).
        vi.mocked(sheetIo.loader.savedRoutes).mockReturnValue(
            QLD_TILE.features.map((f, i) => ({
                name: `Fixture way ${i}`,
                points: [
                    { lat: MARINA.lat, lon: MARINA.lon },
                    { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] },
                ],
            })),
        );
        render(
            <TodaySheet
                vessel={CONFIRMED}
                usingDefaultVessel={false}
                onClose={vi.fn()}
                onPlot={vi.fn()}
                io={sheetIo}
            />,
        );
        const dialog = screen.getByRole('dialog', { name: 'Plan Your Day' });
        const [first] = await stopRows(dialog);
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', {
            name: new RegExp(`^${first.querySelector('.today-stop-name')!.textContent!}`),
        });
        expect(within(detail).getByText(/NM each way \(your saved route 'Fixture way \d+'\)$/)).toBeTruthy();
        expect(routeRow(detail)).toBeNull();
        expect(within(detail).getByRole('button', { name: 'Plot your saved route' })).toBeTruthy();
        expect(route.fn).not.toHaveBeenCalled();
    });

    // ── Review fixes, 2026-10-11 ──

    it('a leave gone by while the sheet stayed open is asked from now, never refused for a time she did not choose', async () => {
        // Opened at 06:30 and left open: tapped hours later, the morning's best leave is long past.
        let clock = NOW;
        const asked: number[] = [];
        const route = routes(async (req) => {
            asked.push(req.departureMs!);
            // As Auto's provider checks it: the hour just gone to 8 days out.
            if (req.departureMs! < clock - H || req.departureMs! > clock + 192 * H)
                throw new Error('Choose a departure within the next 8 days.');
            return routedProposal(req);
        });
        const { detail } = await openStop({ route, loader: { now: () => clock } });
        clock = NOW + 10 * H;
        fireEvent.click(await within(detail).findByRole('button', { name: 'Route round the land' }));
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/^Routed on your charts/));
        expect(asked).toEqual([clock]);
    });

    it('no route can be tried again: re-opened, the tap is back, and the second try routes', async () => {
        let tries = 0;
        const route = routes(async (req) => {
            if (++tries === 1)
                throw new Error(
                    "Couldn't fetch the missing charts (Failed to fetch). Check your connection and sign-in, then try again. Nothing changed.",
                );
            return routedProposal(req);
        });
        const { detail, dialog, name } = await openStop({ route });
        fireEvent.click(await within(detail).findByRole('button', { name: 'Route round the land' }));
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/^Couldn't fetch the missing charts/));
        // The estimate stays, in the route row: the distance is said once.
        expect(routeRow(detail)).toHaveTextContent(/About \d+ NM each way \(/);
        expect(within(detail).getAllByText(/NM each way \(/)).toHaveLength(1);
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        await waitFor(() => expect(detail.isConnected).toBe(false));
        fireEvent.click(within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button')[0]);
        const again = await screen.findByRole('dialog', { name: new RegExp(`^${name}`) });
        expect(routeRow(again)).toHaveTextContent('Not routed yet: takes a few seconds.');
        fireEvent.click(within(again).getByRole('button', { name: 'Route round the land' }));
        await waitFor(() => expect(routeRow(again)).toHaveTextContent(/^Routed on your charts/));
        expect(route.fn).toHaveBeenCalledTimes(2);
    });

    it('while a setting stands in the way she can still plot by hand: two marks, and what routing needs', async () => {
        setStore(CONFIRMED, false);
        const { detail, onPlot } = await openStop();
        await within(detail).findByRole('button', { name: /^Turn on Auto route \(trial\)/ });
        expect(within(detail).queryByRole('button', { name: 'Route round the land' })).toBeNull();
        fireEvent.click(within(detail).getByRole('button', { name: 'Plot by hand' }));
        await waitFor(() => expect(onPlot).toHaveBeenCalledOnce());
        expect(onPlot.mock.calls[0][0]).toMatchObject({
            points: [],
            frame: { why: 'Turn on Auto route (trial) to route round the land.' },
        });
    });

    // ── 127-PYD-3: the routed line on the chart ──

    it("routed: Show route on chart opens Auto's chart over the sheet at the leave she chose; Back returns to her stop", async () => {
        const { detail, dialog, name, route } = await openStop();
        fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
        const show = await within(detail).findByRole('button', { name: 'Show route on chart' });
        expect(show).toHaveClass('today-primary');
        fireEvent.click(show);
        const routeChart = await screen.findByRole('dialog', { name: `Route chart: ${name.split(' · ')[0]}` });
        expect(routeChart).toBeTruthy();
        // The stored route, cloned at her leave: the sheet's own copy is never handed over.
        const stored = chart.props!.dayPlan!.proposal;
        expect(stored.coordinates).toHaveLength(3);
        expect(stored.departureMs).toBeGreaterThan(NOW);
        expect(chart.props!.initialDraftM).toBeCloseTo(2.4, 2);
        expect(chart.props!.initialVesselProfile).toEqual(stored.vesselProfile);
        // Plan Your Day's own screens are hidden (state kept), and none of them traps focus behind the chart.
        const overlays = [dialog, detail].map((d) => d.closest('.today-overlay')!);
        for (const overlay of overlays) expect(overlay).toHaveAttribute('hidden');
        expect(screen.queryByRole('dialog', { name: 'Plan Your Day' })).toBeNull();

        fireEvent.click(within(routeChart).getByRole('button', { name: 'Back to Plan Your Day' }));
        await waitFor(() => expect(routeChart.isConnected).toBe(false));
        for (const overlay of overlays) expect(overlay).not.toHaveAttribute('hidden');
        // The same stop page, its route still in, focus back on its button.
        const back = screen.getByRole('dialog', { name: new RegExp(`^${name}`) });
        expect(back).toBe(detail);
        expect(routeRow(back)).toHaveTextContent(/^Routed on your charts/);
        await waitFor(() =>
            expect(document.activeElement).toBe(within(back).getByRole('button', { name: 'Show route on chart' })),
        );
        // Shown and closed, it never routed again.
        expect(route.fn).toHaveBeenCalledOnce();
    });

    it('the chart takes the leave she chose on the stop page, and changing it never routes again', async () => {
        const { detail, dialog, route } = await openStop();
        // A 1 h stay gives this stop two leaves (07:00 best, 08:00); the route is kept whatever the stay.
        fireEvent.change(within(dialog).getByRole('combobox', { name: 'Stay', hidden: true }), {
            target: { value: '1h' },
        });
        fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
        await within(detail).findByRole('button', { name: 'Show route on chart' });
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/^Routed on your charts/));
        const chips = () => within(within(detail).getByRole('group', { name: 'Leave at' })).getAllByRole('button');
        await waitFor(() => expect(chips().length).toBeGreaterThan(1));
        const open = async (chip: () => HTMLElement) => {
            fireEvent.click(chip());
            await waitFor(() => expect(chip()).toHaveAttribute('aria-pressed', 'true'));
            fireEvent.click(within(detail).getByRole('button', { name: 'Show route on chart' }));
            await screen.findByRole('dialog', { name: /^Route chart: / });
            const leave = chart.props!.dayPlan!.proposal.departureMs!;
            fireEvent.click(screen.getByRole('button', { name: 'Back to Plan Your Day' }));
            await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Route chart: / })).toBeNull());
            return leave;
        };
        const late = await open(() => chips().at(-1)!);
        const early = await open(() => chips()[0]);
        expect(late - early).toBe(H);
        expect(early).toBeGreaterThanOrEqual(NOW);
        // The leave it was routed for is the best one; another leave only moves the tide hour.
        expect(early).toBe(route.calls[0].req.departureMs);
        expect(route.fn).toHaveBeenCalledOnce();
    });

    it('Use on the main chart plots the routed line out and back, sets her leave, and never a straight line', async () => {
        const { detail, onPlot, name } = await openStop();
        fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
        fireEvent.click(await within(detail).findByRole('button', { name: 'Show route on chart' }));
        await screen.findByRole('dialog', { name: /^Route chart: / });
        const proposal = chart.props!.dayPlan!.proposal;
        fireEvent.click(screen.getByRole('button', { name: 'Use on the main chart' }));
        expect(onPlot).toHaveBeenCalledOnce();
        const action = onPlot.mock.calls[0][0];
        const line = proposal.coordinates.map(([lon, lat]) => ({ lat, lon }));
        expect(action).toMatchObject({ kind: 'plot-day', routed: true, name: `Day out: ${name}` });
        expect(action.points).toEqual([...line, ...[...line].reverse().slice(1)]);
        expect(action.points.length).toBeGreaterThan(2);
        expect(action.frame).toBeUndefined();
        // Its satellite land check ran: nothing to caution.
        expect(action.unchecked).toBeUndefined();
        expect(Number(sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, getAuthIdentityScope())))).toBe(
            proposal.departureMs,
        );
    });

    // ── Review fixes (stage 3): what the chart's satellite Retry finds comes back to her stop ──
    const SLOW = "the satellite relief service didn't answer within 12 s";
    /** The satellite land check could not be done when it was routed. */
    const unchecked = () =>
        routes(async (r) => {
            const p = routedProposal(r);
            return { ...p, engine: { ...p.engine!, backstop: 'unavailable', backstopReason: SLOW } };
        });
    const showChart = async (detail: HTMLElement) => {
        fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
        fireEvent.click(await within(detail).findByRole('button', { name: 'Show route on chart' }));
        return screen.findByRole('dialog', { name: /^Route chart: / });
    };
    const backFromChart = async (routeChart: HTMLElement) => {
        fireEvent.click(within(routeChart).getByRole('button', { name: 'Back to Plan Your Day' }));
        await waitFor(() => expect(routeChart.isConnected).toBe(false));
    };

    it("a satellite Retry that finds land: back on her stop it says so in Auto's words, plans on the estimate, and offers only Plot by hand", async () => {
        const { detail, onPlot } = await openStop({ route: unchecked() });
        const routeChart = await showChart(detail);
        fireEvent.click(within(routeChart).getByRole('button', { name: 'Retry finds land' }));
        await backFromChart(routeChart);
        // Exactly as if the router had found it: no route, Auto's sentence, the estimate under it.
        await waitFor(() => expect(routeRow(detail)).toHaveAttribute('data-route', 'no-route'));
        expect(routeRow(detail)).toHaveTextContent(chart.land);
        expect(within(detail).getByText(/^About \d+ NM each way/)).toBeTruthy();
        expect(within(detail).queryByRole('button', { name: 'Show route on chart' })).toBeNull();
        fireEvent.click(within(detail).getByRole('button', { name: 'Plot by hand' }));
        const action = onPlot.mock.calls[0][0];
        expect(action).toMatchObject({ kind: 'plot-day', points: [], frame: { why: chart.land } });
        expect(action.routed).toBeUndefined();
    });

    it("a route whose satellite check didn't run goes on to the main chart saying so; once a Retry clears it, the stop keeps the checked copy", async () => {
        const first = await openStop({ route: unchecked() });
        let routeChart = await showChart(first.detail);
        fireEvent.click(within(routeChart).getByRole('button', { name: 'Use on the main chart' }));
        // A caution, not a gate: the line goes on, and why it is unchecked goes with it.
        expect(first.onPlot.mock.calls[0][0]).toMatchObject({ kind: 'plot-day', routed: true, unchecked: SLOW });
        cleanup();

        const { detail, onPlot } = await openStop({ route: unchecked() });
        routeChart = await showChart(detail);
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/satellite land check not done/));
        fireEvent.click(within(routeChart).getByRole('button', { name: 'Retry clears it' }));
        await backFromChart(routeChart);
        await waitFor(() => expect(routeRow(detail)).not.toHaveTextContent(/satellite land check not done/));
        expect(routeRow(detail)).toHaveTextContent(/^Routed on your charts/);
        // Reopened, the chart is handed the checked copy; nothing routed again.
        fireEvent.click(within(detail).getByRole('button', { name: 'Show route on chart' }));
        await screen.findByRole('dialog', { name: /^Route chart: / });
        expect(chart.props!.dayPlan!.proposal.engine!.backstop).toBe('verified');
        fireEvent.click(screen.getByRole('button', { name: 'Use on the main chart' }));
        expect(onPlot.mock.calls[0][0].unchecked).toBeUndefined();
    });

    it('a stop with no leave (its weather failed) goes on to the main chart without touching the Plan page departure', async () => {
        const fail = async () => {
            throw new Error('proxy 503');
        };
        const KEY = authScopedStorageKey(PLAN_DEPARTURE_KEY, getAuthIdentityScope());
        // 17:00 today, set on the Plan page by another passage.
        sessionStorage.setItem(KEY, String(NOW + 10.5 * H));
        const { detail, onPlot } = await openStop({
            loader: { loadRouteSpread: fail, loadRouteForecast: fail },
            timed: false,
        });
        expect(within(detail).queryByRole('group', { name: 'Leave at' })).toBeNull();
        const routeChart = await showChart(detail);
        fireEvent.click(within(routeChart).getByRole('button', { name: 'Use on the main chart' }));
        expect(onPlot.mock.calls[0][0]).toMatchObject({ kind: 'plot-day', routed: true });
        expect(sessionStorage.getItem(KEY)).toBe(String(NOW + 10.5 * H));
    });

    it('while the chart loads, "Opening chart…" has its way back: focus on it, and Escape returns to her stop', async () => {
        const { detail } = await openStop();
        fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
        const show = await within(detail).findByRole('button', { name: 'Show route on chart' });
        chart.hold = new Promise<void>(() => {});
        try {
            fireEvent.click(show);
            const opening = await screen.findByRole('dialog', { name: 'Plan Your Day route' });
            expect(opening).toHaveTextContent('Opening chart…');
            const back = within(opening).getByRole('button', { name: 'Back to Plan Your Day' });
            await waitFor(() => expect(document.activeElement).toBe(back));
            fireEvent.keyDown(back, { key: 'Escape' });
            await waitFor(() => expect(opening.isConnected).toBe(false));
            expect(detail.closest('.today-overlay')).not.toHaveAttribute('hidden');
            await waitFor(() => expect(document.activeElement).toBe(show));
        } finally {
            chart.hold = null;
        }
    });

    it('Back to the list after a chart round trip: focus lands where it does without one, never lost', async () => {
        const { dialog, name } = await openStop();
        const title = new RegExp(`^${name}`);
        const row = () => within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button')[0];
        const toList = async () => {
            fireEvent.click(within(screen.getByRole('dialog', { name: title })).getByRole('button', { name: 'Back' }));
            await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
            await new Promise((r) => setTimeout(r, 0));
            return document.activeElement;
        };
        // Opened from the keyboard: focus is on her row when she opens it.
        const reopen = async () => {
            row().focus();
            fireEvent.click(row());
            return screen.findByRole('dialog', { name: title });
        };
        await toList();
        await reopen();
        const plain = await toList();
        expect(dialog.contains(plain)).toBe(true);
        await backFromChart(await showChart(await reopen()));
        // The hidden spell re-takes the stop page's restore target; the list's own trap still lands it the same.
        expect(await toList()).toBe(plain);
    });

    it('a draft confirmed after the whole sheet has closed starts nothing', async () => {
        setStore({ ...CONFIRMED, draftConfirmedFt: undefined });
        const route = routes();
        const sheetIo = io({
            voyageEnds: async () => null,
            pinDepths: async (points) => points.map(() => ({ covered: false, hazard: false, minDepthM: null })),
            ownerAccount: async () => true,
            routeStop: route.fn,
        });
        const page = (sheet: boolean) => (
            <>
                {sheet && (
                    <TodaySheet
                        vessel={CONFIRMED}
                        usingDefaultVessel={false}
                        onClose={vi.fn()}
                        onPlot={vi.fn()}
                        io={sheetIo}
                    />
                )}
                <DraftConfirmModal />
            </>
        );
        const { rerender } = render(page(true));
        const [first] = await stopRows(screen.getByRole('dialog', { name: 'Plan Your Day' }));
        fireEvent.click(first);
        const detail = await screen.findByRole('dialog', {
            name: new RegExp(`^${first.querySelector('.today-stop-name')!.textContent!}`),
        });
        fireEvent.click(await within(detail).findByRole('button', { name: 'Route round the land' }));
        await screen.findByRole('dialog', { name: 'Check your draft' });
        // A deep link takes her elsewhere: Plan Your Day goes, the app's draft modal stays.
        rerender(page(false));
        const ask = await screen.findByRole('dialog', { name: 'Check your draft' });
        fireEvent.click(within(ask).getByRole('button', { name: /^Confirm / }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull());
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(route.fn).not.toHaveBeenCalled();
    });

    it('the wind along the routed line failed: the times that loaded stay, and it is asked once more', async () => {
        // Patchy Starlink: the two calls along the routed line (its 3 points) fail once.
        const fake = fakeTodayDeps({ atlas: QLD_TILE.features });
        let fail = true;
        let along = 0;
        const routedOnly = <T,>(real: (coords: never, model: never) => Promise<T>) =>
            (async (coords: { length: number }, model: never) => {
                if (coords.length === 3) {
                    along++;
                    if (fail) throw new Error('429 Too Many Requests');
                }
                return real(coords as never, model);
            }) as never;
        const { detail, dialog, name } = await openStop({
            loader: {
                loadRouteSpread: routedOnly(fake.loadRouteSpread as never),
                loadRouteForecast: routedOnly(fake.loadRouteForecast as never),
            },
        });
        const leave = () => within(screen.getByRole('dialog', { name: new RegExp(`^${name}`) })).getByText(/^Leave /);
        const before = leave().textContent;
        fireEvent.click(await within(detail).findByRole('button', { name: 'Route round the land' }));
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/^Routed on your charts/));
        await waitFor(() => expect(leave()).toHaveTextContent(/\(estimate: route weather didn't load\)$/));
        // The verdict and times that loaded, never "weather not checked".
        expect(leave().textContent!.split(' (')[0]).toBe(before!.split(' (')[0]);
        expect(detail.textContent).not.toMatch(/Weather not checked/);
        const failedCalls = along;
        fail = false;
        fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
        await waitFor(() => expect(along).toBeGreaterThan(failedCalls));
        fireEvent.click(within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button')[0]);
        await screen.findByRole('dialog', { name: new RegExp(`^${name}`) });
        await waitFor(() => expect(leave().textContent).not.toMatch(/estimate|updating/));
    });

    it('with PYD_ROUTE_ON_OPEN (a test override) opening the stop starts its route, no tap', async () => {
        const route = routes();
        const { detail } = await openStop({ route, routeOnOpen: true });
        await waitFor(() => expect(route.fn).toHaveBeenCalledOnce());
        await waitFor(() => expect(routeRow(detail)).toHaveTextContent(/^Routed on your charts/));
    });

    // ── 127-PYD-5: every place opens, and browsing them never routes ──

    /** The sheet on her confirmed boat, All places open, three places beyond the five named. */
    async function browse(owner: boolean, route = routes()) {
        const sheetIo = io({
            voyageEnds: async () => null,
            pinDepths: async (points) => points.map(() => ({ covered: false, hazard: false, minDepthM: null })),
            ownerAccount: async () => owner,
            routeStop: route.fn,
        });
        render(
            <TodaySheet
                vessel={CONFIRMED}
                usingDefaultVessel={false}
                onClose={vi.fn()}
                onPlot={vi.fn()}
                io={sheetIo}
            />,
        );
        const dialog = screen.getByRole('dialog', { name: 'Plan Your Day' });
        await stopRows(dialog);
        const places = await toPlaces(dialog);
        const names = within(placesUnder(places, 'On the area wind'))
            .getAllByRole('button')
            .slice(0, 3)
            .map((b) => b.querySelector('.today-stop-name')!.textContent!);
        /** Opens a place from the list, by name. */
        const visit = async (name: string) => {
            const list = await screen.findByRole('dialog', { name: /^Places near / });
            fireEvent.click(placeRow(list, name)!);
            return screen.findByRole('dialog', { name: titled(name) });
        };
        const leave = async (detail: HTMLElement) => {
            fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
            await waitFor(() => expect(detail.isConnected).toBe(false));
        };
        return { names, visit, leave, route };
    }

    for (const owner of [true, false])
        it(`opening and closing three places in a row starts no route at all (${owner ? 'owner' : 'tester'})`, async () => {
            const { names, visit, leave, route } = await browse(owner);
            expect(names).toHaveLength(3);
            for (const name of names) {
                const detail = await visit(name);
                // His page offers the tap (decision 2: a tap, never on open); a tester's offers no routing.
                if (owner) expect(within(detail).getByRole('button', { name: 'Route round the land' })).toBeTruthy();
                else expect(within(detail).queryByRole('button', { name: 'Route round the land' })).toBeNull();
                expect(
                    within(detail).getByRole('button', { name: owner ? 'Route round the land' : 'Plot by hand' }),
                ).toHaveClass('today-primary');
                await leave(detail);
            }
            expect(route.fn).not.toHaveBeenCalled();
        });

    it("an owner who taps Route on place A, closes it and opens B finds A's route cancelled", async () => {
        const route = routes(
            (_req, signal) =>
                new Promise((_resolve, reject) =>
                    signal!.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))),
                ),
        );
        const { names, visit, leave } = await browse(true, route);
        const [a, b] = names;
        const pageA = await visit(a);
        fireEvent.click(within(pageA).getByRole('button', { name: 'Route round the land' }));
        await waitFor(() => expect(route.calls).toHaveLength(1));
        expect(route.calls[0].req.stopName).toBe(a);
        await leave(pageA);
        expect(route.calls[0].signal.aborted).toBe(true);
        const pageB = await visit(b);
        expect(routeRow(pageB)).toHaveTextContent('Not routed yet: takes a few seconds.');
        await leave(pageB);
        // A's page, opened again, has its tap back: the route she left was dropped, not kept running.
        const again = await visit(a);
        expect(routeRow(again)).toHaveTextContent('Not routed yet: takes a few seconds.');
        expect(route.fn).toHaveBeenCalledOnce();
    });

    // ── 127-PYD-11: the leave window, under the route row, in memory only ──
    describe('the leave window (127-PYD-11)', () => {
        /** The routed line, 20 vertices a leg as a real route has them, its shallow bits where `at` puts them
         *  (on the bend by default): real places, real tide buckets. */
        const tidal = (at: (bend: [number, number]) => [number, number][] = (bend) => [bend]) =>
            routes(async (r) => {
                const p = routedProposal(r);
                const coordinates = p.coordinates.flatMap(([lon, lat], i, all) =>
                    i === all.length - 1
                        ? [[lon, lat] as [number, number]]
                        : Array.from(
                              { length: 20 },
                              (_, k) =>
                                  [lon + ((all[i + 1][0] - lon) * k) / 20, lat + ((all[i + 1][1] - lat) * k) / 20] as [
                                      number,
                                      number,
                                  ],
                          ),
                );
                return {
                    ...p,
                    coordinates,
                    engine: {
                        ...p.engine!,
                        stateMask: coordinates.slice(1).map(() => 'green' as const),
                        // 1.9 m charted: her 2.40 m draft + 0.5 m needs 1.0 m of tide.
                        shallowRuns: at(p.coordinates[1]).map(([lon, lat]) => ({
                            startSeg: 18,
                            endSeg: 21,
                            lengthM: 556,
                            minDepthM: 1.9,
                            midLat: lat,
                            midLon: lon,
                            minAtLat: lat,
                            minAtLon: lon,
                        })),
                    },
                };
            });
        /** A semidiurnal curve, high water 12:30 on the fixture's day (AEST), above 1.0 m for 10 h of each tide. */
        const sine = async () => ({
            heights: [],
            provenance: 'STATION_HEIGHTS' as const,
            heightAt: (t: number) =>
                2.2 + 1.5 * Math.cos((2 * Math.PI * (t - Date.UTC(2026, 9, 8, 2, 30))) / (12.42 * H)),
            rangeMs: [NOW - 48 * H, NOW + 96 * H] as [number, number],
            stationName: 'Fixture Gauge',
        });
        const BIT = 'the shallow bit \\d+\\.\\d NM out';
        const CHOSE = '; your (\\d\\d:\\d\\d) (works|is too early for it|is too late for it)\\.';
        const LEAVE = new RegExp(
            `^Leave \\d\\d:\\d\\d(–\\d\\d:\\d\\d)? to carry the tide over ${BIT}, there and back${CHOSE}$`,
        );
        const OVERNIGHT = new RegExp(
            `^Leave \\d\\d:\\d\\d(–\\d\\d:\\d\\d)? to carry the tide over ${BIT}${CHOSE} Home tomorrow: check its tide in the morning\\.$`,
        );
        const leaveRow = (detail: HTMLElement) => detail.querySelector<HTMLElement>('li[data-leave]');
        const MARINA_ROW = 'Leaving a marina: check its approach depth against the tide before you go.';

        it('after a routed result the row says when to leave, a chip changes only its last clause, and nothing more is fetched', async () => {
            const {
                detail,
                dialog,
                io: sources,
            } = await openStop({
                route: tidal(),
                loader: { loadRouteTideCurve: sine },
            });
            // Overnight: a morning of leave chips to choose from.
            fireEvent.change(within(dialog).getByRole('combobox', { name: 'Stay' }), {
                target: { value: 'overnight' },
            });
            await waitFor(() =>
                expect(
                    within(within(detail).getByRole('group', { name: 'Leave at' })).getAllByRole('button').length,
                ).toBeGreaterThan(1),
            );
            // Before the route: the marina line, and no leave row.
            expect(within(detail).getByText(MARINA_ROW)).toBeTruthy();
            expect(leaveRow(detail)).toBeNull();
            fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
            await waitFor(() => expect(leaveRow(detail)).toHaveTextContent(OVERNIGHT));
            // It sits under the route row, and the marina line is gone: the routed line went through the approach.
            expect(routeRow(detail)!.nextElementSibling).toBe(leaveRow(detail));
            expect(within(detail).queryByText(MARINA_ROW)).toBeNull();
            expect(detail.querySelector('.today-footnote')).toHaveTextContent(
                /Tide from WorldTides \(Fixture Gauge\); check the official tide table\.$/,
            );
            const load = vi.mocked(sources.loader.loadRouteTideCurve);
            expect(load).toHaveBeenCalledOnce();
            const before = leaveRow(detail)!.textContent!;
            const chips = within(within(detail).getByRole('group', { name: 'Leave at' })).getAllByRole('button');
            const other = chips.find((c) => c.getAttribute('aria-pressed') !== 'true')!;
            fireEvent.click(other);
            await waitFor(() => expect(leaveRow(detail)!.textContent).not.toBe(before));
            const after = leaveRow(detail)!.textContent!;
            expect(after.split('; your ')[0]).toBe(before.split('; your ')[0]);
            expect(after.match(OVERNIGHT)![2]).toBe(other.textContent!.slice(0, 5));
            expect(load).toHaveBeenCalledOnce();
        });

        it('a day trip says "there and back"; Sources credits the tide it read', async () => {
            const { detail, dialog } = await openStop({ route: tidal(), loader: { loadRouteTideCurve: sine } });
            fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
            await waitFor(() => expect(leaveRow(detail)).toHaveTextContent(LEAVE));
            fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
            fireEvent.click(within(dialog).getByRole('button', { name: 'Sources and limits' }));
            const sourcesScreen = await screen.findByRole('dialog', { name: 'Sources and limits' });
            expect(
                within(sourcesScreen).getByText(
                    'Leave windows: WorldTides, Fixture Gauge, metres above LAT; check the official tide table',
                ),
            ).toBeTruthy();
        });

        it('one curve per tide place, at most four, each where the shallow bit is', async () => {
            const { detail, io: sources } = await openStop({
                // Five shallow bits, a third of a degree apart: five tide places.
                route: tidal(([lon, lat]) => [0, 1, 2, 3, 4].map((k) => [lon + k / 3, lat] as [number, number])),
                loader: { loadRouteTideCurve: sine },
            });
            fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
            await waitFor(() => expect(leaveRow(detail)).toHaveAttribute('data-leave', ''));
            const calls = vi.mocked(sources.loader.loadRouteTideCurve).mock.calls;
            expect(calls).toHaveLength(4);
            const buckets = calls.map(([lat, lon]) => `${Math.round(lat * 4)},${Math.round(lon * 4)}`);
            expect(new Set(buckets).size).toBe(4);
            // The fifth place's tide is not known: no time is said.
            expect(leaveRow(detail)).toHaveTextContent(/^Tide not known for the shallow bit /);
            expect(leaveRow(detail)!.textContent).not.toMatch(/\d\d:\d\d/);
        });

        it('no tide: "Tide not known", what it needs, never a time', async () => {
            const { detail } = await openStop({ route: tidal(), loader: { loadRouteTideCurve: async () => null } });
            fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
            await waitFor(() =>
                expect(leaveRow(detail)).toHaveTextContent(
                    /^Tide not known for the shallow bit .+ \(it needs 1\.0 m of tide\): check the tide table before you go\.$/,
                ),
            );
            expect(leaveRow(detail)!.textContent).not.toMatch(/\d\d:\d\d/);
            expect(detail.querySelector('.today-footnote')!.textContent).not.toMatch(/WorldTides/);
        });

        it('a tester never sees it, and nothing is fetched', async () => {
            const { detail, io: sources } = await openStop({
                owner: false,
                route: tidal(),
                loader: { loadRouteTideCurve: sine },
            });
            expect(leaveRow(detail)).toBeNull();
            expect(within(detail).getByText(MARINA_ROW)).toBeTruthy();
            expect(sources.loader.loadRouteTideCurve).not.toHaveBeenCalled();
        });

        // Review 2026-10-13: with no times to judge the window returned early, so the row checked for ever and
        // the marina line it replaced was gone with nothing in its place; with a failed route forecast it gave
        // times from walks in no wind under a footnote saying there are none.
        const NO_TIMES =
            /^No leave time without a forecast for the shallow bit \d+\.\d NM out \(it needs 1\.0 m of tide\): check the tide table before you go\.$/;
        const fail = async () => {
            throw new Error('proxy 503');
        };
        it('with the route forecast failed: what the tide must give, never a time', async () => {
            const { detail } = await openStop({
                route: tidal(),
                loader: { loadRouteTideCurve: sine, loadRouteSpread: fail, loadRouteForecast: fail },
                timed: false,
            });
            fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
            await waitFor(() => expect(leaveRow(detail)).toHaveTextContent(NO_TIMES));
            expect(leaveRow(detail)).toHaveAttribute('data-leave', '');
            expect(detail.querySelector('.today-footnote')).toHaveTextContent(/^No times without a forecast\./);
        });

        it('with no forecast at all it never checks for ever', async () => {
            const { detail } = await openStop({
                route: tidal(),
                loader: { loadRouteTideCurve: sine, querySpread: fail },
                timed: 'weather not checked',
            });
            expect(within(detail).getByText('Weather not checked: no forecast loaded.')).toBeTruthy();
            fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
            await waitFor(() => expect(leaveRow(detail)).toHaveTextContent(NO_TIMES));
        });

        it("a line recalculated on Auto's chart checks its own tide, never shows the old line's window", async () => {
            let hold = false;
            const { detail } = await openStop({
                route: tidal(),
                loader: { loadRouteTideCurve: (() => (hold ? new Promise(() => {}) : sine())) as typeof sine },
            });
            const routeChart = await showChart(detail);
            await waitFor(() => expect(leaveRow(detail)).toHaveTextContent(LEAVE));
            hold = true;
            fireEvent.click(within(routeChart).getByRole('button', { name: 'Recalculate finds another line' }));
            await backFromChart(routeChart);
            await waitFor(() => expect(leaveRow(detail)).toHaveAttribute('data-leave', 'checking'));
            expect(leaveRow(detail)).toHaveTextContent(/^Checking the tide on the way…$/);
        });

        it('closing the page drops it; re-opened, it is worked out again from the curves it kept', async () => {
            const {
                detail,
                dialog,
                name,
                io: sources,
            } = await openStop({
                route: tidal(),
                loader: { loadRouteTideCurve: sine },
            });
            fireEvent.click(within(detail).getByRole('button', { name: 'Route round the land' }));
            await waitFor(() => expect(leaveRow(detail)).toHaveTextContent(LEAVE));
            const said = leaveRow(detail)!.textContent!;
            fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
            await waitFor(() => expect(document.querySelector('li[data-leave]')).toBeNull());
            fireEvent.click(within(within(dialog).getByRole('list', { name: 'Stops' })).getAllByRole('button')[0]);
            const again = await screen.findByRole('dialog', { name: new RegExp(`^${name}`) });
            await waitFor(() => expect(leaveRow(again)?.textContent).toBe(said));
            expect(sources.loader.loadRouteTideCurve).toHaveBeenCalledOnce();
        });
    });
});
