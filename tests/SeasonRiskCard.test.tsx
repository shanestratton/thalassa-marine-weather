/**
 * SeasonRiskCard (W1-12) — the cyclone-season card in the Trip Overview.
 *
 * Pins the user-facing contract: the plan's sentence per month under way,
 * the 12-month strip with the season shaded and the passage months marked,
 * the "climate, not a forecast" caption and the IBTrACS credit; the honest
 * gaps (no route, offline, a leg without a route, the Mediterranean that
 * IBTrACS does not cover); and the quiet failure paths (data failed → one
 * line; card chunk failed → nothing, not the Route Planner's crash card).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Suspense, lazy } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchRoutesAndTracks = vi.fn();
vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: (...args: unknown[]) => fetchRoutesAndTracks(...args),
}));

import { SeasonRiskCard } from '../components/passage/SeasonRiskCard';
import { __resetTcClimatologyCacheForTests } from '../services/climatology/tcClimatology';

const cell = (months: Record<number, string>): string =>
    Array.from({ length: 12 }, (_, m) => months[m] ?? '').join('|');

// A fictional South Pacific box: five storms in February, one in July.
const CLIMATOLOGY = {
    format: 'thalassa.tc-climatology',
    version: 1,
    source: 'NOAA IBTrACS v04r01',
    credit: "NOAA's International Best Track Archive for Climate Stewardship (IBTrACS) v04r01, accessed 2026-10-08",
    accessed: '2026-10-08',
    firstYear: 1991,
    lastYear: 2024,
    boxDeg: 5,
    minWindKt: 34,
    storms: 6,
    idWidth: 2,
    cells: {
        '-20,165': cell({ 1: 'AAABACADAE', 6: 'AF' }),
        // A second fictional box, further west: one February storm of its own.
        '-20,150': cell({ 1: 'BA' }),
    },
};

const leg = {
    id: 'voyage-1',
    user_id: 'user-1',
    vessel_id: null,
    voyage_name: 'Port Alpha → Port Beta',
    departure_port: 'Port Alpha',
    destination_port: 'Port Beta',
    departure_time: '2027-02-10T12:00:00Z',
    eta: '2027-02-14T12:00:00Z',
    crew_count: 2,
    status: 'planning' as const,
    weather_master_id: null,
    notes: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
};

const ROUTE = {
    label: 'Port Alpha → Port Beta',
    points: [
        { lat: -17.5, lon: 166.5 },
        { lat: -17.5, lon: 168.0 },
    ],
};

beforeEach(() => {
    __resetTcClimatologyCacheForTests();
    fetchRoutesAndTracks.mockResolvedValue({ routes: [ROUTE], tracks: [] });
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(CLIMATOLOGY), { status: 200 })),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchRoutesAndTracks.mockReset();
});

describe('SeasonRiskCard', () => {
    it("states the storms near the route in the passage's month, with the plan's wording", async () => {
        render(<SeasonRiskCard legs={[leg]} />);
        const line = await screen.findByTestId('tc-month-line');
        expect(line).toHaveTextContent('Tropical cyclones near this route in February: 5 in 34 years (IBTrACS)');
        expect(fetch).toHaveBeenCalledWith('/climatology/tc-monthly-5deg.json');
    });

    it('shades the season months and marks the passage month on a 12-month strip', async () => {
        render(<SeasonRiskCard legs={[leg]} />);
        const strip = await screen.findByRole('list', { name: /cyclones near this route by month/i });
        const months = strip.querySelectorAll('li');
        expect(months).toHaveLength(12);
        const feb = months[1];
        const jul = months[6];
        expect(feb).toHaveAttribute('data-in-season', 'true');
        expect(feb).toHaveAttribute('data-planned', 'true');
        expect(feb).toHaveAccessibleName(/February: 5 storms in 34 years.*cyclone season.*your passage/);
        expect(jul).toHaveAttribute('data-in-season', 'false');
        expect(jul).toHaveAttribute('data-planned', 'false');
    });

    it('says what it is and credits IBTrACS', async () => {
        render(<SeasonRiskCard legs={[leg]} />);
        await screen.findByTestId('tc-month-line');
        expect(screen.getByText(/climate, not a forecast; storm counts, not intensities/i)).toBeInTheDocument();
        expect(screen.getByText(/NOAA IBTrACS v04r01/)).toBeInTheDocument();
    });

    it('shows the whole year when no leg has a date yet', async () => {
        render(<SeasonRiskCard legs={[{ ...leg, departure_time: null, eta: null }]} />);
        await screen.findByRole('list', { name: /cyclones near this route by month/i });
        expect(screen.queryByTestId('tc-month-line')).not.toBeInTheDocument();
        expect(screen.getByText(/no departure date yet/i)).toBeInTheDocument();
        expect(screen.queryByText(/outlined: your passage/i)).not.toBeInTheDocument();
    });

    it('counts each month over the legs at sea then, and says why the strip can differ', async () => {
        const leg2 = {
            ...leg,
            id: 'voyage-2',
            voyage_name: 'Port Beta → Port Gamma',
            departure_port: 'Port Beta',
            destination_port: 'Port Gamma',
            departure_time: '2027-03-02T12:00:00Z',
            eta: '2027-03-06T12:00:00Z',
            routeCoordinates: [
                { lat: -17.5, lon: 151.5 },
                { lat: -17.5, lon: 153.0 },
            ],
        };
        render(<SeasonRiskCard legs={[leg, leg2]} />);
        const lines = await screen.findAllByTestId('tc-month-line');
        expect(lines.map((l) => l.textContent)).toEqual([
            'Tropical cyclones near this route in February: 5 in 34 years (IBTrACS)',
            'Tropical cyclones near this route in March: 0 in 34 years (IBTrACS)',
        ]);
        const months = screen.getByRole('list', { name: /cyclones near this route by month/i }).querySelectorAll('li');
        // The strip is the whole trip: leg 2's box adds its own February storm.
        expect(months[1]).toHaveAccessibleName(/February: 6 storms in 34 years/);
        expect(screen.getByText(/each line, only the legs at sea that month/i)).toBeInTheDocument();
        // Leg 2 carried its own geometry; leg 1 still came from the saved routes.
        expect(fetchRoutesAndTracks).toHaveBeenCalledTimes(1);
    });

    it('says so in one line when no leg has a route, without fetching the climatology', async () => {
        fetchRoutesAndTracks.mockResolvedValue({ routes: [], tracks: [] });
        render(<SeasonRiskCard legs={[leg]} />);
        expect(await screen.findByTestId('tc-no-route')).toHaveTextContent(
            'This trip has no saved route yet, so the cyclone season can’t be shown.',
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });

    it('says the route is not available offline rather than vanishing', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        // Offline, the saved routes come back empty (RoutesAndTracks swallows the failure).
        fetchRoutesAndTracks.mockResolvedValue({ routes: [], tracks: [] });
        render(<SeasonRiskCard legs={[leg]} />);
        expect(await screen.findByTestId('tc-no-route')).toHaveTextContent(
            'This trip has no route available offline, so the cyclone season can’t be shown.',
        );
        expect(fetch).not.toHaveBeenCalled();
    });

    it('names a leg it could not assess instead of silently dropping it', async () => {
        const leg2 = {
            ...leg,
            id: 'voyage-2',
            voyage_name: 'Port Beta → Port Gamma',
            departure_port: 'Port Beta',
            destination_port: 'Port Gamma',
            departure_time: '2027-03-02T12:00:00Z',
            eta: '2027-03-06T12:00:00Z',
        };
        render(<SeasonRiskCard legs={[leg, leg2]} />);
        expect(await screen.findByTestId('tc-skipped-legs')).toHaveTextContent(
            'Leg 2 has no saved route, so it is not counted.',
        );
        // Only leg 1 (February) is assessed.
        expect((await screen.findAllByTestId('tc-month-line')).map((l) => l.textContent)).toEqual([
            'Tropical cyclones near this route in February: 5 in 34 years (IBTrACS)',
        ]);
    });

    it('lists several skipped legs together', async () => {
        const unrouted = (n: number) => ({
            ...leg,
            id: `voyage-${n}`,
            departure_port: `Port ${n}`,
            destination_port: `Port ${n + 1}`,
        });
        render(<SeasonRiskCard legs={[unrouted(10), leg, unrouted(30)]} />);
        expect(await screen.findByTestId('tc-skipped-legs')).toHaveTextContent(
            'Legs 1 and 3 have no saved route, so they are not counted.',
        );
    });

    it('reads saved legs that carry their own geometry (Trip · Legs) without the saved-routes lookup, even offline', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        render(
            <SeasonRiskCard
                routeLegs={[
                    { points: ROUTE.points },
                    // A saved leg without a usable line is named, not dropped.
                    { points: [{ lat: -17.5, lon: 168.0 }] },
                ]}
            />,
        );
        const strip = await screen.findByRole('list', { name: /cyclones near this route by month/i });
        expect(strip.querySelectorAll('li')[1]).toHaveAccessibleName(/February: 5 storms in 34 years/);
        expect(screen.getByText(/no departure date yet/i)).toBeInTheDocument();
        expect(screen.getByTestId('tc-skipped-legs')).toHaveTextContent(
            'Leg 2 has no saved route, so it is not counted.',
        );
        expect(fetchRoutesAndTracks).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledWith('/climatology/tc-monthly-5deg.json');
    });

    it('flags the Mediterranean as not covered by IBTrACS, and only there', async () => {
        const medLeg = {
            ...leg,
            routeCoordinates: [
                { lat: 39.57, lon: 2.65 },
                { lat: 35.9, lon: 14.51 },
            ],
        };
        const { unmount } = render(<SeasonRiskCard legs={[medLeg]} />);
        await screen.findByTestId('tc-month-line');
        expect(screen.getByTestId('tc-coverage-note')).toHaveTextContent(
            /medicanes.*Ianos 2020, Daniel 2023.*not a measured zero/,
        );
        unmount();

        const caribbeanLeg = {
            ...leg,
            routeCoordinates: [
                { lat: 17.0, lon: -61.76 },
                { lat: 17.93, lon: -76.8 },
            ],
        };
        render(<SeasonRiskCard legs={[caribbeanLeg]} />);
        await screen.findByTestId('tc-month-line');
        expect(screen.queryByTestId('tc-coverage-note')).not.toBeInTheDocument();
    });

    it('is mounted lazily in the Trip Overview, so neither the card nor its data loads before the sheet opens', () => {
        const src = readFileSync(resolve(__dirname, '../components/passage/TripOverviewSheet.tsx'), 'utf8');
        expect(src).toMatch(/lazy\(\(\) => import\('\.\/SeasonRiskCard'\)\)/);
        expect(src).not.toMatch(/^import .*SeasonRiskCard/m);
        expect(src).not.toMatch(/tcClimatology/);
        expect(src).toMatch(/<SeasonRiskCard legs=\{stableLegs\} \/>/);
    });

    it('is fenced by its own quiet error boundary, so a stale chunk cannot take down the Route Planner', () => {
        const src = readFileSync(resolve(__dirname, '../components/passage/TripOverviewSheet.tsx'), 'utf8');
        expect(src).toMatch(
            /<ErrorBoundary boundaryName="SeasonRiskCard" fallback=\{RENDER_NOTHING\}>\s*<Suspense fallback=\{null\}>\s*<SeasonRiskCard legs=\{stableLegs\} \/>\s*<\/Suspense>\s*<\/ErrorBoundary>/,
        );
    });

    it('a failed card chunk renders nothing inside that boundary (not the crash card)', async () => {
        const { ErrorBoundary } = await import('../components/ErrorBoundary');
        const Broken = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // React re-throws the caught error on window in dev; keep jsdom from echoing it.
        const swallow = (e: ErrorEvent) => e.preventDefault();
        window.addEventListener('error', swallow);
        try {
            render(
                <div data-testid="sheet">
                    <p>Itinerary</p>
                    <ErrorBoundary boundaryName="SeasonRiskCard" fallback={<></>}>
                        <Suspense fallback={null}>
                            <Broken />
                        </Suspense>
                    </ErrorBoundary>
                    <p>Customs</p>
                </div>,
            );
            await waitFor(() => expect(spy).toHaveBeenCalled());
            expect(screen.getByTestId('sheet')).toHaveTextContent(/^ItineraryCustoms$/);
            expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
        } finally {
            window.removeEventListener('error', swallow);
            spy.mockRestore();
        }
    });

    it('says so in one line when the climatology cannot load', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('gone', { status: 404 })),
        );
        render(<SeasonRiskCard legs={[leg]} />);
        expect(await screen.findByText(/cyclone climatology couldn.t load/i)).toBeInTheDocument();
        expect(screen.queryByTestId('tc-month-line')).not.toBeInTheDocument();
    });
});
