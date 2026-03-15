/**
 * useChatMessages — Extracted from ChatPage god component.
 * Manages channel messages, subscriptions, optimistic updates, and mod actions.
 */
import { useState, useRef, useCallback } from 'react';
import { ChatService, ChatChannel, ChatMessage } from '../../services/ChatService';
import { clientFilter, ClientFilterResult } from '../../services/ContentModerationService';
import { triggerHaptic } from '../../utils/system';
import { batchFetchAvatars } from '../../services/ProfilePhotoService';

export interface UseChatMessagesOptions {
    setView: (view: string) => void;
    setNavDirection: (dir: 'forward' | 'back') => void;
    setLoading: (loading: boolean) => void;
}

export function useChatMessages(options: UseChatMessagesOptions) {
    const { setView, setNavDirection, setLoading } = options;

    // --- State ---
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [activeChannel, setActiveChannel] = useState<ChatChannel | null>(null);
    const [messageText, setMessageText] = useState('');
    const [isQuestion, setIsQuestion] = useState(false);
    const [filterWarning, setFilterWarning] = useState<ClientFilterResult | null>(null);
    const [showModMenu, setShowModMenu] = useState<string | null>(null);
    const [showRankTooltip, setShowRankTooltip] = useState<string | null>(null);
    const [avatarMap, setAvatarMap] = useState<Map<string, string>>(new Map());
    const [pinnedMessages, setPinnedMessages] = useState<ChatMessage[]>([]);
    const [likedMessages, setLikedMessages] = useState<Set<string>>(() => {
        try {
            const stored = localStorage.getItem('chat_liked_messages');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch {
            return new Set();
        }
    });

    // --- Refs ---
    const messageEndRef = useRef<HTMLDivElement>(null);
    const channelUnsubRef = useRef<(() => void) | null>(null);

    // --- Actions ---

    const openChannel = useCallback(
        async (channel: ChatChannel) => {
            // Find Crew / Marketplace get special views
            if (channel.name === 'Find Crew') {
                setNavDirection('forward');
                setView('find_crew');
                return;
            }
            if (channel.name === 'Marketplace') {
                setNavDirection('forward');
                setView('marketplace');
                return;
            }

            setActiveChannel(channel);
            setNavDirection('forward');
            setView('messages');
            localStorage.setItem('chat_last_channel', channel.id);
            setLoading(true);

            const msgs = await ChatService.getMessages(channel.id);
            setMessages(msgs);

            // Batch-fetch avatars
            const userIds = [...new Set(msgs.map((m) => m.user_id).filter((id) => id !== 'self'))];
            if (userIds.length > 0) {
                batchFetchAvatars(userIds).then((map: Map<string, string>) => {
                    setAvatarMap((prev) => {
                        const next = new Map(prev);
                        map.forEach((url: string, id: string) => next.set(id, url));
                        return next;
                    });
                });
            }

            // Compute pinned
            setPinnedMessages(msgs.filter((m) => m.is_pinned && !m.deleted_at));
            setLoading(false);

            // Subscribe — clean up previous first
            channelUnsubRef.current?.();
            channelUnsubRef.current = ChatService.subscribeToChannel(channel.id, (newMsg) => {
                setMessages((prev) => {
                    const optimisticIdx = prev.findIndex(
                        (m) => m.id.startsWith('opt-') && m.user_id === 'self' && m.message === newMsg.message,
                    );
                    if (optimisticIdx >= 0) {
                        const next = [...prev];
                        next[optimisticIdx] = newMsg;
                        return next;
                    }
                    if (prev.find((m) => m.id === newMsg.id)) {
                        return prev.map((m) => (m.id === newMsg.id ? newMsg : m));
                    }
                    return [...prev, newMsg];
                });
            });

            setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
        },
        [setView, setNavDirection, setLoading],
    );

    const sendChannelMessage = useCallback(
        async (bypassFilter = false) => {
            if (!messageText.trim() || !activeChannel) return;
            const text = messageText.trim();

            if (!bypassFilter) {
                const check = clientFilter(text);
                if (check.blocked || check.warning) {
                    setFilterWarning(check);
                    return;
                }
            }
            setFilterWarning(null);
            setMessageText('');

            const optimistic: ChatMessage = {
                id: `opt-${crypto.randomUUID()}`,
                channel_id: activeChannel.id,
                user_id: 'self',
                display_name: 'You',
                message: text,
                is_question: isQuestion,
                helpful_count: 0,
                is_pinned: false,
                deleted_at: null,
                created_at: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, optimistic]);
            setIsQuestion(false);

            await ChatService.sendMessage(activeChannel.id, text, isQuestion);
            triggerHaptic('light');
            setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        },
        [messageText, activeChannel, isQuestion],
    );

    const handleMarkHelpful = useCallback(
        async (msgId: string) => {
            if (likedMessages.has(msgId)) return;
            await ChatService.markHelpful(msgId);
            triggerHaptic('light');
            setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, helpful_count: m.helpful_count + 1 } : m)));
            setLikedMessages((prev) => {
                const next = new Set(prev);
                next.add(msgId);
                localStorage.setItem('chat_liked_messages', JSON.stringify([...next]));
                return next;
            });
        },
        [likedMessages],
    );

    // --- Mod Actions ---

    const handleDeleteMessage = useCallback(async (msgId: string) => {
        await ChatService.deleteMessage(msgId);
        triggerHaptic('heavy');
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, deleted_at: new Date().toISOString() } : m)));
        setShowModMenu(null);
    }, []);

    const handlePinMessage = useCallback(async (msgId: string, pinned: boolean) => {
        await ChatService.pinMessage(msgId, !pinned);
        triggerHaptic('medium');
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, is_pinned: !pinned } : m)));
        setShowModMenu(null);
    }, []);

    const handleMuteUser = useCallback(async (userId: string, hours: number) => {
        await ChatService.muteUser(userId, hours);
        setShowModMenu(null);
    }, []);

    const getAvatar = useCallback(
        (userId: string): string | null => {
            return avatarMap.get(userId) || null;
        },
        [avatarMap],
    );

    // Cleanup
    const cleanup = useCallback(() => {
        channelUnsubRef.current?.();
    }, []);

    return {
        // State
        messages,
        setMessages,
        activeChannel,
        setActiveChannel,
        messageText,
        setMessageText,
        isQuestion,
        setIsQuestion,
        filterWarning,
        setFilterWarning,
        showModMenu,
        setShowModMenu,
        showRankTooltip,
        setShowRankTooltip,
        avatarMap,
        setAvatarMap,
        pinnedMessages,
        likedMessages,
        messageEndRef,

        // Actions
        openChannel,
        sendChannelMessage,
        handleMarkHelpful,
        handleDeleteMessage,
        handlePinMessage,
        handleMuteUser,
        getAvatar,
        cleanup,
    };
}
