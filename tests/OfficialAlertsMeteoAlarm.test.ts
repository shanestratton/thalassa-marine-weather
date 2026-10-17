/**
 * Europe's warnings under MeteoAlarm's own terms (129-05b). MeteoAlarm's Terms
 * and Conditions (https://meteoalarm.org/en/live/page/terms-and-conditions,
 * last updated 15/03/2024, read 2026-10-14) allow redistribution under terms
 * equivalent to CC BY 4.0, plus six rules; its Style Guide v1.0 (February 2026)
 * says how a warning is shown. Each is held here:
 *
 * - Real time: the delay from MeteoAlarm to Thalassa averages under 5 minutes
 *   and is never over 10. Every MeteoAlarm feed is read on every 5-minute run,
 *   first, never sharded or deferred, and one feed's failure never delays
 *   another (a simulated hour of 12 runs, 39 feeds and 30 other providers).
 * - Placement: the hub's EMMA_ID outlines (Geocodes JSON) load into
 *   official_alert_zones per country; a warning at Marseille, Hamburg and
 *   Athens names an outline that holds the city; an updated outline is sent
 *   again and a removed one is dropped, never more than half a country's at
 *   once without saying so.
 * - Source: the national service for one country, "EUMETNET – MeteoAlarm" for
 *   more than one; the issue time; the www.meteoalarm.org link; and the
 *   disclaimer, byte for byte.
 * - What may push: coastal events and marine hazards (and a warning its
 *   issuer marks for the sea), never land types; a yellow one as an advisory.
 * Every fixture is fictional (names with "Zz").
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    ADAPTERS,
    type Adapter,
    type AdapterName,
    type Http,
    HttpError,
    type HttpResult,
    type Known,
    METEOALARM_DOC_ACCEPT,
    parseMeteoAlarmAtom,
    parseRetryAfter,
    type ProviderRow,
} from '../supabase/functions/_shared/official-alerts/adapters';
import {
    type AlertStore,
    type ChangeSet,
    createHttp,
    isRealtime,
    PROVIDER_TIMEOUT_MS,
    REALTIME_APP_MS,
    REALTIME_LIVE_MS,
    RUN_BUDGET_MS,
    RUN_PERIOD_MS,
    runIngest,
    shardFor,
} from '../supabase/functions/_shared/official-alerts/ingest';
import type { NormalizedAlert, StoredInfo } from '../supabase/functions/_shared/official-alerts/normalize';
import {
    METEOALARM_DISCLAIMER,
    METEOALARM_LINK,
    METEOALARM_LINK_TEXT,
    METEOALARM_PARTICIPANTS,
    METEOALARM_SOURCE,
    meteoAlarmCountries,
    meteoAlarmIssuerNames,
    meteoAlarmParticipant,
    meteoAlarmParticipants,
    meteoAlarmSource,
    meteoAlarmTitle,
} from '../supabase/functions/_shared/official-alerts/meteoalarm';
import {
    meteoAlarmGeocodeZones,
    planZoneSync,
    zoneSyncCalls,
} from '../supabase/functions/_shared/official-alerts/geocodes';
import { classifyOfficialEvent, officialPushClass } from '../supabase/functions/_shared/official-alerts/classify';
import {
    decideOfficialPushes,
    officialPushText,
    type WatchAlert,
} from '../supabase/functions/_shared/official-alerts/watch';

const fixture = (name: string) => readFileSync(`tests/fixtures/official-alerts/${name}`, 'utf8');
const MIN = 60_000;
/** The top of a fictional hour; the ingest cron runs at :02, :07 ... :57 (2-59/5). */
const H0 = Date.parse('2026-10-14T09:00:00Z');

/** The 39 member feeds the held migration seeds (slug, as feeds.meteoalarm.org names them). */
const COUNTRIES: Array<[string, string]> = [
    ['ad', 'andorra'],
    ['at', 'austria'],
    ['be', 'belgium'],
    ['ba', 'bosnia-herzegovina'],
    ['bg', 'bulgaria'],
    ['hr', 'croatia'],
    ['cy', 'cyprus'],
    ['cz', 'czechia'],
    ['dk', 'denmark'],
    ['ee', 'estonia'],
    ['fi', 'finland'],
    ['fr', 'france'],
    ['de', 'germany'],
    ['gr', 'greece'],
    ['hu', 'hungary'],
    ['is', 'iceland'],
    ['ie', 'ireland'],
    ['il', 'israel'],
    ['it', 'italy'],
    ['lv', 'latvia'],
    ['lt', 'lithuania'],
    ['lu', 'luxembourg'],
    ['mt', 'malta'],
    ['md', 'moldova'],
    ['me', 'montenegro'],
    ['nl', 'netherlands'],
    ['no', 'norway'],
    ['pl', 'poland'],
    ['pt', 'portugal'],
    ['mk', 'republic-of-north-macedonia'],
    ['ro', 'romania'],
    ['rs', 'serbia'],
    ['sk', 'slovakia'],
    ['si', 'slovenia'],
    ['es', 'spain'],
    ['se', 'sweden'],
    ['ch', 'switzerland'],
    ['ua', 'ukraine'],
    ['gb', 'united-kingdom'],
];
const FEED = (slug: string) => `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${slug}`;
const DOC = (slug: string, n: number) =>
    `https://feeds.meteoalarm.org/api/v1/warnings/feeds-${slug}/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const row = (over: Partial<ProviderRow>): ProviderRow => ({
    id: 'x',
    adapter: 'cap',
    name: 'x',
    feedUrl: null,
    enabled: true,
    config: {},
    feedState: {},
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    unavailableSince: null,
    ...over,
});
const meteoRows = () =>
    COUNTRIES.map(([code, slug]) =>
        row({ id: `meteoalarm-${code}`, adapter: 'meteoalarm', feedUrl: FEED(slug), config: { country: code } }),
    );

/** A fictional warning as MeteoAlarm lists it (one Atom entry) and serves it (one CAP document). */
interface Published {
    slug: string;
    n: number;
    at: number;
    expiresAt: number;
}
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', '+00:00');
const idOf = (p: Published) => `2.49.0.0.999.0.ZZ.${p.slug}.${p.n}`;

function atomOf(slug: string, list: Published[]): string {
    const entries = list
        .map(
            (p) => `
  <entry>
    <cap:geocode><valueName>EMMA_ID</valueName><value>ZZ${String(p.n).padStart(3, '0')}</value></cap:geocode>
    <cap:areaDesc>Zzarea ${p.n}</cap:areaDesc>
    <cap:event>wind</cap:event>
    <cap:sent>${iso(p.at)}</cap:sent>
    <cap:expires>${iso(p.expiresAt)}</cap:expires>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>${idOf(p)}</cap:identifier>
    <link type="application/cap+xml" href="${DOC(slug, p.n)}"/>
    <id>${DOC(slug, p.n)}?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Wind Warning issued for Zzland - Zzarea ${p.n}</title>
    <updated>${iso(p.at)}</updated>
  </entry>`,
        )
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <id>tag:meteoalarm.org,2021-02-19:ZZ</id>
  <title>MeteoAlarm - fictional fixture</title>
  <updated>${iso(H0)}</updated>${entries}
</feed>`;
}

function capOf(p: Published): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${idOf(p)}</identifier>
  <sender>zz@zzmet.example</sender>
  <sent>${iso(p.at)}</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>en-GB</language>
    <category>Met</category>
    <event>Yellow wind warning</event>
    <responseType>Monitor</responseType>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <onset>${iso(p.at)}</onset>
    <expires>${iso(p.expiresAt)}</expires>
    <senderName>Zz Met Service</senderName>
    <headline>Fictional wind warning ${p.n} (test text)</headline>
    <description>Invented test text.</description>
    <parameter><valueName>awareness_level</valueName><value>2; yellow; Moderate</value></parameter>
    <parameter><valueName>awareness_type</valueName><value>1; Wind</value></parameter>
    <area>
      <areaDesc>Zzarea ${p.n}</areaDesc>
      <geocode><valueName>EMMA_ID</valueName><value>ZZ${String(p.n).padStart(3, '0')}</value></geocode>
    </area>
  </info>
</alert>`;
}

/**
 * official_alerts_apply()'s rules in memory, with the time each alert was first stored: `now`, or, with
 * `step`, the run's start plus `step` for each MeteoAlarm country written before it in this run (the
 * k-th country to finish is written at start + k * step).
 */
class Store implements AlertStore {
    rows = new Map<string, { alert: NormalizedAlert; live: boolean; storedAt: number }>();
    now = 0;
    step = 0;
    private written = 0;
    constructor(public list: ProviderRow[]) {}
    startRun(at: number) {
        this.now = at;
        this.written = 0;
    }
    async providers() {
        return this.list.map((p) => ({ ...p, feedState: structuredClone(p.feedState) }));
    }
    async known(providerId: string) {
        const out = new Map<string, Known>();
        for (const [key, r] of this.rows) {
            const [p, id] = key.split('\u0000');
            if (p === providerId)
                out.set(id, { hash: r.alert.contentHash, live: r.live, expiresAt: r.alert.expiresAt });
        }
        return out;
    }
    async missingZones() {
        return [];
    }
    async apply(providerId: string, change: ChangeSet) {
        const at = this.step && providerId.startsWith('meteoalarm-') ? this.now + ++this.written * this.step : this.now;
        for (const a of change.upserts) {
            const key = `${providerId}\u0000${a.identifier}`;
            const prior = this.rows.get(key);
            if (prior && prior.alert.contentHash === a.contentHash && prior.live) continue;
            this.rows.set(key, { alert: a, live: true, storedAt: prior?.storedAt ?? at });
        }
        for (const id of change.withdraw) {
            const r = this.rows.get(`${providerId}\u0000${id}`);
            if (r) r.live = false;
        }
        if (change.status) Object.assign(this.list.find((p) => p.id === providerId)!, change.status);
    }
}

/** Whether an Accept header lets feeds.meteoalarm.org answer: it sends text/xml, and 406 unless any type is allowed. */
const admitsAny = (accept: string | undefined) =>
    accept === undefined || accept.split(',').some((t) => t.trim().split(';')[0] === '*/*');

/**
 * MeteoAlarm as it stood at `now`: each feed lists what was published by then; documents for all of it.
 * As the real host does, a request whose Accept does not admit any type is refused with 406.
 */
function meteoAlarmWorld(
    published: Published[],
    fail: (url: string, now: number) => string | HttpError | null = () => null,
) {
    const fetched: Array<{ url: string; at: number }> = [];
    let now = 0;
    const http: Http = {
        async get(url, opts): Promise<HttpResult> {
            fetched.push({ url, at: now });
            const failure = fail(url, now);
            if (failure) throw typeof failure === 'string' ? new Error(failure) : failure;
            if (!admitsAny(opts?.accept)) throw new HttpError(406);
            for (const [, slug] of COUNTRIES) {
                if (url === FEED(slug)) {
                    const listed = published.filter((p) => p.slug === slug && p.at <= now && p.expiresAt > now);
                    return { status: 'ok', text: atomOf(slug, listed), validators: {} };
                }
            }
            const doc = published.find((p) => DOC(p.slug, p.n) === url && p.at <= now);
            if (doc) return { status: 'ok', text: capOf(doc), validators: {} };
            throw new Error('HTTP 404');
        },
    };
    return { http, fetched, setNow: (ms: number) => (now = ms) };
}

/** A quick adapter for the other providers: answers at once with nothing new. */
const quiet: Adapter = {
    async run(ctx) {
        return {
            notModified: true,
            alerts: [],
            snapshot: null,
            present: new Set(),
            withdraw: [],
            feedState: ctx.provider.feedState,
            partial: null,
            zoneUrls: new Map(),
        };
    },
};
const others = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ id: `zzcap-${String(i).padStart(2, '0')}`, adapter: 'cap' }));

/** The MeteoAlarm countries in the order the ingest sorts them (the rotation counts in this order). */
const SORTED = meteoRows()
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b));
const slugOf = (id: string) => COUNTRIES.find(([c]) => `meteoalarm-${c}` === id)![1];

/**
 * Twelve cron runs (:02 ... :57) of the ingest, each started at its minute (and a thirteenth to read the
 * last); the warnings each published. A warning every minute of the hour, each in the next country, at :30
 * past the minute; and, at every run, one published a second after the run began in the country that run
 * reads first, which the next run's rotation reads last: the longest wait there is.
 *
 * `stepMs`: each MeteoAlarm country is written `stepMs` after the one before it, so the last of the 39 is
 * written 39 steps after the run's start, however its feed was read.
 */
async function simulatedHour(
    opts: { fail?: (url: string, now: number) => string | HttpError | null; stepMs?: number } = {},
) {
    const minutely: Published[] = Array.from({ length: 60 }, (_, m) => ({
        slug: COUNTRIES[m % COUNTRIES.length][1],
        n: m + 1,
        at: H0 + m * MIN + 30_000,
        expiresAt: H0 + 6 * 60 * MIN,
    }));
    const starts = Array.from({ length: 13 }, (_, k) => H0 + (2 + 5 * k) * MIN);
    const justMissed: Published[] = starts.slice(0, 12).map((start, k) => ({
        slug: slugOf(SORTED[Math.floor(start / RUN_PERIOD_MS) % SORTED.length]),
        n: 100 + k,
        at: start + 1_000,
        expiresAt: H0 + 6 * 60 * MIN,
    }));
    const published = [...minutely, ...justMissed];
    const world = meteoAlarmWorld(published, opts.fail);
    const store = new Store([...meteoRows(), ...others(30)]);
    store.step = opts.stepMs ?? 60_000 / 39;
    const adapters = { ...ADAPTERS, cap: quiet } as Record<AdapterName, Adapter>;
    const lastSuccess: Array<{ at: number; ages: number[] }> = [];
    for (const start of starts) {
        world.setNow(start);
        store.startRun(start);
        await runIngest({ store, http: world.http, nowMs: start, adapters, sleep: async () => undefined });
        // How old each country's last success is just before the next run writes again.
        const next = start + RUN_PERIOD_MS + 39 * store.step;
        lastSuccess.push({
            at: start,
            ages: store.list
                .filter(isRealtime)
                .map((p) => (p.lastSuccessAt ? next - Date.parse(p.lastSuccessAt) : Infinity)),
        });
    }
    const delays = published.map((p) => {
        const r = store.rows.get(`meteoalarm-${COUNTRIES.find(([, s]) => s === p.slug)![0]}\u0000${idOf(p)}`);
        return { p, delay: r ? r.storedAt - p.at : Infinity };
    });
    return { delays, store, world, published, justMissed, lastSuccess };
}

describe('real time: on average under 5 minutes, never over 10 (rule 5)', () => {
    it('reads every MeteoAlarm feed on every run, first, and shards only the rest', () => {
        const all = [...meteoRows(), ...others(30)];
        expect(meteoRows().every(isRealtime)).toBe(true);
        expect(others(1).some(isRealtime)).toBe(false);
        for (let slot = 0; slot < 6; slot++) {
            const chosen = shardFor(all, H0 + slot * RUN_PERIOD_MS);
            // All 39 feeds, every slot, ahead of the others.
            expect(
                chosen
                    .slice(0, 39)
                    .map((p) => p.id)
                    .sort(),
            ).toEqual(
                meteoRows()
                    .map((p) => p.id)
                    .sort(),
            );
            expect(chosen.slice(39).every((p) => !isRealtime(p))).toBe(true);
            expect(chosen.length - 39).toBeLessThanOrEqual(24);
        }
    });

    it('in a simulated hour every feed is read within 10 minutes, and each warning is on screen in under 10, under 5 on average', async () => {
        // A slow run: the 39 countries written one after another until the run's budget and one country's
        // whole timeout have gone (145 s), so the country read first in one run and last in the next waits
        // longest. Then the app's share: an answer is shown at most REALTIME_APP_MS after the database has it
        // (a minute's refresh and a 30-second cache, tests/OfficialWarningsPage.test.tsx).
        const slow = await simulatedHour({ stepMs: (RUN_BUDGET_MS + PROVIDER_TIMEOUT_MS) / 39 });
        for (const [, slug] of COUNTRIES) {
            const reads = slow.world.fetched.filter((f) => f.url === FEED(slug)).map((f) => f.at);
            expect(reads.length, slug).toBe(13);
            for (let i = 1; i < reads.length; i++) expect(reads[i] - reads[i - 1], slug).toBeLessThanOrEqual(10 * MIN);
        }
        // The country each run read first is read last by the next (the reviewer's 12:02:02 warning).
        for (const p of slow.justMissed) {
            const d = slow.delays.find((x) => x.p === p)!;
            expect(d.delay, p.slug).toBeGreaterThan(RUN_PERIOD_MS + 2 * MIN);
        }
        const onScreen = slow.delays.map((d) => d.delay + REALTIME_APP_MS);
        expect(Math.max(...onScreen)).toBeLessThan(10 * MIN);
        // A usual run (all 39 written within a minute; 15 s measured) and the app's average share, half its most.
        const usual = await simulatedHour();
        const mean = usual.delays.reduce((s, d) => s + d.delay + REALTIME_APP_MS / 2, 0) / usual.delays.length;
        expect(mean).toBeLessThan(5 * MIN);
    });

    it('a healthy country is written every run, so it reads live all hour; once the ingest stops it reads stopped within 8 minutes', async () => {
        const { lastSuccess, store } = await simulatedHour({ stepMs: (RUN_BUDGET_MS + PROVIDER_TIMEOUT_MS) / 39 });
        // official_alerts_at() calls a MeteoAlarm country live while its last success is under
        // REALTIME_LIVE_MS old: just before every next run writes, each one still is.
        for (const run of lastSuccess) {
            expect(run.ages).toHaveLength(39);
            expect(Math.max(...run.ages), new Date(run.at).toISOString()).toBeLessThan(REALTIME_LIVE_MS);
        }
        // The last success is the run's start (no later than the read), written by every run.
        const last = H0 + 62 * MIN;
        for (const p of store.list.filter(isRealtime)) expect(p.lastSuccessAt, p.id).toBe(new Date(last).toISOString());
        // The ingest stops after that run: 8 minutes on, every country is past the window, so it reads
        // "unavailable", never live with a stale all-clear.
        const live = (p: ProviderRow, now: number) =>
            !p.unavailableSince && !!p.lastSuccessAt && now - Date.parse(p.lastSuccessAt) < REALTIME_LIVE_MS;
        expect(store.list.filter(isRealtime).every((p) => live(p, last + REALTIME_LIVE_MS - 1_000))).toBe(true);
        expect(store.list.filter(isRealtime).some((p) => live(p, last + REALTIME_LIVE_MS))).toBe(false);
    });

    it('one feed that keeps failing never delays the others, and reads as unavailable', async () => {
        const { delays, store } = await simulatedHour({
            fail: (url) => (url === FEED('greece') ? 'HTTP 500' : null),
        });
        const rest = delays.filter((d) => d.p.slug !== 'greece').map((d) => d.delay);
        expect(Math.max(...rest)).toBeLessThan(10 * MIN);
        expect(rest.reduce((s, d) => s + d, 0) / rest.length).toBeLessThan(5 * MIN);
        expect(store.list.find((p) => p.id === 'meteoalarm-gr')!.unavailableSince).not.toBeNull();
    });

    it('a feed that answers 504 once is asked again in the same run; a 429 is never retried', async () => {
        const published: Published[] = [{ slug: 'france', n: 1, at: H0, expiresAt: H0 + 6 * 60 * MIN }];
        let calls504 = 0;
        const world = meteoAlarmWorld(published, (url) =>
            url === FEED('france') && calls504++ === 0 ? 'HTTP 504' : null,
        );
        const store = new Store(meteoRows().filter((p) => p.id === 'meteoalarm-fr'));
        world.setNow(H0 + 2 * MIN);
        const run = await runIngest({ store, http: world.http, nowMs: H0 + 2 * MIN, sleep: async () => undefined });
        expect(run.ran.find((r) => r.provider === 'meteoalarm-fr')).toMatchObject({ ok: true, upserts: 1 });
        expect(world.fetched.filter((f) => f.url === FEED('france'))).toHaveLength(2);

        const busy = meteoAlarmWorld([], (url) => (url === FEED('germany') ? 'HTTP 429' : null));
        const de = new Store(meteoRows().filter((p) => p.id === 'meteoalarm-de'));
        const told = await runIngest({ store: de, http: busy.http, nowMs: H0 + 2 * MIN, sleep: async () => undefined });
        expect(told.ran[0]).toMatchObject({ ok: false, error: 'HTTP 429' });
        expect(busy.fetched.filter((f) => f.url === FEED('germany'))).toHaveLength(1);
    });

    it('one country told to slow down stops every country’s requests to feeds.meteoalarm.org, and a Retry-After holds later runs', async () => {
        // Germany lists six new warnings; its documents answer 429 with Retry-After: 900.
        const published: Published[] = [
            ...[1, 2, 3, 4, 5, 6].map((n) => ({ slug: 'germany', n, at: H0, expiresAt: H0 + 6 * 60 * MIN })),
            { slug: 'france', n: 4, at: H0, expiresAt: H0 + 6 * 60 * MIN },
            { slug: 'italy', n: 5, at: H0, expiresAt: H0 + 6 * 60 * MIN },
        ];
        let busy = true;
        const world = meteoAlarmWorld(published, (url) =>
            busy && url.includes('/feeds-germany/') ? new HttpError(429, parseRetryAfter('900', H0)) : null,
        );
        const store = new Store(
            meteoRows().filter((p) => ['meteoalarm-de', 'meteoalarm-fr', 'meteoalarm-it'].includes(p.id)),
        );
        // One at a time, Germany first (this slot's rotation), so the order is the test's.
        const at = (k: number) => H0 + (2 + 5 * k) * MIN;
        const turn = (now: number) => Math.floor(now / RUN_PERIOD_MS) % 3;
        const k0 = [0, 1, 2].find((k) => turn(at(k)) === 0)!;
        const run = (k: number) => {
            world.setNow(at(k));
            world.fetched.length = 0;
            return runIngest({ store, http: world.http, nowMs: at(k), concurrency: 1, sleep: async () => undefined });
        };
        const first = await run(k0);
        // Germany: the four documents already asked for (four at a time), none after the 429; France and
        // Italy: nothing asked at all.
        expect(world.fetched.map((f) => f.url)).toEqual([
            FEED('germany'),
            ...[1, 2, 3, 4].map((n) => DOC('germany', n)),
        ]);
        expect(first.ran.find((r) => r.provider === 'meteoalarm-de')!.error).toBe('6 MeteoAlarm warnings not read yet');
        for (const id of ['meteoalarm-fr', 'meteoalarm-it']) {
            expect(first.ran.find((r) => r.provider === id)!.error, id).toMatch(/^waiting: feeds\.meteoalarm\.org/);
        }
        // Each reads unavailable, never live; the wait is kept for the next runs.
        for (const p of store.list) {
            expect(p.unavailableSince, p.id).not.toBeNull();
            expect(p.feedState.holdUntil, p.id).toBe(new Date(at(k0) + 900_000).toISOString());
        }
        // Five minutes on, inside the 15 minutes asked: nothing is requested of the host.
        busy = false;
        await run(k0 + 1);
        expect(world.fetched).toEqual([]);
        // After them: every country is read again, and the wait is forgotten.
        const after = await run(k0 + 3);
        expect(after.ran.every((r) => r.ok)).toBe(true);
        expect(world.fetched.filter((f) => f.url.startsWith('https://feeds.meteoalarm.org/api/'))).toHaveLength(8);
        for (const p of store.list) expect(p.feedState.holdUntil, p.id).toBeUndefined();
    });

    it('asks for a CAP document so the host answers: 406 to "application/cap+xml" alone, 200 once any type is allowed', async () => {
        // feeds.meteoalarm.org, probed 2026-10-14: 406 Not Acceptable for application/cap+xml, application/xml
        // or text/xml alone; 200 (text/xml) for */* or a list that ends in it. This fake host does the same.
        expect(admitsAny('application/cap+xml')).toBe(false);
        expect(admitsAny(METEOALARM_DOC_ACCEPT)).toBe(true);
        const p: Published = { slug: 'greece', n: 1, at: H0, expiresAt: H0 + 6 * 60 * MIN };
        const asked: Array<string | null> = [];
        const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const accept = new Headers(init?.headers).get('accept');
            asked.push(accept);
            if (url === FEED('greece')) return new Response(atomOf('greece', [p]), { status: 200 });
            if (accept === null || !admitsAny(accept)) return new Response('Not Acceptable', { status: 406 });
            return new Response(capOf(p), { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
        }) as typeof fetch;
        const out = await ADAPTERS.meteoalarm.run({
            provider: meteoRows().find((r) => r.id === 'meteoalarm-gr')!,
            known: new Map(),
            http: createHttp(fakeFetch, { userAgent: 'test' }),
            nowMs: H0,
            maxDocs: 40,
        });
        expect(asked).toEqual([null, METEOALARM_DOC_ACCEPT]);
        expect(out.partial).toBeNull();
        expect(out.alerts.map((a) => a.identifier)).toEqual([idOf(p)]);
    });

    it('a Retry-After is read in seconds or as a date, and never taken for more than a day', () => {
        expect(parseRetryAfter('120', H0)).toBe(120_000);
        expect(parseRetryAfter(new Date(H0 + 5 * MIN).toUTCString(), H0)).toBe(5 * MIN);
        expect(parseRetryAfter('999999999', H0)).toBe(24 * 60 * MIN);
        expect(parseRetryAfter('0', H0)).toBeNull();
        expect(parseRetryAfter('soon', H0)).toBeNull();
        expect(parseRetryAfter(null, H0)).toBeNull();
    });

    it('a burst of 120 new warnings in one country is read in one run, not over four', async () => {
        const published: Published[] = Array.from({ length: 120 }, (_, i) => ({
            slug: 'germany',
            n: i + 1,
            at: H0,
            expiresAt: H0 + 6 * 60 * MIN,
        }));
        const world = meteoAlarmWorld(published);
        const store = new Store(meteoRows().filter((p) => p.id === 'meteoalarm-de'));
        world.setNow(H0 + 2 * MIN);
        const run = await runIngest({ store, http: world.http, nowMs: H0 + 2 * MIN, sleep: async () => undefined });
        expect(run.ran[0]).toMatchObject({ ok: true, upserts: 120, error: null });
    });

    it('never fetches the document of a warning the feed itself says is over', async () => {
        const atom = atomOf('france', [
            { slug: 'france', n: 1, at: H0 - 60 * MIN, expiresAt: H0 - MIN },
            { slug: 'france', n: 2, at: H0 - 60 * MIN, expiresAt: H0 + 60 * MIN },
        ]);
        const listing = parseMeteoAlarmAtom(atom)!;
        expect(listing.listed.size).toBe(2);
        expect(listing.expires.get(idOf({ slug: 'france', n: 1, at: 0, expiresAt: 0 }))).toBe(
            new Date(H0 - MIN).toISOString(),
        );
        const fetched: string[] = [];
        const http: Http = {
            async get(url) {
                fetched.push(url);
                if (url === FEED('france')) return { status: 'ok', text: atom, validators: {} };
                if (url === DOC('france', 2)) {
                    return {
                        status: 'ok',
                        text: capOf({ slug: 'france', n: 2, at: H0 - 60 * MIN, expiresAt: H0 + 60 * MIN }),
                        validators: {},
                    };
                }
                throw new Error('HTTP 404');
            },
        };
        const out = await ADAPTERS.meteoalarm.run({
            provider: meteoRows().find((p) => p.id === 'meteoalarm-fr')!,
            known: new Map(),
            http,
            nowMs: H0,
            maxDocs: 40,
        });
        expect(fetched).toEqual([FEED('france'), DOC('france', 2)]);
        expect(out.partial).toBeNull();
        expect(out.alerts.map((a) => a.identifier)).toEqual([idOf({ slug: 'france', n: 2, at: 0, expiresAt: 0 })]);
    });
});

describe('placement: the hub’s EMMA_ID outlines', () => {
    const SOURCE = 'https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/MeteoAlarm_Geocodes_2026_07_31.json';
    const loaded = meteoAlarmGeocodeZones(JSON.parse(fixture('meteoalarm-geocodes.json')), SOURCE)!;

    /** Ray casting over a zone's outer rings. */
    const holds = (zone: { geometry: number[][][][] }, lat: number, lon: number) =>
        zone.geometry.some((polygon) => {
            let hit = false;
            const ring = polygon[0];
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [xi, yi] = ring[i];
                const [xj, yj] = ring[j];
                if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
            }
            return hit;
        });

    it('loads each country’s outlines under its own provider, keyed as the warnings name them', () => {
        expect([...loaded.byProvider.keys()].sort()).toEqual([
            'meteoalarm-de',
            'meteoalarm-fr',
            'meteoalarm-gr',
            'meteoalarm-ie',
        ]);
        expect(loaded.byProvider.get('meteoalarm-fr')!.map((z) => z.code)).toEqual(['EMMA_ID:FR913', 'EMMA_ID:FR914']);
        // An Irish code under EI goes by the feature's country, not its letters.
        expect(loaded.byProvider.get('meteoalarm-ie')!.map((z) => z.code)).toEqual(['EMMA_ID:EI901']);
        // Not an EMMA_ID code, no geometry, another scheme: skipped, and counted.
        expect(loaded.skipped).toBe(3);
        for (const zones of loaded.byProvider.values()) {
            for (const z of zones) {
                expect(z.sourceUrl).toBe(SOURCE);
                expect(z.geometry.length).toBeGreaterThan(0);
            }
        }
        expect(meteoAlarmGeocodeZones({ type: 'Feature' }, SOURCE)).toBeNull();
        // Longer codes, as Poland and Czechia have them (PL3009, CZ06104): a fictional one.
        const box = {
            type: 'Polygon',
            coordinates: [
                [
                    [14, 50],
                    [15, 50],
                    [15, 51],
                    [14, 51],
                    [14, 50],
                ],
            ],
        };
        const cz = meteoAlarmGeocodeZones(
            {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { code: 'CZ99901', country: 'CZ', name: 'Zz', type: 'EMMA_ID' },
                        geometry: box,
                    },
                ],
            },
            SOURCE,
        )!;
        expect(cz.byProvider.get('meteoalarm-cz')!.map((z) => z.code)).toEqual(['EMMA_ID:CZ99901']);
    });

    it('places a warning at Marseille, Hamburg and Athens: each names an outline that holds the city', async () => {
        const cases: Array<[string, string, number, number]> = [
            ['meteoalarm-fr', fixture('meteoalarm-fr-cap.xml'), 43.2965, 5.3698], // Marseille
            ['meteoalarm-de', fixture('meteoalarm-de-cap.xml'), 53.55, 9.99], // Hamburg
            // Greece's fixture, for Athens: the same fictional warning for ZZATTIKI (GR911).
            ['meteoalarm-gr', fixture('meteoalarm-gr-cap.xml').replaceAll('GR914', 'GR911'), 37.98, 23.73],
        ];
        for (const [provider, cap, lat, lon] of cases) {
            const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"><id>zz</id><entry><cap:identifier>${
                /<identifier>([^<]+)<\/identifier>/.exec(cap)![1]
            }</cap:identifier><cap:status>Actual</cap:status><link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-zz/1"/></entry></feed>`;
            const http: Http = {
                async get(url) {
                    return { status: 'ok', text: url.endsWith('/1') ? cap : atom, validators: {} };
                },
            };
            const out = await ADAPTERS.meteoalarm.run({
                provider: row({ id: provider, adapter: 'meteoalarm', feedUrl: FEED('zz') }),
                known: new Map(),
                http,
                nowMs: Date.parse('2026-10-14T00:00:00Z'),
                maxDocs: 40,
            });
            expect(out.alerts, provider).toHaveLength(1);
            const [alert] = out.alerts;
            expect(alert.geometry, provider).toBeNull(); // placed by its zone, not a polygon of its own
            const zones = loaded.byProvider.get(provider)!.filter((z) => alert.zones.includes(z.code));
            expect(zones, provider).toHaveLength(1);
            expect(holds(zones[0], lat, lon), provider).toBe(true);
        }
    });

    it('places a warning whose full CAP names only NUTS3 or FIPS areas by the EMMA_ID its Atom entries link', async () => {
        // Bulgaria and Romania send NUTS3 codes only, and Ireland's land warnings FIPS codes, in the Atom feed
        // and the full CAP alike; each entry's link names the hub's EMMA_ID area (14 Oct 2026). Fictional.
        const identifier = '2.49.0.0.100.0.BG.ZZ0001';
        const docUrl =
            'https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-0000000bg001';
        const entry = (area: string, nuts: string, emma: string) => `
  <entry>
    <cap:geocode><valueName>NUTS3</valueName><value>${nuts}</value></cap:geocode>
    <link title="${area}" href="https://meteoalarm.org?geocode=EMMA_ID:${emma}" hreflang="en"/>
    <cap:areaDesc>${area}</cap:areaDesc>
    <cap:expires>2026-10-15T21:00:00+00:00</cap:expires>
    <cap:status>Actual</cap:status>
    <cap:identifier>${identifier}</cap:identifier>
    <link type="application/cap+xml" href="${docUrl}"/>
    <link title="Bulgaria" rel="related" href="https://meteoalarm.org?region=BG" hreflang="en"/>
  </entry>`;
        const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <id>zz</id>${entry('Зз Варна (измислена)', 'BG991', 'BG998')}${entry('Зз Бургас (измислена)', 'BG992', 'BG999')}
</feed>`;
        const cap = `<?xml version="1.0" encoding="utf-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${identifier}</identifier>
  <sender>zz@zzmeteo.example</sender>
  <sent>2026-10-14T09:00:00+00:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>bg-BG</language>
    <category>Met</category>
    <event>Зз вълнение (измислено)</event>
    <urgency>Immediate</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <expires>2026-10-15T21:00:00+00:00</expires>
    <headline>Измислен текст за изпитване</headline>
    <parameter><valueName>awareness_level</valueName><value>2; yellow; Moderate</value></parameter>
    <parameter><valueName>awareness_type</valueName><value>7; coastalevent</value></parameter>
    <area><areaDesc>Зз Варна (измислена)</areaDesc><geocode><valueName>NUTS3</valueName><value>BG991</value></geocode></area>
    <area><areaDesc>Зз Бургас (измислена)</areaDesc><geocode><valueName>NUTS3</valueName><value>BG992</value></geocode></area>
  </info>
</alert>`;
        const listing = parseMeteoAlarmAtom(atom)!;
        expect([...listing.zones.get(identifier)!].sort()).toEqual(['EMMA_ID:BG998', 'EMMA_ID:BG999']);
        const http: Http = {
            async get(url) {
                return { status: 'ok', text: url === docUrl ? cap : atom, validators: {} };
            },
        };
        const out = await ADAPTERS.meteoalarm.run({
            provider: meteoRows().find((r) => r.id === 'meteoalarm-bg')!,
            known: new Map(),
            http,
            nowMs: H0,
            maxDocs: 40,
        });
        expect(out.alerts).toHaveLength(1);
        expect(out.alerts[0].zones).toEqual(['EMMA_ID:BG998', 'EMMA_ID:BG999']);
        // An entry's own EMMA_ID geocode counts as well; another scheme or a malformed code never does.
        const mixed = parseMeteoAlarmAtom(
            atom
                .replace(
                    '<valueName>NUTS3</valueName><value>BG991</value>',
                    '<valueName>EMMA_ID</valueName><value>BG997</value>',
                )
                .replace('EMMA_ID:BG999', 'EMMA_ID:zz'),
        )!;
        expect([...mixed.zones.get(identifier)!].sort()).toEqual(['EMMA_ID:BG997', 'EMMA_ID:BG998']);
    });

    it('an updated outline is sent again; a removed one is dropped, and only on purpose past half a country', () => {
        const fr = loaded.byProvider.get('meteoalarm-fr')!;
        const current = new Map([
            ['meteoalarm-fr', new Set(['EMMA_ID:FR913', 'EMMA_ID:FR914', 'EMMA_ID:FR999'])],
            ['meteoalarm-il', new Set(['EMMA_ID:IL001', 'EMMA_ID:IL002'])],
        ]);
        const plan = planZoneSync(current, loaded.byProvider);
        const france = plan.find((p) => p.provider === 'meteoalarm-fr')!;
        // FR999 is gone from the hub's file: dropped. FR913 and FR914 are sent; the database writes only
        // an outline that changed (official_alert_zones_sync compares the stored geometry).
        expect(france).toMatchObject({ remove: ['EMMA_ID:FR999'], refuse: null });
        expect(france.zones.map((z) => z.code)).toEqual(['EMMA_ID:FR913', 'EMMA_ID:FR914']);
        // Israel's outlines all removed (as the hub's 2026-07-31 change log did): refused unless allowed.
        const israel = plan.find((p) => p.provider === 'meteoalarm-il')!;
        expect(israel.remove).toEqual(['EMMA_ID:IL001', 'EMMA_ID:IL002']);
        expect(israel.refuse).toMatch(/would remove 2 of 2/);
        expect(
            planZoneSync(current, loaded.byProvider, { allowRemoval: true }).find(
                (p) => p.provider === 'meteoalarm-il',
            )!.refuse,
        ).toBeNull();

        // The calls: every code the country keeps goes with every batch, so a batch never drops another's.
        const calls = zoneSyncCalls('meteoalarm-fr', fr, 1);
        expect(calls).toHaveLength(2);
        for (const c of calls) {
            expect(c.p_provider).toBe('meteoalarm-fr');
            expect(c.p_scheme).toBe('EMMA_ID');
            expect(c.p_codes).toEqual(['EMMA_ID:FR913', 'EMMA_ID:FR914']);
            expect(c.p_zones).toHaveLength(1);
        }
        expect(calls[0].p_zones[0]).toMatchObject({ code: 'EMMA_ID:FR913', geometry: { type: 'MultiPolygon' } });
        expect(zoneSyncCalls('meteoalarm-il', [])).toEqual([
            { p_provider: 'meteoalarm-il', p_scheme: 'EMMA_ID', p_codes: [], p_zones: [] },
        ]);
    });
});

describe('the loader (scripts/load-meteoalarm-geocodes.mjs)', () => {
    const run = (...args: string[]) => {
        const env = { ...process.env };
        delete env.SUPABASE_URL;
        delete env.SUPABASE_SERVICE_ROLE_KEY;
        return spawnSync(process.execPath, ['scripts/load-meteoalarm-geocodes.mjs', ...args], {
            encoding: 'utf8',
            env,
        });
    };

    it('plans a load per country from the hub’s file, offline in a dry run, and writes nothing', () => {
        const dir = mkdtempSync(join(tmpdir(), 'meteoalarm-geocodes-'));
        try {
            const file = join(dir, 'MeteoAlarm_Geocodes_2026_07_31.json');
            copyFileSync('tests/fixtures/official-alerts/meteoalarm-geocodes.json', file);
            const out = run('--file', file, '--dry-run');
            expect(out.stderr).not.toMatch(/Error/);
            expect(out.status).toBe(0);
            expect(out.stdout).toMatch(/^meteoalarm-fr +2 outlines, +\d+ vertices, 0 to remove$/m);
            expect(out.stdout).toContain('MeteoAlarm_Geocodes_2026_07_31.json: 4 providers');
            expect(out.stdout).toContain('3 features skipped');
            // Without --dry-run it needs the database, and says so rather than guessing.
            const live = run('--file', file);
            expect(live.status).not.toBe(0);
            expect(live.stderr).toContain('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('takes only a file named as the hub names them', () => {
        const out = run('--file', 'tests/fixtures/official-alerts/meteoalarm-geocodes.json', '--dry-run');
        expect(out.status).not.toBe(0);
        expect(out.stderr).toContain('is not named as the hub names its Geocodes JSON');
    });
});

describe('the source, the issue time, the link and the disclaimer (rules 2, 3, 4 and 6)', () => {
    it('names the national service for one country, by its sender where a country has several', () => {
        expect(meteoAlarmSource('meteoalarm-fr', 'vigilance@meteo.fr', 'Météo-France')).toBe('Météo-France');
        expect(meteoAlarmSource('meteoalarm-gr', 'emk@hnms.gr', 'Hnms Forecaster')).toBe(
            'Hellenic National Meteorological Service (HNMS)',
        );
        expect(meteoAlarmSource('meteoalarm-de', 'opendata@dwd.de', null)).toBe('Deutscher Wetterdienst (DWD)');
        expect(meteoAlarmSource('meteoalarm-no', 'meteorologi@met.no', 'MET Norway')).toBe(
            'Meteorologisk Institutt (MET Norway)',
        );
        expect(meteoAlarmSource('meteoalarm-no', 'zz@nve.no', 'NVE')).toBe(
            'Norges Vassdrags- og Energidirektorat (NVE)',
        );
        expect(meteoAlarmSource('meteoalarm-ba', 'sinoptika@rhmzrs.com', null)).toBe(
            'Republički Hidrometeorološki Zavod Republike Srpske (RHMZ RS)',
        );
        expect(
            meteoAlarmSource(
                'meteoalarm-gb',
                'https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings',
                'UK Met Office',
            ),
        ).toBe('Met Office');
        // A sender none of a country's participants matches: the issuer's own name for itself.
        expect(meteoAlarmSource('meteoalarm-gb', 'zz@zz.example', 'Zz Agency')).toBe('Zz Agency');
        // Every one of the 39 countries has its participant.
        expect(Object.keys(METEOALARM_PARTICIPANTS).sort()).toEqual(COUNTRIES.map(([c]) => c).sort());
        // The app reads the participants from the issuer the RPC gives (the seeds' "names (MeteoAlarm)").
        const uk = meteoAlarmIssuerNames(
            'Met Office / Environment Agency (EA) / Natural Resources Wales (NRW) / Scottish Environment Protection Agency (SEPA) (MeteoAlarm)',
        );
        expect(uk).toEqual(meteoAlarmParticipants('meteoalarm-gb'));
        expect(meteoAlarmParticipant(uk, 'zz@environment-agency.gov.uk', null)).toBe('Environment Agency (EA)');
        expect(meteoAlarmParticipant(uk, 'zz@sepa.org.uk', 'Zz')).toBe('Scottish Environment Protection Agency (SEPA)');
        expect(meteoAlarmParticipant(meteoAlarmIssuerNames('Météo-France (MeteoAlarm)'), null, 'Zz')).toBe(
            'Météo-France',
        );
    });

    it('says "EUMETNET – MeteoAlarm" once more than one country is shown', () => {
        expect(METEOALARM_SOURCE).toBe('EUMETNET – MeteoAlarm');
        expect(meteoAlarmCountries(['meteoalarm-fr', 'meteoalarm-fr', 'nws'])).toBe(1);
        expect(meteoAlarmCountries(['meteoalarm-fr', 'meteoalarm-it'])).toBe(2);
        expect(meteoAlarmCountries(['nws', 'eccc'])).toBe(0);
    });

    it('the disclaimer is MeteoAlarm’s, byte for byte, and the link is www.meteoalarm.org', () => {
        const terms =
            'Time delays between this website and the www.meteoalarm.org website are possible. For the most up-to-date awareness information as published by the participating National Meteorological and Hydrological Services, please refer to www.meteoalarm.org.';
        expect(METEOALARM_DISCLAIMER).toBe(terms);
        expect(Buffer.from(METEOALARM_DISCLAIMER, 'utf8').equals(Buffer.from(terms, 'utf8'))).toBe(true);
        expect(METEOALARM_LINK_TEXT).toBe('www.meteoalarm.org');
        expect(METEOALARM_DISCLAIMER.split(METEOALARM_LINK_TEXT)).toHaveLength(3);
        expect(METEOALARM_LINK).toBe('https://meteoalarm.org/en/live/');
    });

    it('titles a warning as the Style Guide asks: its level and its type', () => {
        const p = (level: string, type: string) => [
            { valueName: 'awareness_level', value: level },
            { valueName: 'awareness_type', value: type },
        ];
        expect(meteoAlarmTitle(p('2; yellow; Moderate', '1; Wind'))).toBe('Yellow Wind Warning');
        expect(meteoAlarmTitle(p('3; orange; Severe', '7; coastalevent'))).toBe('Orange Coastal Event Warning');
        expect(meteoAlarmTitle(p('4; Red; Extreme', '14; marinehazard'))).toBe('Red Marine Hazard Warning');
        expect(meteoAlarmTitle(p('2; yellow; Moderate', '2; snow-ice'))).toBe('Yellow Snow or Ice Warning');
        expect(meteoAlarmTitle(p('1; green; Minor', '1; Wind'))).toBeNull();
        expect(meteoAlarmTitle([])).toBeNull();
    });

    it('a push names the national service and carries the issue time on the boat’s clock, and the link where it fits', () => {
        const info: StoredInfo = {
            language: 'en-GB',
            category: ['Met'],
            event: 'Orange coastalevent warning',
            urgency: 'Expected',
            severity: 'Severe',
            certainty: 'Likely',
            effective: null,
            onset: '2026-10-14T06:00:00+00:00',
            expires: '2026-10-14T22:00:00+00:00',
            ends: null,
            senderName: 'Météo-France',
            headline: 'Orange warning for waves and coastal flooding (test text)',
            description: 'Invented test text.',
            instruction: null,
            web: null,
            contact: null,
            responseType: [],
            areaDesc: ['Bouches-du-Zzrhône'],
            parameters: [
                { valueName: 'awareness_level', value: '3; orange; Severe' },
                { valueName: 'awareness_type', value: '7; coastalevent' },
            ],
            eventCodes: [],
        };
        const alert: WatchAlert = {
            id: 7,
            provider: 'meteoalarm-fr',
            identifier: '2.49.0.0.250.0.FR.ZZ0007',
            sender: 'vigilance@meteo.fr',
            refs: [],
            zones: ['EMMA_ID:FR913'],
            sentAt: '2026-10-14T05:30:00Z',
            onsetAt: '2026-10-14T06:00:00Z',
            effectiveAt: null,
            expiresAt: '2026-10-14T22:00:00Z',
            infos: [info],
            attribution: 'Warnings: Météo-France',
        };
        const text = officialPushText(alert, info, 'Europe/Paris');
        expect(text.title).toBe('Orange Coastal Event Warning');
        expect(text.body).toBe(
            'Orange warning for waves and coastal flooding (test text)\nMétéo-France · Issued 14 Oct, 07:30 CEST · www.meteoalarm.org',
        );
        // A long headline keeps the source and the time, and drops the link first.
        const long = officialPushText(alert, { ...info, headline: `Zz${'z'.repeat(448)}` }, 'Europe/Paris');
        expect(long.body.length).toBeLessThanOrEqual(500);
        expect(long.body).toMatch(/\nMétéo-France · Issued 14 Oct, 07:30 CEST$/);
        // Longer than the lock screen takes: the headline is cut, never the service or the time (rules 2, 3).
        // Poland's participant is the longest listed; the boat is in Gdańsk.
        const polish = officialPushText(
            { ...alert, provider: 'meteoalarm-pl', sender: 'zz@imgw.example', attribution: 'Warnings: IMGW-PIB' },
            { ...info, senderName: null, headline: `Ostrzeżenie zz ${'ż'.repeat(585)}` },
            'Europe/Warsaw',
        );
        expect(polish.body.length).toBeLessThanOrEqual(500);
        const [lead, credit] = polish.body.split('\n');
        expect(lead).toMatch(/^Ostrzeżenie zz ż+…$/);
        expect(credit).toBe(
            'Instytut Meteorologii i Gospodarki Wodnej - Państwowy Instytut Badawczy (IMGW-PIB) · Issued 14 Oct, 07:30 CEST',
        );

        // And through the watcher: an orange coastal event at the boat goes at once.
        const out = decideOfficialPushes({
            boats: [{ userId: 'u1', position: { lat: 43.29, lon: 5.37 }, basis: 'fix', advisories: true }],
            matches: new Map([['u1', [alert]]]),
            prior: [],
            nowMs: Date.parse('2026-10-14T05:40:00Z'),
            zoneAt: () => 'Europe/Paris',
        });
        expect(out.sends).toHaveLength(1);
        expect(out.sends[0].push.body).toContain('Météo-France · Issued 14 Oct, 07:30 CEST');
        expect(out.sends[0].push.data).toMatchObject({ severity: 'Severe', silent: false });
    });
});

describe('what may push from MeteoAlarm', () => {
    const at = (type: string, level = '3; orange; Severe', more: Array<{ valueName: string; value: string }> = []) => [
        { valueName: 'awareness_type', value: type },
        { valueName: 'awareness_level', value: level },
        ...more,
    ];
    const verdict = (
        provider: string,
        event: string,
        parameters: Array<{ valueName: string; value: string }>,
        severity: string,
        eventCodes: Array<{ valueName: string; value: string }> = [],
    ) => officialPushClass(classifyOfficialEvent(provider, { event, parameters, eventCodes }), severity);

    it('a coastal event and a marine hazard push; an orange one at once, a yellow one as an advisory', () => {
        expect(
            classifyOfficialEvent('meteoalarm-fr', { event: 'Vagues-submersion', parameters: at('7; coastalevent') })
                .domain,
        ).toBe('coastal');
        expect(
            classifyOfficialEvent('meteoalarm-hr', { event: 'Zzmore', parameters: at('14; marinehazard') }).domain,
        ).toBe('marine');
        expect(verdict('meteoalarm-fr', 'Vagues-submersion', at('7; coastalevent'), 'Severe')).toEqual({
            push: true,
            urgent: true,
            severity: 'Severe',
        });
        expect(verdict('meteoalarm-hr', 'Zzmore', at('14; Marine Hazard', '2; yellow; Moderate'), 'Moderate')).toEqual({
            push: true,
            urgent: false,
            severity: 'Moderate',
        });
        expect(verdict('meteoalarm-es', 'Costeros', at('7; coastalevent', '4; red; Extreme'), 'Extreme')).toEqual({
            push: true,
            urgent: true,
            severity: 'Extreme',
        });
    });

    it('a warning its issuer marks for the sea (MET Norway’s gale) or names a sea hazard (OET) pushes', () => {
        const gale = classifyOfficialEvent('meteoalarm-no', {
            event: 'Kuling',
            parameters: at('1; Wind', '2; yellow; Moderate', [{ valueName: 'geographicDomain', value: 'marine' }]),
            eventCodes: [{ valueName: 'OET:v1.0', value: 'OET-221' }],
        });
        expect(gale).toMatchObject({ domain: 'marine', significance: 'Y', hazards: [['wind', 2]] });
        expect(officialPushClass(gale, 'Moderate')).toEqual({ push: true, urgent: false, severity: 'Moderate' });
        expect(
            verdict('meteoalarm-ie', 'Zzcoastal flooding', at('10; rain'), 'Severe', [
                { valueName: 'OET:v1.0', value: 'OET-043' },
            ]).push,
        ).toBe(true);
        expect(
            verdict('meteoalarm-pt', 'Zzagitação marítima', at('1; Wind'), 'Severe', [
                { valueName: 'OET:v1.0', value: 'OET-097' },
            ]).push,
        ).toBe(true);
    });

    it('land types never push, however strong', () => {
        for (const type of [
            '1; Wind',
            '2; snow-ice',
            '3; Thunderstorm',
            '4; fog',
            '5; high-temperature',
            '6; low-temperature',
            '8; forest-fire',
            '9; avalanches',
            '10; rain',
            '12; flooding',
            '13; rain-flood',
            '15; drought',
        ]) {
            const c = classifyOfficialEvent('meteoalarm-de', { event: 'ZZ', parameters: at(type, '4; red; Extreme') });
            expect(c.domain, type).toBe('land');
            expect(officialPushClass(c, 'Extreme').push, type).toBe(false);
        }
        // A land wind warning that only names the generic OET Wind term stays on land.
        expect(
            verdict('meteoalarm-de', 'STURMBÖEN', at('1; Wind'), 'Severe', [
                { valueName: 'OET:v1.0', value: 'OET-221' },
            ]).push,
        ).toBe(false);
    });
});
