import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoroutingTrialWorkspaceProps } from '../components/autorouting/AutoroutingTrialWorkspace';

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
        fetch: null as null | { mock: { calls: unknown[][] } },
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
// Auto's status is worked out on the phone since 2026-10-01 (signed in +
// installed charts); no edge function is asked whether Auto is offered.
vi.mock('../services/autoroutingThalassa', () => ({
    getThalassaAutorouteStatus: mocks.status,
    calculateThalassaProposal: mocks.calculate,
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
    // Never the old server trial (zero requests to /functions/v1/autorouting-trial).
    expect(
        (mocks.fetch?.mock.calls ?? []).filter(([input]) => String(input).includes('/functions/v1/autorouting-trial')),
    ).toEqual([]);
}

beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/plan');
    setSession(null, false);
    consumeTracerOpenRequest();
    consumeTracerAction();
    clearPassageRequest();
    useUIStore.setState({ currentView: initialViewFromUrl()!, previousView: 'voyage' });
    mocks.status.mockReturnValue({ enabled: true, ready: true });
    mocks.fetch = vi.spyOn(globalThis, 'fetch');
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

    it('keeps Auto gated when not enabled, then hands Manual to the existing chart exactly once', async () => {
        mocks.status.mockReturnValue({ enabled: false, ready: false });
        setSession('plan-skipper');
        render(<PlanEntry />);

        const dialog = startPlotting();
        await waitFor(() =>
            expect(dialog).toHaveTextContent('Auto routing is not enabled for this account. Manual is ready.'),
        );
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Manual routing' })).toBeEnabled();
        expect(mocks.status).toHaveBeenCalledTimes(1);
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
        'opens the enabled trial chart without activating a route (charts installed=%s)',
        async (ready) => {
            mocks.status.mockReturnValue({ enabled: true, ready });
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
            const dialog = startPlotting();
            const auto = screen.getByRole('button', { name: 'Auto routing' });
            await waitFor(() => expect(auto).toBeEnabled());
            expect(dialog).toHaveTextContent(
                ready
                    ? 'Trial · leaving now. Your saved routes and trip legs stay unchanged.'
                    : 'Install charts for your area to use Auto. Manual is ready.',
            );
            expect(dialog).toHaveTextContent(
                'Thalassa routes it on this phone from your installed charts. Review before saving.',
            );
            expect(dialog).toHaveTextContent('Auto is an unsaved trial, not a route cleared for navigation.');
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

    it('closes the routing choice on sign-out without opening Auto for the old account', async () => {
        setSession('plan-skipper');
        const { rerender } = render(<PlanEntry />);
        startPlotting();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Auto routing' })).toBeEnabled());

        act(() => setSession(null));
        rerender(<PlanEntry />);
        expect(screen.queryByRole('dialog', { name: 'Choose routing mode' })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Sign in to plan' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Auto routing' })).not.toBeInTheDocument();
        expect(mocks.workspace).not.toHaveBeenCalled();
        expectNoRouteHandoff();
    });
});
