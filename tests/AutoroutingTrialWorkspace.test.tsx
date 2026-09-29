import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AutoroutingTrialWorkspace } from '../components/autorouting/AutoroutingTrialWorkspace';
import { RoutingModeDialog } from '../components/autorouting/RoutingModeDialog';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { PanePortalContext } from '../context/PanePortalContext';
import { vesselDraftMetres } from '../services/units';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import { buildTrialWaypointPlan } from '../services/autoroutingDisplayWaypoints';
import { TRIAL_GRADE_COLORS, type TrialRouteReview } from '../services/autoroutingReview';

type Handler = (event?: unknown) => void;
const mocks = vi.hoisted(() => ({
    status: vi.fn(),
    calculate: vi.fn(),
    guidedFactory: vi.fn(),
    guidedCalculate: vi.fn(),
    canalCalculate: vi.fn(),
    resolveExit: vi.fn(),
    verifyExit: vi.fn(),
    review: vi.fn(),
    encLayer: vi.fn(),
    encBase: vi.fn(),
    encInventory: {
        encCellCount: 2,
        encReferenceCellCount: 0,
        encHydration: { remaining: 0, total: 0 },
        encNoCoverage: false,
    },
    settings: {} as {
        defaultLocationCoords?: { lat: number; lon: number };
        vessel?: { draft: number; draftConfirmedFt?: number; cruisingSpeed: number };
    },
    location: { lat: -27.47, lon: 153.02, source: 'initial' },
    maps: [] as Array<{
        options: Record<string, unknown>;
        handlers: Map<string, Handler>;
        source: { setData: ReturnType<typeof vi.fn> };
        loaded: boolean;
        addSource: ReturnType<typeof vi.fn>;
        addLayer: ReturnType<typeof vi.fn>;
        getSource: ReturnType<typeof vi.fn>;
        fitBounds: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        zoomIn: ReturnType<typeof vi.fn>;
        zoomOut: ReturnType<typeof vi.fn>;
        addControl: ReturnType<typeof vi.fn>;
        queryRenderedFeatures: ReturnType<typeof vi.fn>;
        flyTo: ReturnType<typeof vi.fn>;
        getCanvas: ReturnType<typeof vi.fn<() => { style: { cursor: string } }>>;
        project: ReturnType<typeof vi.fn<(coordinates: [number, number]) => { x: number; y: number }>>;
    }>,
}));
vi.mock('../services/autoroutingTrial', () => ({
    getAutoroutingTrialStatus: mocks.status,
    calculateAutoroutingTrial: mocks.calculate,
}));
vi.mock('../services/autoroutingCanalDeparture', () => ({ calculateWithCanalDeparture: mocks.canalCalculate }));
vi.mock('../services/chartGuidedAutorouting', () => ({
    createChartGuidedTrialCalculator: mocks.guidedFactory,
    CHART_GUIDANCE_TOTAL_TIMEOUT_MS: 75_000,
}));
vi.mock('../services/automaticCanalExit', () => ({
    resolveAutomaticCanalExit: mocks.resolveExit,
    VERIFIED_CANAL_EXIT_PROFILES: [],
}));
vi.mock('../services/verifyCanalExitChart', () => ({ verifyCanalExitChart: mocks.verifyExit }));
vi.mock('../services/autoroutingReview', async (original) => ({
    ...(await original<typeof import('../services/autoroutingReview')>()),
    reviewAutoroutingProposal: mocks.review,
}));
vi.mock('../components/map/useEncVectorLayer', () => ({ useEncVectorLayer: mocks.encLayer }));
vi.mock('../components/map/useEncChartInventory', () => ({ useEncChartInventory: () => mocks.encInventory }));
vi.mock('../components/map/EncAttributionChip', () => ({ EncAttributionChip: () => <div>ENC source credit</div> }));
vi.mock('../components/map/PlannerVesselLocator', () => ({
    PlannerVesselLocator: () => <button>Locate yacht</button>,
}));
vi.mock('../components/map/encDepthStyleState', () => ({ setEncMapBase: mocks.encBase }));
vi.mock('../components/map/EncVectorLayer', () => ({ setEncPlottingMode: vi.fn(), setEncPopupSuppression: vi.fn() }));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: mocks.settings }) } }));
vi.mock('../stores/LocationStore', () => ({ LocationStore: { getState: () => ({ ...mocks.location }) } }));
vi.mock('mapbox-gl', () => ({
    default: {
        Map: class {
            constructor(options: Record<string, unknown>) {
                const canvas = { style: { cursor: '' } };
                const map = {
                    options,
                    handlers: new Map<string, Handler>(),
                    loaded: false,
                    source: { setData: vi.fn() },
                    otherSources: new Map<string, { setData: ReturnType<typeof vi.fn> }>(),
                    addSource: vi.fn(),
                    addLayer: vi.fn(),
                    getSource: vi.fn(),
                    fitBounds: vi.fn(),
                    resize: vi.fn(),
                    remove: vi.fn(),
                    on: vi.fn(),
                    touchZoomRotate: { disableRotation: vi.fn() },
                    zoomIn: vi.fn(),
                    zoomOut: vi.fn(),
                    addControl: vi.fn(),
                    getStyle: vi.fn(() => ({ layers: [{ type: 'symbol', id: 'labels' }] })),
                    getLayer: vi.fn(() => true),
                    queryRenderedFeatures: vi.fn(() => []),
                    flyTo: vi.fn(),
                    getZoom: vi.fn(() => 10),
                    getCanvas: vi.fn(() => canvas),
                    project: vi.fn(([lon, lat]: [number, number]) => ({ x: lon * 100, y: -lat * 100 })),
                };
                map.on.mockImplementation((event: string, handler: Handler) => {
                    map.handlers.set(event, handler);
                    return map;
                });
                map.addSource.mockImplementation((id: string) => {
                    map.loaded = true;
                    if (id !== 'trial') map.otherSources.set(id, { setData: vi.fn() });
                });
                map.getSource.mockImplementation((id: string) =>
                    map.loaded ? (id === 'trial' ? map.source : map.otherSources.get(id)) : undefined,
                );
                mocks.maps.push(map);
                return map;
            }
        },
        LngLatBounds: class {
            extend = vi.fn();
        },
        AttributionControl: class {},
    },
}));

const route: AutoroutingTrialRoute = {
    id: 'proposal-1',
    provider: 'SevenCs',
    createdAt: '2026-09-12T00:00:00Z',
    coordinates: [
        [153.15, -27.2],
        [153.3, -27.1],
        [153.4, -27],
    ],
    warnings: ['Check all charted hazards independently.'],
};
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
async function openWorkspace(onClose = vi.fn()) {
    const view = render(
        <AutoroutingTrialWorkspace
            mapboxToken="fixture-token"
            onClose={onClose}
            initialDraftM={1.6}
            initialSpeedKts={6}
        />,
    );
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());
    act(() => mocks.maps.at(-1)!.handlers.get('load')!());
    return { ...view, onClose };
}
function fillRequest(mode: 'canal' | 'open-water' | null = 'open-water') {
    fireEvent.click(screen.getByText('Enter coordinates'));
    for (const [label, value] of [
        ['departure latitude', '-27.2'],
        ['departure longitude', '153.15'],
        ['destination latitude', '-27'],
        ['destination longitude', '153.4'],
    ]) {
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    if (mode) fireEvent.click(screen.getByRole('button', { name: mode === 'canal' ? 'Canal / marina' : 'Open water' }));
}
const calculateButton = () => screen.getByRole('button', { name: 'Calculate trial route' });
// The workspace keeps two ResizeObservers: one on the chart container (refit
// on orientation, keyboard and pane changes) and, while the tracer is folded,
// one on the folded card (refit when its status wraps onto another line).
// Tests drive each by what it observes, never by construction order.
function installResizeObservers() {
    const original = globalThis.ResizeObserver;
    type Entry = {
        callback: ResizeObserverCallback;
        targets: Element[];
        disconnect: ReturnType<typeof vi.fn<() => void>>;
    };
    const observers: Entry[] = [];
    globalThis.ResizeObserver = class {
        private readonly entry: Entry;
        constructor(callback: ResizeObserverCallback) {
            this.entry = { callback, targets: [], disconnect: vi.fn<() => void>() };
            observers.push(this.entry);
        }
        observe(target: Element) {
            this.entry.targets.push(target);
        }
        unobserve() {}
        disconnect() {
            this.entry.disconnect();
            this.entry.targets.length = 0;
        }
    } as unknown as typeof ResizeObserver;
    const isCard = (target: Element) => target.classList.contains('trial-tracer-shell');
    const live = (match: (target: Element) => boolean) => observers.filter((observer) => observer.targets.some(match));
    const fire = (match: (target: Element) => boolean) => {
        const watching = live(match);
        // A notification nobody receives would let a 'no refit' assertion
        // pass without exercising anything.
        if (!watching.length) throw new Error('No live ResizeObserver watches that element');
        for (const observer of watching) observer.callback([], {} as ResizeObserver);
    };
    return {
        resizeChart: () => fire((target) => !isCard(target)),
        resizeCard: () => fire(isCard),
        chartObservers: () => live((target) => !isCard(target)),
        cardObservers: () => live(isCard),
        restore: () => {
            globalThis.ResizeObserver = original;
        },
    };
}
async function openReview() {
    const toggle = await screen.findByRole('button', { name: /^(Expand|Collapse) tracer panel$/ });
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
    const review = screen.queryByRole('button', { name: 'Review' });
    if (review?.getAttribute('aria-pressed') === 'false') fireEvent.click(review);
    return screen.findByRole('region', { name: 'Trial proposal' });
}
async function openSetup() {
    const toggle = await screen.findByRole('button', { name: /^(Expand|Collapse) tracer panel$/ });
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
    const setup = screen.queryByRole('button', { name: 'Setup' });
    if (setup?.getAttribute('aria-pressed') === 'false') fireEvent.click(setup);
    return screen.findByRole('button', { name: 'Calculate trial route' });
}
const features = () => mocks.maps.at(-1)!.source.setData.mock.calls.at(-1)?.[0].features as GeoJSON.Feature[];
const routeLine = () =>
    (features().find((feature) => feature.geometry.type === 'LineString')!.geometry as GeoJSON.LineString).coordinates;
function sourceFeatures(id: string): GeoJSON.Feature[] {
    const source = (mocks.maps.at(-1)!.getSource as (name: string) => { setData: ReturnType<typeof vi.fn> })(id);
    return source.setData.mock.calls.at(-1)![0].features;
}
function tapChart(lon: number, lat: number) {
    act(() =>
        mocks.maps.at(-1)!.handlers.get('click')!({
            point: mocks.maps.at(-1)!.project([lon, lat]),
            lngLat: { lng: lon, lat, wrap: () => ({ lng: lon }) },
        }),
    );
}
function tapWaypoint(number: number) {
    const pin = sourceFeatures('trial-review').find(
        (feature) => feature.geometry.type === 'Point' && feature.properties?.number === number,
    );
    expect(pin?.geometry.type).toBe('Point');
    const coordinates = (pin!.geometry as GeoJSON.Point).coordinates as [number, number];
    mocks.maps.at(-1)!.queryRenderedFeatures.mockReturnValueOnce([pin]);
    tapChart(coordinates[0], coordinates[1]);
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.maps.length = 0;
    // Confirmed drafts throughout: an unconfirmed one is asked about before
    // Auto opens (tests/DraftConfirmGates.test.tsx).
    mocks.settings = { vessel: { draft: 1.6 / 0.3048, draftConfirmedFt: 1.6 / 0.3048, cruisingSpeed: 6 } };
    mocks.encInventory = {
        encCellCount: 2,
        encReferenceCellCount: 0,
        encHydration: { remaining: 0, total: 0 },
        encNoCoverage: false,
    };
    mocks.location = { lat: -27.47, lon: 153.02, source: 'initial' };
    setAuthIdentityScope('trial-fixture-account');
    mocks.status.mockResolvedValue({ enabled: true, ready: true, vesselProfile: true });
    mocks.calculate.mockResolvedValue(route);
    mocks.guidedFactory.mockReturnValue(mocks.guidedCalculate);
    mocks.guidedCalculate.mockResolvedValue(route);
    mocks.verifyExit.mockResolvedValue(true);
    mocks.resolveExit.mockReturnValue({
        status: 'manual-required',
        reason: 'No reviewed channel exit covers this departure. Choose an exit manually.',
    });
    mocks.review.mockImplementation(async (proposal: AutoroutingTrialRoute) => ({
        phase: 'complete',
        legs: proposal.coordinates.slice(1).map(() => ({
            incomplete: false,
            verdict: {
                grade: 'clear',
                issues: [],
                minDepthM: 8,
                minAt: null,
                needsTide: false,
                nudge: null,
                nudgeTo: null,
            },
        })),
    }));
});
afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('display-light');
});

describe('read-only day-plan proposal review', () => {
    async function openDayPlanReview(onReviewChange = vi.fn(), onClose = vi.fn()) {
        const view = render(
            <AutoroutingTrialWorkspace
                mapboxToken="fixture-token"
                initialDraftM={1.6}
                initialSpeedKts={6}
                reviewProposal={route}
                onReviewChange={onReviewChange}
                onClose={onClose}
            />,
        );
        await waitFor(() => expect(mocks.maps).toHaveLength(1));
        act(() => mocks.maps[0].handlers.get('load')!());
        await screen.findByRole('region', { name: 'Trial proposal' });
        return { ...view, onReviewChange, onClose };
    }

    const expectNoRouteMutationControls = () => {
        for (const name of ['Setup', 'Calculate trial route', 'Clear', 'Save as planned route'])
            expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Save planned proposal' })).not.toBeInTheDocument();
        expect(screen.queryByLabelText('departure latitude')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('destination longitude')).not.toBeInTheDocument();
    };

    it('opens the supplied geometry directly with no setup, calculation or standalone save path', async () => {
        const original = JSON.stringify(route);
        const { onClose } = await openDayPlanReview();
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1));
        const reviewedProposal = mocks.review.mock.calls[0][0] as AutoroutingTrialRoute;
        expect(reviewedProposal).not.toBe(route);
        expect(reviewedProposal).toEqual(route);
        expect(routeLine()).toEqual(route.coordinates);
        expectNoRouteMutationControls();
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(mocks.guidedCalculate).not.toHaveBeenCalled();
        expect(mocks.canalCalculate).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Whole route' }));
        expect(mocks.maps[0].fitBounds).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Expand tracer panel' }));
        fireEvent.click(screen.getByRole('button', { name: 'Back to day plan' }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(JSON.stringify(route)).toBe(original);
    });

    it('locks even an interior waypoint and ignores chart taps that would otherwise edit geometry', async () => {
        await openDayPlanReview();
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1));
        tapWaypoint(2);
        const editor = screen.getByRole('region', { name: 'Waypoint 2' });
        const move = within(editor).getByRole('button', { name: 'Move' });
        expect(move).toBeDisabled();
        expect(within(editor).getByText(/Itinerary preview only/)).toBeVisible();
        fireEvent.click(move);
        tapChart(154, -28);
        expect(screen.queryByRole('button', { name: 'Confirm move' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Undo last move/ })).not.toBeInTheDocument();
        expect(routeLine()).toEqual(route.coordinates);
        expect(mocks.review).toHaveBeenCalledTimes(1);
        expect(mocks.calculate).not.toHaveBeenCalled();
        expectNoRouteMutationControls();
    });

    it('delivers checking and complete review evidence back to the owning planner', async () => {
        const pending = deferred<TrialRouteReview>();
        mocks.review.mockImplementation(() => pending.promise);
        const { onReviewChange } = await openDayPlanReview();
        await waitFor(() =>
            expect(onReviewChange).toHaveBeenCalledWith(expect.objectContaining({ phase: 'checking' })),
        );
        const verdict = {
            grade: 'danger' as const,
            issues: [{ severity: 'danger' as const, message: 'Charted obstruction' }],
            minDepthM: 0.5,
            minAt: null,
            needsTide: false,
            nudge: null,
            nudgeTo: null,
        };
        await act(async () =>
            pending.resolve({
                phase: 'complete',
                legs: route.coordinates.slice(1).map(() => ({ incomplete: false, verdict })),
            }),
        );
        await waitFor(() =>
            expect(onReviewChange).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    phase: 'complete',
                    basis: expect.objectContaining({ proposalId: route.id, draftM: 1.6 }),
                    legs: expect.arrayContaining([expect.objectContaining({ verdict })]),
                }),
            ),
        );
        expect(screen.getAllByText(/Danger reported/).length).toBeGreaterThan(0);
        expectNoRouteMutationControls();
    });

    it('aborts pending checks and prevents late review delivery after unmount', async () => {
        const pending = deferred<TrialRouteReview>();
        mocks.review.mockReturnValue(pending.promise);
        const { onReviewChange, unmount } = await openDayPlanReview();
        const reviewSignal = mocks.review.mock.calls[0][2] as AbortSignal;
        await waitFor(() =>
            expect(onReviewChange).toHaveBeenCalledWith(expect.objectContaining({ phase: 'checking' })),
        );
        const count = onReviewChange.mock.calls.length;
        unmount();
        expect(reviewSignal.aborted).toBe(true);
        await act(async () => pending.resolve({ phase: 'complete', legs: [] }));
        expect(onReviewChange).toHaveBeenCalledTimes(count);
        expect(mocks.maps[0].remove).toHaveBeenCalledOnce();
    });

    it('reports an unsuccessful local review without offering calculation or save', async () => {
        mocks.review.mockRejectedValue(new Error('Chart checks unavailable'));
        const { onReviewChange } = await openDayPlanReview();
        await waitFor(() =>
            expect(onReviewChange).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' })),
        );
        expectNoRouteMutationControls();
        expect(screen.getByRole('button', { name: 'Back to day plan' })).toBeEnabled();
    });

    it('preserves setup, calculation, planned-save and interior waypoint edits in normal mode', async () => {
        await openWorkspace();
        expect(calculateButton()).toBeVisible();
        expect(screen.getByRole('button', { name: 'Clear' })).toBeVisible();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        expect(screen.getByRole('button', { name: 'Setup' })).toBeVisible();
        expect(screen.getByRole('region', { name: 'Save planned proposal' })).toBeVisible();
        tapWaypoint(2);
        expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: 'Back to day plan' })).not.toBeInTheDocument();
        expect(mocks.calculate).toHaveBeenCalledOnce();
    });
});

describe('isolated autorouting trial workspace', () => {
    it.each([undefined, false])(
        'keeps the original provider path without advertised guidance: %s',
        async (capability) => {
            mocks.status.mockResolvedValue({ enabled: true, ready: true, channelGuidance: capability });
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            await openReview();
            expect(mocks.calculate).toHaveBeenCalledTimes(1);
            expect(mocks.guidedFactory).not.toHaveBeenCalled();
            expect(mocks.guidedCalculate).not.toHaveBeenCalled();
        },
    );
    it('uses the advertised guidance calculator and reviews the complete returned open-water proposal', async () => {
        mocks.status.mockResolvedValue({ enabled: true, ready: true, channelGuidance: true });
        const guided = {
            ...route,
            id: 'guided-result',
            coordinates: [...route.coordinates, [153.5, -26.9] as [number, number]],
        };
        mocks.guidedCalculate.mockResolvedValue(guided);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        expect(mocks.guidedFactory).toHaveBeenCalledWith({
            channelGuidance: true,
            onProgress: expect.any(Function),
            deadlineAtMs: expect.any(Number),
        });
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(mocks.guidedCalculate).toHaveBeenCalledWith(
            { departure: { lat: -27.2, lon: 153.15 }, destination: { lat: -27, lon: 153.4 }, draftM: 1.6, speedKts: 6 },
            expect.any(AbortSignal),
        );
        await waitFor(() => expect(mocks.review.mock.calls.at(-1)?.[0]).toBe(guided));
    });
    it('injects guidance into the canal continuation and reviews the entire joined proposal', async () => {
        mocks.status.mockResolvedValue({ enabled: true, ready: true, channelGuidance: true });
        const joined = { ...route, canalDeparture: { handoverIndex: 1 } };
        mocks.canalCalculate.mockResolvedValue(joined);
        await openWorkspace();
        fillRequest('canal');
        fireEvent.change(screen.getByLabelText('canal exit latitude'), { target: { value: '-27.19' } });
        fireEvent.change(screen.getByLabelText('canal exit longitude'), { target: { value: '153.15' } });
        fireEvent.click(calculateButton());
        await openReview();
        expect(mocks.canalCalculate.mock.calls[0][6]).toBe(mocks.guidedCalculate);
        expect(mocks.guidedCalculate).not.toHaveBeenCalled();
        expect(mocks.calculate).not.toHaveBeenCalled();
        await waitFor(() => expect(mocks.review.mock.calls.at(-1)?.[0]).toBe(joined));
    });
    const resolvedExit = () => ({
        status: 'resolved' as const,
        profileId: 'synthetic-channel',
        label: 'Fixture channel',
        sourceRevision: 'synthetic-review-1',
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
        gateCentres: [
            { lat: -27.195, lon: 153.15 },
            { lat: -27.19, lon: 153.15 },
        ],
        outboundBearingDeg: 0,
        exit: { lat: -27.19, lon: 153.15 },
    });
    it('selects a verified exit without a third pin and passes every pinned centre to the local connector', async () => {
        const resolved = resolvedExit();
        mocks.resolveExit.mockReturnValue(resolved);
        mocks.canalCalculate.mockResolvedValue({ ...route, canalDeparture: { handoverIndex: 1 } });
        await openWorkspace();
        fillRequest('canal');
        expect(screen.getByRole('region', { name: 'Automatic channel exit' })).toBeVisible();
        expect(screen.queryByLabelText('canal exit latitude')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^destination\s/i })).toHaveAttribute('aria-pressed', 'true');
        expect(features().find((f) => f.properties?.endpoint === 'canal exit')?.geometry).toEqual({
            type: 'Point',
            coordinates: [153.15, -27.19],
        });
        await waitFor(() => expect(calculateButton()).toBeEnabled());
        fireEvent.click(calculateButton());
        await openReview();
        expect(mocks.canalCalculate.mock.calls[0][5]).toEqual(resolved);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });
    it('auto advances chart taps from departure directly to destination for a verified channel', async () => {
        mocks.resolveExit.mockReturnValue(resolvedExit());
        await openWorkspace();
        fireEvent.click(screen.getByRole('button', { name: 'Canal / marina' }));
        await act(async () => {
            tapChart(153.15, -27.2);
        });
        expect(screen.getByRole('button', { name: /^destination\s/i })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByRole('button', { name: /^canal exit\s/i })).not.toBeInTheDocument();
    });
    it('allows a manual override, keeps it for destination edits, and can return to automatic', async () => {
        mocks.resolveExit.mockReturnValue(resolvedExit());
        await openWorkspace();
        fillRequest('canal');
        fireEvent.click(screen.getByRole('button', { name: 'Choose manually' }));
        expect(calculateButton()).toBeDisabled();
        fireEvent.change(screen.getByLabelText('canal exit latitude'), { target: { value: '-27.18' } });
        fireEvent.change(screen.getByLabelText('canal exit longitude'), { target: { value: '153.16' } });
        fireEvent.change(screen.getByLabelText('destination longitude'), { target: { value: '153.5' } });
        expect(screen.getByLabelText('canal exit latitude')).toHaveValue(-27.18);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Use automatic channel exit' }));
        });
        expect(screen.getByRole('region', { name: 'Automatic channel exit' })).toBeVisible();
        expect(screen.queryByLabelText('canal exit latitude')).not.toBeInTheDocument();
    });
    it('clears a manual exit even on an incomplete departure edit and cancels the pending route', async () => {
        await openWorkspace();
        fillRequest('canal');
        fireEvent.change(screen.getByLabelText('canal exit latitude'), { target: { value: '-27.19' } });
        fireEvent.change(screen.getByLabelText('canal exit longitude'), { target: { value: '153.15' } });
        const pendingRoute = deferred<AutoroutingTrialRoute>();
        mocks.canalCalculate.mockReturnValueOnce(pendingRoute.promise);
        fireEvent.click(calculateButton());
        await waitFor(() => expect(mocks.canalCalculate).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('departure latitude'), { target: { value: '' } });
        expect(mocks.canalCalculate.mock.calls[0][3].aborted).toBe(true);
        expect(screen.getByLabelText('canal exit latitude')).toHaveValue(null);
        expect(calculateButton()).toBeDisabled();
        await act(async () => pendingRoute.resolve(route));
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
    });
    it('drops the automatic exit when departure leaves its reviewed area, without sending directly to SevenCs', async () => {
        mocks.resolveExit.mockImplementation((start) =>
            start.lat === -27.2 ? resolvedExit() : { status: 'manual-required', reason: 'No reviewed channel here.' },
        );
        await openWorkspace();
        fillRequest('canal');
        await waitFor(() => expect(calculateButton()).toBeEnabled());
        fireEvent.change(screen.getByLabelText('departure latitude'), { target: { value: '-27.3' } });
        expect(screen.queryByRole('region', { name: 'Automatic channel exit' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('canal exit latitude')).toHaveValue(null);
        expect(calculateButton()).toBeDisabled();
        expect(features().some((f) => f.properties?.endpoint === 'canal exit')).toBe(false);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });
    it('rechecks the reviewed exit at Calculate and refuses an expired review instead of falling back', async () => {
        mocks.resolveExit.mockReturnValue(resolvedExit());
        await openWorkspace();
        fillRequest('canal');
        await waitFor(() => expect(calculateButton()).toBeEnabled());
        mocks.resolveExit.mockReturnValue({ status: 'manual-required', reason: 'Channel review expired.' });
        fireEvent.click(calculateButton());
        expect(await screen.findByRole('alert')).toHaveTextContent('Automatic channel exit needs review');
        expect(mocks.canalCalculate).not.toHaveBeenCalled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });
    it('does not let a hidden Canal Exit target turn automatic mode into manual after coordinate entry', async () => {
        await openWorkspace();
        fillRequest('canal');
        expect(screen.getByRole('button', { name: /^canal exit\s/i })).toHaveAttribute('aria-pressed', 'true');
        mocks.resolveExit.mockReturnValue(resolvedExit());
        fireEvent.change(screen.getByLabelText('departure latitude'), { target: { value: '-27.201' } });
        await waitFor(() =>
            expect(screen.getByRole('button', { name: /^destination\s/i })).toHaveAttribute('aria-pressed', 'true'),
        );
        tapChart(153.4, -27.01);
        expect(screen.getByLabelText('destination latitude')).toHaveValue(-27.01);
        expect(screen.queryByLabelText('canal exit latitude')).not.toBeInTheDocument();
    });
    it('requires the current installed chart to match the reviewed markers and falls back to an empty manual exit on failure', async () => {
        mocks.resolveExit.mockReturnValue(resolvedExit());
        mocks.verifyExit.mockResolvedValue(false);
        await openWorkspace();
        fillRequest('canal');
        expect(await screen.findByRole('alert')).toHaveTextContent('installed chart could not verify');
        expect(screen.getByLabelText('canal exit latitude')).toHaveValue(null);
        expect(calculateButton()).toBeDisabled();
        expect(mocks.canalCalculate).not.toHaveBeenCalled();
        expect(mocks.calculate).not.toHaveBeenCalled();
        mocks.verifyExit.mockResolvedValue(true);
        fireEvent.click(screen.getByRole('button', { name: 'Use automatic channel exit' }));
        await waitFor(() => expect(calculateButton()).toBeEnabled());
    });
    it('ignores a late source verification after the departure changes out of coverage', async () => {
        const proof = deferred<boolean>();
        mocks.resolveExit.mockImplementation((start) =>
            start.lat === -27.2 ? resolvedExit() : { status: 'manual-required', reason: 'Outside reviewed area.' },
        );
        mocks.verifyExit.mockReturnValue(proof.promise);
        await openWorkspace();
        fillRequest('canal');
        expect(calculateButton()).toBeDisabled();
        await waitFor(() => expect(mocks.verifyExit).toHaveBeenCalled());
        const signal = mocks.verifyExit.mock.calls[0][1];
        fireEvent.change(screen.getByLabelText('departure latitude'), { target: { value: '-27.3' } });
        expect(signal.aborted).toBe(true);
        await act(async () => proof.resolve(true));
        expect(screen.queryByRole('region', { name: 'Automatic channel exit' })).not.toBeInTheDocument();
        expect(calculateButton()).toBeDisabled();
    });
    it('refuses a result if the exit review expired while the local/provider calculation was pending', async () => {
        mocks.resolveExit.mockReturnValue(resolvedExit());
        const pendingRoute = deferred<AutoroutingTrialRoute>();
        mocks.canalCalculate.mockReturnValueOnce(pendingRoute.promise);
        await openWorkspace();
        fillRequest('canal');
        await waitFor(() => expect(calculateButton()).toBeEnabled());
        fireEvent.click(calculateButton());
        await waitFor(() => expect(mocks.canalCalculate).toHaveBeenCalled());
        mocks.resolveExit.mockReturnValue({ status: 'manual-required', reason: 'Expired.' });
        await act(async () => pendingRoute.resolve(route));
        expect(await screen.findByRole('alert')).toHaveTextContent('review changed during calculation');
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
    });
    it('requires an explicit departure mode even when both coordinates are set; neither path is a default', async () => {
        await openWorkspace();
        fillRequest(null);
        for (const name of ['Canal / marina', 'Open water'])
            expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
        expect(calculateButton()).toBeDisabled();
        fireEvent.click(calculateButton());
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(mocks.canalCalculate).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Open water' }));
        expect(calculateButton()).toBeEnabled();
        fireEvent.click(calculateButton());
        await openReview();
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
        expect(mocks.canalCalculate).not.toHaveBeenCalled();
    });
    it('makes the canal exit explicit and uses the local connector, without changing normal routing', async () => {
        await openWorkspace();
        fillRequest('canal');
        expect(calculateButton()).toBeDisabled();
        fireEvent.change(screen.getByLabelText('canal exit latitude'), { target: { value: '-27.19' } });
        fireEvent.change(screen.getByLabelText('canal exit longitude'), { target: { value: '153.15' } });
        mocks.canalCalculate.mockResolvedValue({ ...route, canalDeparture: { handoverIndex: 1 } });
        fireEvent.click(calculateButton());
        await openReview();
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(mocks.canalCalculate).toHaveBeenCalledWith(
            { departure: { lat: -27.2, lon: 153.15 }, destination: { lat: -27, lon: 153.4 }, draftM: 1.6, speedKts: 6 },
            { lat: -27.19, lon: 153.15 },
            'fixture-token',
            expect.any(AbortSignal),
            expect.any(Function),
            undefined,
            mocks.calculate,
        );
        await openSetup();
        fireEvent.click(screen.getByRole('button', { name: /^Clear$/ }));
        for (const name of ['Canal / marina', 'Open water'])
            expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.queryByText(/Thalassa canal \+ SevenCs proposal/)).not.toBeInTheDocument();
    });
    it('guides chart taps through departure, canal exit and destination without resetting pins on a repeated mode tap', async () => {
        await openWorkspace();
        fireEvent.click(screen.getByRole('button', { name: 'Canal / marina' }));
        expect(screen.getByRole('button', { name: /^departure\s/i })).toHaveAttribute('aria-pressed', 'true');
        const tap = (lat: number, lon: number) => tapChart(lon, lat);
        tap(-27.2, 153.15);
        expect(screen.getByRole('button', { name: /^canal exit\s/i })).toHaveAttribute('aria-pressed', 'true');
        tap(-27.19, 153.15);
        expect(screen.getByRole('button', { name: /^destination\s/i })).toHaveAttribute('aria-pressed', 'true');
        tap(-27, 153.4);
        expect(calculateButton()).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Canal / marina' }));
        expect(screen.getByLabelText('canal exit latitude')).toHaveValue(-27.19);
        expect(calculateButton()).toBeEnabled();
    });
    it('does not fall back to ordinary SevenCs when the chosen canal calculation fails', async () => {
        await openWorkspace();
        fillRequest('canal');
        fireEvent.change(screen.getByLabelText('canal exit latitude'), { target: { value: '-27.19' } });
        fireEvent.change(screen.getByLabelText('canal exit longitude'), { target: { value: '153.15' } });
        mocks.canalCalculate.mockRejectedValueOnce(new Error('No connected canal exit found.'));
        fireEvent.click(calculateButton());
        expect(await screen.findByRole('alert')).toHaveTextContent('No connected canal exit found.');
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(features().every((feature) => feature.geometry.type === 'Point')).toBe(true);
    });
    it('explains the missing departure when destination and canal exit are filled, as in the reported screenshot', async () => {
        await openWorkspace();
        fireEvent.click(screen.getByRole('button', { name: 'Canal / marina' }));
        for (const [label, value] of [
            ['destination latitude', '-27.448242'],
            ['destination longitude', '153.088345'],
            ['canal exit latitude', '-27.214517'],
            ['canal exit longitude', '153.089774'],
        ])
            fireEvent.change(screen.getByLabelText(label), { target: { value } });
        expect(
            screen.getByText('Set departure on the chart or enter its coordinates before calculating.'),
        ).toBeVisible();
        expect(calculateButton()).toBeDisabled();
        expect(screen.getByRole('button', { name: /^departure\s/i })).toHaveAttribute('aria-pressed', 'true');
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(mocks.canalCalculate).not.toHaveBeenCalled();
    });
    it('switching departure mode aborts a pending canal result, clears its exit, and preserves chosen endpoints', async () => {
        await openWorkspace();
        fillRequest('canal');
        fireEvent.change(screen.getByLabelText('canal exit latitude'), { target: { value: '-27.19' } });
        fireEvent.change(screen.getByLabelText('canal exit longitude'), { target: { value: '153.15' } });
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.canalCalculate.mockReturnValueOnce(pending.promise);
        fireEvent.click(calculateButton());
        await waitFor(() => expect(mocks.canalCalculate).toHaveBeenCalled());
        const signal = mocks.canalCalculate.mock.calls[0][3] as AbortSignal;
        fireEvent.click(screen.getByRole('button', { name: 'Open water' }));
        expect(signal.aborted).toBe(true);
        await act(async () => pending.resolve({ ...route, canalDeparture: { handoverIndex: 1 } }));
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.2);
        expect(screen.getByLabelText('destination longitude')).toHaveValue(153.4);
        fireEvent.click(screen.getByRole('button', { name: 'Canal / marina' }));
        expect(screen.getByLabelText('canal exit latitude')).toHaveValue(null);
        expect(calculateButton()).toBeDisabled();
    });
    it('shows numbered waypoints, paints per-leg checks, and does not replace the proposal on a background tap', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        expect(screen.getByRole('list', { name: 'Proposal waypoints' }).children).toHaveLength(3);
        await waitFor(() =>
            expect(screen.getByText('0 danger · 0 caution · 0 incomplete · 2/2 checked segments')).toBeVisible(),
        );
        const map = mocks.maps[0];
        const source = (map.getSource as (id: string) => { setData: ReturnType<typeof vi.fn> })('trial-review');
        const data = source.setData.mock.calls.at(-1)![0] as GeoJSON.FeatureCollection;
        expect(data.features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties?.number)).toEqual([
            1, 2, 3,
        ]);
        tapChart(154, -26);
        expect(screen.getByRole('region', { name: 'Trial proposal' })).toBeVisible();
        await openSetup();
        fireEvent.click(screen.getByRole('button', { name: /^Clear$/ }));
        expect(screen.queryByRole('region', { name: 'Route chart checks' })).not.toBeInTheDocument();
        expect(source.setData.mock.calls.at(-1)![0].features).toEqual([]);
    });
    it('selects a map pin, previews a candidate and cancels without changing geometry, checks or the zoomed camera', async () => {
        const original = structuredClone(route);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1));
        tapWaypoint(2);
        const editor = screen.getByRole('region', { name: 'Waypoint 2' });
        expect(within(editor).getByRole('button', { name: 'Move' })).toBeEnabled();
        fireEvent.click(within(editor).getByRole('button', { name: 'Move' }));
        expect(within(editor).getByRole('button', { name: 'Confirm move' })).toBeDisabled();
        const map = mocks.maps[0];
        expect(map.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: route.coordinates[1], zoom: 15 }));
        map.fitBounds.mockClear();
        map.flyTo.mockClear();
        tapChart(153.31, -27.11);
        expect(within(editor).getByText('New position')).toBeVisible();
        expect(within(editor).getByRole('button', { name: 'Confirm move' })).toBeEnabled();
        expect(routeLine()).toEqual(original.coordinates);
        expect(
            sourceFeatures('trial-edit-preview').find((feature) => feature.geometry.type === 'LineString')?.geometry,
        ).toEqual({
            type: 'LineString',
            coordinates: [original.coordinates[0], [153.31, -27.11], original.coordinates[2]],
        });
        expect(map.getCanvas().style.cursor).toBe('crosshair');
        fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
        expect(within(editor).getByRole('button', { name: 'Move' })).toBeEnabled();
        expect(sourceFeatures('trial-edit-preview')).toEqual([]);
        expect(map.getCanvas().style.cursor).toBe('');
        expect(routeLine()).toEqual(original.coordinates);
        expect(route).toEqual(original);
        expect(mocks.review).toHaveBeenCalledTimes(1);
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
        expect(map.fitBounds).not.toHaveBeenCalled();
        expect(map.flyTo).not.toHaveBeenCalled();
        expect(mocks.maps).toHaveLength(1);
    });
    it('uses a 44 px query and nearest projected pin rather than rendered feature order', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        const pins = sourceFeatures('trial-review').filter((feature) => feature.geometry.type === 'Point');
        const map = mocks.maps[0];
        map.queryRenderedFeatures.mockReturnValueOnce([
            {
                type: 'Feature',
                properties: { number: 1 },
                geometry: { type: 'LineString', coordinates: route.coordinates },
            },
            pins[2],
            pins[1],
            pins[0],
        ]);
        const point = map.project([153.32, -27.09]);
        tapChart(153.32, -27.09);
        expect(screen.getByRole('region', { name: 'Waypoint 2' })).toBeVisible();
        expect(map.queryRenderedFeatures).toHaveBeenLastCalledWith(
            [
                [point.x - 22, point.y - 22],
                [point.x + 22, point.y + 22],
            ],
            { layers: ['trial-waypoints'] },
        );
        expect(routeLine()).toEqual(route.coordinates);
        expect(mocks.review).toHaveBeenCalledTimes(1);
    });

    it('switches Setup and Review without editing endpoints, discarding the proposal or recalculating', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        const originalLine = structuredClone(routeLine());
        expect(screen.getByRole('button', { name: 'Review' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.queryByRole('button', { name: 'Calculate trial route' })).not.toBeInTheDocument();
        expect(screen.queryByLabelText('departure latitude')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
        expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Review' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.2);
        expect(screen.getByLabelText('departure longitude')).toHaveValue(153.15);
        expect(screen.getByLabelText('destination latitude')).toHaveValue(-27);
        expect(screen.getByLabelText('destination longitude')).toHaveValue(153.4);
        expect(calculateButton()).toBeEnabled();
        expect(screen.queryByRole('region', { name: 'Route chart checks' })).not.toBeInTheDocument();
        tapChart(154, -26); // Merely opening Setup must not arm endpoint replacement.
        expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.2);
        expect(screen.getByLabelText('destination longitude')).toHaveValue(153.4);
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(screen.getByRole('region', { name: 'Route chart checks' })).toBeVisible();
        expect(routeLine()).toEqual(originalLine);
        expect(mocks.review).toHaveBeenCalledTimes(1);
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
        expect(mocks.maps).toHaveLength(1);
    });

    it('leaves armed endpoint placement when returning to Review so chart taps cannot overwrite the departure', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        await openSetup();
        fireEvent.click(screen.getByRole('button', { name: /^departure /i }));
        expect(screen.getByRole('button', { name: 'Expand tracer panel' })).toBeVisible();
        await openReview();
        tapChart(154, -26);
        expect(routeLine()).toEqual(route.coordinates);
        expect(screen.getByRole('region', { name: 'Trial proposal' })).toBeVisible();
        tapWaypoint(2);
        expect(screen.getByRole('region', { name: 'Waypoint 2' })).toBeVisible();
        await openSetup();
        expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.2);
        expect(screen.getByLabelText('departure longitude')).toHaveValue(153.15);
        expect(screen.getByLabelText('destination latitude')).toHaveValue(-27);
        expect(screen.getByLabelText('destination longitude')).toHaveValue(153.4);
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
        expect(mocks.review).toHaveBeenCalledTimes(1);
    });

    it('preserves the same proposal save form and acknowledgement across Setup and Review', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        const save = screen.getByRole('button', { name: 'Save as planned route' });
        await waitFor(() => expect(save).toBeEnabled());
        fireEvent.click(save);
        fireEvent.change(screen.getByLabelText('Planned route name'), { target: { value: 'Newport afternoon' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the warnings/ }));
        expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
        expect(screen.getByLabelText('Planned route name')).not.toBeVisible();
        expect(screen.queryByRole('button', { name: 'Save new planned route' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(screen.getByLabelText('Planned route name')).toBeVisible();
        expect(screen.getByLabelText('Planned route name')).toHaveValue('Newport afternoon');
        expect(screen.getByRole('checkbox', { name: /I reviewed the warnings/ })).toBeChecked();
        expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeEnabled();
        expect(routeLine()).toEqual(route.coordinates);
        expect(mocks.review).toHaveBeenCalledTimes(1);
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
    });

    it('undoes the first move to the exact original proposal but requires fresh local checks before saving', async () => {
        const original = structuredClone(route);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeEnabled());
        const originalReview = (await mocks.review.mock.results[0].value) as TrialRouteReview;
        tapWaypoint(2);
        fireEvent.click(screen.getByRole('button', { name: 'Move' }));
        tapChart(153.31, -27.11);
        fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(2));
        await openReview();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
        const editedSignal = mocks.review.mock.calls[1][2] as AbortSignal;
        const pending = deferred<TrialRouteReview>();
        mocks.review.mockReturnValueOnce(pending.promise);
        mocks.maps[0].fitBounds.mockClear();
        fireEvent.click(screen.getByRole('button', { name: /Undo last move$/ }));
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(3));
        const restored = mocks.review.mock.calls[2][0] as AutoroutingTrialRoute;
        expect(restored).toEqual(original);
        expect(restored.localEdit).toBeUndefined();
        expect(restored.createdAt).toBe(original.createdAt);
        expect(routeLine()).toEqual(original.coordinates);
        expect(editedSignal.aborted).toBe(true);
        expect(screen.getByText('Checking 0/2 detailed route segments…')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
        expect(screen.queryByRole('button', { name: /Undo last move$/ })).not.toBeInTheDocument();
        expect(mocks.maps[0].fitBounds).not.toHaveBeenCalled();
        await act(async () => pending.resolve(originalReview));
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeEnabled();
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
    });

    it('keeps only one undo checkpoint: undoing a second move retains the first edit and its save block', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        for (const [lon, lat] of [
            [153.31, -27.11],
            [153.32, -27.12],
        ]) {
            tapWaypoint(2);
            fireEvent.click(screen.getByRole('button', { name: 'Move' }));
            tapChart(lon, lat);
            fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
        }
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(3));
        const firstEdit = mocks.review.mock.calls[1][0] as AutoroutingTrialRoute;
        expect((mocks.review.mock.calls[2][0] as AutoroutingTrialRoute).localEdit?.revision).toBe(2);
        await openReview();
        fireEvent.click(screen.getByRole('button', { name: /Undo last move$/ }));
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(4));
        expect(mocks.review.mock.calls[3][0]).toBe(firstEdit);
        expect(routeLine()).toEqual(firstEdit.coordinates);
        expect(firstEdit.localEdit?.revision).toBe(1);
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
        expect(screen.queryByRole('button', { name: /Undo last move$/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Redo/ })).not.toBeInTheDocument();
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
    });

    it('keeps the selected pin close-up, then Show whole route clears its focus and frames the full route', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        tapWaypoint(2);
        fireEvent.click(screen.getByRole('button', { name: 'Show on chart' }));
        const map = mocks.maps[0];
        expect(map.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: route.coordinates[1], zoom: 15 }));
        const focus = (map.getSource as (id: string) => { setData: ReturnType<typeof vi.fn> })('trial-focus');
        expect(focus.setData.mock.calls.at(-1)?.[0].geometry).toEqual({
            type: 'Point',
            coordinates: route.coordinates[1],
        });
        map.fitBounds.mockClear();
        await openReview();
        expect(map.fitBounds).not.toHaveBeenCalled();
        fireEvent.click(screen.getAllByRole('button', { name: 'Show whole route' })[0]);
        expect(screen.queryByRole('button', { name: 'Close waypoint editor' })).not.toBeInTheDocument();
        expect(map.fitBounds).toHaveBeenCalled();
        const bounds = map.fitBounds.mock.calls.at(-1)![0];
        expect(bounds.extend.mock.calls.map(([coordinates]: [[number, number]]) => coordinates)).toEqual(
            route.coordinates,
        );
        expect(sourceFeatures('trial-focus')).toEqual([]);
        expect(sourceFeatures('trial-provider-hazard')).toEqual([]);
        expect(routeLine()).toEqual(route.coordinates);
        expect(mocks.review).toHaveBeenCalledTimes(1);
    });

    it.each(['dragstart', 'zoomstart', 'movestart', 'boxzoomstart'])(
        'keeps a user %s viewport through panel folds, chart warnings and resize',
        async (eventName) => {
            const observers = installResizeObservers();
            try {
                await openWorkspace();
                fillRequest();
                fireEvent.click(calculateButton());
                await openReview();
                const map = mocks.maps[0];
                act(() => map.handlers.get(eventName)!({ originalEvent: { type: eventName } }));
                map.fitBounds.mockClear();
                fireEvent.click(screen.getByRole('button', { name: 'Collapse tracer panel' }));
                act(() => map.handlers.get('error')!());
                act(() => observers.resizeChart());
                expect(map.resize).toHaveBeenCalled();
                expect(map.fitBounds).not.toHaveBeenCalled();
                await openReview();
                expect(map.fitBounds).not.toHaveBeenCalled();
                fireEvent.click(
                    within(screen.getByRole('region', { name: 'Autorouting controls' })).getByRole('button', {
                        name: 'Show whole route',
                    }),
                );
                expect(map.fitBounds).toHaveBeenCalled();
                expect(routeLine()).toEqual(route.coordinates);
            } finally {
                cleanup();
                observers.restore();
            }
        },
    );

    it('confirms one full-path vertex edit, discards old review colours, retains historical provider danger and blocks saving after a fresh review', async () => {
        const original: AutoroutingTrialRoute = {
            ...route,
            coordinates: Array.from({ length: 1000 }, (_, index) => [
                153 + index * 0.0001,
                -27 + (index === 500 ? 0.01 : 0),
            ]),
            providerCheck: {
                status: 'unsafe',
                findings: [{ featureIndex: 4, severity: 'danger', message: 'Original reported obstruction' }],
            },
            source: { rtz: '<unchanged/>', geoJson: '{"original":true}' },
        };
        const snapshot = structuredClone(original);
        mocks.calculate.mockResolvedValue(original);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        await waitFor(() => expect(screen.getByText(/999\/999 checked segments/)).toBeVisible());
        const firstReview = (await mocks.review.mock.results[0].value) as TrialRouteReview;
        const originalSignal = mocks.review.mock.calls[0][2] as AbortSignal;
        const oldProgress = mocks.review.mock.calls[0][3] as (result: TrialRouteReview) => void;
        const pending = deferred<TrialRouteReview>();
        mocks.review.mockReturnValueOnce(pending.promise);
        const displayIndex = buildTrialWaypointPlan(original.coordinates).waypoints.findIndex(
            (pin) => pin.pathIndex === 500,
        );
        expect(displayIndex).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: `Select waypoint ${displayIndex + 1}` }));
        fireEvent.click(screen.getByRole('button', { name: 'Move' }));
        const map = mocks.maps[0];
        map.fitBounds.mockClear();
        map.flyTo.mockClear();
        tapChart(153.0501, -26.989);
        fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(2));
        const edited = mocks.review.mock.calls[1][0] as AutoroutingTrialRoute;
        expect(edited).not.toBe(original);
        expect(edited.coordinates).toEqual([
            ...snapshot.coordinates.slice(0, 500),
            [153.0501, -26.989],
            ...snapshot.coordinates.slice(501),
        ]);
        expect(routeLine()).toEqual(edited.coordinates);
        expect(original).toEqual(snapshot);
        expect(edited.providerCheck).toBeUndefined();
        expect(edited.localEdit?.originalProposal.providerCheck).toEqual(snapshot.providerCheck);
        expect(originalSignal.aborted).toBe(true);
        expect(
            sourceFeatures('trial-review')
                .filter((feature) => feature.geometry.type === 'LineString')
                .every((feature) => feature.properties?.color === TRIAL_GRADE_COLORS.unchecked),
        ).toBe(true);
        expect(sourceFeatures('trial-edit-preview')).toEqual([]);
        expect(map.fitBounds).not.toHaveBeenCalled();
        expect(map.flyTo).not.toHaveBeenCalled();
        await openReview();
        expect(screen.getByText('Checking 0/999 detailed route segments…')).toBeVisible();
        expect(screen.getByText('Original SevenCs report · before waypoint edits')).toBeVisible();
        expect(screen.getByText('Original reported obstruction')).toBeVisible();
        expect(screen.getByText('Original proposal notices (historical):')).toBeVisible();
        expect(screen.getByText(/original provider and canal checks no longer apply/)).toBeVisible();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
        // Late progress from the previous check cannot repaint the edited route.
        act(() => oldProgress(firstReview));
        expect(screen.getByText('Checking 0/999 detailed route segments…')).toBeVisible();
        await act(async () => pending.resolve(firstReview));
        expect(screen.getByText(/999\/999 checked segments/)).toBeVisible();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
        expect(screen.getByText(/locally edited trial has not been rechecked by SevenCs/)).toBeVisible();
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
        expect(mocks.maps).toHaveLength(1);
    });

    it('inserts a moved fractional display pin while preserving both neighbouring detailed vertices', async () => {
        const original: AutoroutingTrialRoute = {
            ...route,
            coordinates: Array.from({ length: 1000 }, (_, index) => [153, -27 + (4 * index) / 999]),
        };
        mocks.calculate.mockResolvedValue(original);
        const waypoint = buildTrialWaypointPlan(original.coordinates).waypoints[1];
        expect(Number.isInteger(waypoint.pathIndex)).toBe(false);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        tapWaypoint(2);
        fireEvent.click(screen.getByRole('button', { name: 'Move' }));
        tapChart(153.0001, waypoint.coordinates[1]);
        fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
        await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(2));
        const edited = mocks.review.mock.calls[1][0] as AutoroutingTrialRoute;
        const insertion = Math.ceil(waypoint.pathIndex);
        expect(edited.coordinates).toHaveLength(1001);
        expect(edited.coordinates.slice(0, insertion)).toEqual(original.coordinates.slice(0, insertion));
        expect(edited.coordinates[insertion]).toEqual([153.0001, waypoint.coordinates[1]]);
        expect(edited.coordinates.slice(insertion + 1)).toEqual(original.coordinates.slice(insertion));
        expect(edited.localEdit?.waypointIndices).toEqual([insertion]);
        expect(routeLine()).toEqual(edited.coordinates);
    });

    it('keeps endpoint and handover pins locked but permits an internal canal corner', async () => {
        const joined: AutoroutingTrialRoute = {
            ...route,
            coordinates: [route.coordinates[0], [153.2, -27.15], route.coordinates[1], route.coordinates[2]],
            canalDeparture: { handoverIndex: 2 },
        };
        mocks.canalCalculate.mockResolvedValue(joined);
        await openWorkspace();
        fillRequest('canal');
        fireEvent.change(screen.getByLabelText('canal exit latitude'), { target: { value: '-27.19' } });
        fireEvent.change(screen.getByLabelText('canal exit longitude'), { target: { value: '153.15' } });
        fireEvent.click(calculateButton());
        await openReview();
        const waypoints = buildTrialWaypointPlan(joined.coordinates, [2]).waypoints;
        for (const pathIndex of [0, 2, 3]) {
            const displayIndex = waypoints.findIndex((pin) => pin.pathIndex === pathIndex);
            expect(displayIndex).toBeGreaterThanOrEqual(0);
            tapWaypoint(displayIndex + 1);
            const editor = screen.getByRole('region', { name: `Waypoint ${displayIndex + 1}` });
            expect(within(editor).getByRole('button', { name: 'Move' })).toBeDisabled();
            expect(within(editor).getByText(/setup, then recalculate/)).toBeVisible();
            fireEvent.click(within(editor).getByRole('button', { name: 'Close waypoint editor' }));
        }
        const internalIndex = waypoints.findIndex((pin) => pin.pathIndex === 1);
        expect(internalIndex).toBeGreaterThan(0);
        tapWaypoint(internalIndex + 1);
        expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled();
        expect(routeLine()).toEqual(joined.coordinates);
        expect(mocks.review).toHaveBeenCalledTimes(1);
    });
    it('shows sparse markers while reviewing and drawing every point of a long passage', async () => {
        const dense: AutoroutingTrialRoute = {
            ...route,
            coordinates: Array.from({ length: 1000 }, (_, index) => [153, -27 + (4 * index) / 999]),
        };
        mocks.calculate.mockResolvedValue(dense);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        await waitFor(() => expect(mocks.review.mock.calls.at(-1)?.[0]).toBe(dense));
        expect(screen.getByRole('region', { name: 'Autorouting controls' })).toHaveTextContent('6 waypoints');
        expect(screen.getByRole('list', { name: 'Proposal waypoints' }).children).toHaveLength(6);
        const source = (mocks.maps[0].getSource as (id: string) => { setData: ReturnType<typeof vi.fn> })(
            'trial-review',
        );
        const data = source.setData.mock.calls.at(-1)![0] as GeoJSON.FeatureCollection;
        expect(data.features.filter((feature) => feature.geometry.type === 'Point')).toHaveLength(6);
        expect(data.features.filter((feature) => feature.geometry.type === 'LineString')).toHaveLength(999);
        const original = (mocks.maps[0].getSource as (id: string) => { setData: ReturnType<typeof vi.fn> })('trial');
        expect(
            original.setData.mock.calls
                .at(-1)![0]
                .features.find((feature: GeoJSON.Feature) => feature.geometry.type === 'LineString').geometry
                .coordinates,
        ).toEqual(dense.coordinates);
    });
    it('keeps the canal handover numbered in the sparse waypoint list', async () => {
        const joined: AutoroutingTrialRoute = {
            ...route,
            coordinates: Array.from({ length: 1000 }, (_, index) => [153, -27 + (4 * index) / 999]),
            canalDeparture: { handoverIndex: 5 },
        };
        mocks.canalCalculate.mockResolvedValue(joined);
        await openWorkspace();
        fillRequest('canal');
        fireEvent.change(screen.getByLabelText('canal exit latitude'), { target: { value: '-27.19' } });
        fireEvent.change(screen.getByLabelText('canal exit longitude'), { target: { value: '153.15' } });
        fireEvent.click(calculateButton());
        await openReview();
        expect(screen.getByText(/Canal exit: waypoint 2/)).toBeVisible();
        const source = (mocks.maps[0].getSource as (id: string) => { setData: ReturnType<typeof vi.fn> })(
            'trial-review',
        );
        const data = source.setData.mock.calls.at(-1)![0] as GeoJSON.FeatureCollection;
        expect(
            data.features.find((feature) => feature.geometry.type === 'Point' && feature.properties?.number === 2)
                ?.geometry,
        ).toEqual({ type: 'Point', coordinates: joined.coordinates[5] });
        expect(joined.canalDeparture?.handoverIndex).toBe(5);
    });
    it.each([
        [undefined, 6],
        [0, 6],
        [31, 6],
        [2, undefined],
        [2, 0],
        [2, 101],
        [NaN, 6],
        [2, Infinity],
    ])('requires valid Vessel preferences (%s m, %s kn), not invented defaults', async (draft, speed) => {
        render(
            <AutoroutingTrialWorkspace
                mapboxToken="fixture-token"
                onClose={vi.fn()}
                initialDraftM={draft}
                initialSpeedKts={speed}
            />,
        );
        await waitFor(() => expect(mocks.status).toHaveBeenCalled());
        act(() => mocks.maps[0].handlers.get('load')!());
        fillRequest();
        expect(screen.getByText(/Set a valid draft and cruising speed in Vessel preferences/)).toBeVisible();
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });
    it('distinguishes unavailable ENC, reference-only and downloading charts', async () => {
        mocks.encInventory.encNoCoverage = true;
        mocks.encInventory.encCellCount = 0;
        const view = await openWorkspace();
        expect(screen.getByText('ENC coverage unavailable here. Background map only.')).toBeVisible();
        mocks.encInventory.encCellCount = 1;
        mocks.encInventory.encReferenceCellCount = 1;
        view.rerender(<AutoroutingTrialWorkspace mapboxToken="fixture-token" onClose={view.onClose} />);
        expect(screen.getByText('Reference chart only — not navigation coverage.')).toBeVisible();
        mocks.encInventory.encHydration = { remaining: 1, total: 2 };
        view.rerender(<AutoroutingTrialWorkspace mapboxToken="fixture-token" onClose={view.onClose} />);
        expect(screen.getByText('Loading ENC chart detail…')).toBeVisible();
    });
    it('refits the same proposal after chart resize, then clears bounds and disconnects on unmount', async () => {
        const observers = installResizeObservers();
        try {
            const view = await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            await openReview();
            const map = mocks.maps[0];
            expect(map.fitBounds).toHaveBeenCalledTimes(1);
            const bounds = map.fitBounds.mock.calls[0][0];
            act(() => observers.resizeChart());
            expect(map.resize).toHaveBeenCalledTimes(1);
            expect(map.fitBounds).toHaveBeenLastCalledWith(bounds, { padding: 40, duration: 0 });
            expect(map.fitBounds).toHaveBeenCalledTimes(2);
            await openSetup();
            fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
            act(() => observers.resizeChart());
            expect(map.fitBounds).toHaveBeenCalledTimes(2);
            expect(mocks.maps).toHaveLength(1);
            const [chart] = observers.chartObservers();
            view.unmount();
            expect(chart.disconnect).toHaveBeenCalledTimes(1);
            expect(observers.cardObservers()).toHaveLength(0);
        } finally {
            cleanup();
            observers.restore();
        }
    });
    it.each(['dragstart', 'movestart'])(
        'refits a folded proposal when the tracer card gains a line, never after a skipper %s',
        async (eventName) => {
            const observers = installResizeObservers();
            try {
                await openWorkspace();
                fillRequest();
                fireEvent.click(calculateButton());
                await openReview();
                const map = mocks.maps[0];
                const bounds = map.fitBounds.mock.calls[0][0];
                // jsdom lays nothing out: give the card a height the test controls.
                const card = document.querySelector<HTMLElement>('.trial-tracer-shell')!;
                let height = 120;
                vi.spyOn(card, 'getBoundingClientRect').mockImplementation(
                    () =>
                        ({
                            x: 8,
                            y: 8,
                            top: 8,
                            left: 8,
                            width: 300,
                            height,
                            right: 308,
                            bottom: 8 + height,
                            toJSON: () => ({}),
                        }) as DOMRect,
                );
                expect(observers.cardObservers()).toHaveLength(0);
                fireEvent.click(screen.getByRole('button', { name: 'Collapse tracer panel' }));
                expect(observers.cardObservers()).toHaveLength(1);
                map.fitBounds.mockClear();
                // Same height: a resize notification alone moves nothing.
                act(() => observers.resizeCard());
                expect(map.fitBounds).not.toHaveBeenCalled();
                // A late wrap adds a line: frame the same proposal below it again.
                height = 140;
                act(() => observers.resizeCard());
                expect(map.fitBounds).toHaveBeenCalledTimes(1);
                expect(map.fitBounds).toHaveBeenLastCalledWith(bounds, { padding: 40, duration: 0 });
                // Once the skipper has moved the chart (a drag, or a keyboard
                // pan, which starts no drag or zoom), a growing card leaves it be.
                act(() => map.handlers.get(eventName)!({ originalEvent: { type: eventName } }));
                map.fitBounds.mockClear();
                height = 160;
                act(() => observers.resizeCard());
                expect(map.fitBounds).not.toHaveBeenCalled();
                // Unfolded, the card is no longer watched.
                await openReview();
                expect(observers.cardObservers()).toHaveLength(0);
            } finally {
                cleanup();
                observers.restore();
            }
        },
    );
    it('uses only opening snapshots for camera and vessel inputs, keeps endpoints empty, and offers compact zoom', async () => {
        const onClose = vi.fn();
        const view = render(
            <AutoroutingTrialWorkspace
                onClose={onClose}
                mapboxToken="fixture-token"
                initialCenter={{ lat: -26.7, lon: 153.2 }}
                initialDraftM={1.5}
                initialSpeedKts={6}
            />,
        );
        await waitFor(() => expect(mocks.status).toHaveBeenCalled());
        act(() => mocks.maps[0].handlers.get('load')!());
        expect(mocks.maps[0].options.center).toEqual([153.2, -26.7]);
        expect(mocks.maps[0].options.zoom).toBe(10);
        expect(mocks.maps[0].options.style).toBe('mapbox://styles/mapbox/dark-v11');
        expect(features()).toEqual([]);
        expect(calculateButton()).toBeDisabled();
        expect(screen.queryByLabelText('Trial vessel draft in metres')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Trial cruising speed in knots')).not.toBeInTheDocument();
        expect(screen.queryByText(/Check draft and speed|Trial departure: leaving now/)).not.toBeInTheDocument();
        view.rerender(
            <AutoroutingTrialWorkspace
                onClose={onClose}
                mapboxToken="replacement-token"
                initialCenter={{ lat: 50, lon: 0 }}
                initialDraftM={3}
                initialSpeedKts={8}
            />,
        );
        expect(mocks.maps).toHaveLength(1);
        expect(mocks.maps[0].options.center).toEqual([153.2, -26.7]);
        expect(mocks.maps[0].options.accessToken).toBe('fixture-token');
        fillRequest();
        fireEvent.click(calculateButton());
        await waitFor(() => expect(mocks.calculate).toHaveBeenCalled());
        expect(mocks.calculate.mock.calls[0][0]).toMatchObject({ draftM: 1.5, speedKts: 6 });
        expect(mocks.encBase).toHaveBeenCalledWith(mocks.maps[0], false);
        expect(mocks.encLayer).toHaveBeenLastCalledWith(
            expect.anything(),
            true,
            true,
            true,
            2,
            expect.any(Number),
            true,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Zoom trial chart in' }));
        fireEvent.click(screen.getByRole('button', { name: 'Zoom trial chart out' }));
        expect(mocks.maps[0].zoomIn).toHaveBeenCalledTimes(1);
        expect(mocks.maps[0].zoomOut).toHaveBeenCalledTimes(1);
        expect(mocks.maps[0].addControl).toHaveBeenCalledWith(expect.anything(), 'bottom-right');
    });
    it('requires explicit inputs and Calculate, paints exact returned geometry, and removes its only map on close', async () => {
        const view = await openWorkspace();
        expect(calculateButton()).toBeDisabled();
        expect(screen.getByText('Not for navigation. Unsaved proposal only.')).toBeVisible();
        expect(features()).toEqual([]);
        fillRequest();
        expect(mocks.calculate).not.toHaveBeenCalled();
        fireEvent.click(calculateButton());
        await openReview();
        expect(mocks.calculate).toHaveBeenCalledWith(
            { departure: { lat: -27.2, lon: 153.15 }, destination: { lat: -27, lon: 153.4 }, draftM: 1.6, speedKts: 6 },
            expect.any(AbortSignal),
        );
        expect(features().find((feature) => feature.geometry.type === 'LineString')?.geometry).toEqual({
            type: 'LineString',
            coordinates: route.coordinates,
        });
        expect(screen.getByText(route.warnings[0])).toBeVisible();
        expect(mocks.maps).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Close autorouting trial' }));
        expect(view.onClose).toHaveBeenCalledTimes(1);
        view.unmount();
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
    });

    it('chart taps set the selected endpoints without recalculating or remounting Mapbox', async () => {
        await openWorkspace();
        const tap = (lat: number, lon: number) => tapChart(lon, lat);
        tap(-27.2, 153.15);
        const departureButton = screen.getByRole('button', { name: /^departure/i });
        expect(within(departureButton).getByText('27°12.000′S')).toBeVisible();
        expect(within(departureButton).getByText('153°09.000′E')).toBeVisible();
        expect(screen.getByRole('button', { name: /Destination/i })).toHaveAttribute('aria-pressed', 'true');
        tap(-27, 153.4);
        const destinationButton = screen.getByRole('button', { name: /^destination/i });
        expect(within(destinationButton).getByText('27°00.000′S')).toBeVisible();
        expect(within(destinationButton).getByText('153°24.000′E')).toBeVisible();
        expect(screen.queryByText('Position set')).not.toBeInTheDocument();
        expect(features().map((feature) => feature.geometry)).toEqual([
            { type: 'Point', coordinates: [153.15, -27.2] },
            { type: 'Point', coordinates: [153.4, -27] },
        ]);
        fireEvent.click(screen.getByRole('button', { name: /^Departure/i }));
        tap(-27.1, 153.2);
        const controls = screen.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ });
        expect(controls).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(controls);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.1);
        expect(within(departureButton).getByText('27°06.000′S')).toBeVisible();
        expect(within(departureButton).getByText('153°12.000′E')).toBeVisible();
        expect(mocks.maps).toHaveLength(1);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it.each([
        ['19.999999', '-146.82', '20°00.000′N', '146°49.200′W'],
        ['-89.999999', '179.999999', '90°00.000′S', '180°00.000′E'],
        ['90', '-180', '90°00.000′N', '180°00.000′W'],
        ['0', '0', '0°00.000′N', '000°00.000′E'],
    ])(
        'shows manually entered %s, %s without changing the request coordinates',
        async (lat, lon, latitude, longitude) => {
            await openWorkspace();
            fillRequest();
            fireEvent.change(screen.getByLabelText('departure latitude'), { target: { value: lat } });
            fireEvent.change(screen.getByLabelText('departure longitude'), { target: { value: lon } });
            const button = screen.getByRole('button', { name: /^departure/i });
            expect(within(button).getByText(latitude)).toBeVisible();
            expect(within(button).getByText(longitude)).toBeVisible();
            fireEvent.click(calculateButton());
            await waitFor(() => expect(mocks.calculate).toHaveBeenCalled());
            expect(mocks.calculate.mock.calls[0][0].departure).toEqual({ lat: +lat, lon: +lon });
        },
    );

    it.each(['', '91'])(
        'removes the displayed coordinates when an endpoint becomes incomplete or invalid (%s)',
        async (lat) => {
            await openWorkspace();
            fillRequest();
            fireEvent.change(screen.getByLabelText('departure latitude'), { target: { value: lat } });
            const button = screen.getByRole('button', { name: /^departure/i });
            expect(button).toHaveTextContent('Tap chart or enter below');
            expect(button).not.toHaveTextContent('°');
            expect(calculateButton()).toBeDisabled();
        },
    );

    it.each(['departure latitude', 'destination longitude'])(
        'editing %s aborts and cannot resurrect an outdated proposal',
        async (label) => {
            const pending = deferred<AutoroutingTrialRoute>();
            mocks.calculate.mockReturnValueOnce(pending.promise);
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
            fireEvent.change(screen.getByLabelText(label), {
                target: { value: label.includes('latitude') ? '-26' : '2' },
            });
            expect(signal.aborted).toBe(true);
            await act(async () => pending.resolve(route));
            expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
            expect(features().some((feature) => feature.geometry.type === 'LineString')).toBe(false);
        },
    );

    it('Clear aborts pending work, empties all fields and does not replace the map', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValue(pending.promise);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        await act(async () => pending.resolve(route));
        expect(signal.aborted).toBe(true);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(null);
        for (const endpoint of [/^departure/i, /^destination/i]) {
            const button = screen.getByRole('button', { name: endpoint });
            expect(button).toHaveTextContent('Tap chart or enter below');
            expect(button).not.toHaveTextContent('°');
        }
        expect(features()).toEqual([]);
        expect(calculateButton()).toBeDisabled();
        expect(mocks.maps).toHaveLength(1);
        fillRequest();
        expect(calculateButton()).toBeEnabled();
        await act(async () => fireEvent.click(calculateButton()));
        expect(mocks.calculate.mock.calls[1][0]).toMatchObject({ draftM: 1.6, speedKts: 6 });
    });

    it('invalidates an already displayed proposal before a failed calculation; never draws a straight-line fallback', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        await openSetup();
        fireEvent.change(screen.getByLabelText('destination longitude'), { target: { value: '153.5' } });
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
        mocks.calculate.mockRejectedValueOnce(new Error('Trial coverage unavailable.'));
        fireEvent.click(calculateButton());
        expect(await screen.findByRole('alert')).toHaveTextContent('Trial coverage unavailable.');
        expect(features().every((feature) => feature.geometry.type === 'Point')).toBe(true);
    });

    it('closes and aborts calculation on identity change without leaking a late response', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValue(pending.promise);
        const { onClose } = await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        act(() => setAuthIdentityScope('another-account'));
        await act(async () => pending.resolve(route));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(true);
        expect(features()).toEqual([]);
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
    });

    it('unmount aborts both availability and proposal requests and removes subscriptions', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValue(pending.promise);
        const view = await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const statusSignal = mocks.status.mock.calls[0][0] as AbortSignal;
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        view.unmount();
        expect(statusSignal.aborted).toBe(true);
        expect(signal.aborted).toBe(true);
        act(() => setAuthIdentityScope('next-account'));
        expect(view.onClose).not.toHaveBeenCalled();
        await act(async () => pending.resolve(route));
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
    });

    it('keeps an authorized unready chart available, but disables Calculate with an honest message', async () => {
        mocks.status.mockResolvedValue({ enabled: true, ready: false, message: 'Trial coverage is being configured.' });
        await openWorkspace();
        fillRequest();
        expect(screen.getByText('Trial coverage is being configured.')).toBeVisible();
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(mocks.maps).toHaveLength(1);
    });

    it.each([
        { ready: true, vesselProfile: undefined, showsUpgrade: true, canCalculate: false },
        { ready: true, vesselProfile: false, showsUpgrade: true, canCalculate: false },
        { ready: true, vesselProfile: true, showsUpgrade: false, canCalculate: true },
        { ready: false, vesselProfile: undefined, showsUpgrade: false, canCalculate: false },
    ])('waits for confirmed profile capability before displaying an upgrade warning: %j', async (next) => {
        const pending = deferred<{ enabled: boolean; ready: boolean; vesselProfile?: boolean }>();
        mocks.status.mockReturnValue(pending.promise);
        render(
            <AutoroutingTrialWorkspace
                mapboxToken="fixture-token"
                onClose={vi.fn()}
                initialDraftM={1.6}
                initialSpeedKts={6}
                initialVesselProfile={{
                    draftStatus: 'measured',
                    length: { status: 'measured', valueM: 10 },
                    beam: { status: 'measured', valueM: 3 },
                    airDraft: { status: 'measured', valueM: 15 },
                }}
            />,
        );
        // Pending capability is unknown, not evidence that the server is old.
        // Check this first rendered state before resolving its asynchronous status.
        expect(screen.getByText('Checking trial availability…')).toBeVisible();
        expect(screen.queryByText(/The routing service needs an update/)).not.toBeInTheDocument();
        act(() => mocks.maps[0].handlers.get('load')!());
        fillRequest();
        expect(calculateButton()).toBeDisabled();
        await act(async () => pending.resolve({ enabled: true, ready: next.ready, vesselProfile: next.vesselProfile }));
        if (next.showsUpgrade) expect(screen.getByText(/The routing service needs an update/)).toBeVisible();
        else expect(screen.queryByText(/The routing service needs an update/)).not.toBeInTheDocument();
        if (next.canCalculate) expect(calculateButton()).toBeEnabled();
        else expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it.each([
        ['departure latitude', '91'],
        ['destination longitude', '181'],
    ])('rejects invalid %s=%s before requesting', async (label, value) => {
        await openWorkspace();
        fillRequest();
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it('uses the pane portal and Escape closes only this workspace; daylight starts with a light basemap', async () => {
        document.documentElement.classList.add('display-light');
        const host = document.createElement('div');
        const frame = document.createElement('div');
        host.dataset.panePortal = 'planning';
        document.body.append(host, frame);
        const onClose = vi.fn();
        try {
            render(
                <PanePortalContext.Provider
                    value={{ id: 'planning', host, frameRef: { current: frame }, contentRef: { current: frame } }}
                >
                    <AutoroutingTrialWorkspace mapboxToken="fixture-token" onClose={onClose} />
                </PanePortalContext.Provider>,
            );
            await waitFor(() => expect(mocks.status).toHaveBeenCalled());
            const dialog = screen.getByRole('dialog', { name: 'Autorouting trial' });
            expect(dialog.parentElement).toBe(host);
            expect(dialog).not.toHaveAttribute('aria-modal');
            expect(mocks.maps[0].options.style).toBe('mapbox://styles/mapbox/light-v11');
            act(() => mocks.maps[0].handlers.get('load')!());
            expect(mocks.maps[0].addLayer).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'trial-route', metadata: { 'thalassa:enc-anchor': true } }),
            );
            expect(mocks.encBase).toHaveBeenCalledWith(mocks.maps[0], false);
            fireEvent.keyDown(dialog, { key: 'Escape' });
            expect(onClose).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
            host.remove();
            frame.remove();
        }
    });

    it('keeps save explicit through its card, without direct persistence, activation, GPS or planner dependencies', () => {
        const source = readFileSync('components/autorouting/AutoroutingTrialWorkspace.tsx', 'utf8');
        expect(source).not.toMatch(
            /(?:localStorage|sessionStorage|dispatchEvent|passageHandoff|routeTracer|useVoyageForm|MapHub|GpsService|saveVoyagePlan)/,
        );
        expect(source).toContain('<AutoroutingProposalSaveCard');
    });
    it('folds controls without replacing the map, locates exact provider geometry and clears it with the proposal', async () => {
        const geometry = { type: 'Point' as const, coordinates: [153.25, -27.12] as [number, number] };
        mocks.calculate.mockResolvedValue({
            ...route,
            providerCheck: {
                status: 'unsafe',
                findings: [
                    {
                        featureIndex: 4,
                        featureType: 'obstruction',
                        severity: 'danger',
                        message: 'Fixture provider obstruction',
                        geometry,
                    },
                ],
            },
        });
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const toggle = await screen.findByRole('button', { name: /^(Expand|Collapse) tracer panel$/ });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByText('Danger reported · review required')).toBeVisible();
        expect(screen.getByText('Danger reported · open Route review before proceeding.')).toBeVisible();
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
        await openReview();
        fireEvent.click(screen.getByRole('button', { name: 'Locate provider finding 5' }));
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle).toHaveFocus();
        expect(screen.getByText(/SevenCs danger · exact reported Point highlighted/)).toBeVisible();
        const map = mocks.maps[0];
        const source = (map.getSource as (id: string) => { setData: ReturnType<typeof vi.fn> })(
            'trial-provider-hazard',
        );
        expect(source.setData.mock.calls.at(-1)![0].features[0].geometry).toEqual(geometry);
        expect(map.fitBounds).toHaveBeenLastCalledWith(
            [
                [153.25, -27.12],
                [153.25, -27.12],
            ],
            expect.objectContaining({ maxZoom: 16 }),
        );
        expect(map.addLayer.mock.calls.map(([layer]) => layer.id)).toEqual(
            expect.arrayContaining(['trial-provider-fill', 'trial-provider-line', 'trial-provider-point']),
        );
        expect(mocks.maps).toHaveLength(1);
        expect(features().find((f) => f.geometry.type === 'LineString')?.geometry).toEqual({
            type: 'LineString',
            coordinates: route.coordinates,
        });
        await openSetup();
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(source.setData.mock.calls.at(-1)![0].features).toEqual([]);
        expect(screen.queryByText(/exact reported Point/)).not.toBeInTheDocument();
    });
});

function RoutingFlow({ onManual = vi.fn(), onClose = vi.fn() }: { onManual?: () => void; onClose?: () => void }) {
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <button onClick={() => setOpen(true)}>Open routing choice</button>
            {open && (
                <RoutingModeDialog
                    mapboxToken="fixture-token"
                    onManual={() => {
                        onManual();
                        setOpen(false);
                    }}
                    onClose={() => {
                        onClose();
                        setOpen(false);
                    }}
                />
            )}
        </>
    );
}

function openChoice() {
    fireEvent.click(screen.getByRole('button', { name: 'Open routing choice' }));
    return screen.getByRole('dialog', { name: 'Choose routing mode' });
}

async function chooseAuto() {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Auto routing' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Auto routing' }));
    await screen.findByRole('dialog', { name: 'Autorouting trial' });
    await waitFor(() => expect(mocks.maps.length).toBeGreaterThan(0));
    act(() => mocks.maps.at(-1)!.handlers.get('load')!());
}

describe('explicit routing mode choice', () => {
    it('does no availability or map work until mounted and immediately offers Manual while Auto is pending', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        render(<RoutingFlow />);
        expect(mocks.status).not.toHaveBeenCalled();
        expect(mocks.maps).toHaveLength(0);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        const dialog = openChoice();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByRole('button', { name: 'Manual routing' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Auto routing' }));
        expect(mocks.status).toHaveBeenCalledTimes(1);
        expect(mocks.maps).toHaveLength(0);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it('Manual closes immediately without a calculation, map or extra status call and fences the old status', async () => {
        const pending = deferred<{ enabled: boolean; ready: boolean }>();
        mocks.status.mockReturnValue(pending.promise);
        const onManual = vi.fn();
        const onClose = vi.fn();
        render(<RoutingFlow onManual={onManual} onClose={onClose} />);
        openChoice();
        const signal = mocks.status.mock.calls[0][0] as AbortSignal;
        fireEvent.click(screen.getByRole('button', { name: 'Manual routing' }));
        expect(onManual).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(signal.aborted).toBe(true);
        await act(async () => pending.resolve({ enabled: true, ready: true }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.status).toHaveBeenCalledTimes(1);
        expect(mocks.maps).toHaveLength(0);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it.each(['denied', 'failed', 'signed out'] as const)(
        'keeps Manual available and Auto disabled when %s',
        async (state) => {
            if (state === 'denied') mocks.status.mockResolvedValue({ enabled: false, ready: false });
            if (state === 'failed') mocks.status.mockRejectedValue(new Error('Availability failed'));
            if (state === 'signed out') setAuthIdentityScope(null);
            const onManual = vi.fn();
            render(<RoutingFlow onManual={onManual} />);
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Open routing choice' }));
            });
            expect(screen.getByRole('dialog', { name: 'Choose routing mode' })).toBeVisible();
            expect(screen.getByRole('button', { name: 'Manual routing' })).toBeEnabled();
            expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
            if (state === 'signed out') expect(mocks.status).not.toHaveBeenCalled();
            fireEvent.click(screen.getByRole('button', { name: 'Auto routing' }));
            expect(mocks.maps).toHaveLength(0);
            fireEvent.click(screen.getByRole('button', { name: 'Manual routing' }));
            expect(onManual).toHaveBeenCalledTimes(1);
            expect(mocks.calculate).not.toHaveBeenCalled();
        },
    );

    it('opens Auto only after server authorization and snapshots selected location and vessel without changing settings', async () => {
        const pending = deferred<{ enabled: boolean; ready: boolean }>();
        mocks.status.mockReturnValueOnce(pending.promise);
        mocks.location = { lat: -26.7, lon: 153.2, source: 'map_pin' };
        mocks.settings = { vessel: { draft: 6, draftConfirmedFt: 6, cruisingSpeed: 7 } };
        render(<RoutingFlow />);
        openChoice();
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(mocks.maps).toHaveLength(0);
        await act(async () => pending.resolve({ enabled: true, ready: true }));
        await chooseAuto();
        expect(mocks.maps[0].options.center).toEqual([153.2, -26.7]);
        expect(features()).toEqual([]);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(null);
        expect(mocks.settings.vessel).toEqual({ draft: 6, draftConfirmedFt: 6, cruisingSpeed: 7 });
        expect(mocks.location).toEqual({ lat: -26.7, lon: 153.2, source: 'map_pin' });
        fillRequest();
        fireEvent.click(calculateButton());
        await waitFor(() => expect(mocks.calculate).toHaveBeenCalled());
        expect(mocks.calculate.mock.calls[0][0]).toMatchObject({
            draftM: vesselDraftMetres(mocks.settings.vessel),
            speedKts: 7,
        });
    });

    it('uses saved location only when the location store is initial and never moves the shared location', async () => {
        const vessel = { draft: 5.9, draftConfirmedFt: 5.9, cruisingSpeed: 6 };
        mocks.settings = { defaultLocationCoords: { lat: -23.9, lon: 152.4 }, vessel };
        render(<RoutingFlow />);
        openChoice();
        await chooseAuto();
        expect(mocks.maps[0].options.center).toEqual([152.4, -23.9]);
        expect(mocks.location).toEqual({ lat: -27.47, lon: 153.02, source: 'initial' });
        expect(mocks.settings).toEqual({ defaultLocationCoords: { lat: -23.9, lon: 152.4 }, vessel });
    });

    it('lets an authorized but unready user open Auto without enabling Calculate', async () => {
        mocks.status.mockResolvedValue({ enabled: true, ready: false, message: 'Setup in progress.' });
        render(<RoutingFlow />);
        openChoice();
        await chooseAuto();
        fillRequest();
        expect(screen.getByText('Setup in progress.')).toBeVisible();
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it('Cancel aborts pending authorization; a late success cannot reopen the flow and remount rechecks fresh', async () => {
        const old = deferred<{ enabled: boolean; ready: boolean }>();
        const fresh = deferred<{ enabled: boolean; ready: boolean }>();
        mocks.status.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        const signal = mocks.status.mock.calls[0][0] as AbortSignal;
        fireEvent.click(screen.getByRole('button', { name: 'Close routing choice' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(true);
        await act(async () => old.resolve({ enabled: true, ready: true }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        openChoice();
        expect(mocks.status).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        await act(async () => fresh.resolve({ enabled: false, ready: false }));
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(mocks.maps).toHaveLength(0);
    });

    it('Escape closes the choice and restores its opener without choosing either route mode', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        const onClose = vi.fn();
        const onManual = vi.fn();
        render(<RoutingFlow onClose={onClose} onManual={onManual} />);
        const opener = screen.getByRole('button', { name: 'Open routing choice' });
        opener.focus();
        const dialog = openChoice();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onManual).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
        expect(mocks.maps).toHaveLength(0);
    });

    it('traps keyboard focus among available choices while authorization is pending', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        render(<RoutingFlow />);
        openChoice();
        const close = screen.getByRole('button', { name: 'Close routing choice' });
        const manual = screen.getByRole('button', { name: 'Manual routing' });
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(manual).toHaveFocus();
        fireEvent.keyDown(manual, { key: 'Tab' });
        expect(close).toHaveFocus();
        expect(mocks.maps).toHaveLength(0);
    });

    it('centres the choice and cancels only on its backdrop, not its content', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        const dialog = openChoice();
        const backdrop = dialog.parentElement!;
        expect(backdrop).toHaveClass('flex', 'items-center', 'justify-center');
        fireEvent.click(dialog);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(backdrop);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.maps).toHaveLength(0);
    });

    it('Escape from Auto closes the whole flow without revealing a stale mode choice', async () => {
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        await chooseAuto();
        const close = screen.getByRole('button', { name: 'Close autorouting trial' });
        close.focus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
    });

    it('account changes close and discard the choice rather than rechecking the old dialog', async () => {
        const old = deferred<{ enabled: boolean; ready: boolean }>();
        mocks.status.mockReturnValueOnce(old.promise).mockResolvedValue({ enabled: false, ready: false });
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        const signal = mocks.status.mock.calls[0][0] as AbortSignal;
        act(() => setAuthIdentityScope('not-entitled'));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(true);
        await act(async () => old.resolve({ enabled: true, ready: true }));
        expect(mocks.status).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        openChoice();
        await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(mocks.maps).toHaveLength(0);
    });

    it('account changes discard an open Auto map and prevent its late calculation from resurfacing', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValueOnce(pending.promise);
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        await chooseAuto();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        act(() => setAuthIdentityScope('another-account'));
        await act(async () => pending.resolve(route));
        expect(signal.aborted).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
        expect(mocks.status).toHaveBeenCalledTimes(2);
    });

    it('closing Auto closes the entire flow and reopening takes fresh snapshots with no retained inputs or proposal', async () => {
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        await chooseAuto();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        fireEvent.click(screen.getByRole('button', { name: 'Close autorouting trial' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
        mocks.location = { lat: -23.9, lon: 152.4, source: 'map_pin' };
        mocks.settings = { vessel: { draft: 5, draftConfirmedFt: 5, cruisingSpeed: 8 } };
        openChoice();
        await chooseAuto();
        expect(mocks.maps).toHaveLength(2);
        expect(mocks.maps[1].options.center).toEqual([152.4, -23.9]);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(null);
        expect(screen.getByLabelText('destination latitude')).toHaveValue(null);
        expect(features()).toEqual([]);
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
        fillRequest();
        fireEvent.click(calculateButton());
        await waitFor(() => expect(mocks.calculate).toHaveBeenCalledTimes(2));
        expect(mocks.calculate.mock.calls[1][0]).toMatchObject({
            draftM: vesselDraftMetres(mocks.settings.vessel),
            speedKts: 8,
        });
    });

    it('scopes the centred choice to its pane, leaves the other pane usable and ignores its Escape', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        const host = document.createElement('div');
        const frame = document.createElement('div');
        const otherPane = document.createElement('div');
        const otherControl = document.createElement('button');
        host.dataset.panePortal = 'planning';
        frame.dataset.splitPane = 'planning';
        otherPane.dataset.splitPane = 'weather';
        otherPane.append(otherControl);
        document.body.append(host, frame, otherPane);
        const onClose = vi.fn();
        try {
            render(
                <PanePortalContext.Provider
                    value={{ id: 'planning', host, frameRef: { current: frame }, contentRef: { current: frame } }}
                >
                    <RoutingFlow onClose={onClose} />
                </PanePortalContext.Provider>,
            );
            const dialog = openChoice();
            expect(host.contains(dialog)).toBe(true);
            expect(dialog).not.toHaveAttribute('aria-modal');
            expect(frame).toHaveAttribute('inert');
            expect(otherPane).not.toHaveAttribute('inert');
            otherControl.focus();
            fireEvent.keyDown(otherControl, { key: 'Escape' });
            expect(onClose).not.toHaveBeenCalled();
            expect(dialog).toBeVisible();
            const close = screen.getByRole('button', { name: 'Close routing choice' });
            close.focus();
            fireEvent.keyDown(close, { key: 'Escape' });
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(frame).not.toHaveAttribute('inert');
            expect(otherPane).not.toHaveAttribute('inert');
            expect(mocks.maps).toHaveLength(0);
        } finally {
            cleanup();
            host.remove();
            frame.remove();
            otherPane.remove();
        }
    });

    it('does not import planner, persistence, live GPS or route handoff machinery', () => {
        const source = readFileSync('components/autorouting/RoutingModeDialog.tsx', 'utf8');
        expect(source).not.toMatch(
            /(?:localStorage|sessionStorage|dispatchEvent|passageHandoff|routeTracer|useVoyageForm|MapHub|GpsService|saveVoyagePlan|useWeather)/,
        );
    });
});
