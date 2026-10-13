/**
 * official-alerts-watch's decisions (129-06): which official warnings in force
 * at each boat go to its lock screen, when, and how often.
 *
 * - Marine and coastal warnings push; land types and unknown events stay in
 *   the app. Severe and Extreme (a marine warning, a tsunami) go at once, day
 *   or night. Moderate and Minor (a Small Craft Advisory) wait out
 *   22:00-07:00 on the boat's own clock, unless they begin within 3 h, and the
 *   "Small craft advisories" switch mutes them.
 * - Each boat gets each warning once (official_alert_deliveries). An update
 *   to a warning it was told about replaces that notification quietly (same
 *   collapse id, no sound) unless the severity rises above the last one it
 *   was told, which buzzes again. NWS's chain is its VTEC event, as NWS
 *   sends a continuing event as a fresh Alert with no references; a message
 *   that ends or replaces the event (CAN, EXP, UPG) never sounds or starts
 *   a notification of its own.
 * - The payload names the issuer's warning and the basis it was decided on,
 *   never a coordinate.
 * - The reads behind it (watchReads.ts) are never cut short by PostgREST's
 *   1000-row cap: one match row per boat, and every page of the deliveries.
 * Boats are found the way cyclone-watch finds them (resolveBoat), with this
 * switch instead of the cyclone one.
 */
import tzLookup from 'tz-lookup';
import { describe, expect, it } from 'vitest';
import {
    chainKeyFor,
    decideOfficialPushes,
    nwsVtec,
    officialWatchBoat,
    ONSET_SOON_MS,
    type PriorDelivery,
    type WatchAlert,
    type WatchedBoat,
} from '../supabase/functions/_shared/official-alerts/watch';
import {
    matchBoats,
    MATCH_BOATS,
    PAGE_ROWS,
    readAllRows,
    readPriorDeliveries,
} from '../supabase/functions/_shared/official-alerts/watchReads';
import type { StoredInfo } from '../supabase/functions/_shared/official-alerts/normalize';

const H = 3_600_000;
const BAY = { lat: 39.123456, lon: -76.654321 };
/** 02:00 at the boat (EDT, UTC-4). */
const NIGHT = Date.parse('2026-10-14T06:00:00Z');
/** 07:05 at the boat. */
const MORNING = Date.parse('2026-10-14T11:05:00Z');
/** 14:00 at the boat. */
const DAY = Date.parse('2026-10-14T18:00:00Z');

function info(over: Partial<StoredInfo> = {}): StoredInfo {
    return {
        language: 'en-US',
        category: ['Met'],
        event: 'Small Craft Advisory',
        urgency: 'Expected',
        severity: 'Minor',
        certainty: 'Likely',
        effective: null,
        onset: null,
        expires: null,
        ends: null,
        senderName: 'NWS Zzbaytown MD',
        headline: 'Small Craft Advisory issued October 14 by NWS Zzbaytown MD (fictional)',
        description: 'Fictional text.',
        instruction: null,
        web: null,
        contact: null,
        responseType: [],
        areaDesc: ['Fictional Bay'],
        parameters: [],
        eventCodes: [{ valueName: 'NationalWeatherService', value: 'SCY' }],
        ...over,
    };
}

let nextId = 100;
function alert(over: Partial<WatchAlert> = {}, infoOver: Partial<StoredInfo> = {}): WatchAlert {
    const id = nextId++;
    return {
        id,
        provider: 'nws',
        identifier: `urn:oid:2.49.0.1.840.0.zz${id}.001.1`,
        refs: [],
        zones: ['nws:forecast:ANZ531'],
        sentAt: '2026-10-14T03:30:00Z',
        onsetAt: '2026-10-14T17:00:00Z',
        effectiveAt: '2026-10-14T03:30:00Z',
        expiresAt: '2026-10-15T02:00:00Z',
        infos: [info(infoOver)],
        attribution: 'Warnings: National Weather Service (NOAA)',
        ...over,
    };
}
const gale = (over: Partial<WatchAlert> = {}) =>
    alert(over, {
        event: 'Gale Warning',
        severity: 'Moderate',
        headline: 'Gale Warning issued October 14 by NWS Zzbaytown MD (fictional)',
        eventCodes: [{ valueName: 'NationalWeatherService', value: 'GLW' }],
    });

const boat = (userId = 'u1', advisories = true): WatchedBoat => ({ userId, position: BAY, basis: 'fix', advisories });

function run(alerts: WatchAlert[], nowMs: number, prior: PriorDelivery[] = [], boats = [boat()]) {
    return decideOfficialPushes({
        boats,
        matches: new Map(boats.map((b) => [b.userId, alerts])),
        prior,
        nowMs,
        zoneAt: tzLookup,
    });
}

describe('when a warning goes', () => {
    it('a Severe warning goes at once at 02:00 at the boat', () => {
        const out = run([gale()], NIGHT);
        expect(out.sends).toHaveLength(1);
        expect(out.sends[0].push).toMatchObject({
            userId: 'u1',
            type: 'official_warning',
            title: 'Gale Warning',
            data: { provider: 'nws', severity: 'Severe', silent: false },
        });
        expect(out.held).toBe(0);
    });

    it('a Small Craft Advisory issued at night waits until 07:00 at the boat', () => {
        const sca = alert();
        expect(run([sca], NIGHT)).toMatchObject({ sends: [], held: 1 });
        const morning = run([sca], MORNING);
        expect(morning.sends).toHaveLength(1);
        expect(morning.sends[0].push.data).toMatchObject({ severity: 'Minor', silent: false });
    });

    it('unless it begins within 3 h, or is already in effect', () => {
        expect(ONSET_SOON_MS).toBe(3 * H);
        const soon = alert({ onsetAt: new Date(NIGHT + 2 * H).toISOString() });
        expect(run([soon], NIGHT).sends).toHaveLength(1);
        const already = alert({ onsetAt: new Date(NIGHT - 5 * H).toISOString() });
        expect(run([already], NIGHT).sends).toHaveLength(1);
        const later = alert({ onsetAt: new Date(NIGHT + 4 * H).toISOString() });
        expect(run([later], NIGHT).sends).toHaveLength(0);
    });

    it('a tsunami goes at once as Extreme, whatever the feed says', () => {
        const tsunami = alert({}, { event: 'Tsunami Advisory', category: ['Geo'], severity: 'Minor', eventCodes: [] });
        const out = run([tsunami], NIGHT);
        expect(out.sends[0].push.data).toMatchObject({ severity: 'Extreme', silent: false });
    });

    it('another language block can say what the warning is when the English one cannot', () => {
        const bilingual = alert(
            {},
            {
                language: 'en-US',
                event: 'Zz Marine Notice',
                headline: 'Zz Marine Notice (fictional)',
                eventCodes: [],
            },
        );
        bilingual.infos.push(
            info({ language: 'es-US', event: 'Advertencia para Embarcaciones Pequeñas', eventCodes: [] }),
        );
        const [send] = run([bilingual], DAY).sends;
        expect(send.push.title).toBe('Zz Marine Notice');
        expect(send.push.data.severity).toBe('Minor');
    });

    it('land types and unknown events are never pushed', () => {
        const tornado = alert({}, { event: 'Tornado Warning', severity: 'Extreme', eventCodes: [] });
        const unknown = alert({}, { event: 'Zz Fictional Notice', severity: 'Extreme', eventCodes: [] });
        expect(run([tornado, unknown], DAY).sends).toEqual([]);
    });

    it('the Small craft advisories switch mutes advisories, never a warning', () => {
        const out = run([alert(), gale()], DAY, [], [boat('u1', false)]);
        expect(out.sends.map((s) => s.push.title)).toEqual(['Gale Warning']);
    });
});

describe('once per boat per warning', () => {
    const delivered = (
        a: WatchAlert,
        userId = 'u1',
        severity = 'Minor',
        chainKey = 'aaaaaaaaaaaaaaaa',
        deliveredAt = '2026-10-14T01:00:00Z',
    ): PriorDelivery => ({
        userId,
        alertId: a.id,
        provider: a.provider,
        identifier: a.identifier,
        refs: a.refs,
        chainKey,
        severity,
        deliveredAt,
    });

    it('a warning already delivered is not sent again', () => {
        const sca = alert();
        expect(run([sca], DAY, [delivered(sca)]).sends).toEqual([]);
    });

    it('each boat gets its own', () => {
        const g = gale();
        const out = run([g], DAY, [delivered(g, 'u1', 'Severe')], [boat('u1'), boat('u2')]);
        expect(out.sends.map((s) => s.push.userId)).toEqual(['u2']);
    });

    it('records each delivery with its chain and severity', () => {
        const g = gale();
        const [send] = run([g], DAY).sends;
        expect(send.delivery).toEqual({
            user_id: 'u1',
            alert_id: g.id,
            channel: 'push',
            provider_id: 'nws',
            identifier: g.identifier,
            refs: [],
            chain_key: expect.stringMatching(/^[0-9a-f]{16}$/),
            severity: 'Severe',
            silent: false,
        });
        expect(send.push.data.collapse).toBe(`nws:${send.delivery.chain_key}`);
    });

    it('an update replaces the earlier notification quietly: same collapse id, no buzz, even at night', () => {
        const first = alert();
        const update = alert({ refs: [first.identifier], sentAt: '2026-10-14T05:30:00Z' });
        const out = run([update], NIGHT, [delivered(first, 'u1', 'Minor', '0123456789abcdef')]);
        expect(out.sends).toHaveLength(1);
        expect(out.sends[0].push.data).toMatchObject({ collapse: 'nws:0123456789abcdef', silent: true });
        expect(out.sends[0].delivery).toMatchObject({ chain_key: '0123456789abcdef', silent: true });
    });

    it('an update that names an older message of the same chain finds it too', () => {
        const root = alert();
        const second = alert({ refs: [root.identifier] });
        const third = alert({ refs: [root.identifier] });
        const out = run([third], DAY, [delivered(second, 'u1', 'Minor', 'fedcba9876543210')]);
        expect(out.sends[0].push.data).toMatchObject({ collapse: 'nws:fedcba9876543210', silent: true });
    });

    it('a rise in severity buzzes again under the same collapse id, at once', () => {
        const sca = alert();
        const upgraded = gale({ refs: [sca.identifier] });
        const out = run([upgraded], NIGHT, [delivered(sca, 'u1', 'Minor', '0123456789abcdef')]);
        expect(out.sends[0].push.data).toMatchObject({
            collapse: 'nws:0123456789abcdef',
            severity: 'Severe',
            silent: false,
        });
    });

    it('two runs of the same warning give the same collapse id to the same boat', () => {
        const g = gale();
        expect(run([g], DAY).sends[0].push.data.collapse).toBe(run([g], DAY + H).sends[0].push.data.collapse);
    });

    it('a rise sounds against the last one told, not the strongest: Severe, Moderate, then Severe again', () => {
        // A chain linked by its Update references (no VTEC), whose feed severity falls and rises.
        const advisory = (refs: string[], severity: 'Severe' | 'Moderate', at: string) =>
            alert({ refs, sentAt: at }, { severity, headline: `Small Craft Advisory, ${severity} (fictional)` });
        const first = advisory([], 'Severe', '2026-10-14T01:00:00Z');
        const down = advisory([first.identifier], 'Moderate', '2026-10-14T03:00:00Z');
        const up = advisory([down.identifier], 'Severe', '2026-10-14T05:00:00Z');
        const told = [
            delivered(first, 'u1', 'Severe', '1111111111111111', '2026-10-14T01:02:00Z'),
            delivered(down, 'u1', 'Moderate', '1111111111111111', '2026-10-14T03:02:00Z'),
        ];
        // The lock screen shows the Moderate one: back up to Severe sounds, under the same collapse id.
        const out = run([up], NIGHT, told);
        expect(out.sends).toHaveLength(1);
        expect(out.sends[0].push.data).toMatchObject({ collapse: 'nws:1111111111111111', silent: false });
        expect(out.sends[0].delivery.severity).toBe('Severe');
        // Whatever order the rows come back in.
        expect(run([up], NIGHT, [...told].reverse()).sends[0].push.data.silent).toBe(false);
        // The downgrade itself was quiet, and is recorded as what it told: Moderate.
        const quiet = run([down], NIGHT, [told[0]]);
        expect(quiet.sends[0].push.data.silent).toBe(true);
        expect(quiet.sends[0].delivery.severity).toBe('Moderate');
    });
});

describe('NWS chains by its VTEC event', () => {
    const vtecInfo = (action: string, phen = 'SC', sig = 'Y', etn = '0073', office = 'KZZZ') => ({
        parameters: [
            { valueName: 'VTEC', value: `/O.${action}.${office}.${phen}.${sig}.${etn}.000000T0000Z-261015T2000Z/` },
        ],
    });
    const sca = (action: string, over: Partial<WatchAlert> = {}, etn = '0073') =>
        alert({ refs: [], ...over }, vtecInfo(action, 'SC', 'Y', etn));
    const told = (a: WatchAlert, severity = 'Minor', event = 'KZZZ.SC.Y.0073'): PriorDelivery => ({
        userId: 'u1',
        alertId: a.id,
        provider: 'nws',
        identifier: a.identifier,
        refs: a.refs,
        chainKey: chainKeyFor('nws', `vtec:${event}`),
        severity,
        deliveredAt: '2026-10-14T01:00:00Z',
    });

    it('reads the action and the event: office, phenomenon, significance, number', () => {
        expect(nwsVtec([info(vtecInfo('CON'))])).toEqual({ action: 'CON', event: 'KZZZ.SC.Y.0073' });
        expect(nwsVtec([info({ parameters: [{ valueName: 'VTEC', value: '/T.NEW.KZZZ.SC.Y.0001.x/' }] })])).toBeNull();
        expect(nwsVtec([info()])).toBeNull();
    });

    it('a continuing event sent as a fresh Alert with no references replaces the notification quietly', () => {
        const first = sca('NEW');
        const out = run([sca('CON', { sentAt: '2026-10-14T05:00:00Z' })], NIGHT, [told(first)]);
        expect(out.sends).toHaveLength(1);
        expect(out.sends[0].push.data).toMatchObject({
            collapse: `nws:${chainKeyFor('nws', 'vtec:KZZZ.SC.Y.0073')}`,
            silent: true,
        });
        // So does an extension in area (EXB), and the same event's message for the next zone.
        expect(run([sca('EXB')], NIGHT, [told(first)]).sends[0].push.data.silent).toBe(true);
        const two = run(
            [sca('CON', { zones: ['nws:forecast:ANZ531'] }), sca('CON', { zones: ['nws:forecast:ANZ532'] })],
            DAY,
        );
        expect(two.sends.map((s) => s.push.data.silent)).toEqual([false, true]);
        expect(new Set(two.sends.map((s) => s.push.data.collapse)).size).toBe(1);
    });

    it('a boat first told of a continuing event is told, with a sound', () => {
        const out = run([sca('CON')], DAY);
        expect(out.sends).toHaveLength(1);
        expect(out.sends[0].push.data.silent).toBe(false);
    });

    it('"has been replaced" (UPG), cancelled (CAN) or expired (EXP) never starts a notification or sounds', () => {
        for (const action of ['UPG', 'CAN', 'EXP']) {
            const ending = sca(action, {}, '0075');
            // Nothing told of the event: nothing sent, nothing held.
            expect(run([ending], DAY)).toEqual({ sends: [], held: 0 });
            // Told of it: the notification is replaced, quietly.
            const out = run([ending], DAY, [told(sca('NEW', {}, '0075'), 'Minor', 'KZZZ.SC.Y.0075')]);
            expect(out.sends).toHaveLength(1);
            expect(out.sends[0].push.data.silent).toBe(true);
        }
    });

    it('an upgrade to a gale is its own event: a new notification, with a sound, at once', () => {
        const advisory = sca('NEW');
        const galeNew = alert(
            { refs: [advisory.identifier] },
            {
                event: 'Gale Warning',
                severity: 'Moderate',
                eventCodes: [],
                ...vtecInfo('NEW', 'GL', 'W', '0012'),
            },
        );
        const out = run([galeNew, sca('UPG')], NIGHT, [told(advisory)]);
        const [g, replaced] = out.sends;
        expect(g.push.title).toBe('Gale Warning');
        expect(g.push.data).toMatchObject({ severity: 'Severe', silent: false });
        expect(g.push.data.collapse).toBe(`nws:${chainKeyFor('nws', 'vtec:KZZZ.GL.W.0012')}`);
        expect(replaced.push.data).toMatchObject({
            collapse: `nws:${chainKeyFor('nws', 'vtec:KZZZ.SC.Y.0073')}`,
            silent: true,
        });
    });
});

describe('the reads are never cut short by PostgREST’s 1000-row cap', () => {
    /** A table read as PostgREST answers one: the requested range, never more than `cap` rows. */
    const capped = <T>(rows: T[], cap = PAGE_ROWS) => {
        const calls: Array<[number, number]> = [];
        const page = (from: number, to: number) => {
            calls.push([from, to]);
            return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), error: null });
        };
        return { page, calls };
    };

    it('reads every page of the deliveries, at the hosted cap or a smaller one', async () => {
        // 200 accounts with 12 deliveries each (an advisory chain updated 4 times a day, kept 24 h, and a gale's).
        const users = Array.from({ length: 200 }, (_, i) => `u${i}`);
        const rows = users.flatMap((user_id, u) =>
            Array.from({ length: 12 }, (_, j) => ({
                user_id,
                alert_id: u * 100 + j,
                provider_id: 'nws',
                identifier: `urn:oid:2.49.0.1.840.0.zz${u}.${j}`,
                refs: [],
                chain_key: '0123456789abcdef',
                severity: 'Minor',
                delivered_at: '2026-10-14T01:00:00Z',
            })),
        );
        for (const cap of [PAGE_ROWS, 500]) {
            const db = capped(rows, cap);
            const prior = await readPriorDeliveries(users, (_ids, from, to) => db.page(from, to));
            expect(prior).toHaveLength(2400);
            expect(new Set(prior.map((p) => p.userId)).size).toBe(200);
            expect(db.calls.every(([from, to]) => to - from + 1 <= PAGE_ROWS)).toBe(true);
        }
        // A failed page fails the run: never a delivery list read as complete when it is not.
        await expect(
            readAllRows(() => Promise.resolve({ data: null, error: { message: 'boom' } }), 'delivery'),
        ).rejects.toThrow('delivery read failed');
    });

    it('matches 500 boats under 4 warnings each in one call, every warning kept', async () => {
        const boats = Array.from({ length: 600 }, (_, i) => ({ userId: `u${i}`, position: BAY }));
        const calls: number[] = [];
        const out = await matchBoats(boats, (points) => {
            calls.push(points.length);
            // The function's answer: one row per point, its warnings as an array (500 rows, under the cap).
            const rows = points.map((p) => ({ k: p.k, alert_ids: [1, 2, 3, 4] }));
            return Promise.resolve({ data: rows.slice(0, PAGE_ROWS), error: null });
        });
        expect(calls).toEqual([MATCH_BOATS, 100]);
        expect(out.size).toBe(600);
        expect([...out.values()].every((ids) => ids.size === 4)).toBe(true);
        // A reply with more rows than boats (one row per warning) is refused, never half read.
        await expect(
            matchBoats(boats.slice(0, 2), () =>
                Promise.resolve({
                    data: [
                        { k: 0, alert_id: 1 },
                        { k: 0, alert_id: 2 },
                        { k: 1, alert_id: 1 },
                    ],
                    error: null,
                }),
            ),
        ).rejects.toThrow('match answered more rows than boats');
        // The positions go to the match and nowhere else: each point is its index and its position.
        await matchBoats([{ userId: 'a', position: BAY }], (points) => {
            expect(points).toEqual([{ k: 0, lat: BAY.lat, lon: BAY.lon }]);
            return Promise.resolve({ data: [], error: null });
        });
    });
});

describe('the push', () => {
    it('carries the issuer’s words, its expiry and no coordinate', () => {
        const g = gale();
        const [send] = run([g], DAY).sends;
        expect(send.push.title).toBe('Gale Warning');
        expect(send.push.body).toBe(
            'Gale Warning issued October 14 by NWS Zzbaytown MD (fictional)\nWarnings: National Weather Service (NOAA)',
        );
        expect(send.push.data).toEqual({
            provider: 'nws',
            identifier: g.identifier,
            basis: 'fix',
            collapse: expect.stringMatching(/^nws:[0-9a-f]{16}$/),
            severity: 'Severe',
            expires: '2026-10-15T02:00:00Z',
            silent: false,
            event: 'Gale Warning',
        });
        const all = JSON.stringify(send.push);
        for (const digits of ['39.12', '76.65', '39.1', '-76.6']) expect(all).not.toContain(digits);
        expect(all).not.toMatch(/"(lat|lon|latitude|longitude|position)"/);
    });

    it('drops the credit rather than cut a long headline, and stays within 500 characters', () => {
        const headline = `Gale Warning ${'with a very long fictional headline '.repeat(14)}`.trim();
        const [send] = run([gale({ infos: [info({ event: 'Gale Warning', headline, eventCodes: [] })] })], DAY).sends;
        expect(send.push.body.length).toBeLessThanOrEqual(500);
        expect(send.push.body).not.toContain('Warnings: National Weather Service');
    });

    it('reads the English block of a bilingual warning, else the issuer’s first', () => {
        const eccc = alert(
            {
                provider: 'eccc',
                attribution:
                    'Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada',
                infos: [
                    info({
                        language: 'fr-CA',
                        event: 'coup de vent',
                        severity: 'Moderate',
                        headline: 'avertissement de coup de vent en vigueur',
                        eventCodes: [{ valueName: 'profile:CAP-CP:Event:0.4', value: 'gale' }],
                    }),
                    info({
                        language: 'en-CA',
                        event: 'gale',
                        severity: 'Moderate',
                        headline: 'gale warning in effect',
                        eventCodes: [{ valueName: 'profile:CAP-CP:Event:0.4', value: 'gale' }],
                    }),
                ],
            },
            {},
        );
        const [send] = run([eccc], DAY).sends;
        expect(send.push.title).toBe('gale');
        expect(send.push.body.startsWith('gale warning in effect\n')).toBe(true);
    });
});

describe('the boats', () => {
    const fresh = new Date(DAY - H).toISOString();
    it('are found as cyclone-watch finds them, with their own switch', () => {
        expect(officialWatchBoat('u', { settings: {}, telemetry: { ...BAY, at: fresh } }, DAY)).toEqual({
            userId: 'u',
            position: BAY,
            basis: 'fix',
            advisories: true,
        });
        // The cyclone switch is its own; it does not stop official warnings.
        expect(
            officialWatchBoat('u', { settings: { cycloneWarnings: false }, telemetry: { ...BAY, at: fresh } }, DAY),
        ).not.toBeNull();
        expect(
            officialWatchBoat(
                'u',
                { settings: { officialMarineWarnings: false }, telemetry: { ...BAY, at: fresh } },
                DAY,
            ),
        ).toBeNull();
        expect(
            officialWatchBoat('u', { settings: { smallCraftAdvisories: false }, telemetry: { ...BAY, at: fresh } }, DAY)
                ?.advisories,
        ).toBe(false);
        expect(officialWatchBoat('u', { settings: { homePort: 'Zzbaytown (39.1, -76.4)' } }, DAY)).toMatchObject({
            basis: 'home',
        });
    });
});
