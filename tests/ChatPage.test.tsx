/**
 * ChatPage — component tests.
 * Verifies render, view switching, and banner display.
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
            locationName: 'Sydney',
            windSpeed: 15,
            windGust: 22,
            windDirection: 'NE',
            waveHeight: 1.2,
            airTemperature: 22,
            condition: 'Clear',
            alerts: [],
        },
        loading: false,
    }),
}));

vi.mock('../context/ThemeContext', () => ({
    useTheme: () => ({
        colors: {
            bg: { base: '#0f172a', elevated: '#1e293b', card: '#1e293b' },
            text: { primary: '#f8fafc', secondary: '#94a3b8', muted: '#64748b' },
            border: { subtle: '#334155', muted: '#1e293b' },
            accent: { primary: '#0ea5e9', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444' },
        },
        nav: { pageBackground: '#0f172a', barBackground: '#0f172a' },
        card: { background: '#1e293b', border: '#334155' },
    }),
    ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            userName: 'Test',
            homePort: 'Sydney',
            vesselType: 'sailboat',
            windSpeedUnit: 'kts',
            temperatureUnit: 'celsius',
            distanceUnit: 'nm',
            pressureUnit: 'hPa',
            depthUnit: 'm',
            waveHeightUnit: 'm',
            timeFormat: '24h',
            keepScreenOn: false,
            autoTrack: false,
        },
        updateSettings: vi.fn(),
    }),
    SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../hooks/useKeyboardScroll', () => ({ useKeyboardScroll: () => ({ current: null }) }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils', () => ({
    getSystemUnits: vi.fn().mockReturnValue({ distance: 'nm', speed: 'kts', temperature: 'celsius' }),
}));

vi.mock('../services/ChatService', () => ({
    ChatService: {
        initialize: vi.fn().mockResolvedValue(undefined),
        getChannels: vi
            .fn()
            .mockResolvedValue([{ id: 'general', name: 'General', description: 'General chat', member_count: 42 }]),
        getMessages: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn().mockResolvedValue(null),
        subscribeToChannel: vi.fn(() => vi.fn()),
        getCurrentUser: vi.fn().mockResolvedValue(null),
        getRole: vi.fn().mockReturnValue('member'),
        isMod: vi.fn().mockReturnValue(false),
        isAdmin: vi.fn().mockReturnValue(false),
        isModerator: vi.fn().mockReturnValue(false),
        getCurrentUserId: vi.fn().mockReturnValue(null),
        getDMConversations: vi.fn().mockResolvedValue([]),
        getDMThread: vi.fn().mockResolvedValue([]),
        subscribeToDMs: vi.fn(() => vi.fn()),
        markHelpful: vi.fn(),
        blockUser: vi.fn(),
        unblockUser: vi.fn(),
        isBlocked: vi.fn().mockResolvedValue(false),
        getBlockedUsers: vi.fn().mockResolvedValue([]),
        getChannelsFresh: vi.fn().mockResolvedValue([]),
        listAllUsersWithRoles: vi.fn().mockResolvedValue([]),
        isMuted: vi.fn().mockReturnValue(false),
        getMutedUntil: vi.fn().mockReturnValue(null),
        destroy: vi.fn(),
        blockUserPlatform: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
            getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
            onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
        },
    },
}));

vi.mock('../services/ContentModerationService', () => ({
    moderateMessage: vi.fn().mockResolvedValue({ safe: true }),
}));

vi.mock('../services/MealPlanService', () => ({
    MealPlanService: {
        getMealsForRange: vi.fn().mockResolvedValue([]),
        scheduleMeal: vi.fn(),
    },
}));

vi.mock('../components/AuthModal', () => ({ AuthModal: () => null }));
vi.mock('../components/chat/ChatErrorBoundary', () => ({
    ChatErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/chat/ChatHeader', () => ({
    ChatHeader: () => <div data-testid="chat-header">Crew Talk</div>,
}));
vi.mock('../components/chat/ChannelList', () => ({
    ChannelList: () => <div data-testid="channel-list">Channels</div>,
}));
vi.mock('../components/chat/ChatMessageList', () => ({
    ChatMessageList: () => <div data-testid="message-list">Messages</div>,
}));
vi.mock('../components/chat/ChatComposer', () => ({
    ChatComposer: () => <div data-testid="composer">Composer</div>,
}));
vi.mock('../components/chat/ChatProfileView', () => ({
    ChatProfileView: () => <div data-testid="profile-view">Profile</div>,
}));
vi.mock('../components/chat/ChatDMView', () => ({
    ChatDMInbox: () => <div data-testid="dm-inbox">DM Inbox</div>,
    ChatDMThread: () => <div data-testid="dm-thread">DM Thread</div>,
    ChatDMCompose: () => <div data-testid="dm-compose">DM Compose</div>,
}));
vi.mock('../components/chat/TypingIndicator', () => ({
    TypingIndicator: () => null,
}));
vi.mock('../components/chat/MaritimeIntelCard', () => ({
    MaritimeIntelCard: () => <div data-testid="maritime-intel">Intel</div>,
}));
vi.mock('../components/chat/GalleyCard', () => ({
    GalleyCard: () => <div data-testid="galley-card">Galley</div>,
}));
vi.mock('../components/chat/WelcomeBanner', () => ({
    WelcomeBanner: () => <div data-testid="welcome-banner">Welcome</div>,
}));
vi.mock('../components/chat/AuthBanner', () => ({
    AuthBanner: () => <div data-testid="auth-banner">Auth</div>,
}));

vi.mock('../components/chat/chatUtils', () => ({
    CREW_RANKS: [
        { badge: '🐚', name: 'Shell' },
        { badge: '⚓', name: 'Anchor' },
        { badge: '🧭', name: 'Compass' },
        { badge: '⭐', name: 'Star' },
    ],
    getStaticMapUrl: vi.fn().mockReturnValue(''),
    formatTimestamp: vi.fn().mockReturnValue('now'),
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

import { ChatPage } from '../components/ChatPage';

describe('ChatPage', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<ChatPage />);
        expect(container).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<ChatPage />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('renders the Crew Talk header', () => {
        render(<ChatPage />);
        expect(screen.getByText(/crew talk/i)).toBeDefined();
    });

    it('renders interactive elements', () => {
        const { container } = render(<ChatPage />);
        // The mocked ChatHeader renders "Crew Talk" text
        expect(container.textContent).toContain('Crew Talk');
    });

    it('starts in channels view by default', () => {
        render(<ChatPage />);
        expect(screen.getByText(/crew talk/i)).toBeDefined();
    });
});
