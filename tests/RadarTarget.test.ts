import { describe, expect, it } from 'vitest';
import {
    parseRadarSentence,
    qualifyRadarReport,
    radarContactKey,
    RADAR_REPORT_MAX_AGE_MS,
    type RadarOwnship,
    type RadarReport,
} from '../utils/radarTarget';
const T = Date.UTC(2026, 0, 2, 0, 0, 5, 123);
const FEED = 'pi:generated:verified-vessel:input1';
const frame = (body: string): string => {
    let checksum = 0;
    for (const c of body) checksum ^= c.charCodeAt(0);
    return `$${body}*${checksum.toString(16).padStart(2, '0').toUpperCase()}`;
};
const ttm = (changes: Record<number, string> = {}) =>
    frame(
        ['RATTM', '01', '1', '0', 'R', '10', '180', 'R', '0.2', '6', 'N', 'Generated echo', 'T', '', '000005.123', 'A']
            .map((v, i) => changes[i] ?? v)
            .join(','),
    );
const tll = (changes: Record<number, string> = {}) =>
    frame(
        ['RATLL', '01', '5030.000', 'N', '00115.000', 'W', 'Generated echo', '000005.123', 'T', '']
            .map((v, i) => changes[i] ?? v)
            .join(','),
    );
const parse = (raw: unknown, receivedAt = T, now = receivedAt) =>
    parseRadarSentence(raw, { feedId: FEED, receivedAt, now });
const own = (): RadarOwnship => ({
    feedId: FEED,
    position: { lat: 50, lon: -1, at: T },
    heading: { trueDeg: 0, at: T },
    motion: { sogKn: 5, sogAt: T, cogTrueDeg: 0, cogAt: T },
});

describe('checksum-required read-only radar frames', () => {
    it('keeps the real radar identity/status/clocks without inventing an AIS MMSI', () => {
        const report = parse(ttm())!;
        expect(report).toMatchObject({
            source: 'radar',
            contactKey: `radar:${FEED}:RA:1`,
            talker: 'RA',
            targetNumber: 1,
            status: 'tracking',
            acquisition: 'automatic',
            at: T,
            receivedAt: T,
            clock: 'observation-utc',
        });
        expect(report).not.toHaveProperty('mmsi');
        expect(radarContactKey(FEED, 'RA', 1)).not.toBe(radarContactKey('other-feed', 'RA', 1));
        expect(radarContactKey(FEED, 'RA', 1)).not.toBe(radarContactKey(FEED, 'RB', 1));
        for (const bad of ['', 'a/b', 'x'.repeat(97), 'pi:bad\n']) expect(radarContactKey(bad, 'RA', 1)).toBeNull();
        expect(radarContactKey('x'.repeat(96), 'RA', 999)!.length).toBeLessThanOrEqual(112);
    });
    it.each([
        () => ttm().split('*')[0],
        () => ttm().slice(0, -2) + '00',
        () => ttm() + '\r\n',
        () => ttm() + '*00',
        () => frame('RATTM,01,1,0,R,10,180,R,0.2,6,N,evil\nname,T,,000005.123,A'),
        () => ttm({ 11: 'x'.repeat(257) }),
        () => frame(ttm().slice(1).split('*')[0].replace('RATTM', 'RAVTG')),
    ])('refuses absent/corrupt/ambiguous framing %#', (raw) => expect(parse(raw())).toBeNull());
    it.each([
        [2, ''],
        [2, '-1'],
        [2, 'Infinity'],
        [2, '100.1'],
        [3, '361'],
        [3, '1e2'],
        [4, 'M'],
        [5, '-1'],
        [5, '201'],
        [6, '361'],
        [7, 'M'],
        [10, 'M'],
        [12, 'V'],
        [12, 'S'],
        [13, 'X'],
        [14, '240005'],
        [14, '000060'],
        [15, 'S'],
    ])('refuses invalid TTM field%s=%s', (field, value) => expect(parse(ttm({ [field]: value }))).toBeNull());
    it('converts declared nautical/km/statute units without guessing', () => {
        expect(parse(ttm({ 2: '1.852', 5: '18.52', 10: 'K' }))!.polarPosition!.rangeNm).toBeCloseTo(1, 12);
        expect(parse(ttm({ 2: '1.852', 5: '18.52', 10: 'K' }))!.motion.speedKn).toBeCloseTo(10, 12);
        expect(parse(ttm({ 2: '1', 5: '10', 10: 'S' }))!.motion.speedKn).toBeCloseTo(8.689762419, 8);
        expect(parse(ttm({ 3: '360', 6: '360' }))!.motion.courseDeg).toBe(0);
    });
    it('preserves empty motion as unknown, including an independently reported zero', () => {
        expect(parse(ttm({ 5: '', 6: '', 7: '' }))!.motion).toEqual({
            speedKn: null,
            courseDeg: null,
            reference: null,
        });
        expect(parse(ttm({ 5: '0', 6: '' }))!.motion.speedKn).toBe(0);
        expect(parse(ttm({ 5: '', 6: '90' }))!.motion.speedKn).toBeNull();
    });
    it('accepts explicit acquiring/lost transitions without inventing positions or motion', () => {
        const fields: Record<number, string> = { 2: '', 3: '', 4: '', 5: '', 6: '', 7: '', 8: '', 9: '', 10: '' };
        const report = parse(ttm({ ...fields, 12: 'L' }))!;
        expect(report).toMatchObject({ status: 'lost', polarPosition: null, position: null });
        expect(qualifyRadarReport(report, own(), T).motion).toBeNull();
        expect(parse(ttm({ ...fields, 12: 'Q' }))!.status).toBe('acquiring');
        expect(parse(ttm({ ...fields, 12: 'T' }))).toBeNull();
    });
    it('parses real TLL positions, including zero and the antimeridian, but supplies no velocity', () => {
        expect(parse(tll())!.position).toEqual({ lat: 50.5, lon: -1.25 });
        expect(parse(tll({ 2: '0000.000', 3: 'N', 4: '18000.000', 5: 'E' }))!.position).toEqual({ lat: 0, lon: 180 });
        const contact = qualifyRadarReport(parse(tll())!, null, T);
        expect(contact.position).toEqual({ lat: 50.5, lon: -1.25 });
        expect(contact.motion).toBeNull();
    });
    it.each([
        [2, '5060.1'],
        [2, '9000.1'],
        [3, 'E'],
        [4, '18100'],
        [5, 'N'],
        [8, 'A'],
    ])('rejects invalid TLL field%s=%s', (field, value) => expect(parse(tll({ [field]: value }))).toBeNull());
    it('binds time-of-day across midnight; rejects old/future time and retains ingress clock explicitly', () => {
        expect(parse(ttm({ 14: '235959.123' }))!.at).toBe(T - 6000);
        expect(parse(ttm({ 14: '235900' }))).toBeNull();
        expect(parse(ttm({ 14: '000007.123' }))).toBeNull();
        const noTime = parse(ttm({ 14: '' }))!;
        expect(noTime).toMatchObject({ at: T, receivedAt: T, clock: 'ingress' });
        expect(parse(ttm(), T, T + RADAR_REPORT_MAX_AGE_MS + 1)).toBeNull();
        expect(parse(ttm(), T + 1001, T)).toBeNull();
        expect(qualifyRadarReport(noTime, own(), T + 16_000).at).toBe(T);
    });
});

describe('radar geometry and conservative ground-motion qualification', () => {
    it('locates relative bearings from true heading, and true bearings independently', () => {
        const ship = own();
        ship.position = { lat: 0, lon: 0, at: T };
        ship.heading!.trueDeg = 90;
        const relative = qualifyRadarReport(parse(ttm())!, ship, T);
        expect(relative.position!.lat).toBeCloseTo(0, 10);
        expect(relative.position!.lon).toBeCloseTo(1 / 60.04046, 7);
        ship.heading = null;
        const absolute = qualifyRadarReport(parse(ttm({ 4: 'T' }))!, ship, T);
        expect(absolute.position!.lat).toBeCloseTo(1 / 60.04046, 7);
        expect(absolute.position!.lon).toBeCloseTo(0, 10);
        expect(absolute.motion).toBeNull();
        expect(qualifyRadarReport(parse(ttm())!, ship, T).position).toBeNull();
    });
    it('uses a short geodesic crossing at the dateline', () => {
        const ship = own();
        ship.position = { lat: 0, lon: 179.999, at: T };
        const contact = qualifyRadarReport(parse(ttm({ 3: '90', 4: 'T' }))!, ship, T);
        expect(contact.position!.lon).toBeLessThan(-179.98);
        expect(contact.position!.lon).toBeGreaterThan(-180);
    });
    it('adds the measured own ground vector to relative motion using actual heading orientation', () => {
        const report = parse(ttm())!,
            ship = own();
        const south = qualifyRadarReport(report, ship, T);
        expect(south.motion!.sogKn).toBeCloseTo(5, 12);
        expect(south.motion!.cogTrueDeg).toBeCloseTo(180, 12);
        ship.heading!.trueDeg = 90;
        ship.motion!.cogTrueDeg = 90;
        const ne = qualifyRadarReport(parse(ttm({ 6: '270' }))!, ship, T);
        expect(ne.motion!.sogKn).toBeCloseTo(Math.sqrt(125), 12);
        expect(ne.motion!.cogTrueDeg).toBeCloseTo(26.565051177, 8);
        expect(ne.motionReason).toBe('relative-vector');
    });
    it('does not interpret true-oriented radar speed as ground-stabilized SOG', () => {
        const contact = qualifyRadarReport(parse(ttm({ 7: 'T' }))!, own(), T);
        expect(contact.position).not.toBeNull();
        expect(contact.motion).toBeNull();
        expect(contact.motionReason).toBe('true-reference-unknown');
    });
    it('uses independently reported zero vectors without inventing either missing course', () => {
        const ship = own();
        ship.heading = null;
        ship.motion = { sogKn: 0, sogAt: T, cogTrueDeg: null, cogAt: null };
        const contact = qualifyRadarReport(parse(ttm({ 4: 'T', 5: '0', 6: '' }))!, ship, T);
        expect(contact.motion).toEqual({ sogKn: 0, cogTrueDeg: null, at: T });
    });
    it.each(['position', 'heading', 'sogAt', 'cogAt', 'other-feed'] as const)(
        'refuses stale/mismatched %s dependencies',
        (bad) => {
            const ship = own();
            if (bad === 'position' || bad === 'heading') ship[bad]!.at = T - 6001;
            else if (bad === 'other-feed') ship.feedId = 'another-vessel';
            else ship.motion![bad] = T - 6001;
            const contact = qualifyRadarReport(parse(ttm())!, ship, T);
            expect(contact.motion).toBeNull();
            expect(contact.motionReason).toBe('dependencies-stale');
        },
    );
    it('retains the earliest dependency clock; repeated polls cannot extend freshness', () => {
        const ship = own();
        ship.heading!.at = T - 5000;
        const report = parse(ttm())!;
        expect(qualifyRadarReport(report, ship, T).qualifiedAt).toBe(T - 5000);
        expect(qualifyRadarReport(report, ship, T + 10_001).motion).toBeNull();
        const aged = qualifyRadarReport(report, ship, T + 16_000);
        expect(aged.fresh).toBe(false);
        expect(aged.at).toBe(T);
        expect(aged.motion).toBeNull();
    });
    it('keeps acquired/lost/reference echoes out of motion qualification', () => {
        for (const report of [parse(ttm({ 12: 'Q' }))!, parse(ttm({ 12: 'L' }))!, parse(ttm({ 13: 'R' }))!]) {
            const contact = qualifyRadarReport(report, own(), T);
            expect(contact.motion).toBeNull();
            expect(contact.qualifiedAt).toBeNull();
            expect(contact.motionReason).toBe('not-tracking');
        }
    });
    it('does not mutate raw reports or borrow a TLL motion from another observation', () => {
        const report = parse(ttm())!;
        const before = structuredClone(report);
        qualifyRadarReport(report, own(), T);
        expect(report).toEqual(before);
        const tllReport = parse(tll()) as RadarReport;
        expect(qualifyRadarReport(tllReport, own(), T).motion).toBeNull();
    });
});
