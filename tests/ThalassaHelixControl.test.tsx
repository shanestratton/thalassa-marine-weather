import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MARINE_MOTION_HONESTY, ThalassaHelixControl, type HelixLayer } from '../components/map/ThalassaHelixControl';

describe('ThalassaHelixControl', () => {
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
