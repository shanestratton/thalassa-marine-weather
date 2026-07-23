/**
 * useChatMessages — Extracted from ChatPage god component.
 * Manages channel messages, subscriptions, optimistic updates, and mod actions.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { ChatService, ChatChannel, ChatMessage } from '../../services/ChatService';
import { clientFilter, ClientFilterResult } from '../../services/ContentModerationService';
import { triggerHaptic } from '../../utils/system';
import { batchFetchAvatars } from '../../services/ProfilePhotoService';
import { toast } from '../../components/Toast';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

const LIKED_MESSAGES_KEY = 'chat_liked_messages';
const LAST_CHANNEL_KEY = 'chat_last_channel';

function readLikedMessages(scope: AuthIdentityScope = getAuthIdentityScope()): Set<string> {
    try {
        const stored = localStorage.getItem(authScopedStorageKey(LIKED_MESSAGES_KEY, scope));
        return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch {
        return new Set();
    }
}

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
    const [likedMessages, setLikedMessages] = useState<Set<string>>(readLikedMessages);

    // --- Refs ---
    const messageEndRef = useRef<HTMLDivElement>(null);
    const channelUnsubRef = useRef<(() => void) | null>(null);

    useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                channelUnsubRef.current?.();
                channelUnsubRef.current = null;
                setMessages([]);
                setPinnedMessages([]);
                setActiveChannel(null);
                setMessageText('');
                setFilterWarning(null);
                setShowModMenu(null);
                setAvatarMap(new Map());
                setLikedMessages(readLikedMessages(next));
                setLoading(false);
            }),
        [setLoading],
    );

    // --- Actions ---

    const openChannel = useCallback(
        async (channel: ChatChannel) => {
            const identity = getAuthIdentityScope();
            // Find Crew / Marketplace get special views
            if (channel.name === 'Find Crew') {
                setNavDirection('forward');
                setView('find_crew');
                return;
            }
            if (channel.name === 'Chandlery' || channel.name === 'Marketplace') {
                setNavDirection('forward');
                setView('marketplace');
                return;
            }

            setActiveChannel(channel);
            setNavDirection('forward');
            setView('messages');
            localStorage.setItem(authScopedStorageKey(LAST_CHANNEL_KEY, identity), channel.id);
            setLoading(true);

            let msgs: ChatMessage[];
            try {
                msgs = await ChatService.getMessages(channel.id);
            } catch {
                if (isAuthIdentityScopeCurrent(identity)) {
                    setLoading(false);
                    toast.error("Messages couldn't be loaded. Check your connection and try again.");
                }
                return;
            }
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setMessages(msgs);

            // Batch-fetch avatars
            const userIds = [...new Set(msgs.map((m) => m.user_id).filter((id) => id !== 'self'))];
            if (userIds.length > 0) {
                batchFetchAvatars(userIds)
                    .then((map: Map<string, string>) => {
                        if (!isAuthIdentityScopeCurrent(identity)) return;
                        setAvatarMap((prev) => {
                            const next = new Map(prev);
                            map.forEach((url: string, id: string) => next.set(id, url));
                            return next;
                        });
                    })
                    .catch(() => undefined);
            }

            // Compute pinned
            setPinnedMessages(msgs.filter((m) => m.is_pinned && !m.deleted_at));
            setLoading(false);

            // Subscribe — clean up previous first
            channelUnsubRef.current?.();
            channelUnsubRef.current = ChatService.subscribeToChannel(channel.id, (newMsg) => {
                if (!isAuthIdentityScopeCurrent(identity)) return;
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

            // Jump to the latest message when entering a channel.
            // Use `behavior: 'auto'` (instant) — smooth animates from
            // the top of the list to the bottom which is visually
            // jarring when the user expects to LAND at the latest
            // line. Triple-tap with growing delays so we still hit
            // the bottom after async re-renders (avatar loads, image
            // attachment layout shifts).
            const jumpToBottom = () => {
                messageEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
            };
            requestAnimationFrame(jumpToBottom);
            setTimeout(jumpToBottom, 150);
            setTimeout(jumpToBottom, 500);
        },
        [setView, setNavDirection, setLoading],
    );

    const sendChannelMessage = useCallback(
        async (bypassFilter = false) => {
            if (!messageText.trim() || !activeChannel) return;
            const identity = getAuthIdentityScope();
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
                delivery_status: 'sending',
            };
            setMessages((prev) => [...prev, optimistic]);
            setIsQuestion(false);

            const sent = await ChatService.sendMessage(activeChannel.id, text, isQuestion).catch(() => null);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            if (sent === 'queued') {
                setMessages((prev) =>
                    prev.map((message) =>
                        message.id === optimistic.id ? { ...message, delivery_status: 'queued' } : message,
                    ),
                );
                toast.info('Message queued — it will send when the connection returns.');
                return;
            }
            setMessages((prev) => {
                const optimisticIndex = prev.findIndex((message) => message.id === optimistic.id);
                if (optimisticIndex < 0) {
                    return sent && !prev.some((message) => message.id === sent.id) ? [...prev, sent] : prev;
                }
                const next = [...prev];
                if (sent) next[optimisticIndex] = sent;
                else next.splice(optimisticIndex, 1);
                return next;
            });
            if (!sent) {
                setMessageText((current) => current || text);
                setIsQuestion((current) => current || isQuestion);
                toast.error("Message wasn't sent. Your text has been restored.");
                return;
            }
            triggerHaptic('light');
            setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        },
        [messageText, activeChannel, isQuestion],
    );

    const handleMarkHelpful = useCallback(
        async (msgId: string) => {
            if (likedMessages.has(msgId)) return;
            const identity = getAuthIdentityScope();
            await ChatService.markHelpful(msgId);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            triggerHaptic('light');
            setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, helpful_count: m.helpful_count + 1 } : m)));
            setLikedMessages((prev) => {
                const next = new Set(prev);
                next.add(msgId);
                localStorage.setItem(authScopedStorageKey(LIKED_MESSAGES_KEY, identity), JSON.stringify([...next]));
                return next;
            });
        },
        [likedMessages],
    );

    // --- Mod Actions ---

    const handleDeleteMessage = useCallback(async (msgId: string) => {
        const identity = getAuthIdentityScope();
        await ChatService.deleteMessage(msgId);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        triggerHaptic('heavy');
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, deleted_at: new Date().toISOString() } : m)));
        setShowModMenu(null);
    }, []);

    const handlePinMessage = useCallback(async (msgId: string, pinned: boolean) => {
        const identity = getAuthIdentityScope();
        await ChatService.pinMessage(msgId, !pinned);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        triggerHaptic('medium');
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, is_pinned: !pinned } : m)));
        setShowModMenu(null);
    }, []);

    const handleMuteUser = useCallback(async (userId: string, hours: number) => {
        const identity = getAuthIdentityScope();
        await ChatService.muteUser(userId, hours);
        if (!isAuthIdentityScopeCurrent(identity)) return;
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
