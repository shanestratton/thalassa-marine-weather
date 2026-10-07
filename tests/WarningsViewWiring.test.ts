/**
 * The Forecast alerts page gets the boat's position, location type and model
 * tag from App.tsx through the view registry (build 123, W1-02).
 *
 * Every WarningDetails test passes those props by hand, so without this file
 * a lost hunk in either place (App.tsx is shared with another agent's
 * branches) would quietly send every boat to the WMO fallback and drop the
 * model from the cards, with the whole suite still green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { VIEW_REGISTRY, type ViewContext } from '../viewRegistry';

const ctx: ViewContext = {
    setPage: vi.fn(),
    previousView: 'dashboard',
    setIsUpgradeOpen: vi.fn(),
    settings: {},
    updateSettings: vi.fn(),
    handleFavoriteSelect: vi.fn(),
    weatherAlerts: ['Forecast: gale-force wind, 34 kt+'],
    weatherGeneratedAt: '2026-10-07T06:00:00.000Z',
    weatherLocationName: 'Marseille',
    weatherCoordinates: { lat: 43.3, lon: 5.37 },
    weatherLocationType: 'coastal',
    weatherModelUsed: 'wx:ecmwf_ifs025',
};

describe('the Forecast alerts page wiring', () => {
    it('hands the position, location type and model tag to WarningDetails', () => {
        expect(VIEW_REGISTRY.warnings.getProps?.(ctx)).toEqual({
            alerts: ['Forecast: gale-force wind, 34 kt+'],
            checkedAt: '2026-10-07T06:00:00.000Z',
            placeName: 'Marseille',
            coordinates: { lat: 43.3, lon: 5.37 },
            locationType: 'coastal',
            modelUsed: 'wx:ecmwf_ifs025',
        });
    });

    it('fills them from the weather report in App.tsx', () => {
        // Parsed textually: rendering App is far too heavy for a unit test.
        const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
        const viewCtx = app.slice(app.indexOf('const viewCtx: ViewContext = {'));
        const body = viewCtx.slice(0, viewCtx.indexOf('};'));
        expect(body).toMatch(/\bweatherCoordinates: weatherData\?\.coordinates,/);
        expect(body).toMatch(/\bweatherLocationType: weatherData\?\.locationType,/);
        expect(body).toMatch(/\bweatherModelUsed: weatherData\?\.modelUsed,/);
    });
});
