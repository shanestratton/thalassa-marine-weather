/**
 * AnchorWatchPage — smoke tests (1087 LOC component)
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: {
            locationName: 'Anchor Bay',
            windSpeed: 8,
            windGust: 12,
            windDirection: 'N',
            waveHeight: 0.3,
            airTemperature: 24,
            condition: 'Clear',
            alerts: [],
        },
        loading: false,
    }),
}));

vi.mock('../theme', () => ({
    t: {
        colors: {
            bg: { base: '#0f172a', elevated: '#1e293b', card: '#1e293b' },
            text: { primary: '#f8fafc', secondary: '#94a3b8', muted: '#64748b' },
            border: { subtle: '#334155' },
            accent: { primary: '#0ea5e9', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444' },
        },
        nav: { pageBackground: '#0f172a' },
        card: { background: '#1e293b', border: '#334155' },
        spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
        radius: { sm: 8, md: 12, lg: 16 },
        typography: { caption: { fontSize: 11 }, label: { fontSize: 12 }, body: { fontSize: 14 } },
    },
    default: { colors: { bg: { base: '#0f172a' } } },
}));

vi.mock('../hooks/useKeyboardScroll', () => ({
    useKeyboardScroll: () => ({ current: null }),
}));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        getSnapshot: vi.fn().mockReturnValue(null),
        isWatching: vi.fn().mockReturnValue(false),
        startWatch: vi.fn(),
        stopWatch: vi.fn(),
        restoreWatchState: vi.fn().mockResolvedValue(false),
        setAnchor: vi.fn().mockResolvedValue(false),
        getLastSetupError: vi
            .fn()
            .mockReturnValue('Locked-screen notifications are denied. Enable Notifications in iOS Settings.'),
        getConfig: vi.fn().mockReturnValue({ radius: 30, lat: -33.8, lon: 151.2 }),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
}));

vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        getState: vi.fn().mockReturnValue({ connected: false }),
        // Newer API used by AnchorWatchPage's shore-session restore effect —
        // missing from this mock it threw 3 unhandled rejections per run
        // (tests passed but vitest exited 1).
        getLastSessionCode: vi.fn().mockReturnValue(null),
        onStateChange: vi.fn().mockReturnValue(vi.fn()),
        onPosition: vi.fn().mockReturnValue(vi.fn()),
        onBroadcast: vi.fn().mockReturnValue(vi.fn()),
        restoreSession: vi.fn().mockResolvedValue(false),
        leaveSession: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: {
        acquire: vi.fn().mockResolvedValue('shore-watch-lease'),
        release: vi.fn().mockResolvedValue(undefined),
        releaseEventually: vi.fn(),
        getIsPlaying: vi.fn().mockReturnValue(false),
    },
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: null; authChecked: boolean }) => unknown) =>
        selector({ user: null, authChecked: true }),
}));
vi.mock('../components/SignInScreen', () => ({
    SignInScreen: ({ isOpen, prompt }: { isOpen?: boolean; prompt?: string }) =>
        isOpen ? <div role="dialog">{prompt}</div> : null,
}));

import { AnchorWatchPage, SHORE_DATA_STALE_MS } from '../components/AnchorWatchPage';
import { AlarmAudioService } from '../services/AlarmAudioService';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../services/AnchorWatchService';
import { AnchorWatchSyncService, type PositionBroadcast, type SyncState } from '../services/AnchorWatchSyncService';

const CONNECTED_SHORE_STATE: SyncState = {
    connected: true,
    role: 'shore',
    sessionCode: 'ABCDEFGH2345',
    peerConnected: true,
    lastPeerUpdate: Date.now(),
    peerDisconnectedAt: null,
};

function makeShoreData(isAlarm = false): PositionBroadcast {
    return {
        type: 'position',
        vessel: { latitude: -27, longitude: 153, accuracy: 5, heading: 0, speed: 0, timestamp: Date.now() },
        anchor: { latitude: -27.001, longitude: 153.001, timestamp: Date.now() },
        distance: 12,
        swingRadius: 35,
        isAlarm,
        config: { rodeLength: 30, waterDepth: 5, scopeRatio: 6, rodeType: 'chain', safetyMargin: 10 },
        timestamp: Date.now(),
    };
}

function makePausedSnapshot(): AnchorWatchSnapshot {
    return {
        state: 'paused',
        anchorPosition: { latitude: -27.47, longitude: 153.03, timestamp: 1 },
        vesselPosition: {
            latitude: -27.471,
            longitude: 153.031,
            accuracy: 5,
            heading: 180,
            speed: 0,
            timestamp: 2,
        },
        swingRadius: 35,
        distanceFromAnchor: 12,
        maxDistanceRecorded: 18,
        bearingToAnchor: 180,
        config: { rodeLength: 30, waterDepth: 5, scopeRatio: 6, rodeType: 'chain', safetyMargin: 10 },
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: 1,
        gpsAccuracy: 5,
        gpsQuality: 'precision',
        gpsQualityLabel: 'Precision GPS',
        guardianStatus: 'idle',
        setupError: 'Always location authorization could not be verified.',
        alarmNotificationError: null,
    };
}

async function renderShoreWatch(state: SyncState, data: PositionBroadcast) {
    vi.mocked(AnchorWatchSyncService.restoreSession).mockResolvedValueOnce(true);
    vi.mocked(AnchorWatchSyncService.getState).mockReturnValue(state);
    const rendered = render(<AnchorWatchPage onBack={vi.fn()} />);

    await waitFor(() => {
        expect(AnchorWatchSyncService.onStateChange).toHaveBeenCalled();
        expect(AnchorWatchSyncService.onBroadcast).toHaveBeenCalled();
    });
    const stateListener = vi.mocked(AnchorWatchSyncService.onStateChange).mock.calls.at(-1)?.[0];
    const broadcastListener = vi.mocked(AnchorWatchSyncService.onBroadcast).mock.calls.at(-1)?.[0];
    if (!stateListener || !broadcastListener) throw new Error('Shore Watch listeners were not registered');

    act(() => {
        stateListener(state);
        broadcastListener(data);
    });
    await screen.findByRole('button', { name: 'Stop Watch' });
    return { stateListener, unmount: rendered.unmount };
}

describe('AnchorWatchPage', () => {
    const defaultProps = {
        onBack: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(AnchorWatchService.getSnapshot).mockReturnValue(null as never);
        vi.mocked(AnchorWatchService.subscribe).mockReturnValue(vi.fn());
        vi.mocked(AnchorWatchSyncService.restoreSession).mockResolvedValue(false);
        vi.mocked(AnchorWatchSyncService.getState).mockReturnValue({
            connected: false,
            role: 'vessel',
            sessionCode: null,
            peerConnected: false,
            lastPeerUpdate: null,
            peerDisconnectedAt: null,
        });
        vi.mocked(AnchorWatchSyncService.getLastSessionCode).mockReturnValue(null);
        vi.mocked(AnchorWatchSyncService.onStateChange).mockReturnValue(vi.fn());
        vi.mocked(AnchorWatchSyncService.onBroadcast).mockReturnValue(vi.fn());
    });

    it('renders without crashing', () => {
        const { container } = render(<AnchorWatchPage {...defaultProps} />);
        expect(container).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<AnchorWatchPage {...defaultProps} />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('accepts onBack callback', () => {
        expect(() => {
            render(<AnchorWatchPage onBack={vi.fn()} />);
        }).not.toThrow();
    });

    it('does not promise a screen-off alarm without stating the permission dependency', () => {
        render(<AnchorWatchPage {...defaultProps} />);

        expect(screen.queryByText(/alarm if you drag, even with the screen off/i)).not.toBeInTheDocument();
        expect(
            screen.getByText(/Background warning depends on this device’s GPS and notification permissions/i),
        ).toBeInTheDocument();
    });

    it('keeps local Anchor Watch anonymous but clearly gates Shore Watch sharing on sign-in', () => {
        render(<AnchorWatchPage {...defaultProps} />);

        expect(screen.getByRole('button', { name: 'Drop anchor and arm Anchor Watch' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Sign in to use Shore Watch' }));

        expect(screen.getByRole('dialog')).toHaveTextContent(
            'Sign in to share Anchor Watch between your vessel and shore devices',
        );
    });

    it('surfaces the exact actionable setup failure returned by the safety service', async () => {
        render(<AnchorWatchPage {...defaultProps} />);

        fireEvent.keyDown(screen.getByRole('button', { name: 'Drop anchor and arm Anchor Watch' }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('button', { name: 'Play test alarm' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Stop test alarm' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm alarm was audible' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm selection' }));

        expect(
            await screen.findByText('Locked-screen notifications are denied. Enable Notifications in iOS Settings.'),
        ).toBeInTheDocument();
    });

    it('renders a restored paused watch as explicitly blocked, never Holding', async () => {
        const paused = makePausedSnapshot();
        vi.mocked(AnchorWatchService.restoreWatchState).mockResolvedValue(true);
        vi.mocked(AnchorWatchService.getSnapshot).mockReturnValue(paused as never);
        vi.mocked(AnchorWatchService.subscribe).mockImplementation((listener) => {
            listener(paused);
            return vi.fn();
        });

        render(<AnchorWatchPage {...defaultProps} />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Not monitoring — act now');
        expect(screen.getByRole('alert')).toHaveTextContent('Always location authorization could not be verified');
        expect(screen.getByRole('button', { name: 'Retry Anchor Watch monitoring' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stop Watch' })).toHaveTextContent('Weigh Anchor');
        expect(screen.queryByText('Holding')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Create Session' })).not.toBeInTheDocument();
    });

    it('shows only cleanup controls when a paused watch belongs to the previous account', async () => {
        const paused = {
            ...makePausedSnapshot(),
            anchorPosition: null,
            vesselPosition: null,
            setupError:
                'Account changed while restoring Anchor Watch. Native cleanup is not confirmed; retry Weigh Anchor.',
        };
        vi.mocked(AnchorWatchService.restoreWatchState).mockResolvedValue(true);
        vi.mocked(AnchorWatchService.getSnapshot).mockReturnValue(paused as never);
        vi.mocked(AnchorWatchService.subscribe).mockImplementation((listener) => {
            listener(paused);
            return vi.fn();
        });

        render(<AnchorWatchPage {...defaultProps} />);

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Saved watch details belong to the previous account',
        );
        expect(screen.getByText('Previous account — cleanup only')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Retry Anchor Watch monitoring' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stop Watch' })).toHaveTextContent('Weigh Anchor');
    });

    it('shows corrupt saved configuration as blocked cleanup, never as retryable monitoring', async () => {
        const paused = {
            ...makePausedSnapshot(),
            setupError:
                'Saved Anchor Watch is blocked and was not armed. The saved anchor configuration is invalid. Use Weigh Anchor to clear it, then set the anchor again.',
        };
        vi.mocked(AnchorWatchService.restoreWatchState).mockResolvedValue(true);
        vi.mocked(AnchorWatchService.getSnapshot).mockReturnValue(paused as never);
        vi.mocked(AnchorWatchService.subscribe).mockImplementation((listener) => {
            listener(paused);
            return vi.fn();
        });

        render(<AnchorWatchPage {...defaultProps} />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Saved watch details are unavailable or corrupt');
        expect(screen.getByText('Blocked recovery — cleanup only')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Retry Anchor Watch monitoring' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stop Watch' })).toHaveTextContent('Weigh Anchor');
    });

    it('renders disconnected vessel values explicitly as last-known, never Holding', async () => {
        const { stateListener } = await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData());
        expect(screen.getByText('Holding')).toBeInTheDocument();

        act(() => {
            stateListener({
                ...CONNECTED_SHORE_STATE,
                peerConnected: false,
                peerDisconnectedAt: Date.now(),
            });
        });

        expect(screen.getByText('Last-known data')).toBeInTheDocument();
        expect(screen.getByText(/Vessel offline · showing last-known data/i)).toBeInTheDocument();
        expect(screen.queryByText('Holding')).not.toBeInTheDocument();
    });

    it('ages a connected shore feed into last-known state after three missed broadcasts', async () => {
        const now = Date.now();
        const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            const { stateListener } = await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData());
            expect(screen.getByText('Holding')).toBeInTheDocument();

            dateNow.mockReturnValue(now + SHORE_DATA_STALE_MS + 1);
            act(() => stateListener({ ...CONNECTED_SHORE_STATE }));

            expect(screen.getByText('Vessel Data Stale')).toBeInTheDocument();
            expect(screen.getByText('Last-known data')).toBeInTheDocument();
            expect(screen.getByText(/showing last-known update/i)).toBeInTheDocument();
            expect(screen.queryByText('Holding')).not.toBeInTheDocument();
        } finally {
            dateNow.mockRestore();
        }
    });

    it('labels shore alarm muting as local-device-only without implying vessel acknowledgement', async () => {
        await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData(true));

        await waitFor(() => expect(AlarmAudioService.acquire).toHaveBeenCalledWith('shore-watch'));

        const mute = screen.getByRole('button', { name: 'Mute alarm on this device only' });
        expect(mute).toHaveTextContent('Mute this device only');
        expect(mute).toHaveTextContent(
            'This only silences this device; it does not acknowledge or change the vessel alarm.',
        );

        fireEvent.click(mute);

        await waitFor(() => expect(AlarmAudioService.release).toHaveBeenCalledWith('shore-watch-lease'));
        expect(mute).toBeDisabled();
        expect(mute).toHaveTextContent('Muted on this device only');
    });

    it('hands an owned shore alarm lease to exact-token cleanup when the page unmounts', async () => {
        const { unmount } = await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData(true));
        await waitFor(() => expect(AlarmAudioService.acquire).toHaveBeenCalledWith('shore-watch'));
        await act(async () => Promise.resolve());

        unmount();

        expect(AlarmAudioService.releaseEventually).toHaveBeenCalledWith('shore-watch-lease');
        expect(AlarmAudioService.release).not.toHaveBeenCalled();
    });

    it('hands a shore alarm lease that resolves after unmount to exact-token cleanup', async () => {
        let resolveAcquire!: (lease: string) => void;
        const pendingAcquire = new Promise<string>((resolve) => {
            resolveAcquire = resolve;
        });
        vi.mocked(AlarmAudioService.acquire).mockReturnValueOnce(pendingAcquire);
        const { unmount } = await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData(true));
        await waitFor(() => expect(AlarmAudioService.acquire).toHaveBeenCalledWith('shore-watch'));

        unmount();
        await act(async () => {
            resolveAcquire('late-shore-watch-lease');
            await pendingAcquire;
        });

        expect(AlarmAudioService.releaseEventually).toHaveBeenCalledWith('late-shore-watch-lease');
        expect(AlarmAudioService.release).not.toHaveBeenCalled();
    });
});
