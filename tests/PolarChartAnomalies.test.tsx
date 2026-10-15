/**
 * The polar chart's red rings mark a figure out of line with its neighbours —
 * a likely typo — and only that (build 132, package 132-B22 review).
 *
 * The parser writes 0 inside an Expedition line's beat angle: no figure, not
 * a slow one. The chart averaged that 0 into the neighbours, so every wind
 * speed's beat-angle figure of a good Expedition import was ringed in red, in
 * the import preview and on the Polars page. A 0 neighbour is now left out;
 * a real typo is still ringed, at the beat angle too.
 *
 * The real fixtures (tests/fixtures/polars, made up for a fictional boat)
 * are drawn by the real chart; no mocks.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PolarChart } from '../components/settings/PolarChart';
import { readPolarFile } from '../utils/polarParser';
import type { PolarData } from '../types';

const fixture = (name: string) => readPolarFile(readFileSync(join(__dirname, 'fixtures/polars', name), 'utf8')).polar;

/** The red rings drawn: each anomaly is a ring and a dot. */
const redRings = (container: HTMLElement) => container.querySelectorAll('circle[stroke="#ef4444"]').length;
const redDots = (container: HTMLElement) => container.querySelectorAll('circle[fill="#ef4444"]').length;

afterEach(cleanup);

describe('PolarChart anomaly rings (132-B22 review)', () => {
    it('a good Expedition import has no red rings: the 0s inside her beat angles are no figure', () => {
        const polar = fixture('fair-wind-expedition.txt');
        // The fixture does carry those 0s: 6 kn has none closer than 44°.
        expect(polar.matrix[polar.angles.indexOf(43)][polar.windSpeeds.indexOf(6)]).toBe(0);
        const { container } = render(<PolarChart data={polar} />);
        expect(container.querySelectorAll('path').length).toBeGreaterThan(0);
        expect(redRings(container)).toBe(0);
        expect(redDots(container)).toBe(0);
    });

    it('nor does a good table with a 0° row, nor the same polar as the Smart overlay', () => {
        const table = fixture('fair-wind-table.pol');
        const { container } = render(<PolarChart data={table} overlayData={fixture('fair-wind-expedition.txt')} />);
        expect(redRings(container)).toBe(0);
        expect(redDots(container)).toBe(0);
    });

    it('a real typo is still ringed, beside a 0 at her beat angle as well as mid-table', () => {
        const polar: PolarData = {
            windSpeeds: [6, 10],
            angles: [40, 45, 52, 60, 75, 90, 110, 120, 150],
            matrix: [
                [0, 0],
                [4.5, 14.9], // 10 kn at 45°: 14.9 for 5.9, beside a 0
                [5.0, 6.5],
                [5.2, 6.8],
                [5.5, 7.0],
                [5.6, 17.0], // 10 kn at 90°: 17.0 for 7.0
                [5.5, 7.0],
                [5.2, 6.9],
                [3.7, 5.6],
            ],
        };
        const { container } = render(<PolarChart data={polar} />);
        expect(redRings(container)).toBe(2);
        expect(redDots(container)).toBe(2);
    });
});
