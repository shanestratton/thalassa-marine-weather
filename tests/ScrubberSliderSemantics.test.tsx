/**
 * The passage timeline is one of the app's signature controls, and it opens
 * with a comment explaining it deliberately avoids a native
 * <input type="range"> for drag smoothness. That decision is defensible;
 * shipping without the semantics a native range would have given for free was
 * not. Before 2026-08-27 it carried no role, no value, no tabIndex and no key
 * handler, so the primary control on the passage screen was pointer-only and
 * invisible to VoiceOver.
 *
 * The synoptic chart's scrubber was covered here too until 2026-09-03, when
 * that component was deleted — nothing had mounted it since the chart timeline
 * moved on.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TemporalScrubber from '../components/passage/TemporalScrubber';

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
