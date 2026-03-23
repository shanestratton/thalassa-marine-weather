/**
 * AnchorWatchPage — smoke tests (1087 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
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
        onStateChange: vi.fn().mockReturnValue(vi.fn()),
        onPosition: vi.fn().mockReturnValue(vi.fn()),
        onBroadcast: vi.fn().mockReturnValue(vi.fn()),
    },
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { AnchorWatchPage } from '../components/AnchorWatchPage';

describe('AnchorWatchPage', () => {
    const defaultProps = {
        onBack: vi.fn(),
    };

    beforeEach(() => vi.clearAllMocks());

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
});
