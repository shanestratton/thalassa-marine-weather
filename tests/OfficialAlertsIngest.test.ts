/**
 * The official-warnings ingest (129-05, supabase/functions/_shared/official-
 * alerts/ingest.ts) against an in-memory store that applies changes with the
 * migration's own rule (an upsert whose content hash is unchanged writes
 * nothing) and counts every row it writes.
 *
 * Write volume first (decision B): a re-ingest of the same feed writes zero
 * rows and does not even call the store; a 304 writes zero rows; withdrawals
 * are one write each, once; a healthy provider's status row is touched at
 * most every 15 minutes. A provider whose licence flag is off is never
 * fetched. A slow or failing provider never blocks the others, and is
 * recorded as unavailable from the first failure on (decision C).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
    Adapter,
    AdapterName,
    Http,
    HttpResult,
    Known,
    ProviderRow,
    Validators,
} from '../supabase/functions/_shared/official-alerts/adapters';
import { ADAPTERS } from '../supabase/functions/_shared/official-alerts/adapters';
import {
    type AlertStore,
    applyBatches,
    type ChangeSet,
    createHttp,
    diffAlerts,
    HEARTBEAT_MS,
    ingestProvider,
    MASS_DROP_RELEASE_MS,
    runIngest,
    shardFor,
} from '../supabase/functions/_shared/official-alerts/ingest';
import {
    finishAlert,
    type NormalizedAlert,
    SIMPLIFY_DEGREES,
    simplifyRing,
} from '../supabase/functions/_shared/official-alerts/normalize';

const fixture = (name: string) => readFileSync(`tests/fixtures/official-alerts/${name}`, 'utf8');
const T0 = Date.parse('2026-10-13T19:10:00Z');
const NWS = 'https://api.weather.gov/alerts/active?status=actual';
const ZONE = 'https://api.weather.gov/zones/forecast/';

const providerRow = (over: Partial<ProviderRow>): ProviderRow => ({
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

/** official_alerts_apply()'s rules, in memory, counting rows written. */
class MemoryStore implements AlertStore {
    rows = new Map<string, { alert: NormalizedAlert; live: boolean }>();
    zones = new Set<string>();
    writes = 0;
    applyCalls = 0;
    constructor(public list: ProviderRow[]) {}
    async providers() {
        return this.list.map((p) => ({ ...p, feedState: structuredClone(p.feedState) }));
    }
    async known(providerId: string) {
        const out = new Map<string, Known>();
        for (const [key, r] of this.rows) {
            const [p, id] = key.split('\u0000');
            if (p === providerId) {
                out.set(id, { hash: r.alert.contentHash, live: r.live, expiresAt: r.alert.expiresAt });
            }
        }
        return out;
    }
    async missingZones(providerId: string, keys: string[]) {
        return keys.filter((k) => !this.zones.has(`${providerId}\u0000${k}`));
    }
    async apply(providerId: string, change: ChangeSet) {
        this.applyCalls++;
        const p = this.list.find((x) => x.id === providerId)!;
        if (!p.enabled) throw new Error('licence flag is off');
        for (const a of change.upserts) {
            const key = `${providerId}\u0000${a.identifier}`;
            const prior = this.rows.get(key);
            if (prior && prior.alert.contentHash === a.contentHash && prior.live) continue;
            this.rows.set(key, { alert: a, live: true });
            this.writes++;
        }
        for (const id of change.withdraw) {
            const r = this.rows.get(`${providerId}\u0000${id}`);
            if (r?.live) {
                r.live = false;
                this.writes++;
            }
        }
        for (const z of change.zones) {
            this.zones.add(`${providerId}\u0000${z.code}`);
            this.writes++;
        }
        if (change.status) {
            Object.assign(p, change.status);
            this.writes++;
        }
    }
    /** prune_official_alerts(): an alert goes 24 h after it expires. Each delete is a row written. */
    prune(nowMs: number) {
        for (const [key, r] of this.rows) {
            if (r.alert.expiresAt && Date.parse(r.alert.expiresAt) < nowMs - 24 * 3_600_000) {
                this.rows.delete(key);
                this.writes++;
            }
        }
    }
    /** official_alerts_at()'s rule: not withdrawn and not expired. */
    inForce(providerId: string, nowMs: number) {
        return [...this.rows]
            .filter(
                ([k, r]) =>
                    k.startsWith(`${providerId}\u0000`) &&
                    r.live &&
                    (!r.alert.expiresAt || Date.parse(r.alert.expiresAt) > nowMs),
            )
            .map(([k]) => k.split('\u0000')[1])
            .sort();
    }
    live(providerId: string) {
        return [...this.rows]
            .filter(([k, r]) => k.startsWith(`${providerId}\u0000`) && r.live)
            .map(([k]) => k.split('\u0000')[1])
            .sort();
    }
}

type Route = string | { status: 304 } | { text: string; etag?: string } | { fail: string };
function stubHttp(routes: Record<string, Route>) {
    const calls: { url: string; validators?: Validators }[] = [];
    const http: Http = {
        async get(url, opts = {}): Promise<HttpResult> {
            calls.push({ url, validators: opts.validators });
            const r = routes[url];
            if (r === undefined) throw new Error('HTTP 404');
            if (typeof r === 'string') return { status: 'ok', text: r, validators: {} };
            if ('fail' in r) throw new Error(r.fail);
            if ('status' in r) {
                return { status: 'not-modified' };
            }
            if (r.etag && opts.validators?.etag === r.etag) return { status: 'not-modified' };
            return { status: 'ok', text: r.text, validators: r.etag ? { etag: r.etag } : {} };
        },
    };
    return { http, calls, routes };
}

const nws = () => providerRow({ id: 'nws', adapter: 'nws', feedUrl: NWS });
const nwsRoutes = (): Record<string, Route> => ({
    [NWS]: fixture('nws-active.json'),
    [`${ZONE}ANZ531`]: fixture('nws-zone-anz531.json'),
});

describe('write volume: a re-ingest of the same feed writes nothing', () => {
    it('the first ingest writes the alerts, the zone shapes it could load and the status; the second writes zero rows', async () => {
        const store = new MemoryStore([nws()]);
        const { http } = stubHttp(nwsRoutes());
        const first = await runIngest({ store, http, nowMs: T0 });
        expect(first.ran[0]).toMatchObject({ provider: 'nws', ok: true, upserts: 5, withdrawn: 0, zones: 1 });
        expect(store.writes).toBe(5 + 1 + 1);
        expect(store.list[0].lastSuccessAt).toBe(new Date(T0).toISOString());

        const before = { writes: store.writes, calls: store.applyCalls };
        const second = await runIngest({ store, http, nowMs: T0 + 5 * 60_000 });
        expect(second.ran[0]).toMatchObject({ ok: true, writes: 0, upserts: 0, withdrawn: 0 });
        expect(store.writes).toBe(before.writes);
        expect(store.applyCalls).toBe(before.calls);
    });

    it('a 304 writes nothing, and the stored ETag is what was sent', async () => {
        const store = new MemoryStore([nws()]);
        const routes = { ...nwsRoutes(), [NWS]: { text: fixture('nws-active.json'), etag: 'W/"v1"' } };
        const { http, calls } = stubHttp(routes);
        await runIngest({ store, http, nowMs: T0 });
        const writes = store.writes;
        const second = await runIngest({ store, http, nowMs: T0 + 5 * 60_000 });
        const feedCalls = calls.filter((c) => c.url === NWS);
        expect(feedCalls[1].validators).toEqual({ etag: 'W/"v1"' });
        expect(second.ran[0]).toMatchObject({ notModified: true, writes: 0 });
        expect(store.writes).toBe(writes);
    });

    it('the database refuses an unchanged row too: the same alerts sent again write nothing', async () => {
        const store = new MemoryStore([nws()]);
        const { http } = stubHttp(nwsRoutes());
        await runIngest({ store, http, nowMs: T0 });
        const writes = store.writes;
        const alerts = [...store.rows.values()].map((r) => r.alert);
        await store.apply('nws', { upserts: alerts, withdraw: [], zones: [], status: null });
        expect(store.writes).toBe(writes);
    });

    it('a withdrawn alert is one write, once; a changed one is one write', async () => {
        const store = new MemoryStore([nws()]);
        const routes = nwsRoutes();
        const { http } = stubHttp(routes);
        await runIngest({ store, http, nowMs: T0 });
        const body = JSON.parse(fixture('nws-active.json'));
        body.features = body.features.filter(
            (f: { properties: { id: string } }) => f.properties.id !== 'urn:oid:2.49.0.1.840.0.zz0003.001.1',
        );
        body.features[0].properties.description += '\n\n(amended test text)';
        routes[NWS] = JSON.stringify(body);
        const w0 = store.writes;
        const run = await runIngest({ store, http, nowMs: T0 + 60_000 });
        expect(run.ran[0]).toMatchObject({ upserts: 1, withdrawn: 1 });
        expect(store.writes - w0).toBe(2);
        expect(store.live('nws')).not.toContain('urn:oid:2.49.0.1.840.0.zz0003.001.1');
        const w1 = store.writes;
        await runIngest({ store, http, nowMs: T0 + 120_000 });
        expect(store.writes).toBe(w1);
    });

    it('a healthy provider’s status is refreshed only at the heartbeat', async () => {
        const store = new MemoryStore([nws()]);
        const routes = { ...nwsRoutes(), [NWS]: { text: fixture('nws-active.json'), etag: 'W/"v1"' } };
        const { http } = stubHttp(routes);
        await runIngest({ store, http, nowMs: T0 });
        const w = store.writes;
        await runIngest({ store, http, nowMs: T0 + HEARTBEAT_MS - 60_000 });
        expect(store.writes).toBe(w);
        await runIngest({ store, http, nowMs: T0 + HEARTBEAT_MS });
        expect(store.writes).toBe(w + 1);
        expect(store.list[0].lastSuccessAt).toBe(new Date(T0 + HEARTBEAT_MS).toISOString());
    });

    it('JMA and ECCC: a second run over the same feeds writes nothing', async () => {
        const jmaRoutes = {
            'https://www.data.jma.go.jp/developer/xml/feed/extra.xml': fixture('jma-extra.atom.xml'),
            'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml': fixture('jma-extra.atom.xml'),
            'https://www.data.jma.go.jp/developer/xml/feed/other.xml': fixture('jma-other.atom.xml'),
            'https://www.data.jma.go.jp/developer/xml/feed/other_l.xml': fixture('jma-other.atom.xml'),
            'https://www.data.jma.go.jp/developer/xml/data/20261013183258_0_VPWW54_130000.xml':
                fixture('jma-vpww54-130000.xml'),
            'https://www.data.jma.go.jp/developer/xml/data/20261013183100_0_VPWW54_014030.xml':
                fixture('jma-vpww54-130000.xml'),
            'https://www.data.jma.go.jp/developer/xml/data/20261013183507_0_VPCU51_010000.xml':
                fixture('jma-vpcu51-010000.xml'),
        };
        const day = 'https://dd.weather.gc.ca/20261013/WXO-DD/alerts/cap/20261013/';
        const ecccRoutes = {
            [day]: fixture('eccc-day-listing.txt'),
            [`${day}CWUL/`]: fixture('eccc-office-listing.txt'),
            [`${day}CWUL/17/`]: fixture('eccc-hour-17-listing.txt'),
            [`${day}CWUL/18/`]: fixture('eccc-hour-18-listing.txt'),
            [`${day}CWUL/17/T_WWCN10_C_CWUL_202610131702_0000000101.cap`]: fixture('eccc-alert.cap'),
            [`${day}CWUL/18/T_WWCN10_C_CWUL_202610131824_0000000102.cap`]: fixture('eccc-update-ended.cap'),
            [`${day}CWUL/18/T_WSCN10_C_CWUL_202610131826_0000000103.cap`]: fixture('eccc-fog.cap'),
        };
        const store = new MemoryStore([
            providerRow({ id: 'jma', adapter: 'jma' }),
            providerRow({ id: 'eccc', adapter: 'eccc', feedUrl: 'https://dd.weather.gc.ca/' }),
        ]);
        const { http } = stubHttp({ ...jmaRoutes, ...ecccRoutes });
        const now = Date.parse('2026-10-13T18:40:00Z');
        const first = await runIngest({ store, http, nowMs: now });
        // JMA: three kinds from each of two offices' municipality reports, two sea-area warnings.
        expect(first.ran.map((r) => [r.provider, r.ok, r.upserts])).toEqual([
            ['eccc', true, 1],
            ['jma', true, 8],
        ]);
        expect(store.live('jma')).toHaveLength(8);
        const w = store.writes;
        const second = await runIngest({ store, http, nowMs: now + 5 * 60_000 });
        expect(second.ran.map((r) => r.writes)).toEqual([0, 0]);
        expect(store.writes).toBe(w);
    });
});

describe('NWS lists a warning until its end, not its CAP expiry', () => {
    const spray = 'urn:oid:2.49.0.1.840.0.zz0006.001.1';

    it('a warning past its CAP expiry but before its end is in force, survives the prune, and the next ingest writes nothing', async () => {
        const store = new MemoryStore([nws()]);
        const { http } = stubHttp(nwsRoutes());
        await runIngest({ store, http, nowMs: T0 });
        // Its CAP expires passed 31 h ago; NWS still lists it, and it ends on 18 Oct.
        expect(store.inForce('nws', T0)).toContain(spray);
        store.prune(T0 + 5 * 60_000);
        expect(store.live('nws')).toContain(spray);
        const w = store.writes;
        const again = await runIngest({ store, http, nowMs: T0 + 10 * 60_000 });
        expect(again.ran[0].writes).toBe(0);
        expect(store.writes).toBe(w);
    });

    it('a warning the feed still lists after its own end is never stored, so the prune and the next ingest write nothing', async () => {
        const body = JSON.parse(fixture('nws-active.json'));
        const stale = structuredClone(body.features[0]);
        stale.properties.id = 'urn:oid:2.49.0.1.840.0.zzstale.001.1';
        stale.properties.expires = '2026-10-11T06:00:00-04:00';
        stale.properties.ends = '2026-10-11T18:00:00-04:00';
        body.features.push(stale);
        const store = new MemoryStore([nws()]);
        const { http } = stubHttp({ ...nwsRoutes(), [NWS]: JSON.stringify(body) });
        await runIngest({ store, http, nowMs: T0 });
        expect([...store.rows.keys()].some((k) => k.endsWith('zzstale.001.1'))).toBe(false);
        store.prune(T0 + 5 * 60_000);
        const w = store.writes;
        await runIngest({ store, http, nowMs: T0 + 10 * 60_000 });
        expect(store.writes).toBe(w);
    });
});

describe('the mass-drop guard never sticks, and never holds back new warnings', () => {
    const template = JSON.parse(fixture('nws-active.json')).features[1]; // a polygon warning
    const features = (prefix: string, n: number, expires: string, extra?: (i: number) => Record<string, unknown>) =>
        Array.from({ length: n }, (_, i) => {
            const f = structuredClone(template);
            Object.assign(
                f.properties,
                { id: `urn:oid:2.49.0.1.840.0.${prefix}.${i}`, expires, ends: null },
                extra?.(i),
            );
            return f;
        });
    const feed = (list: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features: list });

    it('after an outage, warnings that ran out meanwhile do not count: the new ones are written', async () => {
        const store = new MemoryStore([nws()]);
        const routes: Record<string, Route> = { [NWS]: feed(features('zzold', 100, '2026-10-13T21:00:00Z')) };
        const { http } = stubHttp(routes);
        await runIngest({ store, http, nowMs: T0 });
        expect(store.live('nws')).toHaveLength(100);
        // Eight hours later (the cron was paused): every old warning has run out; NWS lists 20 new ones.
        routes[NWS] = feed(features('zznew', 20, '2026-10-14T06:00:00Z'));
        const later = T0 + 8 * 3_600_000;
        const run = await runIngest({ store, http, nowMs: later });
        expect(run.ran[0]).toMatchObject({ ok: true, upserts: 20 });
        expect(store.inForce('nws', later)).toHaveLength(20);
        expect(store.list[0].unavailableSince).toBeNull();
    });

    it('warnings replaced by Updates that name them are withdrawn by name, not refused as a mass drop', async () => {
        const store = new MemoryStore([nws()]);
        const routes: Record<string, Route> = { [NWS]: feed(features('zzold', 60, '2026-10-15T00:00:00Z')) };
        const { http } = stubHttp(routes);
        await runIngest({ store, http, nowMs: T0 });
        routes[NWS] = feed(
            features('zzupd', 60, '2026-10-15T06:00:00Z', (i) => ({
                messageType: 'Update',
                references: [{ identifier: `urn:oid:2.49.0.1.840.0.zzold.${i}` }],
            })),
        );
        const run = await runIngest({ store, http, nowMs: T0 + 5 * 60_000 });
        expect(run.ran[0]).toMatchObject({ ok: true, upserts: 60, withdrawn: 60 });
        expect(store.live('nws').every((id) => id.includes('zzupd'))).toBe(true);
    });

    it('a refused snapshot still stores the new warnings it lists, keeps the old ones, and is believed after an hour', async () => {
        const store = new MemoryStore([nws()]);
        const routes: Record<string, Route> = { [NWS]: feed(features('zzold', 60, '2026-10-15T00:00:00Z')) };
        const { http } = stubHttp(routes);
        await runIngest({ store, http, nowMs: T0 });
        routes[NWS] = feed(features('zznew', 3, '2026-10-15T00:00:00Z'));
        const t1 = T0 + 5 * 60_000;
        const refused = await runIngest({ store, http, nowMs: t1 });
        expect(refused.ran[0]).toMatchObject({ ok: false, upserts: 3, withdrawn: 0 });
        expect(refused.ran[0].error).toMatch(/^refused: the feed would withdraw 60 of 60 warnings/);
        expect(store.live('nws')).toHaveLength(63);
        expect(store.list[0].unavailableSince).toBe(new Date(t1).toISOString());
        // Still refused half an hour on; nothing new is written for it.
        const again = await runIngest({ store, http, nowMs: t1 + 30 * 60_000 });
        expect(again.ran[0]).toMatchObject({ ok: false, upserts: 0, withdrawn: 0 });
        // The issuer has said the same on every run for an hour: believed.
        const believed = await runIngest({ store, http, nowMs: t1 + MASS_DROP_RELEASE_MS });
        expect(believed.ran[0]).toMatchObject({ ok: true, withdrawn: 60 });
        expect(store.live('nws')).toHaveLength(3);
        expect(store.list[0].unavailableSince).toBeNull();
        expect(store.list[0].feedState.massDropSince).toBeUndefined();
    });
});

describe('ECCC’s listing progress', () => {
    it('rides along whenever rows are written, so a file read once is not fetched again next run', async () => {
        const day = 'https://dd.weather.gc.ca/20261013/WXO-DD/alerts/cap/20261013/';
        const hour18 = (names: string[]) =>
            '<html><head><title>Index of /20261013/WXO-DD/alerts/cap/20261013/CWUL/18</title></head><body><pre>\n' +
            names.map((n) => `<a href="${n}">${n}</a>                        2026-10-13 18:30  -  `).join('\n') +
            '\n<hr></pre></body></html>';
        const routes: Record<string, Route> = {
            [day]: fixture('eccc-day-listing.txt'),
            [`${day}CWUL/`]: fixture('eccc-office-listing.txt'),
            [`${day}CWUL/17/`]: fixture('eccc-hour-17-listing.txt'),
            [`${day}CWUL/18/`]: hour18(['T_WSCN10_C_CWUL_202610131826_0000000103.cap']),
            [`${day}CWUL/17/T_WWCN10_C_CWUL_202610131702_0000000101.cap`]: fixture('eccc-alert.cap'),
            [`${day}CWUL/18/T_WWCN10_C_CWUL_202610131824_0000000102.cap`]: fixture('eccc-update-ended.cap'),
            [`${day}CWUL/18/T_WSCN10_C_CWUL_202610131826_0000000103.cap`]: fixture('eccc-fog.cap'),
        };
        const store = new MemoryStore([
            providerRow({ id: 'eccc', adapter: 'eccc', feedUrl: 'https://dd.weather.gc.ca/' }),
        ]);
        const { http, calls } = stubHttp(routes);
        await runIngest({ store, http, nowMs: Date.parse('2026-10-13T18:28:30Z') });
        // The 18:24 Update lands: it ends the 17:02 alert (one row written), inside the status heartbeat.
        routes[`${day}CWUL/18/`] = fixture('eccc-hour-18-listing.txt');
        const second = await runIngest({ store, http, nowMs: Date.parse('2026-10-13T18:33:30Z') });
        expect(second.ran[0]).toMatchObject({ ok: true, withdrawn: 1 });
        const before = calls.length;
        const third = await runIngest({ store, http, nowMs: Date.parse('2026-10-13T18:38:30Z') });
        expect(calls.slice(before).filter((c) => c.url.endsWith('.cap'))).toEqual([]);
        expect(third.ran[0].writes).toBe(0);
    });
});

describe('licence flags: a provider that is off is never fetched', () => {
    it('never asks an OFF provider’s feed, even when it is the only one', async () => {
        const off = providerRow({
            id: 'meteoalarm-fr',
            adapter: 'meteoalarm',
            enabled: false,
            feedUrl: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france',
        });
        const bom = providerRow({ id: 'bom', adapter: 'cap', enabled: false });
        const store = new MemoryStore([off, bom, nws()]);
        const { http, calls } = stubHttp({
            ...nwsRoutes(),
            'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france': fixture('meteoalarm-fr.atom.xml'),
        });
        const run = await runIngest({ store, http, nowMs: T0 });
        expect(run.off).toEqual(['bom', 'meteoalarm-fr']);
        expect(run.ran.map((r) => r.provider)).toEqual(['nws']);
        expect(calls.some((c) => c.url.includes('meteoalarm'))).toBe(false);
        expect(store.list.find((p) => p.id === 'meteoalarm-fr')!.lastSuccessAt).toBeNull();
    });

    it('ingestProvider itself refuses an OFF provider without fetching', async () => {
        const store = new MemoryStore([providerRow({ id: 'bom', enabled: false })]);
        const { http, calls } = stubHttp({});
        const r = await ingestProvider(store.list[0], { store, http, nowMs: T0 });
        expect(r.ok).toBe(false);
        expect(calls).toEqual([]);
    });
});

describe('isolation and health (decision C)', () => {
    it('a failing provider is unavailable from its first failure, and never blocks the others', async () => {
        const store = new MemoryStore([nws(), providerRow({ id: 'jma', adapter: 'jma' })]);
        const routes: Record<string, Route> = {
            ...nwsRoutes(),
            'https://www.data.jma.go.jp/developer/xml/feed/extra.xml': { fail: 'HTTP 503' },
        };
        const { http } = stubHttp(routes);
        const run = await runIngest({ store, http, nowMs: T0 });
        expect(run.ran.find((r) => r.provider === 'nws')).toMatchObject({ ok: true, upserts: 5 });
        expect(run.ran.find((r) => r.provider === 'jma')).toMatchObject({ ok: false, error: 'HTTP 503' });
        const jma = store.list.find((p) => p.id === 'jma')!;
        expect(jma.unavailableSince).toBe(new Date(T0).toISOString());
        expect(jma.lastError).toBe('HTTP 503');

        // The same failure again inside the heartbeat writes nothing; "since" keeps its first time.
        const w = store.writes;
        await runIngest({ store, http, nowMs: T0 + 5 * 60_000 });
        expect(store.writes).toBe(w);
        await runIngest({ store, http, nowMs: T0 + HEARTBEAT_MS });
        expect(jma.unavailableSince).toBe(new Date(T0).toISOString());
        expect(jma.lastErrorAt).toBe(new Date(T0 + HEARTBEAT_MS).toISOString());
    });

    it('a provider that hangs is cut off at its timeout and recorded; the others finish', async () => {
        const hang: Adapter = { run: () => new Promise(() => {}) };
        const adapters = { ...ADAPTERS, cap: hang } as Record<AdapterName, Adapter>;
        const store = new MemoryStore([nws(), providerRow({ id: 'slow', adapter: 'cap', feedUrl: 'https://x.test/' })]);
        const { http } = stubHttp(nwsRoutes());
        const run = await runIngest({ store, http, nowMs: T0, adapters, providerTimeoutMs: 50 });
        expect(run.ran.find((r) => r.provider === 'nws')!.ok).toBe(true);
        expect(run.ran.find((r) => r.provider === 'slow')!.error).toBe('slow timed out after 0 s');
        expect(store.list.find((p) => p.id === 'slow')!.unavailableSince).toBe(new Date(T0).toISOString());
    });

    it('no provider is started once the run’s time budget is spent; each waits for the next run', async () => {
        const store = new MemoryStore([nws(), providerRow({ id: 'jma', adapter: 'jma' })]);
        const { http, calls } = stubHttp(nwsRoutes());
        const run = await runIngest({ store, http, nowMs: T0, runBudgetMs: 0 });
        expect(run.ran).toEqual([]);
        expect(run.deferred).toEqual(['jma', 'nws']);
        expect(calls).toEqual([]);
        expect(store.writes).toBe(0);
    });

    it('recovers: the next good run clears "unavailable since" and records the success', async () => {
        const store = new MemoryStore([nws()]);
        const routes: Record<string, Route> = { ...nwsRoutes(), [NWS]: { fail: 'HTTP 500' } };
        const { http } = stubHttp(routes);
        await runIngest({ store, http, nowMs: T0 });
        expect(store.list[0].unavailableSince).not.toBeNull();
        routes[NWS] = fixture('nws-active.json');
        await runIngest({ store, http, nowMs: T0 + 60_000 });
        expect(store.list[0].unavailableSince).toBeNull();
        expect(store.list[0].lastError).toBe('HTTP 500');
        expect(store.list[0].lastSuccessAt).toBe(new Date(T0 + 60_000).toISOString());
    });

    it('refuses a snapshot that would withdraw most of what is in force at once (never a mass false all-clear)', async () => {
        const store = new MemoryStore([nws()]);
        const body = JSON.parse(fixture('nws-active.json'));
        const template = body.features[0];
        body.features = Array.from({ length: 60 }, (_, i) => {
            const f = structuredClone(template);
            f.properties.id = `urn:oid:2.49.0.1.840.0.zzmass.${i}`;
            return f;
        });
        const routes: Record<string, Route> = { ...nwsRoutes(), [NWS]: JSON.stringify(body) };
        const { http } = stubHttp(routes);
        await runIngest({ store, http, nowMs: T0 });
        expect(store.live('nws')).toHaveLength(60);
        routes[NWS] = JSON.stringify({ type: 'FeatureCollection', features: [] });
        const run = await runIngest({ store, http, nowMs: T0 + 60_000 });
        expect(run.ran[0].ok).toBe(false);
        expect(run.ran[0].error).toMatch(/refused: the feed would withdraw 60 of 60 warnings/);
        expect(store.live('nws')).toHaveLength(60);
        expect(store.list[0].unavailableSince).not.toBeNull();
    });

    it('a malformed feed is an error, not an empty one', async () => {
        const store = new MemoryStore([
            providerRow({ id: 'cap-test', adapter: 'cap', feedUrl: 'https://cap.example/f' }),
        ]);
        const { http } = stubHttp({ 'https://cap.example/f': fixture('malformed-cap.xml') });
        const run = await runIngest({ store, http, nowMs: T0 });
        expect(run.ran[0]).toMatchObject({ ok: false, error: 'CAP feed is not XML' });
        expect(store.list[0].unavailableSince).toBe(new Date(T0).toISOString());
    });
});

describe('sharding', () => {
    it('takes every enabled provider when they fit, and otherwise each one exactly once per rotation', () => {
        const many = Array.from({ length: 50 }, (_, i) => providerRow({ id: `p${String(i).padStart(2, '0')}` }));
        expect(shardFor(many.slice(0, 10), T0)).toHaveLength(10);
        const seen: string[] = [];
        for (let slot = 0; slot < 3; slot++) {
            const chosen = shardFor(many, T0 + slot * 5 * 60_000);
            expect(chosen.length).toBeLessThanOrEqual(24);
            seen.push(...chosen.map((p) => p.id));
        }
        expect(seen.sort()).toEqual(many.map((p) => p.id).sort());
    });
});

describe('the database calls', () => {
    it('batches alerts; withdrawals, zones and the status ride on the last call only', async () => {
        const alerts = await Promise.all(
            Array.from({ length: 450 }, (_, i) =>
                finishAlert({
                    identifier: `zz-${i}`,
                    sender: 'fixture',
                    sentAt: '2026-10-13T00:00:00Z',
                    msgType: 'Alert',
                    status: 'Actual',
                    scope: 'Public',
                    references: [],
                    infos: [],
                    zones: [],
                    geometry: null,
                }),
            ),
        );
        const calls = applyBatches('nws', {
            upserts: alerts,
            withdraw: ['old'],
            zones: [],
            status: {
                lastSuccessAt: 'now',
                lastError: null,
                lastErrorAt: null,
                unavailableSince: null,
                feedState: { cursor: 1 },
            },
        });
        expect(calls.map((c) => c.p_upserts.length)).toEqual([200, 200, 50]);
        expect(calls.map((c) => c.p_status !== null)).toEqual([false, false, true]);
        expect(calls[2].p_withdraw).toEqual(['old']);
        expect(calls[0].p_upserts[0]).toMatchObject({ identifier: 'zz-0', refs: [], geometry: null });
    });

    it('the HTTP client sends validators and an honest User-Agent, and treats 304 as not modified', async () => {
        const seen: Record<string, string>[] = [];
        const fetchImpl = (async (_url: string, init?: RequestInit) => {
            seen.push(init!.headers as Record<string, string>);
            return new Response(null, { status: 304 });
        }) as unknown as typeof fetch;
        const http = createHttp(fetchImpl, { userAgent: 'Thalassa test' });
        await expect(
            http.get('https://x.test/', { validators: { etag: '"a"', lastModified: 'Tue' } }),
        ).resolves.toEqual({
            status: 'not-modified',
        });
        expect(seen[0]).toMatchObject({
            'User-Agent': 'Thalassa test',
            'If-None-Match': '"a"',
            'If-Modified-Since': 'Tue',
        });
        const failing = createHttp((async () => new Response('x', { status: 503 })) as unknown as typeof fetch, {
            userAgent: 'x',
        });
        await expect(failing.get('https://x.test/')).rejects.toThrow('HTTP 503');
    });

    it('diffAlerts withdraws only inside a report’s own prefix (one JMA office)', async () => {
        const known = new Map<string, Known>([
            ['jma:VPWW54:130000:03', { hash: 'a'.repeat(64), live: true, expiresAt: null }],
            ['jma:VPWW54:014030:15', { hash: 'b'.repeat(64), live: true, expiresAt: null }],
        ]);
        const diff = diffAlerts(
            known,
            {
                notModified: false,
                alerts: [],
                snapshot: { prefixes: ['jma:VPWW54:130000:'] },
                present: new Set(),
                withdraw: [],
                feedState: {},
                partial: null,
                zoneUrls: new Map(),
            },
            T0,
        );
        expect(diff.withdraw).toEqual(['jma:VPWW54:130000:03']);
    });

    it('diffAlerts sends one row per identifier, the newest message, when a feed lists one twice', async () => {
        const draft = (sentAt: string, sender: string) => ({
            identifier: 'zz-dup',
            sender,
            sentAt,
            msgType: 'Alert' as const,
            status: 'Actual',
            scope: 'Public',
            references: [],
            infos: [],
            zones: [],
            geometry: null,
        });
        const older = await finishAlert(draft('2026-10-13T01:00:00Z', 'a'));
        const newer = await finishAlert(draft('2026-10-13T02:00:00Z', 'b'));
        const diff = diffAlerts(
            new Map(),
            {
                notModified: false,
                alerts: [newer, older],
                snapshot: 'all',
                present: new Set(['zz-dup']),
                withdraw: [],
                feedState: {},
                partial: null,
                zoneUrls: new Map(),
            },
            T0,
        );
        expect(diff.upserts.map((a) => a.sentAt)).toEqual(['2026-10-13T02:00:00.000Z']);
    });

    it('a provider near its time limit stops between requests and records that it is catching up', async () => {
        const day = 'https://dd.weather.gc.ca/20261013/WXO-DD/alerts/cap/20261013/';
        const store = new MemoryStore([
            providerRow({ id: 'eccc', adapter: 'eccc', feedUrl: 'https://dd.weather.gc.ca/' }),
        ]);
        const stub = stubHttp({
            [day]: fixture('eccc-day-listing.txt'),
            [`${day}CWUL/`]: fixture('eccc-office-listing.txt'),
            [`${day}CWUL/17/`]: fixture('eccc-hour-17-listing.txt'),
            [`${day}CWUL/18/`]: fixture('eccc-hour-18-listing.txt'),
            [`${day}CWUL/17/T_WWCN10_C_CWUL_202610131702_0000000101.cap`]: fixture('eccc-alert.cap'),
        });
        // Every request takes 15 s: with 45 s for the provider and 10 s kept for writing, three fit.
        let clock = 0;
        const http: Http = {
            get: (url, opts) => {
                clock += 15_000;
                return stub.http.get(url, opts);
            },
        };
        const run = await runIngest({ store, http, nowMs: Date.parse('2026-10-13T18:40:00Z'), clock: () => clock });
        expect(stub.calls).toHaveLength(3);
        expect(run.ran[0]).toMatchObject({ ok: false });
        expect(run.ran[0].error).toMatch(/catching up/);
        expect(store.list[0].unavailableSince).not.toBeNull();
    });
});

describe('geometry is simplified to about 100 m', () => {
    it('drops vertices closer than ~100 m to the line and keeps the shape within that', () => {
        // A 5 km radius circle at 38.5N with 2,000 vertices and 10 m of noise.
        const ring: [number, number][] = [];
        for (let i = 0; i < 2000; i++) {
            const a = (2 * Math.PI * i) / 2000;
            const noise = (i % 2 ? 1 : -1) * 0.00009;
            ring.push([
                -76.4 + (0.045 / Math.cos((38.5 * Math.PI) / 180)) * Math.cos(a) + noise,
                38.5 + 0.045 * Math.sin(a),
            ]);
        }
        ring.push(ring[0]);
        const out = simplifyRing(ring);
        expect(out.length).toBeLessThan(80);
        expect(out.length).toBeGreaterThanOrEqual(8);
        expect(out[0]).toEqual(out[out.length - 1]);
        // Every original vertex stays within about the tolerance of the simplified outline.
        const k = Math.cos((38.5 * Math.PI) / 180);
        const toSegment = (p: [number, number], a: [number, number], b: [number, number]) => {
            const [px, py, ax, ay, bx, by] = [p[0] * k, p[1], a[0] * k, a[1], b[0] * k, b[1]];
            const dx = bx - ax;
            const dy = by - ay;
            const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
            return Math.hypot(px - ax - t * dx, py - ay - t * dy);
        };
        const worst = Math.max(...ring.map((p) => Math.min(...out.slice(1).map((b, i) => toSegment(p, out[i], b)))));
        expect(worst).toBeLessThan(SIMPLIFY_DEGREES * 1.2);
    });

    it('a ring smaller than the tolerance (a reef) keeps its own points', () => {
        const reef: [number, number][] = [
            [150.0, -23.0],
            [150.0003, -23.0],
            [150.0003, -23.0003],
            [150.0002, -23.0004],
            [150.0, -23.0003],
            [150.0, -23.0],
        ];
        expect(simplifyRing(reef)).toHaveLength(6);
    });
});
