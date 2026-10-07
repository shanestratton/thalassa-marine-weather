/**
 * The day card's readings stay on ONE row (Shane's screenshot, 2026-10-02):
 * '12.5 kts' inline made the five readings wrap onto a second row, and the
 * card's fixed slot cut WAVE and RAIN in half.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
    DAY_CARD_DENSITY_ESTIMATE_PX,
    DailySummaryCard,
    chooseDayCardDensity,
} from '../components/dashboard/hero/DailySummaryCard';
import { MOON_STAYS_UP, SUN_STAYS_DOWN } from '../utils/celestial';

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
        // The wave period: seconds on screen, in words for VoiceOver.
        expect(within(row).getByText('8s')).toHaveAttribute('aria-hidden', 'true');
        expect(within(row).getByText('waves 8 seconds apart')).toHaveClass('sr-only');
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

    function renderInSlot(
        slot: number,
        natural: Record<string, number>,
        extra: Partial<React.ComponentProps<typeof DailySummaryCard>> = {},
    ) {
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
            if (this.dataset.testid !== 'day-card-content') return 0;
            // '<density>+line' when the chip's own line (or its held place) is drawn.
            const density = this.dataset.density ?? 'full';
            const line = !!this.querySelector('[data-placement="line"], [data-testid="day-agreement-pending"]');
            return (line ? natural[`${density}+line`] : undefined) ?? natural[density] ?? 0;
        });
        const view = render(
            <DailySummaryCard
                daily={{ ...(daily as object), tideSummary: 'High 08:12 · Low 14:30' } as never}
                units={units}
                dateLabel="Sat 3 Oct"
                {...extra}
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
            expect(within(card).getByText('8s')).toHaveClass('sr-only');
            expect(within(card).getByText('waves 8 seconds apart')).toBeInTheDocument();
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

    it('on a 156 px slot draws the compact layout: no condition line, wave period and tide kept', () => {
        const { restore } = renderInSlot(156, { full: 188, compact: 122, tight: 90 });
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'compact');
            expect(within(card).getByText('Light Drizzle')).toHaveClass('sr-only');
            expect(within(card).getByText('8s')).not.toHaveClass('sr-only');
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
    // ── Build 123, W1-09: the agreement chip and the sun & moon row ──

    it('on the tightest slot shows the agreement glyph alone, its words still spoken', () => {
        const { restore } = renderInSlot(
            109,
            { full: 188, compact: 122, tight: 90 },
            { agreement: { level: 'split', members: 7, peak: 7, thin: false }, onCompare: vi.fn() },
        );
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'tight');
            const chip = within(card).getByRole('button', { name: 'Wind: models split, 7 models' });
            expect(chip.querySelector('svg[data-agreement="split"]')).not.toBeNull();
            // Nothing is drawn but the glyph: the words are the button's name.
            expect(chip.textContent).toBe('');
            // Pinned in the card's corner, so it costs the tight card no height.
            expect(chip).toHaveAttribute('data-placement', 'corner');
        } finally {
            restore();
        }
    });

    // Review 2026-10-08: at 375x812 (162 px) the chip's own line cost the
    // card its full density (154 px without it, 178 with), every forecast day.
    it('on a 162 px slot (375x812) keeps the full card and moves the chip to the corner, not the card down a step', () => {
        const { restore } = renderInSlot(
            162,
            { 'full+line': 178, full: 154, snug: 154, 'compact+line': 146, compact: 122, tight: 90 },
            { agreement: { level: 'some', members: 7, peak: 7, thin: false }, onCompare: vi.fn() },
        );
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'snug');
            // The full card: its condition line drawn, High/Low at full size.
            expect(within(card).getByText('Light Drizzle')).not.toHaveClass('sr-only');
            expect(within(card).getByText('8s')).not.toHaveClass('sr-only');
            const chip = within(card).getByRole('button', { name: 'Wind: some spread, 7 models' });
            expect(chip).toHaveAttribute('data-placement', 'corner');
            expect(chip.querySelector('svg[data-agreement="some"]')).not.toBeNull();
        } finally {
            restore();
        }
    });

    it('holds no line for a pending chip on that slot, and is full again when the chip comes to nothing', () => {
        const natural = { 'full+line': 178, full: 154, snug: 154, 'compact+line': 146, compact: 122, tight: 90 };
        const { restore, rerender } = renderInSlot(162, natural, { agreement: 'pending' });
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'snug');
            expect(screen.queryByTestId('day-agreement-pending')).toBeNull();
            rerender(
                <DailySummaryCard
                    daily={{ ...(daily as object), tideSummary: 'High 08:12 · Low 14:30' } as never}
                    units={units}
                    dateLabel="Sat 3 Oct"
                    agreement={null}
                />,
            );
            // Measured without the line it held, the full card fits: not stuck a step down.
            expect(card).toHaveAttribute('data-density', 'full');
            expect(within(card).getByText('Light Drizzle')).not.toHaveClass('sr-only');
        } finally {
            restore();
        }
    });

    it('still draws the chip on its own line where the full card has room for it (393x852)', () => {
        const { restore } = renderInSlot(
            193,
            { 'full+line': 178, full: 154 },
            { agreement: { level: 'agree', members: 7, peak: 7, thin: false }, onCompare: vi.fn() },
        );
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'full');
            expect(within(card).getByRole('button', { name: /^Wind: models agree/ })).toHaveAttribute(
                'data-placement',
                'line',
            );
        } finally {
            restore();
        }
    });

    it('draws first light, the sun, last light and the moon on a roomy slot', () => {
        const { restore } = renderInSlot(300, { roomy: 236, full: 188 }, { sky: SKY });
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'roomy');
            const sky = within(card).getByTestId('day-sky');
            expect(sky).not.toHaveClass('sr-only');
            for (const words of ['First light', '05:19', 'Sunrise', '05:42', 'Sunset', '18:05', 'Last light', '18:27'])
                expect(sky).toHaveTextContent(words);
            expect(sky).toHaveTextContent('Moonrise 03:13');
            expect(sky).toHaveTextContent('Moonset 14:57');
            expect(sky).toHaveTextContent('12% lit');
        } finally {
            restore();
        }
    });

    it('speaks the sun and moon on every slot without room for them, 390x844 included', () => {
        const { restore } = renderInSlot(197, { roomy: 236, full: 188 }, { sky: SKY });
        try {
            const card = screen.getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            expect(card).toHaveAttribute('data-density', 'full');
            const sky = within(card).getByTestId('day-sky');
            expect(sky).toHaveClass('sr-only');
            expect(sky).toHaveTextContent(
                'First light 05:19, sunrise 05:42, sunset 18:05, last light 18:27. Moonrise 03:13, moonset 14:57, moon 12% lit.',
            );
        } finally {
            restore();
        }
    });
});

const SKY = {
    firstLight: '05:19',
    sunrise: '05:42',
    sunset: '18:05',
    lastLight: '18:27',
    moonrise: '03:13',
    moonset: '14:57',
    illumination: 0.12,
    phaseName: 'Waning Crescent',
};

describe('the sun & moon row says polar days in words, once', () => {
    it('Tromsø midwinter: civil light comes, the sun does not, the moon stays up', () => {
        render(
            <DailySummaryCard
                daily={daily}
                units={units}
                sky={{
                    ...SKY,
                    firstLight: '09:31',
                    sunrise: SUN_STAYS_DOWN,
                    sunset: SUN_STAYS_DOWN,
                    lastLight: '13:53',
                    moonrise: MOON_STAYS_UP,
                    moonset: MOON_STAYS_UP,
                    illumination: 0.9,
                }}
            />,
        );
        expect(screen.getByTestId('day-sky')).toHaveTextContent(
            'First light 09:31, sun stays down, last light 13:53. Moon stays up, moon 90% lit.',
        );
    });

    it('Svalbard midwinter: no light and no sun are said once; a moonrise on another day is "no moonrise"', () => {
        render(
            <DailySummaryCard
                daily={daily}
                units={units}
                sky={{
                    ...SKY,
                    firstLight: SUN_STAYS_DOWN,
                    sunrise: SUN_STAYS_DOWN,
                    sunset: SUN_STAYS_DOWN,
                    lastLight: SUN_STAYS_DOWN,
                    moonrise: null,
                    moonset: '11:20',
                    illumination: 0.4,
                }}
            />,
        );
        expect(screen.getByTestId('day-sky')).toHaveTextContent(
            'Sun stays down. No moonrise, moonset 11:20, moon 40% lit.',
        );
    });
});

describe('the roomy step is offered only to a card with a sun & moon row', () => {
    it('chooses roomy only when it is offered and its measured height fits', () => {
        expect(chooseDayCardDensity(300, { full: 188 })).toBe('full');
        expect(chooseDayCardDensity(300, { full: 188 }, true)).toBe('roomy');
        expect(chooseDayCardDensity(300, { roomy: 320, full: 188 }, true)).toBe('full');
        // 390x844 and 393x852: the row would push the full card to compact,
        // so it waits for a roomier phone.
        expect(chooseDayCardDensity(197, { full: 188 }, true)).toBe('full');
        expect(chooseDayCardDensity(193, { full: 188 }, true)).toBe('full');
        expect(chooseDayCardDensity(0, {}, true)).toBe('full'); // unmeasured: as before
    });
});

describe('the snug step is offered only to a card holding a chip line (W1-09 review)', () => {
    it('moves the chip to the corner before it drops the condition line', () => {
        expect(chooseDayCardDensity(162, { full: 178 })).toBe('compact'); // no chip: as before
        expect(chooseDayCardDensity(162, { full: 178 }, false, true)).toBe('snug'); // 375x812
        // Unmeasured, snug is the full card less the chip's line; measured too tall, never again.
        expect(chooseDayCardDensity(150, { full: 178 }, false, true)).toBe('compact');
        expect(chooseDayCardDensity(162, { full: 178, snug: 170 }, false, true)).toBe('compact');
        // Where the line fits, the words stay on screen.
        expect(chooseDayCardDensity(193, { full: 178 }, true, true)).toBe('full');
    });
});

describe('DailySummaryCard model agreement chip (build 123, W1-09)', () => {
    const agree = { level: 'agree' as const, members: 7, peak: 7, thin: false };

    it('says the models agree in words, with a glyph and the member count, and opens the comparison', () => {
        const onCompare = vi.fn();
        render(
            <DailySummaryCard
                daily={daily}
                units={units}
                dateLabel="Sat 3 Oct"
                agreement={agree}
                onCompare={onCompare}
            />,
        );
        const chip = screen.getByRole('button', { name: 'Wind: models agree, 7 models' });
        expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
        expect(chip).toHaveTextContent('Models agree');
        expect(chip).toHaveTextContent('7 models');
        expect(chip.querySelector('svg[data-agreement="agree"]')).toHaveAttribute('aria-hidden', 'true');
        expect(chip).toHaveAttribute('data-placement', 'line');
        fireEvent.click(chip);
        expect(onCompare).toHaveBeenCalledTimes(1);
    });

    it('has a glyph of its own for each verdict, never colour alone', () => {
        const glyphs = new Set<string>();
        for (const [level, words] of [
            ['agree', 'Models agree'],
            ['some', 'Some spread'],
            ['split', 'Models split'],
        ] as const) {
            const { unmount } = render(
                <DailySummaryCard daily={daily} units={units} agreement={{ ...agree, level }} onCompare={vi.fn()} />,
            );
            const chip = screen.getByRole('button', { name: `Wind: ${words.toLowerCase()}, 7 models` });
            const path = chip.querySelector(`svg[data-agreement="${level}"] path`)!.getAttribute('d')!;
            glyphs.add(path);
            unmount();
        }
        expect(glyphs.size).toBe(3);
    });

    it('says how few models reach a late day instead of overclaiming agreement', () => {
        render(
            <DailySummaryCard
                daily={daily}
                units={units}
                agreement={{ level: 'agree', members: 4, peak: 7, thin: true }}
                onCompare={vi.fn()}
            />,
        );
        const chip = screen.getByRole('button', { name: 'Wind: models agree, only 4 of 7 models' });
        expect(chip).toHaveTextContent('4 of 7 models');
    });

    // Review 2026-10-08: a day after UKMO and ICON end has 5 of the 7; that
    // it is fewer must show even before it is thin.
    it('says which models are missing once runs have ended, before the day is thin', () => {
        render(
            <DailySummaryCard
                daily={daily}
                units={units}
                agreement={{ level: 'agree', members: 5, peak: 7, thin: false }}
                onCompare={vi.fn()}
            />,
        );
        const chip = screen.getByRole('button', { name: 'Wind: models agree, 5 of 7 models' });
        expect(chip).toHaveTextContent('5 of 7 models');
    });

    it('never calls a one-model day agreement', () => {
        render(
            <DailySummaryCard
                daily={daily}
                units={units}
                agreement={{ level: null, members: 1, peak: 7, thin: false }}
                onCompare={vi.fn()}
            />,
        );
        const chip = screen.getByRole('button', { name: 'Wind: only 1 model reaches this day, nothing to compare' });
        expect(chip).toHaveTextContent('1 model only');
        expect(screen.queryByText(/agree/i)).toBeNull();
        expect(chip.querySelector('svg[data-agreement]')).toBeNull();
    });

    it('draws no chip offline (null), and only holds its line while the spread loads', () => {
        const { unmount } = render(<DailySummaryCard daily={daily} units={units} agreement={null} />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.queryByTestId('day-agreement-pending')).toBeNull();
        unmount();
        render(<DailySummaryCard daily={daily} units={units} agreement="pending" />);
        const placeholder = screen.getByTestId('day-agreement-pending');
        expect(placeholder).toHaveAttribute('aria-hidden', 'true');
        expect(placeholder).toHaveClass('invisible');
        expect(placeholder.textContent).toBe('');
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('sits on its own line under the wind readings, not inside the readings row', () => {
        render(<DailySummaryCard daily={daily} units={units} agreement={agree} onCompare={vi.fn()} />);
        const row = screen.getByTestId('day-metrics-row');
        const chip = screen.getByRole('button', { name: /^Wind: models agree/ });
        expect(row.contains(chip)).toBe(false);
        expect(row.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
