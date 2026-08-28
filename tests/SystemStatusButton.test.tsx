/**
 * SystemStatusButton — smoke tests (631 LOC component)
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const getTrackingStatus = vi.hoisted(() => vi.fn());
const followRouteState = vi.hoisted(() => ({
    isFollowing: false,
    voyagePlan: null as { origin?: string; destination?: string } | null,
    routeChanged: false,
    isRefreshing: false,
    stopFollowing: vi.fn(),
    acceptRouteChange: vi.fn(),
    dismissRouteChange: vi.fn(),
    refreshRoute: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        isTracking: vi.fn().mockReturnValue(false),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        getActiveVoyage: vi.fn().mockReturnValue(null),
        getTrackingStatus,
        getGpsStatus: vi.fn().mockReturnValue({ hasExternalGps: false, source: 'none' }),
        getGpsNavData: vi.fn().mockReturnValue({ sogKts: null }),
        onTrackingChange: vi.fn().mockReturnValue(vi.fn()),
    },
}));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        isWatching: vi.fn().mockReturnValue(false),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        getSnapshot: vi.fn().mockReturnValue(null),
    },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: vi.fn().mockReturnValue({ latitude: 0, longitude: 0 }),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
}));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: () => followRouteState,
}));

import { SystemStatusButton } from '../components/SystemStatusButton';

describe('SystemStatusButton', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        localStorage.clear();
        getTrackingStatus.mockReturnValue({ isTracking: false, isMoving: false });
        followRouteState.isFollowing = false;
        followRouteState.voyagePlan = null;
        followRouteState.routeChanged = false;
        followRouteState.isRefreshing = false;
    });

    afterEach(() => {
        setAuthIdentityScope(null);
        localStorage.clear();
    });

    it('renders without crashing', () => {
        const { container } = render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders when no systems active (hidden)', () => {
        const { container } = render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        // Component may be empty when no systems are active
        expect(container).toBeDefined();
    });

    it('does not surface a cached active voyage as a duplicate system', () => {
        setAuthIdentityScope('status-owner');
        localStorage.setItem(
            authScopedStorageKey('thalassa_active_voyage'),
            JSON.stringify({
                id: 'active-voyage',
                user_id: 'status-owner',
                vessel_id: 'vessel-1',
                voyage_name: 'Brisbane to Gladstone',
                departure_port: 'Brisbane',
                destination_port: 'Gladstone',
                departure_time: null,
                eta: null,
                crew_count: 1,
                status: 'active',
                weather_master_id: 'status-owner',
                notes: null,
                created_at: '2026-07-26T00:00:00.000Z',
                updated_at: '2026-07-26T00:00:00.000Z',
            }),
        );

        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);

        expect(screen.queryByRole('button', { name: /System status:/ })).not.toBeInTheDocument();
    });

    it('keeps the controllable following-route status', () => {
        followRouteState.isFollowing = true;
        followRouteState.voyagePlan = { origin: 'Brisbane, QLD', destination: 'Gladstone, QLD' };

        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /System status: 1 active/ }));

        expect(screen.getByText('Following Route')).toBeInTheDocument();
        // Named for the row it belongs to. Every SystemRow action button used
        // to carry the same hard-coded "View signal propagation forecast",
        // which described none of them and made two buttons share one
        // accessible name.
        fireEvent.click(screen.getByRole('button', { name: 'Stop Following Route' }));
        expect(followRouteState.stopFollowing).toHaveBeenCalledOnce();
    });

    it('gives every row action its own accessible name', () => {
        followRouteState.isFollowing = true;
        followRouteState.voyagePlan = { origin: 'Brisbane, QLD', destination: 'Gladstone, QLD' };

        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /System status: 1 active/ }));

        // The NMEA row offers a way to the page that can fix it; the route row
        // offers Stop. Two buttons, two names — a screen reader can tell them
        // apart, and so can a query.
        expect(screen.getByRole('button', { name: 'Fix NMEA Backbone' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stop Following Route' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'View signal propagation forecast' })).not.toBeInTheDocument();
    });

    it('contains the active-system modal and restores focus after Escape', () => {
        getTrackingStatus.mockReturnValue({
            isTracking: true,
            isMoving: false,
            currentIntervalMs: 5_000,
            isRapidMode: true,
        });
        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        const opener = screen.getByRole('button', { name: /System status: \d+ active/ });
        opener.focus();
        fireEvent.click(opener);

        const close = screen.getByRole('button', { name: 'Close system status' });
        expect(screen.getByRole('dialog', { name: 'System Status' })).toContainElement(close);
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'System Status' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });
});
