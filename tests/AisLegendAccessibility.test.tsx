import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AisLegend } from '../components/map/AisLegend';

const mocks = vi.hoisted(() => ({
    setEnabled: vi.fn(),
    setRadius: vi.fn(),
}));

vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: {
        getState: () => ({ enabled: false, radiusNm: 2, alerts: [] }),
        subscribe: () => () => undefined,
        setEnabled: mocks.setEnabled,
        setRadius: mocks.setRadius,
    },
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

describe('AisLegend accessibility', () => {
    it('exposes independent guard and radius controls in a mobile-safe scroller', () => {
        const { container } = render(<AisLegend visible />);

        const toggle = screen.getByRole('button', { name: 'Enable AIS guard zone' });
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(toggle);
        expect(mocks.setEnabled).toHaveBeenCalledWith(true);

        const radiusChooser = screen.getByRole('button', { name: 'Choose AIS guard zone radius' });
        expect(radiusChooser).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(radiusChooser);
        expect(radiusChooser).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('group', { name: 'AIS guard zone radius' })).toBeInTheDocument();

        fireEvent.click(
            screen.getByRole('button', {
                name: 'Set AIS guard zone radius to 5 nautical miles',
            }),
        );
        expect(mocks.setRadius).toHaveBeenCalledWith(5);
        expect(screen.queryByRole('group', { name: 'AIS guard zone radius' })).not.toBeInTheDocument();

        const scroller = container.firstElementChild as HTMLElement;
        expect(scroller).toHaveStyle({ maxWidth: 'calc(100vw - 24px)', overflowX: 'auto' });
    });
});
