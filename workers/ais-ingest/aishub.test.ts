/**
 * AISHub aggregate parsing — fixtures shaped from their documented
 * webservice response (output=json, format=1). The poller itself is
 * exercised through its rate-floor and single-flight seams.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    parseAishubResponse,
    parseAishubTime,
    parseAishubVessel,
    startAishubPoller,
    getAishubStats,
    isRateLimitMessage,
} from './aishub.js';
import type { VesselDB } from './db.js';

const NOW = Date.parse('2026-08-21T03:20:00Z');

const freshTime = '2026-08-21 03:15:07 GMT'; // ~5 min before NOW
const staleTime = '2026-08-21 02:20:00 GMT'; // an hour before NOW

const row = (over: Record<string, unknown> = {}) => ({
    MMSI: 503101240,
    TIME: freshTime,
    LATITUDE: -27.1951,
    LONGITUDE: 153.1056,
    COG: 123.4,
    SOG: 6.5,
    HEADING: 124,
    NAVSTAT: 0,
    IMO: 0,
    NAME: 'WHISKERS',
    CALLSIGN: 'MQ258Q',
    TYPE: 36,
    A: 8,
    B: 4,
    C: 2,
    D: 2,
    DRAUGHT: 18,
    DEST: 'NEWPORT',
    ETA: '08-21 06:00',
    ...over,
});

describe('parseAishubTime', () => {
    it('reads their UTC GMT-suffixed format', () => {
        expect(parseAishubTime(freshTime)).toBe(Date.parse('2026-08-21T03:15:07Z'));
    });

    it('rejects garbage', () => {
        expect(parseAishubTime('')).toBeNull();
        expect(parseAishubTime('not a time')).toBeNull();
        expect(parseAishubTime(42)).toBeNull();
    });
});

describe('parseAishubVessel', () => {
    it('maps a full row to the shared VesselRecord shape', () => {
        const record = parseAishubVessel(row(), NOW);
        expect(record).toMatchObject({
            mmsi: 503101240,
            lat: -27.1951,
            lon: 153.1056,
            cog: 123.4,
            sog: 6.5,
            heading: 124,
            nav_status: 0,
            name: 'WHISKERS',
            call_sign: 'MQ258Q',
            ship_type: 36,
            destination: 'NEWPORT',
            dimension_a: 8,
        });
        // IMO 0 = not available, never stored.
        expect(record?.imo_number).toBeUndefined();
    });

    it('drops rows whose TIME is history, not observation', () => {
        // The aggregate returns last-known state per vessel; a boat that went
        // quiet an hour ago must not be resurrected with a fresh updated_at.
        expect(parseAishubVessel(row({ TIME: staleTime }), NOW)).toBeNull();
    });

    it('omits sentinel motion values', () => {
        const record = parseAishubVessel(row({ COG: 360, SOG: 102.3, HEADING: 511 }), NOW);
        expect(record?.cog).toBeUndefined();
        expect(record?.sog).toBeUndefined();
        expect(record?.heading).toBeUndefined();
    });

    it('keeps static fields even when the position is Null Island', () => {
        const record = parseAishubVessel(row({ LATITUDE: 0, LONGITUDE: 0 }), NOW);
        expect(record?.lat).toBeUndefined();
        expect(record?.name).toBe('WHISKERS');
    });

    it('accepts numeric strings — their CSV heritage leaks into JSON', () => {
        const record = parseAishubVessel(row({ MMSI: '503101240', SOG: '6.5' }), NOW);
        expect(record?.mmsi).toBe(503101240);
        expect(record?.sog).toBe(6.5);
    });

    it('rejects invalid MMSIs', () => {
        expect(parseAishubVessel(row({ MMSI: 42 }), NOW)).toBeNull();
    });
});

describe('parseAishubResponse', () => {
    it('unwraps the two-element envelope', () => {
        const body = [{ ERROR: false, USERNAME: 'AH_TEST', FORMAT: 'HUMAN', RECORDS: 2 }, [row(), row({ MMSI: 42 })]];
        const parsed = parseAishubResponse(body, NOW);
        expect('records' in parsed && parsed.records).toHaveLength(1);
        expect('total' in parsed && parsed.total).toBe(2);
    });

    it('surfaces the error envelope', () => {
        const parsed = parseAishubResponse([{ ERROR: true, ERROR_MESSAGE: 'Wrong username' }], NOW);
        expect(parsed).toEqual({ error: 'Wrong username' });
    });

    it('rejects malformed bodies', () => {
        expect(parseAishubResponse('nope', NOW)).toEqual({ error: 'malformed envelope' });
        expect(parseAishubResponse([], NOW)).toEqual({ error: 'malformed envelope' });
    });
});

describe('startAishubPoller', () => {
    const fakeDb = () => {
        const enqueued: unknown[] = [];
        const db = { enqueue: (r: unknown) => enqueued.push(r) } as unknown as VesselDB;
        return { db, enqueued };
    };
    const okResponse = () =>
        ({
            ok: true,
            text: async () => JSON.stringify([{ ERROR: false, RECORDS: 1 }, [row({ TIME: new Date().toISOString() })]]),
        }) as unknown as Response;

    it("floors the cadence at AISHub's one-per-minute limit", async () => {
        vi.useFakeTimers();
        const { db } = fakeDb();
        const fetchImpl = vi.fn(async () => okResponse());
        const stop = startAishubPoller(db, {
            apiKey: 'AH_TEST',
            bounds: { latMin: -45, lonMin: 110, latMax: -8, lonMax: 157 },
            pollMs: 1_000, // demands a violation; the floor must refuse
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await vi.advanceTimersByTimeAsync(59_000);
        expect(fetchImpl).toHaveBeenCalledTimes(1); // only the immediate first poll
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        stop();
        vi.useRealTimers();
    });

    it("requests the worker's bounding box and enqueues accepted rows", async () => {
        const { db, enqueued } = fakeDb();
        let requested = '';
        const fetchImpl = vi.fn(async (url: string) => {
            requested = String(url);
            return okResponse();
        });
        const stop = startAishubPoller(db, {
            apiKey: 'AH_TEST',
            bounds: { latMin: -45, lonMin: 110, latMax: -8, lonMax: 157 },
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(requested).toContain('username=AH_TEST');
        expect(requested).toContain('latmin=-45');
        expect(requested).toContain('lonmax=157');
        expect(requested).toContain('output=json');
        expect(enqueued).toHaveLength(1);
        stop();
    });

    it('treats the documented rate-limit response (empty body) as a skip, not an error', async () => {
        const { db, enqueued } = fakeDb();
        const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => '' }) as unknown as Response);
        const stop = startAishubPoller(db, {
            apiKey: 'AH_TEST',
            bounds: { latMin: -45, lonMin: 110, latMax: -8, lonMax: 157 },
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(enqueued).toHaveLength(0);
        stop();
    });

    it('counts the LIVE rate-limit envelope as a ration, not a fault', async () => {
        // MEASURED against the real service 2026-09-02 with a live key: two
        // polls inside a minute answer HTTP 200 with a normal ERROR envelope
        // reading "Too frequent requests!", NOT the empty body the docs
        // describe. Counting that as a poll error made the ration look like
        // an outage in /health.
        const { db, enqueued } = fakeDb();
        const before = getAishubStats();
        const fetchImpl = vi.fn(
            async () =>
                ({
                    ok: true,
                    text: async () => JSON.stringify([{ ERROR: true, ERROR_MESSAGE: 'Too frequent requests!' }]),
                }) as unknown as Response,
        );
        const stop = startAishubPoller(db, {
            apiKey: 'AH_TEST',
            bounds: { latMin: -45, lonMin: 110, latMax: -8, lonMax: 157 },
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await new Promise((r) => setTimeout(r, 20));
        const after = getAishubStats();
        expect(enqueued).toHaveLength(0);
        expect(after.rateLimited).toBe(before.rateLimited + 1);
        expect(after.pollErrors).toBe(before.pollErrors);
        stop();
    });

    it('recognises the rate-limit message without over-matching real errors', () => {
        expect(isRateLimitMessage('Too frequent requests!')).toBe(true);
        expect(isRateLimitMessage('too frequent requests')).toBe(true);
        expect(isRateLimitMessage('Wrong username!')).toBe(false);
        expect(isRateLimitMessage('Invalid bounding box')).toBe(false);
    });

    it('sends the server-side freshness interval', async () => {
        const { db } = fakeDb();
        let requested = '';
        const fetchImpl = vi.fn(async (url: string) => {
            requested = String(url);
            return okResponse();
        });
        const stop = startAishubPoller(db, {
            apiKey: 'AH_TEST',
            bounds: { latMin: -45, lonMin: 110, latMax: -8, lonMax: 157 },
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(requested).toContain('interval=15');
        stop();
    });

    it('survives an API error and keeps its cadence', async () => {
        const { db, enqueued } = fakeDb();
        const fetchImpl = vi.fn(async () => {
            throw new Error('socket hangup');
        });
        const stop = startAishubPoller(db, {
            apiKey: 'AH_TEST',
            bounds: { latMin: -45, lonMin: 110, latMax: -8, lonMax: 157 },
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(enqueued).toHaveLength(0); // failed quietly, no throw escaped
        stop();
    });
});
