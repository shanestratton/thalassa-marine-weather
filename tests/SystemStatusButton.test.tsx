/**
 * SystemStatusButton — smoke tests (631 LOC component)
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTrackingStatus = vi.hoisted(() => vi.fn());

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
    useFollowRouteStore: () => ({ isActive: false }),
}));

import { SystemStatusButton } from '../components/SystemStatusButton';

describe('SystemStatusButton', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getTrackingStatus.mockReturnValue({ isTracking: false, isMoving: false });
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
