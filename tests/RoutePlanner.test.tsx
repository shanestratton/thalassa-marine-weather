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
        form: { departure: '', arrival: '', date: new Date().toISOString(), passengers: 2 },
        setField: vi.fn(),
        submit: vi.fn(),
        loading: false,
        error: null,
        result: null,
        phase: null,
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
vi.mock('../components/ui/SlideToAction', () => ({
    SlideToAction: ({ children }: { children: React.ReactNode }) => <div data-testid="slide-to-action">{children}</div>,
}));
vi.mock('../components/VoyageResults', () => ({
    VoyageResults: () => <div data-testid="voyage-results">Results</div>,
}));
vi.mock('../components/Icons', () => ({
    MapPinIcon: () => <span>📍</span>,
    MapIcon: () => <span>🗺️</span>,
    RouteIcon: () => <span>🛤️</span>,
    CalendarIcon: () => <span>📅</span>,
    CrosshairIcon: () => <span>⊕</span>,
    XIcon: () => <span>✕</span>,
    ClockIcon: () => <span>🕐</span>,
    LockIcon: () => <span>🔒</span>,
    BugIcon: () => <span>🐛</span>,
    CompassIcon: () => <span>🧭</span>,
    PowerBoatIcon: () => <span>🚤</span>,
    SailBoatIcon: () => <span>⛵</span>,
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
