import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RainForecastCard } from '../components/dashboard/RainForecastCard';

/**
 * The no-rain state must state the window it actually checked.
 *
 * v1 of this rule derived the label from the SOURCE ("Rainbow → next 4
 * hours"), which fixed the iPhone/iPad horizon confusion (Shane, 2026-08-01)
 * but overstated in two ways the 2026-08-20 audit confirmed: a 60-minute feed
 * under a 'rainbow' tag still claimed 4 hours, and a 29-minute-old frame
 * claimed its full nominal window when it could only vouch for what remained.
 * The label is now computed from the LIVE span of the still-future frames —
 * whatever the source, however old the frame.
 */

/** A dry feed of `minutes` one-minute frames starting at `start`. */
const dryFeed = (minutes: number, start = Date.now()) =>
    Array.from({ length: minutes }, (_, i) => ({
        time: new Date(start + i * 60_000).toISOString(),
        intensity: 0,
    }));

describe('RainForecastCard — the no-rain verdict names the window it checked', () => {
    it('a fresh 60-minute feed vouches for ~59 minutes, no matter the source tag', () => {
        render(<RainForecastCard data={dryFeed(60)} source="rainbow" />);
        expect(screen.getByText(/No rain expected next (58|59|60) min/)).toBeInTheDocument();
    });

    it('a fresh 4-hour feed says hours', () => {
        render(<RainForecastCard data={dryFeed(240)} source="rainbow" />);
        expect(screen.getByText('No rain expected next 4 hours')).toBeInTheDocument();
    });

    it('an aged feed only vouches for what remains of it', () => {
        // Fetched 29 minutes ago: of the 60-minute window, ~31 min are still
        // ahead. The old card asserted the full "next 60 min" — rain arriving
        // at +40 min was invisible but confidently denied.
        render(<RainForecastCard data={dryFeed(60, Date.now() - 29 * 60_000)} source="weatherkit" />);
        expect(screen.getByText(/No rain expected next (30|31|32) min/)).toBeInTheDocument();
    });

    it('a provider summary cannot overstate the dry window either', () => {
        // Worded at fetch time, a summary's window ages just like the frame.
        // The live computed label always wins in the dry branch.
        render(
            <RainForecastCard
                data={dryFeed(60)}
                source="rainbow"
                rainSummary="No precipitation expected next 4 hours"
            />,
        );
        expect(screen.getByText(/No rain expected next (58|59|60) min/)).toBeInTheDocument();
        expect(screen.queryByText('No precipitation expected next 4 hours')).not.toBeInTheDocument();
    });

    it('the dry detail says so once and heads the dialog like its siblings', () => {
        render(<RainForecastCard data={dryFeed(240)} source="rainbow" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
        const dialog = screen.getByRole('dialog', { name: 'Rain forecast' });
        expect(screen.getByRole('heading', { level: 2, name: 'Rain forecast' })).toBeInTheDocument();
        // One no-rain line (the headline); the empty chart collapses to a
        // baseline rather than printing the verdict a second time.
        expect(within(dialog).getAllByText('No rain expected next 4 hours')).toHaveLength(1);
        expect(screen.queryByText('No rain in the next 4 hours')).not.toBeInTheDocument();
        // Whole-hour axis ticks in lower case, never '1H59'.
        for (const tick of ['Now', '1 h', '2 h', '3 h', '4 h']) {
            expect(within(dialog).getByText(tick)).toBeInTheDocument();
        }
        expect(within(dialog).queryByText(/\dH\d/)).toBeNull();
        // A dry window reads 'Dry', not '0.0 mm/hr peak' under 'Clear'.
        expect(within(dialog).getByText('Dry')).toBeInTheDocument();
        expect(within(dialog).queryByText('mm/hr peak')).toBeNull();
        expect(within(dialog).queryByText('0.0')).toBeNull();
        // No droplet "needle" parked at half scale on a 0.0 gauge.
        expect(dialog.querySelector('path[d^="M 60 28"]')).toBeNull();
    });

    it('the dry detail names one horizon: headline, chart summary and the axis agree (UX scorecard runs 7, 9)', () => {
        render(<RainForecastCard data={dryFeed(240, Date.now() - 25 * 60_000)} source="rainbow" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
        const dialog = screen.getByRole('dialog', { name: 'Rain forecast' });
        expect(within(dialog).getByText('No rain expected next 3\u00bd hours')).toBeInTheDocument();
        expect(
            within(dialog).getByRole('img', { name: 'Rain intensity, next 3\u00bd hours: none' }),
        ).toBeInTheDocument();
        // The credit names the feed only; the horizon is not said a third time.
        expect(within(dialog).getByText('Rainbow.ai nowcast · 1 km grid')).toBeInTheDocument();
        expect(within(dialog).queryByText(/4 hours ahead/)).toBeNull();
        // The axis ends at the stated horizon, not at a '4 h' it cannot vouch for.
        for (const tick of ['Now', '1 h', '2 h', '3\u00bd h']) {
            expect(within(dialog).getByText(tick)).toBeInTheDocument();
        }
        expect(within(dialog).queryByText('4 h')).toBeNull();
    });

    it('trace drizzle under the rain threshold draws no bars under a dry verdict', () => {
        const trace = dryFeed(240).map((f, i) => ({ ...f, intensity: i % 3 === 0 ? 0.1 : 0.06 }));
        render(<RainForecastCard data={trace} source="rainbow" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
        const chart = within(screen.getByRole('dialog', { name: 'Rain forecast' })).getByRole('img', {
            name: /: none$/,
        });
        expect(chart.querySelectorAll('div.flex-1')).toHaveLength(0);
    });

    it('a 240-minute wet feed draws at most 60 bars, clipped inside the dialog, scaled to a fixed floor', () => {
        const wet = dryFeed(240).map((f, i) => ({ ...f, intensity: i >= 30 && i < 60 ? 0.6 : 0 }));
        render(<RainForecastCard data={wet} source="rainbow" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
        const chart = within(screen.getByRole('dialog', { name: 'Rain forecast' })).getByRole('img', {
            name: /Rain intensity, next 4 hours: peak 0\.6 mm\/hr in \d+ min/,
        });
        const bars = chart.querySelectorAll<HTMLElement>('div.flex-1');
        expect(bars.length).toBeLessThanOrEqual(60);
        expect(bars[0].parentElement).toHaveClass('overflow-hidden');
        // 0.6 mm/hr against the 2.5 mm/hr floor is a quarter-height bar, not a wall.
        const tallest = Math.max(
            ...Array.from(bars, (b) => parseFloat((b.firstElementChild as HTMLElement).style.height)),
        );
        expect(tallest).toBeCloseTo(24, 0);
    });

    it('closes from a full-width bottom Close as well as the corner X', () => {
        render(<RainForecastCard data={dryFeed(240)} source="rainbow" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
        const dialog = screen.getByRole('dialog', { name: 'Rain forecast' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('dialog', { name: 'Rain forecast' })).not.toBeInTheDocument();
    });

    it('says "Right now" when the Glass is showing another day or hour', () => {
        const { rerender } = render(<RainForecastCard data={dryFeed(240)} source="rainbow" />);
        expect(screen.queryByText(/Right now/)).toBeNull();
        rerender(<RainForecastCard data={dryFeed(240)} source="rainbow" isLive={false} />);
        // Short, so it holds one line on a 375 pt phone (UX scorecard run 9).
        expect(screen.getByText('Right now: dry for the next 4 h')).toBeInTheDocument();
        // The strip's name is the action; the verdict, in whole words, is its description.
        expect(screen.getByRole('button', { name: 'Open rain forecast detail' })).toHaveAccessibleDescription(
            /Right now: dry for the next 4 hours/,
        );
    });

    it('paints a moon, not the sun, when the dry detail opens after sunset', () => {
        // Gladstone at 09:00 UTC is 19:00 local, after the ~17:50 sunset.
        const at = Date.UTC(2026, 8, 26, 9, 0);
        vi.useFakeTimers({ now: at, toFake: ['Date'] });
        try {
            render(
                <RainForecastCard
                    data={dryFeed(240, at)}
                    source="rainbow"
                    coordinates={{ lat: -23.85, lon: 151.26 }}
                />,
            );
            fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
            const dialog = screen.getByRole('dialog', { name: 'Rain forecast' });
            expect(dialog.querySelector('#rain-moon-disc')).not.toBeNull();
            expect(dialog.querySelector('#sun-disc')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('paints the sun when the dry detail opens by day', () => {
        // 02:00 UTC is 12:00 in Gladstone.
        const at = Date.UTC(2026, 8, 26, 2, 0);
        vi.useFakeTimers({ now: at, toFake: ['Date'] });
        try {
            render(
                <RainForecastCard
                    data={dryFeed(240, at)}
                    source="rainbow"
                    coordinates={{ lat: -23.85, lon: 151.26 }}
                />,
            );
            fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
            const dialog = screen.getByRole('dialog', { name: 'Rain forecast' });
            expect(dialog.querySelector('#sun-disc')).not.toBeNull();
            expect(dialog.querySelector('#rain-moon-disc')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a one-hour feed ticks in quarter hours and ends at 1 h', () => {
        render(<RainForecastCard data={dryFeed(60)} source="weatherkit" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
        const dialog = screen.getByRole('dialog', { name: 'Rain forecast' });
        for (const tick of ['Now', '15 min', '30 min', '45 min', '1 h']) {
            expect(within(dialog).getByText(tick)).toBeInTheDocument();
        }
    });

    it('light rain is one 44 pt line naming the nowcast; the chart waits for moderate rain (UX scorecard run 8)', () => {
        const drizzle = dryFeed(240).map((f, i) => ({ ...f, intensity: i >= 88 ? 0.4 : 0 }));
        render(<RainForecastCard data={drizzle} source="rainbow" />);
        const strip = screen.getByRole('button', { name: 'Open rain forecast detail' });
        expect(strip.className).toContain('min-h-[44px]');
        expect(strip.className).not.toContain('min-h-[76px]');
        expect(within(strip).queryByText(/Tap for detail/)).toBeNull();
        expect(
            within(strip)
                .getAllByText('Nowcast')
                .filter((el) => !el.classList.contains('sr-only')),
        ).toHaveLength(1);
        expect(strip).toHaveAccessibleDescription(/Rain in \d+ min.*Nowcast/);

        cleanup();
        const moderate = dryFeed(240).map((f, i) => ({ ...f, intensity: i >= 30 && i < 90 ? 3.2 : 0 }));
        render(<RainForecastCard data={moderate} source="rainbow" />);
        const full = screen.getByRole('button', { name: 'Open rain forecast detail' });
        expect(full.className).toContain('min-h-[76px]');
        expect(within(full).getByText('Nowcast · Tap for detail')).toBeInTheDocument();
        expect(within(full).getByText('Now')).toBeInTheDocument();
        expect(within(full).getByText('4 h')).toBeInTheDocument();
    });

    it('the detail stands its peak marker on the peak bar and says when the peak comes', () => {
        const drizzle = dryFeed(240).map((f, i) => ({ ...f, intensity: i >= 90 && i < 150 ? 0.3 : 0 }));
        drizzle[104] = { ...drizzle[104], intensity: 0.5 };
        render(<RainForecastCard data={drizzle} source="rainbow" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
        const dialog = screen.getByRole('dialog', { name: 'Rain forecast' });
        // Two 'Peak's: the chart's marker and the stat's label.
        const peaks = within(dialog).getAllByText('Peak');
        expect(peaks).toHaveLength(2);
        const marker = peaks.find((el) => el.style.bottom !== '');
        // 0.5 mm/hr on the 2.5 floor is a 20 % bar: the marker sits 4 px above it.
        expect(marker?.style.bottom).toBe('calc(20% + 4px)');
        // The stat reads 'Peak in 1 h 44 min', not 'Peak at in …'.
        const when = within(dialog).getByText(/^in 1 h 4[3-5] min$/);
        expect(when.previousElementSibling).toHaveTextContent(/^Peak$/);
        // The peak's size is said once, by the gauge.
        expect(within(dialog).getAllByText(/mm\/hr/)).toHaveLength(1);
    });

    it('a fully-elapsed feed is out of date, not a forecast', () => {
        render(<RainForecastCard data={dryFeed(60, Date.now() - 90 * 60_000)} source="weatherkit" />);
        // In sentence case, as every verdict on the strip is (UX scorecard run 9).
        expect(screen.getByText('Rain data out of date')).toBeInTheDocument();
    });
});
