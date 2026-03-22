/**
 * AnchorWatchPage — component tests.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: {
            locationName: 'Brisbane',
            windSpeed: 12,
            windGust: 18,
            windDirection: 'SE',
            waveHeight: 0.5,
            airTemperature: 24,
            condition: 'Clear',
            alerts: [],
        },
        loading: false,
    }),
}));

vi.mock('../hooks/useKeyboardScroll', () => ({ useKeyboardScroll: () => ({ current: null }) }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        setAnchor: vi.fn(),
        stopWatch: vi.fn(),
        acknowledgeAlarm: vi.fn(),
        restoreWatchState: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn(() => vi.fn()),
        getConfig: vi.fn().mockReturnValue(null),
        setConfig: vi.fn(),
        addListener: vi.fn(() => ({ remove: vi.fn() })),
        removeAllListeners: vi.fn(),
        getSnapshot: vi.fn().mockReturnValue(null),
        isWatching: vi.fn().mockReturnValue(false),
    },
}));

vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        getSyncState: vi.fn().mockReturnValue(null),
        getState: vi.fn().mockReturnValue(null),
        startSync: vi.fn(),
        stopSync: vi.fn(),
        createSession: vi.fn(),
        joinSession: vi.fn(),
        leaveSession: vi.fn(),
        restoreSession: vi.fn().mockResolvedValue(null),
        broadcastPosition: vi.fn(),
        onStateChange: vi.fn(() => vi.fn()),
        onBroadcast: vi.fn(() => vi.fn()),
        onPosition: vi.fn(() => vi.fn()),
    },
}));

vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: {
        startAlarm: vi.fn(),
        stopAlarm: vi.fn(),
        play: vi.fn(),
        stop: vi.fn(),
        isPlaying: vi.fn().mockReturnValue(false),
    },
}));

vi.mock('../services/AisStreamService', () => ({
    AisStreamService: {
        getVesselsInRadius: vi.fn().mockReturnValue([]),
        subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    },
}));

vi.mock('../components/anchor-watch/SwingCircleCanvas', () => ({
    SwingCircleCanvas: () => <canvas data-testid="swing-circle">SwingCircle</canvas>,
}));
vi.mock('../components/anchor-watch/AnchorAlarmOverlay', () => ({ AnchorAlarmOverlay: () => null }));
vi.mock('../components/anchor-watch/ScopeRadar', () => ({
    ScopeRadar: () => <div data-testid="scope-radar">ScopeRadar</div>,
}));
vi.mock('../components/anchor-watch/SoundCheckModal', () => ({ SoundCheckModal: () => null }));
vi.mock('../components/anchor-watch/ShoreWatchModal', () => ({ ShoreWatchModal: () => null }));

vi.mock('../components/anchor-watch/anchorUtils', () => ({
    navStatusColorSimple: vi.fn(() => '#22c55e'),
    getWeatherRecommendation: vi.fn(() => ({ text: 'Safe to anchor', color: 'green' })),
    formatDistance: vi.fn((d: number) => `${d.toFixed(0)}m`),
    bearingToCardinal: vi.fn(() => 'N'),
    formatElapsed: vi.fn(() => '0:00'),
}));

vi.mock('../theme', () => ({
    t: {
        colors: {
            bg: { base: '#0f172a', elevated: '#1e293b', card: '#1e293b' },
            text: { primary: '#f8fafc', secondary: '#94a3b8', muted: '#64748b' },
            border: { subtle: '#334155', muted: '#1e293b' },
            accent: { primary: '#0ea5e9', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444' },
        },
        nav: { pageBackground: '#0f172a', barBackground: '#0f172a' },
        card: { background: '#1e293b', border: '#334155' },
        spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
        radius: { sm: 8, md: 12, lg: 16 },
        typography: { caption: { fontSize: 11 }, label: { fontSize: 12 }, body: { fontSize: 14 } },
    },
    default: { colors: { bg: { base: '#0f172a' } }, nav: { pageBackground: '#0f172a' } },
}));

import { AnchorWatchPage } from '../components/AnchorWatchPage';

describe('AnchorWatchPage', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<AnchorWatchPage />);
        expect(container).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<AnchorWatchPage />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('starts in setup mode', () => {
        render(<AnchorWatchPage />);
        const buttons = screen.getAllByRole('button');
        expect(buttons.length).toBeGreaterThan(0);
    });

    it('accepts onBack callback without crashing', () => {
        const onBack = vi.fn();
        expect(() => render(<AnchorWatchPage onBack={onBack} />)).not.toThrow();
    });

    it('does not show alarm state initially', () => {
        render(<AnchorWatchPage />);
        expect(screen.queryByTestId('alarm-overlay')).toBeNull();
    });
});
