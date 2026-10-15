/**
 * The polar chart's legend stays inside its box (build 132, package 132-B22).
 *
 * The svg took the box's full height and the legend sat under it, so on the
 * Polars page the legend spilled out of the chart's square over the save line
 * beneath. Now the chart is a column — the drawing takes what the box has
 * left after the legend. jsdom lays nothing out, so this pins the structure;
 * the phone check is the Polars page at 375 pt with Smart Polars on.
 *
 * And an Expedition polar's moving beat and run angles no longer pile their
 * labels up: a grid line and label at most every 10°.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PolarChart, gridAnglesFor } from '../components/settings/PolarChart';
import type { PolarData } from '../types';

const POLAR: PolarData = {
    windSpeeds: [6, 10, 16],
    angles: [45, 90, 150],
    matrix: [
        [4.4, 5.8, 6.2],
        [5.4, 6.9, 7.5],
        [3.6, 5.4, 6.9],
    ],
};

afterEach(cleanup);

describe('PolarChart (132-B22)', () => {
    it('lays out as a column: the drawing shrinks to leave the legend room, inside the box', () => {
        render(<PolarChart data={POLAR} overlayData={POLAR} />);
        const box = screen.getByTestId('polar-chart-box');
        const legend = screen.getByTestId('polar-chart-legend');
        const svg = screen.getByRole('img');
        expect(box.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'flex-col', 'h-full']));
        expect(legend.parentElement).toBe(box);
        expect(legend.className.split(' ')).toContain('shrink-0');
        // The drawing's own box takes the rest, and may shrink below the svg's natural height.
        const drawing = svg.parentElement!;
        expect(drawing.parentElement).toBe(box);
        expect(drawing.className.split(' ')).toEqual(expect.arrayContaining(['flex-1', 'min-h-0']));
        expect(legend.textContent).toContain('6kts');
        expect(legend.textContent).toContain('SMART');
    });

    it('labels its grid at most every 10°: the standard angles all, an Expedition polar’s thinned', () => {
        expect(gridAnglesFor([45, 60, 90, 120, 150, 180])).toEqual([45, 60, 90, 120, 150, 180]);
        expect(
            gridAnglesFor([38, 39, 40, 41, 43, 44, 52, 60, 75, 90, 110, 120, 135, 142, 146, 150, 152, 166, 175, 179]),
        ).toEqual([38, 52, 75, 90, 110, 120, 135, 146, 166, 179]);
    });
});
