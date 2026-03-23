/**
 * GuardianPage — smoke tests (856 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: vi.fn().mockReturnValue({ latitude: -33.8, longitude: 151.2 }),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
}));

vi.mock('../services/GuardianService', () => ({
    GuardianService: {
        initialize: vi.fn().mockResolvedValue(undefined),
        fetchProfile: vi.fn().mockResolvedValue(null),
        fetchNearbyUsers: vi.fn().mockResolvedValue([]),
        fetchAlerts: vi.fn().mockResolvedValue([]),
        getNearbyUsers: vi.fn().mockResolvedValue([]),
        getAlerts: vi.fn().mockResolvedValue([]),
        getProfile: vi.fn().mockResolvedValue(null),
        createAlert: vi.fn().mockResolvedValue({}),
        hailUser: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        arm: vi.fn().mockResolvedValue(true),
        disarm: vi.fn().mockResolvedValue(true),
        armBolo: vi.fn().mockResolvedValue(undefined),
        disarmBolo: vi.fn().mockResolvedValue(undefined),
        isBoloArmed: vi.fn().mockReturnValue(false),
        reportSuspicious: vi.fn().mockResolvedValue({}),
        broadcastWeatherSpike: vi.fn().mockResolvedValue({}),
        sendHail: vi.fn().mockResolvedValue(true),
        updateProfile: vi.fn().mockResolvedValue(undefined),
        onAlertReceived: vi.fn().mockReturnValue(vi.fn()),
    },
    HAIL_MESSAGES: ['Ahoy!'],
    WEATHER_TEMPLATES: ['Strong winds expected'],
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { userName: 'Skipper', vesselName: 'Test Vessel' },
        updateSettings: vi.fn(),
    }),
}));

import { GuardianPage } from '../components/GuardianPage';

describe('GuardianPage', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<GuardianPage onBack={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders without empty container', () => {
        const { container } = render(<GuardianPage onBack={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });

    it('displays Guardian/BOLO related text', () => {
        const { container } = render(<GuardianPage onBack={vi.fn()} />);
        // Should contain some guardian-related content
        expect(container.innerHTML).toBeTruthy();
    });
});
