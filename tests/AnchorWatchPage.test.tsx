/**
 * AnchorWatchPage — smoke tests (1087 LOC component)
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    // Button (via useThemeStore) resolves tokens per environment, so the
    // theme mock has to answer for the whole module, not just `t`.
    getThemeForEnvironment: () => ({
        button: {
            primary: 'primary',
            secondary: 'secondary',
            danger: 'danger',
            ghost: 'ghost',
            toggleOff: 'toggleOff',
        },
    }),
    touchTarget: { button: 'min-h-[44px]', buttonSm: 'min-h-[36px]', icon: 'w-11 h-11' },
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
        getLatestPosition: vi.fn().mockReturnValue(null),
        getPushReadiness: vi.fn().mockReturnValue({ status: 'inactive', reason: null, checkedAt: null }),
        onPushReadinessChange: vi.fn().mockReturnValue(vi.fn()),
        refreshPushReadiness: vi.fn().mockResolvedValue({ status: 'ready', reason: null, checkedAt: 1 }),
        onStateChange: vi.fn().mockReturnValue(vi.fn()),
        onPosition: vi.fn().mockReturnValue(vi.fn()),
        onBroadcast: vi.fn().mockReturnValue(vi.fn()),
        restoreSession: vi.fn().mockResolvedValue(false),
        leaveSession: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: {
        getSnapshot: vi.fn(),
        start: vi.fn(),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        mute: vi.fn().mockResolvedValue(undefined),
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

// getSystemUnits included because the radar's receiver-merge (anchorRadarTargets)
// transitively pulls settingsStore, whose init calls it at module scope.
vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
    getSystemUnits: () => ({ speed: 'kts', distance: 'nm', temperature: 'c', depth: 'm', windSpeed: 'kts' }),
}));
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
import { ShoreWatchAlarmService, type ShoreAlarmSnapshot } from '../services/ShoreWatchAlarmService';
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

function shoreAlarmSnapshot(cause: ShoreAlarmSnapshot['cause'] = null): ShoreAlarmSnapshot {
    return {
        sessionCode: CONNECTED_SHORE_STATE.sessionCode,
        position: null,
        lastContactAt: null,
        stale: false,
        cause,
        muted: false,
        audioError: null,
    };
}

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
    vi.mocked(ShoreWatchAlarmService.getSnapshot).mockReturnValue(shoreAlarmSnapshot(data.isAlarm ? 'drag' : null));
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
    // Shore Watch header action reads 'Leave' — its name now matches (label-in-name).
    await screen.findByRole('button', { name: 'Leave Shore Watch' });
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
        vi.mocked(AnchorWatchSyncService.getLatestPosition).mockReturnValue(null);
        vi.mocked(AnchorWatchSyncService.getPushReadiness).mockReturnValue({
            status: 'inactive',
            reason: null,
            checkedAt: null,
        });
        vi.mocked(AnchorWatchSyncService.onPushReadinessChange).mockImplementation((listener) => {
            listener(AnchorWatchSyncService.getPushReadiness());
            return vi.fn();
        });
        vi.mocked(ShoreWatchAlarmService.getSnapshot).mockReturnValue(shoreAlarmSnapshot());
        vi.mocked(ShoreWatchAlarmService.subscribe).mockImplementation((listener) => {
            listener(ShoreWatchAlarmService.getSnapshot());
            return vi.fn();
        });
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
        expect(screen.getByText(/Background alerts need GPS and notification access/i)).toBeInTheDocument();
    });

    it('keeps local Anchor Watch anonymous but clearly gates Shore Watch sharing on sign-in', () => {
        render(<AnchorWatchPage {...defaultProps} />);

        expect(screen.getByRole('button', { name: 'Drop anchor and arm Anchor Watch' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Shore Watch. Sign in to use Shore Watch' }));

        expect(screen.getByRole('dialog')).toHaveTextContent(
            'Sign in to share Anchor Watch between your vessel and shore devices',
        );
    });

    it('sets the wind advice under the verdict, and says arming waits for GPS (UX scorecard runs 7 and 8)', () => {
        render(<AnchorWatchPage {...defaultProps} />);

        // The advice sits with the dial's verdict, not in a strip the sticky
        // arming bar covered. No current wind in this mock: '--', never 0, and
        // the light-air scope still offered as a one-tap set (5 m x 5:1). It
        // says 'now': the advice reads this minute's wind (UX scorecard run 9),
        // wind first, then what the scope needs (UX scorecard run 10).
        expect(screen.getByText('ADEQUATE')).toBeInTheDocument();
        const advice = screen.getByRole('button', { name: /^-- kts now · 5:1 needs 25 m, set rode to 25 metres$/ });
        fireEvent.click(advice);
        expect(screen.getByText('25 m')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^-- kts now · 5:1 set/ })).toBeInTheDocument();
        // No fix in the test environment: the bar says so before the slide,
        // and the name the tests and Voice Control use is unchanged.
        const arm = screen.getByRole('button', { name: 'Drop anchor and arm Anchor Watch' });
        expect(arm).toHaveAccessibleDescription(/GPS/);
    });

    it('names the rode-type row and speaks its choices in capitals (UX scorecard run 9)', () => {
        render(<AnchorWatchPage {...defaultProps} />);
        const group = screen.getByRole('group', { name: 'Rode type' });
        expect(screen.getByText('Rode type')).toBeVisible();
        expect(within(group).getByRole('button', { name: 'Chain' })).toHaveAttribute('aria-pressed', 'true');
        expect(within(group).getByRole('button', { name: 'Rope' })).toHaveAttribute('aria-pressed', 'false');
        expect(within(group).getByRole('button', { name: 'Mixed' })).toBeInTheDocument();
        // One status for VoiceOver, however many copies of the pill are drawn.
        expect(screen.getAllByRole('status')).toHaveLength(1);
    });

    it('arms from a VoiceOver double-tap through the Sound Check, never from a finger tap (UX scorecard run 8)', async () => {
        render(<AnchorWatchPage {...defaultProps} />);
        const arm = screen.getByRole('button', { name: 'Drop anchor and arm Anchor Watch' });
        expect(arm).toHaveAccessibleDescription(/Double-tap to arm/);

        // A finger's tap on the track (detail 1) springs back: it must slide.
        fireEvent.click(arm, { detail: 1 });
        expect(screen.queryByRole('button', { name: 'Play test alarm' })).not.toBeInTheDocument();

        // Assistive activation carries no pointer travel (detail 0).
        fireEvent.click(arm, { detail: 0 });
        expect(await screen.findByRole('button', { name: 'Play test alarm' })).toBeInTheDocument();
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
        expect(screen.queryByRole('button', { name: /^(Start|Sign in for) Shore Watch$/ })).not.toBeInTheDocument();
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

    // ── The Pi keeps the watch: there is no presence to have ──────────────
    //
    // A vessel PHONE joins the realtime channel, so Supabase presence tracks
    // it. The Pi never joins: it POSTs each position to the anchor-relay
    // function, which broadcasts it. peerConnected is therefore false for the
    // whole watch, and gating freshness on it made every Pi-kept watch read
    // "Vessel offline · showing last-known data from 8s ago" while positions
    // were arriving perfectly every ten seconds (observed 2026-09-04).
    //
    // The distinction that fixes it without weakening the phone case is
    // peerDisconnectedAt: a peer that LEFT is news, a peer that never existed
    // is not.
    it('treats a Pi-kept watch as live — no presence ever, but positions arriving', async () => {
        await renderShoreWatch(
            { ...CONNECTED_SHORE_STATE, peerConnected: false, peerDisconnectedAt: null },
            makeShoreData(),
        );

        expect(screen.getByText('Holding')).toBeInTheDocument();
        expect(screen.queryByText(/Vessel offline/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/showing last-known/i)).not.toBeInTheDocument();
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

        expect(ShoreWatchAlarmService.start).toHaveBeenCalled();

        const mute = screen.getByRole('button', { name: 'Mute alarm on this device only' });
        expect(mute).toHaveTextContent('Mute this device only');
        expect(mute).toHaveTextContent('The vessel’s watch continues.');

        fireEvent.click(mute);

        await waitFor(() => expect(ShoreWatchAlarmService.mute).toHaveBeenCalledOnce());
        act(() => {
            vi.mocked(ShoreWatchAlarmService.subscribe).mock.calls.at(-1)?.[0]({
                ...shoreAlarmSnapshot('drag'),
                muted: true,
            });
        });
        expect(mute).toBeDisabled();
        expect(mute).toHaveTextContent('Muted on this device only');
    });

    it('only unsubscribes on unmount and leaves app-owned alarm audio running', async () => {
        const { unmount } = await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData(true));
        const unsubscribe = vi.mocked(ShoreWatchAlarmService.subscribe).mock.results.at(-1)?.value;

        unmount();

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(ShoreWatchAlarmService.mute).not.toHaveBeenCalled();
        expect(AnchorWatchSyncService.leaveSession).not.toHaveBeenCalled();
        expect(AlarmAudioService.acquire).not.toHaveBeenCalled();
        expect(AlarmAudioService.releaseEventually).not.toHaveBeenCalled();
        expect(AlarmAudioService.release).not.toHaveBeenCalled();
    });

    it('shows retained vessel data immediately on a shore remount without awaiting restore', async () => {
        vi.mocked(AnchorWatchSyncService.getState).mockReturnValue(CONNECTED_SHORE_STATE);
        vi.mocked(AnchorWatchSyncService.getLatestPosition).mockReturnValue(makeShoreData());
        vi.mocked(AnchorWatchService.restoreWatchState).mockReturnValueOnce(new Promise(() => {}));
        render(<AnchorWatchPage />);

        expect(screen.getByRole('button', { name: 'Leave Shore Watch' })).toBeInTheDocument();
        expect(screen.getByText('Holding')).toBeInTheDocument();
        expect(screen.queryByText(/Connecting to vessel/)).not.toBeInTheDocument();
    });

    it('does not refresh stale cached vessel timestamps just because the shore page remounted', () => {
        const old = Date.now() - SHORE_DATA_STALE_MS - 1000;
        const data = makeShoreData();
        data.timestamp = old;
        data.vessel.timestamp = old;
        vi.mocked(AnchorWatchSyncService.getState).mockReturnValue(CONNECTED_SHORE_STATE);
        vi.mocked(AnchorWatchSyncService.getLatestPosition).mockReturnValue(data);
        render(<AnchorWatchPage />);

        expect(screen.getByText('Last-known data')).toBeInTheDocument();
        expect(screen.queryByText('Holding')).not.toBeInTheDocument();
    });

    it('keeps an existing shore session visible when local watch restore completes before a failed reconnect', async () => {
        vi.mocked(AnchorWatchSyncService.getState).mockReturnValue(CONNECTED_SHORE_STATE);
        vi.mocked(AnchorWatchSyncService.getLatestPosition).mockReturnValue(makeShoreData());
        vi.mocked(AnchorWatchService.restoreWatchState).mockResolvedValueOnce(true);
        vi.mocked(AnchorWatchSyncService.restoreSession).mockResolvedValueOnce(false);
        render(<AnchorWatchPage />);
        await waitFor(() => expect(AnchorWatchSyncService.restoreSession).toHaveBeenCalled());
        expect(screen.getByRole('button', { name: 'Leave Shore Watch' })).toBeInTheDocument();
        expect(screen.getByText('Holding')).toBeInTheDocument();
    });

    it('preserves the app-wide local mute state when returning to shore view', () => {
        vi.mocked(AnchorWatchSyncService.getState).mockReturnValue(CONNECTED_SHORE_STATE);
        vi.mocked(AnchorWatchSyncService.getLatestPosition).mockReturnValue(makeShoreData(true));
        vi.mocked(ShoreWatchAlarmService.getSnapshot).mockReturnValue({ ...shoreAlarmSnapshot('drag'), muted: true });
        render(<AnchorWatchPage />);

        expect(screen.getByRole('button', { name: 'Mute alarm on this device only' })).toBeDisabled();
        expect(screen.getByText('Muted on this device only')).toBeInTheDocument();
        expect(AlarmAudioService.acquire).not.toHaveBeenCalled();
    });

    it('keeps the healthy shore screen focused on readings, with notification explanations in the info panel', async () => {
        vi.mocked(AnchorWatchSyncService.getPushReadiness).mockReturnValue({
            status: 'ready',
            reason: null,
            checkedAt: 1,
        });
        await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData());

        expect(screen.queryByRole('region', { name: 'Background notification readiness' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Registration is confirmed, not delivery/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Alarm notifications use a 24-second siren/)).not.toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Vessel anchor readings' })).toBeInTheDocument();
        for (const label of ['Swing Radius', 'Rode', 'Depth', 'Last Update']) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
        expect(screen.getByTestId('shore-watch-page').style.paddingBottom).toContain('safe-area-inset-bottom');
        expect(screen.getByTestId('shore-readings-scroll')).toHaveClass('min-h-0', 'overflow-y-auto');
    });

    it('does not call an outside-radius fix Holding while the watchkeeper confirms the alarm', async () => {
        const data = makeShoreData(false);
        data.distance = 164;
        await renderShoreWatch(CONNECTED_SHORE_STATE, data);
        expect(screen.getByText('Outside radius · checking')).toHaveClass('text-amber-300');
        expect(screen.queryByText('Holding')).not.toBeInTheDocument();
        expect(screen.queryByText('Drag Alarm')).not.toBeInTheDocument();
        expect(AlarmAudioService.acquire).not.toHaveBeenCalled();
    });

    it('shows unavailable reason and offers an explicit notification retry', async () => {
        vi.mocked(AnchorWatchSyncService.getPushReadiness).mockReturnValue({
            status: 'unavailable',
            reason: 'Enable Time Sensitive notifications.',
            checkedAt: 1,
        });
        await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData());
        expect(screen.getByText('Background notifications not verified')).toBeInTheDocument();
        expect(screen.getByText('Enable Time Sensitive notifications.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Retry notifications' }));
        expect(AnchorWatchSyncService.refreshPushReadiness).toHaveBeenCalledOnce();
    });

    it('shows checking without permitting overlapping notification retries', async () => {
        vi.mocked(AnchorWatchSyncService.getPushReadiness).mockReturnValue({
            status: 'checking',
            reason: null,
            checkedAt: null,
        });
        await renderShoreWatch(CONNECTED_SHORE_STATE, makeShoreData());
        expect(screen.getByText('Checking background notifications…')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry notifications' })).toBeDisabled();
    });
});
