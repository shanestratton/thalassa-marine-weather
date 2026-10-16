/**
 * AISHub aggregate parsing — fixtures shaped from their documented
 * webservice response (output=json, format=1). The poller itself is
 * exercised through its rate-floor and single-flight seams.
 */
import { describe, expect, it } from 'vitest';
import { parseAishubResponse, parseAishubTime, parseAishubVessel } from './aishub.js';

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
