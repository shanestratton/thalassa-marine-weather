/**
 * RoutePlanner — smoke tests (764 LOC component)
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    canonicalRoutes: [] as Array<Record<string, unknown>>,
    mergedRoutes: [] as Array<Record<string, unknown>>,
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
vi.mock('../services/routeTracer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/routeTracer')>();
    return { ...actual, deleteTrace: plannerMocks.deleteTrace };
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
}));

import { RoutePlanner } from '../components/RoutePlanner';

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
        plannerMocks.consumeSavedRoutesLibraryOpen.mockReturnValue(false);
        plannerMocks.deleteLogbookRouteFromLibrary.mockResolvedValue(true);
        plannerMocks.deleteTrace.mockReturnValue(true);
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
        fireEvent.click(screen.getByLabelText('Page actions'));
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

    it('renders without crashing', () => {
        const { container } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
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
