/**
 * The Thalassa Ocean page's words, with FICTIONAL data. It must never show a
 * number it does not have, never promise an anonymity it cannot give, never
 * offer fish, and must credit every historical dataset it draws.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OceanPage, { layerExplanation, type OceanBoot } from '../../src/ocean/OceanPage';
import { parseContext, parseSummary, type ContextState, type FleetState } from '../../src/ocean/oceanApi';
import { fleetFilter, regionReport, rowBoxes, tallyContext } from '../../src/ocean/mapLayers';
import { inBox } from '../../src/ocean/regions';

vi.mock('../../src/ocean/OceanMap', () => ({ default: () => <div data-testid="map-stub" /> }));

const CONTEXT = parseContext({
    schema: 'thalassa-ocean-context',
    v: 1,
    region: { id: 'au-east', name: 'East coast of Australia' },
    built: '2026-10-06',
    minRecords: 50,
    species: [
        {
            sci: 'Megaptera novaeangliae',
            name: 'Humpback whale',
            group: 'whale',
            aphiaId: 137092,
            sensitive: false,
            cellDeg: 0.25,
            records: 120,
            recordDays: 60,
            years: [1990, 2020],
            months: [0, 0, 0, 0, 5, 20, 20, 10, 5, 0, 0, 0],
            cells: [[-27.125, 153.625, 60, [0, 0, 0, 0, 5, 20, 20, 10, 5, 0, 0, 0]]],
        },
        {
            sci: 'Dugong dugon',
            name: 'Dugong',
            group: 'dugong',
            aphiaId: 220227,
            sensitive: true,
            cellDeg: 0.5,
            records: 60,
            recordDays: 20,
            years: [1980, 2010],
            months: Array(12).fill(1),
            cells: [[-27.25, 153.25, 20]],
        },
    ],
    dropped: [
        {
            sci: 'Caretta caretta',
            name: 'Loggerhead turtle',
            records: 5,
            reason: 'only 5 licence-clean at-sea records (needs 50)',
        },
    ],
    datasets: [
        {
            id: 'a',
            title: 'Fixture survey one',
            institutes: ['Fixture Institute'],
            licence: 'CC BY 4.0',
            citation: 'Fixture A (2020) Survey one. https://example.test/a',
            url: 'https://obis.org/dataset/a',
            records: 100,
            species: ['Megaptera novaeangliae'],
        },
        {
            id: 'b',
            title: 'Fixture survey two',
            institutes: [],
            licence: 'CC0 1.0',
            citation: 'Fixture B (2021) Survey two.',
            url: 'https://obis.org/dataset/b',
            records: 80,
            species: ['Dugong dugon'],
        },
    ],
    citation: 'OBIS (2026) Ocean Biodiversity Information System. https://obis.org',
});

const FLEET = parseSummary({
    v: 1,
    status: 'ok',
    generated_at: '2026-10-06T00:00:00Z',
    delay_hours: 3,
    totals: { sightings: 4, animals: 9, species: 2, boats: null, boats_min_shown: 3 },
    groups: { whale: [3, 7], dugong: [1, 2] },
    cells: [
        [-27.05, 153.65, 'whale', 'Megaptera novaeangliae', false, 2026, 8, 3, 7],
        [-27.45, 153.35, 'dugong', 'Dugong dugon', true, 2026, 10, 1, 2],
    ],
    species: [
        {
            sci: 'Megaptera novaeangliae',
            name: 'Humpback whale',
            group: 'whale',
            n: 3,
            animals: 7,
            months: { '8': 3 },
            hours: { '9': 3 },
            years: { '2026': 3 },
            sst: { '21': 5 },
        },
    ],
    recent: [
        {
            id: '0f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01',
            group: 'whale',
            sci: 'Megaptera novaeangliae',
            name: 'Humpback whale',
            count: 3,
            calf: true,
            time: '2026-08-21T03:10:00Z',
            lat: -27.055,
            lon: 153.645,
            uncertainty_m: 790,
            generalised: false,
            credit: 'fixture-boat',
        },
        {
            id: '1f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01',
            group: 'dugong',
            sci: 'Dugong dugon',
            name: 'Dugong',
            count: 1,
            calf: false,
            time: '2026-10-01T03:00:00Z',
            lat: -27.45,
            lon: 153.35,
            uncertainty_m: 7850,
            generalised: true,
            credit: 'should-never-show',
        },
    ],
});

async function show(fleet: FleetState, context: ContextState = { status: 'ok', context: CONTEXT! }) {
    const boot: OceanBoot = { summary: Promise.resolve(fleet), context: Promise.resolve(context) };
    const view = render(<OceanPage boot={boot} />);
    await act(async () => {
        await boot.summary;
        await boot.context;
    });
    return view;
}

const panel = () => screen.getByRole('complementary', { name: 'Map controls' });

describe('the ocean page', () => {
    it('day one: says the first sightings are coming, with no fleet numbers', async () => {
        const empty = parseSummary({
            v: 1,
            status: 'ok',
            totals: { sightings: 0, animals: 0, species: 0, boats: null },
            cells: [],
            species: [],
            recent: [],
        });
        await show(empty);
        expect(within(panel()).getByText('The first sightings arrive as boats log them.')).toBeInTheDocument();
        expect(screen.getByText('Waiting for the first sightings')).toBeInTheDocument();
        expect(screen.queryByText('Live · 3 h behind')).toBeNull();
        expect(within(panel()).queryByText('sightings')).toBeNull();
        // The historical layer is counted and labelled as what it is.
        expect(within(panel()).getByText('record-days')).toBeInTheDocument();
        expect(screen.getByText(/Showing historical public records/)).toBeInTheDocument();
    });

    it('before the push and when the feed is down, it says so plainly', async () => {
        const first = await show({ status: 'not-ready' });
        expect(within(panel()).getByText('The first sightings arrive as boats log them.')).toBeInTheDocument();
        first.unmount();
        const second = await show({ status: 'error' });
        expect(screen.getByText('Fleet data offline')).toBeInTheDocument();
        // The map stub stands in for a working map, so the historical layer is still on it.
        expect(
            within(panel()).getByText('Fleet data is not reachable right now; historical records are still shown.'),
        ).toBeInTheDocument();
        second.unmount();
        // With the historical layer down too, it does not claim to show it.
        await show({ status: 'error' }, { status: 'error' });
        expect(within(panel()).getByText('Fleet data is not reachable right now.')).toBeInTheDocument();
        expect(within(panel()).getByText('Historical records could not load.')).toBeInTheDocument();
    });

    it('with fleet data: real counts, "fewer than 3" boats, credit only where the skipper chose, and a blurred row never listed', async () => {
        await show(FLEET);
        expect(screen.getByText('Live · 3 h behind')).toBeInTheDocument();
        expect(within(panel()).getByText('fewer than 3')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Logged aboard fixture-boat' })).toHaveAttribute(
            'href',
            'https://fixture-boat.thalassawx.app',
        );
        expect(screen.queryByText(/should-never-show/)).toBeNull();
        // The blurred dugong row is dropped: threatened species are area counts, never a listed point.
        expect(document.querySelectorAll('.oc-latest li')).toHaveLength(1);
        expect(screen.getAllByText('on a 1 km grid').length).toBeGreaterThan(0);
    });

    it('the waiting layers explain why, from the real boat count', async () => {
        await show(FLEET);
        const effort = screen.getByRole('button', { name: /^Where we looked/ });
        expect(effort).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(effort);
        const note = document.querySelector('.oc-note');
        expect(note).toHaveTextContent(/at least 3 boats in an area/);
        expect(note).toHaveTextContent('The app does not record watching time yet.');
        expect(note).toHaveTextContent('Fewer than 3 boats are logging so far.');
        fireEvent.click(screen.getByRole('button', { name: /^Seabed mapped/ }));
        expect(screen.getByText('Collected privately for now; shared with Seabed 2030 later.')).toBeInTheDocument();
        expect(layerExplanation('rate', 4)).toMatch(/later app update/);
    });

    it('never offers fish, never promises anonymity, and gives the real blur distances', async () => {
        const { container } = await show(FLEET);
        expect(screen.queryByRole('button', { name: /fish/i })).toBeNull();
        const text = (container.textContent ?? '').replace(/\s+/g, ' ');
        expect(text).toContain('Not anonymous while the fleet is small.');
        expect(text.replace(/Not anonymous while the fleet is small/g, '')).not.toMatch(/anonym/i);
        expect(text).toContain('on a 1 km grid');
        expect(text).toContain('a 10 km square');
        expect(text).not.toMatch(/25 km|sample data|concept/i);
        expect(text).toContain('Fish (the app’s fish group) never appear; sharks and rays do.');
    });

    it('credits every historical dataset with its citation, and the dropped species', async () => {
        await show(FLEET);
        for (const d of CONTEXT!.datasets) {
            expect(screen.getByRole('link', { name: d.title })).toHaveAttribute('href', d.url);
            expect(screen.getByText(d.citation)).toBeInTheDocument();
        }
        expect(
            screen.getByText(/Loggerhead turtle \(only 5 licence-clean at-sea records \(needs 50\)\)/),
        ).toBeInTheDocument();
        expect(screen.getByText(/GEBCO Compilation Group \(2026\) GEBCO 2026 Grid/)).toBeInTheDocument();
        expect(screen.getAllByText(/Not for navigation/).length).toBeGreaterThan(0);
    });

    it('the species page shows only what it holds', async () => {
        await show(FLEET);
        const sheet = screen.getByRole('heading', { level: 2, name: 'Humpback whale' }).closest('section')!;
        expect(
            within(sheet).getByText('Encounter rates per hour watched arrive with effort data.'),
        ).toBeInTheDocument();
        fireEvent.change(within(sheet).getByRole('combobox'), { target: { value: 'Dugong dugon' } });
        const dugong = screen.getByRole('heading', { level: 2, name: 'Dugong' }).closest('section')!;
        expect(within(dugong).getByText('Threatened: area counts only')).toBeInTheDocument();
        expect(within(dugong).getByText('Shown once the fleet has logged this species.')).toBeInTheDocument();
        expect(within(dugong).getByText(/Historical public records by month/)).toBeInTheDocument();
        expect(window.location.pathname).toBe('/species/dugong-dugon');
    });
});

describe('the ocean page, fix-up 2026-10-06', () => {
    const okSummary = (over: Record<string, unknown> = {}) =>
        parseSummary({
            v: 1,
            status: 'ok',
            generated_at: '2026-10-06T00:05:00Z',
            delay_hours: 3,
            totals: { sightings: 4, animals: 9, species: 2, boats: null, boats_min_shown: 3 },
            groups: { whale: [3, 7], dugong: [1, 2] },
            cells: [
                [-27.05, 153.65, 'whale', 'Megaptera novaeangliae', false, 2026, 8, 3, 7],
                [-36.85, 174.75, 'whale', 'Megaptera novaeangliae', false, 2026, 8, 1, 2],
            ],
            species: [],
            recent: [],
            ...over,
        });

    it('a failed refresh keeps the last good numbers, and says when they are from', async () => {
        vi.useFakeTimers();
        try {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
            await show(okSummary());
            expect(screen.getByText('Live · 3 h behind')).toBeInTheDocument();
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => {
                    throw new Error('offline');
                }),
            );
            await act(async () => {
                vi.advanceTimersByTime(5 * 60_000 + 10);
            });
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(screen.queryByText('Fleet data offline')).toBeNull();
            expect(screen.getByText('Live · 3 h behind')).toBeInTheDocument();
            expect(screen.getByText(/^Last updated /)).toBeInTheDocument();
            expect(within(panel()).getAllByText('sightings').length).toBeGreaterThan(0);
        } finally {
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it('the counters count the region shown, not the whole world', async () => {
        await show(okSummary());
        const stats = () =>
            within(panel())
                .getAllByText(/^\d+$/)
                .map((n) => n.textContent);
        // East coast of Australia: the NZ cell is not in it.
        expect(stats()[0]).toBe('3');
        fireEvent.click(screen.getByRole('button', { name: 'The world' }));
        expect(stats()[0]).toBe('4');
    });

    it('threatened sightings that have no place yet are counted and explained, never placed', async () => {
        await show(okSummary({ totals: { sightings: 6, animals: 11, species: 2, boats: null, boats_min_shown: 3 } }));
        expect(within(panel()).getByText(/Plus 2 sightings of threatened species/)).toHaveTextContent(
            /counted with no place until at least 3 boats have logged them in an area/,
        );
    });

    it('day one: the fleet-only blocks fold into one line each, with no "None yet" rows', async () => {
        const empty = parseSummary({
            v: 1,
            status: 'ok',
            totals: { sightings: 0, animals: 0, species: 0, boats: null },
            cells: [],
            species: [],
            recent: [],
        });
        await show(empty);
        expect(screen.queryByText('None yet')).toBeNull();
        expect(screen.queryByText('Nothing new yet')).toBeNull();
        expect(screen.queryByRole('heading', { level: 3, name: 'Time of day' })).toBeNull();
        expect(screen.queryByRole('heading', { level: 3, name: 'Water temperature' })).toBeNull();
        expect(screen.getAllByText(/The fleet’s first sightings will appear here/).length).toBeGreaterThan(0);
    });

    it('says plainly what the effort layers need, without promising them soon', async () => {
        const { container } = await show(okSummary());
        const text = (container.textContent ?? '').replace(/\s+/g, ' ');
        expect(text).not.toMatch(/\bsoon\b/i);
        expect(text).not.toMatch(/knows where each boat looked/);
        expect(text).toContain('Effort is coming: it needs a watch log in the app and at least 3 boats in an area.');
    });

    it('the Respect section names the voyage-log limit and the 3-boat rule for threatened species', async () => {
        const { container } = await show(okSummary());
        const text = (container.textContent ?? '').replace(/\s+/g, ' ');
        expect(text).toContain(
            'Threatened species, and sightings not yet named, are shown only as area counts until at least 3 boats have logged them in an area',
        );
        expect(text).toContain(
            'If a boat also shares a public voyage log, its track can place its sightings more exactly than the grid.',
        );
        expect(text).toContain('Fish (the app’s fish group) never appear; sharks and rays do.');
        expect(text).not.toMatch(/blurred to about 10 km/);
    });

    it('has a skip link, and links each dataset licence', async () => {
        await show(okSummary());
        expect(screen.getByRole('link', { name: 'Skip to the content' })).toHaveAttribute('href', '#main');
        const deeds = screen.getAllByRole('link', { name: 'CC BY 4.0' });
        expect(deeds[0]).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/');
        for (const deed of screen.getAllByRole('link', { name: 'CC0 1.0' })) {
            expect(deed).toHaveAttribute('href', 'https://creativecommons.org/publicdomain/zero/1.0/');
        }
    });
});

describe('map helpers', () => {
    it('splits a viewport box at the antimeridian into whole-degree boxes of at most 10 degrees', () => {
        expect(rowBoxes(178.3, -18.6, 181.4, -16.2)).toEqual([
            [-19, 178, -16, 180],
            [-19, -180, -16, -178],
        ]);
        expect(rowBoxes(-181.5, -18.6, -178.2, -16.2)).toEqual([
            [-19, 178, -16, 180],
            [-19, -180, -16, -178],
        ]);
        for (const [s, w, n, e] of rowBoxes(140, -30, 163, -5)) {
            expect(n - s).toBeLessThanOrEqual(10);
            expect(e - w).toBeLessThanOrEqual(10);
        }
    });

    it('a region box may cross the antimeridian', () => {
        expect(inBox(-17, 179.5, [177, -20, -178, -15])).toBe(true);
        expect(inBox(-17, -179.5, [177, -20, -178, -15])).toBe(true);
        expect(inBox(-17, 170, [177, -20, -178, -15])).toBe(false);
    });

    it('filters by group and month, and tallies only what is shown', () => {
        expect(fleetFilter(['whale'], 8)).toEqual([
            'all',
            ['in', ['get', 'g'], ['literal', ['whale']]],
            ['==', ['get', 'm'], 8],
        ]);
        expect(tallyContext(CONTEXT, ['whale'], 6)).toEqual({ recordDays: 20, species: 1, years: [1990, 2020] });
        expect(tallyContext(CONTEXT, ['turtle'], 0)).toEqual({ recordDays: 0, species: 0, years: null });
    });

    it('the area report counts this month, this year and what is new', () => {
        const fleet = FLEET.status === 'ok' ? FLEET.summary.cells : [];
        const report = regionReport(fleet, CONTEXT, [152.9, -27.75, 153.7, -26.9], new Date('2026-10-15T00:00:00Z'));
        expect(report.month).toEqual({ sightings: 1, animals: 2, species: 1 });
        expect(report.year.sightings).toBe(4);
        expect(report.newThisMonth).toEqual(['Dugong dugon']);
        expect(report.historical.map((h) => h.name)).toEqual(['Humpback whale', 'Dugong']);
    });
});
