/**
 * RoutePlanner — smoke tests (764 LOC component)
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SavedTrace } from '../services/routeTracer';
import type { ComfortParams } from '../types';

const routePlannerState = vi.hoisted(() => ({
    isMapOpen: false,
    setIsMapOpen: vi.fn(),
    voyagePlan: null as Record<string, unknown> | null,
}));

const plannerMocks = vi.hoisted(() => ({
    setPage: vi.fn(),
    requestTracerOpen: vi.fn(),
    consumeSavedRoutesLibraryOpen: vi.fn(),
    loadSavedRouteLibrary: vi.fn(),
    deleteLogbookRouteFromLibrary: vi.fn(),
    deleteTrace: vi.fn(),
    fetchSeaVoyageChoices: vi.fn(),
    canonicalRoutes: [] as Array<Record<string, unknown>>,
    mergedRoutes: [] as Array<Record<string, unknown>>,
    savedTraces: [] as SavedTrace[],
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
    // settingsStore calls getSystemUnits() at module init via the utils barrel —
    // return the real metric defaults so the store builds deterministically.
    getSystemUnits: () => ({
        speed: 'kts',
        length: 'm',
        waveHeight: 'm',
        tideHeight: 'm',
        temp: 'C',
        distance: 'nm',
        visibility: 'nm',
        volume: 'l',
    }),
}));
vi.mock('../utils/keyboardScroll', () => ({
    scrollInputAboveKeyboard: vi.fn(),
    subscribeKeyboardHeight: vi.fn(() => () => {}),
}));
vi.mock('../hooks/useVoyageForm', () => ({
    useVoyageForm: () => ({
        origin: '',
        setOrigin: vi.fn(),
        destination: '',
        setDestination: vi.fn(),
        isMapOpen: routePlannerState.isMapOpen,
        setIsMapOpen: routePlannerState.setIsMapOpen,
        mapSelectionTarget: null,
        loading: false,
        loadingStep: 0,
        error: null,
        handleCalculate: vi.fn(),
        clearVoyagePlan: vi.fn(),
        handleOriginLocation: vi.fn(),
        handleMapSelect: vi.fn(),
        openMap: vi.fn(),
        voyagePlan: routePlannerState.voyagePlan,
        vessel: null,
        isPro: true,
        mapboxToken: 'test-token',
    }),
    LOADING_PHASES: [],
}));
vi.mock('../context/UIContext', () => ({
    useUI: () => ({
        setPage: plannerMocks.setPage,
        page: 'voyage',
    }),
}));
vi.mock('../services/deepLink', () => ({
    requestTracerOpen: plannerMocks.requestTracerOpen,
    consumeSavedRoutesLibraryOpen: plannerMocks.consumeSavedRoutesLibraryOpen,
    initialViewFromUrl: () => null,
    isBuilderDeepLink: () => false,
}));
vi.mock('../services/savedRouteLibrary', () => ({
    loadSavedRouteLibrary: plannerMocks.loadSavedRouteLibrary,
    deleteLogbookRouteFromLibrary: plannerMocks.deleteLogbookRouteFromLibrary,
}));
vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchSeaVoyageChoices: plannerMocks.fetchSeaVoyageChoices,
}));
// Exercise the real planner CTA and existing library handoffs here; the
// dialog's actual entitlement, portal, focus and Auto workspace live in its
// own suite. This child intentionally has no page or tracer callback for Auto.
vi.mock('../components/autorouting/RoutingModeDialog', () => ({
    RoutingModeDialog: ({
        mapboxToken,
        onClose,
        onManual,
    }: {
        mapboxToken: string;
        onClose: () => void;
        onManual: () => void;
    }) => {
        const [auto, setAuto] = React.useState(false);
        return (
            <div role="dialog" aria-label="Routing mode choice" data-mapbox-token={mapboxToken}>
                <button type="button" onClick={onClose}>
                    Close routing choice
                </button>
                {auto ? (
                    <div role="region" aria-label="Isolated auto workspace">
                        Unsaved auto proposal
                    </div>
                ) : (
                    <>
                        <button type="button" onClick={onManual}>
                            Manual
                        </button>
                        <button type="button" onClick={() => setAuto(true)}>
                            Auto Routing
                        </button>
                    </>
                )}
            </div>
        );
    },
}));
vi.mock('../services/routeTracer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/routeTracer')>();
    return { ...actual, deleteTrace: plannerMocks.deleteTrace, loadSavedTraces: () => plannerMocks.savedTraces };
});
vi.mock('../components/map/MapHub', () => ({
    MapHub: (props: { cleanPlanningMap?: boolean }) => (
        <div data-testid="map-hub" data-clean-planning-map={String(props.cleanPlanningMap === true)}>
            Map
        </div>
    ),
}));
vi.mock('../components/Icons', () => ({
    MapPinIcon: () => <span>📍</span>,
    MapIcon: () => <span>🗺️</span>,
    XIcon: () => <span>✕</span>,
    CrosshairIcon: () => <span>⊕</span>,
    LockIcon: () => <span>🔒</span>,
    CompassIcon: () => <span>🧭</span>,
    CalendarIcon: () => <span>📅</span>,
    CalendarGridIcon: () => <span>🗓️</span>,
    ClockIcon: () => <span>🕐</span>,
    SailBoatIcon: () => <span>⛵</span>,
    PowerBoatIcon: () => <span>🚤</span>,
    AlertTriangleIcon: () => <span>⚠</span>,
    DownloadIcon: () => <span>⬇</span>,
    RouteIcon: () => <span>↝</span>,
    FlagIcon: () => <span>⚑</span>,
    SunIcon: () => <span>☀</span>,
}));

import { RoutePlanner } from '../components/RoutePlanner';
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';
import { authScopedStorageKey } from '../services/authIdentityScope';
import { localDateStr } from '../components/passage/TimePicker24';

/**
 * Perform the right-to-left reveal gesture on a saved-route row.
 *
 * Delete is no longer a permanently-visible column (Shane 2026-09-02) — it
 * hides behind a swipe like every other list in the app — so a test that
 * wants the button must earn it the way a thumb does.
 */
function swipeRowLeft(row: HTMLElement): void {
    const touch = (clientX: number) => ({ clientX, clientY: 0 }) as unknown as Touch;
    fireEvent.touchStart(row, { touches: [touch(300)] });
    fireEvent.touchMove(row, { touches: [touch(200)] });
    fireEvent.touchEnd(row, { changedTouches: [touch(200)] });
}

describe('RoutePlanner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        routePlannerState.isMapOpen = false;
        routePlannerState.voyagePlan = null;
        plannerMocks.canonicalRoutes = [];
        plannerMocks.mergedRoutes = [];
        plannerMocks.savedTraces = [];
        plannerMocks.consumeSavedRoutesLibraryOpen.mockReturnValue(false);
        plannerMocks.deleteLogbookRouteFromLibrary.mockResolvedValue(true);
        plannerMocks.deleteTrace.mockReturnValue(true);
        plannerMocks.fetchSeaVoyageChoices.mockResolvedValue([]);
        plannerMocks.loadSavedRouteLibrary.mockImplementation(
            async (_scope: unknown, onCanonical?: (routes: Array<Record<string, unknown>>) => void) => {
                onCanonical?.(plannerMocks.canonicalRoutes);
                return plannerMocks.mergedRoutes;
            },
        );
    });

    it('keeps Import GPX out of the front door and behind the header menu, centred', async () => {
        // Shane 2026-09-02: "remove the import gpx from the routeplanning
        // page. maybe put it under a 3 dot menu at the top of the page, in a
        // modal box (centered of course)". A once-in-a-while errand should
        // not sit between the two everyday doors.
        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);

        // Not on the front door.
        expect(screen.queryByText('Import GPX')).toBeNull();

        // Behind the kebab.
        fireEvent.click(screen.getByRole('button', { name: 'Route Planner actions' }));
        const item = await screen.findByText('Import GPX');

        // The dialog obeys the standing centred-modal rule.
        const dialog = item.closest('[role="dialog"]');
        expect(dialog).not.toBeNull();
        const overlay = dialog?.parentElement;
        expect(overlay?.className).toContain('items-center');
        expect(overlay?.className).toContain('justify-center');
        expect(dialog?.className).toContain('max-h-full');
        // Portalled out of the page's transformed subtree, or `fixed` would
        // mean the page box rather than the screen.
        expect(overlay?.parentElement).toBe(document.body);

        fireEvent.click(item);
        expect(plannerMocks.setPage).toHaveBeenCalledWith('gpx-import');
    });

    it('names the front-door cards by title, describes them by what is actually there, and groups them', async () => {
        // UX scorecard run 6: "Open one" showed with nothing saved, and the
        // card names ran title and subline together.
        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);

        expect(screen.getByRole('group', { name: 'Or start from' })).toBeInTheDocument();
        const saved = screen.getByRole('button', { name: 'Saved routes' });
        const voyages = screen.getByRole('button', { name: 'Past voyages' });
        expect(saved).toHaveAccessibleDescription('None saved on this device yet');
        expect(voyages).toHaveAccessibleDescription('Turn a logged voyage into a route');

        // Once the library has actually loaded, the card says so.
        fireEvent.click(saved);
        expect(await screen.findByRole('heading', { name: 'Saved routes' })).toBeInTheDocument();
        await waitFor(() => expect(saved).toHaveAccessibleDescription('None saved yet'));
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));

        plannerMocks.fetchSeaVoyageChoices.mockResolvedValue([
            {
                voyageId: 'v1',
                label: 'Newport → Tangalooma',
                sublabel: '9 Sept · 18 NM',
                timestamp: 1,
                distanceNm: 18,
                isLocal: false,
            },
        ]);
        fireEvent.click(voyages);
        expect(await screen.findByRole('heading', { name: 'Past voyages' })).toBeInTheDocument();
        await waitFor(() => expect(voyages).toHaveAccessibleDescription('1 voyage to reuse'));
    });

    it('gives the empty Saved routes library a way on instead of a dead end (UX scorecard run 7)', async () => {
        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Saved routes' }));
        const dialog = await screen.findByRole('dialog', { name: 'Saved routes' });
        expect(await within(dialog).findByText('No saved routes yet — plot one and save it.')).toBeVisible();

        fireEvent.click(within(dialog).getByRole('button', { name: 'Start plotting' }));
        expect(screen.queryByRole('dialog', { name: 'Saved routes' })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Routing mode choice' })).toBeInTheDocument();
        expect(plannerMocks.setPage).not.toHaveBeenCalled();
        expect(plannerMocks.requestTracerOpen).not.toHaveBeenCalled();
    });

    it('counts saved routes already on this device before the library opens', () => {
        plannerMocks.savedTraces = [
            {
                id: 'local-a',
                name: 'Newport - Musgrave',
                createdAt: '2026-09-09T00:00:00Z',
                points: [
                    { lat: -27.2, lon: 153.1 },
                    { lat: -23.9, lon: 152.4 },
                ],
            },
        ];
        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Saved routes' })).toHaveAccessibleDescription(
            '1 saved · timings refreshed for today’s tide',
        );
    });

    it('renders without crashing', () => {
        const { container } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });

    it.each([false, true])(
        'temporarily hides Comfort without a gap, disabling planning or resetting limits (embedded=%s)',
        async (embedded) => {
            await awaitSettingsLoaded();
            const previousSettings = useSettingsStore.getState().settings;
            const comfortParams: ComfortParams = {
                maxWindKts: 22,
                maxWaveM: 1.5,
                preferredAngles: ['beam_reach', 'broad_reach'],
            };
            useSettingsStore.setState({ settings: { ...previousSettings, comfortParams } });
            const departureKey = authScopedStorageKey('thalassa_trace_departure_ms');
            const previousDeparture = sessionStorage.getItem(departureKey);
            plannerMocks.savedTraces = [
                {
                    id: 'comfort-hidden-trip',
                    name: 'Newport - Musgrave',
                    createdAt: '2026-09-09T00:00:00Z',
                    points: [
                        { lat: -27.2, lon: 153.1 },
                        { lat: -23.9, lon: 152.4 },
                    ],
                },
            ];
            const { container, unmount } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} embedded={embedded} />);
            try {
                expect(screen.queryByRole('button', { name: /Comfort/i })).not.toBeInTheDocument();
                expect(screen.queryByText('Comfort', { exact: true })).not.toBeInTheDocument();
                expect(screen.queryByLabelText('Max acceptable wind speed')).not.toBeInTheDocument();

                const tripPicker = screen.getByRole('button', { name: 'Trip · Legs' });
                // The hidden card's wrapper must disappear too: an empty
                // sibling still earns space-y margin. The plot settings card
                // (Departure, then the vessel) leads the form, with the ways in
                // after it and no empty gap; the Trip tile comes first of those.
                const firstFormCard = container.querySelector('.route-planner-form > div')?.firstElementChild;
                // (The mocked ClockIcon draws text, hence the pattern.)
                expect(firstFormCard).toContainElement(screen.getByRole('group', { name: /Departure$/ }));
                const doors = screen.getByRole('group', { name: 'Or start from' });
                expect(firstFormCard?.nextElementSibling?.nextElementSibling).toBe(doors);
                expect(doors.firstElementChild).toContainElement(tripPicker);
                expect(doors.lastElementChild).toBe(screen.getByRole('button', { name: 'Plan Your Day' }));
                // 126-16a: the tile opens the Trip sheet; a leg card opens that leg.
                fireEvent.click(tripPicker);
                const trips = await screen.findByRole('dialog', { name: 'Your trips' });
                fireEvent.click(within(trips).getByRole('button', { name: /^Newport - Musgrave/ }));
                fireEvent.click(screen.getByRole('button', { name: /^Leg 1: Newport - Musgrave/ }));
                expect(plannerMocks.requestTracerOpen).toHaveBeenLastCalledWith(
                    { kind: 'load-saved', id: 'comfort-hidden-trip' },
                    expect.objectContaining({ key: 'anonymous' }),
                );
                // A pick closes the sheet as it hands over to the chart.
                expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

                const date = localDateStr(new Date(Date.now() + 3 * 86_400_000));
                fireEvent.change(screen.getByLabelText('Departure date'), { target: { value: date } });
                fireEvent.change(screen.getByLabelText('Departure hour (24-hour)'), { target: { value: '13' } });
                fireEvent.change(screen.getByLabelText('Departure minutes'), { target: { value: '35' } });
                expect(screen.getByLabelText('Departure date')).toHaveValue(date);
                expect(screen.getByLabelText('Departure hour (24-hour)')).toHaveValue('13');
                expect(screen.getByLabelText('Departure minutes')).toHaveValue('35');

                expect(screen.getByRole('button', { name: /Past voyages/ })).toBeEnabled();
                fireEvent.click(screen.getByRole('button', { name: /Saved routes/i }));
                expect(await screen.findByRole('dialog', { name: /Saved routes/i })).toBeInTheDocument();
                fireEvent.click(screen.getByRole('button', { name: 'Close' }));

                const plot = screen.getByRole('button', { name: 'Start plotting' });
                expect(plot).toBeEnabled();
                const previousHandoffs = plannerMocks.requestTracerOpen.mock.calls.length;
                const previousNavigations = plannerMocks.setPage.mock.calls.length;
                fireEvent.click(plot);
                expect(screen.getByRole('dialog', { name: 'Routing mode choice' })).toBeInTheDocument();
                expect(plannerMocks.requestTracerOpen).toHaveBeenCalledTimes(previousHandoffs);
                expect(plannerMocks.setPage).toHaveBeenCalledTimes(previousNavigations);
                fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
                expect(screen.queryByRole('dialog', { name: 'Routing mode choice' })).not.toBeInTheDocument();
                expect(plannerMocks.requestTracerOpen).toHaveBeenLastCalledWith();
                expect(plannerMocks.setPage).toHaveBeenLastCalledWith('map');
                expect(useSettingsStore.getState().settings.comfortParams).toBe(comfortParams);
            } finally {
                unmount();
                useSettingsStore.setState({ settings: previousSettings });
                if (previousDeparture === null) sessionStorage.removeItem(departureKey);
                else sessionStorage.setItem(departureKey, previousDeparture);
            }
        },
    );

    it('opens a routing choice only after Start plotting, and closing/reopening preserves the planner and departure', async () => {
        await awaitSettingsLoaded();
        const departureKey = authScopedStorageKey('thalassa_trace_departure_ms');
        const previousDeparture = sessionStorage.getItem(departureKey);
        const { unmount } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        try {
            expect(screen.queryByRole('dialog', { name: 'Routing mode choice' })).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /Autorouting.*Trial/i })).not.toBeInTheDocument();
            const date = localDateStr(new Date(Date.now() + 3 * 86_400_000));
            fireEvent.change(screen.getByLabelText('Departure date'), { target: { value: date } });
            const savedDeparture = sessionStorage.getItem(departureKey);

            for (let attempt = 0; attempt < 2; attempt++) {
                fireEvent.click(screen.getByRole('button', { name: 'Start plotting' }));
                expect(screen.getByRole('dialog', { name: 'Routing mode choice' })).toHaveAttribute(
                    'data-mapbox-token',
                    'test-token',
                );
                expect(plannerMocks.requestTracerOpen).not.toHaveBeenCalled();
                expect(plannerMocks.setPage).not.toHaveBeenCalled();
                fireEvent.click(screen.getByRole('button', { name: 'Close routing choice' }));
                expect(screen.queryByRole('dialog', { name: 'Routing mode choice' })).not.toBeInTheDocument();
                expect(screen.getByLabelText('Departure date')).toHaveValue(date);
                expect(sessionStorage.getItem(departureKey)).toBe(savedDeparture);
                expect(screen.getByRole('button', { name: /Saved routes/i })).toBeEnabled();
                expect(screen.getByRole('button', { name: /Past voyages/i })).toBeEnabled();
            }
            expect(plannerMocks.requestTracerOpen).not.toHaveBeenCalled();
            expect(plannerMocks.setPage).not.toHaveBeenCalled();
        } finally {
            unmount();
            if (previousDeparture === null) sessionStorage.removeItem(departureKey);
            else sessionStorage.setItem(departureKey, previousDeparture);
        }
    });

    it('does not stage a tracer action or navigate when Auto stays in its isolated child workspace', () => {
        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start plotting' }));
        fireEvent.click(screen.getByRole('button', { name: 'Auto Routing' }));
        expect(screen.getByRole('region', { name: 'Isolated auto workspace' })).toBeInTheDocument();
        expect(plannerMocks.requestTracerOpen).not.toHaveBeenCalled();
        expect(plannerMocks.setPage).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Close routing choice' }));
        expect(screen.queryByRole('region', { name: 'Isolated auto workspace' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Start plotting' })).toBeInTheDocument();
        expect(plannerMocks.requestTracerOpen).not.toHaveBeenCalled();
        expect(plannerMocks.setPage).not.toHaveBeenCalled();
    });

    it('keeps next-leg selection as its original identity-fenced direct chart handoff', async () => {
        plannerMocks.savedTraces = [
            {
                id: 'leg-one',
                name: 'Newport - Musgrave',
                createdAt: '2026-09-09T00:00:00Z',
                points: [
                    { lat: -27.2, lon: 153.1 },
                    { lat: -23.9, lon: 152.4 },
                ],
            },
        ];
        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        // 126-16a: Trip · Legs → the trip → "+ Add the 2nd leg" → plot it by hand.
        fireEvent.click(screen.getByRole('button', { name: 'Trip · Legs' }));
        const trips = await screen.findByRole('dialog', { name: 'Your trips' });
        fireEvent.click(within(trips).getByRole('button', { name: /^Newport - Musgrave/ }));
        fireEvent.click(screen.getByRole('button', { name: '+ Add the 2nd leg from Musgrave' }));
        fireEvent.click(screen.getByRole('button', { name: '✎ Plot it by hand' }));
        expect(plannerMocks.requestTracerOpen).toHaveBeenCalledExactlyOnceWith(
            { kind: 'new-leg', fromId: 'leg-one' },
            expect.objectContaining({ key: 'anonymous' }),
        );
        expect(plannerMocks.setPage).toHaveBeenCalledExactlyOnceWith('map');
        expect(screen.queryByRole('dialog', { name: 'Routing mode choice' })).not.toBeInTheDocument();
    });

    it('keeps past voyages as their original identity-fenced direct chart handoff', async () => {
        const choice = {
            voyageId: 'past-voyage',
            label: 'Mackay Harbour → Whitsundays',
            sublabel: '9 Sept · 18 NM sailed',
            timestamp: Date.parse('2026-09-09T00:00:00Z'),
            distanceNm: 18,
            isLocal: false,
        };
        plannerMocks.fetchSeaVoyageChoices.mockResolvedValue([choice]);
        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Past voyages/i }));
        const voyageButton = await screen.findByRole('button', { name: /Mackay Harbour → Whitsundays/i });
        expect(voyageButton).toHaveTextContent('9 Sept · 18 NM sailed');
        fireEvent.click(voyageButton);
        expect(plannerMocks.requestTracerOpen).toHaveBeenCalledExactlyOnceWith(
            { kind: 'load-voyage', choice },
            expect.objectContaining({ key: 'anonymous' }),
        );
        expect(plannerMocks.setPage).toHaveBeenCalledExactlyOnceWith('map');
        expect(screen.queryByRole('dialog', { name: 'Routing mode choice' })).not.toBeInTheDocument();
    });

    it('exposes the short-landscape layout hooks that keep the CTA out of the departure controls', () => {
        const { container } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);

        expect(container.querySelector('.route-planner-page')).toBeInTheDocument();
        expect(container.querySelector('.route-planner-form')).toBeInTheDocument();
        expect(container.querySelector('.route-planner-map')).toBeInTheDocument();
        expect(container.querySelector('.route-planner-cta')).toBeInTheDocument();
    });

    it('accepts onBack callback', () => {
        expect(() => {
            render(<RoutePlanner onTriggerUpgrade={vi.fn()} onBack={vi.fn()} />);
        }).not.toThrow();
    });

    it('contains the full-screen map, closes it with Escape, and restores focus', async () => {
        const { rerender } = render(
            <>
                <button type="button">Open map</button>
                <RoutePlanner onTriggerUpgrade={vi.fn()} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Open map' });
        opener.focus();

        routePlannerState.isMapOpen = true;
        rerender(
            <>
                <button type="button">Open map</button>
                <RoutePlanner onTriggerUpgrade={vi.fn()} />
            </>,
        );

        const dialog = screen.getByRole('dialog', { name: 'Route map' });
        const close = screen.getByRole('button', { name: 'Go back to previous page' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        await waitFor(() => expect(close).toHaveFocus());

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(routePlannerState.setIsMapOpen).toHaveBeenCalledWith(false);

        routePlannerState.isMapOpen = false;
        rerender(
            <>
                <button type="button">Open map</button>
                <RoutePlanner onTriggerUpgrade={vi.fn()} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('marks both planner-owned map surfaces as clean planning maps', async () => {
        routePlannerState.isMapOpen = true;
        routePlannerState.voyagePlan = {
            origin: 'Brisbane',
            destination: 'Moreton Island',
            originCoordinates: { lat: -27.4698, lon: 153.0251 },
            destinationCoordinates: { lat: -27.163, lon: 153.442 },
            distanceApprox: '24 NM',
            durationApprox: '4h',
            waypoints: [],
        };

        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);

        // MapHub is lazy-loaded in the planner now (same pattern as App.tsx), so await its mount.
        const maps = await screen.findAllByTestId('map-hub');
        expect(maps).toHaveLength(2);
        for (const map of maps) {
            expect(map).toHaveAttribute('data-clean-planning-map', 'true');
        }
    });

    it('contains the route picker, closes it with Escape, and restores focus', async () => {
        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        const opener = screen.getByRole('button', { name: /Saved routes/i });
        opener.focus();

        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: /Saved routes/i });
        const close = screen.getByRole('button', { name: 'Close' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Escape' });
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByRole('dialog', { name: /Saved routes/i })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('opens canonical and recovered Log routes through their distinct identity-fenced handoffs', async () => {
        plannerMocks.canonicalRoutes = [
            {
                source: 'saved-trace',
                key: 'saved:trace-a',
                routeId: 'trace-a',
                label: 'Canonical route',
                points: [
                    { lat: -27.47, lon: 153.02 },
                    { lat: -27.1, lon: 153.4 },
                ],
                timestamp: Date.parse('2026-07-20T00:00:00.000Z'),
            },
        ];
        plannerMocks.mergedRoutes = [
            ...plannerMocks.canonicalRoutes,
            {
                source: 'logbook-route',
                key: 'logbook:planned-old',
                voyageId: 'planned-old',
                label: 'Recovered route',
                sublabel: 'Planned · 18 NM',
                points: [
                    { lat: -26.8, lon: 153.1 },
                    { lat: -26.5, lon: 153.3 },
                ],
                timestamp: Date.parse('2026-07-19T00:00:00.000Z'),
                isLocal: false,
            },
        ];

        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Saved routes/i }));

        const canonical = await screen.findByRole('button', { name: /^Canonical route/ });
        const recovered = await screen.findByRole('button', { name: /^Recovered route/ });
        expect(recovered).toHaveTextContent('recovered from Log');

        fireEvent.click(canonical);
        expect(plannerMocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'load-saved', id: 'trace-a' },
            expect.objectContaining({ key: 'anonymous' }),
        );
        expect(plannerMocks.setPage).toHaveBeenLastCalledWith('map');

        fireEvent.click(recovered);
        expect(plannerMocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'load-logbook-route', voyageId: 'planned-old' },
            expect.objectContaining({ key: 'anonymous' }),
        );
        expect(plannerMocks.setPage).toHaveBeenCalledTimes(2);
    });

    it('requires confirmation before deleting a recovered Log route from Saved Routes', async () => {
        let finishDeletion!: (removed: boolean) => void;
        plannerMocks.deleteLogbookRouteFromLibrary.mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                finishDeletion = resolve;
            }),
        );
        plannerMocks.mergedRoutes = [
            {
                source: 'logbook-route',
                key: 'logbook:planned_old',
                voyageId: 'planned_old',
                label: 'Recovered route',
                sublabel: 'Planned · 18 NM',
                points: [
                    { lat: -26.8, lon: 153.1 },
                    { lat: -26.5, lon: 153.3 },
                ],
                timestamp: Date.parse('2026-07-19T00:00:00.000Z'),
                isLocal: false,
            },
        ];

        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Saved routes/i }));

        // Swipe the row to reveal its delete — the button is hidden until then.
        const row = await screen.findByRole('button', { name: /Recovered route/ });
        expect(screen.queryByRole('button', { name: 'Delete Recovered route' })).toBeNull();
        swipeRowLeft(row);

        const deleteButton = await screen.findByRole('button', { name: 'Delete Recovered route' });
        fireEvent.click(deleteButton);
        expect(plannerMocks.deleteLogbookRouteFromLibrary).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Recovered route' }));
        await waitFor(() =>
            expect(plannerMocks.deleteLogbookRouteFromLibrary).toHaveBeenCalledWith(
                'planned_old',
                expect.objectContaining({ key: 'anonymous' }),
            ),
        );
        expect(screen.getByRole('button', { name: /^Recovered route/ })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Confirm delete Recovered route' })).toBeDisabled();

        await act(async () => {
            finishDeletion(true);
            await Promise.resolve();
        });
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Recovered route/ })).not.toBeInTheDocument());
    });

    it('allows an individual canonical saved route to be deleted from the Saved Routes library', async () => {
        plannerMocks.canonicalRoutes = [
            {
                source: 'saved-trace',
                key: 'saved:trace-a',
                routeId: 'trace-a',
                label: 'Canonical route',
                points: [
                    { lat: -27.47, lon: 153.02 },
                    { lat: -27.1, lon: 153.4 },
                ],
                timestamp: Date.parse('2026-07-20T00:00:00.000Z'),
            },
        ];
        plannerMocks.mergedRoutes = plannerMocks.canonicalRoutes;

        render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Saved routes/i }));

        // Swipe the row to reveal its delete — the button is hidden until then.
        const row = await screen.findByRole('button', { name: /Canonical route/ });
        expect(screen.queryByRole('button', { name: 'Delete Canonical route' })).toBeNull();
        swipeRowLeft(row);

        const deleteButton = await screen.findByRole('button', { name: 'Delete Canonical route' });
        fireEvent.click(deleteButton);
        expect(plannerMocks.deleteTrace).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Canonical route' }));
        await waitFor(() =>
            expect(plannerMocks.deleteTrace).toHaveBeenCalledWith(
                'trace-a',
                expect.objectContaining({ key: 'anonymous' }),
            ),
        );
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Canonical route/ })).not.toBeInTheDocument());
    });

    it('honours a one-shot auto-open intent through StrictMode effect replay', async () => {
        plannerMocks.consumeSavedRoutesLibraryOpen.mockReturnValue(true);

        render(
            <React.StrictMode>
                <RoutePlanner onTriggerUpgrade={vi.fn()} />
            </React.StrictMode>,
        );

        expect(await screen.findByRole('dialog', { name: /Saved routes/i })).toBeInTheDocument();
        expect(plannerMocks.consumeSavedRoutesLibraryOpen).toHaveBeenCalledOnce();
        await waitFor(() => expect(plannerMocks.loadSavedRouteLibrary).toHaveBeenCalled());
    });
});
