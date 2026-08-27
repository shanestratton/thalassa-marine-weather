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
    stopTracking: vi.fn(),
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
        stopTracking: castOffMocks.stopTracking,
    },
}));

import { CastOffPanel } from '../../components/vessel/CastOffPanel';
import { clearCastOffHandoff, peekCastOffHandoff } from '../../services/castOffHandoff';

describe('CastOffPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearCastOffHandoff();
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
        castOffMocks.stopTracking.mockResolvedValue(undefined);
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

    it('hands off to the Log page the moment the passage is active — GPS continues behind it', async () => {
        // Shane 2026-08-26: "press the cast off button and the next button
        // after that, it goes to the log page". The panel must NOT dwell on
        // an intermediate active screen while a cold GPS fix warms up.
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
        castOffMocks.castOff.mockResolvedValue({
            ok: true,
            voyage: { ...voyage, status: 'active' },
            caution: 'The traced route changed after it was checked.',
        });
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

        // Handoff fires as soon as the voyage is active — no dwell.
        await vi.waitFor(() => expect(onCastOff).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('Passage Active · GPS Log Off')).not.toBeInTheDocument();
        expect(peekCastOffHandoff()).toMatchObject({
            voyageId: voyage.id,
            gps: 'starting',
            caution: 'The traced route changed after it was checked.',
        });

        await act(async () => resolveTracking());
        await vi.waitFor(() => expect(peekCastOffHandoff()).toMatchObject({ gps: 'confirmed' }));
    });

    it('revokes an unmounted Cast Off panel so its late activation cannot hand off or stash', async () => {
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

        // The cast off RPC is still in flight when the panel unmounts — its
        // late completion must not hand off from a dead mount.
        let resolveCastOff!: (result: { ok: boolean; voyage: typeof voyage }) => void;
        castOffMocks.castOff.mockReturnValue(
            new Promise((resolve) => {
                resolveCastOff = resolve;
            }),
        );
        const firstMount = render(
            <CastOffPanel initialVoyageId={voyage.id} onCastOff={staleOnCastOff} onClose={vi.fn()} />,
        );
        await screen.findByText('Confirm Safety');
        const safetyToggle = screen.getByText('Confirm Safety').parentElement?.previousElementSibling;
        fireEvent.click(safetyToggle as HTMLElement);
        fireEvent.click(screen.getByRole('button', { name: /cast off/i }));
        firstMount.unmount();

        castOffMocks.getActiveVoyage.mockResolvedValue({ ...voyage, status: 'active' });
        const currentOnCastOff = vi.fn();
        render(<CastOffPanel onCastOff={currentOnCastOff} onClose={vi.fn()} />);
        expect(await screen.findByRole('dialog', { name: 'Active Voyage' })).toBeInTheDocument();

        await act(async () => {
            resolveCastOff({ ok: true, voyage: { ...voyage, status: 'active' } });
            resolveTracking();
        });
        expect(staleOnCastOff).not.toHaveBeenCalled();
        expect(currentOnCastOff).not.toHaveBeenCalled();
        expect(peekCastOffHandoff()).toBeNull();
        expect(screen.getByRole('dialog', { name: 'Active Voyage' })).toBeInTheDocument();
        // The amber "Retry GPS Logging" recovery card is gone (Shane
        // 2026-08-27) — an active passage renders as Live, full stop.
        expect(screen.getByText('Live')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /retry gps logging/i })).not.toBeInTheDocument();
    });

    it('records a GPS start failure on the handoff for the Log page to surface', async () => {
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

        // The handoff still happens — the Log page owns the failure surface
        // and its Retry button. The skipper is never stranded in this panel.
        await vi.waitFor(() => expect(onCastOff).toHaveBeenCalledTimes(1));
        await vi.waitFor(() =>
            expect(peekCastOffHandoff()).toMatchObject({
                voyageId: voyage.id,
                gps: 'failed',
                gpsError: 'Voyage logging needs Always Location access for locked-screen operation.',
            }),
        );
        expect(screen.queryByText('Passage Active · GPS Log Off')).not.toBeInTheDocument();
    });

    it('never second-guesses GPS on an active passage — the cold JS mirror cried wolf', async () => {
        // getTrackingStatus()'s JS mirror stays cold until the Ship's Log
        // page hydrates it, so a HEALTHY passage rendered the amber "Retry
        // GPS Logging" card on every open (Shane 2026-08-27: "it is always
        // working. but i need to open the ships log first"). The card and
        // the load-time tracker probe are gone: an active passage is Live.
        const activeVoyage = {
            id: 'voyage-active',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'active',
        };
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        castOffMocks.getTrackingStatus.mockReturnValue({ isTracking: false, currentVoyageId: undefined });

        render(<CastOffPanel onCastOff={vi.fn()} onClose={vi.fn()} />);
        expect(await screen.findByText('Live')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /retry gps logging/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/GPS voyage logging/)).not.toBeInTheDocument();
        expect(castOffMocks.initializeTracking).not.toHaveBeenCalled();
        expect(castOffMocks.startTracking).not.toHaveBeenCalled();
    });

    it('the selection wins over a stale active voyage: preflight opens, one Cast Off ends then starts', async () => {
        const activeVoyage = {
            id: 'voyage-leg1',
            voyage_name: 'Newport - Coral Sea (1st Leg)',
            departure_port: 'Newport',
            destination_port: 'Coral Sea',
            crew_count: 2,
            status: 'active',
        };
        const selectedVoyage = {
            id: 'voyage-leg2',
            voyage_name: 'Coral Sea - Mackay (2nd Leg)',
            departure_port: 'Coral Sea',
            destination_port: 'Mackay',
            crew_count: 2,
            status: 'planning',
        };
        const onCastOff = vi.fn();
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        castOffMocks.getDraftVoyages.mockResolvedValue([selectedVoyage]);
        castOffMocks.endVoyage.mockResolvedValue(true);
        castOffMocks.castOff.mockResolvedValue({ ok: true, voyage: { ...selectedVoyage, status: 'active' } });

        render(<CastOffPanel initialVoyageId={selectedVoyage.id} onCastOff={onCastOff} onClose={vi.fn()} />);

        // The selection opens ITS OWN pre-departure check — the stale
        // active passage is a named caution, not a gate (Shane 2026-08-27:
        // "it always shows the newport - coral sea 1st leg" / "i dont
        // think that it is necessary to enforce it").
        expect(await screen.findByText('Confirm Safety')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Coral Sea - Mackay (2nd Leg)' })).toBeInTheDocument();
        expect(screen.getByText(/still active/)).toBeInTheDocument();
        expect(screen.getByText('Newport - Coral Sea (1st Leg)')).toBeInTheDocument();

        const safetyToggle = screen.getByRole('checkbox', { name: /confirm safety/i });
        fireEvent.click(safetyToggle);
        fireEvent.click(screen.getByRole('button', { name: /cast off/i }));

        // One gesture: the stale passage is ended & archived FIRST, then
        // the selected one casts off.
        await vi.waitFor(() => expect(onCastOff).toHaveBeenCalledTimes(1));
        expect(castOffMocks.endVoyage).toHaveBeenCalledWith('voyage-leg1', 'completed');
        expect(castOffMocks.castOff).toHaveBeenCalledWith('voyage-leg2');
        expect(castOffMocks.endVoyage.mock.invocationCallOrder[0]).toBeLessThan(
            castOffMocks.castOff.mock.invocationCallOrder[0],
        );
        expect(onCastOff).toHaveBeenCalledWith(expect.objectContaining({ id: 'voyage-leg2' }));
    });

    it('a failed auto-end blocks Cast Off with an honest error, not a half-state', async () => {
        const activeVoyage = {
            id: 'voyage-leg1',
            voyage_name: 'Newport - Coral Sea (1st Leg)',
            departure_port: 'Newport',
            destination_port: 'Coral Sea',
            crew_count: 2,
            status: 'active',
        };
        const selectedVoyage = {
            id: 'voyage-leg2',
            voyage_name: 'Coral Sea - Mackay (2nd Leg)',
            departure_port: 'Coral Sea',
            destination_port: 'Mackay',
            crew_count: 2,
            status: 'planning',
        };
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        castOffMocks.getDraftVoyages.mockResolvedValue([selectedVoyage]);
        castOffMocks.endVoyage.mockResolvedValue(false);

        render(<CastOffPanel initialVoyageId={selectedVoyage.id} onCastOff={vi.fn()} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole('checkbox', { name: /confirm safety/i }));
        fireEvent.click(screen.getByRole('button', { name: /cast off/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent('could not be ended');
        expect(castOffMocks.castOff).not.toHaveBeenCalled();
    });

    it('a passage ended elsewhere cannot dead-end Cast Off — the re-check lets it proceed', async () => {
        const activeVoyage = {
            id: 'voyage-leg1',
            voyage_name: 'Newport - Coral Sea (1st Leg)',
            departure_port: 'Newport',
            destination_port: 'Coral Sea',
            crew_count: 2,
            status: 'active',
        };
        const selectedVoyage = {
            id: 'voyage-leg2',
            voyage_name: 'Coral Sea - Mackay (2nd Leg)',
            departure_port: 'Coral Sea',
            destination_port: 'Mackay',
            crew_count: 2,
            status: 'planning',
        };
        const onCastOff = vi.fn();
        // The load sees the active voyage; by Cast Off time it was ended on
        // another device — endVoyage returns false (its UPDATE filters
        // status='active'), and the re-check finds nothing active.
        castOffMocks.getActiveVoyage.mockResolvedValueOnce(activeVoyage).mockResolvedValue(null);
        castOffMocks.getDraftVoyages.mockResolvedValue([selectedVoyage]);
        castOffMocks.endVoyage.mockResolvedValue(false);
        castOffMocks.castOff.mockResolvedValue({ ok: true, voyage: { ...selectedVoyage, status: 'active' } });

        render(<CastOffPanel initialVoyageId={selectedVoyage.id} onCastOff={onCastOff} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole('checkbox', { name: /confirm safety/i }));
        fireEvent.click(screen.getByRole('button', { name: /cast off/i }));

        await vi.waitFor(() => expect(onCastOff).toHaveBeenCalledTimes(1));
        expect(castOffMocks.castOff).toHaveBeenCalledWith('voyage-leg2');
    });

    it('the handed preflight keeps a door back to the active passage (Watch Mode)', async () => {
        const activeVoyage = {
            id: 'voyage-leg1',
            voyage_name: 'Newport - Coral Sea (1st Leg)',
            departure_port: 'Newport',
            destination_port: 'Coral Sea',
            crew_count: 2,
            status: 'active',
        };
        const selectedVoyage = {
            id: 'voyage-leg2',
            voyage_name: 'Coral Sea - Mackay (2nd Leg)',
            departure_port: 'Coral Sea',
            destination_port: 'Mackay',
            crew_count: 2,
            status: 'planning',
        };
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        castOffMocks.getDraftVoyages.mockResolvedValue([selectedVoyage]);

        render(<CastOffPanel initialVoyageId={selectedVoyage.id} onCastOff={vi.fn()} onClose={vi.fn()} />);

        // Selection wins, but the leg controls / float plan / stand-down
        // offer live on the active card — the caution's link is the only
        // in-panel way back to them.
        fireEvent.click(await screen.findByRole('button', { name: /view active passage/i }));
        expect(await screen.findByRole('dialog', { name: 'Active Voyage' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /end voyage & archive/i })).toBeInTheDocument();
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

    it("the active step's primary door is the Ship's Log", async () => {
        const activeVoyage = {
            id: 'voyage-active',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'active',
        };
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        const onOpenLog = vi.fn();
        const onClose = vi.fn();
        render(<CastOffPanel onOpenLog={onOpenLog} onClose={onClose} />);

        const door = await screen.findByRole('button', { name: /open ship.s log/i });
        fireEvent.click(door);
        expect(onOpenLog).toHaveBeenCalledTimes(1);
    });

    it('the door starts GPS logging when the active passage is not recording', async () => {
        const activeVoyage = {
            id: 'voyage-active',
            voyage_name: 'Brisbane → Cairns',
            departure_port: 'Brisbane',
            destination_port: 'Cairns',
            crew_count: 2,
            status: 'active',
        };
        castOffMocks.getActiveVoyage.mockResolvedValue(activeVoyage);
        castOffMocks.getTrackingStatus.mockReturnValue({ isTracking: false, currentVoyageId: null });
        castOffMocks.startTracking.mockResolvedValue(undefined);
        render(<CastOffPanel onOpenLog={vi.fn()} onClose={vi.fn()} />);

        const door = await screen.findByRole('button', { name: /open ship.s log/i });
        fireEvent.click(door);

        // Same resume path as the manual Retry that always works.
        await vi.waitFor(() =>
            expect(castOffMocks.startTracking).toHaveBeenCalledWith(true, 'voyage-active', expect.anything(), false),
        );
    });
});
