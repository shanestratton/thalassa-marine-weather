/**
 * The responsible centre (129-09): every ocean's WMO tropical cyclone centre,
 * named on the chart, drawn where its data is public domain (NHC, CPHC) and
 * linked everywhere else. JTWC is a labelled US military advisory, never the
 * official warning. Global: no Australia-first default.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    CYCLONE_CENTRES,
    JTWC_NOT_OFFICIAL,
    cycloneCentre,
    esriTrackIssuer,
    esriValidTime,
    trackIssuerLabel,
    utcLabel,
} from '../supabase/functions/_shared/cyclone/centres';
import { parseEsriForecast } from '../supabase/functions/_shared/cyclone/esri';

const at = (lat: number, lon: number) => cycloneCentre(lat, lon).id;

describe('cycloneCentre: the WMO centre for every basin', () => {
    it('North Atlantic and East Pacific: NHC (RSMC Miami); Central Pacific: CPHC (RSMC Honolulu)', () => {
        expect(at(25, -70)).toBe('nhc'); // off the Bahamas
        expect(at(14, -30)).toBe('nhc'); // Cape Verde
        expect(at(15, -110)).toBe('nhc'); // off Mexico
        expect(at(18, -155)).toBe('cphc'); // off Hawaii
        expect(at(20, -179.9)).toBe('cphc');
    });

    it('North West Pacific: RSMC Tokyo; North Indian Ocean: RSMC New Delhi', () => {
        expect(at(15, 140)).toBe('jma');
        expect(at(20, 179.9)).toBe('jma');
        expect(at(15, 88)).toBe('imd'); // Bay of Bengal
        expect(at(15, 65)).toBe('imd'); // Arabian Sea
    });

    it('South West Indian Ocean: RSMC La Réunion', () => {
        expect(at(-18, 55)).toBe('reunion');
        expect(at(-20, 40)).toBe('reunion'); // Mozambique Channel
    });

    it('Australian region: the Bureau, with TCWC Jakarta and TCWC Port Moresby where they lead', () => {
        expect(at(-17, 152)).toBe('bom'); // Coral Sea
        expect(at(-14, 128)).toBe('bom'); // Timor Sea, south of Jakarta's line
        expect(at(-12, 110)).toBe('bom');
        expect(at(-8, 110)).toBe('jakarta'); // south of Java
        expect(at(-10.5, 124)).toBe('jakarta'); // BMKG's line steps to 11°S here
        expect(at(-8.5, 138)).toBe('jakarta');
        expect(at(-8, 152)).toBe('portmoresby'); // Solomon Sea
        expect(at(-12, 152)).toBe('bom');
    });

    it('South Pacific: RSMC Nadi north of 25°S and TCWC Wellington south of it, across the antimeridian', () => {
        expect(at(-17.8, 178.4)).toBe('nadi'); // Fiji
        expect(at(-17, 179.9)).toBe('nadi');
        expect(at(-17, -179.9)).toBe('nadi');
        expect(at(-21, -175)).toBe('nadi'); // Tonga
        expect(at(-14, -172)).toBe('nadi'); // Samoa
        expect(at(-30, 175)).toBe('wellington');
        expect(at(-30, -170)).toBe('wellington');
        // 160°E is the Australian region's eastern edge.
        expect(at(-15, 159.9)).toBe('bom');
        expect(at(-15, 160.1)).toBe('nadi');
    });

    it('South Atlantic: the Brazilian Navy west of 20°W; elsewhere the WMO, never a guess', () => {
        expect(at(-28, -45)).toBe('brazil');
        expect(at(-20, -100)).toBe('wmo'); // South East Pacific
        expect(at(36, 18)).toBe('wmo'); // Mediterranean
        expect(at(-30, 0)).toBe('wmo');
        expect(at(Number.NaN, 150)).toBe('wmo');
    });

    it('RSMC New Delhi is the North Indian Ocean only; Brazil stops at METAREA V', () => {
        expect(at(12, 47)).toBe('imd'); // Gulf of Aden
        expect(at(24, 58)).toBe('imd'); // Gulf of Oman
        expect(at(34, 33)).toBe('wmo'); // off Cyprus
        expect(at(43, 35)).toBe('wmo'); // Black Sea
        expect(at(41, 51)).toBe('wmo'); // Caspian
        expect(at(-30, -48)).toBe('brazil'); // off Santa Catarina
        expect(at(-45, -60)).toBe('wmo'); // Argentine waters, METAREA VI
    });

    it('draws only NHC and CPHC; every centre has a name and an https link', () => {
        for (const centre of Object.values(CYCLONE_CENTRES)) {
            expect(centre.short.length).toBeGreaterThan(2);
            expect(centre.url).toMatch(/^https:\/\//);
        }
        const drawn = Object.values(CYCLONE_CENTRES)
            .filter((c) => c.drawn)
            .map((c) => c.id)
            .sort();
        expect(drawn).toEqual(['cphc', 'nhc']);
    });
});

describe('issuer labels', () => {
    it('NHC is official in its own ocean', () => {
        expect(trackIssuerLabel('NHC', cycloneCentre(25, -70))).toEqual({
            official: true,
            text: 'NHC official forecast',
        });
        expect(trackIssuerLabel('CPHC', cycloneCentre(18, -155)).official).toBe(true);
    });

    it('JTWC in the Coral Sea is an advisory, and the official centre is a link', () => {
        const centre = cycloneCentre(-17, 152);
        expect(trackIssuerLabel('JTWC', centre)).toEqual({ official: false, text: JTWC_NOT_OFFICIAL });
        expect(JTWC_NOT_OFFICIAL).toBe('JTWC: US military advisory, not the official warning here');
        expect(centre.drawn).toBe(false);
        expect(centre.url).toMatch(/^https:\/\/www\.bom\.gov\.au\//);
    });

    it('an NHC track outside NHC waters is not called official', () => {
        expect(trackIssuerLabel('NHC', cycloneCentre(20, 170)).official).toBe(false);
    });

    it('esriTrackIssuer: AL and EP are NHC, CP is CPHC, every other basin is JTWC', () => {
        expect(esriTrackIssuer('AL')).toBe('NHC');
        expect(esriTrackIssuer('ep')).toBe('NHC');
        expect(esriTrackIssuer('CP')).toBe('CPHC');
        for (const basin of ['WP', 'IO', 'SH', '', undefined]) expect(esriTrackIssuer(basin)).toBe('JTWC');
    });

    it('an East Pacific storm west of 140°W is CPHC’s, whatever its EP id says', () => {
        expect(esriTrackIssuer('EP', 16, -150)).toBe('CPHC'); // a Lane-2018 track
        expect(esriTrackIssuer('EP', 16, -120)).toBe('NHC');
        expect(esriTrackIssuer('CP', 16, -138)).toBe('NHC'); // back east of 140°W
        expect(esriTrackIssuer('CP', 16, -175)).toBe('CPHC');
        expect(esriTrackIssuer('AL', 25, -70)).toBe('NHC');
        expect(esriTrackIssuer('WP', 20, 179.9)).toBe('JTWC');
    });
});

describe('Esri forecast times are UTC from VALIDTIME, never the local label read as UTC', () => {
    const advEp = Date.parse('2026-10-13T12:00:00Z');

    it('reads DD/HHMM against the advisory month', () => {
        expect(esriValidTime('13/0900', advEp)).toBe('2026-10-13T09:00:00.000Z');
        expect(esriValidTime('16/0900', advEp)).toBe('2026-10-16T09:00:00.000Z');
    });

    it('rolls into the next month and year', () => {
        expect(esriValidTime('01/0000', Date.parse('2026-10-31T21:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
        expect(esriValidTime('02/1200', Date.parse('2026-12-31T18:00:00Z'))).toBe('2027-01-02T12:00:00.000Z');
    });

    it('reads a valid time from the month before the advisory, and never a day the month lacks', () => {
        // ADVDATE just after 00Z on the 1st, valid time the last day of the month before.
        expect(esriValidTime('31/1800', Date.parse('2026-11-01T00:30:00Z'))).toBe('2026-10-31T18:00:00.000Z');
        expect(esriValidTime('30/1800', Date.parse('2026-12-01T00:30:00Z'))).toBe('2026-11-30T18:00:00.000Z');
        expect(esriValidTime('31/1800', Date.parse('2027-01-01T03:00:00Z'))).toBe('2026-12-31T18:00:00.000Z');
        // 31 November and 29 February 2027 do not exist: never rolled into the next month,
        // and no other month puts them within days of the advisory.
        expect(esriValidTime('31/0000', Date.parse('2026-11-29T00:00:00Z'))).toBeNull();
        expect(esriValidTime('29/1200', Date.parse('2027-02-27T12:00:00Z'))).toBeNull();
    });

    it('refuses what it cannot read', () => {
        expect(esriValidTime('13/09', advEp)).toBeNull();
        expect(esriValidTime('13/0900', undefined)).toBeNull();
        expect(esriValidTime(undefined, advEp)).toBeNull();
    });

    it('parses the feed: NHC in MST lands 7 h later than the label read as UTC; JTWC basins are JTWC', () => {
        const storms = parseEsriForecast(JSON.parse(readFileSync('tests/fixtures/cyclone/esri-forecast.json', 'utf8')));
        const ella = storms.find((s) => s.name === 'ZZELLA')!;
        expect(ella).toMatchObject({ key: 'EP41', issuer: 'NHC', advisory: '24A' });
        expect(ella.issued).toBe('2026-10-13T12:00:00.000Z');
        // FLDATELBL "2026-10-13 2:00 AM Tue MST" is 09:00 UTC, not 02:00 UTC.
        expect(ella.points[0]).toEqual({
            lat: 18,
            lon: -108,
            time: '2026-10-13T09:00:00.000Z',
            windKts: 80,
            pressureMb: 960,
        });
        const dora = storms.find((s) => s.name === 'ZZDORA')!;
        expect(dora).toMatchObject({ key: 'SH38', issuer: 'JTWC', advisory: '2026-10-13T06:00:00.000Z' });
        const cora = storms.find((s) => s.name === 'ZZCORA')!;
        expect(cora.points.map((p) => p.lon)).toEqual([178.5, 179.6, -179.3, -177.4]);
    });

    it('a feature with no storm number still gets a key the watcher can store', () => {
        const feature = (name: string, num: number | null, lon: number, lat: number) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                STORMNAME: name,
                BASIN: 'EP',
                STORMNUM: num,
                ADVISNUM: '3',
                ADVDATE: Date.parse('2026-10-13T12:00:00Z'),
                VALIDTIME: '13/1200',
                MAXWIND: 30,
            },
        });
        const storms = parseEsriForecast({
            features: [feature('Twenty-One-E', null, -150, 16), feature('ÑANDÚ', null, -100, 12)],
        });
        expect(storms.map((s) => s.key)).toEqual(['TWENTYONEE', 'NANDU']);
        for (const s of storms) expect(s.key).toMatch(/^[A-Z0-9]{2,12}$/);
        // Issued by position: an EP id west of 140°W is CPHC's.
        expect(storms[0].issuer).toBe('CPHC');
        expect(storms[1].issuer).toBe('NHC');
    });
});

describe('utcLabel', () => {
    it('is day, month and UTC time', () => {
        expect(utcLabel(Date.parse('2026-10-14T03:10:00Z'))).toBe('14 Oct 03:10 UTC');
    });
});
