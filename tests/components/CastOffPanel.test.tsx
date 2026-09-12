/**
 * CastOffPanel — smoke tests (595 LOC component)
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../../services/authIdentityScope';

const castOffMocks = vi.hoisted(() => ({
    getDraftVoyages: vi.fn(),
    getActiveVoyage: vi.fn(),
    castOff: vi.fn(),
    endVoyage: vi.fn(),
    initializeTracking: vi.fn(),
    getTrackingStatus: vi.fn(),
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    createVoyage: vi.fn(),
    createVoyageChannel: vi.fn(),
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
    createVoyage: castOffMocks.createVoyage,
}));
vi.mock('../../services/ShipLogService', () => ({
    ShipLogService: {
        initialize: castOffMocks.initializeTracking,
        getTrackingStatus: castOffMocks.getTrackingStatus,
        startTracking: castOffMocks.startTracking,
        stopTracking: castOffMocks.stopTracking,
    },
}));
vi.mock('../../services/ChatService', () => ({
    ChatService: { createVoyageChannel: castOffMocks.createVoyageChannel },
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
        castOffMocks.createVoyage.mockResolvedValue({ voyage: null, error: null });
        castOffMocks.createVoyageChannel.mockResolvedValue(null);
        localStorage.clear();
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    const renderSettled = async () => {
        const result = render(<CastOffPanel onClose={vi.fn()} />);
        await screen.findByText('Ready for a new passage?');
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
        // The caution is still returned by castOff(), but the Log page's
        // heads-up was removed (Shane 2026-08-30), so it is deliberately not
        // carried into the handoff any more.
        expect(peekCastOffHandoff()).toMatchObject({
            voyageId: voyage.id,
            gps: 'starting',
            caution: null,
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
    it('a saved route stays memory-only until confirmed Cast Off', async () => {
        // Shane 2026-08-27: "a route is not removed from the list in the cast
        // off list or the passage planning page, unless it is removed from
        // the plan page". This list only ever showed status='planning' rows,
        // so an End Voyage — or a tracer-only save — hid the route entirely.
        localStorage.setItem(
            authScopedStorageKey('thalassa_traced_routes_v1'),
            JSON.stringify([
                {
                    id: 'trace-1',
                    name: 'Newport - Mackay',
                    createdAt: '2026-08-26T00:00:00.000Z',
                    destName: 'Mackay',
                    points: [
                        { lat: -27.2, lon: 153.1 },
                        { lat: -21.1, lon: 149.2 },
                    ],
                },
            ]),
        );
        castOffMocks.getDraftVoyages.mockResolvedValue([]);
        castOffMocks.getActiveVoyage.mockResolvedValue(null);
        castOffMocks.createVoyage.mockResolvedValue({
            voyage: {
                id: 'voyage-materialised',
                voyage_name: 'Newport - Mackay',
                departure_port: 'Newport',
                destination_port: 'Mackay',
                crew_count: 2,
                status: 'planning',
                saved_route_id: 'trace-1',
            },
            error: null,
        });

        render(<CastOffPanel onClose={vi.fn()} />);

        const row = await screen.findByRole('button', { name: /Newport - Mackay/ });
        expect(within(row).getByText('Saved route')).toBeInTheDocument();

        fireEvent.click(row);

        expect(await screen.findByText('Confirm Safety')).toBeInTheDocument();
        expect(castOffMocks.createVoyage).not.toHaveBeenCalled();
        expect(castOffMocks.createVoyageChannel).not.toHaveBeenCalled();
        const savedRoutesBefore = localStorage.getItem(authScopedStorageKey('thalassa_traced_routes_v1'));
        fireEvent.click(screen.getByRole('button', { name: /Back to Routes/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Newport - Mackay/ }));
        expect(await screen.findByText('Confirm Safety')).toBeInTheDocument();
        expect(castOffMocks.createVoyage).not.toHaveBeenCalled();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_traced_routes_v1'))).toBe(savedRoutesBefore);
        castOffMocks.castOff.mockResolvedValue({ ok: false, error: 'Controlled activation failure' });
        fireEvent.click(screen.getByRole('checkbox', { name: /Confirm Safety/ }));
        fireEvent.click(screen.getByRole('button', { name: /CAST OFF/ }));
        await screen.findByText('Controlled activation failure');
        expect(castOffMocks.createVoyage).toHaveBeenCalledTimes(1);
        expect(castOffMocks.createVoyage).toHaveBeenCalledWith(
            expect.objectContaining({ saved_route_id: 'trace-1', voyage_name: 'Newport - Mackay' }),
        );
        expect(castOffMocks.castOff).toHaveBeenCalledWith('voyage-materialised');
        expect(castOffMocks.createVoyageChannel).not.toHaveBeenCalled();
        await act(async () => fireEvent.click(screen.getByRole('button', { name: /CAST OFF/ })));
        expect(castOffMocks.castOff).toHaveBeenCalledTimes(2);
        expect(castOffMocks.createVoyage).toHaveBeenCalledTimes(1);
    });

    it('abandoning a quick passage saves no draft or chat channel and reopening starts fresh', async () => {
        const onClose = vi.fn();
        const opened = render(<CastOffPanel onClose={onClose} />);
        fireEvent.click(await screen.findByRole('button', { name: '+ New Voyage' }));
        fireEvent.change(screen.getByPlaceholderText('e.g. Tangalooma Day Trip'), {
            target: { value: 'Abandoned Musgrave setup' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to Cast Off' }));
        await screen.findByText('Confirm Safety');
        fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        opened.unmount();
        render(<CastOffPanel onClose={vi.fn()} />);
        await screen.findByText('Ready for a new passage?');
        expect(screen.queryByText('Abandoned Musgrave setup')).not.toBeInTheDocument();
        expect(castOffMocks.createVoyage).not.toHaveBeenCalled();
        expect(castOffMocks.castOff).not.toHaveBeenCalled();
        expect(castOffMocks.createVoyageChannel).not.toHaveBeenCalled();
    });

    it('legacy abandoned setups are not route choices, while saved plans remain available', async () => {
        castOffMocks.getDraftVoyages.mockResolvedValue([
            { id: 'abandoned', voyage_name: 'Never sailed this', status: 'planning' },
            { id: 'saved', voyage_name: 'Saved Lady Musgrave route', status: 'planning', saved_route_id: 'route-1' },
        ]);
        render(<CastOffPanel onClose={vi.fn()} />);
        expect(await screen.findByRole('button', { name: /Saved Lady Musgrave route/ })).toBeInTheDocument();
        expect(screen.queryByText('Never sailed this')).not.toBeInTheDocument();
        expect(screen.queryByText('Draft Voyages')).not.toBeInTheDocument();
        expect(castOffMocks.createVoyage).not.toHaveBeenCalled();
    });

    it('starts a quick passage once only, and only creates its channel after confirmed activation', async () => {
        let resolveCreate!: (result: { voyage: object }) => void;
        castOffMocks.createVoyage.mockReturnValue(
            new Promise((resolve) => {
                resolveCreate = resolve;
            }),
        );
        const onClose = vi.fn();
        const onCastOff = vi.fn();
        render(<CastOffPanel onClose={onClose} onCastOff={onCastOff} />);
        fireEvent.click(await screen.findByRole('button', { name: '+ New Voyage' }));
        fireEvent.change(screen.getByPlaceholderText('e.g. Tangalooma Day Trip'), {
            target: { value: 'Musgrave morning' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to Cast Off' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Confirm Safety/ }));
        const start = screen.getByRole('button', { name: /CAST OFF/ });
        fireEvent.click(start);
        fireEvent.click(start);
        expect(castOffMocks.createVoyage).toHaveBeenCalledTimes(1);
        expect(castOffMocks.castOff).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
        const voyage = {
            id: 'actual-voyage',
            user_id: 'account-a',
            voyage_name: 'Musgrave morning',
            departure_port: null,
            destination_port: null,
            crew_count: 2,
            status: 'active',
        };
        castOffMocks.castOff.mockResolvedValue({ ok: true, voyage });
        await act(async () => resolveCreate({ voyage: { ...voyage, status: 'planning' } }));
        await vi.waitFor(() => expect(onCastOff).toHaveBeenCalledWith(voyage));
        expect(castOffMocks.castOff).toHaveBeenCalledExactlyOnceWith('actual-voyage');
        expect(castOffMocks.createVoyageChannel).toHaveBeenCalledExactlyOnceWith('actual-voyage', 'Musgrave morning');
    });

    it('does not create the old account’s in-memory setup under a new account', async () => {
        render(<CastOffPanel onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: '+ New Voyage' }));
        fireEvent.change(screen.getByPlaceholderText('e.g. Tangalooma Day Trip'), {
            target: { value: 'Account A setup' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to Cast Off' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Confirm Safety/ }));
        setAuthIdentityScope('account-b');
        fireEvent.click(screen.getByRole('button', { name: /CAST OFF/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Your account changed');
        expect(castOffMocks.createVoyage).not.toHaveBeenCalled();
    });

    it('does not activate or start tracking when the account changes during final creation', async () => {
        let finishCreate!: (result: { voyage: object }) => void;
        castOffMocks.createVoyage.mockReturnValue(
            new Promise((resolve) => {
                finishCreate = resolve;
            }),
        );
        const onClose = vi.fn();
        render(<CastOffPanel onClose={onClose} />);
        fireEvent.click(await screen.findByRole('button', { name: '+ New Voyage' }));
        fireEvent.change(screen.getByPlaceholderText('e.g. Tangalooma Day Trip'), {
            target: { value: 'Account A setup' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to Cast Off' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Confirm Safety/ }));
        fireEvent.click(screen.getByRole('button', { name: /CAST OFF/ }));
        await act(async () => {
            setAuthIdentityScope('account-b');
            finishCreate({ voyage: { id: 'a-created-voyage', user_id: 'account-a', status: 'planning' } });
        });
        expect(castOffMocks.castOff).not.toHaveBeenCalled();
        expect(castOffMocks.startTracking).not.toHaveBeenCalled();
        expect(castOffMocks.createVoyageChannel).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Close dialog' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
