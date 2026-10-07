/**
 * The voyage model card compares deterministic models; it is not an ensemble,
 * and a model that answered with nothing is not a row.
 *
 * ACCESS-G is the live example: BOM suspended its open data in June 2025, so
 * every value it returns is null. A saved plan from before the probe gate can
 * still carry it. The card leaves such a model out of the legend, the rows and
 * the count, and says in one line that it sent no data.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelComparisonCard } from '../components/passage/ModelComparisonCard';
import {
    getModelById,
    type ModelForecastPoint,
    type MultiModelResult,
    type WeatherModelId,
} from '../services/weather/MultiModelWeatherService';

const HOURS = 48;

function points(wind: number | null): ModelForecastPoint[] {
    return Array.from({ length: HOURS }, (_, h) => ({
        time: new Date(Date.UTC(2026, 9, 7, h)).toISOString(),
        windSpeed: wind,
        windDirection: wind === null ? null : 140,
        windGust: wind === null ? null : wind + 6,
        waveHeight: 1.2,
        pressure: wind === null ? null : 1014,
    }));
}

/** Fictional waypoints across the Tasman and on to Fiji. */
function result(ids: WeatherModelId[], dead: WeatherModelId[]): MultiModelResult {
    const models = ids.map((id) => getModelById(id)!);
    const waypoints = [
        { lat: -33.8, lon: 151.3, name: 'Departure' },
        { lat: -25.0, lon: 165.0, name: 'Mid-Tasman' },
        { lat: -17.7, lon: 177.4, name: 'Arrival' },
    ].map((wp) => ({
        ...wp,
        forecasts: models.map((model) => ({ model, points: points(dead.includes(model.id) ? null : 15) })),
        consensus: {
            windSpeedMean: 15,
            windSpeedSpread: 0,
            windDirectionMean: 140,
            windDirectionSpread: 0,
            waveHeightMean: 1.2,
            waveHeightSpread: 0,
            pressureMean: 1014,
            confidence: 'high' as const,
        },
    }));
    return { waypoints, models, forecastHours: HOURS, queryTime: '2026-10-07T00:00:00.000Z', elapsed_ms: 40 };
}

afterEach(cleanup);

describe('ModelComparisonCard', () => {
    it('is headed "Model comparison", never "Ensemble"', () => {
        const { container } = render(<ModelComparisonCard data={result(['gfs', 'ecmwf'], [])} />);
        expect(screen.getByText('Model comparison')).toBeInTheDocument();
        expect(container.textContent).not.toMatch(/ensemble/i);
        expect(screen.getByText('2 models')).toBeInTheDocument();
    });

    it('shows no row, pill or count for a model that sent no data, and says so once', () => {
        const { container } = render(<ModelComparisonCard data={result(['gfs', 'ecmwf', 'access_g'], ['access_g'])} />);
        expect(screen.getByText('2 models')).toBeInTheDocument();
        expect(screen.getByText('No data from ACCESS-G — left out.')).toBeInTheDocument();
        // Only the note names it: no legend pill, no heat-map row.
        expect(container.textContent!.match(/ACCESS-G/g)).toHaveLength(1);
        expect(container.textContent).toContain('2 of 3 models answered');
    });
});
