/**
 * The two scrubbers are the app's signature controls — the synoptic chart's
 * forecast timeline and the passage timeline — and both open with a comment
 * explaining they deliberately avoid a native <input type="range"> for drag
 * smoothness. That decision is defensible; shipping without the semantics a
 * native range would have given for free was not. Before 2026-08-27 neither
 * carried a role, a value, a tabIndex or a key handler, so the primary
 * control on two screens was pointer-only and invisible to VoiceOver.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SynopticScrubber } from '../components/map/SynopticScrubber';
import TemporalScrubber from '../components/passage/TemporalScrubber';

describe('SynopticScrubber slider semantics', () => {
    const renderScrubber = (over: Partial<Parameters<typeof SynopticScrubber>[0]> = {}) => {
        const onHourChange = vi.fn();
        const applyFrame = vi.fn();
        render(
            <SynopticScrubber
                forecastHour={0}
                totalFrames={13}
                framesReady={13}
                isPlaying={false}
                onHourChange={onHourChange}
                onPlayToggle={vi.fn()}
                onScrubStart={vi.fn()}
                applyFrame={applyFrame}
                triggerHaptic={vi.fn()}
                {...over}
            />,
        );
        return { onHourChange, applyFrame, slider: screen.getByRole('slider', { name: 'Forecast time' }) };
    };

    it('exposes itself as a slider with a real value range', () => {
        const { slider } = renderScrubber();
        expect(slider).toHaveAttribute('aria-valuemin', '0');
        expect(slider).toHaveAttribute('aria-valuemax', '12');
        expect(slider).toHaveAttribute('aria-valuenow', '0');
        expect(slider).toHaveAttribute('tabindex', '0');
    });

    it('speaks the value in the same words the visible label uses', () => {
        expect(renderScrubber().slider).toHaveAttribute('aria-valuetext', 'Now');
        cleanup();
        expect(renderScrubber({ forecastHour: 6 }).slider).toHaveAttribute('aria-valuetext', 'plus 6 hours');
    });

    it('is operable from the keyboard, and commits like a drag does', () => {
        const { slider, onHourChange, applyFrame } = renderScrubber({ forecastHour: 5 });
        fireEvent.keyDown(slider, { key: 'ArrowRight' });
        expect(onHourChange).toHaveBeenCalledWith(6);
        expect(applyFrame).toHaveBeenCalledWith(6);

        fireEvent.keyDown(slider, { key: 'ArrowLeft' });
        expect(onHourChange).toHaveBeenCalledWith(4);
    });

    it('Home and End reach the ends without walking there', () => {
        const { slider, onHourChange } = renderScrubber({ forecastHour: 5 });
        fireEvent.keyDown(slider, { key: 'End' });
        expect(onHourChange).toHaveBeenCalledWith(12);
        fireEvent.keyDown(slider, { key: 'Home' });
        expect(onHourChange).toHaveBeenCalledWith(0);
    });

    it('clamps at the ends rather than running past the forecast', () => {
        const { slider, onHourChange } = renderScrubber({ forecastHour: 12 });
        fireEvent.keyDown(slider, { key: 'ArrowRight' });
        expect(onHourChange).toHaveBeenCalledWith(12);
    });

    it('ignores keys it does not own, so page shortcuts still work', () => {
        const { slider, onHourChange } = renderScrubber();
        fireEvent.keyDown(slider, { key: 'a' });
        expect(onHourChange).not.toHaveBeenCalled();
    });
});

describe('TemporalScrubber slider semantics', () => {
    const renderScrubber = (currentHour = 0, maxTimeHours = 48) => {
        const onChange = vi.fn();
        render(<TemporalScrubber maxTimeHours={maxTimeHours} currentHour={currentHour} onChange={onChange} />);
        return { onChange, slider: screen.getByRole('slider', { name: 'Passage time' }) };
    };

    it('exposes itself as a slider over the passage duration', () => {
        const { slider } = renderScrubber(0, 48);
        expect(slider).toHaveAttribute('aria-valuemin', '0');
        expect(slider).toHaveAttribute('aria-valuemax', '48');
        expect(slider).toHaveAttribute('aria-valuenow', '0');
        expect(slider).toHaveAttribute('aria-valuetext', 'Departure');
        expect(slider).toHaveAttribute('tabindex', '0');
    });

    it('is operable from the keyboard and clamps at departure', () => {
        const { slider, onChange } = renderScrubber(3);
        fireEvent.keyDown(slider, { key: 'ArrowRight' });
        expect(onChange).toHaveBeenCalledWith(4);

        cleanup();
        const second = renderScrubber(0);
        fireEvent.keyDown(second.slider, { key: 'ArrowLeft' });
        expect(second.onChange).toHaveBeenCalledWith(0);
    });
});
