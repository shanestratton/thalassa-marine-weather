/**
 * The cyclone feed, direct from the warning centres (129-09b): no Esri, no
 * knackwx. The storm list is the union of NHC's CurrentStorms.json (AL, EP,
 * CP), JTWC's RSS and NCEP's TC vitals (every basin), keyed by basin and
 * number. NHC and CPHC tracks and cones come from NOAA's own MapServer, with
 * the issuer read from the product's office (MIA or HFO), never the basin
 * letters alone. JTWC's track is its JMV 3.0 file and its danger area the
 * swath in its KMZ. A source that does not answer is said, per source; with
 * no storm list at all the feed is null, never an empty ocean.
 *
 * Every fixture is fictional (tests/fixtures/PROVENANCE.json).
 */
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildCycloneFeed,
    findKmlEntry,
    kmlDangerArea,
    noaaSlotLayers,
    parseAdvDate,
    parseCurrentStorms,
    parseJmv,
    parseJtwcRss,
    parseNoaaCone,
    parseNoaaPast,
    parseNoaaPoints,
    parseTcvitals,
    readKmzDangerArea,
    type NhcStorm,
} from '../supabase/functions/_shared/cyclone/feed';
import { fetchCycloneFeed, forgetCycloneFeedCache } from '../supabase/functions/_shared/cyclone/sources';

const fixture = (name: string) => readFileSync(`tests/fixtures/cyclone/${name}`, 'utf8');
const NOW = Date.parse('2026-10-13T14:00:00Z');

/** A zip in the KMZ layout: local file headers only, which is all the reader walks. */
function zip(entries: { name: string; data: string | Buffer; deflate: boolean }[]): Uint8Array<ArrayBuffer> {
    const parts: Buffer[] = [];
    for (const e of entries) {
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
        const body = e.deflate ? deflateRawSync(raw) : raw;
        const name = Buffer.from(e.name, 'utf8');
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0, 6);
        h.writeUInt16LE(e.deflate ? 8 : 0, 8);
        h.writeUInt32LE(body.length, 18);
        h.writeUInt32LE(raw.length, 22);
        h.writeUInt16LE(name.length, 26);
        h.writeUInt16LE(0, 28);
        parts.push(h, name, body);
    }
    return new Uint8Array(Buffer.concat(parts));
}
const kmz = () =>
    zip([
        { name: 'images/TS.png', data: Buffer.alloc(900, 7), deflate: false },
        { name: 'doc.kml', data: fixture('jtwc-sh3727-doc.kml'), deflate: true },
    ]);

const nhcStorms = () => parseCurrentStorms(JSON.parse(fixture('nhc-current-storms.json')))!;
const ella = (): NhcStorm => nhcStorms().find((s) => s.key === 'EP41')!;

describe('NHC CurrentStorms.json', () => {
    it('keys each storm by basin and number, and reads the issuer from the product’s office', () => {
        const storms = nhcStorms();
        expect(storms.map((s) => `${s.key} ${s.sid} ${s.name} ${s.by} ${s.bin} ${s.basin}`)).toEqual([
            'EP41 ep412026 ZZELLA NHC EP3 E',
            'AL31 al312026 ZZFLORA NHC AT1 L',
            'CP03 cp032026 ZZNOA CPHC CP1 C',
            // An EP id whose advisories come from Honolulu is CPHC's: the product says so.
            'EP42 ep422026 ÑANDÚ CPHC EP4 E',
        ]);
        expect(ella()).toMatchObject({
            advisory: '24',
            issued: '2026-10-13T12:00:00.000Z',
            nature: 'HU',
            current: { lat: 18.1, lon: -108.1, time: '2026-10-13T12:00:00.000Z', windKts: 80, pressureMb: 960 },
        });
    });

    it('is null when the file is not the storm list', () => {
        expect(parseCurrentStorms({ nothing: [] })).toBeNull();
        expect(parseCurrentStorms('<!DOCTYPE html>')).toBeNull();
        expect(parseCurrentStorms({ activeStorms: [] })).toEqual([]);
    });
});

describe('NOAA NHC_tropical_weather MapServer', () => {
    const service = {
        layers: [
            { id: 4, name: 'AT1' },
            { id: 6, name: 'AT1 Forecast Points' },
            { id: 8, name: 'AT1 Forecast Cone' },
            { id: 11, name: 'AT1 Past Points' },
            { id: 188, name: 'EP3 Forecast Points' },
            { id: 190, name: 'EP3 Forecast Cone' },
            { id: 193, name: 'EP3 Past Points' },
        ],
    };

    it('finds a slot’s layers by name, never by guessing the numbering', () => {
        expect(noaaSlotLayers(service, 'EP3')).toEqual({ points: 188, cone: 190, past: 193 });
        expect(noaaSlotLayers(service, 'AT1')).toEqual({ points: 6, cone: 8, past: 11 });
        expect(noaaSlotLayers(service, 'CP2')).toBeNull();
        expect(noaaSlotLayers({}, 'EP3')).toBeNull();
    });

    it('reads the advisory time from its own zone, never a local label read as UTC', () => {
        expect(parseAdvDate('800 AM MST Tue Oct 13 2026')).toBe(Date.parse('2026-10-13T15:00:00Z'));
        expect(parseAdvDate('1100 PM HST Mon Oct 12 2026')).toBe(Date.parse('2026-10-13T09:00:00Z'));
        expect(parseAdvDate('1100 AM EDT Sun Aug 30 2026')).toBe(Date.parse('2026-08-30T15:00:00Z'));
        expect(parseAdvDate('1200 PM AST Mon Sep 14 2026')).toBe(Date.parse('2026-09-14T16:00:00Z'));
        expect(parseAdvDate('800 AM XYZ Tue Oct 13 2026')).toBeNull();
        expect(parseAdvDate(undefined)).toBeNull();
    });

    it('forecast points: UTC from VALIDTIME, in time order, with the advisory and its issuer', () => {
        const f = parseNoaaPoints(JSON.parse(fixture('noaa-ep3-forecast-points.json')), ella())!;
        expect(f).toMatchObject({ by: 'NHC', advisory: '24', issued: '2026-10-13T12:00:00.000Z' });
        expect(f.points.map((p) => p.time)).toEqual([
            '2026-10-13T09:00:00.000Z',
            '2026-10-13T21:00:00.000Z',
            '2026-10-14T09:00:00.000Z',
            '2026-10-15T09:00:00.000Z',
            '2026-10-16T09:00:00.000Z',
        ]);
        expect(f.points[0]).toEqual({
            lat: 18,
            lon: -108,
            time: '2026-10-13T09:00:00.000Z',
            windKts: 80,
            pressureMb: 960,
        });
        // 9999 is "no value" in the feed, not a pressure.
        expect(f.points[1].pressureMb).toBeNull();
    });

    it('a slot now holding another storm is never drawn as this one', () => {
        const json = JSON.parse(fixture('noaa-ep3-forecast-points.json'));
        for (const f of json.features) f.properties.stormnum = 7;
        expect(parseNoaaPoints(json, ella())).toBeNull();
        expect(parseNoaaPoints({ features: [] }, ella())).toBeNull();
    });

    it('the cone as published, and the past track from its synoptic times', () => {
        const cone = {
            features: [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [-108, 18],
                                [-112, 22],
                                [-110, 23],
                                [-108, 18],
                            ],
                        ],
                    },
                    properties: { stormnum: 41, basin: 'EP', advisnum: '24' },
                },
            ],
        };
        expect(parseNoaaCone(cone, ella())).toEqual(cone.features[0].geometry);
        expect(parseNoaaCone({ features: [] }, ella())).toBeNull();
        const past = parseNoaaPast(
            {
                features: [
                    {
                        geometry: { coordinates: [-107.2, 17.6] },
                        properties: { stormnum: 41, dtg: 2026101306, intensity: 75, mslp: 965 },
                    },
                    {
                        geometry: { coordinates: [-106.4, 17.1] },
                        properties: { stormnum: 41, dtg: 2026101300, intensity: 70, mslp: 0 },
                    },
                    {
                        geometry: { coordinates: [-106.4, 17.1] },
                        properties: { stormnum: 41, dtg: 2026101300, intensity: 70, mslp: 0 },
                    },
                    {
                        geometry: { coordinates: [-90, 10] },
                        properties: { stormnum: 9, dtg: 2026100100, intensity: 20 },
                    },
                ],
            },
            ella(),
        );
        expect(past).toEqual([
            { lat: 17.1, lon: -106.4, time: '2026-10-13T00:00:00.000Z', windKts: 70, pressureMb: null },
            { lat: 17.6, lon: -107.2, time: '2026-10-13T06:00:00.000Z', windKts: 75, pressureMb: 965 },
        ]);
    });
});

describe('JTWC: the RSS, the JMV 3.0 track and the KMZ danger area', () => {
    it('lists each warning with its product, number and storm', () => {
        expect(parseJtwcRss(fixture('jtwc.rss'))).toEqual([
            { product: 'ep4126', key: 'EP41', sid: 'ep412026', name: 'ZZELLA', warning: '24' },
            { product: 'sh3727', key: 'SH37', sid: 'sh372027', name: 'ZZCORA', warning: '7' },
            { product: 'sh3827', key: 'SH38', sid: 'sh382027', name: 'ZZDORA', warning: '12' },
        ]);
        expect(parseJtwcRss('<rss><channel></channel></rss>')).toEqual([]);
    });

    it('reads the forecast track across the antimeridian, the warning-time position and the past track', () => {
        const j = parseJmv(fixture('jtwc-sh3727.tcw'), 'sh3727')!;
        expect(j).toMatchObject({ key: 'SH37', sid: 'sh372027', name: 'ZZCORA', warning: '7' });
        expect(j.issued).toBe('2026-10-13T09:00:00.000Z');
        expect(j.points.map((p) => [p.time, p.lat, p.lon, p.windKts])).toEqual([
            ['2026-10-13T06:00:00.000Z', -16.8, 178.5, 60],
            ['2026-10-13T18:00:00.000Z', -17.8, 179.6, 65],
            ['2026-10-14T06:00:00.000Z', -18.8, -179.3, 70],
            ['2026-10-15T06:00:00.000Z', -20.9, -177.4, 65],
        ]);
        expect(j.current).toEqual({
            lat: -17.1,
            lon: 179,
            time: '2026-10-13T09:00:00.000Z',
            windKts: 60,
            pressureMb: null,
        });
        expect(j.past.map((p) => p.time)).toEqual([
            '2026-10-12T00:00:00.000Z',
            '2026-10-12T06:00:00.000Z',
            '2026-10-12T12:00:00.000Z',
            '2026-10-12T18:00:00.000Z',
            '2026-10-13T00:00:00.000Z',
            '2026-10-13T06:00:00.000Z',
        ]);
        expect(j.past[0]).toMatchObject({ lat: -15, lon: 176, windKts: 35 });
    });

    it('refuses a file that is not the storm it was fetched for', () => {
        expect(parseJmv(fixture('jtwc-sh3727.tcw'), 'sh3827')).toBeNull();
        expect(parseJmv('<!DOCTYPE html><title>403</title>', 'sh3727')).toBeNull();
    });

    it('takes the 34 kt danger swath from the KMZ, past the images, kept in -180..180', async () => {
        const area = (await readKmzDangerArea(kmz()))!;
        expect(area.type).toBe('Polygon');
        const ring = (area as { coordinates: number[][][] }).coordinates[0];
        expect(ring).toHaveLength(11);
        expect(ring[0]).toEqual([176.5, -15]);
        expect(ring[ring.length - 1]).toEqual(ring[0]);
        expect(ring.some(([lon]) => lon < -178)).toBe(true);
        for (const [lon, lat] of ring) {
            expect(Math.abs(lon)).toBeLessThanOrEqual(180);
            expect(Math.abs(lat)).toBeLessThanOrEqual(90);
        }
    });

    it('no swath, no zip, or a cut-off download is no danger area, never a guessed one', async () => {
        expect(kmlDangerArea(fixture('jtwc-sh3727-doc.kml').replace('Danger Swath', 'Something else'))).toBeNull();
        expect(await readKmzDangerArea(new TextEncoder().encode('<!DOCTYPE html>'))).toBeNull();
        const whole = kmz();
        expect(findKmlEntry(whole.slice(0, 40))).toBe('more');
        expect(findKmlEntry(whole)).toMatchObject({ method: 8 });
        expect(findKmlEntry(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    });
});

describe('NCEP TC vitals: every basin, read by column', () => {
    it('keeps a long name out of the date, and reads m/s winds as knots', () => {
        const v = parseTcvitals(fixture('tcvitals.txt'));
        expect(v.map((s) => `${s.key} ${s.sid} ${s.name} ${s.centre}`)).toEqual([
            'EP41 ep412026 ZZELLA NHC',
            'AL31 al312026 ZZFLORA NHC',
            // The southern season is numbered for the year it ends.
            'SH37 sh372027 ZZCORA JTWC',
            'SH38 sh382027 ZZDORA JTWC',
            'WP33 wp332026 TWENTY-TH JTWC',
            'IO02 io022026 ZZMEERA JTWC',
        ]);
        const wp = v.find((s) => s.key === 'WP33')!;
        expect(wp.current).toEqual({
            lat: 15.2,
            lon: 179.5,
            time: '2026-10-13T06:00:00.000Z',
            windKts: 45,
            pressureMb: 995,
        });
        expect(wp.basin).toBe('W');
        expect(v.find((s) => s.key === 'IO02')!.basin).toBe('A');
        expect(v.find((s) => s.key === 'EP41')!.current.windKts).toBe(80);
    });

    it('drops invests and lines it cannot read', () => {
        const v = parseTcvitals(`${fixture('tcvitals.txt')}\ngarbage\nJTWC 99W ??\n`);
        expect(v.some((s) => s.key.endsWith('93'))).toBe(false);
        expect(v).toHaveLength(6);
    });
});

/** Every source answering, as the fixtures have it. */
function allSources() {
    const nhc = nhcStorms();
    const noaa = new Map<string, ReturnType<typeof parseNoaaPoints> | 'unavailable'>();
    const points = parseNoaaPoints(JSON.parse(fixture('noaa-ep3-forecast-points.json')), ella())!;
    noaa.set('EP41', points);
    noaa.set('AL31', 'unavailable');
    const cora = parseJmv(fixture('jtwc-sh3727.tcw'), 'sh3727')!;
    const dora = parseJmv(fixture('jtwc-sh3827.tcw'), 'sh3827')!;
    return {
        nhc,
        noaa,
        jtwc: {
            listed: parseJtwcRss(fixture('jtwc.rss')),
            storms: [
                {
                    ...cora,
                    cone: {
                        type: 'Polygon' as const,
                        coordinates: [
                            [
                                [176.5, -15],
                                [179, -16],
                                [176.5, -15],
                            ],
                        ],
                    },
                },
                { ...dora, coneUnavailable: true as const },
            ],
            failed: [] as string[],
        },
        vitals: parseTcvitals(fixture('tcvitals.txt')),
        nowMs: NOW,
    };
}

describe('buildCycloneFeed: one storm list keyed by basin and number', () => {
    it('the union of every list, no invest, each storm once', () => {
        const feed = buildCycloneFeed(allSources());
        expect(feed.storms.map((s) => s.key)).toEqual(['AL31', 'CP03', 'EP41', 'EP42', 'IO02', 'SH37', 'SH38', 'WP33']);
        expect(feed.storms.find((s) => s.key === 'EP41')!.from).toEqual(['jtwc', 'nhc', 'vitals']);
        expect(feed.sources).toEqual({
            nhc: 'ok',
            jtwc: 'ok',
            vitals: 'ok',
            noaa: 'unavailable',
            jtwcTracks: 'ok',
        });
        expect(feed.generatedAt).toBe(new Date(NOW).toISOString());
    });

    it('the official track for NHC’s storms, JTWC’s advisory elsewhere, and a position where neither has one', () => {
        const feed = buildCycloneFeed(allSources());
        const by = (k: string) => feed.storms.find((s) => s.key === k)!;
        expect(by('EP41')).toMatchObject({
            name: 'ZZELLA',
            positionBy: 'NHC',
            forecast: { by: 'NHC', advisory: '24' },
        });
        expect(by('SH37').forecast).toMatchObject({ by: 'JTWC', advisory: '7', issued: '2026-10-13T09:00:00.000Z' });
        expect(by('SH37').forecast?.cone?.type).toBe('Polygon');
        // The warning-time position is newer than the 06Z vitals.
        expect(by('SH37').current).toMatchObject({ lat: -17.1, lon: 179, time: '2026-10-13T09:00:00.000Z' });
        expect(by('SH37')).toMatchObject({ sid: 'sh372027', basin: 'P', positionBy: 'JTWC' });
        expect(by('SH38').forecast?.coneUnavailable).toBe(true);
        // In the vitals only: a position, said to be one, with no track and no failure.
        expect(by('WP33')).toMatchObject({ name: 'TWENTY-TH', positionBy: 'JTWC', from: ['vitals'] });
        expect(by('WP33').forecast).toBeUndefined();
        expect(by('WP33').forecastUnavailable).toBeUndefined();
        // NOAA failed for this one: its track is unavailable, never "none issued".
        expect(by('AL31').forecastUnavailable).toBe(true);
        expect(by('CP03').positionBy).toBe('CPHC');
    });

    it('a name JMV cut at 10 letters is taken whole from the RSS, and only then', () => {
        const input = allSources();
        const listed = input.jtwc.listed.map((l) =>
            l.key === 'SH37' ? { ...l, name: 'ZZCORALINE' } : l.key === 'SH38' ? { ...l, name: 'OTHER' } : l,
        );
        const feed = buildCycloneFeed({ ...input, jtwc: { ...input.jtwc, listed } });
        expect(feed.storms.find((s) => s.key === 'SH37')!.name).toBe('ZZCORALINE');
        expect(feed.storms.find((s) => s.key === 'SH38')!.name).toBe('ZZDORA');
    });

    it('a storm list that failed still leaves the others, and JTWC’s storms say their track is unavailable', () => {
        const input = allSources();
        const feed = buildCycloneFeed({ ...input, jtwc: null });
        expect(feed.sources.jtwc).toBe('unavailable');
        const cora = feed.storms.find((s) => s.key === 'SH37')!;
        expect(cora.from).toEqual(['vitals']);
        expect(cora.forecast).toBeUndefined();
        expect(cora.forecastUnavailable).toBe(true);
        // A storm NHC answers for is not marked by JTWC's outage.
        expect(feed.storms.find((s) => s.key === 'EP41')!.forecastUnavailable).toBeUndefined();
        const noNhc = buildCycloneFeed({ ...input, nhc: null, noaa: new Map() });
        expect(noNhc.sources.nhc).toBe('unavailable');
        expect(noNhc.storms.find((s) => s.key === 'EP41')).toMatchObject({ name: 'ZZELLA', positionBy: 'NHC' });
        expect(noNhc.storms.find((s) => s.key === 'EP41')!.forecastUnavailable).toBe(true);
    });

    it('a JTWC warning whose product did not come is said by name, never dropped in silence', () => {
        const input = allSources();
        // Warning 7 for ZZCORA: its JMV failed, and the vitals carry it only as an invest (dropped).
        const vitals = parseTcvitals(
            `${fixture('tcvitals.txt').replace(/^JTWC 37P .*$/m, '')}\n` +
                'JTWC 95P INVEST    20261013 0600 168S 1785E 120 041 0975 1004 0250 31 025 0220 0240 0200 0190 M\n',
        );
        const others = input.jtwc.storms.filter((s) => s.key !== 'SH37');
        const failed = buildCycloneFeed({
            ...input,
            vitals,
            jtwc: { ...input.jtwc, storms: others, failed: ['SH37'] },
        });
        expect(failed.storms.some((s) => s.key === 'SH37')).toBe(false);
        expect(failed.sources.jtwcTracks).toBe('unavailable');
        expect(failed.unplaced).toEqual([{ key: 'SH37', name: 'ZZCORA', warning: '7' }]);
        // Past the products one run reads: the same, not a quiet gap.
        const cut = buildCycloneFeed({ ...input, vitals, jtwc: { ...input.jtwc, storms: others, failed: [] } });
        expect(cut.sources.jtwcTracks).toBe('unavailable');
        expect(cut.unplaced.map((u) => u.key)).toEqual(['SH37']);
        // Where another list places it: drawn there, its track unavailable.
        const placed = buildCycloneFeed({ ...input, jtwc: { ...input.jtwc, storms: others, failed: [] } });
        expect(placed.storms.find((s) => s.key === 'SH37')!.forecastUnavailable).toBe(true);
        expect(placed.sources.jtwcTracks).toBe('unavailable');
        expect(placed.unplaced).toEqual([]);
        // Every product read: nothing unplaced.
        expect(buildCycloneFeed(input).unplaced).toEqual([]);
    });

    it('an East Pacific storm past 180°, which NHC no longer lists, takes JTWC’s track under its E id', () => {
        const fictus = parseJmv(DATELINE_JMV, 'ep0526')!;
        expect(fictus).toMatchObject({ key: 'EP05', warning: '60', name: 'ZZFICTUS' });
        const vitals = parseTcvitals(DATELINE_VITALS);
        const listed = parseJtwcRss(DATELINE_RSS);
        expect(listed.map((l) => l.key)).toEqual(['EP05']);
        for (const nhc of [[], null]) {
            const feed = buildCycloneFeed({
                nhc,
                noaa: new Map(),
                jtwc: { listed, storms: [fictus], failed: [] },
                vitals,
                nowMs: NOW,
            });
            const s = feed.storms.find((x) => x.key === 'EP05')!;
            expect(s.forecast).toMatchObject({ by: 'JTWC', advisory: '60' });
            expect(s.forecastUnavailable).toBeUndefined();
            // NOAA was not asked for a storm NHC does not advise on: never "NOAA unavailable".
            expect(feed.sources.noaa).toBe('none');
            expect(feed.sources.jtwcTracks).toBe('ok');
        }
        // Its product failed too: then, and only then, its track is unavailable.
        const down = buildCycloneFeed({
            nhc: [],
            noaa: new Map(),
            jtwc: { listed, storms: [], failed: ['EP05'] },
            vitals,
            nowMs: NOW,
        });
        expect(down.storms.find((x) => x.key === 'EP05')!.forecastUnavailable).toBe(true);
        expect(down.sources).toMatchObject({ noaa: 'none', jtwcTracks: 'unavailable' });
    });
});

/** Fictional: an East Pacific storm, 05E, that crossed 180° into the West Pacific (as Dora did in 2023). */
const DATELINE_JMV = [
    'WTPN31 PGTW 130900',
    'WARNING    ATCG MIL 05E NEPAC 261013084500',
    '2026101306 05E ZZFICTUS   060  01 280 10 SATL 030',
    'T000 185N 1765E 070 R034 100 NE QD 100 SE QD 090 SW QD 090 NW QD ',
    'T012 188N 1748E 075 R034 110 NE QD 110 SE QD 100 SW QD 100 NW QD ',
    'T024 192N 1731E 075 R034 120 NE QD 120 SE QD 110 SW QD 110 NW QD ',
    'AMP',
    'SUBJ:  HURRICANE 05E (ZZFICTUS) WARNING NR 060',
    '   FICTIONAL (129-09B): NO REAL STORM.',
    'REMARKS:',
    '130900Z POSITION NEAR 18.6N 176.0E.',
    '//',
    '0526101300 182N1778E  70',
    '0526101306 185N1765E  70',
    'NNNN',
].join('\n');
const DATELINE_VITALS =
    'JTWC 05E ZZFICTUS  20261013 0600 185N 1765E 280 040 0985 1006 0220 36 030 0150 0150 0120 0120 M\n';
const DATELINE_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><item>
<title>Current Northwest Pacific/North Indian Ocean* Tropical Systems</title>
<description><![CDATA[<p><b>Hurricane  05E (Zzfictus) Warning #60 </b><br>
<li><a href='https://www.metoc.navy.mil/jtwc/products/ep0526.tcw'>JMV 3.0 Data</a></li>]]></description>
</item></channel></rss>`;

describe('fetchCycloneFeed: every source direct from its centre', () => {
    const MAPSERVER =
        'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
    const layers = {
        layers: [
            { id: 6, name: 'AT1 Forecast Points' },
            { id: 8, name: 'AT1 Forecast Cone' },
            { id: 11, name: 'AT1 Past Points' },
            { id: 188, name: 'EP3 Forecast Points' },
            { id: 190, name: 'EP3 Forecast Cone' },
            { id: 193, name: 'EP3 Past Points' },
        ],
    };
    const down = new Set<string>();
    const urls: string[] = [];
    /** Extra RSS items, products and vitals lines for one test. */
    const extra = { rss: '', vitals: '', products: new Map<string, string>() };
    const answer = (url: string): Response => {
        const is = (part: string) => url.includes(part);
        const off = [...down].some((d) => url.includes(d));
        if (off) return new Response('<!DOCTYPE html><h1>403 ERROR</h1>', { status: 403 });
        if (is('CurrentStorms.json')) return new Response(fixture('nhc-current-storms.json'));
        if (url.startsWith(`${MAPSERVER}?f=json`)) return new Response(JSON.stringify(layers));
        if (is(`${MAPSERVER}/188/query`)) return new Response(fixture('noaa-ep3-forecast-points.json'));
        if (is(`${MAPSERVER}/190/query`))
            return new Response(
                JSON.stringify({
                    features: [
                        {
                            geometry: {
                                type: 'Polygon',
                                coordinates: [
                                    [
                                        [-108, 18],
                                        [-112, 22],
                                        [-110, 23],
                                        [-108, 18],
                                    ],
                                ],
                            },
                            properties: { stormnum: 41, basin: 'EP' },
                        },
                    ],
                }),
            );
        if (is(`${MAPSERVER}/193/query`)) return new Response(JSON.stringify({ features: [] }));
        if (is('/jtwc/rss/jtwc.rss'))
            return new Response(fixture('jtwc.rss').replace('</channel>', `${extra.rss}</channel>`));
        for (const [product, text] of extra.products) if (is(`/jtwc/products/${product}`)) return new Response(text);
        if (is('/jtwc/products/sh3727.tcw')) return new Response(fixture('jtwc-sh3727.tcw'));
        if (is('/jtwc/products/sh3827.tcw')) return new Response(fixture('jtwc-sh3827.tcw'));
        if (is('/jtwc/products/sh3727.kmz')) return new Response(kmz());
        if (is('syndata.tcvitals.tm00')) return new Response(fixture('tcvitals.txt') + extra.vitals);
        return new Response('missing', { status: 404 });
    };

    beforeEach(() => {
        forgetCycloneFeedCache();
        down.clear();
        urls.length = 0;
        extra.rss = '';
        extra.vitals = '';
        extra.products.clear();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string) => {
                urls.push(String(input));
                return answer(String(input));
            }),
        );
    });
    afterEach(() => vi.unstubAllGlobals());

    it('builds the feed from NOAA, NHC, JTWC and NCEP only, and fetches JTWC’s track only where NHC is not official', async () => {
        const feed = (await fetchCycloneFeed(NOW))!;
        expect(feed.storms.map((s) => s.key)).toEqual(['AL31', 'CP03', 'EP41', 'EP42', 'IO02', 'SH37', 'SH38', 'WP33']);
        const ella = feed.storms.find((s) => s.key === 'EP41')!;
        expect(ella.forecast).toMatchObject({ by: 'NHC', advisory: '24' });
        expect(ella.forecast?.cone?.type).toBe('Polygon');
        expect(feed.storms.find((s) => s.key === 'SH37')!.forecast?.cone?.type).toBe('Polygon');
        // sh3827.kmz is missing: its danger area is unavailable, not "none published".
        expect(feed.storms.find((s) => s.key === 'SH38')!.forecast?.coneUnavailable).toBe(true);
        expect(urls.some((u) => u.includes('ep4126'))).toBe(false);
        for (const u of urls) {
            expect(new URL(u).hostname).toMatch(/(^|\.)(noaa\.gov|navy\.mil)$/);
        }
        expect(urls.join(' ')).not.toMatch(/arcgis\.com|knackwx/i);
    });

    it('each source that does not answer is said by name, and the others still list their storms', async () => {
        down.add('/jtwc/');
        const feed = (await fetchCycloneFeed(NOW))!;
        expect(feed.sources).toMatchObject({ nhc: 'ok', jtwc: 'unavailable', vitals: 'ok' });
        expect(feed.storms.find((s) => s.key === 'SH37')).toMatchObject({
            from: ['vitals'],
            forecastUnavailable: true,
        });
    });

    it('a warning whose product fails, which no other list places, is named in the feed and JTWC’s tracks are unavailable', async () => {
        down.add('/jtwc/products/sh3727.tcw');
        down.add('tcvitals');
        const feed = (await fetchCycloneFeed(NOW))!;
        expect(feed.storms.some((s) => s.key === 'SH37')).toBe(false);
        expect(feed.sources).toMatchObject({ jtwc: 'ok', vitals: 'unavailable', jtwcTracks: 'unavailable' });
        expect(feed.unplaced).toEqual([{ key: 'SH37', name: 'ZZCORA', warning: '7' }]);
    });

    it('reads JTWC’s product for an East Pacific storm NHC no longer lists, and never for one it does', async () => {
        extra.rss = DATELINE_RSS.slice(DATELINE_RSS.indexOf('<item>'), DATELINE_RSS.indexOf('</channel>'));
        extra.vitals = DATELINE_VITALS;
        extra.products.set('ep0526.tcw', DATELINE_JMV);
        const feed = (await fetchCycloneFeed(NOW))!;
        expect(feed.storms.find((s) => s.key === 'EP05')!.forecast).toMatchObject({ by: 'JTWC', advisory: '60' });
        expect(feed.storms.find((s) => s.key === 'EP05')!.forecastUnavailable).toBeUndefined();
        expect(urls.some((u) => u.endsWith('/jtwc/products/ep0526.tcw'))).toBe(true);
        expect(urls.some((u) => u.includes('ep4126'))).toBe(false);
        // NHC's list down as well: the vitals put it past 180°, so JTWC's product is still read.
        forgetCycloneFeedCache();
        urls.length = 0;
        down.add('CurrentStorms.json');
        const noNhc = (await fetchCycloneFeed(NOW))!;
        expect(noNhc.storms.find((s) => s.key === 'EP05')!.forecast?.by).toBe('JTWC');
        expect(urls.some((u) => u.includes('ep4126'))).toBe(false);
    });

    it('with no storm list answering it is null: unavailable, never an empty ocean', async () => {
        down.add('CurrentStorms.json');
        down.add('/jtwc/');
        down.add('tcvitals');
        expect(await fetchCycloneFeed(NOW)).toBeNull();
    });
});
