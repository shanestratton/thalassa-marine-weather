/**
 * Every model's track (129-09): fetch-gfs-tracker keeps every a-deck tech it
 * can credit, not only GFS, and draws each as a thin labelled line.
 *
 * The three fixtures are fictional ATCF a-deck lines (tests/fixtures/cyclone,
 * PROVENANCE.json). The formats differ by basin: the Atlantic spells
 * longitude west, the West Pacific east and then west over the antimeridian,
 * the South Pacific latitude south and longitude east then west.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    atcfLat,
    atcfLon,
    cycleIso,
    latestGfsCycles,
    modelTracks,
    parseAdeck,
    techInfo,
} from '../supabase/functions/_shared/cyclone/adeck';

const fixture = (name: string) => readFileSync(`tests/fixtures/cyclone/${name}`, 'utf8');
const NOW = Date.parse('2026-10-13T18:00:00Z');

describe('ATCF positions', () => {
    it('reads tenths of a degree with the hemisphere letter', () => {
        expect(atcfLat('245N')).toBeCloseTo(24.5, 6);
        expect(atcfLat(' 168S')).toBeCloseTo(-16.8, 6);
        expect(atcfLon('700W')).toBeCloseTo(-70, 6);
        expect(atcfLon('1785E')).toBeCloseTo(178.5, 6);
        expect(atcfLon('1793W')).toBeCloseTo(-179.3, 6);
    });

    it('refuses what is not a position', () => {
        for (const bad of ['', '   ', '-99', '1805E', '1805W', '901N', 'garbage', '12X']) {
            expect(atcfLat(bad) ?? atcfLon(bad)).toBeNull();
        }
    });

    it('turns a cycle into an ISO time and refuses a malformed one', () => {
        expect(cycleIso('2026101306')).toBe('2026-10-13T06:00:00.000Z');
        expect(cycleIso('20261013')).toBeNull();
        expect(cycleIso('2026131306')).toBeNull();
    });
});

describe('parseAdeck', () => {
    it('keeps the latest cycle of each tech, one point per tau, in tau order (Atlantic)', () => {
        const tracks = parseAdeck(fixture('adeck-atlantic.dat'));
        const avno = tracks.filter((t) => t.tech === 'AVNO');
        expect(avno).toHaveLength(1);
        expect(avno[0]).toMatchObject({ storm: 'AL31', basin: 'AL', cycle: '2026101300' });
        expect(avno[0].points.map((p) => p.tau)).toEqual([0, 12, 24, 36, 48, 72, 96, 120]);
        expect(avno[0].points[0]).toMatchObject({ lat: 24.5, lon: -70, vmax: 85 });
        expect(avno[0].points[7].lat).toBeCloseTo(33.6, 6);
        expect(avno[0].points[7].lon).toBeCloseTo(-78.4, 6);
        // The malformed line and the positionless SHIP rows are not tracks.
        expect(tracks.find((t) => t.tech === 'SHIP')).toBeUndefined();
        // CARQ's negative taus are history, not forecast.
        expect(tracks.find((t) => t.tech === 'CARQ')?.points.every((p) => p.tau >= 0) ?? true).toBe(true);
    });

    it('reads the West Pacific over the antimeridian and keeps JTWC as its own tech', () => {
        const tracks = parseAdeck(fixture('adeck-wpac.dat'));
        const gfs = tracks.find((t) => t.storm === 'WP33' && t.tech === 'AVNO')!;
        const lons = gfs.points.map((p) => p.lon);
        expect(lons[0]).toBeCloseTo(176.5, 6);
        // East, then west of 180: the feed's own spelling, in [-180, 180].
        expect(lons.some((lon) => lon < 0)).toBe(true);
        expect(lons.every((lon) => lon >= -180 && lon <= 180)).toBe(true);
        expect(tracks.find((t) => t.storm === 'WP33' && t.tech === 'JTWC')).toBeDefined();
        expect(tracks.find((t) => t.storm === 'WP93')).toBeDefined();
    });

    it('reads the South Pacific: south latitudes, east then west longitudes, keyed without the year', () => {
        const tracks = parseAdeck(fixture('adeck-spac.dat'));
        const gfs = tracks.find((t) => t.tech === 'AVNO')!;
        expect(gfs.storm).toBe('SH37');
        expect(gfs.points[0]).toMatchObject({ lat: -16.8, lon: 178.5 });
        expect(gfs.points[2].lat).toBeCloseTo(-18.6, 6);
        expect(gfs.points[2].lon).toBeCloseTo(-179.3, 6);
    });

    it('also reads a file that leads with the centre and its storm id ("JTWC, 28P")', () => {
        const [t] = parseAdeck(
            [
                'JTWC, 28P, 2026101306, 03, AVNO,   0, 214S, 1635E,  62,  990',
                'JTWC, 28P, 2026101306, 03, AVNO,  12, 220S, 1638E,  58,  992',
            ].join('\n'),
        );
        expect(t).toMatchObject({ storm: 'SH28', basin: 'SH', tech: 'AVNO' });
        expect(t.points).toHaveLength(2);
    });

    it('can keep only cycles from a cut-off on', () => {
        const tracks = parseAdeck(fixture('adeck-atlantic.dat'), { sinceCycle: '2026101300' });
        expect(tracks.find((t) => t.tech === 'EMX')).toBeUndefined();
        expect(tracks.find((t) => t.tech === 'EMXI')).toBeDefined();
    });
});

describe('which techs are drawn, and credited', () => {
    it('names the producer of every model it draws', () => {
        expect(techInfo('AVNO')).toEqual({ label: 'GFS', by: 'NOAA NCEP', kind: 'model' });
        expect(techInfo('EMXI')).toEqual({ label: 'ECMWF', by: 'ECMWF', kind: 'model' });
        expect(techInfo('UKXI')?.by).toBe('Met Office');
        expect(techInfo('TVCN')?.kind).toBe('consensus');
        expect(techInfo('OFCL')?.kind).toBe('official');
        expect(techInfo('JTWC')?.kind).toBe('advisory');
    });

    it('does not draw what it cannot credit, a statistical aid, or an ensemble member', () => {
        for (const tech of ['CLP5', 'XTRP', 'BAMM', 'LBAR', 'SHIP', 'AP01', 'EE12', 'ZZZZ', 'CARQ']) {
            expect(techInfo(tech), tech).toBeNull();
        }
    });

    it('gives one labelled line per model per storm, the newest cycle, never the official or JTWC track', () => {
        const lines = modelTracks(parseAdeck(fixture('adeck-atlantic.dat')), NOW);
        const labels = lines.map((l) => l.label).sort();
        expect(labels).toEqual(['Consensus', 'ECMWF', 'GFS', 'UKMO']);
        const gfs = lines.find((l) => l.label === 'GFS')!;
        // AVNI (06Z) is newer than AVNO (00Z).
        expect(gfs).toMatchObject({ storm: 'AL31', tech: 'AVNI', by: 'NOAA NCEP', cycle: '2026-10-13T06:00:00.000Z' });
        expect(gfs.points[0]).toEqual([0, 25.1, -70.6, 85]);
        expect(lines.find((l) => l.label === 'ECMWF')?.tech).toBe('EMXI');
    });

    it('drops a run more than 36 hours old', () => {
        const later = Date.parse('2026-10-15T12:00:00Z');
        expect(modelTracks(parseAdeck(fixture('adeck-atlantic.dat')), later)).toEqual([]);
    });

    it('keeps the South Pacific models, with ECMWF credited', () => {
        const lines = modelTracks(parseAdeck(fixture('adeck-spac.dat')), NOW);
        expect(lines.map((l) => `${l.storm} ${l.label} ${l.by}`).sort()).toEqual([
            'SH37 ECMWF ECMWF',
            'SH37 GFS NOAA NCEP',
        ]);
    });
});

describe('the GFS cycle to look for', () => {
    it('is the newest cycle old enough to be on NOMADS, then the one before', () => {
        expect(latestGfsCycles(Date.parse('2026-10-13T11:00:00Z'))).toEqual([
            { date: '20261013', cycle: '06' },
            { date: '20261013', cycle: '00' },
        ]);
        expect(latestGfsCycles(Date.parse('2026-10-13T03:00:00Z'))).toEqual([
            { date: '20261012', cycle: '18' },
            { date: '20261012', cycle: '12' },
        ]);
    });
});
