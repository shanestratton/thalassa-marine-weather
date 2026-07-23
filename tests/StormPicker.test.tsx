import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StormPicker } from '../components/map/StormPicker';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

const triggerHaptic = vi.hoisted(() => vi.fn());

vi.mock('../utils/system', () => ({ triggerHaptic }));

const cyclone: ActiveCyclone = {
    sid: 'AL012026',
    name: 'Cyclone Iris',
    basin: 'SP',
    category: 2,
    categoryLabel: '2',
    currentPosition: { lat: -18.2, lon: 151.4, time: '2026-07-23T00:00:00Z', windKts: 85, pressureMb: 970 },
    track: [],
    forecastTrack: [],
    maxWindKts: 85,
    minPressureMb: 970,
    nature: 'TY',
};

function props(overrides: Partial<React.ComponentProps<typeof StormPicker>> = {}) {
    return {
        visible: true,
        cyclones: [cyclone],
        userLat: -27.47,
        userLon: 153.02,
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onClearStorms: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => triggerHaptic.mockClear());

describe('StormPicker', () => {
    it('is absent until opened and exposes a labelled modal', () => {
        const { rerender } = render(<StormPicker {...props({ visible: false })} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        rerender(<StormPicker {...props()} />);
        expect(screen.getByRole('dialog', { name: 'Active Cyclones' })).toHaveAttribute('aria-modal', 'true');
    });

    it('selects a storm and closes using Escape', () => {
        const input = props();
        render(<StormPicker {...input} />);

        fireEvent.click(screen.getByRole('button', { name: 'Focus on Iris' }));
        expect(input.onSelect).toHaveBeenCalledWith(cyclone);
        expect(input.onClose).toHaveBeenCalledOnce();
        expect(triggerHaptic).toHaveBeenCalledWith('medium');

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(input.onClose).toHaveBeenCalledTimes(2);
    });

    it('keeps keyboard focus inside the picker and restores it after closing', () => {
        const input = props({ visible: false });
        const { rerender } = render(
            <>
                <button>Open storms</button>
                <StormPicker {...input} />
            </>,
        );
        const trigger = screen.getByRole('button', { name: 'Open storms' });
        trigger.focus();

        rerender(
            <>
                <button>Open storms</button>
                <StormPicker {...input} visible />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close storm picker' });
        const hide = screen.getByRole('button', { name: 'Hide All Storms' });
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(hide).toHaveFocus();
        fireEvent.keyDown(hide, { key: 'Tab' });
        expect(close).toHaveFocus();

        rerender(
            <>
                <button>Open storms</button>
                <StormPicker {...input} />
            </>,
        );
        expect(trigger).toHaveFocus();
    });
});
