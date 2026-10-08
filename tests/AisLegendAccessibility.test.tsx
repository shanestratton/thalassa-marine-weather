import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AisLegend } from '../components/map/AisLegend';
import { AIS_DANGER_COLOR, AIS_LEGEND_ITEMS, typeBucketColor } from '../components/map/aisPresentationPalette';

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
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

describe('AisLegend accessibility', () => {
    it('explains the actual vessel-type palette and distinct danger override', () => {
        render(<AisLegend visible />);
        for (const { label, color } of AIS_LEGEND_ITEMS) {
            const entry = screen.getByText(label).parentElement!;
            expect(entry.querySelector('[aria-hidden="true"]')).toHaveStyle({ background: color });
        }
        for (let shipType = 0; shipType <= 99; shipType++) {
            expect(AIS_LEGEND_ITEMS.some((entry) => entry.color === typeBucketColor(shipType))).toBe(true);
        }
        expect(screen.getByText('Cargo').parentElement?.firstElementChild).toHaveStyle({
            background: typeBucketColor(70),
        });
        expect(screen.getByText('NUC / restricted / draught / aground').parentElement?.firstElementChild).toHaveStyle({
            background: AIS_DANGER_COLOR,
        });
        expect(screen.queryByText('Underway')).not.toBeInTheDocument();
        expect(screen.queryByText('Class B')).not.toBeInTheDocument();
        expect(screen.getByText(/Boat: moving with known direction/)).toBeInTheDocument();
    });

    it('embeds one set of guard controls and the radius picker in normal document flow', async () => {
        render(<AisLegend visible embedded />);
        const key = screen.getByRole('group', { name: 'AIS vessel colours and guard controls' });
        expect(key).toHaveStyle({ position: 'static', flexWrap: 'wrap', maxWidth: '100%' });
        expect(screen.getAllByRole('button', { name: 'Enable AIS guard zone' })).toHaveLength(1);
        // Build 125 (125-01): the shield arms the collision watch too, so it
        // opens the real sound check first (tests/CollisionAlarmUi.test.tsx
        // arms through it); it no longer arms on the tap itself.
        fireEvent.click(screen.getByRole('button', { name: 'Enable AIS guard zone' }));
        const check = await screen.findByRole('dialog', { name: 'Sound check' });
        expect(mocks.setEnabled).not.toHaveBeenCalled();
        fireEvent.click(within(check).getByRole('button', { name: 'Cancel this action' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sound check' })).toBeNull());
        fireEvent.click(screen.getByRole('button', { name: 'Choose AIS guard zone radius' }));
        expect(screen.getByRole('group', { name: 'AIS guard zone radius' })).toHaveStyle({
            position: 'static',
            flexWrap: 'wrap',
        });
        fireEvent.click(screen.getByRole('button', { name: 'Set AIS guard zone radius to 10 nautical miles' }));
        expect(mocks.setRadius).toHaveBeenCalledWith(10);
        expect(screen.queryByRole('group', { name: 'AIS guard zone radius' })).not.toBeInTheDocument();
    });

    it('exposes independent guard and radius controls in a mobile-safe scroller', async () => {
        const { container } = render(<AisLegend visible />);

        const toggle = screen.getByRole('button', { name: 'Enable AIS guard zone' });
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(toggle);
        expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel this action' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sound check' })).toBeNull());

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
