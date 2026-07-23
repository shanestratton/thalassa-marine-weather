import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThalassaHelixControl } from '../components/map/ThalassaHelixControl';

describe('ThalassaHelixControl', () => {
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
});
