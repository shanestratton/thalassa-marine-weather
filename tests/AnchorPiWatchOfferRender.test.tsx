/**
 * Does the Pi offer modal ACTUALLY render when the Pi says it is capable?
 *
 * Every existing test for this feature is a regex over source text
 * (tests/AnchorPiWatchWiring.test.ts). None of them renders the component, so
 * six "fixes" shipped green while the modal never appeared on the device.
 * This one renders the real page in the real watching view and asserts on the
 * DOM.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ weatherData: { locationName: 'Anchor Bay', windSpeed: 8 }, loading: false }),
}));

vi.mock('../theme', () => ({
    getThemeForEnvironment: () => ({
        button: { primary: 'p', secondary: 's', danger: 'd', ghost: 'g', toggleOff: 't' },
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

vi.mock('../hooks/useKeyboardScroll', () => ({ useKeyboardScroll: () => ({ current: null }) }));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        getSnapshot: vi.fn(),
        isWatching: vi.fn().mockReturnValue(true),
        startWatch: vi.fn(),
        stopWatch: vi.fn(),
        restoreWatchState: vi.fn().mockResolvedValue(true),
        setAnchor: vi.fn().mockResolvedValue(false),
        getLastSetupError: vi.fn().mockReturnValue(null),
        getConfig: vi.fn().mockReturnValue({ radius: 30, lat: -27.47, lon: 153.03 }),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
}));

vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        getState: vi.fn().mockReturnValue({ connected: false }),
        getLastSessionCode: vi.fn().mockReturnValue(null),
        onStateChange: vi.fn().mockReturnValue(vi.fn()),
        onPosition: vi.fn().mockReturnValue(vi.fn()),
        onBroadcast: vi.fn().mockReturnValue(vi.fn()),
        restoreSession: vi.fn().mockResolvedValue(false),
        leaveSession: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue('CODE12345678'),
        joinSession: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: {
        acquire: vi.fn().mockResolvedValue('lease'),
        release: vi.fn().mockResolvedValue(undefined),
        releaseEventually: vi.fn(),
        getIsPlaying: vi.fn().mockReturnValue(false),
    },
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
    getSystemUnits: () => ({ speed: 'kts', distance: 'nm', temperature: 'c', depth: 'm', windSpeed: 'kts' }),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (s: { user: null; authChecked: boolean }) => unknown) =>
        selector({ user: null, authChecked: true }),
}));
vi.mock('../components/SignInScreen', () => ({
    SignInScreen: ({ isOpen }: { isOpen?: boolean }) => (isOpen ? <div role="dialog">sign in</div> : null),
}));

// THE POINT OF THIS FILE: the Pi says yes.
vi.mock('../services/anchorPiWatchKeeper', () => ({
    probePiWatchCapability: vi.fn().mockResolvedValue({ capable: true, reason: null, hasFix: true }),
    AnchorPiWatchKeeper: {
        isKeeping: vi.fn().mockReturnValue(false),
        keepingSessionCode: vi.fn().mockReturnValue(null),
        begin: vi.fn().mockResolvedValue(true),
        end: vi.fn().mockResolvedValue(undefined),
    },
}));

import { AnchorWatchPage } from '../components/AnchorWatchPage';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../services/AnchorWatchService';

function watchingSnapshot(): AnchorWatchSnapshot {
    return {
        state: 'watching',
        anchorPosition: { latitude: -27.47, longitude: 153.03, timestamp: 1_000 },
        vesselPosition: {
            latitude: -27.4701,
            longitude: 153.0301,
            accuracy: 3,
            heading: 180,
            speed: 0,
            timestamp: 2_000,
        },
        swingRadius: 35,
        distanceFromAnchor: 12,
        maxDistanceRecorded: 18,
        bearingToAnchor: 180,
        config: { rodeLength: 30, waterDepth: 5, scopeRatio: 6, rodeType: 'chain', safetyMargin: 10 },
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: Date.now(),
        gpsAccuracy: 3,
        gpsQuality: 'precision',
        gpsQualityLabel: 'Precision GPS',
        guardianStatus: 'armed',
        setupError: null,
        alarmNotificationError: null,
    } as unknown as AnchorWatchSnapshot;
}

describe('Pi watch offer — real render', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const snap = watchingSnapshot();
        vi.mocked(AnchorWatchService.getSnapshot).mockReturnValue(snap);
        vi.mocked(AnchorWatchService.restoreWatchState).mockResolvedValue(true);
        vi.mocked(AnchorWatchService.subscribe).mockImplementation((listener: (s: AnchorWatchSnapshot) => void) => {
            listener(snap);
            return vi.fn();
        });
    });

    it('shows the watching view', async () => {
        render(<AnchorWatchPage onBack={vi.fn()} />);
        expect(await screen.findByText('⏏ Weigh Anchor')).toBeTruthy();
    });

    it('shows the "Hand the watch to the Pi" row when the Pi is capable', async () => {
        render(<AnchorWatchPage onBack={vi.fn()} />);
        await waitFor(() => expect(screen.queryByText('Hand the watch to the Pi')).toBeTruthy(), { timeout: 3000 });
    });

    it('OPENS THE MODAL when the Pi is capable', async () => {
        render(<AnchorWatchPage onBack={vi.fn()} />);
        await waitFor(() => expect(screen.queryByText('Let the boat keep the watch?')).toBeTruthy(), {
            timeout: 3000,
        });
    });
});
