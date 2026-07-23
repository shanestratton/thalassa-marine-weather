/**
 * useChatDMs — Extracted from ChatPage god component.
 * Manages DM conversations, threads, sending, and block/unblock.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatService, DMConversation, DirectMessage } from '../../services/ChatService';
import { triggerHaptic } from '../../utils/system';
import { toast } from '../../components/Toast';
import { QUEUED_DM_SENT_EVENT } from '../../services/chat/constants';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';

export interface UseChatDMsOptions {
    setView: (view: string) => void;
    setNavDirection: (dir: 'forward' | 'back') => void;
    setLoading: (loading: boolean) => void;
}

export function useChatDMs(options: UseChatDMsOptions) {
    const { setView, setNavDirection, setLoading } = options;

    // --- State ---
    const [dmConversations, setDmConversations] = useState<DMConversation[]>([]);
    const [dmThread, setDmThread] = useState<DirectMessage[]>([]);
    const [dmPartner, setDmPartner] = useState<{ id: string; name: string } | null>(null);
    const [dmText, setDmText] = useState('');
    const [isUserBlocked, setIsUserBlocked] = useState(false);
    const [showBlockConfirm, setShowBlockConfirm] = useState(false);
    const [unreadDMs, setUnreadDMs] = useState(0);

    // Ref so the DM subscription callback always has fresh partner data
    const dmPartnerRef = useRef(dmPartner);
    useEffect(() => {
        dmPartnerRef.current = dmPartner;
    }, [dmPartner]);

    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                setDmConversations([]);
                setDmThread([]);
                setDmPartner(null);
                setDmText('');
                setIsUserBlocked(false);
                setShowBlockConfirm(false);
                setUnreadDMs(0);
                setLoading(false);
            }),
        [setLoading],
    );

    useEffect(() => {
        const handleQueuedDmSent = (event: Event) => {
            const detail = (event as CustomEvent<{ ownerUserId: string; message: DirectMessage }>).detail;
            const identity = getAuthIdentityScope();
            if (!detail || detail.ownerUserId !== identity.userId || !isAuthIdentityScopeCurrent(identity)) return;
            const confirmed = detail.message;
            setDmThread((prev) => {
                const queuedIndex = prev.findIndex(
                    (message) =>
                        message.delivery_status === 'queued' &&
                        message.sender_id === 'self' &&
                        message.recipient_id === confirmed.recipient_id &&
                        message.message === confirmed.message,
                );
                if (queuedIndex < 0) return prev;
                const next = [...prev];
                next[queuedIndex] = confirmed;
                return next;
            });
        };
        window.addEventListener(QUEUED_DM_SENT_EVENT, handleQueuedDmSent);
        return () => window.removeEventListener(QUEUED_DM_SENT_EVENT, handleQueuedDmSent);
    }, []);

    // --- DM Subscription (lives for component lifetime) ---
    const subscribe = useCallback(() => {
        const identity = getAuthIdentityScope();
        return ChatService.subscribeToDMs((dm) => {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setUnreadDMs((prev) => prev + 1);
            setDmThread((prev) => {
                const partner = dmPartnerRef.current;
                if (partner && dm.sender_id === partner.id) {
                    return [...prev, dm];
                }
                return prev;
            });
        });
    }, []);

    // --- Actions ---

    const openDMInbox = useCallback(async () => {
        const identity = getAuthIdentityScope();
        setNavDirection('forward');
        setView('dm_inbox');
        setLoading(true);
        const convs = await ChatService.getDMConversations().catch(() => null);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        if (!convs) {
            setLoading(false);
            toast.error("Direct messages couldn't be loaded. Check your connection and try again.");
            return;
        }
        setDmConversations(convs);
        setLoading(false);
    }, [setView, setNavDirection, setLoading]);

    const openDMThread = useCallback(
        async (userId: string, name: string) => {
            const identity = getAuthIdentityScope();
            setDmPartner({ id: userId, name });
            setNavDirection('forward');
            setView('dm_thread');
            setShowBlockConfirm(false);
            setLoading(true);
            const result = await Promise.all([ChatService.getDMThread(userId), ChatService.isBlocked(userId)]).catch(
                () => null,
            );
            if (!isAuthIdentityScopeCurrent(identity)) return;
            if (!result) {
                setLoading(false);
                toast.error("This conversation couldn't be loaded. Check your connection and try again.");
                return;
            }
            const [thread, blocked] = result;
            setDmThread(thread);
            setIsUserBlocked(blocked);
            setLoading(false);
            setUnreadDMs((prev) => Math.max(0, prev - 1));
        },
        [setView, setNavDirection, setLoading],
    );

    const sendDMMessage = useCallback(async () => {
        if (!dmText.trim() || !dmPartner) return;
        const identity = getAuthIdentityScope();
        const text = dmText.trim();
        setDmText('');

        const optimistic: DirectMessage = {
            id: `opt-${crypto.randomUUID()}`,
            sender_id: 'self',
            recipient_id: dmPartner.id,
            sender_name: 'You',
            message: text,
            read: true,
            created_at: new Date().toISOString(),
            delivery_status: 'sending',
        };
        setDmThread((prev) => [...prev, optimistic]);

        const result = await ChatService.sendDM(dmPartner.id, text).catch(() => null);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        if (result === 'blocked') {
            setDmThread((prev) => prev.filter((m) => m.id !== optimistic.id));
            setIsUserBlocked(true);
            return;
        }
        if (result === 'queued') {
            setDmThread((prev) =>
                prev.map((message) =>
                    message.id === optimistic.id ? { ...message, delivery_status: 'queued' } : message,
                ),
            );
            toast.info('Direct message queued — it will send when the connection returns.');
            return;
        }
        if (!result) {
            setDmThread((prev) => prev.filter((message) => message.id !== optimistic.id));
            setDmText((current) => current || text);
            toast.error("Direct message wasn't sent. Your text has been restored.");
            return;
        }
        setDmThread((prev) => {
            const optimisticIndex = prev.findIndex((message) => message.id === optimistic.id);
            if (optimisticIndex < 0) {
                return prev.some((message) => message.id === result.id) ? prev : [...prev, result];
            }
            const next = [...prev];
            next[optimisticIndex] = result;
            return next;
        });
        triggerHaptic('light');
    }, [dmText, dmPartner]);

    const handleBlockUser = useCallback(async () => {
        if (!dmPartner) return;
        const identity = getAuthIdentityScope();
        const ok = await ChatService.blockUser(dmPartner.id);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        if (ok) {
            setIsUserBlocked(true);
            setShowBlockConfirm(false);
        }
    }, [dmPartner]);

    const handleUnblockUser = useCallback(async () => {
        if (!dmPartner) return;
        const identity = getAuthIdentityScope();
        const ok = await ChatService.unblockUser(dmPartner.id);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        if (ok) setIsUserBlocked(false);
    }, [dmPartner]);

    const loadUnreadCount = useCallback(async () => {
        const identity = getAuthIdentityScope();
        const convs = await ChatService.getDMConversations();
        if (!isAuthIdentityScopeCurrent(identity)) return;
        const total = convs.reduce((sum, c) => sum + c.unread_count, 0);
        setUnreadDMs(total);
    }, []);

    return {
        // State
        dmConversations,
        dmThread,
        setDmThread,
        dmPartner,
        setDmPartner,
        dmText,
        setDmText,
        isUserBlocked,
        showBlockConfirm,
        setShowBlockConfirm,
        unreadDMs,

        // Actions
        subscribe,
        openDMInbox,
        openDMThread,
        sendDMMessage,
        handleBlockUser,
        handleUnblockUser,
        loadUnreadCount,
    };
}
