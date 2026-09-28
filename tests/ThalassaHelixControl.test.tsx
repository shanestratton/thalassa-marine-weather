import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    LegendDock,
    MARINE_MOTION_HONESTY,
    ThalassaHelixControl,
    type HelixLayer,
} from '../components/map/ThalassaHelixControl';

describe('ThalassaHelixControl', () => {
    it('keeps standalone pressure fill positions and alpha aligned with the renderer', () => {
        render(<LegendDock inline layers={['pressure']} />);
        fireEvent.click(screen.getByRole('button', { name: 'Show weather legends' }));
        const legend = screen.getByRole('region', { name: 'Pressure legend' });
        expect(legend).toHaveTextContent('≤960 hPa');
        expect(legend).toHaveTextContent('≥1042 hPa');
        const source = readFileSync('services/weather/isobars.ts', 'utf8');
        const stops = source.slice(source.indexOf('const colorStops:'), source.indexOf('const colorStops:') + 2000);
        const scale = legend.querySelector<HTMLElement>('[data-weather-scale]')!;
        const gradient = scale.style.background.replace(/\s+/g, '');
        const matches = [...stops.matchAll(/\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]/g)];
        expect(matches).toHaveLength(12);
        for (const match of matches) {
            const [pressure, r, g, b, alpha] = match.slice(1).map(Number);
            expect(gradient).toContain(`rgba(${r},${g},${b},${alpha / 255})${((pressure - 960) / 82) * 100}%`);
        }
    });
    it('keeps its trailing hide control when the combined key expands and preserves independent units', () => {
        render(
            <LegendDock
                inline
                layers={[
                    'wind',
                    'rain',
                    'pressure',
                    'temperature',
                    'clouds',
                    'currents',
                    'waves',
                    'sst',
                    'chl',
                    'seaice',
                    'mld',
                ]}
                pressureOverlay
                trailing={<button type="button">Hide weather controls</button>}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Show weather legends' }));
        expect(screen.getByRole('button', { name: 'Hide weather controls' })).toBeVisible();
        expect(screen.getByText('Wind speed · kt')).toBeVisible();
        expect(screen.getByText('Current speed · m/s')).toBeVisible();
        expect(screen.getByText('Significant wave height · m')).toBeVisible();
        expect(screen.getByText('Sea-surface temperature · °C')).toBeVisible();
        expect(screen.getByText('Chlorophyll · mg/m³ (logarithmic)')).toBeVisible();
        expect(screen.getByText('Sea-ice concentration · %')).toBeVisible();
        expect(screen.getByText('Mixed-layer depth · m (logarithmic)')).toBeVisible();
        expect(screen.getByText(/not a rainfall total or a mm\/h conversion/)).toBeVisible();
        const pressure = screen.getByRole('region', { name: 'Pressure legend' });
        expect(pressure).toHaveTextContent('Mean sea-level pressure · hPa');
        expect(pressure).toHaveTextContent('no pressure colour fill');
        expect(pressure.querySelector('[data-weather-scale]')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Hide weather legends' }));
        expect(screen.getByRole('button', { name: 'Hide weather controls' })).toBeVisible();
        expect(screen.queryByRole('region', { name: 'Weather layer legends' })).not.toBeInTheDocument();
    });
    it('puts the full pressure valid-time caption below the slider without changing wind layout', () => {
        const props = {
            frameIndex: 1,
            totalFrames: 22,
            frameLabel: 'Near now',
            sublabel: 'GFS 00Z · Valid 09-20 08:00 UTC · Saved data; refresh unavailable',
            isPlaying: false,
            onScrub: vi.fn(),
            onPlayToggle: vi.fn(),
        };
        const { rerender } = render(<ThalassaHelixControl {...props} activeLayer="pressure" />);
        const caption = screen.getByTestId('pressure-time-provenance');
        expect(caption).toHaveTextContent(props.sublabel);
        expect(caption).toHaveClass('break-words');
        expect(caption).not.toHaveClass('shrink-0');
        rerender(<ThalassaHelixControl {...props} activeLayer="wind" sublabel="Forecast" />);
        expect(screen.queryByTestId('pressure-time-provenance')).not.toBeInTheDocument();
        expect(screen.getByText('Forecast')).toBeInTheDocument();
    });
    it('exposes the forecast timeline as a keyboard-operable slider', () => {
        const onScrub = vi.fn();
        const onScrubStart = vi.fn();
        const applyFrame = vi.fn();

        render(
            <ThalassaHelixControl
                activeLayer="wind"
                frameIndex={10}
                totalFrames={31}
                frameLabel="+2h"
                sublabel="Forecast"
                isPlaying={false}
                onScrub={onScrub}
                onScrubStart={onScrubStart}
                onPlayToggle={vi.fn()}
                applyFrame={applyFrame}
            />,
        );

        const timeline = screen.getByRole('slider', { name: 'Wind timeline' });
        expect(timeline).toHaveAttribute('aria-valuenow', '10');
        expect(timeline).toHaveAttribute('aria-valuetext', '+2h — Forecast');

        fireEvent.keyDown(timeline, { key: 'ArrowRight' });
        expect(onScrubStart).toHaveBeenCalledOnce();
        expect(applyFrame).toHaveBeenCalledWith(11);
        expect(onScrub).toHaveBeenCalledWith(11);

        fireEvent.keyDown(timeline, { key: 'PageUp' });
        expect(onScrub).toHaveBeenLastCalledWith(13);
        fireEvent.keyDown(timeline, { key: 'PageDown' });
        expect(onScrub).toHaveBeenLastCalledWith(7);

        fireEvent.keyDown(timeline, { key: 'End' });
        expect(onScrub).toHaveBeenLastCalledWith(30);
        fireEvent.keyDown(timeline, { key: 'Home' });
        expect(onScrub).toHaveBeenLastCalledWith(0);
    });

    it.each([
        ['currents', MARINE_MOTION_HONESTY.currents],
        ['waves', MARINE_MOTION_HONESTY.waves],
    ] as const)('shows honest measured-colour and illustrative-motion semantics for %s', (activeLayer, note) => {
        render(
            <ThalassaHelixControl
                activeLayer={activeLayer as HelixLayer}
                frameIndex={0}
                totalFrames={2}
                frameLabel="Now"
                isPlaying={false}
                onScrub={vi.fn()}
                onPlayToggle={vi.fn()}
            />,
        );

        expect(screen.getByText(note)).toBeVisible();
        expect(note).toMatch(/^Colour = .+ \(.+\) · particle motion = direction only \(speed illustrative\)$/);
        expect(note).not.toMatch(/propagation speed|particle speed =|motion = measured/i);
    });
});
