import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TideStationCard, TideStationGauge } from '../components/map/TideStationCard';
import type { TideStationDetails } from '../services/tides/stationDetails';

const NOW = Date.parse('2026-09-20T00:00:00Z');
const HOUR = 3_600_000;
const station = {
    id: 'brisbane',
    name: 'Brisbane Bar',
    lat: -27.35,
    lon: 153.16,
    distance: 2,
    timezone: 'Australia/Brisbane',
};
const details = (overrides: Partial<TideStationDetails> = {}): TideStationDetails => ({
    station,
    predictionLocation: { lat: station.lat, lon: station.lon },
    predictionStationName: station.name,
    datum: 'MSL',
    requestedDatum: 'LAT',
    timezone: 'Australia/Brisbane',
    fetchedAtMs: NOW - 30_000,
    heights: Array.from({ length: 28 }, (_, i) => ({
        timeMs: NOW + (i - 1) * HOUR,
        heightM: 1 + Math.cos((i / 12) * Math.PI * 2),
    })),
    extremes: [
        { timeMs: NOW - HOUR, heightM: 2.1, type: 'High' },
        { timeMs: NOW + 5 * HOUR, heightM: -0.3, type: 'Low' },
        { timeMs: NOW + 11 * HOUR, heightM: 1.9, type: 'High' },
    ],
    source: 'WorldTides',
    copyright: 'WorldTides attribution',
    kind: 'prediction',
    wind: null,
    ...overrides,
});

describe('tide station card', () => {
    it('shows station-local prediction, gauge, upcoming events and a valid 24-hour curve', () => {
        render(<TideStationCard station={station} detail={details()} nowMs={NOW} onClose={vi.fn()} />);
        expect(screen.getByRole('region', { name: 'Brisbane Bar' })).toBeInTheDocument();
        expect(screen.getByText('Predicted now · 10:00')).toBeInTheDocument();
        expect(screen.getByText('Falling')).toBeInTheDocument();
        expect(screen.getByText(/Predicted, not measured/)).toBeInTheDocument();
        expect(screen.getByRole('img', { name: /24-hour predicted tide curve/ })).toBeInTheDocument();
        const events = screen.getByLabelText('Next high and low water');
        expect(within(events).getByText('-0.3', { exact: false })).toBeInTheDocument();
        expect(within(events).queryByText('2.1', { exact: false })).not.toBeInTheDocument();
        expect(screen.getByText(/Gauge fill shows position within this 24h range/)).toBeInTheDocument();
    });

    it('labels the actual response datum, not the requested LAT, and never offers clearance', () => {
        const props = { station, detail: details(), nowMs: NOW, onClose: vi.fn() };
        const { rerender } = render(<TideStationCard {...props} />);
        expect(screen.getByText('Mean sea level (MSL)')).toBeInTheDocument();
        expect(screen.queryByText('Lowest astronomical tide (LAT)')).not.toBeInTheDocument();
        expect(screen.getByText('Tide height is not water depth or clearance.')).toBeInTheDocument();
        rerender(<TideStationCard {...props} detail={details({ datum: null })} />);
        expect(screen.getByText('Vertical datum not supplied')).toBeInTheDocument();
        expect(screen.queryByText('Lowest astronomical tide (LAT)')).not.toBeInTheDocument();
    });

    it('does not invent a current height, arrow or curve from high/low events', () => {
        const { container } = render(
            <TideStationCard station={station} detail={details({ heights: [] })} nowMs={NOW} onClose={vi.fn()} />,
        );
        expect(screen.getByText('Current height unavailable')).toBeInTheDocument();
        expect(screen.getByText(/High\/low events do not provide a current reading/)).toBeInTheDocument();
        expect(screen.queryByRole('img', { name: /24-hour/ })).not.toBeInTheDocument();
        expect(container.querySelector('.tide-station-gauge__arrow')).toBeNull();
        expect(screen.getByText('Next high water')).toBeInTheDocument();
    });

    it('distinguishes loading, unavailable and saved offline states with working controls', () => {
        const close = vi.fn();
        const retry = vi.fn();
        const props = { station, detail: null, nowMs: NOW, onClose: close, onRetry: retry };
        const { rerender } = render(<TideStationCard {...props} loading />);
        expect(screen.getByRole('status')).toHaveTextContent('Loading tide predictions');
        expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'true');
        rerender(<TideStationCard {...props} error />);
        expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close tide station' }));
        expect(retry).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        rerender(<TideStationCard {...props} detail={details()} offline />);
        expect(screen.getByRole('status')).toHaveTextContent('Offline · showing saved predictions');
    });

    it('shows station forecast wind with FROM direction and valid time, not apparent/live wind', () => {
        const wind: NonNullable<TideStationDetails['wind']> = {
            speedKn: 14.2,
            directionDeg: 45,
            gustKn: 19,
            validTimeMs: NOW,
            fetchedAtMs: NOW,
            model: 'ECMWF IFS',
            source: 'ECMWF / Open-Meteo',
            kind: 'forecast',
        };
        const props = { station, detail: details({ wind }), nowMs: NOW, onClose: vi.fn() };
        const { rerender } = render(<TideStationCard {...props} />);
        expect(screen.getByText('Forecast wind · station position')).toBeInTheDocument();
        expect(screen.getByText('from NE · 45°')).toBeInTheDocument();
        expect(screen.getByText(/Valid.*10:00.*ECMWF IFS/)).toBeInTheDocument();
        expect(screen.getByText('Not measured or vessel apparent wind.')).toBeInTheDocument();
        rerender(<TideStationCard {...props} detail={details({ wind: { ...wind, validTimeMs: NOW - 3 * HOUR } })} />);
        expect(screen.queryByText('from NE · 45°')).not.toBeInTheDocument();
        expect(screen.getByText('Wind forecast does not cover this time.')).toBeInTheDocument();
    });

    it('keeps station/provider text as text and reveals a different returned prediction location', () => {
        const title = '<img src=x onerror=alert(1)> Harbour';
        const { container } = render(
            <TideStationCard
                station={{ ...station, name: title }}
                detail={details({
                    predictionStationName: '<script>other station</script>',
                    predictionLocation: { lat: -27.5, lon: 153.2 },
                    copyright: '<a href="javascript:alert(1)">copyright</a>',
                })}
                nowMs={NOW}
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByText(title)).toBeInTheDocument();
        expect(
            screen.getByText(/Prediction location: <script>other station<\/script> · -27.500, 153.200/),
        ).toBeInTheDocument();
        expect(container.querySelector('script, img, a')).toBeNull();
    });

    it('renders the same compact segmented gauge with a blue directional arrow for map markers', () => {
        const { container, rerender } = render(
            <TideStationGauge fraction={0.5} trend="falling" size={38} label="Falling predicted tide" />,
        );
        expect(screen.getByRole('img', { name: 'Falling predicted tide' })).toHaveAttribute('width', '38');
        expect(container.querySelectorAll('.tide-station-gauge__filled')).toHaveLength(3);
        expect(container.querySelector('.tide-station-gauge__arrow')).not.toHaveAttribute('transform');
        rerender(<TideStationGauge fraction={1} trend="rising" />);
        expect(container.querySelectorAll('.tide-station-gauge__filled')).toHaveLength(6);
        expect(container.querySelector('.tide-station-gauge__arrow')).toHaveAttribute('transform', 'rotate(180 54 36)');
    });
});
