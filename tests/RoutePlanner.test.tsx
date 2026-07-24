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
        setPage: vi.fn(),
        page: 'voyage',
    }),
}));
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

describe('RoutePlanner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        routePlannerState.isMapOpen = false;
        routePlannerState.voyagePlan = null;
    });

    it('renders without crashing', () => {
        const { container } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<RoutePlanner onTriggerUpgrade={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
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

    it('marks both planner-owned map surfaces as clean planning maps', () => {
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

        const maps = screen.getAllByTestId('map-hub');
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
});
