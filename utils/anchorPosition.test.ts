/**
 * Move anchor's Position field (build 126, 126-07b): a position typed the way
 * a skipper copies it from the plotter, a guide or a text message, read back
 * before anything moves.
 *
 * parseAnchorPosition is parseCoordinateString (utils/coordParse.ts, its own
 * suite, untouched) plus the decimal comma half the world writes, and only
 * where it cannot be mistaken: the two halves apart by whitespace, ';' or a
 * comma beside a hemisphere letter, never by a bare comma between numbers. A
 * text with a decimal comma is never read with its commas as spaces (decimal
 * minutes as seconds). formatDmm is the readback, at 0.001′ (about 2 m).
 *
 * Fictional, worldwide fixtures: Horta (the Azores, N and W), Taveuni astride
 * 180°, Lyttelton (S and E), Longyearbyen (78°N) and Chichi-jima.
 */
import { describe, expect, it } from 'vitest';
import { formatDmm, parseAnchorPosition } from './anchorPosition';
import { parseCoordinateString } from './coordParse';

/** Degrees and decimal minutes, signed by hemisphere. */
const dm = (deg: number, min: number, hemi: 'N' | 'S' | 'E' | 'W') =>
    (hemi === 'S' || hemi === 'W' ? -1 : 1) * (deg + min / 60);

function expectPoint(text: string, lat: number, lon: number) {
    const parsed = parseAnchorPosition(text);
    expect(parsed, text).not.toBeNull();
    expect(parsed!.lat).toBeCloseTo(lat, 9);
    expect(parsed!.lon).toBeCloseTo(lon, 9);
}

describe('parseAnchorPosition: what it reads', () => {
    const HORTA = { lat: dm(38, 31.8, 'N'), lon: dm(28, 37.2, 'W') };

    it('signed decimal degrees', () => {
        expectPoint('38.53, -28.62', 38.53, -28.62);
        expectPoint('-43.608333 172.716667', -43.608333, 172.716667);
    });

    it('degrees and decimal minutes, with and without symbols (Horta)', () => {
        expectPoint('38°31.80′N 028°37.20′W', HORTA.lat, HORTA.lon);
        expectPoint("38°31.8'N 28°37.2'W", HORTA.lat, HORTA.lon);
        expectPoint('38 31.80 N 028 37.20 W', HORTA.lat, HORTA.lon);
    });

    it('degrees, minutes and seconds (Longyearbyen, 78°N)', () => {
        expectPoint(`78°13'48"N 15°36'00"E`, 78 + 13 / 60 + 48 / 3600, 15 + 36 / 60);
        expectPoint('78 13 48 N 015 36 00 E', 78 + 13 / 60 + 48 / 3600, 15 + 36 / 60);
    });

    it('hemisphere letters before or after, in lower case too (Lyttelton, Chichi-jima)', () => {
        expectPoint('S43 36.50 E172 43.00', dm(43, 36.5, 'S'), dm(172, 43, 'E'));
        expectPoint('43 36.50 s 172 43.00 e', dm(43, 36.5, 'S'), dm(172, 43, 'E'));
        expectPoint('n27 05.00 e142 12.00', dm(27, 5, 'N'), dm(142, 12, 'E'));
    });

    it('Taveuni astride 180°: east stays east and west stays west', () => {
        expectPoint('16 46.80 S 179 59.99 E', dm(16, 46.8, 'S'), dm(179, 59.99, 'E'));
        expectPoint('16 46.80 S 179 59.99 W', dm(16, 46.8, 'S'), dm(179, 59.99, 'W'));
    });

    it('a decimal comma, with the two numbers apart by whitespace or ";"', () => {
        expectPoint('-16,78 179,335', -16.78, 179.335);
        expectPoint('16,78 S 179,335 E', -16.78, 179.335);
        expectPoint('S 16,78; E 179,335', -16.78, 179.335);
        expectPoint('48,8566 2,3522', 48.8566, 2.3522);
        expectPoint('-16,78; 179,335', -16.78, 179.335);
    });

    it('decimal-comma minutes read as minutes, not as seconds (a European plotter)', () => {
        // Read as parseCoordinateString reads it, "46,8" would be 46′ 08″,
        // about 300 m from 46.8′.
        expectPoint('16 46,8 S 179 20,1 E', dm(16, 46.8, 'S'), dm(179, 20.1, 'E'));
        expectPoint('38°31,80′N 028°37,20′W', HORTA.lat, HORTA.lon);
    });

    it('a comma beside a hemisphere letter separates the halves, and decimal-comma minutes stay minutes', () => {
        // Read as parseCoordinateString reads it, "38 31,02 N, 028 37,03 W" is
        // 38°31′02″N 028°37′03″W: 38 m from what was typed, and plausible.
        expectPoint('38 31,02 N, 028 37,03 W', dm(38, 31.02, 'N'), dm(28, 37.03, 'W'));
        expectPoint('38 31,05 N , 028 37,05 W', dm(38, 31.05, 'N'), dm(28, 37.05, 'W'));
        expectPoint('N 38 31,05, W 028 37,05', dm(38, 31.05, 'N'), dm(28, 37.05, 'W'));
        expectPoint('47 18,03 N, 2 30,02 W', dm(47, 18.03, 'N'), dm(2, 30.02, 'W'));
        // Taveuni: 1.2 km off, read the other way.
        expectPoint('16 46,8 S, 179 20,1 E', dm(16, 46.8, 'S'), dm(179, 20.1, 'E'));
        expectPoint('16 46,8 S,179 20,1 E', dm(16, 46.8, 'S'), dm(179, 20.1, 'E'));
        expectPoint('S 16 46,8, E 179 20,1', dm(16, 46.8, 'S'), dm(179, 20.1, 'E'));
        expectPoint('s 16 46,8, e 179 20,1', dm(16, 46.8, 'S'), dm(179, 20.1, 'E'));
        expectPoint('16 46,05 S, 179 20,01 E', dm(16, 46.05, 'S'), dm(179, 20.01, 'E'));
        expectPoint('38°31,02′N, 028°37,03′W', dm(38, 31.02, 'N'), dm(28, 37.03, 'W'));
    });

    it('a comma between two numbers that already have decimal points separates them', () => {
        // A number cannot take a decimal comma and a decimal point both.
        expectPoint('-43.608333,172.716667', -43.608333, 172.716667);
        expectPoint('78.23,15.6', 78.23, 15.6);
        expectPoint('27.0833,142.2', 27.0833, 142.2);
    });

    it('never reads decimal-comma minutes as minutes and seconds, whatever separates the halves', () => {
        const pairs: Array<[[number, string, 'N' | 'S'], [number, string, 'E' | 'W']]> = [
            [
                [38, '31,02', 'N'],
                [28, '37,03', 'W'],
            ],
            [
                [16, '46,8', 'S'],
                [179, '20,1', 'E'],
            ],
            [
                [47, '18,03', 'N'],
                [2, '30,02', 'W'],
            ],
            [
                [16, '46,05', 'S'],
                [179, '59,99', 'W'],
            ],
            [
                [78, '13,800', 'N'],
                [15, '36,5', 'E'],
            ],
            [
                [43, '36,5', 'S'],
                [172, '43,01', 'E'],
            ],
        ];
        const separators = [' ', ', ', ',', ' , ', ' ,', '; ', ';'];
        let read = 0;
        for (const [[latDeg, latMin, ns], [lonDeg, lonMin, ew]] of pairs) {
            const lat = dm(latDeg, Number(latMin.replace(',', '.')), ns);
            const lon = dm(lonDeg, Number(lonMin.replace(',', '.')), ew);
            for (const sep of separators) {
                for (const symbols of [false, true]) {
                    const a = symbols ? `${latDeg}°${latMin}′` : `${latDeg} ${latMin}`;
                    const b = symbols ? `${lonDeg}°${lonMin}′` : `${lonDeg} ${lonMin}`;
                    for (const text of [`${a} ${ns}${sep}${b} ${ew}`, `${ns} ${a}${sep}${ew} ${b}`]) {
                        const parsed = parseAnchorPosition(text);
                        // Never a wrong point; and with the letters there, never in doubt.
                        expect(parsed, text).not.toBeNull();
                        expect(parsed!.lat, text).toBeCloseTo(lat, 9);
                        expect(parsed!.lon, text).toBeCloseTo(lon, 9);
                        read += 1;
                    }
                }
            }
        }
        expect(read).toBe(pairs.length * separators.length * 2 * 2);
    });
});

describe('parseAnchorPosition: what it will not guess', () => {
    it.each([
        ['four numbers run together with commas', '48,85,2,35'],
        ['decimal commas with a bare comma between them', '-16,78, 179,335'],
        ['decimal commas with a bare comma between them, no space', '-16,78,179,335'],
        ['two whole numbers run together with a comma (or one decimal-comma number)', '48,85'],
        ['decimal-comma minutes with no hemisphere letters, a comma between', '38 31,02, 028 37,03'],
        ['a decimal comma, and a comma between degrees and minutes', '38,31,02 N 028,37,03 W'],
        ['minutes of 60 or more', '16 75.5 S 179 20.1 E'],
        ['decimal-comma minutes of 60 or more', '16 75,5 S 179 20,1 E'],
        ['a latitude of 91', '91 00.0 N 028 37.2 W'],
        ['a decimal latitude of 91', '91,5 -28,62'],
        ['two latitudes', '38 31.8 N 28 37.2 S'],
        ['a berth name with two numbers', 'Berth 2, 153 Marina'],
        ['one number', '38.53'],
        ['nothing', ''],
        ['words', 'off the beach'],
    ])('refuses %s', (_label, text) => {
        expect(parseAnchorPosition(text)).toBeNull();
    });

    it('leaves parseCoordinateString as it was for its other callers', () => {
        // The decimal comma is the anchor field's alone.
        expect(parseCoordinateString('-16,78 179,335')).toBeNull();
        expect(parseCoordinateString('48,8566 2,3522')).toBeNull();
    });
});

describe('formatDmm: the readback', () => {
    it('Horta, north and west, minutes to 0.001′', () => {
        expect(formatDmm(dm(38, 31.8, 'N'), dm(28, 37.2, 'W'))).toBe('38°31.800′N 028°37.200′W');
    });

    it('Lyttelton and Longyearbyen', () => {
        expect(formatDmm(dm(43, 36.5, 'S'), dm(172, 43, 'E'))).toBe('43°36.500′S 172°43.000′E');
        expect(formatDmm(dm(78, 13.8, 'N'), dm(15, 36, 'E'))).toBe('78°13.800′N 015°36.000′E');
    });

    it('round-trips Taveuni on both sides of 180°: W stays W', () => {
        for (const hemi of ['E', 'W'] as const) {
            const lat = dm(16, 46.8, 'S');
            const lon = dm(179, 59.99, hemi);
            const text = formatDmm(lat, lon);
            expect(text).toBe(`16°46.800′S 179°59.990′${hemi}`);
            const back = parseAnchorPosition(text);
            expect(back!.lat).toBeCloseTo(lat, 9);
            expect(back!.lon).toBeCloseTo(lon, 9);
        }
    });

    it('round-trips any point to within 2 m (Chichi-jima, a dragged anchor)', () => {
        const lat = 27.0834567;
        const lon = 142.2001234;
        const back = parseAnchorPosition(formatDmm(lat, lon))!;
        // 0.0005′ of latitude is 0.93 m.
        expect(Math.abs(back.lat - lat) * 111_120).toBeLessThan(1);
        expect(Math.abs(back.lon - lon) * 111_120 * Math.cos((lat * Math.PI) / 180)).toBeLessThan(1);
    });
});
