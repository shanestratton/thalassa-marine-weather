/**
 * The five draft-dependent entry points (Shane 2026-09-29): each waits for the
 * draft confirmation — nothing runs while "Your draft is set at 2.40 m. Please
 * confirm." is up, nothing runs when it is closed — and each runs straight
 * away once the draft is confirmed. One shared modal (DraftConfirmModal) does
 * the asking for all of them.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VesselProfile, VoyagePlan } from '../types';

const mocks = vi.hoisted(() => ({
    route: vi.fn(),
    sheet: vi.fn(),
    workspace: vi.fn(),
    status: vi.fn(),
    sweep: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/InshoreRouter', () => ({ tryInshoreRoute: mocks.route }));
vi.mock('../components/dayPlanner/DayPlannerSheet', () => ({
    default: (props: { vessel: VesselProfile | null; onClose: () => void }) => {
        mocks.sheet(props);
        return <div role="dialog" aria-label="Plan Your Day" />;
    },
}));
vi.mock('../services/autoroutingThalassa', () => ({
    getThalassaAutorouteStatus: mocks.status,
    calculateThalassaProposal: vi.fn(),
}));
vi.mock('../components/autorouting/AutoroutingTrialWorkspace', () => ({
    AutoroutingTrialWorkspace: (props: { initialDraftM?: number }) => {
        mocks.workspace(props);
        return <div role="dialog" aria-label="Autorouting trial workspace" />;
    },
}));
vi.mock('../services/routing/DepartureSweepInshore', () => ({ sweepDepartures: mocks.sweep }));
vi.mock('../services/TideHeightService', () => ({ fetchTideCurve: vi.fn(async () => null) }));
vi.mock('../services/routing/env/CmemsCurrentField', () => ({ getCurrentField: vi.fn(async () => null) }));

import { DraftConfirmModal } from '../components/vessel/DraftConfirmModal';
import { useAutoRouteLeg, type AutoRouteLegDeps } from '../components/map/useAutoRouteLeg';
import { DayPlannerEntry } from '../components/dayPlanner/DayPlannerEntry';
import { RoutingModeDialog } from '../components/autorouting/RoutingModeDialog';
import { DepartureSweepSheet } from '../components/passage/DepartureSweepSheet';
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { FEET_PER_METRE } from '../services/units';

const DRAFT_FT = 7.87; // shows as 2.40 m
const BOAT: VesselProfile = {
    name: 'Serene Summer',
    type: 'sail',
    length: 40,
    beam: 13,
    draft: DRAFT_FT,
    displacement: 20000,
    maxWaveHeight: 10,
    cruisingSpeed: 6,
};
const CONFIRMED: VesselProfile = { ...BOAT, draftConfirmedFt: DRAFT_FT };

function seed(vessel: VesselProfile | undefined) {
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, vessel } });
}
const storeVessel = () => useSettingsStore.getState().settings.vessel;

async function confirmInModal() {
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm 2.40 m' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull());
}
async function changeInModal(metres: string) {
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft in metres' }), { target: { value: metres } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull());
}
async function closeModal() {
    const dialog = await screen.findByRole('dialog', { name: 'Check your draft' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull());
}
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 60)));

beforeAll(async () => {
    await awaitSettingsLoaded();
});

beforeEach(async () => {
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    await awaitSettingsLoaded();
    seed(BOAT);
    mocks.route.mockResolvedValue({
        polyline: [
            [153.1, -27.2],
            [153.11, -27.21],
        ],
        distanceNM: 0.8,
    });
    mocks.status.mockReturnValue({ enabled: true, ready: true });
    mocks.sweep.mockReturnValue({ options: [], best: null, currentProvenance: 'NONE' });
});

afterEach(() => {
    cleanup();
});

// ── 1. ⚡ Auto route (components/map/useAutoRouteLeg.ts) ────────────────
describe('⚡ Auto route', () => {
    function autoRoute() {
        const deps: AutoRouteLegDeps = {
            capturedCoords: [
                { lat: -27.2, lon: 153.1 },
                { lat: -27.21, lon: 153.11 },
            ],
            setCapturedCoords: vi.fn(),
            selectedPin: null,
            setSelectedPin: vi.fn(),
            setInsertAfter: vi.fn(),
            insertAfterRef: { current: null },
            fixBusyLeg: null,
            setFixBusyLeg: vi.fn(),
            setAutoRouteDiag: vi.fn(),
            flashTraceFeedback: vi.fn(),
            // MapHub hands over the profile as it was when ⚡ was drawn.
            vessel: storeVessel(),
        };
        const { result } = renderHook(() => useAutoRouteLeg(deps));
        return { run: result.current, deps };
    }

    it('does not route until the draft is confirmed, then routes on the confirmed draft', async () => {
        render(<DraftConfirmModal />);
        const { run, deps } = autoRoute();
        act(() => run());
        await screen.findByRole('dialog', { name: 'Check your draft' });
        await settle();
        expect(mocks.route).not.toHaveBeenCalled();
        expect(deps.setFixBusyLeg).not.toHaveBeenCalled();

        // Changed in the modal: the route uses the NEW draft, not the old one.
        await changeInModal('2.1');
        await waitFor(() => expect(mocks.route).toHaveBeenCalled());
        expect(mocks.route.mock.calls[0][2]).toBeCloseTo(2.1, 10);
    });

    it('closing the modal leaves the leg alone', async () => {
        render(<DraftConfirmModal />);
        const { run, deps } = autoRoute();
        act(() => run());
        await closeModal();
        await settle();
        expect(mocks.route).not.toHaveBeenCalled();
        expect(deps.setCapturedCoords).not.toHaveBeenCalled();
    });

    it('routes straight away when the draft is already confirmed', async () => {
        seed(CONFIRMED);
        render(<DraftConfirmModal />);
        const { run, deps } = autoRoute();
        act(() => run());
        expect(deps.setFixBusyLeg).toHaveBeenCalledWith(0);
        expect(screen.queryByRole('dialog')).toBeNull();
        await waitFor(() => expect(mocks.route).toHaveBeenCalled());
        expect(mocks.route.mock.calls[0][2]).toBeCloseTo(DRAFT_FT / FEET_PER_METRE, 10);
    });
});

// ── 2. Plan Your Day (components/dayPlanner) ─────────────────────────────
describe('Plan Your Day', () => {
    // The skipper has switched Auto route (trial) on in Preferences: Plan
    // Your Day is closed without it since 2026-10-01
    // (tests/AutorouteTrialSwitch.test.tsx). seed() keeps it.
    beforeEach(() => {
        useSettingsStore.setState({
            settings: { ...useSettingsStore.getState().settings, autorouteTrialEnabled: true },
        });
    });
    afterEach(() => {
        useSettingsStore.setState({
            settings: { ...useSettingsStore.getState().settings, autorouteTrialEnabled: undefined },
        });
    });

    // RoutePlanner hands the entry the store's profile.
    function Entry() {
        const vessel = useSettingsStore((state) => state.settings.vessel ?? null);
        return <DayPlannerEntry vessel={vessel} mapboxToken="" onOpenSaved={vi.fn()} isPro onUpgrade={vi.fn()} />;
    }

    it('does not open the planner until the draft is confirmed, then opens it on the confirmed draft', async () => {
        render(
            <>
                <Entry />
                <DraftConfirmModal />
            </>,
        );
        fireEvent.click(screen.getByRole('button', { name: /Plan Your Day/ }));
        await screen.findByRole('dialog', { name: 'Check your draft' });
        await settle();
        expect(mocks.sheet).not.toHaveBeenCalled();
        await confirmInModal();
        await screen.findByRole('dialog', { name: 'Plan Your Day' });
        expect(mocks.sheet.mock.calls.at(-1)![0].vessel.draftConfirmedFt).toBe(DRAFT_FT);
    });

    it('closing the modal leaves the planner shut', async () => {
        render(
            <>
                <Entry />
                <DraftConfirmModal />
            </>,
        );
        fireEvent.click(screen.getByRole('button', { name: /Plan Your Day/ }));
        await closeModal();
        await settle();
        expect(mocks.sheet).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /Plan Your Day/ })).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens straight away when the draft is already confirmed', async () => {
        seed(CONFIRMED);
        render(
            <>
                <Entry />
                <DraftConfirmModal />
            </>,
        );
        fireEvent.click(screen.getByRole('button', { name: /Plan Your Day/ }));
        expect(screen.getByRole('button', { name: /Plan Your Day/ })).toHaveAttribute('aria-expanded', 'true');
        expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull();
        await screen.findByRole('dialog', { name: 'Plan Your Day' });
    });
});

// ── 3. Auto routing trial (components/autorouting) ───────────────────────
describe('Auto routing trial', () => {
    async function openChoice() {
        setAuthIdentityScope('trial-skipper');
        await awaitSettingsLoaded();
        // Signed in, a save goes through the fleet patch; keep it on this device.
        useSettingsStore.setState({
            patchActiveVesselProfile: (async (input: { profile: Partial<VesselProfile> }) => {
                seed({ ...storeVessel()!, ...input.profile });
            }) as never,
        });
        render(
            <>
                <RoutingModeDialog mapboxToken="token" onClose={vi.fn()} onManual={vi.fn()} />
                <DraftConfirmModal />
            </>,
        );
        const auto = screen.getByRole('button', { name: 'Auto routing' });
        await waitFor(() => expect(auto).toBeEnabled());
        return auto;
    }

    it('does not open the trial (or calculate) until the draft is confirmed, then snapshots the confirmed draft', async () => {
        seed(BOAT);
        const auto = await openChoice();
        seed(BOAT);
        fireEvent.click(auto);
        await screen.findByRole('dialog', { name: 'Check your draft' });
        await settle();
        expect(mocks.workspace).not.toHaveBeenCalled();
        await changeInModal('2.1');
        await screen.findByRole('dialog', { name: 'Autorouting trial workspace' });
        expect(mocks.workspace.mock.calls.at(-1)![0].initialDraftM).toBeCloseTo(2.1, 10);
    });

    it('closing the modal keeps the routing choice and opens nothing', async () => {
        const auto = await openChoice();
        seed(BOAT);
        fireEvent.click(auto);
        await closeModal();
        await settle();
        expect(mocks.workspace).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Choose routing mode' })).toBeInTheDocument();
    });

    it('opens straight away when the draft is already confirmed', async () => {
        const auto = await openChoice();
        seed(CONFIRMED);
        fireEvent.click(auto);
        expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull();
        await screen.findByRole('dialog', { name: 'Autorouting trial workspace' });
        expect(mocks.workspace.mock.calls.at(-1)![0].initialDraftM).toBeCloseTo(DRAFT_FT / FEET_PER_METRE, 10);
    });
});

// ── 4. Departure / tide window sweep (components/passage) ───────────────
describe('Inshore departure sweep', () => {
    const plan = {
        origin: 'Newport',
        destination: 'Tangalooma',
        routeGeoJSON: {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: [
                    [153.1, -27.2],
                    [153.3, -27.18],
                ],
            },
        },
    } as unknown as VoyagePlan;

    // The sheet loads the tide module lazily, and a re-run of that lazy import
    // (the sweep restarts once the confirmed profile lands) can reach the real
    // module under vitest. No network here: a real tide fetch fails at once,
    // which the sheet already treats as "no tide".
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('offline in tests');
            }),
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function Sweep({ onClose }: { onClose: () => void }) {
        // RoutePlanner hands the sheet the store's profile.
        const vessel = useSettingsStore((state) => state.settings.vessel);
        return <DepartureSweepSheet open onClose={onClose} voyagePlan={plan} vessel={vessel} onAccept={vi.fn()} />;
    }

    it('does not sweep until the draft is confirmed, then sweeps on the confirmed draft', async () => {
        render(
            <>
                <Sweep onClose={vi.fn()} />
                <DraftConfirmModal />
            </>,
        );
        await screen.findByRole('dialog', { name: 'Check your draft' });
        await settle();
        expect(mocks.sweep).not.toHaveBeenCalled();
        await changeInModal('2.1');
        await waitFor(() => expect(mocks.sweep).toHaveBeenCalled());
        expect(mocks.sweep.mock.calls.at(-1)![0].draftM).toBeCloseTo(2.1, 10);
        for (const [opts] of mocks.sweep.mock.calls) expect(opts.draftM).toBeCloseTo(2.1, 10);
    });

    it('closing the modal closes the sweep without running it', async () => {
        const onClose = vi.fn();
        render(
            <>
                <Sweep onClose={onClose} />
                <DraftConfirmModal />
            </>,
        );
        await closeModal();
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        await settle();
        expect(mocks.sweep).not.toHaveBeenCalled();
    });

    it('sweeps straight away when the draft is already confirmed', async () => {
        seed(CONFIRMED);
        render(
            <>
                <Sweep onClose={vi.fn()} />
                <DraftConfirmModal />
            </>,
        );
        await waitFor(() => expect(mocks.sweep).toHaveBeenCalled());
        expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull();
        expect(mocks.sweep.mock.calls[0][0].draftM).toBeCloseTo(DRAFT_FT / FEET_PER_METRE, 10);
    });

    // Round 3 (2026-09-30): a saved plan kept its route's caveats (decision
    // 8's bridges, decision 9's survey quality) but nothing showed them again.
    it('a reopened inshore plan says its route caveats again', async () => {
        seed(CONFIRMED);
        const saved = {
            ...plan,
            routeGeoJSON: {
                ...plan.routeGeoJSON,
                properties: {
                    source: 'inshore-router',
                    structuresUnknownCells: ['OC-61-10ENB5'],
                    surveyRuns: [
                        {
                            reason: 'survey-poor',
                            startSeg: 0,
                            startT: 0,
                            endSeg: 0,
                            endT: 0.5,
                            lengthM: 900,
                            catzoc: 5,
                            midLat: -27.19,
                            midLon: 153.15,
                        },
                    ],
                },
            },
        } as unknown as VoyagePlan;
        render(<DepartureSweepSheet open onClose={vi.fn()} voyagePlan={saved} vessel={CONFIRMED} onAccept={vi.fn()} />);
        const note = await screen.findByTestId('sweep-route-caveats');
        expect(note.textContent).toMatch(/Bridges and power lines not checked on this chart/);
        expect(note.textContent).toMatch(/Old or ungraded survey on 900 m of this route/);
        await settle();
    });
});

// ── 5. Settings → Preferences → Chart → "Show charted leads" ────────────
describe('Show charted leads', () => {
    async function preferences(onSave: (patch: object) => void) {
        vi.stubGlobal('__BUILD_STAMP__', '2026-09-29 00:00Z');
        const { GeneralTab } = await import('../components/settings/GeneralTab');
        function Tab() {
            const settings = useSettingsStore((state) => state.settings);
            return (
                <GeneralTab
                    settings={settings}
                    onSave={onSave}
                    onLocationSelect={vi.fn()}
                    onDetectLocation={vi.fn()}
                    onShowFactoryReset={vi.fn()}
                />
            );
        }
        render(
            <>
                <Tab />
                <DraftConfirmModal />
            </>,
        );
        return screen.getByRole('switch', { name: 'Show charted leads' });
    }

    it('does not switch on until the draft is confirmed, then switches on', async () => {
        const onSave = vi.fn();
        const toggle = await preferences(onSave);
        fireEvent.click(toggle);
        await screen.findByRole('dialog', { name: 'Check your draft' });
        expect(onSave).not.toHaveBeenCalledWith({ showChartLeads: true });
        await confirmInModal();
        expect(onSave).toHaveBeenCalledWith({ showChartLeads: true });
    });

    it('closing the modal leaves the switch off', async () => {
        const onSave = vi.fn();
        const toggle = await preferences(onSave);
        fireEvent.click(toggle);
        await closeModal();
        await settle();
        expect(onSave).not.toHaveBeenCalledWith({ showChartLeads: true });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('switches on straight away when the draft is confirmed, and off never asks', async () => {
        seed(CONFIRMED);
        const onSave = vi.fn();
        const toggle = await preferences(onSave);
        fireEvent.click(toggle);
        expect(onSave).toHaveBeenCalledWith({ showChartLeads: true });
        expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull();

        cleanup();
        seed(BOAT);
        useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, showChartLeads: true } });
        const off = vi.fn();
        fireEvent.click(await preferences(off));
        expect(off).toHaveBeenCalledWith({ showChartLeads: false });
        expect(screen.queryByRole('dialog', { name: 'Check your draft' })).toBeNull();
        useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, showChartLeads: false } });
    });
});
