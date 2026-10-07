/**
 * A polar file with a 0 kn column keeps every figure under its own wind speed
 * (build 123, W1-03 review). The parser dropped the 0 kn header column but
 * still read each row from its second cell, so every row slid one column
 * left: the 0 kn figures landed under 6 kn and each speed was credited one
 * column late. Imported polars now reach the router raw, so a shifted table
 * would route. Fictional figures only.
 */
import { describe, expect, it } from 'vitest';
import { parsePolarFile } from '../utils/polarParser';

describe('parsePolarFile: a 0 kn column is dropped with its figures', () => {
    it('Expedition .pol (tabs)', () => {
        const polar = parsePolarFile(
            ['TWA\t0\t6\t8\t10', '45\t0\t4.2\t5.0\t5.6', '90\t0\t5.3\t6.3\t7.0', '150\t0\t3.8\t4.9\t5.8'].join('\n'),
            'Fair Wind.pol',
        );
        expect(polar.windSpeeds).toEqual([6, 8, 10]);
        expect(polar.angles).toEqual([45, 90, 150]);
        expect(polar.matrix).toEqual([
            [4.2, 5.0, 5.6],
            [5.3, 6.3, 7.0],
            [3.8, 4.9, 5.8],
        ]);
    });

    it('OpenCPN .csv (commas and semicolons)', () => {
        for (const sep of [',', ';']) {
            const polar = parsePolarFile(
                [`TWA\\TWS${sep}0${sep}6${sep}8`, `52${sep}0${sep}4.6${sep}5.4`, `120${sep}0${sep}5.0${sep}6.1`].join(
                    '\n',
                ),
                'Fair Wind.csv',
            );
            expect(polar.windSpeeds, sep).toEqual([6, 8]);
            expect(polar.matrix, sep).toEqual([
                [4.6, 5.4],
                [5.0, 6.1],
            ]);
        }
    });

    it('a file without a 0 kn column reads as before', () => {
        const polar = parsePolarFile(['TWA\t6\t8', '60\t4.9\t5.8', '180\t3.0\t4.0'].join('\n'), 'Fair Wind.pol');
        expect(polar.windSpeeds).toEqual([6, 8]);
        expect(polar.matrix).toEqual([
            [4.9, 5.8],
            [3.0, 4.0],
        ]);
    });
});
