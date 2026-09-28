/**
 * The Glass hero — UX scorecard run 7 fixes.
 *
 *  - the tide band marks an event after midnight as the next day's
 *  - the warnings pill takes the trimmed rhythm's height (h-11 is floored in
 *    index.css after the utilities, so it used to beat in-data h-8)
 *  - the sun and moon chip is spoken in words
 *  - a missing temperature drops its unit, and a later day offers "Today"
 *  - grid cells are named in full words, and an empty day says why first
 *  - computeDisplayValues (the dead gust-inventing twin) stays gone
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import { TideGraph } from '../components/dashboard/tide/TideGraph';
import { CompactHeaderRow } from '../components/dashboard/CompactHeaderRow';
import { HeroHeader } from '../components/dashboard/HeroHeader';
import { HeroWidgets } from '../components/dashboard/HeroWidgets';
import * as helpers from '../components/dashboard/hero/heroSlideHelpers';
import type { UnitPreferences, WeatherMetrics } from '../types';

const units: UnitPreferences = {
    speed: 'kts',
    temp: 'C',
    length: 'm',
    waveHeight: 'm',
    tideHeight: 'm',
    distance: 'nm',
    visibility: 'nm',
};

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('tide band day cue', () => {
    const tz = 'Australia/Brisbane'; // UTC+10, no DST
    const tides = [
        { time: '2026-09-26T04:40:00Z', height: 0.6, type: 'Low' as const },
        { time: '2026-09-26T10:56:00Z', height: 4.1, type: 'High' as const }, // 20:56 local
        { time: '2026-09-26T17:13:00Z', height: 0.5, type: 'Low' as const }, // 03:13 local, the 27th
        { time: '2026-09-26T23:20:00Z', height: 4.0, type: 'High' as const },
        { time: '2026-09-28T12:00:00Z', height: 3.9, type: 'High' as const }, // 22:00 local Mon 28th
        { time: '2026-09-28T19:00:00Z', height: 0.7, type: 'Low' as const }, // 05:00 local Tue 29th
    ];

    it('marks tomorrow’s low on the live card, and leaves tonight’s high alone', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-26T08:56:00Z')); // 18:56 local
        render(<TideGraph tides={tides} unit="m" unitPref={units} timeZone={tz} stationPosition="bottom" />);
        const cues = screen.getAllByTestId('tide-day-cue');
        expect(cues).toHaveLength(1);
        expect(cues[0]).toHaveTextContent('tmrw');
        expect(cues[0]).toHaveTextContent('tomorrow');
        expect(screen.getByText('20:56')).toBeInTheDocument();
        expect(screen.getByText('03:13')).toBeInTheDocument();
    });

    it('names the weekday on a later day’s card', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-26T08:56:00Z'));
        render(
            <TideGraph
                tides={tides}
                unit="m"
                unitPref={units}
                timeZone={tz}
                stationPosition="bottom"
                customTime={Date.parse('2026-09-28T08:00:00Z')} // 18:00 local Mon 28th
            />,
        );
        const cues = screen.getAllByTestId('tide-day-cue');
        expect(cues).toHaveLength(1);
        expect(cues[0]).toHaveTextContent('Tue');
    });

    it('writes every height in the band the same way: value, thin space, unit', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-26T08:56:00Z'));
        const { container } = render(
            <TideGraph tides={tides} unit="m" unitPref={units} timeZone={tz} stationPosition="bottom" />,
        );
        const text = container.textContent ?? '';
        expect(text).toContain('4.1\u2009m');
        expect(text).toContain('0.5\u2009m');
        expect(text).toMatch(/\d\.\d\u2009m/);
        expect(text).not.toMatch(/\d\.\d m/);
    });

    it('after 23:00 the trend arrow follows the next extreme, in the card\u2019s sky tone', () => {
        // The curve ends at 24:00, so there is no next-hour height to compare:
        // a tide rising to tomorrow\u2019s high drew a falling arrow (review, batch 11).
        const lateTides = [
            { time: '2026-09-26T00:20:00Z', height: 0.6, type: 'Low' as const }, // 10:20 local
            { time: '2026-09-26T06:30:00Z', height: 4.0, type: 'High' as const }, // 16:30 local
            { time: '2026-09-26T12:40:00Z', height: 0.5, type: 'Low' as const }, // 22:40 local
            { time: '2026-09-26T18:50:00Z', height: 4.1, type: 'High' as const }, // 04:50 local, the 27th
        ];
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-26T13:40:00Z')); // 23:40 local
        const { container } = render(
            <TideGraph tides={lateTides} unit="m" unitPref={units} timeZone={tz} stationPosition="bottom" />,
        );
        const arrow = container.querySelector('svg.text-sky-300');
        expect(arrow).not.toBeNull();
        expect(arrow!.querySelector('path[d="m5 12 7-7 7 7"]')).not.toBeNull(); // up, not down
        expect(container.querySelector('svg.text-red-400, svg.text-emerald-400')).toBeNull();
    });
});

describe('warnings pill and sun chip', () => {
    it('lets the trimmed rhythm set the pill height instead of the floored h-11', () => {
        render(<CompactHeaderRow alerts={[]} sunrise="05:42" sunset="17:53" moonPhase="🌕" moonPhaseName="Full" />);
        const pill = screen.getByRole('button', { name: 'No forecast alerts' });
        expect(pill.className).not.toMatch(/(^|\s)h-11(\s|$)/);
        expect(pill.className).toContain('in-data-[glass-rhythm]:h-8');
        expect(pill.className).toContain('hit-target-44');
    });

    it('speaks sunrise, sunset and the moon in words', () => {
        render(<CompactHeaderRow alerts={[]} sunrise="05:42" sunset="17:53" moonPhase="🌕" moonPhaseName="Full" />);
        const chip = screen.getByRole('group', { name: 'Sun and moon' });
        expect(chip).toHaveTextContent(/Sunrise 05:42/);
        expect(chip).toHaveTextContent(/sunset 17:53/);
        expect(chip).toHaveTextContent(/full moon/);
        // A line glyph, not the colour emoji that read as a second sun (UX
        // scorecard run 10); the words are what is read.
        expect(screen.queryByText('🌕')).toBeNull();
        const moon = chip.querySelector('svg[data-moon-phase="full"]');
        expect(moon).not.toBeNull();
        expect(moon).toHaveAttribute('aria-hidden', 'true');
        // Each spoken part carries its own trailing comma, so no part starts
        // with one: a leading comma was read after a space (UX scorecard run 9).
        const spoken = Array.from(chip.querySelectorAll('.sr-only')).map((el) => el.textContent);
        expect(spoken).toEqual(['Sunrise 05:42,', 'sunset 17:53,', 'full moon']);
    });

    it('holds the sun times’ places with muted placeholders while they load (UX scorecard run 8)', () => {
        render(<CompactHeaderRow alerts={[]} moonPhase="🌕" moonPhaseName="Full" />);
        const chip = screen.getByRole('group', { name: 'Sun and moon' });
        expect(chip.textContent).toMatch(/^--:--Sunrise and sunset not yet known,--:--.*full moon$/);
        expect(chip.textContent).not.toMatch(/^,/);
    });

    it('keeps the live region on the warnings, not on the sunrise times', () => {
        render(<CompactHeaderRow alerts={[]} sunrise="05:42" sunset="17:53" moonPhase="🌕" />);
        const pill = screen.getByRole('button', { name: 'No forecast alerts' });
        expect(pill.parentElement).toHaveAttribute('aria-live', 'polite');
        expect(screen.getByRole('group', { name: 'Sun and moon' }).closest('[aria-live]')).toBeNull();
    });
});

const baseMetrics = {
    airTemperature: 21,
    highTemp: 23,
    lowTemp: 17,
    condition: 'Clouds',
    windSpeed: 8,
    windGust: 17,
    windDirection: 'ESE',
    waveHeight: null,
    swellPeriod: null,
    uvIndex: 0,
    visibility: 24, // km → 13 nm
    pressure: 1026,
    humidity: 66,
    precipitation: 1,
} as unknown as WeatherMetrics;

describe('hero header', () => {
    it('drops the ° and unit when there is no temperature', () => {
        const { container } = render(
            <DndContext>
                <HeroHeader
                    data={{ ...baseMetrics, airTemperature: null } as unknown as WeatherMetrics}
                    units={units}
                    isLive={false}
                    isDay
                    dateLabel="Tue 6 Oct"
                    timeLabel=""
                />
            </DndContext>,
        );
        const pin = screen.getByRole('button', { name: /^Temperature no reading/ });
        expect(pin).toHaveTextContent('--');
        expect(pin.textContent).not.toContain('°');
        expect(container.textContent).not.toContain('--°');
    });

    it('offers one tap back to today on a later day', () => {
        const onReturnToToday = vi.fn();
        render(
            <DndContext>
                <HeroHeader
                    data={baseMetrics}
                    units={units}
                    isLive={false}
                    isDay
                    dateLabel="Tue 6 Oct"
                    timeLabel=""
                    onReturnToToday={onReturnToToday}
                />
            </DndContext>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Today, back to now' }));
        expect(onReturnToToday).toHaveBeenCalledTimes(1);
    });

    it('has no Today control on today', () => {
        render(
            <DndContext>
                <HeroHeader data={baseMetrics} units={units} isLive isDay dateLabel="TODAY" timeLabel="" />
            </DndContext>,
        );
        expect(screen.queryByRole('button', { name: /^Today\b/ })).toBeNull();
    });

    it('never places the first-run coach mark over the digits or the grid', () => {
        const src = readFileSync('components/dashboard/HeroHeader.tsx', 'utf8');
        const coach = src.slice(src.indexOf('<CoachMark'), src.indexOf('/>', src.indexOf('<CoachMark')));
        // Inside the card beside the digits, pointing back at them — never
        // hung below the card over the WIND label (UX scorecard run 8).
        expect(coach).toContain('left-full');
        expect(coach).toContain('arrow="left"');
        expect(coach).not.toContain('top-full');
        expect(coach).not.toContain('bottom-0.5');
        // The condition steps aside while the coach stands in its place.
        expect(src).toContain('group/hero');
        expect(src).toContain('group-has-[[role=status]]/hero:invisible');
        // The card does not clip it, and Dashboard lifts the header layer over the grid.
        expect(src).not.toMatch(/rounded-2xl overflow-hidden border bg-white\/8/);
        expect(readFileSync('components/Dashboard.tsx', 'utf8')).toContain('left-0 right-0 z-115 px-4');
    });
});

describe('instrument grid names', () => {
    const renderGrid = (props: Partial<React.ComponentProps<typeof HeroWidgets>> = {}) =>
        render(
            <DndContext>
                <HeroWidgets data={baseMetrics} units={units} locationType="coastal" isLive {...props} />
            </DndContext>,
        );

    it('names every cell in full words', () => {
        renderGrid({ hourly: [{ time: new Date().toISOString(), precipitation: 1 }] as never });
        expect(screen.getByLabelText(/^Wind speed 8 knots/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^Direction of the wind from the east-southeast/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^Gusts 17 knots/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^Wave height, no reading/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^UV index 0/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^Visibility 13 nautical miles/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^Barometer 1026 hectopascals/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^Humidity 66 percent/)).toBeInTheDocument();
        // Value only in the name; what the metric is comes as the description
        // (UX scorecard run 8: swiping the grid read ten definitions).
        expect(screen.getByLabelText(/^Rain today 1 millimetre$/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Rain today 1 millimetre$/ })).toHaveAccessibleDescription(
            /^Total rain for today, from the hourly forecast/,
        );
        expect(screen.getByRole('button', { name: /^Humidity 66 percent$/ })).toHaveAccessibleDescription(
            /^Relative humidity/,
        );
        expect(screen.getByLabelText(/^Period of the waves, no reading/)).toBeInTheDocument();
        expect(screen.queryByLabelText(/^(WIND|DIR|VIS|HUM):/)).toBeNull();
    });

    it('starts every cell name with the word its visible label shortens', () => {
        const { container } = renderGrid({ hourly: [{ time: new Date().toISOString(), precipitation: 1 }] as never });
        const headings = Array.from(container.querySelectorAll('.glass-metric-heading'));
        expect(headings.length).toBeGreaterThanOrEqual(10);
        for (const heading of headings) {
            const label = (heading.textContent ?? '').trim().toLowerCase();
            const name = heading.closest('[aria-label]')?.getAttribute('aria-label') ?? '';
            expect(name.toLowerCase().startsWith(label), `${label} -> ${name}`).toBe(true);
        }
    });

    it('says why a day past the model’s range is empty, before its cells', () => {
        renderGrid({
            data: { windDirection: undefined } as unknown as WeatherMetrics,
            isLive: false,
            emptyDayNote: 'Beyond ICON’s range (ends Sat 3 Oct) — try another model',
        });
        expect(
            screen.getByRole('region', {
                name: 'Weather metrics dashboard. Beyond ICON’s range (ends Sat 3 Oct) — try another model',
            }),
        ).toBeInTheDocument();
    });

    it('shows every missing reading as one muted placeholder, spoken as no reading (UX scorecard run 8)', () => {
        const { container } = renderGrid({
            data: { ...baseMetrics, windDirection: '---', pressure: null } as unknown as WeatherMetrics,
        });
        const dir = screen.getByLabelText('Direction of the wind, no reading');
        expect(dir).toHaveTextContent(/^DIR--$/);
        expect(screen.getByLabelText(/^Barometer, no reading$/)).toBeInTheDocument();
        const dashes = Array.from(container.querySelectorAll('span')).filter((el) => el.textContent === '--');
        expect(dashes.length).toBeGreaterThanOrEqual(3);
        for (const dash of dashes) expect(dash.className).toContain('text-slate-500');
    });

    it('keeps the plain region name on an ordinary day', () => {
        renderGrid();
        expect(screen.getByRole('region', { name: 'Weather metrics dashboard' })).toBeInTheDocument();
    });
});

describe('dead helpers stay dead', () => {
    it('no longer exports the gust-inventing computeDisplayValues', () => {
        expect('computeDisplayValues' in helpers).toBe(false);
        expect(readFileSync('components/dashboard/hero/heroSlideHelpers.ts', 'utf8')).not.toMatch(
            /windSpeed \|\| 0\) \* 1\.3/,
        );
    });

    it('captions a day past the pinned model’s range from one helper', () => {
        expect(helpers.horizonCaption({ modelLabel: 'ICON', lastDayLabel: 'Sat 3 Oct' })).toBe(
            'Beyond ICON’s range (ends Sat 3 Oct) — try another model',
        );
        expect(helpers.horizonCaption(undefined)).toBe('Beyond the forecast horizon — check back tomorrow');
    });
});
