/**
 * Isochrone Router — Polar performance interpolation.
 *
 * Factory function to create a highly-optimised closure for boat speed lookup.
 * It brackets the TWS (True Wind Speed) ONCE, avoiding 36x redundant array
 * scans per parent node, returning a function that only brackets the TWA.
 */

import type { PolarData } from '../../types';

/**
 * @returns A fast function taking `twa` and returning boat speed in knots.
 */
export function createPolarSpeedLookup(polar: PolarData, tws: number): (twa: number) => number {
    const twsArr = polar.windSpeeds;
    const twaArr = polar.angles;
    const matrix = polar.matrix;

    if (!twsArr?.length || !twaArr?.length || !matrix?.length) {
        return () => 0;
    }

    // Bracket TWS once
    const clampedTws = Math.min(twsArr[twsArr.length - 1], Math.max(twsArr[0], tws));
    let twsI = 0;
    for (let i = 0; i < twsArr.length - 1; i++) {
        if (twsArr[i + 1] >= clampedTws) {
            twsI = i;
            break;
        }
    }
    const twsI2 = Math.min(twsI + 1, twsArr.length - 1);

    const twsFrac = twsArr[twsI] === twsArr[twsI2] ? 0 : (clampedTws - twsArr[twsI]) / (twsArr[twsI2] - twsArr[twsI]);

    return function getSpeedForTwa(twa: number): number {
        const clampedTwa = Math.min(twaArr[twaArr.length - 1], Math.max(twaArr[0], Math.abs(twa)));

        let twaI = 0;
        for (let i = 0; i < twaArr.length - 1; i++) {
            if (twaArr[i + 1] >= clampedTwa) {
                twaI = i;
                break;
            }
        }
        const twaI2 = Math.min(twaI + 1, twaArr.length - 1);

        const twaFrac =
            twaArr[twaI] === twaArr[twaI2] ? 0 : (clampedTwa - twaArr[twaI]) / (twaArr[twaI2] - twaArr[twaI]);

        const s00 = matrix[twaI]?.[twsI] ?? 0;
        const s10 = matrix[twaI]?.[twsI2] ?? 0;
        const s01 = matrix[twaI2]?.[twsI] ?? 0;
        const s11 = matrix[twaI2]?.[twsI2] ?? 0;

        const s0 = s00 + (s10 - s00) * twsFrac;
        const s1 = s01 + (s11 - s01) * twsFrac;

        return s0 + (s1 - s0) * twaFrac;
    };
}
