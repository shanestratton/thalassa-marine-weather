/**
 * The day card's readings stay on ONE row (Shane's screenshot, 2026-10-02):
 * '12.5 kts' inline made the five readings wrap onto a second row, and the
 * card's fixed slot cut WAVE and RAIN in half.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DailySummaryCard } from '../components/dashboard/hero/DailySummaryCard';

const units = { speed: 'kts', length: 'm', temp: 'C' } as never;
const daily = {
    highTemp: 23,
    lowTemp: 21,
    condition: 'Light Drizzle',
    windSpeed: 12.5,
    windGust: 23.1,
    windDegree: 110,
    waveHeight: 2,
    swellPeriod: 8,
    precipChance: 40,
} as never;

describe('DailySummaryCard readings row (2026-10-02)', () => {
    it('lays all five readings out as one grid row of five equal columns, never wrapping', () => {
        render(<DailySummaryCard daily={daily} units={units} dateLabel="Sat 3 Oct" />);
        const row = screen.getByTestId('day-metrics-row');
        expect(row.className).not.toMatch(/flex-wrap/);
        expect(row.style.gridTemplateColumns).toBe('repeat(5, minmax(0, 1fr))');
        expect(within(row).getAllByTestId('day-metric')).toHaveLength(5);
    });

    it('puts each unit on its own line under the number', () => {
        render(<DailySummaryCard daily={daily} units={units} dateLabel="Sat 3 Oct" />);
        const row = screen.getByTestId('day-metrics-row');
        expect(within(row).getByText('12.5')).toBeInTheDocument();
        expect(within(row).getByText('23.1')).toBeInTheDocument();
        expect(within(row).getAllByText('kts')).toHaveLength(2);
        expect(within(row).getByText('40')).toBeInTheDocument();
        expect(within(row).getByText('%')).toBeInTheDocument();
        expect(within(row).getByText('8s swell')).toBeInTheDocument();
    });

    it('shows no unit under a missing reading and counts only the columns it draws', () => {
        render(
            <DailySummaryCard
                daily={{ ...(daily as object), windGust: null, precipChance: null } as never}
                units={units}
                isLandlocked
            />,
        );
        const row = screen.getByTestId('day-metrics-row');
        expect(row.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
        expect(within(row).getAllByText('kts')).toHaveLength(1);
        expect(within(row).queryByText('%')).toBeNull();
    });
});
