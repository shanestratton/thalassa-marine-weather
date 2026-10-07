/**
 * The route consensus matrix names a model only when that model answered.
 *
 * Before build 123, when the multi-model fetch failed the engine sampled the
 * ONE chart grid and multiplied it by sin-noise into "ECMWF", "ICON" and "GEM",
 * then graded those inventions AGREE / MIXED / SPLIT. It also turned a model's
 * null into a 0-knot calm, made gusts up as wind × 1.4, read a degraded
 * unsuffixed reply once per model (four "models", one number), and clamped an
 * ETA past the grid's end onto its last hour.
 *
 * Now: one grid is one grid. It is shown as such, with no model names and no
 * agreement badges, at the hour the boat is really there; a model that gave
 * nothing at an hour sits that hour out. Routes are fictional, one per ocean.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindGrid } from '../services/weather/windField';
import type { IsochroneResult } from '../services/IsochroneRouter';
import { generateConsensusMatrix, type ConsensusMatrixData } from '../services/ConsensusMatrixEngine';
import { ConsensusMatrix, GRID_ROW_TAG, SINGLE_GRID_NOTICE } from '../components/map/ConsensusMatrix';

const REF = Date.parse('2026-10-07T00:00:00Z');
const MS_TO_KT = 1.94384;
const HOURS = 30;

type LatLon = { lat: number; lon: number };
const ROUTES: Record<string, [LatLon, LatLon]> = {
    med: [
        { lat: 36.1, lon: -5.3 },
        { lat: 38.9, lon: 1.4 },
    ],
    caribbean: [
        { lat: 17.1, lon: -61.8 },
        { lat: 18.4, lon: -64.6 },
    ],
    pacific: [
        { lat: -17.5, lon: -149.6 },
        { lat: -16.5, lon: -151.7 },
    ],
    northSea: [
        { lat: 52.96, lon: 4.76 },
        { lat: 52.47, lon: 1.75 },
    ],
    usWest: [
        { lat: 37.8, lon: -122.6 },
        { lat: 36.6, lon: -121.9 },
    ],
    queensland: [
        { lat: -20.27, lon: 148.72 },
        { lat: -21.15, lon: 149.2 },
    ],
};

/** Wind FROM the north at (h + 5) m/s in hour h; gust (h + 9) m/s when asked. */
function grid(from: LatLon, to: LatLon, opts: { gust?: boolean; refTime?: string | null } = {}): WindGrid {
    const south = Math.min(from.lat, to.lat) - 2;
    const north = Math.max(from.lat, to.lat) + 2;
    const west = Math.min(from.lon, to.lon) - 2;
    const east = Math.max(from.lon, to.lon) + 2;
    const width = 3;
    const height = 3;
    const plane = (value: number) => new Float32Array(width * height).fill(value);
    const hours = Array.from({ length: HOURS }, (_, h) => h);
    return {
        u: hours.map(() => plane(0)),
        v: hours.map((h) => plane(-(h + 5))),
        speed: hours.map((h) => plane(h + 5)),
        ...(opts.gust ? { gust: hours.map((h) => plane(h + 9)) } : {}),
        width,
        height,
        lats: [south, (south + north) / 2, north],
        lons: [west, (west + east) / 2, east],
        north,
        south,
        east,
        west,
        totalHours: HOURS,
        ...(opts.refTime === null ? {} : { refTime: opts.refTime ?? new Date(REF).toISOString() }),
    };
}

function route(from: LatLon, to: LatLon, hours = 18, nm = 120): IsochroneResult {
    const steps = 6;
    const nodes = Array.from({ length: steps + 1 }, (_, i) => {
        const f = i / steps;
        return {
            lat: from.lat + (to.lat - from.lat) * f,
            lon: from.lon + (to.lon - from.lon) * f,
            timeHours: hours * f,
            bearing: 0,
            speed: 6,
            tws: 10,
            twa: 90,
            parentIndex: i === 0 ? null : 0,
            distance: nm * f,
        };
    });
    return {
        route: nodes,
        isochrones: [],
        totalDistanceNM: nm,
        totalDurationHours: hours,
        arrivalTime: new Date(REF + hours * 3_600_000).toISOString(),
        routeCoordinates: nodes.map((n) => [n.lon, n.lat]),
        shallowFlags: nodes.map(() => false),
    };
}

const kt = (ms: number) => Math.round(ms * MS_TO_KT * 10) / 10;

beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('when the multi-model fetch fails: one grid, shown as one grid', () => {
    it.each(Object.keys(ROUTES))('%s — no invented members, the grid’s own number at each hour', async (name) => {
        const [from, to] = ROUTES[name];
        const departure = new Date(REF + 3 * 3_600_000).toISOString(); // grid hour 3
        const data = await generateConsensusMatrix(route(from, to), grid(from, to), departure, undefined, 6);

        expect(data.dataSource).toBe('single-grid');
        expect(data.modelsUsed).toEqual([]);
        expect(data.rows.length).toBeGreaterThan(0);
        for (const row of data.rows) {
            expect(row.models).toEqual([]);
            expect(row.confidence).toBeNull();
            expect(row.spreadKts).toBeNull();
            // Departure is grid hour 3, so the row at +h reads grid hour 3 + h.
            const gridHour = 3 + row.hoursFromDep;
            expect(row.grid).toEqual({ windKts: kt(gridHour + 5), directionDeg: 0, gustKts: null });
        }
        expect(data.summary.avgSpreadKts).toBeNull();
        expect(data.summary.maxSpreadKts).toBeNull();
        expect(data.summary.lowConfidenceCount).toBe(0);
        expect(data.emptyReason).toBeNull();
    });

    it('takes the gust from the grid when the grid has one, never wind × 1.4', async () => {
        const [from, to] = ROUTES.med;
        const data = await generateConsensusMatrix(
            route(from, to),
            grid(from, to, { gust: true }),
            new Date(REF).toISOString(),
        );
        expect(data.rows[0].grid).toEqual({ windKts: kt(5), directionDeg: 0, gustKts: kt(9) });
    });

    it('leaves out an hour past the end of the grid rather than repeating its last hour', async () => {
        const [from, to] = ROUTES.northSea;
        // Departure at grid hour 20 + an 18 h passage runs past the 30 h grid.
        const data = await generateConsensusMatrix(
            route(from, to),
            grid(from, to),
            new Date(REF + 20 * 3_600_000).toISOString(),
        );
        expect(data.rows.map((r) => r.hoursFromDep)).toEqual([0, 6]);
    });

    it('a grid with no clock of its own cannot be placed in time, so it shows nothing', async () => {
        const [from, to] = ROUTES.caribbean;
        const data = await generateConsensusMatrix(
            route(from, to),
            grid(from, to, { refTime: null }),
            new Date(REF).toISOString(),
        );
        expect(data.rows).toEqual([]);
        expect(data.emptyReason).toBe('no-clock');
    });

    it('a passage wholly past the grid says no forecast covers it — not that the grid has no clock', async () => {
        const [from, to] = ROUTES.med;
        const data = await generateConsensusMatrix(
            route(from, to),
            grid(from, to),
            new Date(REF + 40 * 3_600_000).toISOString(), // the 30 h grid ended 10 h before departure
        );
        expect(data.rows).toEqual([]);
        expect(data.emptyReason).toBe('no-coverage');
    });

    it('rates comfort on the grid’s own wind, without a fabricated gust', async () => {
        const [from, to] = ROUTES.queensland;
        const data = await generateConsensusMatrix(route(from, to), grid(from, to), new Date(REF).toISOString(), {
            maxWindKts: 20,
            maxGustKts: 12,
        } as never);
        // Hour 0: 5 m/s = 9.7 kt, under 20 kt. A gust of 9.7 × 1.4 = 13.6 kt would
        // have breached 12 kt; the grid has no gust, so nothing is breached.
        expect(data.rows[0].exceedsComfort).toBe(false);
        // Hour 6: 11 m/s = 21.4 kt, over 20 kt.
        expect(data.rows[1].exceedsComfort).toBe(true);
    });
});

/** Open-Meteo multi-model reply rows, one per requested point, unixtime clock. */
function liveReplies(
    count: number,
    perModel: Record<string, { speed: (number | null)[]; gust?: (number | null)[]; dir?: number }>,
    unsuffixedOnly = false,
) {
    const time = Array.from({ length: HOURS }, (_, h) => REF / 1000 + h * 3600);
    const hourly: Record<string, unknown> = { time };
    for (const [id, m] of Object.entries(perModel)) {
        const suffix = unsuffixedOnly ? '' : `_${id}`;
        hourly[`wind_speed_10m${suffix}`] = m.speed;
        hourly[`wind_direction_10m${suffix}`] = m.speed.map(() => m.dir ?? 180);
        hourly[`wind_gusts_10m${suffix}`] = m.gust ?? m.speed.map(() => null);
    }
    return Array.from({ length: count }, () => ({ hourly }));
}

const kmh = (k: number) => Math.round(k * 1.852 * 1000) / 1000;
const series = (k: number | null) => Array.from({ length: HOURS }, () => (k === null ? null : kmh(k)));

describe('live multi-model rows', () => {
    it('asks for the four models with a unix clock, and a model with no value at an hour sits it out', async () => {
        const [from, to] = ROUTES.pacific;
        const fetchSpy = vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as { params: Record<string, string> };
            const count = body.params.latitude.split(',').length;
            return new Response(
                JSON.stringify(
                    liveReplies(count, {
                        gfs_seamless: { speed: series(12), gust: series(18) },
                        ecmwf_ifs025: { speed: series(16) },
                        icon_seamless: { speed: series(14), gust: series(20) },
                        gem_seamless: { speed: series(null) },
                    }),
                ),
                { status: 200 },
            );
        });

        const data = await generateConsensusMatrix(route(from, to), grid(from, to), new Date(REF).toISOString());
        const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { params: Record<string, string> };
        expect(body.params.models.split(',')).toEqual([
            'gfs_seamless',
            'ecmwf_ifs025',
            'icon_seamless',
            'gem_seamless',
        ]);
        expect(body.params.timeformat).toBe('unixtime');

        expect(data.dataSource).toBe('live');
        expect(data.modelsUsed).toEqual(['GFS', 'ECMWF', 'ICON']);
        const row = data.rows[0];
        expect(row.models.map((m) => m.model)).toEqual(['GFS', 'ECMWF', 'ICON']);
        expect(row.models.find((m) => m.model === 'ECMWF')).toMatchObject({ windKts: 16, gustKts: null });
        expect(row.models.find((m) => m.model === 'GFS')).toMatchObject({ windKts: 12, gustKts: 18 });
        expect(row.spreadKts).toBe(4);
        expect(row.confidence).toBe('high');
        expect(row.worstCase).toEqual({ model: 'ECMWF', windKts: 16, gustKts: null });
    });

    it('an unsuffixed (degraded) reply is not four models agreeing perfectly', async () => {
        const [from, to] = ROUTES.usWest;
        vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as { params: Record<string, string> };
            const count = body.params.latitude.split(',').length;
            return new Response(JSON.stringify(liveReplies(count, { any: { speed: series(10) } }, true)), {
                status: 200,
            });
        });
        const data = await generateConsensusMatrix(route(from, to), grid(from, to), new Date(REF).toISOString());
        expect(data.dataSource).toBe('single-grid');
        expect(data.rows.every((r) => r.models.length === 0 && r.confidence === null)).toBe(true);
    });

    it('one model at an hour is no agreement: no spread, no confidence', async () => {
        const [from, to] = ROUTES.med;
        vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as { params: Record<string, string> };
            const count = body.params.latitude.split(',').length;
            return new Response(
                JSON.stringify(
                    liveReplies(count, {
                        gfs_seamless: { speed: series(null) },
                        ecmwf_ifs025: { speed: series(22) },
                        icon_seamless: { speed: series(null) },
                        gem_seamless: { speed: series(null) },
                    }),
                ),
                { status: 200 },
            );
        });
        const data = await generateConsensusMatrix(route(from, to), grid(from, to), new Date(REF).toISOString());
        expect(data.rows[0].models.map((m) => m.model)).toEqual(['ECMWF']);
        expect(data.rows[0].spreadKts).toBeNull();
        expect(data.rows[0].confidence).toBeNull();

        // The panel does not call one model "multi-model".
        const { container } = render(<ConsensusMatrix data={data} />);
        expect(container.textContent).toContain('LIVE · ONE MODEL');
        expect(container.textContent).not.toMatch(/MULTI-MODEL/);
    });

    it('rows past the models’ last hour fall back to the grid, and say so on the row', async () => {
        const [from, to] = ROUTES.caribbean;
        // The models answer for the first 12 h only (a long passage past their
        // horizon, or an outage); the grid still covers the later rows.
        const shortSeries = (k: number) => Array.from({ length: HOURS }, (_, h) => (h < 12 ? kmh(k) : null));
        vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as { params: Record<string, string> };
            const count = body.params.latitude.split(',').length;
            return new Response(
                JSON.stringify(
                    liveReplies(count, {
                        gfs_seamless: { speed: shortSeries(12) },
                        ecmwf_ifs025: { speed: shortSeries(15) },
                        icon_seamless: { speed: shortSeries(13) },
                        gem_seamless: { speed: shortSeries(14) },
                    }),
                ),
                { status: 200 },
            );
        });
        const data = await generateConsensusMatrix(route(from, to), grid(from, to), new Date(REF).toISOString());
        expect(data.dataSource).toBe('live');
        expect(data.rows.map((r) => [r.hoursFromDep, r.models.length, Boolean(r.grid)])).toEqual([
            [0, 4, false],
            [6, 4, false],
            [12, 0, true],
            [18, 0, true],
        ]);

        render(<ConsensusMatrix data={data} />);
        expect(screen.getByText('● LIVE MULTI-MODEL')).toBeInTheDocument();
        const gridRows = screen.getAllByTestId('consensus-grid-row');
        expect(gridRows).toHaveLength(2);
        for (const row of gridRows) expect(row.textContent).toContain(GRID_ROW_TAG);
        expect(screen.getAllByText(GRID_ROW_TAG)).toHaveLength(2);
    });
});

function singleGridData(): ConsensusMatrixData {
    return {
        rows: [
            {
                timeLabel: 'Wed 10:00',
                timestamp: new Date(REF).toISOString(),
                hoursFromDep: 0,
                lat: 36.1,
                lon: -5.3,
                distanceNM: 0,
                models: [],
                grid: { windKts: 14.2, directionDeg: 270, gustKts: null },
                spreadKts: null,
                confidence: null,
                exceedsComfort: false,
                worstCase: { model: null, windKts: 14.2, gustKts: null },
            },
        ],
        routeCoords: [[-5.3, 36.1]],
        modelsUsed: [],
        dataSource: 'single-grid',
        emptyReason: null,
        summary: { avgSpreadKts: null, maxSpreadKts: null, lowConfidenceCount: 0, comfortBreachCount: 0 },
    };
}

describe('the matrix panel', () => {
    it('says plainly that there is no comparison, and names no model', () => {
        const { container } = render(<ConsensusMatrix data={singleGridData()} onClose={vi.fn()} />);
        expect(screen.getByText('Model comparison unavailable — one grid shown')).toBeInTheDocument();
        const text = container.textContent ?? '';
        expect(text).not.toMatch(/\b(GFS|ECMWF|ICON|GEM)\b/);
        expect(text).not.toMatch(/AGREE|MIXED|SPLIT|Avg Spread|Worst/i);
        expect(text).toContain('14');
        // The whole panel is one grid, so the header says it once, not every row.
        expect(text).not.toContain(GRID_ROW_TAG);
        // The close control the passage HUD keys off is still there.
        expect(screen.getByRole('button', { name: 'Close consensus matrix' })).toBeInTheDocument();
    });

    it('a live row with a single model shows no agreement badge', () => {
        const data = singleGridData();
        data.dataSource = 'live';
        data.modelsUsed = ['ECMWF'];
        data.rows[0] = {
            ...data.rows[0],
            grid: undefined,
            models: [{ model: 'ECMWF', color: '#a78bfa', windKts: 14.2, directionDeg: 270, gustKts: null }],
            worstCase: { model: 'ECMWF', windKts: 14.2, gustKts: null },
        };
        const { container } = render(<ConsensusMatrix data={data} />);
        expect(container.textContent).toContain('ECMWF');
        expect(container.textContent).not.toMatch(/AGREE|MIXED|SPLIT/);
        expect(container.textContent).toContain('LIVE · ONE MODEL');
        expect(container.textContent).not.toMatch(/MULTI-MODEL/);
    });

    it.each([
        ['no-clock', /carries no forecast time, so it can’t be placed on your passage/],
        ['no-coverage', /No forecast covers this route’s places and times/],
    ] as const)('with nothing to show (%s) it gives the real reason and claims no grid', (reason, line) => {
        const data = singleGridData();
        data.rows = [];
        data.emptyReason = reason;
        const { container } = render(<ConsensusMatrix data={data} />);
        expect(screen.getByText('Model comparison unavailable')).toBeInTheDocument();
        expect(screen.getByText(line)).toBeInTheDocument();
        expect(container.textContent).not.toContain(SINGLE_GRID_NOTICE);
        expect(container.textContent).not.toMatch(/one grid shown|reaches this route/i);
    });
});
