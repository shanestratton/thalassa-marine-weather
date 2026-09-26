import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
        expect(within(dialog).getByText('mm/hr peak')).toBeInTheDocument();
        // No droplet "needle" parked at half scale on a 0.0 gauge.
        expect(dialog.querySelector('path[d^="M 60 28"]')).toBeNull();
    });

    it('a one-hour feed ticks in quarter hours and ends at 1 h', () => {
        render(<RainForecastCard data={dryFeed(60)} source="weatherkit" />);
        fireEvent.click(screen.getByRole('button', { name: 'Open rain forecast detail' }));
        const dialog = screen.getByRole('dialog', { name: 'Rain forecast' });
        for (const tick of ['Now', '15 min', '30 min', '45 min', '1 h']) {
            expect(within(dialog).getByText(tick)).toBeInTheDocument();
        }
    });

    it('a fully-elapsed feed is out of date, not a forecast', () => {
        render(<RainForecastCard data={dryFeed(60, Date.now() - 90 * 60_000)} source="weatherkit" />);
        expect(screen.getByText('Rain Data Out Of Date')).toBeInTheDocument();
    });
});
