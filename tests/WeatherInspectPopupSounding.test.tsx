/**
 * The entry to the Sounding sheet (build 125, SND): an explicit action on the
 * Obs tap-a-point bubble. Nothing is fetched until it is tapped (never on a
 * map move), and the sheet is a lazy chunk opened through its own host, so
 * the map and the bubble carry only the button.
 *
 * The bubble is a Mapbox popup that cannot scroll, so the entry is a pill on
 * the coordinates line, not a row of its own (review 2026-10-09: a 44 px row
 * pushed the Save row under an iPhone SE's tab bar). Measured at 320 wide in
 * wide fonts with swell, a buoy line and Save: 354 px without it, 361 with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WeatherInspectPopup } from '../components/map/WeatherInspectPopup';
import type { PointWeatherData } from '../services/weather/pointWeather';

const point = (): PointWeatherData => ({
    lat: 43.21,
    lon: 5.35,
    fetchedAt: Date.now(),
    marineStatus: 'available',
    windSpeedKmh: 40,
    windDirectionDeg: 320,
    windGustsKmh: 60,
    pressureMsl: 1014,
    temperatureC: 19,
    humidity: 55,
    cloudCover: 10,
    waveHeightM: 1.6,
    wavePeriodS: 6,
    waveDirectionDeg: 320,
    swellHeightM: null,
    swellPeriodS: null,
    swellDirectionDeg: null,
});

describe('the Sounding action on the inspect bubble', () => {
    it('opens the sounding when tapped', () => {
        const open = vi.fn();
        render(<WeatherInspectPopup data={point()} loading={false} onClose={vi.fn()} onOpenSounding={open} />);
        fireEvent.click(screen.getByRole('button', { name: /sounding/i }));
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('sits on the coordinates line once the point forecast is in, not on a row of its own', () => {
        render(<WeatherInspectPopup data={point()} loading={false} onClose={vi.fn()} onOpenSounding={vi.fn()} />);
        const pill = screen.getByRole('button', { name: /sounding/i });
        expect(pill.parentElement?.textContent).toContain('43.21°N 5.35°E');
        expect(pill.className).not.toMatch(/\bw-full\b/);
    });

    it('is there while the point forecast is still loading, and when it failed', () => {
        const open = vi.fn();
        const { rerender } = render(
            <WeatherInspectPopup data={null} loading onClose={vi.fn()} onOpenSounding={open} />,
        );
        expect(screen.getByRole('button', { name: /sounding/i })).toBeTruthy();
        rerender(
            <WeatherInspectPopup data={null} loading={false} error="offline" onClose={vi.fn()} onOpenSounding={open} />,
        );
        expect(screen.getByRole('button', { name: /sounding/i })).toBeTruthy();
    });

    it('is absent where nothing can open it', () => {
        render(<WeatherInspectPopup data={point()} loading={false} onClose={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /sounding/i })).toBeNull();
    });
});

describe('useWeatherInspectPopup wiring', () => {
    const hook = fs.readFileSync(path.join(process.cwd(), 'components/map/useWeatherInspectPopup.tsx'), 'utf8');

    it('opens the sheet through a lazy import, only from the button', () => {
        expect(hook).toMatch(/onOpenSounding=\{/);
        expect(hook).toMatch(/import\('\.\.\/sounding\/soundingSheetHost'\)/);
        // Never a static import: the sheet, its chart and its maths stay out of the map chunk.
        expect(hook).not.toMatch(/^import .*soundingSheetHost/m);
        expect(hook).not.toMatch(/^import .*sounding\/Sounding/m);
    });

    it('hands the skipper’s units and the night palette to the sheet', () => {
        expect(hook).toMatch(/openSoundingSheet\(/);
        expect(hook).toMatch(/displayMode/);
    });
});
