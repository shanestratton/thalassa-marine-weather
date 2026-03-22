/**
 * PassageBanner — component tests.
 *
 * Tests the passage planner overlay that shows route data and controls.
 * This is the newly extracted component from MapHub.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../services/passageGpxExport', () => ({
    exportPassageAsGPX: vi.fn().mockReturnValue('<gpx></gpx>'),
    exportBasicPassageGPX: vi.fn().mockReturnValue('<gpx></gpx>'),
}));

vi.mock('../services/gpxService', () => ({
    shareGPXFile: vi.fn().mockResolvedValue(undefined),
}));

import { PassageBanner } from '../components/map/PassageBanner';

const baseProps = {
    passage: {
        showPassage: true,
        departure: { lat: -27.5, lon: 153.0, name: 'Brisbane' },
        arrival: { lat: -20.0, lon: 148.7, name: 'Airlie Beach' },
        routeAnalysis: { totalDistance: 520, estimatedDuration: 72 },
        departureTime: '2026-03-25T08:00:00Z',
        setShowPassage: vi.fn(),
        isoResultRef: { current: null },
        turnWaypointsRef: { current: [] },
        speed: 6,
    },
    isoProgress: { step: 100, closestNM: 0, totalDistNM: 520, phase: 'complete' },
    mapboxToken: 'pk.test',
    embedded: false,
    isPinView: false,
    deviceMode: 'deck' as const,
};

describe('PassageBanner', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<PassageBanner {...baseProps} />);
        expect(container).toBeDefined();
    });

    it('renders content when passage is active', () => {
        const { container } = render(<PassageBanner {...baseProps} />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('shows departure and arrival names', () => {
        render(<PassageBanner {...baseProps} />);
        expect(screen.getByText(/Brisbane/)).toBeDefined();
        expect(screen.getByText(/Airlie Beach/)).toBeDefined();
    });

    it('renders nothing when showPassage is false', () => {
        const props = {
            ...baseProps,
            passage: { ...baseProps.passage, showPassage: false },
        };
        const { container } = render(<PassageBanner {...props} />);
        // When passage is hidden, the banner should be empty/minimal
        expect(container.textContent!.length).toBeLessThan(10);
    });

    it('does not throw on rerender', () => {
        expect(() => {
            const { rerender } = render(<PassageBanner {...baseProps} />);
            rerender(<PassageBanner {...baseProps} />);
        }).not.toThrow();
    });
});
