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
    endVoyage: vi.fn(),
    initializeTracking: vi.fn(),
    getTrackingStatus: vi.fn(),
    startTracking: vi.fn(),
}));

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// Spread the real module — settingsStore calls getSystemUnits() at module
// scope, so a triggerHaptic-only mock breaks the import graph on load.
vi.mock('../../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
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
    endVoyage: castOffMocks.endVoyage,
    createVoyage: vi.fn(),
}));
vi.mock('../../services/ShipLogService', () => ({
    ShipLogService: {
        initialize: castOffMocks.initializeTracking,
        getTrackingStatus: castOffMocks.getTrackingStatus,
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
        castOffMocks.endVoyage.mockResolvedValue(true);
        castOffMocks.initializeTracking.mockResolvedValue(undefined);
        castOffMocks.getTrackingStatus.mockReturnValue({
            isTracking: true,
            currentVoyageId: 'voyage-active',
        });
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
        expect(screen.getByRole('button', { name: 'Back' })).toHaveClass('h-11', 'w-11');
        expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveClass('h-11', 'w-11');
    });

    it('exposes the safety confirmation as a keyboard-operable checked control', async () => {
        const voyage = {
            id: 'voyage-accessible-safety',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'planning',
        };
        castOffMocks.getDraftVoyages.mockResolvedValue([voyage]);
        render(<CastOffPanel initialVoyageId={voyage.id} onClose={vi.fn()} />);

        const confirmation = await screen.findByRole('checkbox', { name: /confirm safety/i });
        expect(confirmation).toHaveAttribute('aria-checked', 'false');
        confirmation.focus();
        fireEvent.keyDown(confirmation, { key: 'Enter' });
        fireEvent.click(confirmation);
        expect(confirmation).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('button', { name: /cast off/i })).toBeEnabled();
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

    it('never presents a remotely activated passage as live while GPS verification is pending', async () => {
        const voyage = {
            id: 'voyage-slow-gps',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'planning',
        };
        let resolveTracking!: () => void;
        const onCastOff = vi.fn();
        castOffMocks.getDraftVoyages.mockResolvedValue([voyage]);
        castOffMocks.castOff.mockResolvedValue({ ok: true, voyage: { ...voyage, status: 'active' } });
        castOffMocks.startTracking.mockReturnValue(
            new Promise<void>((resolve) => {
                resolveTracking = resolve;
            }),
        );
        castOffMocks.getTrackingStatus.mockReturnValue({
            isTracking: true,
            currentVoyageId: voyage.id,
        });

        render(<CastOffPanel initialVoyageId={voyage.id} onCastOff={onCastOff} onClose={vi.fn()} />);
        await screen.findByText('Confirm Safety');
        const safetyToggle = screen.getByText('Confirm Safety').parentElement?.previousElementSibling;
        fireEvent.click(safetyToggle as HTMLElement);
        fireEvent.click(screen.getByRole('button', { name: /cast off/i }));

        expect(await screen.findByText('Passage Active · GPS Log Off')).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('has not yet been verified');
        expect(screen.getByRole('button', { name: /starting gps logging/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: /end voyage & archive/i })).toBeDisabled();
        expect(onCastOff).not.toHaveBeenCalled();

        await act(async () => resolveTracking());
        expect(await screen.findByText('Live')).toBeInTheDocument();
        expect(onCastOff).toHaveBeenCalledTimes(1);
    });

    it('revokes an unmounted Cast Off panel so its late GPS completion cannot close a reopened panel', async () => {
        const voyage = {
            id: 'voyage-remounted',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'planning',
        };
        let resolveTracking!: () => void;
        const staleOnCastOff = vi.fn();
        castOffMocks.getDraftVoyages.mockResolvedValue([voyage]);
        castOffMocks.castOff.mockResolvedValue({ ok: true, voyage: { ...voyage, status: 'active' } });
        castOffMocks.startTracking.mockReturnValue(
            new Promise<void>((resolve) => {
                resolveTracking = resolve;
            }),
        );
        castOffMocks.getTrackingStatus.mockReturnValue({ isTracking: false, currentVoyageId: voyage.id });

        const firstMount = render(
            <CastOffPanel initialVoyageId={voyage.id} onCastOff={staleOnCastOff} onClose={vi.fn()} />,
        );
        await screen.findByText('Confirm Safety');
        const safetyToggle = screen.getByText('Confirm Safety').parentElement?.previousElementSibling;
        fireEvent.click(safetyToggle as HTMLElement);
        fireEvent.click(screen.getByRole('button', { name: /cast off/i }));
        await screen.findByText('Passage Active · GPS Log Off');
        firstMount.unmount();

        castOffMocks.getActiveVoyage.mockResolvedValue({ ...voyage, status: 'active' });
        const currentOnCastOff = vi.fn();
        render(<CastOffPanel onCastOff={currentOnCastOff} onClose={vi.fn()} />);
        expect(await screen.findByRole('dialog', { name: 'Active Voyage' })).toBeInTheDocument();

        await act(async () => resolveTracking());
        expect(staleOnCastOff).not.toHaveBeenCalled();
        expect(currentOnCastOff).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Active Voyage' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /retry gps logging/i })).toBeEnabled();
    });

    it('shows the activated passage with a recovery action when background GPS cannot start', async () => {
        const voyage = {
            id: 'voyage-gps-denied',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'planning',
        };
        const onCastOff = vi.fn();
        castOffMocks.getDraftVoyages.mockResolvedValue([voyage]);
        castOffMocks.castOff.mockResolvedValue({ ok: true, voyage: { ...voyage, status: 'active' } });
        castOffMocks.startTracking.mockRejectedValue(
            new Error('Voyage logging needs Always Location access for locked-screen operation.'),
        );
        render(<CastOffPanel initialVoyageId={voyage.id} onCastOff={onCastOff} onClose={vi.fn()} />);

        await screen.findByText('Confirm Safety');
        const safetyToggle = screen.getByText('Confirm Safety').parentElement?.previousElementSibling;
        fireEvent.click(safetyToggle as HTMLElement);
        fireEvent.click(screen.getByRole('button', { name: /cast off/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Passage is active, but GPS voyage logging did not start.',
        );
        expect(screen.getByRole('dialog', { name: 'Active Voyage' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /retry gps logging/i })).toBeEnabled();
        expect(screen.getByText('Passage Active · GPS Log Off')).toBeInTheDocument();
        expect(onCastOff).not.toHaveBeenCalled();
    });

    it('detects an active-passage GPS mismatch on reopen and deduplicates recovery', async () => {
        const activeVoyage = {
            id: 'voyage-active',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'active',
        };
        let resolveTracking!: () => void;
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        castOffMocks.getTrackingStatus
            .mockReturnValueOnce({ isTracking: false, currentVoyageId: activeVoyage.id })
            .mockReturnValue({ isTracking: true, currentVoyageId: activeVoyage.id });
        castOffMocks.startTracking.mockReturnValue(
            new Promise<void>((resolve) => {
                resolveTracking = resolve;
            }),
        );
        const onCastOff = vi.fn();

        render(<CastOffPanel onCastOff={onCastOff} onClose={vi.fn()} />);
        const retry = await screen.findByRole('button', { name: /retry gps logging/i });
        expect(castOffMocks.initializeTracking).toHaveBeenCalledOnce();
        fireEvent.click(retry);
        fireEvent.click(retry);

        expect(await screen.findByRole('button', { name: /starting gps logging/i })).toBeDisabled();
        await vi.waitFor(() => expect(castOffMocks.startTracking).toHaveBeenCalledTimes(1));

        await act(async () => resolveTracking());
        expect(await screen.findByText('Live')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /retry gps logging/i })).not.toBeInTheDocument();
        expect(onCastOff).toHaveBeenCalledTimes(1);
        expect(onCastOff).toHaveBeenCalledWith(expect.objectContaining({ id: activeVoyage.id }));
    });

    it('keeps the active voyage visible and creates no stand-down when End Voyage is not confirmed', async () => {
        const activeVoyage = {
            id: 'voyage-active',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'active',
        };
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        castOffMocks.endVoyage.mockResolvedValue(false);

        render(<CastOffPanel onClose={vi.fn()} />);
        const endButton = await screen.findByRole('button', { name: /end voyage & archive/i });
        fireEvent.click(endButton);

        expect(await screen.findByRole('alert')).toHaveTextContent('End Voyage was not confirmed');
        expect(screen.getByRole('dialog', { name: 'Active Voyage' })).toBeInTheDocument();
        expect(screen.queryByTestId('stand-down-prompt')).not.toBeInTheDocument();
        expect(castOffMocks.getDraftVoyages).toHaveBeenCalledTimes(1);
    });

    it('deduplicates repeated End Voyage activation until the confirmed operation settles', async () => {
        const activeVoyage = {
            id: 'voyage-active',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'active',
        };
        let resolveEnd!: (confirmed: boolean) => void;
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        castOffMocks.endVoyage.mockReturnValue(
            new Promise<boolean>((resolve) => {
                resolveEnd = resolve;
            }),
        );

        render(<CastOffPanel onClose={vi.fn()} />);
        const endButton = await screen.findByRole('button', { name: /end voyage & archive/i });
        fireEvent.click(endButton);
        fireEvent.click(endButton);

        expect(castOffMocks.endVoyage).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole('button', { name: /ending voyage/i })).toBeDisabled();

        await act(async () => resolveEnd(false));
        expect(await screen.findByRole('alert')).toHaveTextContent('End Voyage was not confirmed');
    });
});
