/**
 * CastOffPanel — smoke tests (595 LOC component)
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../../services/authIdentityScope';

const castOffMocks = vi.hoisted(() => ({
    getDraftVoyages: vi.fn(),
    getActiveVoyage: vi.fn(),
    castOff: vi.fn(),
    startTracking: vi.fn(),
}));

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { vesselName: 'Test Vessel', vesselType: 'sailboat' },
        updateSettings: vi.fn(),
    }),
}));
vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ children }: { children: React.ReactNode }) => <div data-testid="slide-to-action">{children}</div>,
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../services/VoyageService', () => ({
    getDraftVoyages: castOffMocks.getDraftVoyages,
    getActiveVoyage: castOffMocks.getActiveVoyage,
    castOff: castOffMocks.castOff,
    endVoyage: vi.fn(),
    createVoyage: vi.fn(),
}));
vi.mock('../../services/ShipLogService', () => ({
    ShipLogService: {
        startTracking: castOffMocks.startTracking,
    },
}));

import { CastOffPanel } from '../../components/vessel/CastOffPanel';

describe('CastOffPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope('account-a');
        castOffMocks.getDraftVoyages.mockResolvedValue([]);
        castOffMocks.getActiveVoyage.mockResolvedValue(null);
        castOffMocks.startTracking.mockResolvedValue(undefined);
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    const renderSettled = async () => {
        const result = render(<CastOffPanel onClose={vi.fn()} />);
        await screen.findByText('No draft voyages yet');
        return result;
    };

    it('renders without crashing', async () => {
        const { container } = await renderSettled();
        expect(container).toBeDefined();
    });

    it('renders content', async () => {
        await renderSettled();
        expect(screen.getByRole('dialog', { name: 'Select Voyage' })).toBeInTheDocument();
    });

    it('does not start account-B tracking when account A changes during cast off', async () => {
        const voyage = {
            id: 'voyage-a',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'planning',
        };
        let resolveCastOff!: (result: { ok: boolean; voyage: typeof voyage }) => void;
        castOffMocks.getDraftVoyages.mockResolvedValue([voyage]);
        castOffMocks.castOff.mockReturnValue(
            new Promise((resolve) => {
                resolveCastOff = resolve;
            }),
        );
        render(<CastOffPanel initialVoyageId={voyage.id} onClose={vi.fn()} />);

        await screen.findByText('Confirm Safety');
        const safetyToggle = screen.getByText('Confirm Safety').parentElement?.previousElementSibling;
        expect(safetyToggle).toBeInstanceOf(HTMLElement);
        fireEvent.click(safetyToggle as HTMLElement);
        fireEvent.click(screen.getByRole('button', { name: /cast off/i }));

        act(() => {
            setAuthIdentityScope('account-b');
            resolveCastOff({ ok: true, voyage });
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(castOffMocks.startTracking).not.toHaveBeenCalled();
    });
});
