/**
 * The responsible centre (129-09): every ocean's WMO tropical cyclone centre,
 * named on the chart, drawn where its data is public domain (NHC, CPHC) and
 * linked everywhere else. JTWC is a labelled US military advisory, never the
 * official warning. Global: no Australia-first default.
 */
import { describe, expect, it } from 'vitest';
import {
    CYCLONE_CENTRES,
    JTWC_NOT_OFFICIAL,
    cycloneCentre,
    productIssuer,
    trackIssuerLabel,
    utcLabel,
    validTimeNear,
} from '../supabase/functions/_shared/cyclone/centres';

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

    it('NHC or CPHC from the product’s own office (MIA, HFO), never the basin letters alone', () => {
        const miami = ['https://www.nhc.noaa.gov/text/MIATCMEP3.shtml'];
        const honolulu = ['https://www.nhc.noaa.gov/text/HFOTCMEP4.shtml'];
        expect(productIssuer(miami, 18, -108)).toBe('NHC');
        // An EP id whose advisory Honolulu wrote is CPHC's, wherever the id says it began.
        expect(productIssuer(honolulu, 14.2, -142.5)).toBe('CPHC');
        expect(productIssuer(['https://www.nhc.noaa.gov/text/HFOTCMCP1.shtml'], 16, -155)).toBe('CPHC');
        expect(productIssuer([undefined, 'https://www.nhc.noaa.gov/text/MIATCPAT1.shtml'], 25, -70)).toBe('NHC');
    });

    it('with no office in the product, the storm’s position: west of 140°W north of the equator is CPHC’s', () => {
        expect(productIssuer([], 16, -150)).toBe('CPHC'); // a Lane-2018 track
        expect(productIssuer([], 16, -120)).toBe('NHC');
        expect(productIssuer(['https://example.test/x'], 16, -138)).toBe('NHC'); // back east of 140°W
        expect(productIssuer([null], 16, -175)).toBe('CPHC');
        expect(productIssuer([], 25, -70)).toBe('NHC');
    });
});

describe('forecast times are UTC from VALIDTIME, never the local label read as UTC', () => {
    const advEp = Date.parse('2026-10-13T12:00:00Z');

    it('reads DD/HHMM against the advisory month', () => {
        expect(validTimeNear('13/0900', advEp)).toBe('2026-10-13T09:00:00.000Z');
        expect(validTimeNear('16/0900', advEp)).toBe('2026-10-16T09:00:00.000Z');
    });

    it('rolls into the next month and year', () => {
        expect(validTimeNear('01/0000', Date.parse('2026-10-31T21:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
        expect(validTimeNear('02/1200', Date.parse('2026-12-31T18:00:00Z'))).toBe('2027-01-02T12:00:00.000Z');
    });

    it('reads a valid time from the month before the advisory, and never a day the month lacks', () => {
        // ADVDATE just after 00Z on the 1st, valid time the last day of the month before.
        expect(validTimeNear('31/1800', Date.parse('2026-11-01T00:30:00Z'))).toBe('2026-10-31T18:00:00.000Z');
        expect(validTimeNear('30/1800', Date.parse('2026-12-01T00:30:00Z'))).toBe('2026-11-30T18:00:00.000Z');
        expect(validTimeNear('31/1800', Date.parse('2027-01-01T03:00:00Z'))).toBe('2026-12-31T18:00:00.000Z');
        // 31 November and 29 February 2027 do not exist: never rolled into the next month,
        // and no other month puts them within days of the advisory.
        expect(validTimeNear('31/0000', Date.parse('2026-11-29T00:00:00Z'))).toBeNull();
        expect(validTimeNear('29/1200', Date.parse('2027-02-27T12:00:00Z'))).toBeNull();
    });

    it('refuses what it cannot read', () => {
        expect(validTimeNear('13/09', advEp)).toBeNull();
        expect(validTimeNear('13/0900', undefined)).toBeNull();
        expect(validTimeNear(undefined, advEp)).toBeNull();
    });
});

describe('utcLabel', () => {
    it('is day, month and UTC time', () => {
        expect(utcLabel(Date.parse('2026-10-14T03:10:00Z'))).toBe('14 Oct 03:10 UTC');
    });
});
