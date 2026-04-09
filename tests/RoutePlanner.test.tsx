/**
 * RoutePlanner — smoke tests (764 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils/keyboardScroll', () => ({
    scrollInputAboveKeyboard: vi.fn(),
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
    MapHub: () => <div data-testid="map-hub">Map</div>,
}));
vi.mock('../components/Icons', () => ({
    MapPinIcon: () => <span>📍</span>,
    MapIcon: () => <span>🗺️</span>,
    XIcon: () => <span>✕</span>,
    CrosshairIcon: () => <span>⊕</span>,
    LockIcon: () => <span>🔒</span>,
    CompassIcon: () => <span>🧭</span>,
    CalendarIcon: () => <span>📅</span>,
    ClockIcon: () => <span>🕐</span>,
}));

import { RoutePlanner } from '../components/RoutePlanner';

describe('RoutePlanner', () => {
    beforeEach(() => vi.clearAllMocks());

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
});
