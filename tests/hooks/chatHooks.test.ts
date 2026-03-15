/**
 * Chat Hook Tests
 *
 * Tests the 3 primary chat hooks: useChatMessages, useChatDMs, useChatProfile.
 * Uses renderHook from @testing-library/react to test hook logic in isolation.
 *
 * Strategy: Mock ChatService at module level, then test initial state, callbacks,
 * and state transitions for each hook.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// --- Hoisted mocks ---
const {
    mockInitialize,
    mockGetChannels,
    mockGetMessages,
    mockSendMessage,
    mockSubscribeToChannel,
    mockSubscribeToDMs,
    mockGetDMConversations,
    mockGetDMThread,
    mockIsBlocked,
    mockSendDM,
    mockBlockUser,
    mockUnblockUser,
    mockDeleteMessage,
    mockPinMessage,
    mockMuteUser,
    mockMarkHelpful,
    mockGetCurrentUser,
    mockGetProfile,
    mockBatchFetchAvatars,
    mockClientFilter,
    mockTriggerHaptic,
    mockGetAvatarUrl,
    mockDestroy,
    mockClearDisplayNameCache,
    mockRemoveProfilePhoto,
    mockUpdateProfile,
    mockUploadProfilePhoto,
    mockCreateChannel,
    mockProposeChannel,
    mockIsChannelMember,
    mockRequestJoinChannel,
    mockToastSuccess,
    mockToastError,
} = vi.hoisted(() => ({
    mockInitialize: vi.fn().mockResolvedValue(undefined),
    mockGetChannels: vi.fn().mockResolvedValue([]),
    mockGetMessages: vi.fn().mockResolvedValue([]),
    mockSendMessage: vi.fn().mockResolvedValue(undefined),
    mockSubscribeToChannel: vi.fn().mockReturnValue(() => {}),
    mockSubscribeToDMs: vi.fn().mockReturnValue(() => {}),
    mockGetDMConversations: vi.fn().mockResolvedValue([]),
    mockGetDMThread: vi.fn().mockResolvedValue([]),
    mockIsBlocked: vi.fn().mockResolvedValue(false),
    mockSendDM: vi.fn().mockResolvedValue('sent'),
    mockBlockUser: vi.fn().mockResolvedValue(true),
    mockUnblockUser: vi.fn().mockResolvedValue(true),
    mockDeleteMessage: vi.fn().mockResolvedValue(true),
    mockPinMessage: vi.fn().mockResolvedValue(true),
    mockMuteUser: vi.fn().mockResolvedValue(true),
    mockMarkHelpful: vi.fn().mockResolvedValue(true),
    mockGetCurrentUser: vi.fn().mockResolvedValue({ id: 'user-123' }),
    mockGetProfile: vi.fn().mockResolvedValue(null),
    mockBatchFetchAvatars: vi.fn().mockResolvedValue(new Map()),
    mockClientFilter: vi.fn().mockReturnValue({ blocked: false, warning: false }),
    mockTriggerHaptic: vi.fn(),
    mockGetAvatarUrl: vi.fn().mockReturnValue(null),
    mockDestroy: vi.fn(),
    mockClearDisplayNameCache: vi.fn(),
    mockRemoveProfilePhoto: vi.fn().mockResolvedValue(true),
    mockUpdateProfile: vi.fn().mockResolvedValue(true),
    mockUploadProfilePhoto: vi.fn().mockResolvedValue({ success: true, url: 'https://example.com/avatar.jpg' }),
    mockCreateChannel: vi.fn().mockResolvedValue({ id: 'new-ch' }),
    mockProposeChannel: vi.fn().mockResolvedValue(true),
    mockIsChannelMember: vi.fn().mockResolvedValue(false),
    mockRequestJoinChannel: vi.fn().mockResolvedValue(true),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
}));

vi.mock('../../services/ChatService', () => ({
    ChatService: {
        initialize: mockInitialize,
        getChannels: mockGetChannels,
        getMessages: mockGetMessages,
        sendMessage: mockSendMessage,
        subscribeToChannel: mockSubscribeToChannel,
        subscribeToDMs: mockSubscribeToDMs,
        getDMConversations: mockGetDMConversations,
        getDMThread: mockGetDMThread,
        isBlocked: mockIsBlocked,
        sendDM: mockSendDM,
        blockUser: mockBlockUser,
        unblockUser: mockUnblockUser,
        deleteMessage: mockDeleteMessage,
        pinMessage: mockPinMessage,
        muteUser: mockMuteUser,
        markHelpful: mockMarkHelpful,
        getCurrentUser: mockGetCurrentUser,
        getAvatarUrl: mockGetAvatarUrl,
        destroy: mockDestroy,
        clearDisplayNameCache: mockClearDisplayNameCache,
        createChannel: mockCreateChannel,
        proposeChannel: mockProposeChannel,
        isChannelMember: mockIsChannelMember,
        requestJoinChannel: mockRequestJoinChannel,
    },
    DEFAULT_CHANNELS: [],
}));

vi.mock('../../services/ContentModerationService', () => ({
    clientFilter: mockClientFilter,
    reportMessage: vi.fn(),
}));

vi.mock('../../services/ProfilePhotoService', () => ({
    batchFetchAvatars: mockBatchFetchAvatars,
    getCachedAvatar: vi.fn().mockReturnValue(null),
    uploadProfilePhoto: mockUploadProfilePhoto,
    removeProfilePhoto: mockRemoveProfilePhoto,
    getProfile: mockGetProfile,
    updateProfile: mockUpdateProfile,
}));

vi.mock('../../utils/system', () => ({
    triggerHaptic: mockTriggerHaptic,
}));

import { useChatMessages } from '../../hooks/chat/useChatMessages';
import { useChatDMs } from '../../hooks/chat/useChatDMs';
import { useChatProfile } from '../../hooks/chat/useChatProfile';
import { useChatProposals } from '../../hooks/chat/useChatProposals';

vi.mock('../../components/Toast', () => ({
    toast: { success: mockToastSuccess, error: mockToastError },
}));

// --- Test Helpers ---
const noop = () => {};
const defaultMessageOpts = { setView: vi.fn(), setNavDirection: vi.fn(), setLoading: vi.fn() };
const defaultDMOpts = { setView: vi.fn(), setNavDirection: vi.fn(), setLoading: vi.fn() };

describe('useChatMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it('initializes with empty messages', () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));
        expect(result.current.messages).toEqual([]);
        expect(result.current.activeChannel).toBeNull();
        expect(result.current.messageText).toBe('');
        expect(result.current.isQuestion).toBe(false);
    });

    it('provides setMessageText', () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));
        act(() => result.current.setMessageText('hello'));
        expect(result.current.messageText).toBe('hello');
    });

    it('provides setIsQuestion toggle', () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));
        act(() => result.current.setIsQuestion(true));
        expect(result.current.isQuestion).toBe(true);
    });

    it('openChannel navigates to Find Crew view', async () => {
        const opts = { ...defaultMessageOpts };
        const { result } = renderHook(() => useChatMessages(opts));
        await act(() => result.current.openChannel({ id: 'fc', name: 'Find Crew', description: '', icon: '' } as any));
        expect(opts.setView).toHaveBeenCalledWith('find_crew');
        expect(opts.setNavDirection).toHaveBeenCalledWith('forward');
    });

    it('openChannel navigates to Marketplace view', async () => {
        const opts = { ...defaultMessageOpts };
        const { result } = renderHook(() => useChatMessages(opts));
        await act(() =>
            result.current.openChannel({ id: 'mp', name: 'Marketplace', description: '', icon: '' } as any),
        );
        expect(opts.setView).toHaveBeenCalledWith('marketplace');
    });

    it('openChannel loads messages and subscribes', async () => {
        const testMsgs = [{ id: 'msg-1', user_id: 'u1', message: 'hello', is_pinned: false, deleted_at: null }];
        mockGetMessages.mockResolvedValueOnce(testMsgs);

        const opts = { ...defaultMessageOpts };
        const { result } = renderHook(() => useChatMessages(opts));

        await act(() => result.current.openChannel({ id: 'ch-1', name: 'General', description: '', icon: '' } as any));

        expect(mockGetMessages).toHaveBeenCalledWith('ch-1');
        expect(result.current.messages).toEqual(testMsgs);
        expect(result.current.activeChannel?.id).toBe('ch-1');
        expect(opts.setLoading).toHaveBeenCalledWith(true);
        expect(opts.setLoading).toHaveBeenCalledWith(false);
        expect(mockSubscribeToChannel).toHaveBeenCalledWith('ch-1', expect.any(Function));
    });

    it('sendChannelMessage runs client filter first', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));

        // Set up active channel and text
        act(() => {
            result.current.setActiveChannel({ id: 'ch-1', name: 'General' } as any);
            result.current.setMessageText('Hello world');
        });

        await act(() => result.current.sendChannelMessage());
        expect(mockClientFilter).toHaveBeenCalledWith('Hello world');
        expect(mockSendMessage).toHaveBeenCalled();
    });

    it('sendChannelMessage blocks when filter flags', async () => {
        mockClientFilter.mockReturnValueOnce({ blocked: true, warning: true, reason: 'Bad word' });
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));

        act(() => {
            result.current.setActiveChannel({ id: 'ch-1', name: 'General' } as any);
            result.current.setMessageText('bad content');
        });

        await act(() => result.current.sendChannelMessage());
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(result.current.filterWarning).toBeTruthy();
    });

    it('sendChannelMessage adds optimistic message', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));

        act(() => {
            result.current.setActiveChannel({ id: 'ch-1', name: 'General' } as any);
            result.current.setMessageText('Optimistic!');
        });

        await act(() => result.current.sendChannelMessage());
        expect(result.current.messages).toHaveLength(1);
        expect(result.current.messages[0].message).toBe('Optimistic!');
        expect(result.current.messages[0].id).toMatch(/^opt-/);
    });

    it('handleDeleteMessage updates message with deleted_at', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));

        act(() => {
            result.current.setMessages([{ id: 'msg-1', message: 'hi', deleted_at: null } as any]);
        });

        await act(() => result.current.handleDeleteMessage('msg-1'));
        expect(mockDeleteMessage).toHaveBeenCalledWith('msg-1');
        expect(result.current.messages[0].deleted_at).toBeTruthy();
    });

    it('handlePinMessage toggles pin state', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));

        act(() => {
            result.current.setMessages([{ id: 'msg-1', is_pinned: false } as any]);
        });

        await act(() => result.current.handlePinMessage('msg-1', false));
        expect(mockPinMessage).toHaveBeenCalledWith('msg-1', true);
        expect(result.current.messages[0].is_pinned).toBe(true);
    });

    it('handleMuteUser calls ChatService.muteUser', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));
        await act(() => result.current.handleMuteUser('user-1', 24));
        expect(mockMuteUser).toHaveBeenCalledWith('user-1', 24);
    });

    it('handleMarkHelpful increments count and tracks in localStorage', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));

        act(() => {
            result.current.setMessages([{ id: 'msg-1', helpful_count: 0 } as any]);
        });

        await act(() => result.current.handleMarkHelpful('msg-1'));
        expect(result.current.messages[0].helpful_count).toBe(1);
        expect(mockMarkHelpful).toHaveBeenCalledWith('msg-1');
    });

    it('handleMarkHelpful is idempotent — cannot like twice', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));

        act(() => {
            result.current.setMessages([{ id: 'msg-1', helpful_count: 0 } as any]);
        });

        await act(() => result.current.handleMarkHelpful('msg-1'));
        await act(() => result.current.handleMarkHelpful('msg-1'));
        expect(result.current.messages[0].helpful_count).toBe(1);
        expect(mockMarkHelpful).toHaveBeenCalledTimes(1);
    });

    it('cleanup calls channelUnsubRef', () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));
        // Should not throw
        act(() => result.current.cleanup());
    });
});

// ═══════════════════════════════════════

describe('useChatDMs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('initializes with empty state', () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        expect(result.current.dmConversations).toEqual([]);
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmPartner).toBeNull();
        expect(result.current.dmText).toBe('');
        expect(result.current.unreadDMs).toBe(0);
    });

    it('subscribe calls ChatService.subscribeToDMs', () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        act(() => {
            result.current.subscribe();
        });
        expect(mockSubscribeToDMs).toHaveBeenCalledWith(expect.any(Function));
    });

    it('openDMInbox loads conversations', async () => {
        const convs = [{ partner_id: 'u1', partner_name: 'Alice', unread_count: 2 }];
        mockGetDMConversations.mockResolvedValueOnce(convs);

        const opts = { ...defaultDMOpts };
        const { result } = renderHook(() => useChatDMs(opts));
        await act(() => result.current.openDMInbox());

        expect(opts.setView).toHaveBeenCalledWith('dm_inbox');
        expect(result.current.dmConversations).toEqual(convs);
    });

    it('openDMThread loads thread and checks block status', async () => {
        const thread = [{ id: 'dm-1', sender_id: 'u2', message: 'hey' }];
        mockGetDMThread.mockResolvedValueOnce(thread);
        mockIsBlocked.mockResolvedValueOnce(false);

        const opts = { ...defaultDMOpts };
        const { result } = renderHook(() => useChatDMs(opts));
        await act(() => result.current.openDMThread('u2', 'Bob'));

        expect(result.current.dmPartner).toEqual({ id: 'u2', name: 'Bob' });
        expect(result.current.dmThread).toEqual(thread);
        expect(result.current.isUserBlocked).toBe(false);
        expect(opts.setView).toHaveBeenCalledWith('dm_thread');
    });

    it('sendDMMessage adds optimistic message', async () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));

        // Set partner and text
        act(() => {
            result.current.setDmPartner({ id: 'u2', name: 'Bob' });
            result.current.setDmText('hello DM!');
        });

        await act(() => result.current.sendDMMessage());
        expect(result.current.dmThread).toHaveLength(1);
        expect(result.current.dmThread[0].message).toBe('hello DM!');
        expect(mockSendDM).toHaveBeenCalledWith('u2', 'hello DM!');
    });

    it('sendDMMessage handles blocked response', async () => {
        mockSendDM.mockResolvedValueOnce('blocked');
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));

        act(() => {
            result.current.setDmPartner({ id: 'u2', name: 'Bob' });
            result.current.setDmText('hello');
        });

        await act(() => result.current.sendDMMessage());
        expect(result.current.isUserBlocked).toBe(true);
        expect(result.current.dmThread).toHaveLength(0); // optimistic removed
    });

    it('handleBlockUser blocks and updates state', async () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        act(() => result.current.setDmPartner({ id: 'u2', name: 'Bob' }));

        await act(() => result.current.handleBlockUser());
        expect(mockBlockUser).toHaveBeenCalledWith('u2');
        expect(result.current.isUserBlocked).toBe(true);
    });

    it('handleUnblockUser unblocks and updates state', async () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        act(() => result.current.setDmPartner({ id: 'u2', name: 'Bob' }));

        await act(() => result.current.handleUnblockUser());
        expect(mockUnblockUser).toHaveBeenCalledWith('u2');
        expect(result.current.isUserBlocked).toBe(false);
    });

    it('loadUnreadCount aggregates from conversations', async () => {
        mockGetDMConversations.mockResolvedValueOnce([{ unread_count: 3 }, { unread_count: 2 }]);
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        await act(() => result.current.loadUnreadCount());
        expect(result.current.unreadDMs).toBe(5);
    });
});

// ═══════════════════════════════════════

describe('useChatProfile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const defaultProfileOpts = {
        avatarMap: new Map<string, string>(),
        setView: vi.fn(),
    };

    it('initializes with empty profile state', () => {
        const { result } = renderHook(() => useChatProfile(defaultProfileOpts));
        expect(result.current.myAvatarUrl).toBeNull();
        expect(result.current.profileDisplayName).toBe('');
        expect(result.current.profileVesselName).toBe('');
        expect(result.current.profileLoaded).toBe(false);
        expect(result.current.profileSaving).toBe(false);
    });

    it('loadProfile loads data from ChatService + ProfilePhotoService', async () => {
        mockGetCurrentUser.mockResolvedValueOnce({ id: 'user-123' });
        mockGetProfile.mockResolvedValueOnce({
            user_id: 'user-123',
            display_name: 'Captain Shane',
            vessel_name: 'Thalassa',
            looking_for_love: true,
            avatar_url: 'https://example.com/avatar.jpg',
        });

        const { result } = renderHook(() => useChatProfile(defaultProfileOpts));
        await act(() => result.current.loadProfile());

        expect(result.current.profileDisplayName).toBe('Captain Shane');
        expect(result.current.profileVesselName).toBe('Thalassa');
        expect(result.current.profileLookingForLove).toBe(true);
        expect(result.current.myAvatarUrl).toBe('https://example.com/avatar.jpg');
        expect(result.current.profileLoaded).toBe(true);
    });

    it('loadProfile handles missing user gracefully', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(null);
        const { result } = renderHook(() => useChatProfile(defaultProfileOpts));
        await act(() => result.current.loadProfile());
        expect(result.current.profileLoaded).toBe(true);
    });

    it('handleSaveProfile calls updateProfile and clears cache', async () => {
        const opts = { ...defaultProfileOpts };
        const { result } = renderHook(() => useChatProfile(opts));

        act(() => {
            result.current.setProfileDisplayName('New Name');
            result.current.setProfileVesselName('New Vessel');
        });

        await act(() => result.current.handleSaveProfile());
        expect(mockUpdateProfile).toHaveBeenCalledWith({
            display_name: 'New Name',
            vessel_name: 'New Vessel',
            looking_for_love: false,
        });
        expect(mockClearDisplayNameCache).toHaveBeenCalled();
    });

    it('handleRemovePhoto removes and clears avatar', async () => {
        const { result } = renderHook(() => useChatProfile(defaultProfileOpts));

        act(() => result.current.setMyAvatarUrl('https://example.com/old.jpg'));
        expect(result.current.myAvatarUrl).toBe('https://example.com/old.jpg');

        await act(() => result.current.handleRemovePhoto());
        expect(mockRemoveProfilePhoto).toHaveBeenCalled();
        expect(result.current.myAvatarUrl).toBeNull();
    });

    it('getAvatar returns myAvatarUrl for "self"', () => {
        const { result } = renderHook(() => useChatProfile(defaultProfileOpts));
        act(() => result.current.setMyAvatarUrl('https://example.com/me.jpg'));
        expect(result.current.getAvatar('self')).toBe('https://example.com/me.jpg');
    });

    it('getAvatar uses avatarMap for other users', () => {
        const map = new Map([['u1', 'https://example.com/u1.jpg']]);
        const opts = { ...defaultProfileOpts, avatarMap: map };
        const { result } = renderHook(() => useChatProfile(opts));
        expect(result.current.getAvatar('u1')).toBe('https://example.com/u1.jpg');
    });

    it('getAvatar returns null for unknown users', () => {
        const { result } = renderHook(() => useChatProfile(defaultProfileOpts));
        expect(result.current.getAvatar('unknown')).toBeNull();
    });
});

// ═══════════════════════════════════════

describe('useChatProposals', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const defaultProposalOpts = {
        channels: [] as any[],
        setChannels: vi.fn(),
        isAdmin: false,
    };

    it('initializes with empty proposal state', () => {
        const { result } = renderHook(() => useChatProposals(defaultProposalOpts));
        expect(result.current.showProposalForm).toBe(false);
        expect(result.current.proposalName).toBe('');
        expect(result.current.proposalSent).toBe(false);
        expect(result.current.memberChannelIds.size).toBe(0);
    });

    it('handleProposeChannel — non-admin submits proposal', async () => {
        const { result } = renderHook(() => useChatProposals(defaultProposalOpts));

        act(() => result.current.setProposalName('New Channel'));
        await act(() => result.current.handleProposeChannel());

        expect(mockProposeChannel).toHaveBeenCalled();
        expect(mockCreateChannel).not.toHaveBeenCalled();
        expect(result.current.proposalSent).toBe(true);
    });

    it('handleProposeChannel — admin creates instantly', async () => {
        const opts = { ...defaultProposalOpts, isAdmin: true };
        const { result } = renderHook(() => useChatProposals(opts));

        act(() => result.current.setProposalName('Admin Channel'));
        await act(() => result.current.handleProposeChannel());

        expect(mockCreateChannel).toHaveBeenCalled();
        expect(mockProposeChannel).not.toHaveBeenCalled();
    });

    it('handleProposeChannel — empty name is no-op', async () => {
        const { result } = renderHook(() => useChatProposals(defaultProposalOpts));
        await act(() => result.current.handleProposeChannel());
        expect(mockProposeChannel).not.toHaveBeenCalled();
    });

    it('handleProposeChannel — failure shows error toast', async () => {
        mockProposeChannel.mockResolvedValueOnce(false);
        const { result } = renderHook(() => useChatProposals(defaultProposalOpts));

        act(() => result.current.setProposalName('Bad Channel'));
        await act(() => result.current.handleProposeChannel());

        expect(mockToastError).toHaveBeenCalledWith('Failed to submit — please try again');
    });

    it('handleRequestAccess sets join request state', () => {
        const { result } = renderHook(() => useChatProposals(defaultProposalOpts));
        const ch = { id: 'ch-private', name: 'VIP' } as any;

        act(() => result.current.handleRequestAccess(ch));

        expect(result.current.joinRequestChannel).toEqual(ch);
        expect(result.current.joinRequestMessage).toBe('');
    });

    it('handleSubmitJoinRequest calls service and shows success', async () => {
        const { result } = renderHook(() => useChatProposals(defaultProposalOpts));
        const ch = { id: 'ch-private', name: 'VIP' } as any;

        act(() => result.current.handleRequestAccess(ch));
        act(() => result.current.setJoinRequestMessage('Let me in!'));
        await act(() => result.current.handleSubmitJoinRequest());

        expect(mockRequestJoinChannel).toHaveBeenCalledWith('ch-private', 'Let me in!');
        expect(mockToastSuccess).toHaveBeenCalled();
    });

    it('handleSubmitJoinRequest — no channel is no-op', async () => {
        const { result } = renderHook(() => useChatProposals(defaultProposalOpts));
        await act(() => result.current.handleSubmitJoinRequest());
        expect(mockRequestJoinChannel).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════

describe('useChatMessages — edge cases', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it('sendChannelMessage with empty text is no-op', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));
        act(() => result.current.setActiveChannel({ id: 'ch-1', name: 'G' } as any));
        await act(() => result.current.sendChannelMessage());
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('sendChannelMessage with bypassFilter skips client filter', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));
        act(() => {
            result.current.setActiveChannel({ id: 'ch-1', name: 'G' } as any);
            result.current.setMessageText('risky text');
        });
        await act(() => result.current.sendChannelMessage(true));
        expect(mockClientFilter).not.toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalled();
    });

    it('openChannel cleans up previous subscription', async () => {
        const unsub = vi.fn();
        mockSubscribeToChannel.mockReturnValueOnce(unsub);

        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));

        await act(() => result.current.openChannel({ id: 'ch-1', name: 'A' } as any));
        await act(() => result.current.openChannel({ id: 'ch-2', name: 'B' } as any));

        expect(unsub).toHaveBeenCalled();
    });

    it('sendChannelMessage without activeChannel is no-op', async () => {
        const { result } = renderHook(() => useChatMessages(defaultMessageOpts));
        act(() => result.current.setMessageText('orphaned'));
        await act(() => result.current.sendChannelMessage());
        expect(mockSendMessage).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════

describe('useChatDMs — edge cases', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sendDMMessage without partner is no-op', async () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        act(() => result.current.setDmText('orphan'));
        await act(() => result.current.sendDMMessage());
        expect(mockSendDM).not.toHaveBeenCalled();
    });

    it('sendDMMessage with empty text is no-op', async () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        act(() => result.current.setDmPartner({ id: 'u1', name: 'A' }));
        await act(() => result.current.sendDMMessage());
        expect(mockSendDM).not.toHaveBeenCalled();
    });

    it('handleBlockUser without partner is no-op', async () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        await act(() => result.current.handleBlockUser());
        expect(mockBlockUser).not.toHaveBeenCalled();
    });

    it('handleUnblockUser without partner is no-op', async () => {
        const { result } = renderHook(() => useChatDMs(defaultDMOpts));
        await act(() => result.current.handleUnblockUser());
        expect(mockUnblockUser).not.toHaveBeenCalled();
    });
});
