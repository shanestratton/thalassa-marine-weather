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
import { BackstopLandRefusal } from '../services/routing/landBackstopWords';
import { buildTrialWaypointPlan } from '../services/autoroutingDisplayWaypoints';
import { TRIAL_GRADE_COLORS, type TrialRouteReview } from '../services/autoroutingReview';
import { clearAllCellMetadata, putCell } from '../services/enc/EncCellMetadata';
import { ROUTE_STAGE_WORDS } from '../services/autoroutingThalassa';

type Handler = (event?: unknown) => void;
const mocks = vi.hoisted(() => ({
    status: vi.fn(),
    calculate: vi.fn(),
    recheck: vi.fn(),
    annotate: vi.fn(),
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
        setLayoutProperty: ReturnType<typeof vi.fn>;
        getCanvas: ReturnType<typeof vi.fn<() => { style: { cursor: string } }>>;
        project: ReturnType<typeof vi.fn<(coordinates: [number, number]) => { x: number; y: number }>>;
    }>,
}));
// Thalassa's router on the phone (2026-10-01); the real one runs in
// tests/autoroutingThalassa.engine.test.ts.
vi.mock('../services/autoroutingThalassa', async (original) => ({
    // The router's own stage words (127-ROUTE-W), so the status tests below
    // speak the provider's real words.
    ROUTE_STAGE_WORDS: (await original<typeof import('../services/autoroutingThalassa')>()).ROUTE_STAGE_WORDS,
    getThalassaAutorouteStatus: mocks.status,
    calculateThalassaProposal: mocks.calculate,
    recheckThalassaBackstop: mocks.recheck,
}));
vi.mock('../components/map/tideWindowChips', () => ({ annotateTideWindows: mocks.annotate }));
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
                    setLayoutProperty: vi.fn(),
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
    provider: 'Thalassa',
    createdAt: '2026-09-12T00:00:00Z',
    coordinates: [
        [153.15, -27.2],
        [153.3, -27.1],
        [153.4, -27],
    ],
    warnings: ['Check all charted hazards independently.'],
    engine: {
        stateMask: ['channel', 'green'],
        cautionMask: [false, false],
        canalMask: [false, false],
        channelMask: [true, false],
        offshoreMask: [false, false],
        cellsUsed: ['OC-99-SYN001'],
        distanceNM: 15.6,
        elapsedMs: 900,
        backstop: 'verified',
    },
};
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (failure: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
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
function fillRequest() {
    fireEvent.click(screen.getByText('Enter coordinates'));
    for (const [label, value] of [
        ['departure latitude', '-27.2'],
        ['departure longitude', '153.15'],
        ['destination latitude', '-27'],
        ['destination longitude', '153.4'],
    ]) {
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
}
const calculateButton = () => screen.getByRole('button', { name: 'Calculate trial route' });
// The workspace keeps two ResizeObservers: one on the chart container (refit
// on orientation, keyboard and pane changes) and, while the tracer is folded,
// one on the folded card (refit when its status wraps onto another line).
// Tests drive each by what it observes, never by construction order. The
// shell's own self-measuring observer (expanded only) is left out of both.
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
    // TrialTracerShell measures itself while expanded (single-scroll, 2026-10-02):
    // its observer watches the card AND rows inside it. That one belongs to the
    // shell, not the workspace, so neither the chart nor the card set counts it.
    const isShellRow = (target: Element) => !isCard(target) && target.closest('.trial-tracer-shell') !== null;
    const live = (match: (target: Element) => boolean) =>
        observers.filter((observer) => !observer.targets.some(isShellRow) && observer.targets.some(match));
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
    mocks.status.mockReturnValue({ enabled: true, ready: true });
    mocks.calculate.mockResolvedValue(route);
    mocks.annotate.mockResolvedValue(undefined);
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
    it('sets up with two pins and Calculate: no departure type, no canal exit, the router asked once', async () => {
        await openWorkspace();
        expect(screen.queryByRole('button', { name: 'Canal / marina' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Open water' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Departure type/)).not.toBeInTheDocument();
        expect(screen.queryByText(/canal exit/i)).not.toBeInTheDocument();
        expect(calculateButton()).toBeDisabled();
        fillRequest();
        expect(calculateButton()).toBeEnabled();
        fireEvent.click(calculateButton());
        await openReview();
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
        const [request, signal, onProgress] = mocks.calculate.mock.calls[0];
        expect(request).toEqual({
            departure: { lat: -27.2, lon: 153.15 },
            destination: { lat: -27, lon: 153.4 },
            draftM: 1.6,
            speedKts: 6,
        });
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(onProgress).toEqual(expect.any(Function));
        expect(screen.getByText(/Thalassa proposal · not saved or activated/)).toBeVisible();
    });

    it("paints the router's own pieces in the planner's colours and hides the chart-check line colours", async () => {
        await openWorkspace();
        const map = mocks.maps.at(-1)!;
        const layerIds = map.addLayer.mock.calls.map(([layer]) => layer.id);
        expect(layerIds).toEqual(
            expect.arrayContaining([
                'thalassa-route-glow',
                'thalassa-route-line-layer',
                'thalassa-route-core',
                'route-survey-casing',
                'route-survey-dash',
                'thalassa-route-unverified',
            ]),
        );
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        const pieces = sourceFeatures('thalassa-route');
        expect(pieces.map((piece) => piece.properties?.safety)).toEqual(['channel', 'green']);
        for (const piece of pieces)
            expect(['danger', 'tide', 'survey', 'channel', 'offshore', 'green']).toContain(piece.properties?.safety);
        expect(map.setLayoutProperty).toHaveBeenLastCalledWith('trial-reviewed-legs', 'visibility', 'none');
        // The numbered waypoints keep the chart-check colours.
        expect(sourceFeatures('trial-review').some((feature) => feature.geometry.type === 'Point')).toBe(true);
    });

    it('draws an unverified line dashed and keeps the chart-check colours when the classifications did not arrive', async () => {
        mocks.calculate.mockResolvedValue({ ...route, engine: { ...route.engine!, stateMask: null } });
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        expect(sourceFeatures('thalassa-route')).toEqual([
            expect.objectContaining({ properties: expect.objectContaining({ safety: 'unverified', dashed: true }) }),
        ]);
        expect(mocks.maps.at(-1)!.setLayoutProperty).toHaveBeenLastCalledWith(
            'trial-reviewed-legs',
            'visibility',
            'visible',
        );
        expect(mocks.annotate).not.toHaveBeenCalled();
    });

    it("shows the router's refusal whole and draws no line", async () => {
        const refusal =
            'No route for 1.6 m draft: the only way through crosses Synthetic Bank, charted 0.5 m; the highest tide in the next 14 days is 0.6 m and you need 2.1 m.';
        mocks.calculate.mockRejectedValue(new Error(refusal));
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        expect(await screen.findByRole('alert')).toHaveTextContent(refusal);
        expect(features().some((feature) => feature.geometry.type === 'LineString')).toBe(false);
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
    });

    it('lists what the route must say on Review and counts the notes in the folded status', async () => {
        mocks.calculate.mockResolvedValue({
            ...route,
            warnings: [
                'Proposal only: not cleared for navigation.',
                'Bridges and power lines not checked on this chart — known bridges are.',
            ],
        });
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        const notes = screen.getByRole('region', { name: 'Route notes' });
        expect(within(notes).getAllByRole('listitem')).toHaveLength(2);
        expect(within(notes).getByRole('heading')).toHaveTextContent('2 route notes · what this route must say');
        expect(screen.getByText('2 route notes · review required')).toBeInTheDocument();
        expect(screen.getByText('Not for navigation. Unsaved proposal only.')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText('Chart checks complete · review required')).toBeInTheDocument());
    });

    // Package 125-06 (Shane's fresh Auto route, 2026-10-08: "Chart checks
    // stale" on a route just made). The review was bound to the whole chart
    // library: a chart landing anywhere after the check began — the map
    // loading detail round the new route, a sync, a cell elsewhere in the
    // world — left it stale until Recheck. Now a chart away from the route
    // leaves it alone, and one under it is checked against by itself.
    it('a fresh route keeps fresh chart checks as charts land round it — never "stale"', async () => {
        clearAllCellMetadata();
        const cell = (id: string, bbox: [number, number, number, number]) =>
            ({
                id,
                sourceHO: id.slice(0, 2),
                edition: 1,
                issued: '2026-10-01',
                importedAt: '2026-10-09T00:00:00.000Z',
                bbox,
                geojsonPath: `enc/${id}.json`,
                hazardCount: 12,
                usage: 'navigation',
            }) as const;
        try {
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            await waitFor(() =>
                expect(screen.getByText('Chart checks complete · review required')).toBeInTheDocument(),
            );
            expect(mocks.review).toHaveBeenCalledTimes(1);
            // A chart a hemisphere away (fictional, off Norway): not this route's.
            act(() => putCell(cell('NO5SYN01', [5, 60, 6, 61])));
            expect(screen.getByText('Chart checks complete · review required')).toBeInTheDocument();
            // One under the route lands, as the map loads detail round it.
            act(() => putCell(cell('AU5SYN99', [153.1, -27.3, 153.5, -26.9])));
            expect(screen.queryByText(/Chart checks stale/)).not.toBeInTheDocument();
            await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(2), { timeout: 5_000 });
            await waitFor(() =>
                expect(screen.getByText('Chart checks complete · review required')).toBeInTheDocument(),
            );
            expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
        } finally {
            clearAllCellMetadata();
        }
    });

    // Package 125-06 (Shane's fresh Auto route, 2026-10-08: "8 route notes ·
    // review required"): three lines are on every Auto route whatever it
    // finds. They are still listed on Review, under their own heading, but
    // the count — folded and on Review — is of what this route found.
    it('counts what the route found, not the lines every Auto route carries', async () => {
        mocks.calculate.mockResolvedValue({
            ...route,
            warnings: [
                'Proposal only: not cleared for navigation. Review every leg against the chart before you save or use it.',
                'Routed on this phone by Thalassa from your installed charts: draft 2.40 m + 0.5 m under the keel at chart datum (LAT). Tide is shown, never assumed.',
                'Survey may be out by up to 1.1 m on 3.3 km of this route — more than your keel margin there.',
                'Beam and length are not used by the router yet.',
            ],
        });
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        expect(screen.getByText('1 route note · review required')).toBeInTheDocument();
        const notes = screen.getByRole('region', { name: 'Route notes' });
        expect(within(notes).getByRole('heading', { level: 3 })).toHaveTextContent(
            '1 route note · what this route must say',
        );
        const found = within(notes).getByRole('list', { name: 'What this route found' });
        expect(
            within(found)
                .getAllByRole('listitem')
                .map((item) => item.textContent),
        ).toEqual([
            'Whole route · Survey may be out by up to 1.1 m on 3.3 km of this route — more than your keel margin there.',
        ]);
        const always = within(notes).getByRole('list', { name: 'On every Auto route' });
        expect(within(always).getAllByRole('listitem')).toHaveLength(3);
    });

    it('a route that found nothing says no notes to review, and still lists the three', async () => {
        mocks.calculate.mockResolvedValue({
            ...route,
            warnings: [
                'Proposal only: not cleared for navigation. Review every leg against the chart before you save or use it.',
                'Routed on this phone by Thalassa from your installed charts: draft 2.40 m + 0.5 m under the keel at chart datum (LAT). Tide is shown, never assumed.',
                'Beam and length are not used by the router yet.',
            ],
        });
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        expect(screen.queryByText(/route notes? · review required/)).not.toBeInTheDocument();
        const notes = screen.getByRole('region', { name: 'Route notes' });
        expect(within(notes).getByRole('heading', { level: 3 })).toHaveTextContent('No route notes to review');
        expect(
            within(within(notes).getByRole('list', { name: 'On every Auto route' })).getAllByRole('listitem'),
        ).toHaveLength(3);
    });

    // Shane's phone, 2026-10-02, online: "The satellite land check has not
    // run for this route (offline)", Save off, and the only way on was to
    // recalculate the whole route. It had timed out.
    it("offers Retry for a satellite check that couldn't run — the check alone, then Save follows it", async () => {
        const reason = "the satellite relief service didn't answer within 12 s";
        const note = `Satellite land check couldn't be done just now: ${reason}. Checked against the installed charts only — retry the check in Review before saving.`;
        const unavailable: AutoroutingTrialRoute = {
            ...route,
            warnings: ['Proposal only: not cleared for navigation.', note],
            engine: {
                ...route.engine!,
                backstop: 'unavailable',
                backstopReason: reason,
                backstopCharts: ['water', 'water'],
            },
        };
        mocks.calculate.mockResolvedValue(unavailable);
        const checked = deferred<AutoroutingTrialRoute>();
        mocks.recheck.mockReturnValue(checked.promise);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        const check = screen.getByRole('region', { name: 'Satellite land check' });
        expect(check).toHaveTextContent(`Satellite land check couldn't be done just now: ${reason}.`);
        expect(check).not.toHaveTextContent(/offline/i);
        expect(screen.getByText('2 route notes · review required')).toBeInTheDocument();
        expect(
            screen.getByText(
                `The satellite land check couldn't be done just now: ${reason}. Retry the check before saving.`,
            ),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
        const reviewsBefore = mocks.review.mock.calls.length;

        fireEvent.click(within(check).getByRole('button', { name: 'Retry satellite check' }));
        expect(within(check).getByRole('button', { name: 'Checking satellite relief…' })).toBeDisabled();
        await waitFor(() => expect(mocks.recheck).toHaveBeenCalledWith(unavailable));
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
        await act(async () =>
            checked.resolve({
                ...unavailable,
                warnings: ['Proposal only: not cleared for navigation.'],
                engine: { ...route.engine!, backstop: 'verified' },
            }),
        );
        expect(screen.queryByRole('region', { name: 'Satellite land check' })).not.toBeInTheDocument();
        expect(screen.getByText('1 route note · review required')).toBeInTheDocument();
        expect(screen.queryByText(/satellite land check couldn't be done/i)).not.toBeInTheDocument();
        // The chart review was not restarted, and the route was not re-routed.
        expect(mocks.review.mock.calls.length).toBe(reviewsBefore);
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
    });

    it('a retry that finds land takes the route away and says why', async () => {
        const reason = "the request didn't get through (network error)";
        mocks.calculate.mockResolvedValue({
            ...route,
            engine: {
                ...route.engine!,
                backstop: 'unavailable',
                backstopReason: reason,
                backstopCharts: ['land', 'land'],
            },
        });
        mocks.recheck.mockRejectedValue(
            new BackstopLandRefusal(
                'Satellite relief shows land near 27.100° S, 153.300° E. The route is not shown. Nothing changed.',
            ),
        );
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        fireEvent.click(screen.getByRole('button', { name: 'Retry satellite check' }));
        expect(
            await screen.findByText(
                'Satellite relief shows land near 27.100° S, 153.300° E. The route is not shown. Nothing changed.',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
    });

    // Fix-up review (2026-10-03): a retry can take ~27 s on a slow link. A
    // skipper who goes back to Setup and calculates again meanwhile must keep
    // the NEW route: the old route's answer, land or not, is about a line
    // that is no longer shown.
    it('a retry still running when a new route arrives never touches the new route', async () => {
        const reason = "the satellite relief service didn't answer (tried twice, 12 s each)";
        const first: AutoroutingTrialRoute = {
            ...route,
            engine: {
                ...route.engine!,
                backstop: 'unavailable',
                backstopReason: reason,
                backstopCharts: ['water', 'water'],
            },
        };
        const second: AutoroutingTrialRoute = { ...route, id: 'proposal-2', warnings: ['Second route note.'] };
        mocks.calculate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        let refuse!: (failure: unknown) => void;
        mocks.recheck.mockReturnValue(
            new Promise<AutoroutingTrialRoute>((_resolve, reject) => {
                refuse = reject;
            }),
        );
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        fireEvent.click(screen.getByRole('button', { name: 'Retry satellite check' }));
        await waitFor(() => expect(mocks.recheck).toHaveBeenCalledTimes(1));
        await openSetup();
        fireEvent.click(calculateButton());
        await openReview();
        await waitFor(() => expect(mocks.calculate).toHaveBeenCalledTimes(2));
        expect(screen.getByText('1 route note · review required')).toBeInTheDocument();

        await act(async () =>
            refuse(
                new BackstopLandRefusal(
                    'Satellite relief shows land near 27.100° S, 153.300° E. The route is not shown. Nothing changed.',
                ),
            ),
        );
        expect(screen.getByRole('region', { name: 'Trial proposal' })).toBeInTheDocument();
        expect(screen.queryByText(/Satellite relief shows land/)).not.toBeInTheDocument();
        expect(screen.getByText('1 route note · review required')).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Satellite land check' })).not.toBeInTheDocument();
    });

    it('a retry that resolves after a new route arrives is not shown on the new route', async () => {
        const reason = "the request didn't get through (network error)";
        const first: AutoroutingTrialRoute = {
            ...route,
            engine: {
                ...route.engine!,
                backstop: 'unavailable',
                backstopReason: reason,
                backstopCharts: ['water', 'water'],
            },
        };
        const second: AutoroutingTrialRoute = {
            ...first,
            id: 'proposal-2',
            engine: { ...first.engine!, backstopReason: 'this phone is offline' },
        };
        mocks.calculate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const checked = deferred<AutoroutingTrialRoute>();
        mocks.recheck.mockReturnValue(checked.promise);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        fireEvent.click(screen.getByRole('button', { name: 'Retry satellite check' }));
        await openSetup();
        fireEvent.click(calculateButton());
        await openReview();
        const check = await screen.findByRole('region', { name: 'Satellite land check' });
        expect(check).toHaveTextContent('this phone is offline');
        // The new route's own Retry is not held by the old one.
        expect(within(check).getByRole('button', { name: 'Retry satellite check' })).toBeEnabled();
        await act(async () => checked.resolve({ ...first, engine: { ...first.engine!, backstop: 'verified' } }));
        expect(screen.getByRole('region', { name: 'Satellite land check' })).toHaveTextContent('this phone is offline');
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
    });

    it('a retry that fails for any other reason keeps the route and says why beside Retry', async () => {
        const reason = "the satellite relief service didn't answer within 28 s";
        mocks.calculate.mockResolvedValue({
            ...route,
            engine: {
                ...route.engine!,
                backstop: 'unavailable',
                backstopReason: reason,
                backstopCharts: ['water', 'water'],
            },
        });
        mocks.recheck.mockRejectedValue(
            new Error("This route's chart evidence for the satellite check is not kept. Recalculate."),
        );
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        fireEvent.click(screen.getByRole('button', { name: 'Retry satellite check' }));
        const check = screen.getByRole('region', { name: 'Satellite land check' });
        expect(
            await within(check).findByText(
                "This route's chart evidence for the satellite check is not kept. Recalculate.",
            ),
        ).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Trial proposal' })).toBeInTheDocument();
        expect(within(check).getByRole('button', { name: 'Retry satellite check' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
    });

    it('offers no Retry when the route kept no chart evidence for the check — Recalculate instead', async () => {
        const reason = "the satellite relief service didn't answer within 28 s";
        mocks.calculate.mockResolvedValue({
            ...route,
            engine: { ...route.engine!, backstop: 'unavailable', backstopReason: reason },
        });
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        const check = screen.getByRole('region', { name: 'Satellite land check' });
        expect(check).toHaveTextContent(`Satellite land check couldn't be done just now: ${reason}.`);
        expect(check).toHaveTextContent('Recalculate to run it again.');
        expect(within(check).queryByRole('button', { name: 'Retry satellite check' })).not.toBeInTheDocument();
        expect(mocks.recheck).not.toHaveBeenCalled();
    });

    it('places tide chips on the workspace map and removes them on recalculate and close', async () => {
        const marker = { remove: vi.fn() };
        mocks.annotate.mockImplementation(async (options: { markers: unknown[] }) => {
            options.markers.push(marker);
        });
        const shallow = {
            ...route,
            engine: {
                ...route.engine!,
                stateMask: ['danger' as const, 'green' as const],
                cautionMask: [true, false],
                chartedShallowMask: [true, false],
                tideDepthM: [1.2, null],
                tideNeedM: 2.1,
                shallowRuns: [{ startSeg: 0, endSeg: 0, lengthM: 900, midLat: -27.15, midLon: 153.22, minDepthM: 1.2 }],
            },
        };
        mocks.calculate.mockResolvedValue(shallow);
        const { unmount } = await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        await waitFor(() => expect(mocks.annotate).toHaveBeenCalledTimes(1));
        const options = mocks.annotate.mock.calls[0][0];
        expect(options.map).toBe(mocks.maps.at(-1));
        expect(options.runs).toEqual(shallow.engine.shallowRuns);
        expect(options.needM).toBe(2.1);
        expect(options.draftM).toBe(1.6);
        expect(options.liftable.length).toBeGreaterThan(0);
        // The tide's top redraws the line: amber where a tide clears it.
        let drawn: unknown;
        act(() => {
            drawn = options.onTide(() => 2.5);
        });
        expect((drawn as { state: string }[])[0].state).toBe('tide');
        expect(sourceFeatures('thalassa-route')[0].properties?.safety).toBe('tide');
        await openSetup();
        fireEvent.click(calculateButton());
        await waitFor(() => expect(marker.remove).toHaveBeenCalledTimes(1));
        await openReview();
        await waitFor(() => expect(mocks.annotate).toHaveBeenCalledTimes(2));
        unmount();
        expect(marker.remove).toHaveBeenCalledTimes(2);
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

    it("confirms one full-path vertex edit, drops the router's colours, keeps its notes as history and blocks saving after a fresh review", async () => {
        const original: AutoroutingTrialRoute = {
            ...route,
            coordinates: Array.from({ length: 1000 }, (_, index) => [
                153 + index * 0.0001,
                -27 + (index === 500 ? 0.01 : 0),
            ]),
            engine: { ...route.engine!, stateMask: Array.from({ length: 999 }, () => 'green' as const) },
        };
        const snapshot = structuredClone(original);
        mocks.calculate.mockResolvedValue(original);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        await waitFor(() => expect(screen.getByText(/999\/999 checked segments/)).toBeVisible());
        expect(sourceFeatures('thalassa-route')).toHaveLength(1);
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
        // The router never saw the edited line: no disclosure, no router
        // colours — the chart-check colours return on the line.
        expect(edited.engine).toBeUndefined();
        expect(edited.localEdit?.originalProposal.warnings).toEqual(snapshot.warnings);
        expect(sourceFeatures('thalassa-route')).toEqual([]);
        expect(map.setLayoutProperty).toHaveBeenLastCalledWith('trial-reviewed-legs', 'visibility', 'visible');
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
        expect(
            screen.getByText('From the original route, before waypoint edits · historical, not checks of this line.'),
        ).toBeVisible();
        expect(screen.getByText('Check all charted hazards independently.')).toBeVisible();
        expect(screen.getByText(/The router's\s+original checks no longer apply/)).toBeVisible();
        expect(screen.getByText('Edited · router checks no longer apply')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
        // Late progress from the previous check cannot repaint the edited route.
        act(() => oldProgress(firstReview));
        expect(screen.getByText('Checking 0/999 detailed route segments…')).toBeVisible();
        await act(async () => pending.resolve(firstReview));
        expect(screen.getByText(/999\/999 checked segments/)).toBeVisible();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
        expect(screen.getByText(/edited route has not been rechecked by Thalassa's router/)).toBeVisible();
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

    it('keeps endpoint pins locked but permits an interior corner', async () => {
        const joined: AutoroutingTrialRoute = {
            ...route,
            coordinates: [route.coordinates[0], [153.2, -27.15], route.coordinates[1], route.coordinates[2]],
        };
        mocks.calculate.mockResolvedValue(joined);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await openReview();
        const waypoints = buildTrialWaypointPlan(joined.coordinates).waypoints;
        for (const pathIndex of [0, 3]) {
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
            expect.any(Function),
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

    it('Stop aborts pending work and keeps the pins; Clear then empties all fields and does not replace the map', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValue(pending.promise);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        // While it routes the second button is Stop (127-ROUTE-W2), not Clear.
        expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await act(async () => pending.resolve(route));
        expect(signal.aborted).toBe(true);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.2);
        // A deliberate Clear, a moment later (a second tap of the same press is ignored, below).
        const later = performance.now() + 1_000;
        const clock = vi.spyOn(performance, 'now').mockReturnValue(later);
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        clock.mockRestore();
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

    describe('Stop, and the seconds while it routes (127-ROUTE-W2)', () => {
        // Shane, 2026-10-10: "yes for a short while it looked as though the
        // app had frozen". The router now works in a worker; the status says
        // so with a ticking count, and Stop really stops it.
        const statusLine = () => document.querySelector('.trial-tracer-status') as HTMLElement;
        const LIVE_LINE = 'The chart stays live while it works. Stop ends it.';
        const progressOf = () => mocks.calculate.mock.calls.at(-1)![2] as (message: string) => void;

        it('while it routes the second button is Stop: it ends the route, keeps her pins, and says "Stopped. Nothing changed."', async () => {
            const pending = deferred<AutoroutingTrialRoute>();
            mocks.calculate.mockReturnValueOnce(pending.promise);
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
            act(() => progressOf()(ROUTE_STAGE_WORDS.routing));
            expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
            expect(signal.aborted).toBe(true);
            expect(statusLine()).toHaveTextContent('Stopped. Nothing changed.');
            expect(screen.queryByText(LIVE_LINE)).not.toBeInTheDocument();
            // The route that was running comes back late: it is dropped.
            await act(async () => pending.resolve(route));
            expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
            expect(features().some((feature) => feature.geometry.type === 'LineString')).toBe(false);
            expect(statusLine()).toHaveTextContent('Stopped. Nothing changed.');
            // Her pins are where she put them.
            for (const [label, value] of [
                ['departure latitude', -27.2],
                ['departure longitude', 153.15],
                ['destination latitude', -27],
                ['destination longitude', 153.4],
            ] as const)
                expect(screen.getByLabelText(label)).toHaveValue(value);
            expect(screen.getByRole('button', { name: 'Clear' })).toBeVisible();
            // Calculate again: the route arrives as before.
            expect(calculateButton()).toBeEnabled();
            fireEvent.click(calculateButton());
            await openReview();
            expect(mocks.calculate).toHaveBeenCalledTimes(2);
            expect(mocks.calculate.mock.calls[1][0]).toEqual(mocks.calculate.mock.calls[0][0]);
            expect(statusLine()).not.toHaveTextContent('Stopped');
        });

        it('a second tap straight after Stop, now on Clear, keeps her pins', async () => {
            mocks.calculate.mockReturnValueOnce(deferred<AutoroutingTrialRoute>().promise);
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
            fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
            expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.2);
            expect(statusLine()).toHaveTextContent('Stopped. Nothing changed.');
        });

        it('the router refuses just as she reaches for Stop: the tap, now on Clear, keeps her pins and the refusal', async () => {
            // Review, 2026-10-11: the route ends on its own, Stop turns into
            // Clear under her finger, and the tap meant for Stop lands on Clear.
            const refusal =
                'No route for 1.6 m draft: the only way through crosses Synthetic Bank, charted 0.5 m; the highest tide in the next 14 days is 0.6 m and you need 2.1 m.';
            const pending = deferred<AutoroutingTrialRoute>();
            mocks.calculate.mockReturnValueOnce(pending.promise);
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            act(() => progressOf()(ROUTE_STAGE_WORDS.routing));
            const at = performance.now();
            const clock = vi.spyOn(performance, 'now').mockReturnValue(at);
            try {
                await act(async () => pending.reject(new Error(refusal)));
                clock.mockReturnValue(at + 100);
                fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
                expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.2);
                expect(screen.getByLabelText('destination longitude')).toHaveValue(153.4);
                expect(screen.getByRole('alert')).toHaveTextContent(refusal);
                // A deliberate Clear, a moment later, empties them.
                clock.mockReturnValue(at + 1_000);
                fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
                expect(screen.getByLabelText('departure latitude')).toHaveValue(null);
                expect(screen.queryByRole('alert')).not.toBeInTheDocument();
            } finally {
                clock.mockRestore();
            }
        });

        it("the phone's clock stepping back after a Stop (back online) never blocks a later Clear", async () => {
            mocks.calculate.mockReturnValueOnce(deferred<AutoroutingTrialRoute>().promise);
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
            const later = performance.now() + 1_000;
            const monotonic = vi.spyOn(performance, 'now').mockReturnValue(later);
            const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000);
            try {
                fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
            } finally {
                monotonic.mockRestore();
                wall.mockRestore();
            }
            expect(screen.getByLabelText('departure latitude')).toHaveValue(null);
        });

        it('editing a pin after a stop clears "Stopped"', async () => {
            mocks.calculate.mockReturnValueOnce(deferred<AutoroutingTrialRoute>().promise);
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
            expect(statusLine()).toHaveTextContent('Stopped. Nothing changed.');
            fireEvent.change(screen.getByLabelText('destination latitude'), { target: { value: '-27.05' } });
            expect(statusLine()).not.toHaveTextContent('Stopped');
            expect(statusLine()).toHaveTextContent('Ready to calculate');
        });

        it('counts the seconds from the tap once the router starts; VoiceOver hears the words, never the count', async () => {
            const pending = deferred<AutoroutingTrialRoute>();
            mocks.calculate.mockReturnValueOnce(pending.promise);
            await openWorkspace();
            fillRequest();
            vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
            try {
                fireEvent.click(calculateButton());
                // The prep, and a route waiting behind another: their words, no count.
                act(() => progressOf()('Following deep water…'));
                expect(statusLine()).toHaveTextContent('Following deep water…');
                act(() => vi.advanceTimersByTime(1_000));
                act(() => progressOf()(ROUTE_STAGE_WORDS.queued));
                expect(statusLine()).toHaveTextContent('Waiting for the route before this one…');
                expect(statusLine().textContent).not.toMatch(/· \d+ s/);
                act(() => vi.advanceTimersByTime(2_000));
                act(() => progressOf()(ROUTE_STAGE_WORDS.routing));
                expect(statusLine()).toHaveTextContent('Routing round the land · 3 s');
                const count = within(statusLine()).getByText('· 3 s');
                expect(count).toHaveAttribute('aria-hidden', 'true');
                // The panel's own status line is the words alone, and the live line shows.
                expect(screen.getAllByRole('status').map((node) => node.textContent)).toContain(
                    ROUTE_STAGE_WORDS.routing,
                );
                expect(screen.getByText(LIVE_LINE)).toBeVisible();
                act(() => vi.advanceTimersByTime(2_000));
                expect(statusLine()).toHaveTextContent('Routing round the land · 5 s');
                // The phone's clock steps back an hour (back online): the count goes on.
                vi.setSystemTime(Date.now() - 3_600_000);
                act(() => vi.advanceTimersByTime(1_000));
                expect(statusLine()).toHaveTextContent('Routing round the land · 6 s');
                // After the router: the land check, still counting; the live line goes.
                act(() => progressOf()('Checking the route…'));
                act(() => vi.advanceTimersByTime(4_000));
                expect(statusLine()).toHaveTextContent('Checking the route · 10 s');
                expect(screen.queryByText(LIVE_LINE)).not.toBeInTheDocument();
            } finally {
                vi.useRealTimers();
            }
            await act(async () => pending.resolve(route));
            expect(statusLine().textContent).not.toMatch(/· \d+ s/);
        });

        it("on a phone where the worker can't start, it says the screen may pause, and promises no live chart", async () => {
            mocks.calculate.mockReturnValueOnce(deferred<AutoroutingTrialRoute>().promise);
            await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            act(() => progressOf()(ROUTE_STAGE_WORDS['routing-main']));
            expect(statusLine()).toHaveTextContent(
                /^Set up routeRouting round the land \(the screen may pause\) · \d+ s$/,
            );
            expect(screen.queryByText(LIVE_LINE)).not.toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
        });

        it('closing Auto mid-route ends it too', async () => {
            mocks.calculate.mockReturnValueOnce(deferred<AutoroutingTrialRoute>().promise);
            const { unmount } = await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
            unmount();
            expect(signal.aborted).toBe(true);
        });
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

    it('unmount aborts the proposal request and removes subscriptions', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValue(pending.promise);
        const view = await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        view.unmount();
        expect(signal.aborted).toBe(true);
        act(() => setAuthIdentityScope('next-account'));
        expect(view.onClose).not.toHaveBeenCalled();
        await act(async () => pending.resolve(route));
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
    });

    it('keeps the chart available without installed charts, but disables Calculate with an honest message', async () => {
        mocks.status.mockReturnValue({
            enabled: true,
            ready: false,
            message: 'Install charts for your area to use Auto. Manual is ready.',
        });
        await openWorkspace();
        fillRequest();
        expect(screen.getByText('Install charts for your area to use Auto. Manual is ready.')).toBeVisible();
        expect(screen.getByText('Install charts to calculate')).toBeInTheDocument();
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(mocks.maps).toHaveLength(1);
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
    it('folds controls without replacing the map, reports danger from the chart checks and clears with the proposal', async () => {
        mocks.review.mockImplementation(async (proposal: AutoroutingTrialRoute) => ({
            phase: 'complete',
            legs: proposal.coordinates.slice(1).map((_, index) => ({
                incomplete: false,
                verdict: {
                    grade: index === 0 ? 'danger' : 'clear',
                    issues: index === 0 ? [{ severity: 'danger', message: 'Charted obstruction' }] : [],
                    minDepthM: 8,
                    minAt: null,
                    needsTide: false,
                    nudge: null,
                    nudgeTo: null,
                },
            })),
        }));
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const toggle = await screen.findByRole('button', { name: /^(Expand|Collapse) tracer panel$/ });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await waitFor(() => expect(screen.getByText('Danger reported · review required')).toBeVisible());
        expect(screen.getByText('Danger reported · open Route review before proceeding.')).toBeVisible();
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
        const map = mocks.maps[0];
        expect(map.addLayer.mock.calls.map(([layer]) => layer.id)).not.toEqual(
            expect.arrayContaining(['trial-provider-fill']),
        );
        expect(mocks.maps).toHaveLength(1);
        expect(features().find((f) => f.geometry.type === 'LineString')?.geometry).toEqual({
            type: 'LineString',
            coordinates: route.coordinates,
        });
        await openSetup();
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(sourceFeatures('thalassa-route')).toEqual([]);
        expect(features().some((f) => f.geometry.type === 'LineString')).toBe(false);
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
    it('does no availability or map work until mounted; offers Manual at once and Auto only when enabled', () => {
        mocks.status.mockReturnValue({ enabled: false, ready: false });
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

    it('Manual closes immediately without a calculation, map or extra status call', async () => {
        const onManual = vi.fn();
        const onClose = vi.fn();
        render(<RoutingFlow onManual={onManual} onClose={onClose} />);
        openChoice();
        // Worked out on the phone (2026-10-01): no request to wait for or abort.
        expect(mocks.status.mock.calls[0]).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: 'Manual routing' }));
        expect(onManual).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.status).toHaveBeenCalledTimes(1);
        expect(mocks.maps).toHaveLength(0);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it.each(['denied', 'failed', 'signed out'] as const)(
        'keeps Manual available and Auto disabled when %s',
        async (state) => {
            if (state === 'denied') mocks.status.mockReturnValue({ enabled: false, ready: false });
            if (state === 'failed')
                mocks.status.mockImplementation(() => {
                    throw new Error('Availability failed');
                });
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

    it('opens Auto only when enabled and snapshots selected location and vessel without changing settings', async () => {
        mocks.location = { lat: -26.7, lon: 153.2, source: 'map_pin' };
        mocks.settings = { vessel: { draft: 6, draftConfirmedFt: 6, cruisingSpeed: 7 } };
        render(<RoutingFlow />);
        openChoice();
        expect(mocks.maps).toHaveLength(0);
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

    it('lets a signed-in user with no charts open Auto without enabling Calculate', async () => {
        mocks.status.mockReturnValue({
            enabled: true,
            ready: false,
            message: 'Install charts for your area to use Auto. Manual is ready.',
        });
        render(<RoutingFlow />);
        openChoice();
        await chooseAuto();
        fillRequest();
        expect(screen.getByText('Install charts for your area to use Auto. Manual is ready.')).toBeVisible();
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it('Cancel closes the choice; reopening reads the status fresh', async () => {
        mocks.status.mockReturnValueOnce({ enabled: true, ready: true }).mockReturnValueOnce({
            enabled: false,
            ready: false,
        });
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Auto routing' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'Close routing choice' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        openChoice();
        expect(mocks.status).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(mocks.maps).toHaveLength(0);
    });

    it('Escape closes the choice and restores its opener without choosing either route mode', () => {
        mocks.status.mockReturnValue({ enabled: false, ready: false });
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

    it('traps keyboard focus among available choices while Auto is unavailable', () => {
        mocks.status.mockReturnValue({ enabled: false, ready: false });
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
        mocks.status.mockReturnValue({ enabled: false, ready: false });
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
        mocks.status
            .mockReturnValueOnce({ enabled: true, ready: true })
            .mockReturnValue({ enabled: false, ready: false });
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        act(() => setAuthIdentityScope('not-entitled'));
        expect(onClose).toHaveBeenCalledTimes(1);
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
        mocks.status.mockReturnValue({ enabled: false, ready: false });
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

describe('boat details from Vessel preferences', () => {
    // Shane's screenshot, 2026-10-02: draft, length, beam and air draft all
    // "measured", and the "not confirmed clearance" line still showed.
    const measured = {
        length: { status: 'measured' as const, valueM: 14 },
        beam: { status: 'measured' as const, valueM: 4.9 },
        airDraft: { status: 'measured' as const, valueM: 18.29 },
        draftStatus: 'measured' as const,
    };
    const CAVEAT = /Missing or estimated dimensions are not confirmed clearance/;
    async function openWith(profile: Parameters<typeof AutoroutingTrialWorkspace>[0]['initialVesselProfile']) {
        render(
            <AutoroutingTrialWorkspace
                mapboxToken="fixture-token"
                onClose={vi.fn()}
                initialDraftM={2.4}
                initialSpeedKts={6}
                initialVesselProfile={profile}
            />,
        );
        await waitFor(() => expect(mocks.status).toHaveBeenCalled());
        expect(screen.getByText('Boat details · from Vessel preferences')).toBeInTheDocument();
    }

    it('says nothing about unconfirmed clearance when every dimension is measured', async () => {
        await openWith(structuredClone(measured));
        expect(screen.getAllByText(/· measured$/)).toHaveLength(4);
        expect(screen.queryByText(CAVEAT)).not.toBeInTheDocument();
    });

    it.each([
        ['an estimated beam', { beam: { status: 'estimated' as const, valueM: 4.9 } }],
        ['a missing air draft', { airDraft: { status: 'missing' as const } }],
        ['a missing length', { length: { status: 'missing' as const } }],
        ['an estimated draft', { draftStatus: 'estimated' as const }],
    ])('says it with %s', async (_name, change) => {
        await openWith({ ...structuredClone(measured), ...change });
        expect(screen.getByText(CAVEAT)).toBeInTheDocument();
    });
});
