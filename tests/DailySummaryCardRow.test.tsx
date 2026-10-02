/**
 * The day card's readings stay on ONE row (Shane's screenshot, 2026-10-02):
 * '12.5 kts' inline made the five readings wrap onto a second row, and the
 * card's fixed slot cut WAVE and RAIN in half.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
    DAY_CARD_DENSITY_ESTIMATE_PX,
    DailySummaryCard,
    chooseDayCardDensity,
} from '../components/dashboard/hero/DailySummaryCard';

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

// ── Short screens (2026-10-02): the card adapts to its slot's HEIGHT ──
//
// On a 375x667 phone the carousel slot is 109 px and the full card needs
// 188, so 105 px was cut off. The card measures itself and draws the largest
// layout that fits: full, compact (no condition line, one small High/Low
// line), or tight (the High/Low and swell lines go too: the hero header
// right above already shows the day's high and low). Readings and the tide
// times always stay: on a marine app the tide line is the one to keep.

describe('DailySummaryCard density', () => {
    it('chooses the largest density whose measured (or estimated) height fits', () => {
        expect(chooseDayCardDensity(0)).toBe('full'); // unmeasured: never shrink
        expect(chooseDayCardDensity(null)).toBe('full');
        expect(chooseDayCardDensity(197, { full: 188 })).toBe('full'); // 390x844
        expect(chooseDayCardDensity(156, { full: 188 })).toBe('compact');
        expect(chooseDayCardDensity(156, { full: 188, compact: 122 })).toBe('compact');
        expect(chooseDayCardDensity(109, { full: 188 })).toBe('tight'); // 375x667
        expect(chooseDayCardDensity(109, { full: 188, compact: 122, tight: 90 })).toBe('tight');
        // An unmeasured density is assumed to need its estimate.
        expect(chooseDayCardDensity(DAY_CARD_DENSITY_ESTIMATE_PX.full)).toBe('full');
        expect(chooseDayCardDensity(DAY_CARD_DENSITY_ESTIMATE_PX.full - 1)).toBe('compact');
        // A density measured too tall is never chosen again at that width.
        expect(chooseDayCardDensity(205, { full: 214 })).toBe('compact');
    });

    function renderInSlot(slot: number, natural: Record<string, number>) {
        const sizes = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
            this: HTMLElement,
        ) {
            return this.getAttribute('role') === 'group' ? slot : 0;
        });
        const widths = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
            this: HTMLElement,
        ) {
            return this.getAttribute('role') === 'group' ? 343 : 0;
        });
        const heights = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
            this: HTMLElement,
        ) {
            return this.dataset.testid === 'day-card-content' ? (natural[this.dataset.density ?? 'full'] ?? 0) : 0;
        });
        const view = render(
            <DailySummaryCard
                daily={{ ...(daily as object), tideSummary: 'High 08:12 · Low 14:30' } as never}
                units={units}
                dateLabel="Sat 3 Oct"
            />,
        );
        return {
            ...view,
            restore: () => {
                sizes.mockRestore();
                widths.mockRestore();
                heights.mockRestore();
            },
        };
    }

    it('on a 109 px slot (375x667) draws the tight layout and keeps every reading, spoken text intact', () => {
        const { restore } = renderInSlot(109, { full: 188, compact: 122, tight: 90 });
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'tight');
            const row = within(card).getByTestId('day-metrics-row');
            expect(within(row).getAllByTestId('day-metric')).toHaveLength(5);
            expect(within(row).getByText('12.5')).toBeInTheDocument();
            // Hidden from sight, never from VoiceOver.
            expect(within(card).getByText('Light Drizzle')).toHaveClass('sr-only');
            expect(within(card).getByText('8s swell')).toHaveClass('sr-only');
            expect(within(card).getByText('Sat 3 Oct')).toHaveClass('sr-only');
            // The tide times stay on screen; the High/Low pair (repeated by
            // the hero header above) is the one spoken only (2026-10-02).
            expect(within(card).getByText('High 08:12 · Low 14:30').parentElement).not.toHaveClass('sr-only');
            expect(within(card).getByTestId('day-high-low').closest('.sr-only')).not.toBeNull();
            expect(within(card).getByTestId('day-high-low')).toHaveTextContent(/High.*Low/);
        } finally {
            restore();
        }
    });

    it('on a 156 px slot draws the compact layout: no condition line, swell and tide kept', () => {
        const { restore } = renderInSlot(156, { full: 188, compact: 122, tight: 90 });
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'compact');
            expect(within(card).getByText('Light Drizzle')).toHaveClass('sr-only');
            expect(within(card).getByText('8s swell')).not.toHaveClass('sr-only');
            expect(within(card).getByText('High 08:12 · Low 14:30').parentElement).not.toHaveClass('sr-only');
        } finally {
            restore();
        }
    });

    it('on a 197 px slot (390x844) keeps the full card', () => {
        const { restore } = renderInSlot(197, { full: 188 });
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'full');
            expect(within(card).getByText('Light Drizzle')).not.toHaveClass('sr-only');
        } finally {
            restore();
        }
    });
});
