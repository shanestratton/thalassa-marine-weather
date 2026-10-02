/**
 * The satellite land check on a real-length route, online (2026-10-02).
 *
 * Shane's phone, 06:21, Wi-Fi and 4G both up: an 18.3 NM Auto route in the
 * Whitsundays came back "The satellite land check has not run for this route
 * (offline). Recalculate online before saving." and Save stayed off. Nothing
 * was offline. The check asked the legacy-named gebco-depth edge function for
 * its ~85 samples one by one — the edge asks NOAA ERDDAP ten points at a time,
 * and measured from the Mac that day 86 such points took 12.98 s (13.45 s end
 * to end), against a 10 s deadline. Every route over ~9 NM timed out, and the
 * timeout was worded "offline". The same edge answers the whole route's box in
 * ONE grid request (1.13 s upstream, measured the same day), and the nearest
 * grid node is exactly what ERDDAP returns for a point (23 of 23 compared).
 *
 * The fetch here answers as the deployed edge does: per point, 1.45 s per
 * round of ten; the bbox grid, in 1.13 s. Synthetic open water off the
 * Whitsundays — no chart data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Signed in (the session's headers) or not (the public key's) — the edge's
// daily allowance is per account for the one, per IP for the other.
const auth = vi.hoisted(() => ({ signedIn: false }));
vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: async () => {
        if (!auth.signedIn) throw new Error('Sign in to use this online service');
        return { 'Content-Type': 'application/json', Authorization: 'Bearer session-token', apikey: 'anon' };
    },
}));

import { inshoreRouteCrossesLand, samplePolyline, type LonLat } from '../services/routing/landBackstop';
import { backstopUnavailableWords } from '../services/routing/landBackstopWords';
import { GebcoDepthService } from '../services/GebcoDepthService';

/** The field route's shape: 18.3 NM, mostly one long diagonal. */
const ROUTE: LonLat[] = [
    [148.6179, -20.0547],
    [148.7988, -20.2245],
    [148.8055, -20.2245],
    [148.8251, -20.2429],
    [148.8557, -20.2375],
];

const PER_ROUND_MS = 1_450;
const GRID_MS = 1_130;

interface EdgeOptions {
    /** HTTP statuses to answer the grid with, in order, before answering it. */
    gridStatuses?: number[];
    /** Make the grid request throw (a dropped connection) this many times. */
    gridThrows?: number;
    /** Never answer the grid. */
    gridHangs?: boolean;
    /** Leave this node out of the grid answer. */
    missingNode?: (lat: number, lon: number) => boolean;
}

/** The deployed edge function, as measured on 2026-10-02. */
function edge(options: EdgeOptions = {}) {
    const statuses = [...(options.gridStatuses ?? [])];
    let throws = options.gridThrows ?? 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
            points?: { lat: number; lon: number }[];
            bbox?: { south: number; north: number; west: number; east: number; stride: number };
        };
        if (body.points) {
            const rounds = Math.ceil(body.points.length / 10);
            await new Promise((resolve) => setTimeout(resolve, rounds * PER_ROUND_MS));
            return new Response(
                JSON.stringify({
                    depths: body.points.map((p) => ({ ...p, depth_m: -20 })),
                    elapsed_ms: rounds * PER_ROUND_MS,
                    source: 'noaa_etopo_erddap',
                }),
                { status: 200 },
            );
        }
        if (body.bbox) {
            if (options.gridHangs) return new Promise<Response>(() => {});
            if (throws > 0) {
                throws -= 1;
                throw new TypeError('Load failed');
            }
            await new Promise((resolve) => setTimeout(resolve, GRID_MS));
            const status = statuses.shift();
            if (status !== undefined && status !== 200)
                return new Response(JSON.stringify({ error: 'nope' }), { status });
            const { south, north, west, east } = body.bbox;
            // ERDDAP snaps each end to its nearest node (1 arc-minute lattice).
            const rows: [number, number, number][] = [];
            for (let la = Math.round(south * 60); la <= Math.round(north * 60); la++)
                for (let lo = Math.round(west * 60); lo <= Math.round(east * 60); lo++)
                    if (!options.missingNode?.(la / 60, lo / 60)) rows.push([la / 60, lo / 60, -20]);
            return new Response(
                JSON.stringify({
                    grid: {
                        table: {
                            columnNames: ['latitude', 'longitude', 'altitude'],
                            columnTypes: ['double', 'double', 'short'],
                            rows,
                        },
                    },
                    elapsed_ms: GRID_MS,
                    source: 'noaa_etopo_erddap_grid',
                }),
                { status: 200 },
            );
        }
        return new Response('{}', { status: 400 });
    });
}

/** Run the check to completion on fake timers. */
async function check(polyline: LonLat[] = ROUTE) {
    const pending = inshoreRouteCrossesLand(polyline);
    for (let i = 0; i < 120; i++) await vi.advanceTimersByTimeAsync(1_000);
    return pending;
}

let online = true;
beforeEach(() => {
    vi.useFakeTimers();
    GebcoDepthService.clearCache();
    online = true;
    auth.signedIn = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the satellite land check on the field route, online', () => {
    it('is the 85 samples an 18.3 NM route asks for (one every 400 m)', () => {
        expect(samplePolyline(ROUTE)).toHaveLength(85);
    });

    it('comes back verified from one grid request, inside its deadline', async () => {
        const fetch = edge();
        const result = await check();
        expect(result).toMatchObject({ status: 'verified', crossesLand: false, samplesChecked: 85 });
        expect(fetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
        expect(body.bbox).toMatchObject({ stride: 1 });
        // The box holds every sample's nearest node, and one node beyond.
        const node = (deg: number) => Math.round(deg * 60) / 60;
        const samples = samplePolyline(ROUTE);
        expect(body.bbox.south).toBeLessThanOrEqual(Math.min(...samples.map((s) => node(s[1]))) - 1 / 60 + 1e-9);
        expect(body.bbox.north).toBeGreaterThanOrEqual(Math.max(...samples.map((s) => node(s[1]))) + 1 / 60 - 1e-9);
        expect(body.bbox.west).toBeLessThanOrEqual(Math.min(...samples.map((s) => node(s[0]))) - 1 / 60 + 1e-9);
        expect(body.bbox.east).toBeGreaterThanOrEqual(Math.max(...samples.map((s) => node(s[0]))) + 1 / 60 - 1e-9);
    });

    it('reads each sample at its nearest grid node — what ERDDAP answers for a point', async () => {
        const answered: string[] = [];
        edge({
            missingNode: (lat, lon) => {
                answered.push(`${Math.round(lat * 60)},${Math.round(lon * 60)}`);
                return false;
            },
        });
        const result = await check();
        expect(result.status).toBe('verified');
        for (const [lon, lat] of samplePolyline(ROUTE))
            expect(answered).toContain(`${Math.round(lat * 60)},${Math.round(lon * 60)}`);
    });

    it('reuses what it already has: a second check of the same line asks nothing', async () => {
        const fetch = edge();
        await check();
        await check();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('rides out one dropped request or one server error, after a short wait', async () => {
        let fetch = edge({ gridThrows: 1 });
        await expect(check()).resolves.toMatchObject({ status: 'verified' });
        expect(fetch).toHaveBeenCalledTimes(2);
        vi.restoreAllMocks();
        vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
        GebcoDepthService.clearCache();
        fetch = edge({ gridStatuses: [503] });
        await expect(check()).resolves.toMatchObject({ status: 'verified' });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('when the check truly cannot run, it says what happened — never "offline" while online', () => {
    const words = (result: Awaited<ReturnType<typeof check>>) => backstopUnavailableWords(result.unavailable);

    // Fix-up review (2026-10-03): two 12 s attempts and the pause between
    // them are ~25.5 s of waiting, not "within 12 s".
    it('the source does not answer: a timeout, after one retry — and says both waits', async () => {
        const fetch = edge({ gridHangs: true });
        const result = await check();
        expect(result.status).toBe('unavailable');
        expect(result.unavailable).toMatchObject({ kind: 'timeout', waitedMs: 12_000, attempts: 2 });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(words(result)).toBe("the satellite relief service didn't answer (tried twice, 12 s each)");
        expect(words(result)).not.toMatch(/offline/i);
        expect(backstopUnavailableWords({ kind: 'timeout', waitedMs: 27_500 })).toBe(
            "the satellite relief service didn't answer within 28 s",
        );
    });

    it('the connection drops twice: the request did not get through', async () => {
        edge({ gridThrows: 2 });
        const result = await check();
        expect(result).toMatchObject({ status: 'unavailable', unavailable: { kind: 'network' } });
        expect(words(result)).toBe("the request didn't get through (network error)");
    });

    it("the account's daily allowance is used up: said once, not retried", async () => {
        const fetch = edge({ gridStatuses: [429] });
        const result = await check();
        expect(result).toMatchObject({ status: 'unavailable', unavailable: { kind: 'quota', status: 429 } });
        expect(result.unavailable).not.toHaveProperty('sharedKey');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(words(result)).toBe("today's allowance of satellite checks for this account is used up");
    });

    // Fix-up review (2026-10-03): without a session the request rides the
    // public key, whose allowance is per IP — shared by everyone on marina
    // Wi-Fi or behind a carrier's NAT. It is not "this account's".
    it("without a session, a used-up allowance is this connection's, not the account's", async () => {
        auth.signedIn = false;
        const fetch = edge({ gridStatuses: [429] });
        const result = await check();
        expect(result.unavailable).toMatchObject({ kind: 'quota', status: 429, sharedKey: true });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(words(result)).toBe(
            "today's allowance of satellite checks for this connection is used up — without your sign-in it is shared with everyone on this network",
        );
        expect(words(result)).not.toMatch(/account/);
    });

    it('signed out or an expired session: not retried', async () => {
        const fetch = edge({ gridStatuses: [401] });
        const result = await check();
        expect(result).toMatchObject({ status: 'unavailable', unavailable: { kind: 'auth', status: 401 } });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(words(result)).toBe("you're not signed in, or the session has expired");
    });

    it('a server error twice: the status is named', async () => {
        edge({ gridStatuses: [502, 502] });
        const result = await check();
        expect(result).toMatchObject({ status: 'unavailable', unavailable: { kind: 'server', status: 502 } });
        expect(words(result)).toBe('the satellite relief service answered with an error (HTTP 502)');
    });

    it('part of the route came back without relief', async () => {
        edge({ missingNode: (lat) => lat < -20.2 });
        const result = await check();
        expect(result.status).toBe('unavailable');
        expect(result.unavailable).toMatchObject({ kind: 'partial', total: 85 });
        expect(words(result)).toMatch(/^\d+ of 85 points along the route came back without satellite relief$/);
    });

    it('only an offline phone is called offline — and nothing is asked', async () => {
        online = false;
        const fetch = edge();
        const result = await check();
        expect(result).toMatchObject({ status: 'unavailable', unavailable: { kind: 'offline' } });
        expect(fetch).not.toHaveBeenCalled();
        expect(words(result)).toBe('this phone is offline');
    });

    it('a caller that gives no reason gets plain words, not "offline"', () => {
        expect(backstopUnavailableWords(undefined)).toBe("the satellite relief didn't come back for the whole route");
    });
});
