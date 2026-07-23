/**
 * GuardianPage — smoke tests (856 LOC component)
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const authState = vi.hoisted(() => ({ user: { id: 'current-user' } as { id: string } | null }));
const guardianState = vi.hoisted(() => ({
    current: {
        profile: null,
        nearbyUsers: [],
        alerts: [],
        loading: false,
        armed: false,
        nearbyCount: 0,
    } as any,
}));

vi.mock('../stores/authStore', () => {
    const useAuthStore = Object.assign((selector: (state: typeof authState) => unknown) => selector(authState), {
        getState: () => authState,
    });
    return { useAuthStore };
});

vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: vi.fn().mockReturnValue({ latitude: -33.8, longitude: 151.2 }),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
}));

vi.mock('../services/ownshipPosition', () => ({
    acquireFreshOwnshipPosition: vi.fn(),
}));

vi.mock('../services/GuardianService', () => ({
    GuardianService: {
        initialize: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn(() => guardianState.current),
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
        reportSuspicious: vi.fn().mockResolvedValue({ success: true }),
        broadcastWeatherSpike: vi.fn().mockResolvedValue({}),
        sendHail: vi.fn().mockResolvedValue(true),
        setHomeCoordinate: vi.fn().mockResolvedValue(true),
        updateProfile: vi.fn().mockResolvedValue(undefined),
        onAlertReceived: vi.fn().mockReturnValue(vi.fn()),
    },
    HAIL_MESSAGES: [{ emoji: '👋', text: 'Ahoy!' }],
    WEATHER_TEMPLATES: [{ emoji: '💨', text: 'Strong winds expected' }],
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { userName: 'Skipper', vesselName: 'Test Vessel' },
        updateSettings: vi.fn(),
    }),
}));

import { GuardianService, type GuardianProfile, type GuardianState } from '../services/GuardianService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { acquireFreshOwnshipPosition } from '../services/ownshipPosition';
import { GuardianPage } from '../components/GuardianPage';

describe('GuardianPage', () => {
    const existingProfile: GuardianProfile = {
        user_id: 'current-user',
        mmsi: 123456789,
        mmsi_verified: true,
        vessel_name: 'Test Vessel',
        vessel_bio: 'Cruising locally',
        owner_name: 'Skipper',
        dog_name: '',
        armed: false,
        armed_at: null,
        home_coordinate: null,
        home_radius_m: 100,
        last_known_lat: -33.8,
        last_known_lon: 151.2,
        last_known_at: '2026-07-23T00:00:00.000Z',
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        authState.user = { id: 'current-user' };
        setAuthIdentityScope('current-user');
        guardianState.current = {
            profile: null,
            nearbyUsers: [],
            alerts: [],
            loading: false,
            armed: false,
            nearbyCount: 0,
        };
        vi.mocked(GuardianService.fetchProfile).mockResolvedValue(null);
        vi.mocked(GuardianService.getState).mockImplementation(() => guardianState.current);
        vi.mocked(GuardianService.subscribe).mockReturnValue(vi.fn());
        vi.mocked(acquireFreshOwnshipPosition).mockResolvedValue({
            lat: -33.8,
            lon: 151.2,
            sog: 0,
            cog: 0,
            timestamp: Date.now(),
            source: 'gps',
        });
        vi.mocked(GuardianService.setHomeCoordinate).mockResolvedValue(true);
    });

    const renderSettled = async () => {
        const result = render(<GuardianPage onBack={vi.fn()} />);
        await screen.findByText('Guardian Profile');
        return result;
    };

    const renderWithProfile = async () => {
        vi.mocked(GuardianService.fetchProfile).mockResolvedValue(existingProfile);
        guardianState.current = {
            profile: existingProfile,
            nearbyUsers: [],
            alerts: [],
            loading: false,
            armed: false,
            nearbyCount: 0,
        };
        const result = render(<GuardianPage onBack={vi.fn()} />);
        await screen.findByLabelText('Edit Profile');
        return result;
    };

    it('renders without crashing', async () => {
        const { container } = await renderSettled();
        expect(container).toBeDefined();
    });

    it('renders without empty container', async () => {
        const { container } = await renderSettled();
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });

    it('displays Guardian/BOLO related text', async () => {
        const { container } = await renderSettled();
        // Should contain some guardian-related content
        expect(container.innerHTML).toBeTruthy();
    });

    it('contains profile setup focus, labels it, and restores focus after Escape', async () => {
        await renderWithProfile();
        const opener = screen.getByRole('button', { name: 'Edit Profile' });

        opener.focus();
        fireEvent.click(opener);

        const dialog = await screen.findByRole('dialog', { name: 'Guardian Profile' });
        expect(dialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
        expect(screen.getByRole('button', { name: 'Close profile setup' })).toHaveFocus();
        expect(screen.getByRole('textbox', { name: 'Vessel Name' })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Guardian Profile' })).not.toBeInTheDocument());
        expect(opener).toHaveFocus();
    });

    it('contains report focus and restores the report trigger after Escape', async () => {
        await renderWithProfile();
        const opener = screen.getByRole('button', { name: 'Report suspicious activity in your area' });

        opener.focus();
        fireEvent.click(opener);

        const dialog = await screen.findByRole('dialog', { name: /Report Suspicious Activity/i });
        expect(dialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
        expect(screen.getByRole('textbox', { name: 'Suspicious activity details' })).toHaveFocus();

        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: /Report Suspicious Activity/i })).not.toBeInTheDocument(),
        );
        expect(opener).toHaveFocus();
    });

    it('starts weather alerts on the safe cancel action and restores focus after Escape', async () => {
        await renderWithProfile();
        const opener = screen.getByRole('button', { name: 'Broadcast a weather alert to nearby boats' });

        opener.focus();
        fireEvent.click(opener);

        const dialog = await screen.findByRole('dialog', { name: 'Weather Alert' });
        expect(dialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
        expect(screen.getByRole('button', { name: 'Cancel weather alert' })).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Send weather alert: Strong winds expected' })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Weather Alert' })).not.toBeInTheDocument());
        expect(opener).toHaveFocus();
    });

    it('contains hail focus and restores the vessel trigger after Escape', async () => {
        vi.mocked(GuardianService.fetchProfile).mockResolvedValue(existingProfile);
        const nearbyUser = {
            user_id: 'nearby-user',
            vessel_name: 'Sea Biscuit',
            owner_name: 'Alex',
            dog_name: 'Biscuit',
            mmsi: 987654321,
            armed: false,
            distance_nm: 0.8,
            last_known_at: '2026-07-23T00:00:00.000Z',
        };
        vi.mocked(GuardianService.subscribe).mockImplementation((listener) => {
            listener({
                profile: existingProfile,
                nearbyUsers: [nearbyUser],
                alerts: [],
                loading: false,
                armed: false,
                nearbyCount: 1,
            } satisfies GuardianState);
            return vi.fn();
        });
        guardianState.current = {
            profile: existingProfile,
            nearbyUsers: [nearbyUser],
            alerts: [],
            loading: false,
            armed: false,
            nearbyCount: 1,
        };
        render(<GuardianPage onBack={vi.fn()} />);
        const opener = await screen.findByRole('button', { name: 'Hail nearby vessel' });

        opener.focus();
        fireEvent.click(opener);

        const dialog = await screen.findByRole('dialog', { name: 'Hail Sea Biscuit' });
        expect(dialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
        expect(screen.getByRole('button', { name: 'Cancel hail message' })).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Send "Ahoy!" to Sea Biscuit' })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Hail Sea Biscuit' })).not.toBeInTheDocument());
        expect(opener).toHaveFocus();
    });

    it('sets the tripwire from a fresh ownship fix and reports success without a browser alert', async () => {
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        await renderWithProfile();

        fireEvent.click(screen.getByRole('button', { name: 'Set digital tripwire at current position' }));

        await waitFor(() => expect(GuardianService.setHomeCoordinate).toHaveBeenCalledWith(-33.8, 151.2));
        expect(screen.getByRole('status').textContent).toContain('Tripwire set at the vessel’s current GPS position');
        expect(alertSpy).not.toHaveBeenCalled();
        alertSpy.mockRestore();
    });

    it('fails closed with accessible feedback when no fresh ownship fix is available', async () => {
        vi.mocked(acquireFreshOwnshipPosition).mockResolvedValueOnce(null);
        await renderWithProfile();

        fireEvent.click(screen.getByRole('button', { name: 'Set digital tripwire at current position' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('fresh vessel GPS fix is required');
        expect(GuardianService.setHomeCoordinate).not.toHaveBeenCalled();
    });

    it('closes A forms synchronously and ignores a deferred A report after switching to B', async () => {
        let finishReport!: (value: { success: boolean; notified: number }) => void;
        vi.mocked(GuardianService.reportSuspicious).mockReturnValueOnce(
            new Promise((resolve) => {
                finishReport = resolve;
            }),
        );
        await renderWithProfile();
        fireEvent.click(screen.getByRole('button', { name: 'Report suspicious activity in your area' }));
        const input = await screen.findByRole('textbox', { name: 'Suspicious activity details' });
        fireEvent.change(input, { target: { value: 'Account A private report' } });
        fireEvent.click(screen.getByRole('button', { name: 'Broadcast suspicious activity alert' }));
        expect(GuardianService.reportSuspicious).toHaveBeenCalledWith('Account A private report');

        authState.user = { id: 'account-b' };
        guardianState.current = {
            profile: null,
            nearbyUsers: [],
            alerts: [],
            loading: false,
            armed: false,
            nearbyCount: 0,
        };
        setAuthIdentityScope('account-b');

        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: /Report Suspicious Activity/i })).not.toBeInTheDocument(),
        );
        expect(screen.queryByDisplayValue('Account A private report')).not.toBeInTheDocument();

        finishReport({ success: true, notified: 1 });
        await Promise.resolve();
        expect(screen.queryByDisplayValue('Account A private report')).not.toBeInTheDocument();
    });
});
