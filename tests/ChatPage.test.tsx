/**
 * ChatPage — component tests.
 * Verifies render, view switching, and banner display.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { User } from '@supabase/supabase-js';

const keyboardMocks = vi.hoisted(() => {
    let resolveImport!: () => void;
    const importGate = new Promise<void>((resolve) => {
        resolveImport = resolve;
    });
    return {
        importGate,
        resolveImport,
        addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })),
    };
});

vi.mock('@capacitor/keyboard', async () => {
    await keyboardMocks.importGate;
    return {
        Keyboard: {
            addListener: keyboardMocks.addListener,
        },
    };
});

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
            // The signed-in account's OWN boat (fictional). A crew member's
            // Crew Chat card must never name it (Shane 2026-10-02).
            vessel: { name: 'Kestrel' },
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
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../utils', () => ({
    getSystemUnits: vi.fn().mockReturnValue({ distance: 'nm', speed: 'kts', temperature: 'celsius' }),
}));

vi.mock('../services/ChatService', () => ({
    ChatService: {
        initialize: vi.fn().mockResolvedValue(undefined),
        reconcileAcceptedCrewChannels: vi.fn().mockResolvedValue({ status: 'ok', joinedCount: 0 }),
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
        getDMBlockStatus: vi.fn().mockResolvedValue({ blockedByMe: false, blockedEitherDirection: false }),
        getBlockedUsers: vi.fn().mockResolvedValue([]),
        getChannelsFresh: vi.fn().mockResolvedValue([]),
        listAllUsersWithRoles: vi.fn().mockResolvedValue([]),
        isMuted: vi.fn().mockReturnValue(false),
        getMutedUntil: vi.fn().mockReturnValue(null),
        destroy: vi.fn(),
        blockUserPlatform: vi.fn().mockResolvedValue(true),
        isChannelMember: vi.fn().mockResolvedValue(false),
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

vi.mock('../services/CrewService', () => ({
    getMyCrew: vi.fn().mockResolvedValue([]),
    getMyMemberships: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/VesselIdentityService', () => ({
    fetchVesselNameForOwner: vi.fn().mockResolvedValue(null),
}));

vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));
vi.mock('../components/chat/ChatErrorBoundary', () => ({
    ChatErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/chat/ChatHeader', () => ({
    ChatHeader: () => <div data-testid="chat-header">Crew Talk</div>,
}));
// Every Crew Chat card the list was handed, in paint order, so a test can
// prove the card never painted with a fallback name before the real one.
const crewCardPaints = vi.hoisted(
    () =>
        [] as Array<{
            hasCrewInvited: boolean;
            crewChatChannel: string;
            vesselName: string;
            crewChatVesselName: string;
        }>,
);
vi.mock('../components/chat/ChannelList', () => ({
    ChannelList: ({
        onRequestAccess,
        onOpenChannel,
        isAdmin,
        hasCrewInvited,
        crewChatChannel,
        vesselName,
        crewChatVesselName,
    }: {
        onRequestAccess: (channel: { id: string; name: string }) => void;
        onOpenChannel: (channel: { id: string; name: string }) => void;
        isAdmin?: boolean;
        hasCrewInvited?: boolean;
        crewChatChannel?: { id: string } | null;
        vesselName?: string;
        crewChatVesselName?: string;
    }) => {
        crewCardPaints.push({
            hasCrewInvited: !!hasCrewInvited,
            crewChatChannel: crewChatChannel?.id ?? '',
            vesselName: vesselName ?? '',
            crewChatVesselName: crewChatVesselName ?? '',
        });
        return (
            <div
                data-testid="channel-list"
                data-has-crew-invited={String(!!hasCrewInvited)}
                data-crew-chat-channel={crewChatChannel?.id ?? ''}
                data-vessel-name={vesselName ?? ''}
                data-crew-chat-vessel-name={crewChatVesselName ?? ''}
            >
                Channels
                {isAdmin && <div>Admin card</div>}
                <button onClick={() => onOpenChannel({ id: 'general', name: 'General' })}>Open General</button>
                <button onClick={() => onRequestAccess({ id: 'private-1', name: 'Skippers Lounge' })}>
                    Request private channel
                </button>
            </div>
        );
    },
}));

// The real service answers "no passage" here (no signed-in Supabase user);
// the crew-only tests swap in a skipper's passage that the crew may chat on.
vi.mock('../services/PassagePlanService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/PassagePlanService')>();
    return { ...actual, getPassageStatus: vi.fn().mockResolvedValue(actual.NO_PASSAGE_ACCESS) };
});
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
import { ChatService, type ChatChannel } from '../services/ChatService';
import { getMyCrew, getMyMemberships, type CrewMember } from '../services/CrewService';
import { fetchVesselNameForOwner } from '../services/VesselIdentityService';
import { NO_PASSAGE_ACCESS, getPassageStatus } from '../services/PassagePlanService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useAuthStore } from '../stores/authStore';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function signInFixture(id = 'crew-a') {
    setAuthIdentityScope(id);
    useAuthStore.setState({ user: { id } as User });
}
afterEach(() => {
    cleanup();
    useAuthStore.setState({ user: null });
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

const renderSettledChatPage = async () => {
    const result = render(<ChatPage />);

    await waitFor(() => {
        expect(ChatService.getChannelsFresh).toHaveBeenCalled();
    });
    await act(async () => {
        await Promise.resolve();
    });

    return result;
};

describe('ChatPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(ChatService.initialize).mockResolvedValue(undefined);
        vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockResolvedValue({ status: 'ok', joinedCount: 0 });
        vi.mocked(ChatService.getChannelsFresh).mockResolvedValue([]);
        vi.mocked(ChatService.isChannelMember).mockResolvedValue(false);
        vi.mocked(getMyCrew).mockResolvedValue([]);
        vi.mocked(getMyMemberships).mockResolvedValue([]);
        vi.mocked(fetchVesselNameForOwner).mockResolvedValue(null);
    });

    it('reconciles only after initialization and before the authenticated fresh channel read', async () => {
        signInFixture();
        const initialized = deferred<void>();
        const repaired = deferred<Awaited<ReturnType<typeof ChatService.reconcileAcceptedCrewChannels>>>();
        vi.mocked(ChatService.initialize).mockReturnValueOnce(initialized.promise);
        vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockReturnValueOnce(repaired.promise);
        render(<ChatPage />);
        await waitFor(() => expect(ChatService.initialize).toHaveBeenCalledTimes(1));
        expect(ChatService.reconcileAcceptedCrewChannels).not.toHaveBeenCalled();
        expect(ChatService.getChannelsFresh).not.toHaveBeenCalled();
        await act(async () => initialized.resolve());
        await waitFor(() => expect(ChatService.reconcileAcceptedCrewChannels).toHaveBeenCalledTimes(1));
        expect(ChatService.getChannelsFresh).not.toHaveBeenCalled();
        await act(async () => repaired.resolve({ status: 'ok', joinedCount: 1 }));
        await waitFor(() => expect(ChatService.getChannelsFresh).toHaveBeenCalledTimes(1));
        expect(ChatService.reconcileAcceptedCrewChannels).toHaveBeenCalledWith(
            getAuthIdentityScope(),
            expect.any(AbortSignal),
        );
        expect(ChatService.getChannelsFresh).toHaveBeenCalledWith(getAuthIdentityScope(), expect.any(AbortSignal));
    });

    it('still fetches channels after a failed repair and retries repair on the next chat load', async () => {
        signInFixture();
        vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockResolvedValueOnce({
            status: 'failed',
            reason: 'channel_join',
            failedOwners: 1,
        });
        const first = await renderSettledChatPage();
        expect(ChatService.reconcileAcceptedCrewChannels).toHaveBeenCalledTimes(1);
        first.unmount();
        render(<ChatPage />);
        await waitFor(() => expect(ChatService.getChannelsFresh).toHaveBeenCalledTimes(2));
        expect(ChatService.reconcileAcceptedCrewChannels).toHaveBeenCalledTimes(2);
    });

    it('cancels the old load during account switch and does not refetch A after late repair completion', async () => {
        signInFixture();
        const old = deferred<Awaited<ReturnType<typeof ChatService.reconcileAcceptedCrewChannels>>>();
        vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockReturnValueOnce(old.promise);
        render(<ChatPage />);
        await waitFor(() => expect(ChatService.reconcileAcceptedCrewChannels).toHaveBeenCalledTimes(1));
        const oldSignal = vi.mocked(ChatService.reconcileAcceptedCrewChannels).mock.calls[0][1]!;
        act(() => signInFixture('crew-b'));
        await waitFor(() => expect(ChatService.getChannelsFresh).toHaveBeenCalledTimes(1));
        expect(oldSignal.aborted).toBe(true);
        await act(async () => old.resolve({ status: 'ok', joinedCount: 1 }));
        expect(vi.mocked(ChatService.getChannelsFresh).mock.calls.map(([scope]) => scope?.userId)).toEqual(['crew-b']);
    });

    it('bounds a stalled repair, aborts its wait, and leaves the channel screen available for next-load retry', async () => {
        vi.useFakeTimers();
        signInFixture();
        const pending = deferred<Awaited<ReturnType<typeof ChatService.reconcileAcceptedCrewChannels>>>();
        vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockReturnValueOnce(pending.promise);
        render(<ChatPage />);
        await act(async () => {
            for (let index = 0; index < 30; index += 1) await Promise.resolve();
        });
        expect(ChatService.reconcileAcceptedCrewChannels).toHaveBeenCalledTimes(1);
        const signal = vi.mocked(ChatService.reconcileAcceptedCrewChannels).mock.calls[0][1]!;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(8000);
        });
        expect(signal.aborted).toBe(true);
        expect(ChatService.getChannelsFresh).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('channel-list')).toBeTruthy();
        await act(async () => pending.resolve({ status: 'ok', joinedCount: 1 }));
        expect(ChatService.getChannelsFresh).toHaveBeenCalledTimes(1);
    });

    it('paints the Admin card and the channels together — never the card a beat later on top', async () => {
        // Shane 2026-09-09: "the Admin card arrives at the moment i try to press
        // something" — channels came back from cache before the roles did, so
        // the crown card pushed the row under his thumb down. The list now
        // waits for the roles; both land in one paint.
        let finishInit!: () => void;
        vi.mocked(ChatService.initialize).mockReturnValueOnce(
            new Promise<void>((resolve) => {
                finishInit = resolve;
            }),
        );
        vi.mocked(ChatService.isAdmin).mockReturnValue(false); // unknown until init
        render(<ChatPage />);
        await waitFor(() => expect(ChatService.getChannels).toHaveBeenCalled());
        // Channels are in hand, roles are not: still the skeleton, no list.
        expect(screen.queryByTestId('channel-list')).toBeNull();

        vi.mocked(ChatService.isAdmin).mockReturnValue(true);
        finishInit();
        const list = await screen.findByTestId('channel-list');
        expect(list).toHaveTextContent('Admin card');
        expect(list).toHaveTextContent('Open General');
        vi.mocked(ChatService.isAdmin).mockReturnValue(false);
    });

    it('renders without crashing', async () => {
        const { container } = await renderSettledChatPage();
        expect(container).toBeDefined();
    });

    it('renders content (not empty)', async () => {
        const { container } = await renderSettledChatPage();
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('renders the Crew Talk header', async () => {
        await renderSettledChatPage();
        expect(screen.getByText(/crew talk/i)).toBeDefined();
    });

    it('renders interactive elements', async () => {
        const { container } = await renderSettledChatPage();
        // The mocked ChatHeader renders "Crew Talk" text
        expect(container.textContent).toContain('Crew Talk');
    });

    it('starts in channels view by default', async () => {
        await renderSettledChatPage();
        expect(screen.getByText(/crew talk/i)).toBeDefined();
    });

    it('contains the private-channel request and restores focus after Escape', async () => {
        await renderSettledChatPage();
        const opener = screen.getByRole('button', { name: 'Request private channel' });
        opener.focus();
        fireEvent.click(opener);

        const cancel = screen.getByRole('button', { name: 'Cancel request' });
        expect(screen.getByRole('dialog', { name: 'Request access to Skippers Lounge' })).toContainElement(cancel);
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /Request access/ })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('does not install keyboard listeners when its lazy import resolves after unmount', async () => {
        const { unmount } = await renderSettledChatPage();

        fireEvent.click(screen.getByRole('button', { name: 'Open General' }));
        unmount();
        keyboardMocks.resolveImport();
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(keyboardMocks.addListener).not.toHaveBeenCalled();
    });
});

// Shane 2026-10-02: "it is the correct group, but it is just saying the wrong
// vessel". The crew member owns 'Kestrel' and is crew on 'Albatross' (both
// fictional); the card opens Albatross's group, so it names Albatross.
describe('ChatPage Crew Chat card vessel name', () => {
    const groupOwnedBy = (ownerId: string) =>
        ({
            id: `crew-chat-${ownerId}`,
            name: 'Crew Chat',
            description: '',
            icon: '👥',
            is_private: true,
            is_global: false,
            owner_id: ownerId,
            parent_id: null,
            region: null,
            created_at: '2026-10-01T00:00:00Z',
        }) as ChatChannel;
    const membershipWith = (ownerId: string, crewId: string) =>
        ({ id: 'membership-1', owner_id: ownerId, crew_user_id: crewId, status: 'accepted' }) as CrewMember;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(ChatService.initialize).mockResolvedValue(undefined);
        vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockResolvedValue({ status: 'ok', joinedCount: 0 });
        vi.mocked(ChatService.isChannelMember).mockResolvedValue(true);
        vi.mocked(getMyCrew).mockResolvedValue([]);
        vi.mocked(getMyMemberships).mockResolvedValue([]);
        vi.mocked(fetchVesselNameForOwner).mockResolvedValue(null);
        vi.mocked(getPassageStatus).mockResolvedValue(NO_PASSAGE_ACCESS);
        crewCardPaints.length = 0;
    });

    // A crew-only account (owns Kestrel, no crew of its own) with the
    // skipper's passage selected sees the card before the skipper's group is
    // known: the membership check is still in flight. The card used to fall
    // back to the account's own boat here.
    it("never names a crew-only account's own boat while the skipper's group is still unknown", async () => {
        signInFixture('crew-a');
        vi.mocked(getPassageStatus).mockResolvedValue({
            ...NO_PASSAGE_ACCESS,
            visible: true,
            voyageId: 'voyage-1',
            ownerUserId: 'skipper-1',
            isOwner: false,
            canViewChat: true,
        });
        vi.mocked(ChatService.getChannelsFresh).mockResolvedValue([groupOwnedBy('skipper-1')]);
        vi.mocked(getMyMemberships).mockResolvedValue([membershipWith('skipper-1', 'crew-a')]);
        vi.mocked(ChatService.isChannelMember).mockReturnValue(new Promise<boolean>(() => {}));

        render(<ChatPage />);

        const list = await screen.findByTestId('channel-list');
        await waitFor(() => expect(list).toHaveAttribute('data-has-crew-invited', 'true'));
        expect(list).toHaveAttribute('data-crew-chat-channel', '');
        expect(list).toHaveAttribute('data-vessel-name', '');
        expect(crewCardPaints.filter((paint) => paint.hasCrewInvited).map((paint) => paint.vesselName)).not.toContain(
            'Kestrel',
        );
    });

    // Low (review 2026-10-02): the name used to be read after the card had
    // painted, so every visit swapped "on the vessel" for the name a beat
    // later. It is now read before the card can show.
    it('paints the crew card once, already carrying the connected vessel', async () => {
        signInFixture('crew-a');
        vi.mocked(ChatService.getChannelsFresh).mockResolvedValue([groupOwnedBy('skipper-1')]);
        vi.mocked(getMyMemberships).mockResolvedValue([membershipWith('skipper-1', 'crew-a')]);
        vi.mocked(fetchVesselNameForOwner).mockResolvedValue('Albatross');

        render(<ChatPage />);

        const list = await screen.findByTestId('channel-list');
        await waitFor(() => expect(list).toHaveAttribute('data-crew-chat-channel', 'crew-chat-skipper-1'));
        const cardPaints = crewCardPaints.filter((paint) => paint.hasCrewInvited);
        expect(cardPaints.length).toBeGreaterThan(0);
        expect(cardPaints.map((paint) => paint.crewChatVesselName)).toEqual(cardPaints.map(() => 'Albatross'));
    });

    it('shows the card after a short wait on a slow link, then names the vessel when the read lands', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        signInFixture('crew-a');
        vi.mocked(ChatService.getChannelsFresh).mockResolvedValue([groupOwnedBy('skipper-1')]);
        vi.mocked(getMyMemberships).mockResolvedValue([membershipWith('skipper-1', 'crew-a')]);
        const nameRead = deferred<string | null>();
        vi.mocked(fetchVesselNameForOwner).mockReturnValue(nameRead.promise);

        render(<ChatPage />);

        const list = await screen.findByTestId('channel-list');
        await waitFor(() => expect(fetchVesselNameForOwner).toHaveBeenCalledWith('skipper-1'));
        expect(list).toHaveAttribute('data-has-crew-invited', 'false');

        // Past the short name wait: the card shows with the generic wording.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3000);
        });
        await waitFor(() => expect(list).toHaveAttribute('data-crew-chat-channel', 'crew-chat-skipper-1'));
        expect(list).toHaveAttribute('data-crew-chat-vessel-name', '');

        await act(async () => nameRead.resolve('Albatross'));
        await waitFor(() => expect(list).toHaveAttribute('data-crew-chat-vessel-name', 'Albatross'));
    });

    it("gives a crew member's card the connected skipper's vessel, read by that skipper's id", async () => {
        signInFixture('crew-a');
        vi.mocked(ChatService.getChannelsFresh).mockResolvedValue([groupOwnedBy('skipper-1')]);
        vi.mocked(getMyMemberships).mockResolvedValue([membershipWith('skipper-1', 'crew-a')]);
        vi.mocked(fetchVesselNameForOwner).mockResolvedValue('Albatross');

        render(<ChatPage />);

        const list = await screen.findByTestId('channel-list');
        await waitFor(() => expect(list).toHaveAttribute('data-crew-chat-vessel-name', 'Albatross'));
        expect(list).toHaveAttribute('data-crew-chat-channel', 'crew-chat-skipper-1');
        expect(fetchVesselNameForOwner).toHaveBeenCalledWith('skipper-1');
        expect(fetchVesselNameForOwner).not.toHaveBeenCalledWith('crew-a');
    });

    it("leaves a skipper's own card on their own vessel and reads nobody else's", async () => {
        signInFixture('skipper-1');
        vi.mocked(ChatService.getChannelsFresh).mockResolvedValue([groupOwnedBy('skipper-1')]);
        vi.mocked(getMyCrew).mockResolvedValue([membershipWith('skipper-1', 'crew-a')]);

        render(<ChatPage />);

        const list = await screen.findByTestId('channel-list');
        await waitFor(() => expect(list).toHaveAttribute('data-has-crew-invited', 'true'));
        expect(list).toHaveAttribute('data-crew-chat-channel', '');
        expect(list).toHaveAttribute('data-vessel-name', 'Kestrel');
        expect(list).toHaveAttribute('data-crew-chat-vessel-name', '');
        expect(fetchVesselNameForOwner).not.toHaveBeenCalled();
    });
});
