/**
 * The proximity watcher (129-09): a notice at 600 NM, an urgent push at 300 NM
 * or when the forecast track reaches the boat within 72 h. Great-circle
 * distances in NM, right across the antimeridian (Fiji, Tonga, Samoa,
 * Kiribati) and at high latitudes. One push per storm per level, re-armed
 * only by 12 h more than 100 NM outside or a new advisory crossing back in.
 * Notices wait out 22:00-07:00 boat time, on the boat's own clock (129-09b:
 * the IANA zone of its position, tz-lookup, worked out on the server); urgent
 * goes at once. The payload never carries a coordinate, and a dead feed is
 * never an all-clear. The storms come from the warning centres' own feed
 * (_shared/cyclone/feed.ts): the official track, else JTWC's, else GFS's,
 * else the centre's position alone, and the push says which.
 */
import { readFileSync } from 'node:fs';
import tzLookup from 'tz-lookup';
import { describe, expect, it } from 'vitest';
import {
    assess,
    boatLocalHour,
    boatZone,
    closestApproach,
    gcBearingDeg,
    gcDistanceNm,
    gcInterpolate,
    feedPartial,
    gfsOnlyStorms,
    isQuietHour,
    positionOnlyStorms,
    pushMessage,
    resolveBoat,
    runWatch,
    step,
    unavailableLine,
    watchStormsFromFeed,
    type Boat,
    type WatchState,
    type WatchStorm,
} from '../supabase/functions/_shared/cyclone/watch';
import {
    buildCycloneFeed,
    parseCurrentStorms,
    parseJmv,
    parseJtwcRss,
    parseNoaaPoints,
    parseTcvitals,
} from '../supabase/functions/_shared/cyclone/feed';
import type { FeedStorm } from '../supabase/functions/_shared/cyclone/feed';
import { parseAdeck } from '../supabase/functions/_shared/cyclone/adeck';
import { JTWC_NOT_OFFICIAL } from '../supabase/functions/_shared/cyclone/centres';

const fixture = (name: string) => readFileSync(`tests/fixtures/cyclone/${name}`, 'utf8');
/** The fixtures' feed: NHC's ZZELLA with NOAA's track, JTWC's ZZCORA and ZZDORA, and the vitals. */
function fixtureFeed() {
    const nhc = parseCurrentStorms(JSON.parse(fixture('nhc-current-storms.json')))!;
    const ella = nhc.find((s) => s.key === 'EP41')!;
    const noaa = new Map([['EP41', parseNoaaPoints(JSON.parse(fixture('noaa-ep3-forecast-points.json')), ella)]]);
    const storms = ['sh3727', 'sh3827'].map((p) => parseJmv(fixture(`jtwc-${p}.tcw`), p)!);
    return buildCycloneFeed({
        nhc: nhc.filter((s) => s.key === 'EP41'),
        noaa,
        jtwc: { listed: parseJtwcRss(fixture('jtwc.rss')), storms, failed: [] },
        vitals: parseTcvitals(fixture('tcvitals.txt')).filter((v) => v.key !== 'AL31'),
        nowMs: Date.parse('2026-10-13T14:00:00Z'),
    });
}

const H = 3_600_000;
const R = 3440.065;
/** Same-latitude great circle, an independent closed form (not haversine). */
const sameLatGc = (lat: number, dLonDeg: number) =>
    2 * R * Math.asin(Math.cos((lat * Math.PI) / 180) * Math.sin(((dLonDeg / 2) * Math.PI) / 180));

describe('great-circle maths', () => {
    it('is right across the antimeridian: 179.9°E to 179.9°W at Fiji is about 11 NM, not half the planet', () => {
        const d = gcDistanceNm({ lat: -17, lon: 179.9 }, { lat: -17, lon: -179.9 });
        expect(d).toBeCloseTo(sameLatGc(-17, 0.2), 3);
        expect(d).toBeLessThan(12);
        // Kiribati's Line Islands spell it the other way round.
        expect(gcDistanceNm({ lat: 2, lon: -179.9 }, { lat: 2, lon: 179.9 })).toBeCloseTo(sameLatGc(2, 0.2), 3);
    });

    it('is right at high latitudes, shorter than the rhumb line', () => {
        expect(gcDistanceNm({ lat: 60, lon: 0 }, { lat: 60, lon: 10 })).toBeCloseTo(sameLatGc(60, 10), 3);
        expect(gcDistanceNm({ lat: 60, lon: 0 }, { lat: 60, lon: 10 })).toBeLessThan(300);
        // Over the pole: 20° of arc.
        expect(gcDistanceNm({ lat: 80, lon: 0 }, { lat: 80, lon: 180 })).toBeCloseTo((R * 20 * Math.PI) / 180, 3);
    });

    it('bears east from Fiji to a storm just over the line', () => {
        expect(gcBearingDeg({ lat: -17, lon: 179.9 }, { lat: -17, lon: -179.5 })).toBeCloseTo(90, 0);
        expect(gcBearingDeg({ lat: -17, lon: -179.5 }, { lat: -17, lon: 179.9 })).toBeCloseTo(270, 0);
    });

    it('interpolates along the great circle, not a straight line on the chart', () => {
        const mid = gcInterpolate({ lat: -15, lon: 170 }, { lat: -15, lon: -170 }, 0.5);
        expect(mid.lon === 180 || mid.lon === -180).toBe(true);
        // A southern great circle between two points at 15°S bulges south.
        expect(mid.lat).toBeLessThan(-15.1);
    });
});

describe('closestApproach: interpolating the track between forecast points', () => {
    const t0 = Date.parse('2026-10-13T06:00:00Z');
    const track = [
        { lat: -15, lon: 170, t: t0 },
        { lat: -15, lon: -175, t: t0 + 24 * H },
    ];
    const boat = { lat: -19.5, lon: 179.9 };

    it('finds the arc passing within 300 NM though both forecast points are farther', () => {
        expect(gcDistanceNm(boat, track[0])).toBeGreaterThan(300);
        expect(gcDistanceNm(boat, track[1])).toBeGreaterThan(300);
        const near = closestApproach(boat, track, t0, t0 + 72 * H)!;
        expect(near.nm).toBeLessThan(300);
        expect(near.t).toBeGreaterThan(t0);
        expect(near.t).toBeLessThan(t0 + 24 * H);
    });

    it('stops at the window: a pass after +72 h does not count', () => {
        const late = track.map((p) => ({ ...p, t: p.t + 80 * H }));
        expect(closestApproach(boat, late, t0, t0 + 72 * H)).toBeNull();
        // Clipped mid-segment, the reachable part is still measured.
        const half = closestApproach(boat, track, t0, t0 + 6 * H)!;
        expect(half.nm).toBeGreaterThan(300);
    });
});

const NOW = Date.parse('2026-10-13T08:00:00Z');
function storm(over: Partial<WatchStorm> = {}): WatchStorm {
    return {
        key: 'SH37',
        name: 'ZZCORA',
        issuer: 'JTWC',
        advisory: 'A1',
        issuedMs: NOW - 2 * H,
        current: { lat: -17, lon: -179.5 },
        track: [],
        maxWindKts: 60,
        ...over,
    };
}
/** A point `nm` due south of the storm's centre (a boat). */
const southOf = (s: WatchStorm, nm: number) => ({ lat: s.current.lat - nm / 60, lon: s.current.lon });

describe('assess: the levels and the 72 h rule', () => {
    it('urgent inside 300 NM, a notice inside 600, nothing beyond', () => {
        const s = storm();
        expect(assess(southOf(s, 250), s, NOW).level).toBe(2);
        expect(assess(southOf(s, 500), s, NOW).level).toBe(1);
        expect(assess(southOf(s, 700), s, NOW).level).toBe(0);
    });

    it('a track reaching within 300 NM inside 72 h is urgent though the centre is 700 NM away', () => {
        const s = storm({
            track: [
                { lat: -17, lon: -179.5, t: NOW - 2 * H },
                { lat: -27, lon: -179.5, t: NOW + 48 * H },
            ],
        });
        const boat = southOf(s, 700);
        const a = assess(boat, s, NOW);
        expect(a.advisoryNm).toBeGreaterThan(690);
        expect(a.nm).toBeGreaterThan(600);
        expect(a.level).toBe(2);
        expect(a.track?.nm).toBeLessThan(300);
    });

    it('the same track arriving after 72 h is only what the centre says', () => {
        const s = storm({
            track: [
                { lat: -17, lon: -179.5, t: NOW + 75 * H },
                { lat: -27, lon: -179.5, t: NOW + 120 * H },
            ],
        });
        expect(assess(southOf(s, 700), s, NOW).level).toBe(0);
    });

    it('a track reaching 550 NM within 72 h is a notice', () => {
        const s = storm({
            track: [
                { lat: -17, lon: -179.5, t: NOW },
                { lat: -19.5, lon: -179.5, t: NOW + 24 * H },
            ],
        });
        expect(assess(southOf(s, 700), s, NOW).level).toBe(1);
    });
});

describe('step: collapse and hysteresis', () => {
    // Boat time is UTC at 0°, and every step that could push is in daylight,
    // so a 0 below is the hysteresis talking, never the quiet hours.
    const lon = 0;
    const t = (day: number, hour: number) => Date.parse('2026-10-13T00:00:00Z') + (day * 24 + hour) * H;
    const at = (nm: number, adv = 'A1', s = storm({ advisory: adv })) => assess(southOf(s, nm), s, NOW);

    it('one push per level: notice, then urgent, never the same level twice while inside', () => {
        let st: WatchState | undefined;
        const pushes: number[] = [];
        [500, 480, 250, 240, 450, 260].forEach((nm, i) => {
            const r = step(st, at(nm), 'A1', t(0, 9 + i), lon);
            pushes.push(r.push);
            st = r.state;
        });
        expect(pushes).toEqual([1, 0, 2, 0, 0, 0]);
    });

    it('re-arms after more than 100 NM outside for 12 h, not 11', () => {
        let st = step(undefined, at(500), 'A1', t(0, 8), lon).state;
        st = step(st, at(750), 'A1', t(0, 9), lon).state;
        expect(step(st, at(500), 'A1', t(0, 20), lon).push).toBe(0); // 11 h out
        st = step(st, at(750), 'A1', t(0, 21), lon).state; // 12 h out
        expect(step(st, at(500), 'A1', t(1, 8), lon).push).toBe(1);
    });

    it('outside but within the 100 NM margin never re-arms on time alone', () => {
        let st = step(undefined, at(500), 'A1', t(0, 8), lon).state;
        st = step(st, at(650), 'A1', t(0, 9), lon).state;
        st = step(st, at(650), 'A1', t(1, 15), lon).state;
        expect(step(st, at(500), 'A1', t(1, 16), lon).push).toBe(0);
    });

    it('re-arms when a NEW advisory crosses back inside after one was outside', () => {
        let st = step(undefined, at(500, 'A1'), 'A1', t(0, 8), lon).state;
        st = step(st, at(650, 'A2'), 'A2', t(0, 14), lon).state;
        expect(step(st, at(550, 'A3'), 'A3', t(0, 20), lon).push).toBe(1);
    });

    it('a boat sailing back in during the same advisory is not a new crossing', () => {
        let st = step(undefined, at(500, 'A1'), 'A1', t(0, 8), lon).state;
        st = step(st, at(650, 'A2'), 'A2', t(0, 14), lon).state;
        const back = step(st, at(550, 'A2'), 'A2', t(0, 15), lon);
        expect(back.push).toBe(0);
        expect(step(back.state, at(550, 'A3'), 'A3', t(0, 20), lon).push).toBe(0);
    });

    it('urgent re-arms on its own radius: 400 NM out for 12 h, and goes at 01:00', () => {
        let st = step(undefined, at(250), 'A1', t(0, 8), lon).state;
        st = step(st, at(450), 'A1', t(0, 9), lon).state;
        st = step(st, at(450), 'A1', t(0, 21), lon).state;
        expect(step(st, at(250), 'A1', t(1, 1), lon).push).toBe(2);
    });
});

describe('quiet hours: notices wait for 07:00 boat time, urgent goes at once', () => {
    it('boat time comes from the position, the same clock hour either side of the antimeridian', () => {
        const t = Date.parse('2026-10-13T13:00:00Z');
        expect(boatLocalHour(t, 150)).toBe(23); // UTC+10
        expect(boatLocalHour(t, -60)).toBe(9); // UTC-4
        expect(boatLocalHour(t, 179.9)).toBe(boatLocalHour(t, -179.9));
        expect(isQuietHour(t, 150)).toBe(true);
        expect(isQuietHour(t, -60)).toBe(false);
    });

    it('holds a notice raised at 23:00 and sends it after 07:00 if still inside', () => {
        const lon = 150;
        const s = storm();
        const night = Date.parse('2026-10-13T13:00:00Z'); // 23:00 at UTC+10
        const held = step(undefined, assess(southOf(s, 500), s, night), 'A1', night, lon);
        expect(held.push).toBe(0);
        const dawn = Date.parse('2026-10-13T21:10:00Z'); // 07:10
        expect(step(held.state, assess(southOf(s, 500), s, dawn), 'A1', dawn, lon).push).toBe(1);
    });

    it('sends urgent at 01:00, and the held notice is not sent after it', () => {
        const lon = 150;
        const s = storm();
        const night = Date.parse('2026-10-13T13:00:00Z');
        const held = step(undefined, assess(southOf(s, 500), s, night), 'A1', night, lon);
        const one = Date.parse('2026-10-13T15:00:00Z');
        const urgent = step(held.state, assess(southOf(s, 250), s, one), 'A1', one, lon);
        expect(urgent.push).toBe(2);
        const dawn = Date.parse('2026-10-13T21:10:00Z');
        expect(step(urgent.state, assess(southOf(s, 500), s, dawn), 'A1', dawn, lon).push).toBe(0);
    });
});

describe('the push', () => {
    const boat: Boat = { userId: 'u1', position: { lat: -17.53, lon: 178.41 }, basis: 'fix' };

    it('names the storm, the issuer, the distance and the bearing, and never a coordinate', () => {
        const s = storm({ current: { lat: -18.92, lon: -179.47 } });
        const a = assess(boat.position, s, NOW);
        const msg = pushMessage(2, s, a, boat, NOW);
        const all = JSON.stringify(msg);
        // Not "Cyclone warning": that is the official centres' product name.
        expect(msg.title).toBe('Urgent cyclone notice: ZZCORA');
        expect(msg.title).not.toMatch(/warning/i);
        // The issuer leads for a track that is not the official one: lock screens cut the end off.
        expect(msg.body.startsWith(`${JTWC_NOT_OFFICIAL}.`)).toBe(true);
        expect(msg.body).toContain('ZZCORA is');
        expect(msg.body).toMatch(/\d+ NM from your boat, bearing \d{3}° \([NSEW]{1,3}\)/);
        expect(msg.body).toContain('JTWC: US military advisory, not the official warning here');
        expect(msg.body).toContain('RSMC Nadi');
        for (const n of ['17.53', '178.41', '18.92', '179.47', '-17', '178.4']) expect(all).not.toContain(n);
        expect(msg.data).toEqual({ storm_key: 'SH37', storm_name: 'ZZCORA', level: 'urgent', issuer: 'JTWC' });
        expect(msg.title.length).toBeLessThanOrEqual(120);
        expect(msg.body.length).toBeLessThanOrEqual(500);
    });

    it('says which position it measured from, and when the last advisory was if it is old', () => {
        const s = storm({ issuedMs: NOW - 14 * H });
        const msg = pushMessage(1, s, assess(boat.position, s, NOW), { ...boat, basis: 'home' }, NOW);
        expect(msg.title).toBe('Cyclone notice: ZZCORA');
        expect(msg.body).toContain('from your home port');
        expect(msg.body).toContain('Last advisory 12 Oct 18:00 UTC');
    });

    it('calls an NHC track official, and a model-only track a model', () => {
        const nhc = storm({
            key: 'EP41',
            name: 'ZZELLA',
            issuer: 'NHC',
            advisory: '24A',
            current: { lat: 18, lon: -108 },
        });
        const b: Boat = { userId: 'u2', position: { lat: 20, lon: -105 }, basis: 'fix' };
        expect(pushMessage(1, nhc, assess(b.position, nhc, NOW), b, NOW).body).toContain(
            'NHC official forecast, advisory 24A',
        );
        const gfs = storm({ issuer: 'GFS' });
        const gfsBody = pushMessage(1, gfs, assess(boat.position, gfs, NOW), boat, NOW).body;
        expect(gfsBody).toMatch(/^GFS model track only/);
        expect(gfsBody).toContain('Official warnings: RSMC Nadi');
    });

    it('measures from where the track puts the storm now, not from an advisory hours old', () => {
        // Advisory 6 h old; moving east about 19 kt along 17°S, across the antimeridian.
        const track = [
            { lat: -17, lon: 179.5, t: NOW - 6 * H },
            { lat: -17, lon: -172.5, t: NOW + 18 * H },
        ];
        const s = storm({ issuedMs: NOW - 6 * H, current: { lat: -17, lon: 179.5 }, track });
        const b: Boat = { userId: 'tonga', position: { lat: -17, lon: -170 }, basis: 'fix' };
        const a = assess(b.position, s, NOW);
        const nowAt = gcInterpolate(track[0], track[1], 0.25);
        expect(a.nm).toBeCloseTo(gcDistanceNm(b.position, nowAt), 1);
        expect(a.nm).toBeLessThan(gcDistanceNm(b.position, s.current) - 100);
        expect(a.bearing).toBeCloseTo(gcBearingDeg(b.position, nowAt), 1);
        const body = pushMessage(2, s, a, b, NOW).body;
        expect(body).toContain(`ZZCORA is about ${Math.round(a.nm / 10) * 10} NM from your boat`);
    });

    it('a storm moving away is still judged by its advisory position, and the push says why', () => {
        const track = [
            { lat: -17, lon: -179.5, t: NOW - 6 * H },
            { lat: -17, lon: -167.5, t: NOW + 18 * H },
        ];
        const s = storm({ issuedMs: NOW - 6 * H, current: { lat: -17, lon: -179.5 }, track });
        const b: Boat = { userId: 'fiji', position: { lat: -17, lon: 175.5 }, basis: 'fix' };
        const a = assess(b.position, s, NOW);
        expect(gcDistanceNm(b.position, s.current)).toBeLessThan(300);
        expect(a.nm).toBeGreaterThan(300);
        expect(a.level).toBe(2);
        const body = pushMessage(2, s, a, b, NOW).body;
        expect(body).toMatch(/At the 13 Oct 02:00 UTC advisory it was \d+ NM away\./);
    });
});

describe('runWatch', () => {
    const boats: Boat[] = [
        { userId: 'fiji', position: { lat: -17.6, lon: 178.0 }, basis: 'fix' },
        { userId: 'coral', position: { lat: -27.4, lon: 153.2 }, basis: 'home' },
        { userId: 'mexico', position: { lat: 20.6, lon: -105.3 }, basis: 'old-fix' },
    ];
    const feed = fixtureFeed();
    const now = Date.parse('2026-10-13T14:00:00Z');

    it('pushes from the warning centres’ feed to the boats near each storm, and records state without positions', () => {
        const storms = watchStormsFromFeed(feed.storms);
        expect(storms.map((s) => `${s.key} ${s.issuer}`).sort()).toEqual(['EP41 NHC', 'SH37 JTWC', 'SH38 JTWC']);
        // tau 0 of the issuer's own track is the advisory's centre, as before.
        expect(storms.find((s) => s.key === 'SH37')).toMatchObject({
            advisory: '7',
            issuedMs: Date.parse('2026-10-13T09:00:00Z'),
            current: { lat: -16.8, lon: 178.5 },
            maxWindKts: 70,
        });
        const out = runWatch({ storms, boats, states: new Map(), nowMs: now });
        const sent = out.pushes.map((p) => `${p.userId} ${p.data.storm_key} ${p.type}`).sort();
        expect(sent).toContain('fiji SH37 cyclone_urgent');
        expect(sent).toContain('mexico EP41 cyclone_urgent');
        for (const [, st] of out.states) {
            const text = JSON.stringify(st);
            expect(text).not.toMatch(/lat|lon/);
        }
        expect(out.unavailable).toBe(false);
    });

    it('with the feed down: no pushes, no state erased, and it says unavailable, not all-clear', () => {
        const prior = new Map<string, WatchState>([
            ['fiji|SH37', { sent: 2, sentAt: now - H, far: [null, null], out: [null, null], seenAt: now - H }],
        ]);
        const out = runWatch({ storms: null, boats, states: prior, nowMs: now });
        expect(out.unavailable).toBe(true);
        expect(out.pushes.filter((p) => p.type !== 'cyclone_notice' || !/unavailable/i.test(p.title))).toEqual([]);
        expect(out.states.get('fiji|SH37')?.sent).toBe(2);
        expect(unavailableLine(Date.parse('2026-10-14T03:10:00Z'))).toBe(
            'Cyclone data unavailable since 14 Oct 03:10 UTC',
        );
    });

    it('a storm that drops out of the feed while near a boat is not silently erased: one push says so', () => {
        const prior = new Map<string, WatchState>([
            ['fiji|SH37', { sent: 2, sentAt: now - 6 * H, far: [null, null], out: [null, null], seenAt: now - 2 * H }],
        ]);
        const storms = watchStormsFromFeed(feed.storms).filter((s) => s.key !== 'SH37');
        const first = runWatch({ storms, boats, states: prior, nowMs: now });
        const lost = first.pushes.filter((p) => p.userId === 'fiji' && p.data.storm_key === 'SH37');
        expect(lost).toHaveLength(1);
        expect(lost[0].title).toMatch(/unavailable/i);
        expect(lost[0].body).not.toMatch(/clear|no cyclone/i);
        expect(first.states.get('fiji|SH37')?.sent).toBe(2);
        const again = runWatch({ storms, boats, states: first.states, nowMs: now + H });
        expect(again.pushes.filter((p) => p.data.storm_key === 'SH37')).toEqual([]);
    });

    it('a storm that weakens below gale force while still in the feed is not called lost', () => {
        const prior = new Map<string, WatchState>([
            [
                'fiji|SH37',
                {
                    sent: 2,
                    sentAt: now - 3 * H,
                    far: [null, null],
                    out: [null, null],
                    seenAt: now - H,
                    name: 'ZZCORA',
                    centre: 'nadi',
                },
            ],
        ]);
        const weak = storm({ maxWindKts: 30, current: { lat: -17.5, lon: 179.0 } });
        let states = prior;
        for (const dt of [0, H, 2 * H, 3 * H]) {
            const out = runWatch({ storms: [weak], boats, states, nowMs: now + dt });
            expect(out.pushes).toEqual([]);
            states = out.states;
        }
        expect(states.get('fiji|SH37')).toMatchObject({ sent: 2, seenAt: now + 3 * H });
    });

    it('the gale-force line is the warning centre’s: a GFS-only storm at 30 kt is still measured', () => {
        const gfs = storm({ issuer: 'GFS', maxWindKts: 30, current: { lat: -17.5, lon: 178.2 } });
        const out = runWatch({ storms: [gfs], boats, states: new Map(), nowMs: now });
        expect(out.pushes.map((p) => `${p.userId} ${p.type}`)).toEqual(['fiji cyclone_urgent']);
    });

    it('a source flap is not a new advisory: official inside, GFS outside, the same advisory inside again', () => {
        const cuba: Boat[] = [{ userId: 'cuba', position: { lat: 20, lon: -80 }, basis: 'fix' }];
        const at = Date.parse('2026-08-13T18:00:00Z'); // 13:00 at the boat
        const nhc = storm({ key: 'AL09', issuer: 'NHC', advisory: '24A', current: { lat: 20 - 280 / 60, lon: -80 } });
        const gfs = storm({
            key: 'AL09',
            issuer: 'GFS',
            advisory: '2026081312',
            current: { lat: 20 - 310 / 60, lon: -80 },
        });
        const one = runWatch({ storms: [nhc], boats: cuba, states: new Map(), nowMs: at });
        expect(one.pushes.map((p) => p.type)).toEqual(['cyclone_urgent']);
        const two = runWatch({ storms: [gfs], boats: cuba, states: one.states, nowMs: at + 0.5 * H });
        expect(two.pushes).toEqual([]);
        const three = runWatch({ storms: [nhc], boats: cuba, states: two.states, nowMs: at + H });
        expect(three.pushes).toEqual([]);
        // The same issuer's NEXT advisory crossing back in still re-arms.
        const outside = storm({ ...nhc, advisory: '25', current: { lat: 20 - 310 / 60, lon: -80 } });
        const four = runWatch({ storms: [outside], boats: cuba, states: three.states, nowMs: at + 6 * H });
        const five = runWatch({
            storms: [{ ...nhc, advisory: '26' }],
            boats: cuba,
            states: four.states,
            nowMs: at + 12 * H,
        });
        expect(five.pushes.map((p) => p.type)).toEqual(['cyclone_urgent']);
    });

    it('a storm back in the feed after its data was said lost is restated, once', () => {
        const prior = new Map<string, WatchState>([
            [
                'fiji|SH37',
                {
                    sent: 2,
                    sentAt: now - 6 * H,
                    far: [null, null],
                    out: [null, null],
                    seenAt: now - 3 * H,
                    lostToldAt: now - 2 * H,
                    name: 'ZZCORA',
                    centre: 'nadi',
                },
            ],
        ]);
        const back = storm({ current: { lat: -17.5, lon: 179.0 } });
        const first = runWatch({ storms: [back], boats, states: prior, nowMs: now });
        expect(first.pushes.map((p) => `${p.userId} ${p.data.storm_key} ${p.type}`)).toEqual([
            'fiji SH37 cyclone_urgent',
        ]);
        expect(runWatch({ storms: [back], boats, states: first.states, nowMs: now + H }).pushes).toEqual([]);
    });

    it('skips a storm too weak to be a cyclone anywhere in the next 72 h', () => {
        const weak = storm({ maxWindKts: 25, current: { lat: -17.5, lon: 178.2 } });
        expect(runWatch({ storms: [weak], boats, states: new Map(), nowMs: now }).pushes).toEqual([]);
    });
});

describe('which position a boat is watched from', () => {
    const NOWB = Date.parse('2026-10-13T08:00:00Z');
    const fresh = new Date(NOWB - 2 * H).toISOString();
    const stale = new Date(NOWB - 80 * H).toISOString();
    const fiji = { lat: -17.75, lon: 177.45 };

    it('the Pi’s fix while fresh, then a fresh fix the phone already sent', () => {
        expect(resolveBoat('u', { settings: {}, telemetry: { ...fiji, at: fresh } }, NOWB)).toEqual({
            userId: 'u',
            position: fiji,
            basis: 'fix',
        });
        expect(
            resolveBoat(
                'u',
                { settings: {}, telemetry: { lat: 1, lon: 2, at: stale }, phone: { ...fiji, at: fresh } },
                NOWB,
            ),
        ).toMatchObject({ position: fiji, basis: 'phone' });
    });

    it('a phone-only boat: the home port as the app resolves it, by display name or its embedded position', () => {
        const byName = {
            homePort: 'Suva (-18.1416, 178.4419)',
            savedLocationCoords: { Suva: { lat: -18.14, lon: 178.44 } },
        };
        expect(resolveBoat('u', { settings: byName }, NOWB)).toMatchObject({
            position: { lat: -18.14, lon: 178.44 },
            basis: 'home',
        });
        // Non-Latin names: the position written into the name is read.
        expect(resolveBoat('u', { settings: { homePort: '那霸 (26.2124, 127.6809)' } }, NOWB)).toMatchObject({
            position: { lat: 26.2124, lon: 127.6809 },
            basis: 'home',
        });
    });

    it('then the place the weather is set to (onboarding writes the home port there), then an old fix', () => {
        const onboarded = { defaultLocation: 'Nukuʻalofa, Tonga', defaultLocationCoords: { lat: -21.14, lon: -175.2 } };
        expect(resolveBoat('u', { settings: onboarded, telemetry: { ...fiji, at: stale } }, NOWB)).toMatchObject({
            position: { lat: -21.14, lon: -175.2 },
            basis: 'place',
        });
        expect(resolveBoat('u', { settings: {}, telemetry: { ...fiji, at: stale } }, NOWB)).toMatchObject({
            position: fiji,
            basis: 'old-fix',
        });
        expect(resolveBoat('u', { settings: {}, phone: { ...fiji, at: stale } }, NOWB)).toMatchObject({
            basis: 'old-fix',
        });
    });

    it('nothing usable, or the switch off, is no boat', () => {
        expect(resolveBoat('u', { settings: { homePort: 'Suva' } }, NOWB)).toBeNull();
        expect(resolveBoat('u', { settings: null, telemetry: { lat: 91, lon: 0, at: fresh } }, NOWB)).toBeNull();
        expect(
            resolveBoat('u', { settings: { cycloneWarnings: false }, telemetry: { ...fiji, at: fresh } }, NOWB),
        ).toBeNull();
    });

    it('says plainly where it measured from', () => {
        const s = storm();
        for (const [basis, words] of [
            ['phone', 'from your last reported position'],
            ['place', 'from your weather location'],
        ] as const) {
            const b: Boat = { userId: 'u', position: { lat: -18, lon: 178 }, basis };
            expect(pushMessage(1, s, assess(b.position, s, NOW), b, NOW).body).toContain(words);
        }
    });
});

describe('quiet hours on the boat’s real local clock (129-09b)', () => {
    const summer = Date.parse('2026-12-01T11:30:00Z');

    it.each([
        ['Sydney in daylight saving, UTC+11', -33.86, 151.21, 'Australia/Sydney', 22],
        ['Brisbane, no daylight saving, UTC+10', -27.47, 153.03, 'Australia/Brisbane', 21],
        ['Nouméa, UTC+11', -22.27, 166.45, 'Pacific/Noumea', 22],
    ])('%s', (_name, lat, lon, zone, hour) => {
        expect(boatZone({ lat, lon }, tzLookup)).toBe(zone);
        expect(boatLocalHour(summer, boatZone({ lat, lon }, tzLookup))).toBe(hour);
    });

    it('mid-ocean the lookup gives the nautical Etc/GMT zone, which is right there', () => {
        const zone = boatZone({ lat: -10, lon: -120 }, tzLookup);
        expect(zone).toMatch(/^Etc\/GMT[+-]\d{1,2}$/);
        expect(boatLocalHour(summer, zone)).toBe(boatLocalHour(summer, -120));
        expect(boatLocalHour(summer, zone)).toBe(3);
    });

    it('a lookup that fails, or names no zone, falls back to the nautical zone', () => {
        const at = { lat: -33.86, lon: 151.21 };
        expect(
            boatZone(at, () => {
                throw new Error('no data');
            }),
        ).toBe(151.21);
        expect(boatZone(at, () => 'Not/AZone')).toBe(151.21);
        expect(boatZone(at)).toBe(151.21);
        expect(boatLocalHour(summer, 'Not/AZone')).toBe(boatLocalHour(summer, 0));
    });

    const sydney: Boat[] = [{ userId: 'sydney', position: { lat: -33.86, lon: 151.21 }, basis: 'fix' }];
    const near = (nm: number) =>
        storm({ key: 'SH40', name: 'ZZERIN', current: { lat: -33.86 + nm / 60, lon: 151.21 }, maxWindKts: 60 });

    it('a notice at 22:30 Sydney summer time waits, though the nautical clock says 21:30', () => {
        const held = runWatch({
            storms: [near(500)],
            boats: sydney,
            states: new Map(),
            nowMs: summer,
            zoneAt: tzLookup,
        });
        expect(held.pushes).toEqual([]);
        // Without the lookup the hour is the nautical one, and the notice goes.
        expect(runWatch({ storms: [near(500)], boats: sydney, states: new Map(), nowMs: summer }).pushes).toHaveLength(
            1,
        );
        // 07:10 at the boat: sent.
        const dawn = Date.parse('2026-12-01T20:10:00Z');
        const sent = runWatch({
            storms: [near(500)],
            boats: sydney,
            states: held.states,
            nowMs: dawn,
            zoneAt: tzLookup,
        });
        expect(sent.pushes.map((p) => p.type)).toEqual(['cyclone_notice']);
    });

    it('urgent goes at once on the real clock too', () => {
        const out = runWatch({
            storms: [near(200)],
            boats: sydney,
            states: new Map(),
            nowMs: summer,
            zoneAt: tzLookup,
        });
        expect(out.pushes.map((p) => p.type)).toEqual(['cyclone_urgent']);
    });
});

describe('position only: a storm in the list with no track that reached Thalassa', () => {
    const feed = fixtureFeed();
    const now = Date.parse('2026-10-13T14:00:00Z');

    it('is measured from the centre’s own position and says it has no track', () => {
        const pos = positionOnlyStorms(feed.storms);
        expect(pos.map((s) => `${s.key} ${s.issuer}`)).toEqual(['IO02 JTWC', 'WP33 JTWC']);
        const wp = pos.find((s) => s.key === 'WP33')!;
        // No forecast reached Thalassa, so nothing says it stays weak: no maximum wind is claimed.
        expect(wp).toMatchObject({ positionOnly: true, name: 'TWENTY-TH', maxWindKts: null });
        expect(wp.track).toHaveLength(1);
        const boat: Boat = { userId: 'guam', position: { lat: 13.4, lon: 175.0 }, basis: 'fix' };
        const msg = pushMessage(1, wp, assess(boat.position, wp, now), boat, now);
        expect(msg.body.startsWith('Position only, from JTWC (US military); no forecast track reached Thalassa.')).toBe(
            true,
        );
        expect(msg.body).toContain('Official warnings: RSMC Tokyo.');
        expect(msg.body).toContain('Position 13 Oct 06:00 UTC.');
        expect(msg.body).not.toContain('official forecast');
        expect(JSON.stringify(msg)).not.toMatch(/15\.2|179\.5|13\.4|175\.0/);
    });

    it('flapping between JTWC’s track and the bare position is not a new advisory', () => {
        const boats: Boat[] = [{ userId: 'fiji', position: { lat: -17.6, lon: 178.0 }, basis: 'fix' }];
        const tracked = watchStormsFromFeed(feed.storms).find((s) => s.key === 'SH37')!;
        // The vitals put it 330 NM off, outside the urgent radius; JTWC's warning 7 inside it.
        const bare: WatchStorm = {
            ...tracked,
            positionOnly: true,
            advisory: '2026-10-13T06:00:00.000Z',
            current: { lat: -17.6 + 330 / 60, lon: 178.0 },
            track: [],
        };
        const one = runWatch({ storms: [tracked], boats, states: new Map(), nowMs: now });
        expect(one.pushes.map((p) => p.type)).toEqual(['cyclone_urgent']);
        const two = runWatch({ storms: [bare], boats, states: one.states, nowMs: now + 0.5 * 3_600_000 });
        expect(two.pushes).toEqual([]);
        // Back to the same warning: not a new JTWC advisory crossing the line.
        const three = runWatch({ storms: [tracked], boats, states: two.states, nowMs: now + 3_600_000 });
        expect(three.pushes).toEqual([]);
        // JTWC's own warning 8 outside, then its warning 9 back inside, does re-arm.
        const outside = { ...tracked, advisory: '8', current: bare.current, track: [] };
        const eight = runWatch({ storms: [outside], boats, states: three.states, nowMs: now + 2 * 3_600_000 });
        const four = runWatch({
            storms: [{ ...tracked, advisory: '9' }],
            boats,
            states: eight.states,
            nowMs: now + 3 * 3_600_000,
        });
        expect(four.pushes.map((p) => p.type)).toEqual(['cyclone_urgent']);
    });

    it('a depression with no forecast is still measured and pushed: nothing says it stays weak', () => {
        // JTWC's 05P, a 29 kt depression 40 NM off a boat at Port Vila, forecast to deepen; its
        // .tcw failed and the GFS tracker lacks it, so the feed has its position from the vitals only.
        const td: FeedStorm = {
            key: 'SH05',
            sid: 'sh052027',
            name: 'FIVE',
            basin: 'P',
            nature: '',
            current: {
                lat: -17.74 + 40 / 60,
                lon: 168.31,
                time: '2026-10-13T12:00:00.000Z',
                windKts: 29,
                pressureMb: 1002,
            },
            positionBy: 'JTWC',
            from: ['vitals'],
            forecastUnavailable: true,
        };
        const [bare] = positionOnlyStorms([td]);
        expect(bare.maxWindKts).toBeNull();
        const boats: Boat[] = [{ userId: 'vila', position: { lat: -17.74, lon: 168.31 }, basis: 'fix' }];
        const out = runWatch({ storms: [bare], boats, states: new Map(), nowMs: now, zoneAt: tzLookup });
        expect(out.pushes.map((p) => `${p.userId} ${p.type}`)).toEqual(['vila cyclone_urgent']);
        expect(out.pushes[0].body.startsWith('Position only, from JTWC (US military)')).toBe(true);
        // Even one built with a wind the centre gave now: a position alone is never "too weak".
        const stated = { ...bare, maxWindKts: 29 };
        expect(runWatch({ storms: [stated], boats, states: new Map(), nowMs: now }).pushes).toHaveLength(1);
    });

    it('a storm whose list went partly down is "not answering", never "no longer in the feed"', () => {
        const prior = new Map<string, WatchState>([
            [
                'fiji|SH37',
                {
                    sent: 2,
                    sentAt: now - 6 * 3_600_000,
                    far: [null, null],
                    out: [null, null],
                    seenAt: now - 2 * 3_600_000,
                },
            ],
        ]);
        const boats: Boat[] = [{ userId: 'fiji', position: { lat: -17.6, lon: 178.0 }, basis: 'fix' }];
        const out = runWatch({ storms: [], boats, states: prior, nowMs: now, partial: true });
        expect(out.pushes).toHaveLength(1);
        expect(out.pushes[0].body).toContain('Part of the cyclone feed is not answering');
        expect(out.pushes[0].body).not.toMatch(/no longer in the cyclone feed|clear|no cyclone/i);
    });
});

describe('feedPartial: when part of the feed did not come', () => {
    const base = fixtureFeed();
    const now0 = Date.parse('2026-10-13T14:00:00Z');
    it('a storm list, NOAA’s tracks, JTWC’s products, or a JTWC warning with no position, is partial', () => {
        expect(feedPartial(null)).toBe(true);
        expect(feedPartial({ ...base, sources: { ...base.sources, noaa: 'ok', jtwcTracks: 'ok' }, unplaced: [] })).toBe(
            false,
        );
        for (const k of ['nhc', 'jtwc', 'vitals', 'noaa', 'jtwcTracks'] as const) {
            expect(feedPartial({ ...base, sources: { ...base.sources, [k]: 'unavailable' } })).toBe(true);
        }
        expect(
            feedPartial({
                ...base,
                sources: { ...base.sources, noaa: 'ok', jtwcTracks: 'ok' },
                unplaced: [{ key: 'SH05', name: 'FIVE', warning: '1' }],
            }),
        ).toBe(true);
    });

    it('a pushed storm whose JTWC product failed, placed by no list, is "not answering", never "no longer in the feed"', () => {
        const prior = new Map<string, WatchState>([
            [
                'fiji|SH37',
                {
                    sent: 2,
                    sentAt: now0 - 6 * H,
                    far: [null, null],
                    out: [null, null],
                    seenAt: now0 - 2 * H,
                    name: 'ZZCORA',
                    centre: 'nadi',
                },
            ],
        ]);
        const feed = buildCycloneFeed({
            nhc: [],
            noaa: new Map(),
            jtwc: { listed: parseJtwcRss(fixture('jtwc.rss')), storms: [], failed: ['SH37', 'SH38'] },
            vitals: [],
            nowMs: now0,
        });
        const boats: Boat[] = [{ userId: 'fiji', position: { lat: -17.6, lon: 178.0 }, basis: 'fix' }];
        const out = runWatch({
            storms: positionOnlyStorms(feed.storms),
            boats,
            states: prior,
            nowMs: now0,
            partial: feedPartial(feed),
        });
        expect(out.pushes).toHaveLength(1);
        expect(out.pushes[0].body).toContain('Part of the cyclone feed is not answering');
        expect(out.pushes[0].body).not.toContain('no longer in the cyclone feed');
    });
});

describe('gfsOnlyStorms: the GFS model’s track for a storm no centre’s track covers', () => {
    const tracks = parseAdeck(fixture('adeck-wpac.dat'));

    it('keeps named storms, never invests, and takes the name from the storm list', () => {
        const out = gfsOnlyStorms(tracks, [], new Map([['WP33', 'TWENTY-TH']]));
        expect(out.map((s) => `${s.key} ${s.issuer} ${s.name}`)).toEqual(['WP33 GFS TWENTY-TH']);
        expect(out[0].advisory).toBe('2026101312');
        expect(gfsOnlyStorms(tracks, [])[0].name).toBe('Tropical cyclone WP33');
    });

    it('a storm a centre already tracks, by key or within 300 NM, is not doubled', () => {
        const wp = gfsOnlyStorms(tracks, [])[0];
        expect(gfsOnlyStorms(tracks, [{ ...wp, key: 'WP33', issuer: 'JTWC' }])).toEqual([]);
        expect(gfsOnlyStorms(tracks, [{ ...wp, key: 'XX01', issuer: 'JTWC' }])).toEqual([]);
    });
});
