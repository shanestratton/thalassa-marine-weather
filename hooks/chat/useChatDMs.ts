/**
 * useChatDMs — Extracted from ChatPage god component.
 * Manages DM conversations, threads, sending, and block/unblock.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatService, DMConversation, DirectMessage } from '../../services/ChatService';
import { triggerHaptic } from '../../utils/system';

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

    // --- DM Subscription (lives for component lifetime) ---
    const subscribe = useCallback(() => {
        return ChatService.subscribeToDMs((dm) => {
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
        setNavDirection('forward');
        setView('dm_inbox');
        setLoading(true);
        const convs = await ChatService.getDMConversations();
        setDmConversations(convs);
        setLoading(false);
    }, [setView, setNavDirection, setLoading]);

    const openDMThread = useCallback(
        async (userId: string, name: string) => {
            setDmPartner({ id: userId, name });
            setNavDirection('forward');
            setView('dm_thread');
            setShowBlockConfirm(false);
            setLoading(true);
            const [thread, blocked] = await Promise.all([
                ChatService.getDMThread(userId),
                ChatService.isBlocked(userId),
            ]);
            setDmThread(thread);
            setIsUserBlocked(blocked);
            setLoading(false);
            setUnreadDMs((prev) => Math.max(0, prev - 1));
        },
        [setView, setNavDirection, setLoading],
    );

    const sendDMMessage = useCallback(async () => {
        if (!dmText.trim() || !dmPartner) return;
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
        };
        setDmThread((prev) => [...prev, optimistic]);
        triggerHaptic('light');

        const result = await ChatService.sendDM(dmPartner.id, text);
        if (result === 'blocked') {
            setDmThread((prev) => prev.filter((m) => m.id !== optimistic.id));
            setIsUserBlocked(true);
        }
    }, [dmText, dmPartner]);

    const handleBlockUser = useCallback(async () => {
        if (!dmPartner) return;
        const ok = await ChatService.blockUser(dmPartner.id);
        if (ok) {
            setIsUserBlocked(true);
            setShowBlockConfirm(false);
        }
    }, [dmPartner]);

    const handleUnblockUser = useCallback(async () => {
        if (!dmPartner) return;
        const ok = await ChatService.unblockUser(dmPartner.id);
        if (ok) setIsUserBlocked(false);
    }, [dmPartner]);

    const loadUnreadCount = useCallback(async () => {
        const convs = await ChatService.getDMConversations();
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
