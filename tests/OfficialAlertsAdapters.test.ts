/**
 * One adapter per issuer (129-05, supabase/functions/_shared/official-alerts/
 * adapters.ts), run on fictional fixtures through a stub HTTP client: NWS
 * (GeoJSON), MeteoAlarm Germany, France and Greece (Atom + CAP), JMA
 * (気象庁防災情報XML, not CAP) and ECCC (MSC Datamart CAP files), and any CAP
 * feed. The issuer's words arrive unchanged in every language; what is over
 * (解除, "ended", a Cancel) is not in force; a feed that does not answer
 * properly is an error, never an empty list.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    ADAPTERS,
    capIndexLinks,
    ecccInfoOver,
    type Http,
    type HttpResult,
    jmaFeedDocs,
    jmaSeverity,
    parseDirectoryListing,
    parseJmaReport,
    parseMeteoAlarmAtom,
    parseNwsAlerts,
    type ProviderRow,
    type Validators,
} from '../supabase/functions/_shared/official-alerts/adapters';
import { parseCapAlert, parseXml } from '../supabase/functions/_shared/cap';
import { finishAlert } from '../supabase/functions/_shared/official-alerts/normalize';

const fixture = (name: string) => readFileSync(`tests/fixtures/official-alerts/${name}`, 'utf8');
const NOW = Date.parse('2026-10-13T18:40:00Z');

type Route = string | { status: 304 } | { text: string; etag?: string };
function stubHttp(routes: Record<string, Route>) {
    const calls: { url: string; validators?: Validators; accept?: string }[] = [];
    const http: Http = {
        async get(url, opts = {}): Promise<HttpResult> {
            calls.push({ url, validators: opts.validators, accept: opts.accept });
            const r = routes[url];
            if (r === undefined) throw new Error('HTTP 404');
            if (typeof r === 'string') return { status: 'ok', text: r, validators: {} };
            if ('status' in r) return { status: 'not-modified' };
            return { status: 'ok', text: r.text, validators: r.etag ? { etag: r.etag } : {} };
        },
    };
    return { http, calls };
}

const provider = (over: Partial<ProviderRow>): ProviderRow => ({
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

/** An Apache directory index like the MSC Datamart's, for the names given. */
const listing = (title: string, names: string[]) =>
    `<html><head><title>Index of ${title}</title></head><body><h1>Index of ${title}</h1><pre>\n` +
    names.map((n) => `<a href="${n}">${n}</a>                        2026-10-13 18:30  -  `).join('\n') +
    '\n<hr></pre></body></html>';
const soft = (out: { feedState: Record<string, unknown> }) =>
    out.feedState.soft as { listedTo: Record<string, string>; seen: string[]; retired: Record<string, string> };

describe('NWS (api.weather.gov GeoJSON)', () => {
    const parsed = parseNwsAlerts(JSON.parse(fixture('nws-active.json')))!;

    it('keeps every alert and update, and turns a Cancel into a withdrawal', () => {
        expect(parsed.drafts.map((d) => d.identifier)).toEqual([
            'urn:oid:2.49.0.1.840.0.zz0001.001.1',
            'urn:oid:2.49.0.1.840.0.zz0002.001.1',
            'urn:oid:2.49.0.1.840.0.zz0003.001.1',
            'urn:oid:2.49.0.1.840.0.zz0004.001.2',
            'urn:oid:2.49.0.1.840.0.zz0006.001.1',
        ]);
        // An Update retires what it replaces (NWS never lists both: the 13 Oct feed had 63 references, none
        // to an alert still listed), so a replaced warning is withdrawn by name, not by its absence.
        expect(parsed.withdraw).toEqual(['urn:oid:2.49.0.1.840.0.zz0004.001.1', 'urn:oid:2.49.0.1.840.0.zz0005.001.1']);
    });

    it('a warning is in force until NWS’s own end: expires_at is the later of the CAP expires and ends', async () => {
        // NWS keeps listing an alert after its CAP expires, until its ends (36 of 224 alerts on 13 Oct,
        // 6 of them Gale Warnings). The stored expiry must not hide or prune one NWS still lists.
        const spray = await finishAlert(parsed.drafts.find((d) => d.identifier.endsWith('zz0006.001.1'))!);
        expect(spray.expiresAt).toBe('2026-10-19T01:00:00.000Z');
        expect(spray.infos[0].expires).toBe('2026-10-12T04:00:00-08:00'); // NWS's own fields stay verbatim
        expect(spray.infos[0].ends).toBe('2026-10-18T17:00:00-08:00');
        expect((await finishAlert(parsed.drafts[0])).expiresAt).toBe('2026-10-14T22:00:00.000Z');
        // No ends: the CAP expires.
        expect((await finishAlert(parsed.drafts[1])).expiresAt).toBe('2026-10-13T20:00:00.000Z');
    });

    it('a zone-based marine alert names its zones (and where their shapes are); a storm warning keeps its polygon', () => {
        const sca = parsed.drafts[0];
        expect(sca.geometry).toBeNull();
        expect(sca.zones).toEqual(['nws:forecast:ANZ531', 'nws:forecast:ANZ532']);
        expect(parsed.zoneUrls.get('nws:forecast:ANZ531')).toBe('https://api.weather.gov/zones/forecast/ANZ531');
        const smw = parsed.drafts[1];
        expect(smw.geometry).toEqual([
            [
                [
                    [-76.5, 38.3],
                    [-76.2, 38.3],
                    [-76.2, 38.6],
                    [-76.5, 38.6],
                    [-76.5, 38.3],
                ],
            ],
        ]);
    });

    it('copies the text verbatim, line breaks and Spanish included, with NWS’s own end time', () => {
        const sca = parsed.drafts[0].infos[0];
        expect(sca.description).toBe(
            '* WHAT...South winds 15 to 20 kt with gusts up to 25 kt.\n\n* WHERE...Fictional waters of the upper bay used only for tests.',
        );
        expect(sca.instruction).toBe(
            'Inexperienced mariners, especially those operating smaller\nvessels, should avoid navigating in hazardous conditions.',
        );
        expect(sca.ends).toBe('2026-10-14T18:00:00-04:00');
        expect(sca.areaDesc).toEqual([
            'Chesapeake Bay from Pooles Island to Sandy Point MD; Chesapeake Bay from Sandy Point to North Beach MD',
        ]);
        expect(sca.parameters).toContainEqual({ valueName: 'NWSheadline', value: 'SMALL CRAFT ADVISORY IN EFFECT' });
        const pr = parsed.drafts[2].infos[0];
        expect(pr.language).toBe('es-US');
        expect(pr.event).toBe('Advertencia para Embarcaciones Pequeñas');
    });

    it('a shape across 180 degrees stays continuous after preparing', async () => {
        const gale = await finishAlert(parsed.drafts[3]);
        const lons = gale.geometry![0][0].map((p) => p[0]);
        expect(Math.min(...lons)).toBe(179.5);
        expect(Math.max(...lons)).toBe(180.5);
    });

    it('is null when the answer is not a FeatureCollection', () => {
        expect(parseNwsAlerts({ type: 'Feature' })).toBeNull();
        expect(parseNwsAlerts(null)).toBeNull();
    });

    it('sends the stored ETag, and a 304 is "not modified"', async () => {
        const url = 'https://api.weather.gov/alerts/active?status=actual';
        const { http, calls } = stubHttp({ [url]: { status: 304 } });
        const out = await ADAPTERS.nws.run({
            provider: provider({
                id: 'nws',
                adapter: 'nws',
                feedUrl: url,
                feedState: { validators: { [url]: { etag: 'W/"abc"' } } },
            }),
            known: new Map(),
            http,
            nowMs: NOW,
            maxDocs: 40,
        });
        expect(out.notModified).toBe(true);
        expect(calls[0].validators).toEqual({ etag: 'W/"abc"' });
        expect(calls[0].accept).toBe('application/geo+json');
    });

    it('throws (unavailable, never "no warnings") on a body that is not JSON', async () => {
        const url = 'https://api.weather.gov/alerts/active?status=actual';
        const { http } = stubHttp({ [url]: '<html>maintenance</html>' });
        await expect(
            ADAPTERS.nws.run({
                provider: provider({ adapter: 'nws', feedUrl: url }),
                known: new Map(),
                http,
                nowMs: NOW,
                maxDocs: 40,
            }),
        ).rejects.toThrow(/not JSON/);
    });
});

describe('MeteoAlarm (Atom + CAP), Germany, France and Greece', () => {
    it('lists each identifier once, with its CAP link, and skips Test entries', () => {
        const de = parseMeteoAlarmAtom(fixture('meteoalarm-de.atom.xml'))!;
        expect([...de.listed.keys()]).toEqual([
            '2.49.0.0.276.0.DWD.PVW.ZZ0001.MUL',
            '2.49.0.0.276.0.DWD.PVW.ZZ0002.MUL',
        ]);
        expect(parseMeteoAlarmAtom(fixture('meteoalarm-gr.atom.xml'))!.listed.size).toBe(1);
        expect(parseMeteoAlarmAtom(fixture('meteoalarm-fr.atom.xml'))!.listed.size).toBe(1);
        expect(parseMeteoAlarmAtom('<rss/>')).toBeNull();
    });

    const base = 'https://feeds.meteoalarm.org/api/v1/warnings/';
    const routes = {
        'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-germany': fixture('meteoalarm-de.atom.xml'),
        [`${base}feeds-germany/00000000-0000-4000-8000-0000000de001`]: fixture('meteoalarm-de-cap.xml'),
        [`${base}feeds-germany/00000000-0000-4000-8000-0000000de002`]: fixture('meteoalarm-de-cap-2.xml'),
        'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece': fixture('meteoalarm-gr.atom.xml'),
        [`${base}feeds-greece/00000000-0000-4000-8000-0000000e1001`]: fixture('meteoalarm-gr-cap.xml'),
    };
    const de = provider({
        id: 'meteoalarm-de',
        adapter: 'meteoalarm',
        feedUrl: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-germany',
    });

    it('reads each new identifier’s full CAP once, every language kept; an Update retires what it names', async () => {
        const { http, calls } = stubHttp(routes);
        const out = await ADAPTERS.meteoalarm.run({ provider: de, known: new Map(), http, nowMs: NOW, maxDocs: 40 });
        expect(out.alerts.map((a) => a.identifier)).toEqual([
            '2.49.0.0.276.0.DWD.PVW.ZZ0001.MUL',
            '2.49.0.0.276.0.DWD.PVW.ZZ0002.MUL',
        ]);
        expect(out.alerts[0].infos.map((i) => i.language)).toEqual(['de-DE', 'en-GB']);
        // The CAP names DE901; the feed lists it for DE902 as well: placed in both (129-05b), as the hub shows it.
        expect(out.alerts[0].zones).toEqual(['EMMA_ID:DE901', 'EMMA_ID:DE902']);
        expect(out.withdraw).toEqual(['2.49.0.0.276.0.DWD.PVW.ZZ0000.MUL']);
        expect(out.snapshot).toBe('all');
        expect(out.partial).toBeNull();
        expect(calls.filter((c) => c.url.includes('/api/v1/'))).toHaveLength(2);

        // The next run already holds both: the feed is read, no CAP is fetched again.
        const known = new Map(
            out.alerts.map((a) => [a.identifier, { hash: a.contentHash, live: true, expiresAt: a.expiresAt }]),
        );
        const again = stubHttp(routes);
        const next = await ADAPTERS.meteoalarm.run({ provider: de, known, http: again.http, nowMs: NOW, maxDocs: 40 });
        expect(again.calls.map((c) => c.url)).toEqual([de.feedUrl]);
        expect(next.alerts).toEqual([]);
        expect([...next.present].sort()).toEqual([...known.keys()].sort());
    });

    it('Greece: the Greek block is stored as sent', async () => {
        const { http } = stubHttp(routes);
        const gr = provider({
            id: 'meteoalarm-gr',
            adapter: 'meteoalarm',
            feedUrl: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece',
        });
        const out = await ADAPTERS.meteoalarm.run({ provider: gr, known: new Map(), http, nowMs: NOW, maxDocs: 40 });
        const el = out.alerts[0].infos.find((i) => i.language === 'el-GR')!;
        expect(el.headline).toBe('Κόκκινη προειδοποίηση για νησιά του Βορειοανατολικού Αιγαίου (δοκιμαστικό κείμενο)');
        expect(el.areaDesc).toEqual(['Νησιά Βορειοανατολικού Αιγαίου']);
        expect(out.alerts[0].expiresAt).toBe('2026-10-14T07:00:00.000Z');
    });

    it('a CAP that cannot be read leaves the provider partial, never clean', async () => {
        const { http } = stubHttp({
            ...routes,
            [`${base}feeds-germany/00000000-0000-4000-8000-0000000de002`]: fixture('malformed-cap.xml'),
        });
        const out = await ADAPTERS.meteoalarm.run({ provider: de, known: new Map(), http, nowMs: NOW, maxDocs: 40 });
        expect(out.alerts).toHaveLength(1);
        expect(out.partial).toBe('1 MeteoAlarm warning not read yet');
        // Still listed, so it is never withdrawn for being unreadable.
        expect(out.present.has('2.49.0.0.276.0.DWD.PVW.ZZ0002.MUL')).toBe(true);
    });

    it('fetches CAP documents only from MeteoAlarm itself', async () => {
        const atom = fixture('meteoalarm-fr.atom.xml').replace(
            'https://feeds.meteoalarm.org/api/v1/warnings/feeds-france/',
            'https://evil.example/',
        );
        const { http, calls } = stubHttp({ 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france': atom });
        const fr = provider({
            id: 'meteoalarm-fr',
            adapter: 'meteoalarm',
            feedUrl: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france',
        });
        const out = await ADAPTERS.meteoalarm.run({ provider: fr, known: new Map(), http, nowMs: NOW, maxDocs: 40 });
        expect(calls.map((c) => c.url)).toEqual([fr.feedUrl]);
        expect(out.partial).toBe('1 MeteoAlarm warning not read yet');
    });
});

describe('JMA (気象庁防災情報XML)', () => {
    it('picks the newest report per office for the wanted type only', () => {
        const listed = jmaFeedDocs(fixture('jma-extra.atom.xml'), ['VPWW54'])!;
        expect(listed.docs.map((d) => [d.key, d.stamp])).toEqual([
            ['VPWW54:014030', '20261013183100_0'],
            ['VPWW54:130000', '20261013183258_0'],
        ]);
        expect(listed.oldest).toBe('20261013182500');
    });

    it('VPWW54: one warning per kind with every municipality it covers; lifted kinds (解除) are not in force', () => {
        const report = parseJmaReport(fixture('jma-vpww54-130000.xml'), 'VPWW54', '130000')!;
        expect(report.prefix).toBe('jma:VPWW54:130000:');
        const byId = new Map(report.drafts.map((d) => [d.identifier, d]));
        expect([...byId.keys()].sort()).toEqual([
            'jma:VPWW54:130000:15',
            'jma:VPWW54:130000:16',
            'jma:VPWW54:130000:19',
        ]);
        const waves = byId.get('jma:VPWW54:130000:16')!;
        expect(waves.zones).toEqual(['jma-city:1319901', 'jma-city:1319902']);
        expect(waves.infos[0]).toMatchObject({
            language: 'ja-JP',
            event: '波浪注意報',
            headline: '東京都気象警報・注意報',
            description: '東京地方では、強風や高波、高潮に注意してください。（試験用の架空の文）',
            senderName: '気象庁',
            severity: 'Moderate',
            areaDesc: ['港区（架空）', '江東区（架空）'],
        });
        expect(waves.infos[0].expires).toBeNull();
        expect(waves.sentAt).toBe('2026-10-13T18:32:00.000Z');
    });

    it('VPCU51: sea-area warnings with JMA’s own sentence and the report’s expiry', () => {
        const report = parseJmaReport(fixture('jma-vpcu51-010000.xml'), 'VPCU51', '010000')!;
        expect(report.drafts.map((d) => d.identifier).sort()).toEqual(['jma:VPCU51:010000:11', 'jma:VPCU51:010000:21']);
        const gale = report.drafts.find((d) => d.identifier.endsWith(':21'))!;
        expect(gale.zones).toEqual(['jma-sea:9991']);
        expect(gale.infos[0].event).toBe('海上強風警報');
        expect(gale.infos[0].description).toBe(
            '東京湾（架空）では　南西の風が強く　最大風速は　３５ノット（１８メートル）　試験用の架空の文',
        );
        expect(gale.infos[0].severity).toBe('Severe');
        expect(gale.expiresAt).toBe('2026-10-14T18:00:00.000Z');
    });

    it('a cancelled report retires the office’s warnings; training and test telegrams are ignored', () => {
        const xml = fixture('jma-vpww54-130000.xml');
        expect(
            parseJmaReport(xml.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>'), 'VPWW54', '130000'),
        ).toEqual({ prefix: 'jma:VPWW54:130000:', drafts: [] });
        expect(
            parseJmaReport(xml.replace('<Status>通常</Status>', '<Status>訓練</Status>'), 'VPWW54', '130000'),
        ).toBeNull();
        expect(parseJmaReport(fixture('malformed-cap.xml'), 'VPWW54', '130000')).toBeNull();
    });

    it('maps JMA’s classes to CAP severities and nothing else', () => {
        expect(jmaSeverity('大雨特別警報')).toBe('Extreme');
        expect(jmaSeverity('暴風警報')).toBe('Severe');
        expect(jmaSeverity('海上濃霧警報')).toBe('Severe');
        expect(jmaSeverity('強風注意報')).toBe('Moderate');
    });

    const feeds = {
        'https://www.data.jma.go.jp/developer/xml/feed/extra.xml': {
            text: fixture('jma-extra.atom.xml'),
            etag: '"e1"',
        },
        'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml': fixture('jma-extra.atom.xml'),
        'https://www.data.jma.go.jp/developer/xml/feed/other.xml': {
            text: fixture('jma-other.atom.xml'),
            etag: '"o1"',
        },
        'https://www.data.jma.go.jp/developer/xml/feed/other_l.xml': fixture('jma-other.atom.xml'),
        'https://www.data.jma.go.jp/developer/xml/data/20261013183258_0_VPWW54_130000.xml':
            fixture('jma-vpww54-130000.xml'),
        'https://www.data.jma.go.jp/developer/xml/data/20261013183100_0_VPWW54_014030.xml':
            fixture('malformed-cap.xml'),
        'https://www.data.jma.go.jp/developer/xml/data/20261013183507_0_VPCU51_010000.xml':
            fixture('jma-vpcu51-010000.xml'),
    };

    it('the first run reads the long feeds, each office’s newest report once; an unreadable report is a reason for doubt', async () => {
        const { http, calls } = stubHttp(feeds);
        const jma = provider({ id: 'jma', adapter: 'jma' });
        const out = await ADAPTERS.jma.run({ provider: jma, known: new Map(), http, nowMs: NOW, maxDocs: 40 });
        expect(calls.map((c) => c.url)).toContain('https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml');
        expect(out.alerts).toHaveLength(5);
        expect(out.snapshot).toEqual({ prefixes: ['jma:VPWW54:130000:', 'jma:VPCU51:010000:'] });
        expect(out.partial).toBe('1 JMA office report could not be read');
        expect(out.feedState.docs).toEqual({
            'VPWW54:130000': 'https://www.data.jma.go.jp/developer/xml/data/20261013183258_0_VPWW54_130000.xml',
            'VPCU51:010000': 'https://www.data.jma.go.jp/developer/xml/data/20261013183507_0_VPCU51_010000.xml',
        });

        // The next run: the short feeds only (nothing was missed), no report fetched again.
        const again = stubHttp(feeds);
        const next = await ADAPTERS.jma.run({
            provider: { ...jma, feedState: out.feedState },
            known: new Map(),
            http: again.http,
            nowMs: NOW + 300_000,
            maxDocs: 40,
        });
        expect(again.calls.map((c) => c.url)).toEqual([
            'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
            'https://www.data.jma.go.jp/developer/xml/feed/other.xml',
        ]);
        expect(again.calls[0].validators).toEqual({ etag: '"e1"' });
        expect(next.alerts).toEqual([]);
        expect(next.partial).toBe('1 JMA office report could not be read');
    });
    it('a report left waiting (past the per-run limit) is found again, never skipped by the high-water mark', async () => {
        const jma = provider({ id: 'jma', adapter: 'jma' });
        const run = async (feedState: Record<string, unknown>, nowMs: number) => {
            const { http, calls } = stubHttp(feeds);
            const out = await ADAPTERS.jma.run({
                provider: { ...jma, feedState },
                known: new Map(),
                http,
                nowMs,
                maxDocs: 1,
            });
            return { out, urls: calls.map((c) => c.url) };
        };
        const first = await run({}, NOW);
        expect(first.out.partial).toBe('2 JMA reports not read yet; 1 JMA office report could not be read');
        expect(first.out.feedState.newest).toEqual({});
        const second = await run(first.out.feedState, NOW + 300_000);
        expect(second.urls).toContain('https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml');
        expect(second.out.alerts.map((a) => a.identifier).sort()).toEqual([
            'jma:VPWW54:130000:15',
            'jma:VPWW54:130000:16',
            'jma:VPWW54:130000:19',
        ]);
        const third = await run(second.out.feedState, NOW + 600_000);
        expect(third.urls).not.toContain('https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml');
        expect(third.urls).toContain('https://www.data.jma.go.jp/developer/xml/feed/other_l.xml');
        expect(third.out.alerts.map((a) => a.identifier).sort()).toEqual([
            'jma:VPCU51:010000:11',
            'jma:VPCU51:010000:21',
        ]);
        expect(third.out.feedState.newest).toEqual({ extra: '20261013183258', other: '20261013183507' });
    });
});

describe('ECCC (MSC Datamart CAP files)', () => {
    it('reads an Apache directory listing', () => {
        expect(parseDirectoryListing(fixture('eccc-hour-18-listing.txt'))).toEqual([
            { name: 'T_WWCN10_C_CWUL_202610131824_0000000102.cap', modified: '2026-10-13 18:28' },
            { name: 'T_WSCN10_C_CWUL_202610131826_0000000103.cap', modified: '2026-10-13 18:29' },
        ]);
        expect(parseDirectoryListing('<html>not found</html>')).toBeNull();
    });

    it('an info whose Alert_Location_Status is "ended" is not in force', () => {
        const ended = parseCapAlert(fixture('eccc-update-ended.cap'))!;
        expect(ended.infos.every(ecccInfoOver)).toBe(true);
        expect(parseCapAlert(fixture('eccc-alert.cap'))!.infos.some(ecccInfoOver)).toBe(false);
    });

    const day = 'https://dd.weather.gc.ca/20261013/WXO-DD/alerts/cap/20261013/';
    const routes = {
        [day]: fixture('eccc-day-listing.txt'),
        [`${day}CWUL/`]: fixture('eccc-office-listing.txt'),
        [`${day}CWUL/17/`]: fixture('eccc-hour-17-listing.txt'),
        [`${day}CWUL/18/`]: fixture('eccc-hour-18-listing.txt'),
        [`${day}CWUL/17/T_WWCN10_C_CWUL_202610131702_0000000101.cap`]: fixture('eccc-alert.cap'),
        [`${day}CWUL/18/T_WWCN10_C_CWUL_202610131824_0000000102.cap`]: fixture('eccc-update-ended.cap'),
        [`${day}CWUL/18/T_WSCN10_C_CWUL_202610131826_0000000103.cap`]: fixture('eccc-fog.cap'),
    };

    it('reads the stream oldest first: an Update that ends an alert retires it; the cursor moves on', async () => {
        const { http } = stubHttp(routes);
        const eccc = provider({ id: 'eccc', adapter: 'eccc', feedUrl: 'https://dd.weather.gc.ca/' });
        const out = await ADAPTERS.eccc.run({ provider: eccc, known: new Map(), http, nowMs: NOW, maxDocs: 40 });
        expect(out.alerts.map((a) => a.identifier)).toEqual(['urn:oid:2.49.0.1.124.0000000103.2026']);
        expect(out.withdraw.sort()).toEqual([
            'urn:oid:2.49.0.1.124.0000000101.2026',
            'urn:oid:2.49.0.1.124.0000000102.2026',
        ]);
        expect(out.snapshot).toBeNull();
        expect(out.partial).toBeNull();
        expect(soft(out).listedTo).toEqual({ CWUL: '202610131840' });
        // The names a re-list (from an hour before 18:40) could find again; the 17:02 file is older than that.
        expect(soft(out).seen).toEqual([
            'T_WSCN10_C_CWUL_202610131826_0000000103.cap',
            'T_WWCN10_C_CWUL_202610131824_0000000102.cap',
        ]);
        const fog = out.alerts[0];
        expect(fog.infos.map((i) => i.language)).toEqual(['fr-CA', 'en-CA']);
        expect(fog.infos[0].headline).toBe('avis - brouillard - en vigueur (texte d’essai)');
        expect(fog.zones).toEqual(['layer:EC-MSC-SMC:1.0:CLC:099990']);
        expect(fog.geometry).not.toBeNull();

        const again = stubHttp(routes);
        const next = await ADAPTERS.eccc.run({
            provider: { ...eccc, feedState: out.feedState },
            known: new Map(),
            http: again.http,
            nowMs: NOW + 300_000,
            maxDocs: 40,
        });
        expect(next.notModified).toBe(true);
        expect(again.calls.filter((c) => c.url.endsWith('.cap'))).toEqual([]);
    });

    it('keeps reading yesterday’s directory while an office’s cursor is still in yesterday (a backfill left over)', async () => {
        const { http, calls } = stubHttp(routes);
        const eccc = provider({
            id: 'eccc',
            adapter: 'eccc',
            feedUrl: 'https://dd.weather.gc.ca/',
            feedState: { soft: { listedTo: { CWUL: '202610122300' } } },
        });
        const out = await ADAPTERS.eccc.run({ provider: eccc, known: new Map(), http, nowMs: NOW, maxDocs: 40 });
        expect(calls[0].url).toBe('https://dd.weather.gc.ca/20261012/WXO-DD/alerts/cap/20261012/');
        expect(soft(out).listedTo).toEqual({ CWUL: '202610131840' });
        const later = stubHttp(routes);
        await ADAPTERS.eccc.run({
            provider: { ...eccc, feedState: out.feedState },
            known: new Map(),
            http: later.http,
            nowMs: NOW + 300_000,
            maxDocs: 40,
        });
        expect(later.calls.some((c) => c.url.includes('/20261012/'))).toBe(false);
    });

    it('a CAP file that will not download stops that office there, to be read again next run', async () => {
        const { [`${day}CWUL/18/T_WWCN10_C_CWUL_202610131824_0000000102.cap`]: _gone, ...rest } = routes;
        const { http } = stubHttp(rest);
        const eccc = provider({ id: 'eccc', adapter: 'eccc', feedUrl: 'https://dd.weather.gc.ca/' });
        const out = await ADAPTERS.eccc.run({ provider: eccc, known: new Map(), http, nowMs: NOW, maxDocs: 40 });
        expect(out.alerts.map((a) => a.identifier)).toEqual(['urn:oid:2.49.0.1.124.0000000101.2026']);
        // Listed through the end of hour 17 only, so hour 18 is listed again next run.
        expect(soft(out).listedTo).toEqual({ CWUL: '202610131759' });
        expect(out.partial).toBe('catching up: 2 ECCC CAP files not read yet');
    });

    // Files land minutes after the time in their name (the real 13 Oct listing: 18:24 landed 18:28, 18:26
    // landed 18:29), and the number after the time is not in order (_2676342088, then _0488364865).
    const hour18 = (names: string[]) => listing('/20261013/WXO-DD/alerts/cap/20261013/CWUL/18', names);
    const run = async (r: Record<string, Route>, feedState: Record<string, unknown>, nowMs: number, extra = {}) => {
        const stub = stubHttp(r);
        const eccc = provider({ id: 'eccc', adapter: 'eccc', feedUrl: 'https://dd.weather.gc.ca/', feedState });
        const out = await ADAPTERS.eccc.run({
            provider: eccc,
            known: new Map(),
            http: stub.http,
            nowMs,
            maxDocs: 40,
            ...extra,
        });
        return { out, calls: stub.calls };
    };
    const at = (hhmmss: string) => Date.parse(`2026-10-13T${hhmmss}Z`);

    it('a file that lands after a newer one from its office was read is still read', async () => {
        const first = await run(
            { ...routes, [`${day}CWUL/18/`]: hour18(['T_WSCN10_C_CWUL_202610131826_0000000103.cap']) },
            {},
            at('18:28:30'),
        );
        expect(first.out.alerts.map((a) => a.identifier)).toEqual([
            'urn:oid:2.49.0.1.124.0000000101.2026',
            'urn:oid:2.49.0.1.124.0000000103.2026',
        ]);
        // The 18:24 Update (it ends ...101) lands at 18:30.
        const second = await run(routes, first.out.feedState, at('18:33:30'));
        expect(second.calls.filter((c) => c.url.endsWith('.cap')).map((c) => c.url.split('/').pop())).toEqual([
            'T_WWCN10_C_CWUL_202610131824_0000000102.cap',
        ]);
        expect(second.out.notModified).toBe(false);
        expect(second.out.withdraw).toContain('urn:oid:2.49.0.1.124.0000000101.2026');
    });

    it('two files from the same minute that arrive in different runs are both read', async () => {
        const late = 'T_WWCN10_C_CWUL_202610131826_0000000099.cap';
        const first = await run(
            { ...routes, [`${day}CWUL/18/`]: hour18(['T_WSCN10_C_CWUL_202610131826_0000000103.cap']) },
            {},
            at('18:28:30'),
        );
        const second = await run(
            {
                ...routes,
                [`${day}CWUL/18/`]: hour18(['T_WSCN10_C_CWUL_202610131826_0000000103.cap', late]),
                [`${day}CWUL/18/${late}`]: fixture('eccc-alert.cap').replaceAll('0000000101', '0000000099'),
            },
            first.out.feedState,
            at('18:33:30'),
        );
        expect(second.out.alerts.map((a) => a.identifier)).toEqual(['urn:oid:2.49.0.1.124.0000000099.2026']);
    });

    it('a warning whose Update was read first never comes back when its own file lands late', async () => {
        const lateAlert = 'T_WWCN10_C_CWUL_202610131820_0000000101.cap';
        const first = await run(routes, {}, at('18:30:00'));
        expect(first.out.withdraw).toContain('urn:oid:2.49.0.1.124.0000000101.2026');
        const second = await run(
            {
                ...routes,
                [`${day}CWUL/17/`]: listing('/20261013/WXO-DD/alerts/cap/20261013/CWUL/17', []),
                [`${day}CWUL/18/`]: hour18([
                    lateAlert,
                    'T_WWCN10_C_CWUL_202610131824_0000000102.cap',
                    'T_WSCN10_C_CWUL_202610131826_0000000103.cap',
                ]),
                [`${day}CWUL/18/${lateAlert}`]: fixture('eccc-alert.cap'),
            },
            first.out.feedState,
            at('18:35:00'),
        );
        expect(second.calls.some((c) => c.url.endsWith(lateAlert))).toBe(true);
        expect(second.out.alerts).toEqual([]);
    });

    it('an office whose directory will not list waits for the next run; the others are read', async () => {
        const { out } = await run(
            {
                ...routes,
                [day]: listing('/20261013/WXO-DD/alerts/cap/20261013', ['CWTO/', 'CWUL/']),
                // CWTO/ answers 404 (no route).
            },
            {},
            NOW,
        );
        expect(out.alerts.map((a) => a.identifier)).toEqual(['urn:oid:2.49.0.1.124.0000000103.2026']);
        expect(out.partial).toBe('1 ECCC directory could not be listed');
        expect(soft(out).listedTo).toEqual({ CWUL: '202610131840' });
    });

    it('a run short of time stops between requests and keeps what each office finished', async () => {
        const cwto = 'T_WOCN11_C_CWTO_202610131815_0000000201.cap';
        const r: Record<string, Route> = {
            ...routes,
            [day]: listing('/20261013/WXO-DD/alerts/cap/20261013', ['CWTO/', 'CWUL/']),
            [`${day}CWTO/`]: listing('/20261013/WXO-DD/alerts/cap/20261013/CWTO', ['18/']),
            [`${day}CWTO/18/`]: listing('/20261013/WXO-DD/alerts/cap/20261013/CWTO/18', [cwto]),
            [`${day}CWTO/18/${cwto}`]: fixture('eccc-fog.cap').replaceAll('0000000103', '0000000201'),
        };
        // Eight requests' worth of time: yesterday (404), today, CWTO's office, hour and file, CWUL's office,
        // hour 17 and its file. CWUL's hour 18 waits for the next run.
        let budget = 8;
        const stub = stubHttp(r);
        const http: Http = {
            get: (url, opts) => {
                budget--;
                return stub.http.get(url, opts);
            },
        };
        const eccc = provider({ id: 'eccc', adapter: 'eccc', feedUrl: 'https://dd.weather.gc.ca/' });
        const out = await ADAPTERS.eccc.run({
            provider: eccc,
            known: new Map(),
            http,
            nowMs: NOW,
            maxDocs: 40,
            timeLeft: () => budget,
        });
        expect(stub.calls).toHaveLength(8);
        expect(out.alerts.map((a) => a.identifier).sort()).toEqual([
            'urn:oid:2.49.0.1.124.0000000101.2026',
            'urn:oid:2.49.0.1.124.0000000201.2026',
        ]);
        expect(soft(out).listedTo).toEqual({ CWTO: '202610131840', CWUL: '202610131759' });
        expect(out.partial).toMatch(/^catching up/);

        const next = await run(r, out.feedState, NOW + 300_000);
        expect(next.out.alerts.map((a) => a.identifier)).toEqual(['urn:oid:2.49.0.1.124.0000000103.2026']);
        expect(next.out.partial).toBeNull();
        expect(soft(next.out).listedTo).toEqual({ CWTO: '202610131845', CWUL: '202610131845' });
    });
});

describe('any CAP feed', () => {
    it('finds the CAP links of an Atom or RSS index', () => {
        expect(
            capIndexLinks(
                parseXml(
                    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link type="application/cap+xml" href="https://cap.example/a.xml"/></entry></feed>',
                )!,
            ),
        ).toEqual(['https://cap.example/a.xml']);
        expect(
            capIndexLinks(
                parseXml('<rss><channel><item><link>https://cap.example/b.xml</link></item></channel></rss>')!,
            ),
        ).toEqual(['https://cap.example/b.xml']);
        expect(capIndexLinks(parseXml('<html/>')!)).toBeNull();
    });

    it('an index that names one CAP document twice, or two documents with one identifier, stores it once', async () => {
        const index =
            '<feed xmlns="http://www.w3.org/2005/Atom">' +
            '<entry><link type="application/cap+xml" href="https://cap.example/a.xml"/></entry>' +
            '<entry><link type="application/cap+xml" href="https://cap.example/a.xml"/></entry>' +
            '<entry><link type="application/cap+xml" href="https://cap.example/b.xml"/></entry></feed>';
        const { http, calls } = stubHttp({
            'https://cap.example/index.xml': index,
            'https://cap.example/a.xml': fixture('meteoalarm-fr-cap.xml'),
            'https://cap.example/b.xml': fixture('meteoalarm-fr-cap.xml'),
        });
        const out = await ADAPTERS.cap.run({
            provider: provider({ id: 'cap-test', feedUrl: 'https://cap.example/index.xml' }),
            known: new Map(),
            http,
            nowMs: NOW,
            maxDocs: 40,
        });
        expect(out.alerts.map((a) => a.identifier)).toEqual(['2.49.0.0.250.0.FR.ZZ0001']);
        expect(calls.filter((c) => c.url === 'https://cap.example/a.xml')).toHaveLength(1);
    });

    it('reads a one-document CAP feed, and refuses a row with no feed URL (the Bureau’s, until licensed)', async () => {
        const { http } = stubHttp({ 'https://cap.example/feed.xml': fixture('meteoalarm-fr-cap.xml') });
        const out = await ADAPTERS.cap.run({
            provider: provider({ id: 'cap-test', feedUrl: 'https://cap.example/feed.xml' }),
            known: new Map(),
            http,
            nowMs: NOW,
            maxDocs: 40,
        });
        expect(out.alerts.map((a) => a.identifier)).toEqual(['2.49.0.0.250.0.FR.ZZ0001']);
        expect(out.alerts[0].zones).toEqual(['EMMA_ID:FR913']);
        await expect(
            ADAPTERS.cap.run({ provider: provider({ id: 'bom' }), known: new Map(), http, nowMs: NOW, maxDocs: 40 }),
        ).rejects.toThrow(/no feed URL/);
    });
});
