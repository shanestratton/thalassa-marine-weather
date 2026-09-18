/**
 * useChatDMs — Extracted from ChatPage god component.
 * Manages DM conversations, threads, sending, and block/unblock.
 */
import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import { ChatService, DMConversation, DirectMessage } from '../../services/ChatService';
import { triggerHaptic } from '../../utils/system';
import { toast } from '../../components/Toast';
import { reconcileOptimisticMessage } from '../../components/chat/chatUtils';
import { QUEUED_DM_SENT_EVENT } from '../../services/chat/constants';
import { PushNotificationService } from '../../services/PushNotificationService';
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
    const identityScope = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope, getAuthIdentityScope);

    // --- State ---
    const [dmConversations, setDmConversations] = useState<DMConversation[]>([]);
    const [dmThread, setDmThread] = useState<DirectMessage[]>([]);
    const [dmPartner, setDmPartnerState] = useState<{ id: string; name: string } | null>(null);
    const [dmText, setDmText] = useState('');
    const [isUserBlocked, setIsUserBlocked] = useState(false);
    const [blockedByMe, setBlockedByMe] = useState(false);
    const [blockStatusLoading, setBlockStatusLoading] = useState(false);
    const [blockStatusError, setBlockStatusError] = useState<string | null>(null);
    const [blockMutationPending, setBlockMutationPending] = useState(false);
    const [showBlockConfirm, setShowBlockConfirm] = useState(false);
    const [unreadDMs, setUnreadDMs] = useState(0);
    // Keep the iOS permission request contextual: the first time a sailor
    // deliberately opens or starts a direct conversation.  Asking at app
    // launch is both noisy and easy to deny, which leaves chat-only users
    // with no APNs token at all.
    const registeredPushScopeRef = useRef<string | null>(null);
    const registeringPushScopeRef = useRef<string | null>(null);

    // Ref so the DM subscription callback always has fresh partner data
    const dmPartnerRef = useRef(dmPartner);
    const partnerVersionRef = useRef(0);
    const blockRequestRef = useRef(0);
    const blockMutationRef = useRef(false);
    const pendingSendIdsRef = useRef(new Set<string>());
    const deferredSelfEchoesRef = useRef(new Map<string, DirectMessage>());
    const setDmPartner = useCallback((partner: { id: string; name: string } | null) => {
        partnerVersionRef.current += 1;
        blockRequestRef.current += 1;
        dmPartnerRef.current = partner;
        blockMutationRef.current = false;
        pendingSendIdsRef.current.clear();
        deferredSelfEchoesRef.current.clear();
        setDmPartnerState(partner);
        setIsUserBlocked(false);
        setBlockedByMe(false);
        setBlockStatusLoading(false);
        setBlockStatusError(null);
        setBlockMutationPending(false);
    }, []);

    const retryBlockStatus = useCallback(async () => {
        const partner = dmPartnerRef.current;
        if (!partner || blockMutationRef.current) return;
        const identity = getAuthIdentityScope();
        const version = partnerVersionRef.current;
        const request = ++blockRequestRef.current;
        const current = () =>
            isAuthIdentityScopeCurrent(identity) &&
            version === partnerVersionRef.current &&
            request === blockRequestRef.current;
        setBlockStatusLoading(true);
        setBlockStatusError(null);
        try {
            const status = await ChatService.getDMBlockStatus(partner.id);
            if (!current()) return;
            setBlockedByMe(status.blockedByMe);
            setIsUserBlocked(status.blockedEitherDirection);
        } catch {
            if (current()) setBlockStatusError('Unable to verify blocking. Retry before sending a message.');
        } finally {
            if (current()) setBlockStatusLoading(false);
        }
    }, []);

    const ensureDirectMessagePushRegistration = useCallback(() => {
        const scope = getAuthIdentityScope();
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        if (registeredPushScopeRef.current === scope.key || registeringPushScopeRef.current === scope.key) return;

        registeringPushScopeRef.current = scope.key;
        void PushNotificationService.requestPermissionAndRegister()
            .then((token) => {
                // A token is useful only for the identity that initiated the
                // request.  A delayed result from a signed-out account must
                // not suppress registration for the next sailor.
                if (!isAuthIdentityScopeCurrent(scope) || registeringPushScopeRef.current !== scope.key) return;
                if (token) registeredPushScopeRef.current = scope.key;
            })
            .catch(() => {
                // Registration is best-effort.  A DM must still open when a
                // sailor declines notifications or APNs is temporarily down.
            })
            .finally(() => {
                if (registeringPushScopeRef.current === scope.key) registeringPushScopeRef.current = null;
            });
    }, []);

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
        [setLoading, setDmPartner],
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
                return reconcileOptimisticMessage(prev, prev[queuedIndex].id, confirmed);
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
            if (dm.sender_id !== identity.userId) setUnreadDMs((prev) => prev + 1);
            const partner = dmPartnerRef.current;
            if (
                partner &&
                dm.sender_id === partner.id &&
                dm.sender_id === identity.userId &&
                pendingSendIdsRef.current.size > 0
            ) {
                // Delay the self echo until the matching insert returns its ID.
                // Do not guess identity from equal message text or timestamps.
                deferredSelfEchoesRef.current.set(dm.id, dm);
                return;
            }
            setDmThread((prev) => {
                if (partner && dm.sender_id === partner.id && !prev.some((message) => message.id === dm.id)) {
                    return [...prev, dm];
                }
                return prev;
            });
        });
    }, []);

    // --- Actions ---

    const openDMInbox = useCallback(async () => {
        ensureDirectMessagePushRegistration();
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
    }, [ensureDirectMessagePushRegistration, setView, setNavDirection, setLoading]);

    const openDMThread = useCallback(
        async (userId: string, name: string) => {
            const identity = getAuthIdentityScope();
            if (userId !== identity.userId) ensureDirectMessagePushRegistration();
            setDmPartner({ id: userId, name: userId === identity.userId ? 'Self test' : name });
            const version = partnerVersionRef.current;
            setDmThread([]);
            setDmText('');
            setNavDirection('forward');
            setView('dm_thread');
            setShowBlockConfirm(false);
            setLoading(true);
            const blockStatus = retryBlockStatus();
            const thread = await ChatService.getDMThread(userId).catch(() => null);
            await blockStatus;
            if (!isAuthIdentityScopeCurrent(identity) || version !== partnerVersionRef.current) return;
            if (!thread) {
                setLoading(false);
                toast.error("This conversation couldn't be loaded. Check your connection and try again.");
                return;
            }
            setDmThread(thread);
            setLoading(false);
            if (userId !== identity.userId) setUnreadDMs((prev) => Math.max(0, prev - 1));
        },
        [ensureDirectMessagePushRegistration, setView, setNavDirection, setLoading, setDmPartner, retryBlockStatus],
    );

    const sendDMMessage = useCallback(async () => {
        if (!dmText.trim() || !dmPartner) return;
        if (isUserBlocked || blockStatusLoading || blockStatusError || blockMutationRef.current) return;
        const identity = getAuthIdentityScope();
        const version = partnerVersionRef.current;
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
        pendingSendIdsRef.current.add(optimistic.id);
        setDmThread((prev) => [...prev, optimistic]);

        const result = await ChatService.sendDM(dmPartner.id, text).catch(() => null);
        if (!isAuthIdentityScopeCurrent(identity) || version !== partnerVersionRef.current) return;
        pendingSendIdsRef.current.delete(optimistic.id);
        const echoes = pendingSendIdsRef.current.size === 0 ? [...deferredSelfEchoesRef.current.values()] : [];
        if (pendingSendIdsRef.current.size === 0) deferredSelfEchoesRef.current.clear();
        const settle = (update: (previous: DirectMessage[]) => DirectMessage[]) => {
            setDmThread((previous) => {
                const next = update(previous);
                return [...next, ...echoes.filter((echo) => !next.some((message) => message.id === echo.id))];
            });
        };
        if (result === 'blocked') {
            settle((prev) => prev.filter((m) => m.id !== optimistic.id));
            setIsUserBlocked(true);
            setDmText((current) => current || text);
            toast.info('Messages are unavailable in this conversation. Your text has been restored.');
            await retryBlockStatus();
            return;
        }
        if (result === 'queued') {
            settle((prev) => reconcileOptimisticMessage(prev, optimistic.id, 'queued'));
            toast.info('Direct message queued — it will send when the connection returns.');
            return;
        }
        if (!result) {
            settle((prev) => prev.filter((message) => message.id !== optimistic.id));
            setDmText((current) => current || text);
            toast.error("Direct message wasn't sent. Your text has been restored.");
            return;
        }
        settle((prev) => reconcileOptimisticMessage(prev, optimistic.id, result));
        triggerHaptic('light');
    }, [dmText, dmPartner, isUserBlocked, blockStatusLoading, blockStatusError, retryBlockStatus]);

    const updateBlock = useCallback(async (blocked: boolean) => {
        const partner = dmPartnerRef.current;
        if (!partner || blockMutationRef.current) return;
        const identity = getAuthIdentityScope();
        const version = partnerVersionRef.current;
        const request = ++blockRequestRef.current;
        const current = () =>
            isAuthIdentityScopeCurrent(identity) &&
            version === partnerVersionRef.current &&
            request === blockRequestRef.current;
        blockMutationRef.current = true;
        setBlockMutationPending(true);
        setBlockStatusLoading(false);
        setBlockStatusError(null);
        try {
            const ok = await (blocked ? ChatService.blockUser(partner.id) : ChatService.unblockUser(partner.id));
            if (!current()) return;
            if (!ok) throw new Error('Block update not confirmed');
            setBlockedByMe(blocked);
            if (blocked) {
                setIsUserBlocked(true);
                setDmThread((messages) => messages.filter((message) => message.delivery_status !== 'queued'));
            }
            setShowBlockConfirm(false);
            // Unblocking our row must not pretend the other sailor's block
            // disappeared. Re-read the server's combined state.
            const status = await ChatService.getDMBlockStatus(partner.id);
            if (!current()) return;
            setBlockedByMe(status.blockedByMe);
            setIsUserBlocked(status.blockedEitherDirection);
        } catch {
            if (!current()) return;
            setBlockStatusError('Unable to confirm blocking changes. Retry to check the current status.');
            toast.error(
                blocked ? "Block couldn't be confirmed. Please retry." : "Unblock couldn't be confirmed. Please retry.",
            );
        } finally {
            if (current()) {
                blockMutationRef.current = false;
                setBlockMutationPending(false);
            }
        }
    }, []);

    const handleBlockUser = useCallback(() => updateBlock(true), [updateBlock]);
    const handleUnblockUser = useCallback(() => updateBlock(false), [updateBlock]);

    const loadUnreadCount = useCallback(async () => {
        const identity = getAuthIdentityScope();
        const convs = await ChatService.getDMConversations();
        if (!isAuthIdentityScopeCurrent(identity)) return;
        const total = convs.reduce((sum, c) => sum + c.unread_count, 0);
        setUnreadDMs(total);
    }, []);

    return {
        // State
        currentUserId: identityScope.userId,
        isSelfConversation: !!identityScope.userId && dmPartner?.id === identityScope.userId,
        dmConversations,
        dmThread,
        setDmThread,
        dmPartner,
        setDmPartner,
        dmText,
        setDmText,
        isUserBlocked,
        blockedByMe,
        blockStatusLoading,
        blockStatusError,
        blockMutationPending,
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
        retryBlockStatus,
        loadUnreadCount,
    };
}
