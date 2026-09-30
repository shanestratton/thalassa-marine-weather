/**
 * Shane 2026-09-30, "can we fix the overruns here": on the Glass the rain
 * cell read "TRACE mm" and ran into HUM (its unit clipped to "m"), and the
 * radar map's labelled base picture printed "QUEENSLAND" under the wind badge
 * ("…ND") and a clipped "Coral Sea" on the right edge.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CurrentConditionsCard, fifthCellValueSize } from '../components/dashboard/CurrentConditionsCard';
import { buildBasemapUrl } from '../components/dashboard/hero/radarGlassEngine';
import type { UnitPreferences, WeatherMetrics } from '../types';

const units: UnitPreferences = {
    speed: 'kts',
    length: 'm',
    waveHeight: 'm',
    temp: 'C',
    distance: 'nm',
    visibility: 'nm',
};
const weather = {
    windSpeed: 14,
    windDirection: 'ESE',
    windDegree: 110,
    uvIndex: 7,
    visibility: 4,
    humidity: 76,
    precipitation: 0.1,
} as WeatherMetrics;

afterEach(cleanup);

describe('the compact conditions row', () => {
    it('says a trace of rain as a word, with no millimetre unit', () => {
        render(<CurrentConditionsCard data={weather} units={units} />);
        expect(screen.getByText('Trace')).toBeInTheDocument();
        expect(screen.queryByText('TRACE')).toBeNull();
        expect(screen.queryByText('mm')).toBeNull();
    });

    it('keeps millimetres on a real amount', () => {
        render(<CurrentConditionsCard data={{ ...weather, precipitation: 3 }} units={units} />);
        expect(screen.getByText('3')).toBeInTheDocument();
        expect(screen.getByText('mm')).toBeInTheDocument();
    });

    it('steps long readings down a size so they stay in a fifth of the row', () => {
        expect(fifthCellValueSize('76%')).toBe('text-2xl');
        expect(fifthCellValueSize('100%')).toBe('text-xl');
        expect(fifthCellValueSize('Trace')).toBe('text-lg');
        expect(fifthCellValueSize('<0.01"')).toBe('text-lg');
        render(<CurrentConditionsCard data={weather} units={units} />);
        expect(screen.getByText('Trace')).toHaveClass('text-lg', 'whitespace-nowrap');
    });
});

describe('the radar map base picture', () => {
    const url = buildBasemapUrl({ lon: 148.72, lat: -20.27, z: 5.5, wCss: 422, hCss: 264 } as never, 'pk.test');

    it('is plain satellite imagery with town names only', () => {
        expect(url).toContain('/styles/v1/mapbox/satellite-v9/static/');
        expect(url).not.toContain('satellite-streets');
        const layer = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('addlayer') ?? '{}')) as {
            'source-layer': string;
            filter: unknown;
        };
        expect(layer['source-layer']).toBe('place_label');
        expect(JSON.stringify(layer.filter)).toContain('"settlement"');
    });

    it('keeps the view, size and the no-logo, no-attribution picture as before', () => {
        expect(url).toContain('/148.7200,-20.2700,4.50,0/422x264@2x?');
        expect(url).toContain('attribution=false');
        expect(url).toContain('logo=false');
    });
});
