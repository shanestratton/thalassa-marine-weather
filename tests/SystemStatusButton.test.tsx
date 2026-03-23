/**
 * SystemStatusButton — smoke tests (631 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        isTracking: vi.fn().mockReturnValue(false),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        getActiveVoyage: vi.fn().mockReturnValue(null),
        getTrackingStatus: vi.fn().mockReturnValue({ isTracking: false, isMoving: false }),
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
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders when no systems active (hidden)', () => {
        const { container } = render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        // Component may be empty when no systems are active
        expect(container).toBeDefined();
    });
});
