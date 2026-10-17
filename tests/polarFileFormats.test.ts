/**
 * Real Expedition polar files are read (build 132, package 132-B22).
 *
 * Expedition writes a "!Expedition polar" line, then a line per true wind
 * speed of angle / boat speed PAIRS, tab-separated, each line with its own
 * beat and run angles. Before 132 every .pol was read as a TWA × TWS table
 * and called "Expedition": a real Expedition file was refused, and one
 * without its "!" line had its first line's angles and speeds read as wind
 * speeds. The import now tells the layout from the file, and refuses a file
 * routes cannot sail on, with the resolver's own reason.
 *
 * Fixtures are made up by hand for a fictional boat (tests/fixtures/polars,
 * PROVENANCE.json); no network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PolarData, VesselProfile } from '../types';
import { PolarFileError, parsePolarFile, readPolarFile } from '../utils/polarParser';
import { resolveRoutingPolarFrom, toEdgePolar, whyRoutesCannotSail } from '../services/routingPolar';
import { createPolarSpeedLookup } from '../services/isochrone/polar';
import { validatePolarData as edgeValidatePolar } from '../supabase/functions/_shared/route-weather-safety';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/polars', name), 'utf8');
const EXPEDITION = fixture('fair-wind-expedition.txt');
const TABLE = fixture('fair-wind-table.pol');
const UPWIND_ONLY = fixture('upwind-only.pol');

const cell = (p: PolarData, twa: number, tws: number) => {
    const a = p.angles.indexOf(twa);
    const w = p.windSpeeds.indexOf(tws);
    if (a < 0 || w < 0) throw new Error(`no cell at ${twa}° / ${tws} kn`);
    return p.matrix[a][w];
};

const SLOOP: VesselProfile = {
    name: 'Fair Wind',
    type: 'sail',
    length: 38,
    beam: 12.8,
    draft: 6.2,
    displacement: 15000,
    maxWaveHeight: 10,
    cruisingSpeed: 6.5,
};

describe('an Expedition polar file (132-B22)', () => {
    const { polar, format } = readPolarFile(EXPEDITION);

    it('is read as Expedition: a column per wind-speed line, a row per angle any line names', () => {
        expect(format).toBe('expedition');
        expect(polar.windSpeeds).toEqual([6, 8, 10, 12, 16, 20]);
        // Each line's beat and run angles (to the whole degree) beside the
        // angles every line has; the 6 kn line's run angle, written last, is
        // put in its place.
        expect(polar.angles).toEqual([
            38, 39, 40, 41, 43, 44, 52, 60, 75, 90, 110, 120, 135, 142, 146, 150, 152, 166, 175, 179,
        ]);
        expect(polar.matrix).toHaveLength(polar.angles.length);
        expect(polar.matrix.every((row) => row.length === polar.windSpeeds.length)).toBe(true);
    });

    it('keeps every figure the file gives under its own angle and wind speed', () => {
        expect(cell(polar, 52, 6)).toBe(5.12);
        expect(cell(polar, 90, 20)).toBe(7.95);
        expect(cell(polar, 60, 12)).toBe(7.08);
        expect(cell(polar, 44, 6)).toBe(4.62); // 44.2°, its beat at 6 kn
        expect(cell(polar, 43, 8)).toBe(5.41); // 42.6°
        expect(cell(polar, 142, 6)).toBe(4.21); // 141.8°, written after 150°
        expect(cell(polar, 179, 20)).toBe(7.4); // 178.5°
    });

    it('between a line’s own angles, interpolates; past its deepest, holds; inside its beat angle, 0', () => {
        // 12 kn: 39.9° → 6.22, 52° → 6.81.
        expect(cell(polar, 41, 12)).toBeCloseTo(6.22 + (6.81 - 6.22) / 12, 2);
        // 6 kn: 142° → 4.21, 150° → 3.72.
        expect(cell(polar, 146, 6)).toBeCloseTo((4.21 + 3.72) / 2, 1);
        // Past the 6 kn line's deepest angle (150°) its figure is held, as
        // routes hold any table's last row.
        expect(cell(polar, 179, 6)).toBe(3.72);
        // Closer to the wind than her beat angle at that wind: no figure.
        expect(cell(polar, 38, 6)).toBe(0);
        expect(cell(polar, 43, 6)).toBe(0);
        expect(cell(polar, 38, 20)).toBe(6.55);
    });

    it('routes can sail it, on the figures the file gives, with a no-go zone', () => {
        expect(whyRoutesCannotSail(polar)).toBeNull();
        const settings = { polarData: polar, polarBoatModel: 'Fair Wind', polarSource_type: 'file_import' as const };
        const resolved = resolveRoutingPolarFrom({ settings, vessel: SLOOP, learned: null });
        expect(resolved.source).toBe('imported');
        expect(resolved.label).toBe('Fair Wind (imported)');
        expect(createPolarSpeedLookup(resolved.polar, 10)(90)).toBeCloseTo(7.05, 5);
        expect(createPolarSpeedLookup(resolved.polar, 16)(110)).toBeCloseTo(7.88, 5);
        // Inside her first priced angle less the no-go ramp, she does not sail.
        expect(createPolarSpeedLookup(resolved.polar, 10)(30)).toBe(0);
        // And the weather-route server takes it as the app sends it.
        expect(() => edgeValidatePolar(toEdgePolar(resolved))).not.toThrow();
    });

    it('reads the same without its "!" lines, with Windows line ends and a byte-order mark, or spaced', () => {
        const bare = EXPEDITION.split('\n')
            .filter((line) => !line.startsWith('!'))
            .join('\n');
        const crlf = `\uFEFF${EXPEDITION.replace(/\n/g, '\r\n')}`;
        const spaced = EXPEDITION.replace(/\t/g, '  ');
        for (const [label, text] of [
            ['bare', bare],
            ['crlf', crlf],
            ['spaced', spaced],
        ] as const) {
            const read = readPolarFile(text);
            expect(read.format, label).toBe('expedition');
            expect(read.polar, label).toEqual(polar);
        }
    });

    it('takes the first line of a repeated wind speed, and drops a 0 kn line and 0 kn pairs', () => {
        const text = [
            '!Expedition polar',
            '0\t45\t0\t90\t0',
            '6\t45\t4.5\t90\t5.6\t150\t0\t180\t3.1',
            '6\t45\t9.9\t90\t9.9\t180\t9.9',
            '10\t42\t5.9\t90\t7.0\t180\t5.2',
        ].join('\n');
        const read = readPolarFile(text).polar;
        expect(read.windSpeeds).toEqual([6, 10]);
        expect(read.angles).toEqual([42, 45, 90, 180]);
        expect(cell(read, 45, 6)).toBe(4.5);
        expect(cell(read, 180, 6)).toBe(3.1);
        expect(cell(read, 42, 6)).toBe(0);
    });

    it('says so when an Expedition file has no wind-speed lines', () => {
        expect(() => readPolarFile('!Expedition polar\n!nothing else')).toThrow(PolarFileError);
        expect(() => readPolarFile('!Expedition polar\n!nothing else')).toThrow('No valid wind speed lines found');
    });
});

describe('a TWA × TWS table, as most .pol and .csv files are (132-B22)', () => {
    it('is read as a table: semicolons, decimal commas and a 0 kn column', () => {
        const { polar, format } = readPolarFile(TABLE);
        expect(format).toBe('table');
        expect(polar.windSpeeds).toEqual([6, 8, 10, 12, 16, 20]);
        expect(polar.angles).toEqual([0, 40, 52, 60, 90, 120, 150, 180]);
        expect(cell(polar, 52, 10)).toBe(6.45);
        expect(cell(polar, 180, 20)).toBe(7.35);
        expect(whyRoutesCannotSail(polar)).toBeNull();
    });

    it('a table with tabs, its header a word, is still a table (never mistaken for Expedition)', () => {
        const read = readPolarFile(['TWA\t6\t8\t10', '45\t4.2\t5.0\t5.6', '90\t5.3\t6.3\t7.0'].join('\n'));
        expect(read.format).toBe('table');
        expect(read.polar.windSpeeds).toEqual([6, 8, 10]);
        // A table row read as pairs would have "angles" of 4.2 and 5.6: under 20°, so not Expedition.
        const headless = readPolarFile(['0\t6\t8', '45\t4.2\t5.0', '90\t5.3\t6.3'].join('\n'));
        expect(headless.format).toBe('table');
    });

    // Review fix: split by spaces, "TWA TWS" was two cells. Every figure was
    // read one wind speed low, the last column came out empty and was dropped,
    // and routes sailed an optimistic polar without a word.
    const ROWS = [
        [45, 4.6, 5.4, 5.9, 6.2, 6.5, 6.6],
        [60, 5.3, 6.2, 6.7, 7.0, 7.3, 7.4],
        [90, 5.6, 6.5, 7.0, 7.4, 7.7, 7.9],
        [120, 5.2, 6.2, 6.9, 7.3, 7.9, 8.3],
        [150, 3.7, 4.7, 5.6, 6.3, 7.1, 7.9],
        [180, 3.0, 4.0, 4.9, 5.7, 6.6, 7.3],
    ];
    const table = (header: string, sep: string) =>
        [header, ...ROWS.map((row) => row.join(sep))].join('\n').replace(/\|/g, sep);

    it('a header label of more than one word is one label: every figure stays under its own wind speed', () => {
        for (const [header, sep] of [
            ['TWA TWS 6 8 10 12 16 20', ' '],
            ['TWA / TWS   6  8  10  12  16  20', ' '],
            ['TWA|TWS|6|8|10|12|16|20', '\t'],
            ['TWA|TWS|6|8|10|12|16|20', ';'],
        ]) {
            const label = `${JSON.stringify(header)} by ${JSON.stringify(sep)}`;
            const { polar, format } = readPolarFile(table(header, sep));
            expect(format, label).toBe('table');
            expect(polar.windSpeeds, label).toEqual([6, 8, 10, 12, 16, 20]);
            expect(polar.matrix, label).toEqual(ROWS.map((row) => row.slice(1)));
            expect(cell(polar, 120, 20), label).toBe(8.3);
            expect(whyRoutesCannotSail(polar), label).toBeNull();
        }
    });

    it('a header that does not line up with its rows is refused, not read a column off', () => {
        // No "TWA" corner: 6 would be taken for the label, and every figure read a wind speed high.
        const noCorner = table('6 8 10 12 16 20', ' ');
        expect(() => readPolarFile(noCorner)).toThrow(PolarFileError);
        expect(() => readPolarFile(noCorner)).toThrow(
            "The 45° row has more figures than the header has wind speeds, so its columns don't line up",
        );
        // A row one figure longer than the header, by tabs or by commas: the same.
        expect(() => readPolarFile(['TWA\t6\t8', '45\t4.6\t5.4', '90\t5.6\t6.5\t7.0'].join('\n'))).toThrow(
            'The 90° row has more figures',
        );
        expect(() => readPolarFile(['TWA,6,8', '45,4.6,5.4,5.9'].join('\n'))).toThrow(PolarFileError);
        // A trailing separator or a short row is not a misfit: short rows read 0, as before.
        const ragged = readPolarFile(['TWA;6;8;', '45;4,6;5,4;', '90;5,6'].join('\n')).polar;
        expect(ragged.matrix).toEqual([
            [4.6, 5.4],
            [5.6, 0],
        ]);
    });

    it('parsePolarFile still returns the polar alone, whatever the file is called', () => {
        expect(parsePolarFile(EXPEDITION, 'Fair Wind.pol')).toEqual(readPolarFile(EXPEDITION).polar);
        expect(parsePolarFile(TABLE, 'Fair Wind.csv')).toEqual(readPolarFile(TABLE).polar);
    });
});

describe('a file routes cannot sail on is refused, in the resolver’s words (132-B22)', () => {
    it('figures only to 52°: too many of its figures off the wind are zero', () => {
        const { polar } = readPolarFile(UPWIND_ONLY);
        expect(whyRoutesCannotSail(polar)).toBe('too many of its figures off the wind are zero');
        // The resolver refuses it the same way: saved, every route would sail the generic polar.
        const resolved = resolveRoutingPolarFrom({
            settings: { polarData: polar, polarSource_type: 'file_import' },
            vessel: SLOOP,
            learned: null,
        });
        expect(resolved.label).toBe('Generic cruising polar (your imported polar could not be used)');
    });

    it('real speed dead into the wind: not a sailing polar', () => {
        const polar = parsePolarFile(
            ['TWA\t6\t10', '10\t3.0\t4.0', '45\t4.6\t5.9', '90\t5.6\t7.0', '150\t3.7\t5.6', '180\t3.0\t4.9'].join('\n'),
        );
        expect(whyRoutesCannotSail(polar)).toBe('it gives her real speed within 20° of the wind');
    });

    it('a single wind speed: too few rows or columns', () => {
        const polar = parsePolarFile(['TWA\t10', '45\t5.9', '90\t7.0', '150\t5.6'].join('\n'));
        expect(whyRoutesCannotSail(polar)).toBe('it has too few rows or columns');
    });

    it('a file that is not a polar at all says why, as a PolarFileError', () => {
        expect(() => readPolarFile('Hello\nthis is my shopping list')).toThrow(PolarFileError);
        expect(() => readPolarFile('')).toThrow(PolarFileError);
    });
});
