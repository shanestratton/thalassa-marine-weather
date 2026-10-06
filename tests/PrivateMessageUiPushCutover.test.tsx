/** Mocked legacy UI/native-push callbacks only; no Auth, APNs banners or crypto evidence. */
import React from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivateMessageCutoverPolicy } from '../services/chat/e2ee/privateMessageCutover';
import type { DirectMessage } from '../services/ChatService';

const policySlot = vi.hoisted(() => ({ policy: null as PrivateMessageCutoverPolicy | null }));
const api = vi.hoisted(() => ({
    status: vi.fn(),
    thread: vi.fn(),
    conversations: vi.fn(),
    send: vi.fn(),
    block: vi.fn(),
    unblock: vi.fn(),
    subscribe: vi.fn(),
    stopSubscription: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    haptic: vi.fn(),
    nativeCallbacks: new Map<string, (value: any) => void>(),
    addListener: vi.fn(),
    log: vi.fn(),
}));
vi.mock('../services/chat/e2ee/privateMessageCutover', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/chat/e2ee/privateMessageCutover')>();
    return {
        ...actual,
        captureLegacyPrivateMessagePermit: (
            ...args: Parameters<PrivateMessageCutoverPolicy['captureLegacyPrivateMessagePermit']>
        ) => policySlot.policy!.captureLegacyPrivateMessagePermit(...args),
        isLegacyPrivateMessagePermitCurrent: (permit: unknown) =>
            policySlot.policy!.isLegacyPrivateMessagePermitCurrent(permit),
        requireNativePrivateMessagesForScope: (
            scope: Parameters<PrivateMessageCutoverPolicy['requireNativePrivateMessagesForScope']>[0],
        ) => policySlot.policy!.requireNativePrivateMessagesForScope(scope),
        subscribePrivateMessageCutover: (listener: () => void) =>
            policySlot.policy!.subscribePrivateMessageCutover(listener),
    };
});
vi.mock('../services/ChatService', () => ({
    ChatService: {
        getDMBlockStatus: api.status,
        getDMThread: api.thread,
        getDMConversations: api.conversations,
        sendDM: api.send,
        blockUser: api.block,
        unblockUser: api.unblock,
        subscribeToDMs: api.subscribe,
    },
}));
vi.mock('../components/Toast', () => ({ toast: { error: api.error, info: api.info } }));
vi.mock('../utils/system', () => ({ triggerHaptic: api.haptic }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: api.log, debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/supabase', () => ({ supabase: { auth: { getUser: vi.fn() }, rpc: vi.fn() } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } }));
vi.mock('@capacitor/push-notifications', () => ({
    PushNotifications: {
        addListener: api.addListener,
        register: vi.fn(),
        unregister: vi.fn(),
        removeAllDeliveredNotifications: vi.fn(),
    },
}));

import {
    createPrivateMessageCutoverPolicy,
    PrivateMessageLegacyUnavailableError,
} from '../services/chat/e2ee/privateMessageCutover';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useChatDMs } from '../hooks/chat/useChatDMs';
import { PushNotificationService } from '../services/PushNotificationService';
import { PushToast, pushForegroundToast } from '../components/PushToast';
import { QUEUED_DM_SENT_EVENT } from '../services/chat/constants';

const owner = 'cutover-owner',
    peer = 'cutover-peer',
    other = 'native-other';
const row: DirectMessage = {
    id: 'private-row',
    sender_id: peer,
    recipient_id: owner,
    sender_name: 'Peer',
    message: 'Private fixture body',
    read: false,
    created_at: '2026-10-06T01:00:00.000Z',
};
function hook() {
    const options = { setView: vi.fn(), setNavDirection: vi.fn(), setLoading: vi.fn() };
    return renderHook(() => useChatDMs(options));
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (value: unknown) => void;
    const promise = new Promise<T>((done, refused) => {
        resolve = done;
        reject = refused;
    });
    return { promise, resolve, reject };
}
const requireNative = () => policySlot.policy!.requireNativePrivateMessagesForScope(getAuthIdentityScope());

beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    setAuthIdentityScope(owner);
    policySlot.policy = createPrivateMessageCutoverPolicy(getAuthIdentityScope);
    api.status.mockResolvedValue({ blockedByMe: false, blockedEitherDirection: false });
    api.thread.mockResolvedValue([row]);
    api.conversations.mockResolvedValue([
        { user_id: peer, display_name: 'Peer', last_message: row.message, last_at: row.created_at, unread_count: 2 },
    ]);
    api.send.mockResolvedValue({ ...row, id: 'sent-row', sender_id: owner, recipient_id: peer });
    api.subscribe.mockImplementation(() => api.stopSubscription);
    api.addListener.mockImplementation((event: string, callback: (value: unknown) => void) => {
        api.nativeCallbacks.set(event, callback);
        return Promise.resolve({ remove: vi.fn(async () => undefined) });
    });
    await PushNotificationService.dispose();
    api.nativeCallbacks.clear();
    vi.spyOn(PushNotificationService, 'requestPermissionAndRegister').mockResolvedValue(null);
});
afterEach(async () => {
    cleanup();
    await PushNotificationService.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('legacy private hook cutover fixtures', () => {
    it('preserves default legacy thread, badge and send behavior before any latch', async () => {
        const { result } = hook();
        await act(async () => result.current.openDMInbox());
        await act(async () => result.current.loadUnreadCount());
        expect(result.current.unreadDMs).toBe(2);
        await act(async () => result.current.openDMThread(peer, 'Peer'));
        expect(result.current.dmThread).toEqual([row]);
        act(() => result.current.setDmText('Default legacy draft'));
        await act(async () => result.current.sendDMMessage());
        expect(api.send).toHaveBeenCalledWith(peer, 'Default legacy draft');
    });
    it('clears private state and ignores held reads, same-auth callbacks and captured setters after cutover', async () => {
        const { result } = hook();
        let receive!: (message: DirectMessage) => void;
        api.subscribe.mockImplementation((callback) => {
            receive = callback;
            return api.stopSubscription;
        });
        act(() => result.current.subscribe());
        await act(async () => result.current.openDMInbox());
        await act(async () => result.current.openDMThread(peer, 'Peer'));
        act(() => result.current.setDmText('Old private draft'));
        const oldSetText = result.current.setDmText,
            oldSetThread = result.current.setDmThread;
        const oldSetPartner = result.current.setDmPartner;
        const oldOpen = result.current.openDMThread;
        const held = deferred<DirectMessage[]>();
        api.thread.mockReturnValueOnce(held.promise);
        let opening!: Promise<void>;
        act(() => {
            opening = result.current.openDMThread(peer, 'Peer');
        });
        act(() => requireNative());
        act(() => {
            receive({ ...row, message: 'Late private callback' });
            oldSetText('Late private setter');
            oldSetThread([row]);
            oldSetPartner({ id: peer, name: 'Late private peer' });
            window.dispatchEvent(
                new CustomEvent(QUEUED_DM_SENT_EVENT, { detail: { ownerUserId: owner, message: row } }),
            );
        });
        await act(async () => {
            held.resolve([row]);
            await opening;
            await oldOpen(peer, 'Old button');
        });
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmConversations).toEqual([]);
        expect(result.current.dmText).toBe('');
        expect(result.current.dmPartner).toBeNull();
        expect(result.current.unreadDMs).toBe(0);
        expect(api.stopSubscription).toHaveBeenCalledTimes(1);
        expect(api.thread).toHaveBeenCalledTimes(2);
        expect(api.error).not.toHaveBeenCalled();
        expect(api.info).not.toHaveBeenCalled();
    });
    it('suppresses a late cutover send refusal without claiming the remote message was unsent', async () => {
        const { result } = hook();
        await act(async () => result.current.openDMThread(peer, 'Peer'));
        act(() => result.current.setDmText('Held send body'));
        const held = deferred<DirectMessage>();
        api.send.mockReturnValueOnce(held.promise);
        let sending!: Promise<void>;
        act(() => {
            sending = result.current.sendDMMessage();
        });
        act(() => requireNative());
        await act(async () => {
            held.reject(new PrivateMessageLegacyUnavailableError());
            await sending;
        });
        expect(result.current.dmThread).toEqual([]);
        expect(result.current.dmText).toBe('');
        expect(result.current.blockStatusError).toBe('Legacy private messaging is unavailable.');
        expect(api.error).not.toHaveBeenCalled();
        expect(api.info).not.toHaveBeenCalled();
    });
    it('refuses aggregates after another account latch while admitting a fresh known safe peer', async () => {
        setAuthIdentityScope(other);
        requireNative();
        setAuthIdentityScope(owner);
        const { result } = hook();
        await act(async () => result.current.openDMInbox());
        await act(async () => result.current.loadUnreadCount());
        expect(api.conversations).not.toHaveBeenCalled();
        expect(result.current.unreadDMs).toBe(0);
        await act(async () => result.current.openDMThread(peer, 'Peer'));
        act(() => result.current.setDmText('Known safe peer draft'));
        await act(async () => result.current.sendDMMessage());
        expect(api.send).toHaveBeenCalledWith(peer, 'Known safe peer draft');
    });
});

describe('private foreground push and tap cutover fixtures', () => {
    it('denies dm/hail native and cached callbacks after latch while preserving safety/public notifications', async () => {
        await PushNotificationService.initialize();
        await PushNotificationService.setUser(owner);
        const foreground = vi.fn(),
            tap = vi.fn();
        PushNotificationService.bindNotificationHandlers(getAuthIdentityScope(), {
            onForegroundPush: foreground,
            onNotificationTap: tap,
        });
        const cachedForeground = PushNotificationService.onForegroundPush!,
            cachedTap = PushNotificationService.onNotificationTap!;
        const receive = api.nativeCallbacks.get('pushNotificationReceived')!;
        const action = api.nativeCallbacks.get('pushNotificationActionPerformed')!;
        receive({ title: 'Private title', body: 'Private body', data: { notification_type: 'dm' } });
        expect(foreground).toHaveBeenCalledTimes(1);
        requireNative();
        for (const notification_type of ['dm', 'hail']) {
            receive({ title: 'Refused private', data: { notification_type } });
            action({ notification: { data: { notification_type } } });
            cachedForeground({ title: 'Cached private', data: { notification_type } });
            cachedTap({ notification_type });
        }
        expect(foreground).toHaveBeenCalledTimes(1);
        expect(tap).not.toHaveBeenCalled();
        for (const notification_type of ['anchor_alarm', 'bolo_alert', 'weather_alert', 'public_channel']) {
            receive({ title: 'Allowed non-private', data: { notification_type } });
            action({ notification: { data: { notification_type } } });
        }
        expect(foreground).toHaveBeenCalledTimes(5);
        expect(tap).toHaveBeenCalledTimes(4);
        expect(api.log.mock.calls.flat()).not.toContain('Refused private');
    });
    it('clears existing private toast rows and rejects new dm/hail without touching anchor toasts', () => {
        render(<PushToast onTap={vi.fn()} />);
        const mutableData = { notification_type: 'dm' };
        act(() => {
            pushForegroundToast({ title: 'Private toast', body: 'Private toast body', data: mutableData });
            pushForegroundToast({
                title: 'Anchor toast',
                body: 'Anchor safety body',
                data: { notification_type: 'anchor_alarm' },
            });
        });
        expect(screen.getByText('Private toast body')).toBeTruthy();
        mutableData.notification_type = 'anchor_alarm';
        act(() => requireNative());
        expect(screen.queryByText('Private toast body')).toBeNull();
        expect(screen.getByText('Anchor safety body')).toBeTruthy();
        act(() => {
            for (const notification_type of ['dm', 'hail'])
                pushForegroundToast({ body: 'Refused toast body', data: { notification_type } });
        });
        expect(screen.queryByText('Refused toast body')).toBeNull();
    });
    it('refuses an original-scope toast after account ABA, even before a native latch', () => {
        render(<PushToast />);
        const original = getAuthIdentityScope();
        setAuthIdentityScope(other);
        setAuthIdentityScope(owner);
        act(() => pushForegroundToast({ body: 'Old origin body', data: { notification_type: 'dm' } }, original));
        expect(screen.queryByText('Old origin body')).toBeNull();
        act(() => pushForegroundToast({ body: 'Fresh origin body', data: { notification_type: 'dm' } }));
        expect(screen.getByText('Fresh origin body')).toBeTruthy();
    });
});
