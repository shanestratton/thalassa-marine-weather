import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoroutingTrialWorkspaceProps } from '../components/autorouting/AutoroutingTrialWorkspace';
import type { AutoroutingTrialStatus } from '../services/autoroutingTrial';

const mocks = vi.hoisted(() => {
    // Seed the actual URL before uiStore imports and selects its boot view.
    const originalUrl = window.location.href;
    window.history.replaceState(null, '', '/plan');
    return {
        originalUrl,
        auth: { user: null as { id: string } | null, authChecked: false },
        status: vi.fn(),
        calculate: vi.fn(),
        workspace: vi.fn(),
        tracerEvent: vi.fn(),
        passageEvent: vi.fn(),
    };
});

vi.mock('../stores/authStore', () => ({
    useAuthStore: Object.assign((selector: (state: typeof mocks.auth) => unknown) => selector(mocks.auth), {
        getState: () => mocks.auth,
    }),
}));
vi.mock('../components/SignInScreen', () => ({
    SignInScreen: ({ onClose }: { onClose?: () => void }) => (
        <div role="dialog" aria-label="Sign in to plan" data-dismissible={String(Boolean(onClose))} />
    ),
}));
vi.mock('../services/autoroutingTrial', () => ({
    getAutoroutingTrialStatus: mocks.status,
    calculateAutoroutingTrial: mocks.calculate,
}));
// Exercise the real entry dialog; stop at the costly, separately tested chart.
vi.mock('../components/autorouting/AutoroutingTrialWorkspace', () => ({
    AutoroutingTrialWorkspace: (props: AutoroutingTrialWorkspaceProps) => {
        mocks.workspace(props);
        return (
            <div role="dialog" aria-label="Autorouting trial workspace">
                <button type="button" onClick={props.onClose}>
                    Close trial workspace
                </button>
            </div>
        );
    },
}));
vi.mock('../hooks/useVoyageForm', () => ({
    useVoyageForm: () => ({
        origin: '',
        setOrigin: vi.fn(),
        destination: '',
        setDestination: vi.fn(),
        isMapOpen: false,
        setIsMapOpen: vi.fn(),
        mapSelectionTarget: null,
        loading: false,
        loadingStep: 0,
        error: null,
        handleCalculate: vi.fn(),
        clearVoyagePlan: vi.fn(),
        handleOriginLocation: vi.fn(),
        handleMapSelect: vi.fn(),
        openMap: vi.fn(),
        voyagePlan: null,
        vessel: null,
        isPro: true,
        mapboxToken: 'plan-fixture-map-token',
    }),
    LOADING_PHASES: [],
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../utils/system', async (original) => ({
    ...(await original<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../utils/keyboardScroll', () => ({
    scrollInputAboveKeyboard: vi.fn(),
    subscribeKeyboardHeight: vi.fn(() => () => {}),
}));
vi.mock('../services/routeTracer', async (original) => ({
    ...(await original<typeof import('../services/routeTracer')>()),
    loadSavedTraces: () => [],
}));
vi.mock('../components/map/MapHub', () => ({ MapHub: () => <div>Manual chart</div> }));

import { BuilderDeepLink } from '../components/BuilderDeepLink';
import { RoutePlanner } from '../components/RoutePlanner';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    consumeTracerAction,
    consumeTracerOpenRequest,
    initialViewFromUrl,
    isBuilderDeepLink,
    peekTracerOpenRequest,
} from '../services/deepLink';
import { clearPassageRequest, peekPassageRequest } from '../services/passageHandoff';
import { useUIStore } from '../stores/uiStore';
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';

const actualBootView = useUIStore.getState().currentView;

function PlanEntry() {
    const view = useUIStore((state) => state.currentView);
    return (
        <>
            {view === 'voyage' ? <RoutePlanner onTriggerUpgrade={vi.fn()} /> : <div>Manual chart destination</div>}
            <BuilderDeepLink />
        </>
    );
}

function setSession(userId: string | null, authChecked = true) {
    setAuthIdentityScope(userId);
    mocks.auth = { user: userId ? { id: userId } : null, authChecked };
}

function startPlotting() {
    // A plain tap: Start plotting only opens the reversible routing choice.
    fireEvent.click(screen.getByRole('button', { name: 'Start plotting' }));
    return screen.getByRole('dialog', { name: 'Choose routing mode' });
}

function expectNoRouteHandoff() {
    expect(useUIStore.getState().currentView).toBe('voyage');
    expect(peekTracerOpenRequest()).toBe(false);
    expect(peekPassageRequest()).toBeNull();
    expect(mocks.tracerEvent).not.toHaveBeenCalled();
    expect(mocks.passageEvent).not.toHaveBeenCalled();
    expect(mocks.calculate).not.toHaveBeenCalled();
}

beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/plan');
    setSession(null, false);
    consumeTracerOpenRequest();
    consumeTracerAction();
    clearPassageRequest();
    useUIStore.setState({ currentView: initialViewFromUrl()!, previousView: 'voyage' });
    mocks.status.mockResolvedValue({ enabled: true, ready: true });
    window.addEventListener('thalassa:trace-mode', mocks.tracerEvent);
    window.addEventListener('thalassa:passage-mode', mocks.passageEvent);
});

afterEach(() => {
    cleanup();
    window.removeEventListener('thalassa:trace-mode', mocks.tracerEvent);
    window.removeEventListener('thalassa:passage-mode', mocks.passageEvent);
    vi.restoreAllMocks();
});

afterAll(() => window.history.replaceState(null, '', mocks.originalUrl));

describe('/plan autorouting entry', () => {
    it('boots the real /plan URL into the planner and requires a confirmed session before routing choices', () => {
        expect(isBuilderDeepLink()).toBe(true);
        expect(actualBootView).toBe('voyage');
        const { rerender } = render(<PlanEntry />);
        expect(screen.getByRole('dialog', { name: 'Checking your session…' })).toHaveFocus();
        expect(mocks.status).not.toHaveBeenCalled();
        expect(mocks.workspace).not.toHaveBeenCalled();
        expectNoRouteHandoff();

        act(() => setSession(null));
        rerender(<PlanEntry />);
        expect(screen.getByRole('dialog', { name: 'Sign in to plan' })).toHaveAttribute('data-dismissible', 'false');
        expect(mocks.status).not.toHaveBeenCalled();

        act(() => setSession('plan-skipper'));
        rerender(<PlanEntry />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Start plotting' })).toBeInTheDocument();
        expect(mocks.status).not.toHaveBeenCalled();
        expectNoRouteHandoff();
    });

    it('keeps Auto gated while checking and denied, then hands Manual to the existing chart exactly once', async () => {
        let resolveStatus!: (status: AutoroutingTrialStatus) => void;
        mocks.status.mockReturnValue(new Promise<AutoroutingTrialStatus>((resolve) => (resolveStatus = resolve)));
        setSession('plan-skipper');
        render(<PlanEntry />);

        const dialog = startPlotting();
        expect(dialog).toHaveTextContent('Checking Auto routing availability… Manual is ready.');
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Manual routing' })).toBeEnabled();
        expect(mocks.status).toHaveBeenCalledTimes(1);
        expectNoRouteHandoff();

        await act(async () => resolveStatus({ enabled: false, ready: false }));
        expect(dialog).toHaveTextContent('Auto routing is not enabled for this account. Manual is ready.');
        fireEvent.click(screen.getByRole('button', { name: 'Auto routing' }));
        expect(mocks.workspace).not.toHaveBeenCalled();
        expectNoRouteHandoff();

        fireEvent.click(screen.getByRole('button', { name: 'Manual routing' }));
        expect(useUIStore.getState().currentView).toBe('map');
        expect(screen.getByText('Manual chart destination')).toBeInTheDocument();
        expect(mocks.tracerEvent).toHaveBeenCalledTimes(1);
        expect(consumeTracerOpenRequest()).toBe(true);
        expect(consumeTracerAction()).toBeNull();
        expect(consumeTracerOpenRequest()).toBe(false);
        expect(mocks.passageEvent).not.toHaveBeenCalled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'opens the enabled trial chart without activating a route (provider ready=%s)',
        async (ready) => {
            mocks.status.mockResolvedValue({ enabled: true, ready });
            setSession('plan-skipper');
            // A confirmed draft opens the trial at once; an unconfirmed one is
            // asked about first (tests/DraftConfirmGates.test.tsx).
            await awaitSettingsLoaded();
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    vessel: {
                        name: 'Plan boat',
                        type: 'sail',
                        length: 40,
                        beam: 13,
                        draft: 7.87,
                        draftConfirmedFt: 7.87,
                        displacement: 20000,
                        maxWaveHeight: 10,
                        cruisingSpeed: 6,
                    },
                },
            });
            render(<PlanEntry />);
            startPlotting();
            const auto = screen.getByRole('button', { name: 'Auto routing' });
            await waitFor(() => expect(auto).toBeEnabled());
            fireEvent.click(auto);

            expect(await screen.findByRole('dialog', { name: 'Autorouting trial workspace' })).toBeInTheDocument();
            expect(mocks.workspace).toHaveBeenLastCalledWith(
                expect.objectContaining({ mapboxToken: 'plan-fixture-map-token', onClose: expect.any(Function) }),
            );
            expectNoRouteHandoff();
            fireEvent.click(screen.getByRole('button', { name: 'Close trial workspace' }));
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Start plotting' })).toBeInTheDocument();
            expectNoRouteHandoff();
        },
    );

    it('closes the routing choice on sign-out and ignores the old account’s late trial availability', async () => {
        let resolveStatus!: (status: AutoroutingTrialStatus) => void;
        mocks.status.mockReturnValue(new Promise<AutoroutingTrialStatus>((resolve) => (resolveStatus = resolve)));
        setSession('plan-skipper');
        const { rerender } = render(<PlanEntry />);
        startPlotting();
        const signal = mocks.status.mock.calls[0][0] as AbortSignal;

        act(() => setSession(null));
        rerender(<PlanEntry />);
        expect(screen.queryByRole('dialog', { name: 'Choose routing mode' })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Sign in to plan' })).toBeInTheDocument();
        expect(signal.aborted).toBe(true);
        await act(async () => resolveStatus({ enabled: true, ready: true }));
        expect(screen.queryByRole('button', { name: 'Auto routing' })).not.toBeInTheDocument();
        expect(mocks.workspace).not.toHaveBeenCalled();
        expectNoRouteHandoff();
    });
});
