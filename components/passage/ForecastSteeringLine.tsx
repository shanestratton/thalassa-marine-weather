import React from 'react';
import { forecastSteeringText, type ForecastSteering } from '../../services/routing/forecastSteering';

export const ForecastSteeringLine: React.FC<{ value: ForecastSteering | null }> = ({ value }) => (
    <p
        className="px-2 py-1 text-xs text-amber-200 leading-relaxed"
        data-testid="forecast-steering"
        title={
            value
                ? `${value.model} ${value.components}; run ${new Date(value.runMs).toISOString()}; at ${new Date(value.sampledAtMs).toISOString()}; generation ${value.generation}. Planned through-water speed; coarse model, no leeway or narrow-channel stream correction.`
                : 'No verified current coverage at this place and forecast time.'
        }
    >
        {forecastSteeringText(value)}
        {value && (
            <span className="block text-gray-400">
                {value.model}{' '}
                {value.components === 'ocean'
                    ? 'ocean only; local tidal streams unavailable'
                    : 'ocean + model tide; narrow streams unresolved'}
            </span>
        )}
    </p>
);
