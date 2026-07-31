import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RainForecastCard } from '../components/dashboard/RainForecastCard';

/**
 * The no-rain state must state the window it actually checked.
 *
 * The rain source is tier-dependent: Skipper gets Rainbow.ai (4-hour nowcast),
 * everyone else — and any Rainbow failure, silently — gets WeatherKit (60
 * minutes). Rain arriving at T+3h is therefore VISIBLE to one device and
 * honestly invisible to another ("rain in 183 minutes" vs nothing — Shane's
 * iPhone/iPad, 2026-08-01). The card used to hard-code "Next 60 minutes" under
 * every no-rain headline, which turned that horizon difference into what looked
 * like a data bug.
 */

/** A dry hour of minutely data starting now. */
const dryHour = () => {
    const start = Date.now();
    return Array.from({ length: 60 }, (_, i) => ({
        time: new Date(start + i * 60_000).toISOString(),
        intensity: 0,
    }));
};

describe('RainForecastCard — the no-rain verdict names its window', () => {
    it('Rainbow.ai (4-hour nowcast) says so in the visible headline', () => {
        render(<RainForecastCard data={dryHour()} source="rainbow" />);
        expect(screen.getByText('No rain expected next 4 hours')).toBeInTheDocument();
    });

    it('WeatherKit (60-minute window) says so in the visible headline', () => {
        render(<RainForecastCard data={dryHour()} source="weatherkit" />);
        expect(screen.getByText('No rain expected next 60 min')).toBeInTheDocument();
    });

    it('a provider summary wins — it already names its own window', () => {
        render(
            <RainForecastCard data={dryHour()} source="rainbow" rainSummary="No precipitation expected next 4 hours" />,
        );
        expect(screen.getByText('No precipitation expected next 4 hours')).toBeInTheDocument();
    });
});
