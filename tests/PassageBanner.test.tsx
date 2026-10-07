/**
 * PassageBanner — component tests.
 *
 * Tests the passage planner overlay that shows route data and controls.
 * This is the newly extracted component from MapHub.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

vi.mock('../services/passageGpxExport', () => ({
    exportPassageAsGPX: vi.fn().mockReturnValue('<gpx></gpx>'),
    exportBasicPassageGPX: vi.fn().mockReturnValue('<gpx></gpx>'),
}));

vi.mock('../services/gpxService', () => ({
    shareGPXFile: vi.fn().mockResolvedValue(undefined),
}));

const shipLog = vi.hoisted(() => ({ savePassagePlanToLogbook: vi.fn() }));
vi.mock('../services/ShipLogService', () => ({ ShipLogService: shipLog }));

import { PassageBanner } from '../components/map/PassageBanner';
import { clearPassageRequest, peekPassageRequest, stagePassageRequest } from '../services/passageHandoff';

const baseProps = {
    passage: {
        showPassage: true,
        departure: { lat: -27.5, lon: 153.0, name: 'Brisbane' },
        arrival: { lat: -20.0, lon: 148.7, name: 'Airlie Beach' },
        routeAnalysis: { totalDistance: 520, estimatedDuration: 72 },
        routeVerification: { status: 'verified' as const, geometryKey: 'verified-route' },
        routeActionsAvailable: true,
        departureTime: '2026-03-25T08:00:00Z',
        setShowPassage: vi.fn(),
        clearRoute: vi.fn(),
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
    beforeEach(() => {
        vi.clearAllMocks();
        clearPassageRequest();
    });

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

    it('clears the sticky passage request before hiding the planner', () => {
        stagePassageRequest({
            departure: { lat: -27.5, lon: 153, name: 'Brisbane' },
            arrival: { lat: -20, lon: 148.7, name: 'Airlie Beach' },
        });
        const clearRoute = vi.fn(() => clearPassageRequest());
        const setShowPassage = vi.fn();

        render(
            <PassageBanner
                {...baseProps}
                passage={{
                    ...baseProps.passage,
                    clearRoute,
                    setShowPassage,
                }}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Close passage planner' }));

        expect(clearRoute).toHaveBeenCalledOnce();
        expect(setShowPassage).toHaveBeenCalledWith(false);
        expect(clearRoute.mock.invocationCallOrder[0]).toBeLessThan(setShowPassage.mock.invocationCallOrder[0]);
        expect(peekPassageRequest()).toBeNull();
    });

    // ── Routing notice band (field bug 2026-06-12: refusals were
    //    invisible — blank map read as a hang) ──

    it('renders a warn notice when no cooking band is up', () => {
        render(
            <PassageBanner
                {...baseProps}
                isoProgress={null}
                passageNotice={{
                    severity: 'warn',
                    title: 'Inshore routing unavailable',
                    message: 'Sync the missing cells via Pi Cache.',
                }}
            />,
        );
        expect(screen.getByText('Inshore routing unavailable')).toBeDefined();
        expect(screen.getByText(/Pi Cache/)).toBeDefined();
    });

    it('suppresses the notice while the cooking band is showing', () => {
        render(
            <PassageBanner
                {...baseProps}
                passageNotice={{ severity: 'info', title: 'Computing inshore route…', message: 'Checking charts.' }}
            />,
        );
        expect(screen.queryByText('Computing inshore route…')).toBeNull();
    });

    it('notice renders even with no routeAnalysis (the too-short case)', () => {
        render(
            <PassageBanner
                {...baseProps}
                passage={{ ...baseProps.passage, routeAnalysis: null as never }}
                isoProgress={null}
                passageNotice={{
                    severity: 'warn',
                    title: 'Route too short for passage planning (8 NM)',
                    message: 'Try Community Routes.',
                }}
            />,
        );
        expect(screen.getByText(/Route too short/)).toBeDefined();
    });

    it('withholds Save, GPX and Brief actions while the displayed route is unverified', () => {
        render(
            <PassageBanner
                {...baseProps}
                passage={{
                    ...baseProps.passage,
                    routeVerification: {
                        status: 'unverified',
                        geometryKey: 'candidate-route',
                        reason: 'depth validation timed out',
                    },
                    routeActionsAvailable: false,
                }}
                isoProgress={null}
            />,
        );

        expect(screen.getByTestId('passage-route-unverified')).toHaveTextContent('depth validation timed out');
        expect(screen.queryByRole('button', { name: 'Export GPX' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Share Brief' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save to Log' })).not.toBeInTheDocument();
    });

    // Round-3 review (2026-09-30): saving from the map dropped the route's
    // caveats (bridges not checked, a pin off the water, survey quality).
    it('Save to Log keeps the drawn route’s caveats with the plan', async () => {
        shipLog.savePassagePlanToLogbook.mockResolvedValue('voyage-1');
        const caveats = ['Bridges and power lines not checked on this chart — known bridges are.'];
        render(
            <PassageBanner
                {...baseProps}
                passage={{ ...baseProps.passage, routeCaveats: caveats }}
                isoProgress={null}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Save to Log' }));
        await waitFor(() => expect(shipLog.savePassagePlanToLogbook).toHaveBeenCalledTimes(1));
        const plan = shipLog.savePassagePlanToLogbook.mock.calls[0][0];
        expect(plan.__inshoreRouting).toEqual({ status: 'success', caveats });
    });

    it('shows route actions only for the exact geometry marked verified', () => {
        render(<PassageBanner {...baseProps} isoProgress={null} />);

        expect(screen.getByRole('button', { name: 'Export GPX' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Share Brief' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Save to Log' })).toBeEnabled();
        expect(screen.queryByTestId('passage-route-unverified')).not.toBeInTheDocument();
    });
    // W1-03 slice 1b: the banner says plainly which polar the ETA was sailed on.
    describe('which polar the route sailed by', () => {
        it('names a database polar and the cruising speed its shape was scaled to', () => {
            render(
                <PassageBanner
                    {...baseProps}
                    passage={{
                        ...baseProps.passage,
                        routingPolarLabel: 'Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)',
                    }}
                    isoProgress={null}
                />,
            );
            expect(screen.getByTestId('passage-routing-polar')).toHaveTextContent(
                'Polar: Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)',
            );
        });

        it('says so when the generic polar was used, and when the learned one was', () => {
            const { rerender } = render(
                <PassageBanner
                    {...baseProps}
                    passage={{ ...baseProps.passage, routingPolarLabel: 'Generic cruising polar' }}
                    isoProgress={null}
                />,
            );
            expect(screen.getByTestId('passage-routing-polar')).toHaveTextContent('Polar: Generic cruising polar');
            rerender(
                <PassageBanner
                    {...baseProps}
                    passage={{ ...baseProps.passage, routingPolarLabel: 'Learned (blended)' }}
                    isoProgress={null}
                />,
            );
            expect(screen.getByTestId('passage-routing-polar')).toHaveTextContent('Polar: Learned (blended)');
        });

        it('a long file name with no spaces wraps inside the card instead of being clipped', () => {
            // An imported polar is named after its file, and the card is
            // overflow-x-hidden: at 320 px a 40-character token ran off the
            // edge mid-word. jsdom has no layout, so pin the wrap rule itself.
            const label = 'Fair_Wind_Expedition_polar_export_2026_final.pol (imported)';
            render(
                <PassageBanner
                    {...baseProps}
                    passage={{ ...baseProps.passage, routingPolarLabel: label }}
                    isoProgress={null}
                />,
            );
            const line = screen.getByTestId('passage-routing-polar');
            expect(line).toHaveTextContent(`Polar: ${label}`);
            expect(line.className).toContain('[overflow-wrap:anywhere]');
            expect(line.className).toContain('min-w-0');
        });

        it('no line while the route is cooking, or for a route no polar sailed (inshore, short hops)', () => {
            const { rerender } = render(
                <PassageBanner
                    {...baseProps}
                    passage={{ ...baseProps.passage, routingPolarLabel: 'Generic cruising polar' }}
                />,
            );
            expect(screen.queryByTestId('passage-routing-polar')).not.toBeInTheDocument();
            rerender(
                <PassageBanner
                    {...baseProps}
                    passage={{ ...baseProps.passage, routingPolarLabel: null }}
                    isoProgress={null}
                />,
            );
            expect(screen.queryByTestId('passage-routing-polar')).not.toBeInTheDocument();
        });
    });
});
