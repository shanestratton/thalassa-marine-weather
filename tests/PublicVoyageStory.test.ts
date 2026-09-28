import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PassageStats } from '../src/components/PassageStats';
import {
    formatDurationParts,
    formatNm,
    instrumentHeadline,
    isAutoDateTitle,
    labelSide,
    latestPublicTrackPoint,
    passageFacts,
    passageKeySummary,
    publicLastKnownLabel,
    splitWaypointName,
    stripTrackPrefix,
    tripSummary,
    usableTimeZone,
    waypointLabel,
    formatLocalDay,
    formatLocalMoment,
    isHiddenPublicWaypoint,
    type PassageStat,
} from '../src/components/voyageStory';
import { PUBLIC_POSITION_FRESH_MS, formatPublicAge, isPublicPositionFresh } from '../src/publicVoyageFreshness';
import type {
    PublicVoyageTrip,
    VoyageLogInstruments,
    VoyageLogTelemetry,
    VoyageLogTrackPoint,
} from '../src/voyageLogApi';

const NOW = Date.parse('2026-09-27T06:45:00.000Z');
const isoAtAge = (ageMs: number) => new Date(NOW - ageMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SHORT_DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

const point = (overrides: Partial<VoyageLogTrackPoint> = {}): VoyageLogTrackPoint => ({
    lat: -20.27,
    lon: 148.72,
    timestamp: '2026-09-26T01:16:23.420Z',
    voyage_id: 'voyage_a',
    speed_kts: null,
    course_deg: null,
    heading_deg: null,
    pressure: null,
    wind_speed_apparent: null,
    wind_angle_apparent: null,
    wind_speed_true: null,
    wind_direction_true: null,
    depth_m: null,
    air_temp: null,
    water_temp: null,
    wave_height: null,
    ...overrides,
});

const telemetry = (overrides: Partial<VoyageLogTelemetry> = {}): VoyageLogTelemetry => ({
    sog: null,
    cog: null,
    heading: null,
    baro: null,
    baro_trend: null,
    aws: null,
    awa: null,
    tws: null,
    twd: null,
    depth: null,
    air_temp: null,
    water_temp: null,
    wave_height: null,
    lat: -20.27,
    lon: 148.72,
    updated_at: isoAtAge(MIN),
    ...overrides,
});

const instruments = (overrides: Partial<VoyageLogInstruments> = {}): VoyageLogInstruments => ({
    updated_at: isoAtAge(30_000),
    source: 'pi',
    sog: null,
    cog: null,
    heading: null,
    stw: null,
    tws: null,
    twa: null,
    twd: null,
    aws: null,
    awa: null,
    depth: null,
    water_temp: null,
    baro: null,
    voltage: null,
    rpm: null,
    heel: null,
    pitch: null,
    rudder: null,
    ...overrides,
});

const trip = (overrides: Partial<PublicVoyageTrip> = {}): PublicVoyageTrip => ({
    id: 'voyage_a',
    kind: 'track',
    label: 'Track · 25 Sept 2026',
    started_at: '2026-09-25T22:42:58.380Z',
    ended_at: '2026-09-26T01:16:23.420Z',
    active: false,
    point_count: 912,
    distance_nm: 17.2,
    has_route: false,
    ...overrides,
});

// The live Serene Summer picker on 2026-09-27: seven shared tracks plus the
// permanent whole-journey entry (which carries no distance of its own).
const SERENE_TRIPS: PublicVoyageTrip[] = [
    trip(),
    trip({
        id: 'b',
        label: 'Track · 24 Sept 2026',
        started_at: '2026-09-24T22:54:49.292Z',
        ended_at: '2026-09-25T01:30:32.505Z',
        distance_nm: 10.8,
    }),
    trip({
        id: 'c',
        label: 'Track · 23 Sept 2026',
        started_at: '2026-09-23T22:43:34.560Z',
        ended_at: '2026-09-24T01:23:58.830Z',
        distance_nm: 15.6,
    }),
    trip({
        id: 'd',
        label: 'Track · 22 Sept 2026',
        started_at: '2026-09-22T23:30:39.680Z',
        ended_at: '2026-09-23T02:23:01.259Z',
        distance_nm: 17.9,
    }),
    trip({
        id: 'e',
        label: 'Track · 21 Sept 2026',
        started_at: '2026-09-21T05:57:21.910Z',
        ended_at: '2026-09-22T06:58:52.417Z',
        distance_nm: 57.9,
    }),
    trip({
        id: 'f',
        label: 'Track · 18 Sept 2026',
        started_at: '2026-09-18T10:38:31.356Z',
        ended_at: '2026-09-20T07:06:04.317Z',
        distance_nm: 230.1,
    }),
    trip({
        id: 'g',
        label: 'Track · 15 Sept 2026',
        started_at: '2026-09-15T02:28:41.640Z',
        ended_at: '2026-09-17T00:44:46.340Z',
        distance_nm: 306.4,
    }),
    trip({
        id: 'all-diary',
        kind: 'all-diary',
        label: 'All trips & diary',
        started_at: null,
        ended_at: null,
        point_count: 0,
        distance_nm: null,
    }),
];
const FIRST_SERENE_START = Date.parse('2026-09-15T02:28:41.640Z');

afterEach(cleanup);

describe('latestPublicTrackPoint', () => {
    it('returns undefined for an empty track', () => {
        expect(latestPublicTrackPoint([])).toBeUndefined();
    });

    it('keeps the newest fix by timestamp, not by array position', () => {
        const newest = point({ timestamp: '2026-09-26T01:16:23.420Z', lat: -20.3 });
        const older = point({ timestamp: '2026-09-25T22:42:58.380Z', lat: -20.1 });
        expect(latestPublicTrackPoint([newest, older])).toBe(newest);
        expect(latestPublicTrackPoint([older, newest])).toBe(newest);
    });

    it('prefers the later of two points sharing a timestamp', () => {
        const a = point({ lat: -20.1 });
        const b = point({ lat: -20.2 });
        expect(latestPublicTrackPoint([a, b])).toBe(b);
    });

    it('never treats a planned-route point as a sailed fix', () => {
        const sailed = point({ timestamp: '2026-09-26T01:00:00.000Z' });
        const planned = point({ timestamp: '2026-09-30T00:00:00.000Z', voyage_id: 'planned_route_1' });
        expect(latestPublicTrackPoint([sailed, planned])).toBe(sailed);
        expect(latestPublicTrackPoint([planned])).toBeUndefined();
    });

    it('keeps points with a null or missing voyage id', () => {
        const unscoped = point({ voyage_id: null });
        expect(latestPublicTrackPoint([unscoped])).toBe(unscoped);
        const missing = point();
        delete missing.voyage_id;
        expect(latestPublicTrackPoint([missing])).toBe(missing);
    });

    it.each([
        ['a NaN latitude', { lat: Number.NaN }],
        ['an infinite longitude', { lon: Number.POSITIVE_INFINITY }],
        ['a latitude beyond the pole', { lat: 90.0001 }],
        ['a longitude beyond the antimeridian', { lon: -180.0001 }],
        ['null island', { lat: 0, lon: 0 }],
        ['an unparsable timestamp', { timestamp: 'not-a-date' }],
    ])('skips %s even when it is the newest', (_label, overrides) => {
        const good = point({ timestamp: '2026-09-26T00:00:00.000Z' });
        const bad = point({ timestamp: '2026-09-27T00:00:00.000Z', ...overrides });
        expect(latestPublicTrackPoint([good, bad])).toBe(good);
    });

    it('accepts the exact globe limits and a fix on one zero axis', () => {
        const pole = point({ lat: 90, lon: 180, timestamp: '2026-09-26T00:00:00.000Z' });
        expect(latestPublicTrackPoint([pole])).toBe(pole);
        const equator = point({ lat: 0, lon: 148.7 });
        expect(latestPublicTrackPoint([equator])).toBe(equator);
    });
});

/** The formula MapContainer inlined before the move, kept as the oracle. */
function legacyMapLabel(
    latest: VoyageLogTrackPoint | undefined,
    t: VoyageLogTelemetry | null | undefined,
    connectionLost: boolean,
    nowMs: number,
): string | null {
    const telemetryFix = t && Number.isFinite(t.lat) && Number.isFinite(t.lon) ? [t.lon, t.lat] : undefined;
    const lastFix = latest ? [latest.lon, latest.lat] : telemetryFix;
    const lastFixUpdatedAt = t?.updated_at ?? latest?.timestamp ?? null;
    const positionIsLive =
        lastFix !== undefined &&
        !connectionLost &&
        t !== null &&
        t !== undefined &&
        !t.is_last_known &&
        isPublicPositionFresh(t.updated_at, nowMs);
    return lastFix && !positionIsLive ? `Last known · ${formatPublicAge(lastFixUpdatedAt, nowMs)}` : null;
}

describe('publicLastKnownLabel', () => {
    const latest = point({ timestamp: isoAtAge(DAY + HOUR) });

    it('is null when there is no fix at all', () => {
        expect(publicLastKnownLabel({ latest: undefined, telemetry: null, connectionLost: false, nowMs: NOW })).toBe(
            null,
        );
        expect(
            publicLastKnownLabel({
                latest: null,
                telemetry: telemetry({ lat: Number.NaN, updated_at: isoAtAge(DAY) }),
                connectionLost: true,
                nowMs: NOW,
            }),
        ).toBe(null);
    });

    it('is null while the fix is independently live', () => {
        expect(publicLastKnownLabel({ latest, telemetry: telemetry(), connectionLost: false, nowMs: NOW })).toBeNull();
    });

    it('labels a historic track with no telemetry by the track fix age', () => {
        expect(publicLastKnownLabel({ latest, telemetry: null, connectionLost: false, nowMs: NOW })).toBe(
            'Last known · 1 d ago',
        );
    });

    it('prefers the telemetry timestamp over the track timestamp for the age', () => {
        expect(
            publicLastKnownLabel({
                latest,
                telemetry: telemetry({ updated_at: isoAtAge(3 * HOUR), is_last_known: true }),
                connectionLost: false,
                nowMs: NOW,
            }),
        ).toBe('Last known · 3 h ago');
    });

    it('drops live styling when the connection is lost, even with a fresh fix', () => {
        expect(publicLastKnownLabel({ latest: null, telemetry: telemetry(), connectionLost: true, nowMs: NOW })).toBe(
            'Last known · just now',
        );
    });

    it('honours the server last-known fallback bit', () => {
        expect(
            publicLastKnownLabel({
                latest: undefined,
                telemetry: telemetry({ is_last_known: true, updated_at: isoAtAge(5 * MIN) }),
                connectionLost: false,
                nowMs: NOW,
            }),
        ).toBe('Last known · 5 min ago');
    });

    it('expires a fix at the ten-minute freshness bound on its own clock', () => {
        const t = telemetry({ updated_at: isoAtAge(PUBLIC_POSITION_FRESH_MS - 1) });
        expect(publicLastKnownLabel({ latest: null, telemetry: t, connectionLost: false, nowMs: NOW })).toBeNull();
        expect(publicLastKnownLabel({ latest: null, telemetry: t, connectionLost: false, nowMs: NOW + 1 })).toBe(
            'Last known · 10 min ago',
        );
    });

    it('says unknown rather than inventing an age for an unparsable timestamp', () => {
        expect(
            publicLastKnownLabel({
                latest: null,
                telemetry: telemetry({ updated_at: 'garbage' }),
                connectionLost: false,
                nowMs: NOW,
            }),
        ).toBe('Last known · unknown');
    });

    it('matches the string MapContainer built before the move, case by case', () => {
        const latestOptions: (VoyageLogTrackPoint | undefined)[] = [undefined, latest, point({ timestamp: 'bad' })];
        const telemetryOptions: (VoyageLogTelemetry | null | undefined)[] = [
            undefined,
            null,
            telemetry(),
            telemetry({ is_last_known: true }),
            telemetry({ updated_at: isoAtAge(2 * HOUR) }),
            telemetry({ lat: Number.NaN }),
            telemetry({ updated_at: new Date(NOW + 5 * MIN).toISOString() }),
        ];
        for (const l of latestOptions) {
            for (const t of telemetryOptions) {
                for (const connectionLost of [false, true]) {
                    expect(publicLastKnownLabel({ latest: l, telemetry: t, connectionLost, nowMs: NOW })).toBe(
                        legacyMapLabel(l, t, connectionLost, NOW),
                    );
                }
            }
        }
    });
});

describe('instrumentHeadline', () => {
    it('is null without instruments', () => {
        expect(instrumentHeadline(null, NOW)).toBeNull();
        expect(instrumentHeadline(undefined, NOW)).toBeNull();
    });

    it('is null when no reading other than the three-hour pressure delta is finite', () => {
        expect(instrumentHeadline(instruments(), NOW)).toBeNull();
        expect(instrumentHeadline(instruments({ pressure_3h: -1.2 }), NOW)).toBeNull();
        expect(instrumentHeadline(instruments({ depth: Number.NaN, sog: Number.POSITIVE_INFINITY }), NOW)).toBeNull();
    });

    it('reports live with its age when a reading is fresh', () => {
        expect(instrumentHeadline(instruments({ depth: 4.2 }), NOW)).toEqual({ live: true, age: 'just now' });
    });

    it('counts zero as a real reading', () => {
        expect(instrumentHeadline(instruments({ sog: 0 }), NOW)).toEqual({ live: true, age: 'just now' });
    });

    it('counts optional sensor fields like the house battery', () => {
        expect(instrumentHeadline(instruments({ house_battery_soc: 88 }), NOW)?.live).toBe(true);
    });

    it('reports stale snapshots as not live, with their age', () => {
        expect(instrumentHeadline(instruments({ heading: 313, updated_at: isoAtAge(25 * MIN) }), NOW)).toEqual({
            live: false,
            age: '25 min ago',
        });
        expect(
            instrumentHeadline(instruments({ heading: 313, updated_at: isoAtAge(PUBLIC_POSITION_FRESH_MS) }), NOW)
                ?.live,
        ).toBe(false);
    });

    it('never banks future freshness from an unparsable or far-future stamp', () => {
        expect(instrumentHeadline(instruments({ heading: 313, updated_at: 'nope' }), NOW)).toEqual({
            live: false,
            age: 'unknown',
        });
        expect(
            instrumentHeadline(instruments({ heading: 313, updated_at: new Date(NOW + 10 * MIN).toISOString() }), NOW),
        ).toEqual({ live: false, age: 'unknown' });
    });
});

describe('stripTrackPrefix', () => {
    it('drops the leading track prefix for the chip face', () => {
        expect(stripTrackPrefix('Track · 25 Sept 2026 · 17.2 nm')).toBe('25 Sept 2026 · 17.2 nm');
    });

    it('leaves other labels alone, including a prefix that is not leading', () => {
        expect(stripTrackPrefix('All trips & diary')).toBe('All trips & diary');
        expect(stripTrackPrefix('Passage · Track · 3')).toBe('Passage · Track · 3');
        expect(stripTrackPrefix('Tracking north')).toBe('Tracking north');
    });

    it('strips only once', () => {
        expect(stripTrackPrefix('Track · Track · x')).toBe('Track · x');
    });
});

describe('splitWaypointName', () => {
    it('splits a server qualifier onto its own line', () => {
        expect(splitWaypointName('Hamilton Island · recovered departure')).toEqual({
            place: 'Hamilton Island',
            role: 'recovered departure',
        });
    });

    it('splits on the FIRST separator only', () => {
        expect(splitWaypointName('Airlie Beach · recovered arrival · 2')).toEqual({
            place: 'Airlie Beach',
            role: 'recovered arrival · 2',
        });
    });

    it('keeps plain names whole', () => {
        expect(splitWaypointName('Voyage Start')).toEqual({ place: 'Voyage Start', role: null });
        expect(splitWaypointName('Channel entrance')).toEqual({ place: 'Channel entrance', role: null });
        expect(splitWaypointName('Hook·Island')).toEqual({ place: 'Hook·Island', role: null });
    });

    it('never produces an empty place or role line', () => {
        expect(splitWaypointName('Hamilton Island · ')).toEqual({ place: 'Hamilton Island', role: null });
        expect(splitWaypointName(' · recovered departure')).toEqual({ place: '· recovered departure', role: null });
    });
});

// Boat-local time. Every fixture below is a UTC evening, where the old
// UTC-built picker labels showed the day before. 'en-AU' pins the words and
// a Brisbane reader pins 'is this the reader's clock?' (CI runs in UTC); the
// page itself leaves both to the viewer, as the diary does.
const BRISBANE = 'Australia/Brisbane';
const AU = { locale: 'en-AU', nowMs: NOW, viewerTimeZone: BRISBANE } as const;

describe('formatLocalDay / formatLocalMoment', () => {
    it('builds the day in the given zone, never UTC', () => {
        expect(formatLocalDay('2026-09-25T22:42:58.38+00:00', BRISBANE, AU)).toMatch(/^Sat 26 Sept?$/);
        expect(formatLocalDay('2026-09-25T22:42:58.38+00:00', 'UTC', AU)).toMatch(/^Fri 25 Sept?$/);
        expect(formatLocalMoment('2026-09-25T22:42:58.38+00:00', BRISBANE, AU)).toMatch(/^Sat 26 Sept? · 08:42$/);
        expect(formatLocalMoment('2026-09-25T14:05:00Z', BRISBANE, AU)).toMatch(/^Sat 26 Sept? · 00:05$/);
    });

    it('falls back to the given zone, then to the viewer zone the diary uses', () => {
        const iso = '2026-09-22T23:30:39.68+00:00';
        expect(formatLocalDay(iso, null, { ...AU, fallbackZone: BRISBANE })).toMatch(/^Wed 23 Sept?$/);
        expect(formatLocalDay(iso, 'Not/AZone', { ...AU, fallbackZone: BRISBANE })).toMatch(/^Wed 23 Sept?$/);
        const viewer = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
            .format(Date.parse(iso))
            .replace(/,/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        expect(formatLocalDay(iso, undefined, AU)).toBe(viewer);
    });

    it("names the zone only when it is not the reader's clock at that moment", () => {
        const iso = '2026-09-25T22:42:58.38+00:00';
        // A Los Angeles reader sees 15:42 on their own clock: say whose 08:42 it is.
        expect(formatLocalMoment(iso, BRISBANE, { ...AU, viewerTimeZone: 'America/Los_Angeles' })).toMatch(
            /^Sat 26 Sept? · 08:42 AEST$/,
        );
        expect(formatLocalMoment(iso, BRISBANE, { ...AU, viewerTimeZone: 'UTC' })).toMatch(/ · 08:42 AEST$/);
        // Sydney keeps Brisbane's clock until daylight saving starts on 4 Oct.
        expect(formatLocalMoment(iso, BRISBANE, { ...AU, viewerTimeZone: 'Australia/Sydney' })).toMatch(
            /^Sat 26 Sept? · 08:42$/,
        );
        expect(
            formatLocalMoment('2026-10-10T22:42:58Z', BRISBANE, { ...AU, viewerTimeZone: 'Australia/Sydney' }),
        ).toMatch(/^Sun 11 Oct · 08:42 AEST$/);
        // No zone at all is the reader's own clock: nothing to name.
        expect(formatLocalMoment(iso, null, { locale: 'en-AU', nowMs: NOW })).toMatch(/\d$/);
    });

    it('drops the weekday for a tile when asked', () => {
        expect(formatLocalDay('2026-09-14T20:00:00Z', BRISBANE, { ...AU, weekday: false })).toMatch(/^15 Sept?$/);
        expect(formatLocalDay('2025-09-14T20:00:00Z', BRISBANE, { ...AU, weekday: false })).toMatch(/^15 Sept? 2025$/);
    });

    it('adds the year only outside this year, and refuses unusable input', () => {
        expect(formatLocalDay('2025-12-31T20:00:00Z', BRISBANE, AU)).toBe('Thu 1 Jan');
        expect(formatLocalDay('2025-12-30T20:00:00Z', BRISBANE, AU)).toMatch(/^Wed 31 Dec 2025$/);
        expect(formatLocalDay(null, BRISBANE, AU)).toBeNull();
        expect(formatLocalDay('not a date', BRISBANE, AU)).toBeNull();
        expect(formatLocalMoment('', BRISBANE, AU)).toBeNull();
    });

    it('accepts only zones Intl knows', () => {
        expect(usableTimeZone(BRISBANE)).toBe(BRISBANE);
        expect(usableTimeZone(' Australia/Brisbane ')).toBe(BRISBANE);
        expect(usableTimeZone('Mars/Olympus_Mons')).toBeUndefined();
        expect(usableTimeZone('')).toBeUndefined();
        expect(usableTimeZone(null)).toBeUndefined();
    });
});

describe('waypointLabel', () => {
    it('turns a recovered departure into Departed, in the waypoint zone', () => {
        expect(
            waypointLabel(
                {
                    name: 'Hamilton Island · recovered departure',
                    timestamp: '2026-09-25T22:42:58.38+00:00',
                    time_zone: BRISBANE,
                },
                AU,
            ),
        ).toEqual({ place: 'Hamilton Island', role: expect.stringMatching(/^Departed Sat 26 Sept? · 08:42$/) });
    });

    it('turns a recovered arrival into Arrived', () => {
        expect(
            waypointLabel(
                {
                    name: 'Airlie Beach · recovered arrival',
                    timestamp: '2026-09-26T01:16:23.42+00:00',
                    time_zone: BRISBANE,
                },
                AU,
            ),
        ).toEqual({ place: 'Airlie Beach', role: expect.stringMatching(/^Arrived Sat 26 Sept? · 11:16$/) });
    });

    it('uses the page zone when the waypoint has none (an older server)', () => {
        expect(
            waypointLabel(
                { name: 'Tongue Bay · recovered departure', timestamp: '2026-09-22T23:30:39.68+00:00' },
                { ...AU, fallbackZone: BRISBANE },
            ),
        ).toEqual({ place: 'Tongue Bay', role: expect.stringMatching(/^Departed Wed 23 Sept? · 09:30$/) });
        expect(
            waypointLabel(
                {
                    name: 'Butterfly Bay · Recovered Departure',
                    timestamp: '2026-09-23T22:43:34.56+00:00',
                    time_zone: 'Mars/Olympus_Mons',
                },
                { ...AU, fallbackZone: BRISBANE },
            ),
        ).toEqual({ place: 'Butterfly Bay', role: expect.stringMatching(/^Departed Thu 24 Sept? · 08:43$/) });
    });

    it('says Departed alone when the time is unusable', () => {
        expect(waypointLabel({ name: 'Newport · recovered departure', timestamp: 'garbage' }, AU)).toEqual({
            place: 'Newport',
            role: 'Departed',
        });
    });

    it("reads the 15 Sep recovery's first fix as Departed, inventing no place", () => {
        expect(
            waypointLabel(
                {
                    name: 'Recovered GPS track · Newport to Gladstone',
                    timestamp: '2026-09-15T02:28:41.64+00:00',
                    time_zone: BRISBANE,
                },
                AU,
            ),
        ).toEqual({ place: 'Departed', role: expect.stringMatching(/^Tue 15 Sept? · 12:28$/) });
        expect(waypointLabel({ name: 'Recovered GPS track', timestamp: 'garbage' }, AU)).toEqual({
            place: 'Departed',
            role: null,
        });
    });

    it('hides the bookkeeping pins, and only those', () => {
        expect(isHiddenPublicWaypoint('App recording began · original mark')).toBe(true);
        expect(isHiddenPublicWaypoint('  app recording began ·  original mark ')).toBe(true);
        expect(isHiddenPublicWaypoint('Latest Position')).toBe(true);
        for (const name of [
            'Voyage Start',
            'Voyage End',
            'Hamilton Island · recovered departure',
            'Recovered GPS track · Newport to Gladstone',
            'App recording began',
        ]) {
            expect(isHiddenPublicWaypoint(name)).toBe(false);
        }
    });

    it('leaves Voyage Start, Voyage End and every other name exactly as before', () => {
        const at = { timestamp: '2026-09-18T10:38:31.356+00:00', time_zone: BRISBANE };
        for (const name of [
            'Voyage Start',
            'Voyage End',
            'App recording began · original mark',
            'Airlie Beach · recovered arrival · 2',
            ' · recovered departure',
            'Channel entrance',
        ]) {
            expect(waypointLabel({ name, ...at }, AU)).toEqual(splitWaypointName(name));
        }
    });
});

describe('tripSummary', () => {
    const base: PublicVoyageTrip = {
        id: 'trip',
        kind: 'track',
        label: 'Track · 25 Sept 2026',
        started_at: '2026-09-25T22:42:58.38+00:00',
        ended_at: '2026-09-26T01:16:23.42+00:00',
        active: false,
        point_count: 912,
        distance_nm: 17.2,
        has_route: false,
    };

    it('names both ends and dates the trip where it started', () => {
        const summary = tripSummary(
            { ...base, from_name: 'Hamilton Island', to_name: 'Airlie Beach', time_zone: BRISBANE },
            AU,
        );
        expect(summary).toMatchObject({
            from: 'Hamilton Island',
            to: 'Airlie Beach',
            headline: 'Hamilton Island → Airlie Beach',
            spokenHeadline: 'Hamilton Island to Airlie Beach',
            named: true,
            distance: '17.2 nm',
        });
        expect(summary.date).toMatch(/^Sat 26 Sept?$/);
    });

    it.each([
        // 'From', never 'Departed': started_at is when tracking began.
        [{ from_name: 'Mackay Harbour', to_name: null }, 'From Mackay Harbour', true],
        [{ from_name: null, to_name: 'Callemondah' }, 'To Callemondah', true],
        [{ from_name: '  ', to_name: '' }, null, false],
        [{ from_name: null, to_name: null }, null, false],
        [{}, null, false],
    ])('falls back gracefully for %j', (fields, headline, named) => {
        const summary = tripSummary({ ...base, ...fields, time_zone: BRISBANE }, AU);
        expect(summary.named).toBe(named);
        if (headline) expect(summary.headline).toBe(headline);
        else expect(summary.headline).toMatch(/^Sat 26 Sept?$/);
        expect(summary.spokenHeadline).toBe(summary.headline);
    });

    it('treats missing time_zone like null and keeps the UTC label only as a last resort', () => {
        expect(tripSummary(base, { ...AU, fallbackZone: BRISBANE }).headline).toMatch(/^Sat 26 Sept?$/);
        expect(tripSummary({ ...base, started_at: null }, AU).headline).toBe('25 Sept 2026');
        expect(tripSummary({ ...base, started_at: null, label: '' }, AU).headline).toBe('Trip');
        expect(tripSummary({ ...base, distance_nm: 306.4 }, AU).distance).toBe('306 nm');
        expect(tripSummary({ ...base, distance_nm: 0 }, AU).distance).toBeNull();
    });
});

describe('isAutoDateTitle', () => {
    it.each([
        'Tuesday 22 September 2026 · 09:15',
        'Monday 1 June 2026 · 7:05',
        'Wednesday 23 September 2026 · 18:40',
        'Thursday 24 September 2026 · 06:00',
        'Friday 25 September 2026 · 23:59',
        'Saturday 26 September 2026 · 12:00',
        'Sunday 27 September 2026 · 00:00',
        '  Sunday 27 September 2026 · 00:00  ',
    ])('recognises the app auto title %j', (title) => {
        expect(isAutoDateTitle(title)).toBe(true);
    });

    it.each([
        'Daydreaming, Cold Beers & a Netflix Emergency',
        'Tuesday at Hamilton Island',
        'Tuesday 22 September 2026',
        'Tuesday 22 September 2026 · 09:15 · Airlie',
        'Tuesday 22 Sept 2026 09:15',
        'tuesday 22 September 2026 · 09:15',
        'Funday 22 September 2026 · 09:15',
        '22 September 2026 · 09:15',
        '',
    ])('leaves the written title %j alone', (title) => {
        expect(isAutoDateTitle(title)).toBe(false);
    });
});

describe('labelSide', () => {
    const frame = { width: 1000, height: 800 };

    it('defaults to below without a projected point or frame', () => {
        expect(labelSide(null, frame)).toBe('below');
        expect(labelSide({ x: 5, y: 5 }, null)).toBe('below');
        expect(labelSide(null, null)).toBe('below');
    });

    it('flips toward the middle near the left and right edges', () => {
        expect(labelSide({ x: 119, y: 400 }, frame)).toBe('right');
        expect(labelSide({ x: 120, y: 400 }, frame)).toBe('below');
        expect(labelSide({ x: 880, y: 400 }, frame)).toBe('below');
        expect(labelSide({ x: 881, y: 400 }, frame)).toBe('left');
    });

    it('lifts above near the bottom edge', () => {
        expect(labelSide({ x: 500, y: 704 }, frame)).toBe('below');
        expect(labelSide({ x: 500, y: 705 }, frame)).toBe('above');
    });

    it('lets the side edges win over the bottom edge', () => {
        expect(labelSide({ x: 10, y: 790 }, frame)).toBe('right');
        expect(labelSide({ x: 990, y: 790 }, frame)).toBe('left');
    });

    it('honours a custom room', () => {
        expect(labelSide({ x: 50, y: 400 }, frame, 40)).toBe('below');
        expect(labelSide({ x: 39, y: 400 }, frame, 40)).toBe('right');
    });

    it('accepts a frame that carries extra fields such as zoom', () => {
        const labelFrame = { width: 390, height: 844, zoom: 11 };
        expect(labelSide({ x: 300, y: 400 }, labelFrame)).toBe('left');
    });
});

describe('formatDurationParts', () => {
    it('is null for non-finite or sub-minute spans', () => {
        expect(formatDurationParts(Number.NaN)).toBeNull();
        expect(formatDurationParts(Number.POSITIVE_INFINITY)).toBeNull();
        expect(formatDurationParts(-HOUR)).toBeNull();
        expect(formatDurationParts(0)).toBeNull();
        expect(formatDurationParts(59_999)).toBeNull();
    });

    it('shows minutes only under an hour', () => {
        expect(formatDurationParts(MIN)).toEqual([{ value: '1', unit: 'm' }]);
        expect(formatDurationParts(HOUR - 1)).toEqual([{ value: '59', unit: 'm' }]);
    });

    it('shows hours and minutes under 48 hours, dropping zero minutes', () => {
        expect(formatDurationParts(HOUR)).toEqual([{ value: '1', unit: 'h' }]);
        expect(formatDurationParts(2 * HOUR + 33 * MIN + 25_000)).toEqual([
            { value: '2', unit: 'h' },
            { value: '33', unit: 'm' },
        ]);
        expect(formatDurationParts(25 * HOUR + MIN)).toEqual([
            { value: '25', unit: 'h' },
            { value: '1', unit: 'm' },
        ]);
        expect(formatDurationParts(48 * HOUR - 1)).toEqual([
            { value: '47', unit: 'h' },
            { value: '59', unit: 'm' },
        ]);
    });

    it('shows days and hours from 48 hours, dropping zero hours', () => {
        expect(formatDurationParts(48 * HOUR)).toEqual([{ value: '2', unit: 'd' }]);
        expect(formatDurationParts(3 * DAY + 4 * HOUR + 59 * MIN)).toEqual([
            { value: '3', unit: 'd' },
            { value: '4', unit: 'h' },
        ]);
        expect(formatDurationParts(14 * DAY)).toEqual([{ value: '14', unit: 'd' }]);
    });
});

describe('formatNm', () => {
    it('keeps one decimal under 100 nm', () => {
        expect(formatNm(0)).toBe('0.0');
        expect(formatNm(17.2)).toBe('17.2');
        expect(formatNm(10.84)).toBe('10.8');
        expect(formatNm(99.94)).toBe('99.9');
    });

    it('rounds to whole, locale-grouped miles from 100 nm', () => {
        expect(formatNm(100)).toBe('100');
        expect(formatNm(655.9)).toBe('656');
        expect(formatNm(1234.4)).toBe((1234).toLocaleString());
    });
});

describe('passageFacts', () => {
    const latestTrip = SERENE_TRIPS[0];

    it('reproduces the Serene Summer latest-trip tiles', () => {
        const stats = passageFacts({
            trip: latestTrip,
            trips: SERENE_TRIPS,
            nowMs: NOW,
            journey: false,
            entryCount: 0,
        });
        expect(stats).toEqual<PassageStat[]>([
            { key: 'distance', label: 'Distance', parts: [{ value: '17.2', unit: 'nm' }] },
            {
                key: 'elapsed',
                label: 'Start to finish',
                parts: [
                    { value: '2', unit: 'h' },
                    { value: '33', unit: 'm' },
                ],
            },
            {
                key: 'journey',
                label: 'Whole journey',
                parts: [{ value: '656', unit: 'nm' }],
                note: `7 tracks · since ${SHORT_DAY_MONTH.format(FIRST_SERENE_START)}`,
            },
        ]);
    });

    it('reproduces the Serene Summer whole-journey tiles', () => {
        const stats = passageFacts({ trip: null, trips: SERENE_TRIPS, nowMs: NOW, journey: true, entryCount: 12 });
        expect(stats).toEqual<PassageStat[]>([
            { key: 'distance', label: 'Distance', parts: [{ value: '656', unit: 'nm' }], note: '7 shared tracks' },
            { key: 'first', label: 'First track', parts: [{ value: SHORT_DAY_MONTH.format(FIRST_SERENE_START) }] },
            { key: 'stories', label: 'Stories', parts: [{ value: '12' }] },
        ]);
    });

    it("dates the first track in its own zone, like the picker's card", () => {
        // 00:30 on 16 Sep in Nouméa is still the 15th in Brisbane and in UTC.
        const first = trip({ id: 'g', started_at: '2026-09-15T13:30:00Z', time_zone: 'Pacific/Noumea' });
        const trips = [SERENE_TRIPS[0], first];
        const expected = new Intl.DateTimeFormat(undefined, {
            day: 'numeric',
            month: 'short',
            timeZone: 'Pacific/Noumea',
        }).format(Date.parse(first.started_at!));
        expect(expected).toMatch(/16/);
        expect(passageFacts({ trip: null, trips, nowMs: NOW, journey: true, entryCount: 0 })[1]).toEqual({
            key: 'first',
            label: 'First track',
            parts: [{ value: expected }],
        });
        expect(
            passageFacts({ trip: SERENE_TRIPS[0], trips, nowMs: NOW, journey: false, entryCount: 0 }).find(
                (s) => s.key === 'journey',
            )?.note,
        ).toBe(`2 tracks · since ${expected}`);
    });

    it('uses journey mode whenever journey is set, even if a trip is passed', () => {
        const stats = passageFacts({ trip: latestTrip, trips: SERENE_TRIPS, nowMs: NOW, journey: true, entryCount: 0 });
        expect(stats.map((s) => s.key)).toEqual(['distance', 'first']);
    });

    it('returns no tiles in trip mode without a trip', () => {
        expect(passageFacts({ trip: null, trips: SERENE_TRIPS, nowMs: NOW, journey: false, entryCount: 3 })).toEqual(
            [],
        );
    });

    it('says "Time so far" on an active trip, measured to now', () => {
        const active = trip({
            started_at: new Date(NOW - 3 * HOUR - 5 * MIN).toISOString(),
            ended_at: null,
            active: true,
        });
        const stats = passageFacts({ trip: active, trips: [active], nowMs: NOW, journey: false, entryCount: 0 });
        expect(stats.find((s) => s.key === 'elapsed')).toEqual({
            key: 'elapsed',
            label: 'Time so far',
            parts: [
                { value: '3', unit: 'h' },
                { value: '5', unit: 'm' },
            ],
        });
    });

    it('omits elapsed time for an unfinished trip that is no longer active', () => {
        const stalled = trip({ ended_at: null, active: false });
        const stats = passageFacts({ trip: stalled, trips: [stalled], nowMs: NOW, journey: false, entryCount: 0 });
        expect(stats.map((s) => s.key)).toEqual(['distance']);
    });

    it('omits elapsed time for missing or unparsable timestamps and sub-minute spans', () => {
        const cases = [
            trip({ started_at: null }),
            trip({ started_at: 'not-a-date' }),
            trip({ ended_at: 'not-a-date' }),
            trip({ started_at: '2026-09-25T22:42:58.000Z', ended_at: '2026-09-25T22:43:30.000Z' }),
            trip({ started_at: '2026-09-26T01:00:00.000Z', ended_at: '2026-09-25T01:00:00.000Z' }),
        ];
        for (const t of cases) {
            const keys = passageFacts({ trip: t, trips: [t], nowMs: NOW, journey: false, entryCount: 0 }).map(
                (s) => s.key,
            );
            expect(keys).not.toContain('elapsed');
        }
    });

    it('never shows zero or missing distance placeholders', () => {
        for (const distance_nm of [null, 0, -3, Number.NaN]) {
            const t = trip({ distance_nm });
            const stats = passageFacts({ trip: t, trips: [t], nowMs: NOW, journey: false, entryCount: 0 });
            expect(stats.map((s) => s.key)).toEqual(['elapsed']);
            expect(passageFacts({ trip: null, trips: [t], nowMs: NOW, journey: true, entryCount: 0 })).toEqual([
                {
                    key: 'first',
                    label: 'First track',
                    parts: [{ value: SHORT_DAY_MONTH.format(Date.parse(t.started_at!)) }],
                },
            ]);
        }
    });

    it('shows the whole journey tile only with at least two tracks and some distance', () => {
        const one = [latestTrip, SERENE_TRIPS[7]];
        expect(
            passageFacts({ trip: latestTrip, trips: one, nowMs: NOW, journey: false, entryCount: 0 }).map((s) => s.key),
        ).toEqual(['distance', 'elapsed']);

        const noDistance = [trip({ distance_nm: null }), trip({ id: 'b', distance_nm: 0 })];
        expect(
            passageFacts({ trip: noDistance[0], trips: noDistance, nowMs: NOW, journey: false, entryCount: 0 }).map(
                (s) => s.key,
            ),
        ).toEqual(['elapsed']);
    });

    it('sums only positive track distances and ignores the all-diary entry', () => {
        const trips = [
            trip({ distance_nm: 12.5 }),
            trip({ id: 'b', distance_nm: -4 }),
            trip({ id: 'c', distance_nm: null }),
            trip({ id: 'd', distance_nm: 7.5 }),
            trip({ id: 'all-diary', kind: 'all-diary', distance_nm: 999, started_at: '2020-01-01T00:00:00.000Z' }),
        ];
        const stats = passageFacts({ trip: null, trips, nowMs: NOW, journey: true, entryCount: 0 });
        expect(stats[0]).toEqual({
            key: 'distance',
            label: 'Distance',
            parts: [{ value: '20.0', unit: 'nm' }],
            note: '4 shared tracks',
        });
        // The all-diary entry's start never counts as the first track.
        expect(stats[1].parts[0].value).toBe(SHORT_DAY_MONTH.format(Date.parse(trips[0].started_at!)));
    });

    it('uses the singular for one shared track', () => {
        const stats = passageFacts({ trip: null, trips: [latestTrip], nowMs: NOW, journey: true, entryCount: 1 });
        expect(stats[0].note).toBe('1 shared track');
        expect(stats[2]).toEqual({ key: 'stories', label: 'Stories', parts: [{ value: '1' }] });
    });

    it('picks the earliest parsable start as the first track', () => {
        const trips = [
            trip({ started_at: '2026-09-20T00:00:00.000Z' }),
            trip({ id: 'b', started_at: 'garbage' }),
            trip({ id: 'c', started_at: null }),
            trip({ id: 'd', started_at: '2026-09-10T00:00:00.000Z' }),
        ];
        const stats = passageFacts({ trip: null, trips, nowMs: NOW, journey: true, entryCount: 0 });
        expect(stats.find((s) => s.key === 'first')?.parts).toEqual([
            { value: SHORT_DAY_MONTH.format(Date.parse('2026-09-10T00:00:00.000Z')) },
        ]);
    });

    it('drops the "since" clause when no track start parses', () => {
        const trips = [trip({ started_at: null, ended_at: null }), trip({ id: 'b', started_at: null, ended_at: null })];
        const stats = passageFacts({ trip: trips[0], trips, nowMs: NOW, journey: false, entryCount: 0 });
        expect(stats.find((s) => s.key === 'journey')?.note).toBe('2 tracks');
    });

    it('returns nothing for an empty journey', () => {
        expect(passageFacts({ trip: null, trips: [], nowMs: NOW, journey: true, entryCount: 0 })).toEqual([]);
    });

    it('never offers an average speed', () => {
        const all = [
            ...passageFacts({ trip: latestTrip, trips: SERENE_TRIPS, nowMs: NOW, journey: false, entryCount: 4 }),
            ...passageFacts({ trip: null, trips: SERENE_TRIPS, nowMs: NOW, journey: true, entryCount: 4 }),
        ];
        expect(all.some((s) => /speed|kt|average/i.test(`${s.label} ${s.note ?? ''}`))).toBe(false);
    });
});

describe('passageKeySummary', () => {
    it('summarises an ended trip with its start-to-finish time', () => {
        expect(passageKeySummary({ trip: SERENE_TRIPS[0], trips: SERENE_TRIPS, journey: false })).toBe(
            '17.2 nm · 2 h 33 m',
        );
        expect(passageKeySummary({ trip: SERENE_TRIPS[6], trips: SERENE_TRIPS, journey: false })).toBe(
            '306 nm · 46 h 16 m',
        );
    });

    it('says "so far" on an unfinished trip and never reads the clock', () => {
        const active = trip({ ended_at: null, active: true, distance_nm: 4.12 });
        expect(passageKeySummary({ trip: active, trips: [active], journey: false })).toBe('4.1 nm so far');
    });

    it('falls back to distance alone when the duration is unusable', () => {
        expect(passageKeySummary({ trip: trip({ started_at: null }), trips: [], journey: false })).toBe('17.2 nm');
        expect(passageKeySummary({ trip: trip({ ended_at: 'garbage' }), trips: [], journey: false })).toBe('17.2 nm');
    });

    it('is null for a trip without distance, or no trip', () => {
        expect(passageKeySummary({ trip: trip({ distance_nm: null }), trips: [], journey: false })).toBeNull();
        expect(passageKeySummary({ trip: trip({ distance_nm: 0 }), trips: [], journey: false })).toBeNull();
        expect(passageKeySummary({ trip: null, trips: SERENE_TRIPS, journey: false })).toBeNull();
    });

    it('summarises the whole journey', () => {
        expect(passageKeySummary({ trip: null, trips: SERENE_TRIPS, journey: true })).toBe('656 nm · 7 tracks');
        expect(passageKeySummary({ trip: null, trips: [SERENE_TRIPS[0]], journey: true })).toBe('17.2 nm · 1 track');
    });

    it('is null for a journey with no distance', () => {
        expect(passageKeySummary({ trip: null, trips: [], journey: true })).toBeNull();
        expect(passageKeySummary({ trip: null, trips: [trip({ distance_nm: null })], journey: true })).toBeNull();
    });

    it('lets journey mode win over a passed trip', () => {
        expect(passageKeySummary({ trip: SERENE_TRIPS[0], trips: SERENE_TRIPS, journey: true })).toBe(
            '656 nm · 7 tracks',
        );
    });
});

describe('PassageStats', () => {
    const stats: PassageStat[] = [
        { key: 'distance', label: 'Distance', parts: [{ value: '17.2', unit: 'nm' }] },
        {
            key: 'elapsed',
            label: 'Start to finish',
            parts: [
                { value: '2', unit: 'h' },
                { value: '33', unit: 'm' },
            ],
        },
        {
            key: 'journey',
            label: 'Whole journey',
            parts: [{ value: '656', unit: 'nm' }],
            note: '7 tracks · since 15 Sep',
        },
        { key: 'stories', label: 'Stories', parts: [{ value: '12' }] },
    ];

    it('renders nothing for an empty list', () => {
        const { container } = render(React.createElement(PassageStats, { stats: [] }));
        expect(container.innerHTML).toBe('');
    });

    it('renders a labelled description list of tiles with units and notes', () => {
        render(React.createElement(PassageStats, { stats, label: 'This trip', className: 'grid gap-2 lg:hidden' }));
        const list = screen.getByLabelText('This trip');
        expect(list.tagName).toBe('DL');
        expect(list.className).toBe('pv-stats grid gap-2 lg:hidden');

        const tiles = Array.from(list.querySelectorAll(':scope > .pv-stat'));
        expect(tiles.map((tile) => tile.getAttribute('data-key'))).toEqual([
            'distance',
            'elapsed',
            'journey',
            'stories',
        ]);

        const distance = within(tiles[0] as HTMLElement);
        expect(distance.getByText('Distance').tagName).toBe('DT');
        const value = tiles[0].querySelector('dd.pv-stat__value.pv-num')!;
        expect(value.textContent).toBe('17.2nm');
        expect(value.querySelector('.pv-stat__unit')?.textContent).toBe('nm');

        expect(tiles[1].querySelector('.pv-stat__value')!.textContent).toBe('2h 33m');
        expect(tiles[1].querySelectorAll('.pv-stat__unit')).toHaveLength(2);

        const note = tiles[2].querySelector('dd.pv-stat__note');
        expect(note?.textContent).toBe('7 tracks · since 15 Sep');
        expect(tiles[0].querySelector('.pv-stat__note')).toBeNull();

        expect(tiles[3].querySelector('.pv-stat__value')!.textContent).toBe('12');
        expect(tiles[3].querySelector('.pv-stat__unit')).toBeNull();
    });

    it('defaults its accessible name and adds no layout classes of its own', () => {
        render(React.createElement(PassageStats, { stats: stats.slice(0, 1) }));
        const list = screen.getByLabelText('Passage facts');
        expect(list.className.trim()).toBe('pv-stats');
    });

    it('never adds headings, so the diary list keeps its titles as the only h3s', () => {
        const { container } = render(React.createElement(PassageStats, { stats }));
        expect(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(0);
        expect(container.querySelector('[role="status"]')).toBeNull();
    });
});
