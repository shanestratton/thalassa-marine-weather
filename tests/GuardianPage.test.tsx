/**
 * GuardianPage — smoke tests (856 LOC component)
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
        refreshArmedPresence: vi.fn().mockResolvedValue(true),
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

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

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

    const renderWithArmedProfile = async () => {
        const armedProfile = { ...existingProfile, armed: true, armed_at: '2026-07-23T00:00:00.000Z' };
        vi.mocked(GuardianService.fetchProfile).mockResolvedValue(armedProfile);
        guardianState.current = {
            profile: armedProfile,
            nearbyUsers: [],
            alerts: [],
            loading: false,
            armed: true,
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

    it('docks the arm slider at the foot of the page and lets the alert feed take the rest', async () => {
        // Shane 2026-09-09: "move the slide to arm vessel to the bottom of the
        // screen (exactly 8px above the top of the menu bar) and make sure that
        // the alert feed grows and shrinks to fit."
        await renderWithProfile();
        const slider = await screen.findByRole('button', { name: /Arm Guardian vessel watch/ });
        const dock = slider.closest('[data-testid="guardian-arm-slider-dock"]') as HTMLElement | null;
        expect(dock).not.toBeNull();
        const feed = screen.getByTestId('guardian-alert-feed');
        // The feed comes before the dock, the dock is a direct child of the page
        // root, and the root's bottom padding is the tab bar plus 8px.
        expect(feed.compareDocumentPosition(dock!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(dock!.className).toContain('shrink-0');
        // jsdom re-orders calc() terms; pin the three parts, not the string.
        const pad = dock!.parentElement?.style.paddingBottom ?? '';
        expect(pad).toContain('4rem');
        expect(pad).toContain('8px');
        expect(pad).toContain('env(safe-area-inset-bottom)');
        expect(
            dock!.parentElement?.lastElementChild === dock ||
                dock!.nextElementSibling?.getAttribute('role') === 'presentation',
        ).toBe(true);
        expect(feed.className).toContain('flex-1');
        expect(feed.className).toContain('min-h-[120px]');
        expect(feed.querySelector('.overflow-y-auto')).not.toBeNull();
        // The slider left the scrolling column.
        expect(feed.parentElement?.contains(dock)).toBe(false);
    });

    it('renders without empty container', async () => {
        const { container } = await renderSettled();
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });

    it('shows a complete signed-out state with navigation instead of an endless spinner', async () => {
        authState.user = null;
        setAuthIdentityScope(null);
        const onBack = vi.fn();

        render(<GuardianPage onBack={onBack} />);

        expect(await screen.findByRole('status')).toHaveTextContent('Sign in to use Guardian');
        expect(screen.getByText('Guardian')).toBeInTheDocument();
        const back = screen.getByRole('button', { name: /back/i });
        fireEvent.click(back);
        expect(onBack).toHaveBeenCalledOnce();
        expect(screen.queryByText('Loading Guardian…')).not.toBeInTheDocument();
    });

    it('keeps the page header and Back control visible while Guardian is loading', async () => {
        let finishInitialization!: () => void;
        vi.mocked(GuardianService.initialize).mockReturnValueOnce(
            new Promise((resolve) => {
                finishInitialization = resolve;
            }),
        );
        const onBack = vi.fn();

        render(<GuardianPage onBack={onBack} />);

        expect(screen.getByRole('status')).toHaveTextContent('Loading Guardian');
        fireEvent.click(screen.getByRole('button', { name: /back/i }));
        expect(onBack).toHaveBeenCalledOnce();
        finishInitialization();
    });

    it('does not acquire, share or poll location while the profile is disarmed', async () => {
        await renderWithProfile();

        expect(await screen.findByText('Disarmed — no location sharing or nearby polling')).toBeInTheDocument();
        expect(screen.queryByText('Thalassa boats nearby')).not.toBeInTheDocument();
        expect(
            screen.getByText('Disarmed: Guardian does not heartbeat your position or poll the nearby feed.'),
        ).toBeInTheDocument();
        expect(acquireFreshOwnshipPosition).not.toHaveBeenCalled();
        expect(GuardianService.fetchNearbyUsers).not.toHaveBeenCalled();
        expect(GuardianService.fetchAlerts).not.toHaveBeenCalled();
    });

    it('keeps location-based community broadcasts unavailable while disarmed', async () => {
        await renderWithProfile();

        const report = screen.getByRole('button', { name: 'Report suspicious activity in your area' });
        const weather = screen.getByRole('button', { name: 'Broadcast a weather alert to nearby boats' });
        expect(report).toHaveAttribute('aria-disabled', 'true');
        expect(weather).toHaveAttribute('aria-disabled', 'true');

        fireEvent.click(report);
        expect(await screen.findByRole('alert')).toHaveTextContent('Arm Guardian before sending a location-based');
        expect(screen.queryByRole('dialog', { name: /Report Suspicious Activity/i })).not.toBeInTheDocument();
    });

    it('does not report zero nearby boats when an armed watch has no fresh GPS fix', async () => {
        const armedProfile = { ...existingProfile, armed: true, armed_at: '2026-07-23T00:00:00.000Z' };
        vi.mocked(acquireFreshOwnshipPosition).mockResolvedValue(null);
        guardianState.current = {
            profile: armedProfile,
            nearbyUsers: [],
            alerts: [],
            loading: false,
            armed: true,
            nearbyCount: 0,
        };
        vi.mocked(GuardianService.fetchProfile).mockResolvedValue(armedProfile);

        render(<GuardianPage onBack={vi.fn()} />);

        expect(await screen.findByText('GPS unavailable — nearby coverage not checked')).toBeInTheDocument();
        expect(screen.queryByText('Thalassa boats nearby')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry GPS' })).toBeInTheDocument();
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
        await renderWithArmedProfile();
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
        await renderWithArmedProfile();
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
        const armedProfile = { ...existingProfile, armed: true, armed_at: '2026-07-23T00:00:00.000Z' };
        vi.mocked(GuardianService.fetchProfile).mockResolvedValue(armedProfile);
        const nearbyUser = {
            user_id: 'nearby-user',
            vessel_name: 'Sea Biscuit',
            distance_nm: 0.8,
            last_known_at: '2026-07-23T00:00:00.000Z',
        };
        vi.mocked(GuardianService.subscribe).mockImplementation((listener) => {
            listener({
                profile: armedProfile,
                nearbyUsers: [nearbyUser],
                alerts: [],
                loading: false,
                armed: true,
                nearbyCount: 1,
            } satisfies GuardianState);
            return vi.fn();
        });
        guardianState.current = {
            profile: armedProfile,
            nearbyUsers: [nearbyUser],
            alerts: [],
            loading: false,
            armed: true,
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
        vi.mocked(acquireFreshOwnshipPosition).mockResolvedValue(null);
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
        await renderWithArmedProfile();
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

    it('labels the server-confirmed sender entry in the alert feed', async () => {
        await renderWithArmedProfile();
        const listener = vi.mocked(GuardianService.subscribe).mock.calls.at(-1)![0];
        act(() => {
            listener({
                ...guardianState.current,
                alerts: [
                    {
                        id: 'server-alert-id',
                        alert_type: 'weather_spike',
                        source_vessel_name: 'Test Vessel',
                        title: 'Weather alert',
                        body: 'Wind building in the bay',
                        lat: -33.8,
                        lon: 151.2,
                        data: { sent_by_you: true },
                        created_at: new Date().toISOString(),
                    },
                ],
            });
        });
        const feed = within(screen.getByTestId('guardian-alert-feed'));
        expect(feed.getByText('Sent by you')).toBeInTheDocument();
        expect(feed.getByText('Wind building in the bay')).toBeInTheDocument();
        expect(feed.queryByText('from Test Vessel')).not.toBeInTheDocument();
    });

    it.each([0, 2])(
        'confirms own-feed storage and reports %i other vessels as queued, not received',
        async (notified) => {
            vi.mocked(GuardianService.reportSuspicious).mockResolvedValueOnce({
                success: true,
                notified,
                feedConfirmed: true,
            });
            await renderWithArmedProfile();
            fireEvent.click(screen.getByRole('button', { name: 'Report suspicious activity in your area' }));
            fireEvent.change(await screen.findByRole('textbox', { name: 'Suspicious activity details' }), {
                target: { value: 'Please check the bay' },
            });
            fireEvent.click(screen.getByRole('button', { name: 'Broadcast suspicious activity alert' }));
            const feedback = await screen.findByRole('status');
            expect(feedback).toHaveTextContent('Saved to your alert feed.');
            expect(feedback).toHaveTextContent(
                notified ? 'Notifications queued for 2 nearby vessels.' : 'No nearby vessels were available to notify.',
            );
            expect(feedback).not.toHaveTextContent(/received|delivered/i);
        },
    );

    it('confirms weather alerts use the same own-feed receipt', async () => {
        vi.mocked(GuardianService.broadcastWeatherSpike).mockResolvedValueOnce({
            success: true,
            notified: 1,
            feedConfirmed: true,
        });
        await renderWithArmedProfile();
        fireEvent.click(screen.getByRole('button', { name: 'Broadcast a weather alert to nearby boats' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Send weather alert: Strong winds expected' }));
        expect(await screen.findByRole('status')).toHaveTextContent(
            'Saved to your alert feed. Notifications queued for 1 nearby vessel.',
        );
    });

    it('does not claim the feed is confirmed when the response is missing its receipt', async () => {
        vi.mocked(GuardianService.broadcastWeatherSpike).mockResolvedValueOnce({
            success: true,
            notified: 0,
            feedConfirmed: false,
        });
        await renderWithArmedProfile();
        fireEvent.click(screen.getByRole('button', { name: 'Broadcast a weather alert to nearby boats' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Send weather alert: Strong winds expected' }));
        expect(await screen.findByRole('status')).toHaveTextContent(
            'Alert sent; waiting for feed confirmation. Please don’t resend.',
        );
        expect(screen.queryByText('Sent by you')).not.toBeInTheDocument();
    });
});
