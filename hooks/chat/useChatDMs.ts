/**
 * useChatDMs — Extracted from ChatPage god component.
 * Manages DM conversations, threads, sending, and block/unblock.
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useSyncExternalStore } from 'react';
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
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    DISABLED_PRIVATE_MESSAGE_PILOT,
    isPrivateMessagePilotText,
    privateMessageFailureText,
    type PrivateMessageRuntime,
    type PrivateMessageFailure,
    type PrivateMessagePilotResult,
} from '../../services/chat/e2ee/privateMessagePilot';

export interface UseChatDMsOptions {
    setView: (view: string) => void;
    setNavDirection: (dir: 'forward' | 'back') => void;
    setLoading: (loading: boolean) => void;
    privateMessageRuntime?: PrivateMessageRuntime;
}

function samePilotMessageContent(a: DirectMessage, b: DirectMessage): boolean {
    return (
        a.id === b.id &&
        a.sender_id === b.sender_id &&
        a.recipient_id === b.recipient_id &&
        a.message === b.message &&
        a.created_at === b.created_at
    );
}

/** Only merge matching native messages. Acceptance and reading never regress. */
function mergePilotMessage(previous: DirectMessage, next: DirectMessage): DirectMessage {
    return {
        ...next,
        read: previous.read || next.read,
        delivery_status:
            previous.delivery_status === undefined || next.delivery_status === undefined
                ? undefined
                : next.delivery_status,
    };
}

export function useChatDMs(options: UseChatDMsOptions) {
    const { setView, setNavDirection, setLoading, privateMessageRuntime = DISABLED_PRIVATE_MESSAGE_PILOT } = options;
    const pilotActive = privateMessageRuntime.kind === 'native-pilot';
    const runtimeRef = useRef(privateMessageRuntime);
    runtimeRef.current = privateMessageRuntime;
    const stateRuntimeRef = useRef(privateMessageRuntime);
    const runtimeChanged = stateRuntimeRef.current !== privateMessageRuntime;
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
    const [pilotFailure, setPilotFailure] = useState<PrivateMessageFailure | null>(pilotActive ? 'unavailable' : null);
    const [pilotSending, setPilotSending] = useState(false);
    const pilotSendRef = useRef<{ peerId: string; text: string; clientMessageId: string } | null>(null);
    const pilotSendingRef = useRef(false);
    const pilotViewGenerationRef = useRef(0);
    const pilotViewOpenRef = useRef(false);
    const pilotSendAllowedRef = useRef(false);
    const pilotEventRevisionRef = useRef(0);
    const pilotEventMessagesRef = useRef(new Map<string, { revision: number; message: DirectMessage }>());
    const pilotInboxLoadingRef = useRef(false);
    // Keep the iOS permission request contextual: the first time a sailor
    // deliberately opens or starts a direct conversation.  Asking at app
    // launch is both noisy and easy to deny, which leaves chat-only users
    // with no APNs token at all.
    const registeredPushScopeRef = useRef<string | null>(null);
    const registeringPushScopeRef = useRef<string | null>(null);

    // Ref so the DM subscription callback always has fresh partner data
    const dmPartnerRef = useRef(dmPartner);
    const partnerVersionRef = useRef(0);
    const inboxRequestRef = useRef(0);
    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            partnerVersionRef.current += 1;
            inboxRequestRef.current += 1;
            pilotViewGenerationRef.current += 1;
        };
    }, []);
    const blockRequestRef = useRef(0);
    const blockMutationRef = useRef(false);
    const pendingSendIdsRef = useRef(new Set<string>());
    const deferredSelfEchoesRef = useRef(new Map<string, DirectMessage>());
    const fencePilotView = useCallback(
        (reason: PrivateMessageFailure) => {
            pilotViewGenerationRef.current += 1;
            pilotViewOpenRef.current = false;
            pilotSendAllowedRef.current = false;
            pilotEventRevisionRef.current = 0;
            pilotEventMessagesRef.current.clear();
            inboxRequestRef.current += 1;
            blockRequestRef.current += 1;
            blockMutationRef.current = false;
            pilotSendingRef.current = false;
            pilotInboxLoadingRef.current = false;
            setPilotFailure(reason);
            setPilotSending(false);
            setBlockMutationPending(false);
            setBlockStatusLoading(false);
            setDmThread([]);
            setDmConversations([]);
            setUnreadDMs(0);
            setLoading(false);
        },
        [setLoading],
    );

    const reconcilePilotThread = useCallback(
        (snapshot: DirectMessage[], afterRevision: number, peerId: string) => {
            const merged = new Map(snapshot.map((message) => [message.id, message]));
            for (const message of snapshot) {
                const existing = pilotEventMessagesRef.current.get(message.id);
                if (existing && !samePilotMessageContent(existing.message, message)) {
                    fencePilotView('unavailable');
                    return null;
                }
                if (existing) merged.set(message.id, mergePilotMessage(existing.message, message));
            }
            for (const { revision, message } of pilotEventMessagesRef.current.values()) {
                if (revision > afterRevision && (message.sender_id === peerId || message.recipient_id === peerId))
                    merged.set(message.id, message);
            }
            if (merged.size > 32) {
                fencePilotView('capacity_exceeded');
                return null;
            }
            for (const message of merged.values()) {
                const existing = pilotEventMessagesRef.current.get(message.id);
                if (!existing && pilotEventMessagesRef.current.size >= 32) {
                    fencePilotView('capacity_exceeded');
                    return null;
                }
                pilotEventMessagesRef.current.set(message.id, {
                    revision: existing && existing.revision > afterRevision ? existing.revision : afterRevision,
                    message: { ...message },
                });
            }
            return [...merged.values()];
        },
        [fencePilotView],
    );

    const refreshPilotInbox = useCallback(async () => {
        if (privateMessageRuntime.kind !== 'native-pilot') return;
        const identity: AuthIdentityScope = getAuthIdentityScope();
        const generation = pilotViewGenerationRef.current;
        const partnerVersion = partnerVersionRef.current;
        const request = ++inboxRequestRef.current;
        const current = () =>
            aliveRef.current &&
            isAuthIdentityScopeCurrent(identity) &&
            runtimeRef.current === privateMessageRuntime &&
            generation === pilotViewGenerationRef.current &&
            partnerVersion === partnerVersionRef.current &&
            request === inboxRequestRef.current;
        let result: PrivateMessagePilotResult<DMConversation[]> | null = null;
        // Inbox previews have no message IDs. Use a fresh native snapshot,
        // never guess how many asynchronous events a returned count includes.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const revision = pilotEventRevisionRef.current;
            result = await privateMessageRuntime
                .getInbox(identity)
                .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
            if (!current()) return;
            if (result.status !== 'ok' || revision === pilotEventRevisionRef.current) break;
            result = null;
        }
        if (!result || result.status !== 'ok') {
            fencePilotView(result?.reason || 'unavailable');
            return;
        }
        pilotViewOpenRef.current = true;
        setDmConversations(result.value);
        setUnreadDMs(result.value.reduce((sum, item) => sum + item.unread_count, 0));
        if (!dmPartnerRef.current) setPilotFailure(null);
        if (pilotInboxLoadingRef.current) {
            pilotInboxLoadingRef.current = false;
            setLoading(false);
        }
    }, [privateMessageRuntime, fencePilotView, setLoading]);
    const setDmPartner = useCallback((partner: { id: string; name: string } | null) => {
        partnerVersionRef.current += 1;
        blockRequestRef.current += 1;
        dmPartnerRef.current = partner;
        blockMutationRef.current = false;
        pendingSendIdsRef.current.clear();
        deferredSelfEchoesRef.current.clear();
        pilotSendRef.current = null;
        pilotSendingRef.current = false;
        pilotSendAllowedRef.current = false;
        setPilotSending(false);
        setDmPartnerState(partner);
        setIsUserBlocked(false);
        setBlockedByMe(false);
        setBlockStatusLoading(false);
        setBlockStatusError(null);
        setBlockMutationPending(false);
        setPilotFailure(runtimeRef.current.kind === 'native-pilot' ? 'unavailable' : null);
    }, []);

    // Runtime replacement is an authority boundary even if the SDK account ID
    // did not change. Mask old rendering immediately, then clear before paint.
    useLayoutEffect(() => {
        if (stateRuntimeRef.current === privateMessageRuntime) return;
        stateRuntimeRef.current = privateMessageRuntime;
        fencePilotView('unavailable');
        setDmPartner(null);
        setDmText('');
        setShowBlockConfirm(false);
        pendingSendIdsRef.current.clear();
        deferredSelfEchoesRef.current.clear();
    }, [privateMessageRuntime, fencePilotView, setDmPartner]);

    const retryBlockStatus = useCallback(async () => {
        const partner = dmPartnerRef.current;
        if (!partner || blockMutationRef.current) return;
        const identity = getAuthIdentityScope();
        const version = partnerVersionRef.current;
        const request = ++blockRequestRef.current;
        const generation = pilotViewGenerationRef.current;
        const current = () =>
            aliveRef.current &&
            isAuthIdentityScopeCurrent(identity) &&
            runtimeRef.current === privateMessageRuntime &&
            version === partnerVersionRef.current &&
            request === blockRequestRef.current;
        setBlockStatusLoading(true);
        setBlockStatusError(null);
        if (privateMessageRuntime.kind === 'native-pilot') {
            pilotSendAllowedRef.current = false;
            const result = await privateMessageRuntime
                .getBlockStatus(identity, partner.id)
                .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
            if (!current() || generation !== pilotViewGenerationRef.current) return;
            if (result.status === 'ok') {
                setBlockedByMe(result.value.blockedByMe);
                setIsUserBlocked(result.value.blockedEitherDirection);
                setPilotFailure(result.value.canSend ? null : result.value.reason || 'unavailable');
                pilotSendAllowedRef.current = result.value.canSend;
                pilotViewOpenRef.current = true;
            } else {
                fencePilotView(result.reason);
                return;
            }
            setBlockStatusLoading(false);
            return;
        }
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
    }, [privateMessageRuntime, fencePilotView]);

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
                pilotViewGenerationRef.current += 1;
                pilotViewOpenRef.current = false;
                pilotSendAllowedRef.current = false;
                pilotEventMessagesRef.current.clear();
                pilotEventRevisionRef.current = 0;
                pilotInboxLoadingRef.current = false;
                setLoading(false);
            }),
        [setLoading, setDmPartner],
    );

    useEffect(() => {
        if (pilotActive) return;
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
    }, [pilotActive]);

    // --- DM Subscription (lives for component lifetime) ---
    const subscribe = useCallback(() => {
        const identity = getAuthIdentityScope();
        if (privateMessageRuntime.kind === 'native-pilot') {
            return privateMessageRuntime.subscribe(identity, (event) => {
                if (
                    !aliveRef.current ||
                    !isAuthIdentityScopeCurrent(identity) ||
                    runtimeRef.current !== privateMessageRuntime
                )
                    return;
                if (event.status === 'ready') {
                    // Native lease renewal does not change the local auth ID.
                    // Refresh rendering/permissions under the new authority,
                    // preserving the current view and the in-memory draft.
                    fencePilotView('unavailable');
                    pilotViewOpenRef.current = true;
                    const partner = dmPartnerRef.current;
                    const version = partnerVersionRef.current;
                    const request = ++blockRequestRef.current;
                    const generation = pilotViewGenerationRef.current;
                    const afterRevision = pilotEventRevisionRef.current;
                    const current = () =>
                        aliveRef.current &&
                        isAuthIdentityScopeCurrent(identity) &&
                        runtimeRef.current === privateMessageRuntime &&
                        generation === pilotViewGenerationRef.current &&
                        version === partnerVersionRef.current &&
                        request === blockRequestRef.current;
                    if (partner) {
                        setBlockStatusLoading(true);
                        void privateMessageRuntime
                            .getThread(identity, partner.id)
                            .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }))
                            .then((result) => {
                                if (!current()) return;
                                if (result.status === 'ok') {
                                    const messages = reconcilePilotThread(
                                        result.value.messages,
                                        afterRevision,
                                        partner.id,
                                    );
                                    if (!messages) return;
                                    setDmThread(messages);
                                    const permissions = result.value.permissions;
                                    setBlockedByMe(permissions.blockedByMe);
                                    setIsUserBlocked(permissions.blockedEitherDirection);
                                    setPilotFailure(permissions.canSend ? null : permissions.reason || 'unavailable');
                                    pilotSendAllowedRef.current = permissions.canSend;
                                    void refreshPilotInbox();
                                } else {
                                    fencePilotView(result.reason);
                                    return;
                                }
                                setBlockStatusLoading(false);
                            });
                    } else {
                        void refreshPilotInbox();
                    }
                    return;
                }
                if (event.status !== 'ok') {
                    fencePilotView(event.reason);
                    return;
                }
                if (!pilotViewOpenRef.current) return;
                const dm = event.value;
                const partner = dmPartnerRef.current;
                const existing = pilotEventMessagesRef.current.get(dm.id)?.message;
                if (existing && !samePilotMessageContent(existing, dm)) {
                    fencePilotView('unavailable');
                    return;
                }
                const message = existing ? mergePilotMessage(existing, dm) : dm;
                if (existing && existing.read === message.read && existing.delivery_status === message.delivery_status)
                    return;
                if (!existing && pilotEventMessagesRef.current.size >= 32) {
                    fencePilotView('capacity_exceeded');
                    return;
                }
                pilotEventMessagesRef.current.set(dm.id, {
                    revision: ++pilotEventRevisionRef.current,
                    message: { ...message },
                });
                if (partner && (dm.sender_id === partner.id || dm.recipient_id === partner.id)) {
                    setDmThread((prev) =>
                        prev.some((message) => message.id === dm.id)
                            ? prev.map((item) => (item.id === dm.id ? message : item))
                            : [...prev, message],
                    );
                }
                void refreshPilotInbox();
            });
        }
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
    }, [privateMessageRuntime, fencePilotView, reconcilePilotThread, refreshPilotInbox]);

    // --- Actions ---

    const openDMInbox = useCallback(async () => {
        if (!pilotActive) ensureDirectMessagePushRegistration();
        const identity = getAuthIdentityScope();
        setNavDirection('forward');
        setView('dm_inbox');
        setLoading(true);
        if (privateMessageRuntime.kind === 'native-pilot') {
            pilotInboxLoadingRef.current = true;
            await refreshPilotInbox();
            return;
        }
        const convs = await ChatService.getDMConversations().catch(() => null);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        if (!convs) {
            setLoading(false);
            toast.error("Direct messages couldn't be loaded. Check your connection and try again.");
            return;
        }
        setDmConversations(convs);
        setLoading(false);
    }, [
        ensureDirectMessagePushRegistration,
        setView,
        setNavDirection,
        setLoading,
        pilotActive,
        privateMessageRuntime,
        refreshPilotInbox,
    ]);

    const openDMThread = useCallback(
        async (userId: string, name: string) => {
            const identity = getAuthIdentityScope();
            if (!pilotActive && userId !== identity.userId) ensureDirectMessagePushRegistration();
            setDmPartner({ id: userId, name: userId === identity.userId ? 'Self test' : name });
            const version = partnerVersionRef.current;
            setDmThread([]);
            setDmText('');
            setNavDirection('forward');
            setView('dm_thread');
            setShowBlockConfirm(false);
            setLoading(true);
            if (privateMessageRuntime.kind === 'native-pilot') {
                pilotInboxLoadingRef.current = false;
                const generation = pilotViewGenerationRef.current;
                const afterRevision = pilotEventRevisionRef.current;
                setBlockStatusLoading(true);
                const result = await privateMessageRuntime
                    .getThread(identity, userId)
                    .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
                if (
                    !aliveRef.current ||
                    !isAuthIdentityScopeCurrent(identity) ||
                    generation !== pilotViewGenerationRef.current ||
                    version !== partnerVersionRef.current ||
                    runtimeRef.current !== privateMessageRuntime
                )
                    return;
                if (result.status === 'ok') {
                    const messages = reconcilePilotThread(result.value.messages, afterRevision, userId);
                    if (!messages) return;
                    pilotViewOpenRef.current = true;
                    setDmThread(messages);
                    const permissions = result.value.permissions;
                    setBlockedByMe(permissions.blockedByMe);
                    setIsUserBlocked(permissions.blockedEitherDirection);
                    setPilotFailure(permissions.canSend ? null : permissions.reason || 'unavailable');
                    pilotSendAllowedRef.current = permissions.canSend;
                    void refreshPilotInbox();
                } else {
                    fencePilotView(result.reason);
                    return;
                }
                setBlockStatusLoading(false);
                setLoading(false);
                return;
            }
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
        [
            ensureDirectMessagePushRegistration,
            setView,
            setNavDirection,
            setLoading,
            setDmPartner,
            retryBlockStatus,
            pilotActive,
            privateMessageRuntime,
            reconcilePilotThread,
            refreshPilotInbox,
            fencePilotView,
        ],
    );

    const sendDMMessage = useCallback(async () => {
        if (runtimeRef.current !== privateMessageRuntime || stateRuntimeRef.current !== privateMessageRuntime) return;
        if (!dmText.trim() || !dmPartner) return;
        if (isUserBlocked || blockStatusLoading || blockStatusError || blockMutationRef.current) return;
        const identity = getAuthIdentityScope();
        const version = partnerVersionRef.current;
        const text = dmText.trim();
        if (privateMessageRuntime.kind === 'native-pilot') {
            if (!pilotSendAllowedRef.current || pilotFailure || pilotSendingRef.current) return;
            if (!isPrivateMessagePilotText(text)) {
                setPilotFailure('unsupported_content');
                return;
            }
            const previous = pilotSendRef.current;
            const send =
                previous?.peerId === dmPartner.id && previous.text === text
                    ? previous
                    : { peerId: dmPartner.id, text, clientMessageId: crypto.randomUUID() };
            pilotSendRef.current = send;
            const generation = pilotViewGenerationRef.current;
            const afterRevision = pilotEventRevisionRef.current;
            pilotSendingRef.current = true;
            setPilotSending(true);
            const result = await privateMessageRuntime
                .sendText(identity, dmPartner.id, send.clientMessageId, text)
                .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
            if (
                !aliveRef.current ||
                !isAuthIdentityScopeCurrent(identity) ||
                generation !== pilotViewGenerationRef.current ||
                version !== partnerVersionRef.current ||
                runtimeRef.current !== privateMessageRuntime
            )
                return;
            pilotSendingRef.current = false;
            setPilotSending(false);
            if (result.status !== 'ok') {
                fencePilotView(result.reason);
                return;
            }
            const existing = pilotEventMessagesRef.current.get(result.value.id);
            if (existing && !samePilotMessageContent(existing.message, result.value)) {
                fencePilotView('unavailable');
                return;
            }
            if (!existing && pilotEventMessagesRef.current.size >= 32) {
                fencePilotView('capacity_exceeded');
                return;
            }
            // An event can confirm relay acceptance/read state before an
            // older send snapshot is delivered to this hook. Keep that newer
            // native event rather than downgrade it to the earlier snapshot.
            const message = existing ? mergePilotMessage(existing.message, result.value) : result.value;
            pilotEventMessagesRef.current.set(result.value.id, {
                revision:
                    existing && existing.revision > afterRevision ? existing.revision : ++pilotEventRevisionRef.current,
                message: { ...message },
            });
            setDmThread((prev) =>
                prev.some((item) => item.id === message.id)
                    ? prev.map((item) => (item.id === message.id ? message : item))
                    : [...prev, message],
            );
            setDmText((current) => (current.trim() === text ? '' : current));
            pilotSendRef.current = null;
            void refreshPilotInbox();
            triggerHaptic('light');
            return;
        }
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
    }, [
        dmText,
        dmPartner,
        isUserBlocked,
        blockStatusLoading,
        blockStatusError,
        retryBlockStatus,
        privateMessageRuntime,
        pilotFailure,
        fencePilotView,
        refreshPilotInbox,
    ]);

    const updateBlock = useCallback(
        async (blocked: boolean) => {
            if (runtimeRef.current !== privateMessageRuntime || stateRuntimeRef.current !== privateMessageRuntime)
                return;
            const partner = dmPartnerRef.current;
            if (!partner || blockMutationRef.current) return;
            const identity = getAuthIdentityScope();
            const version = partnerVersionRef.current;
            const request = ++blockRequestRef.current;
            const generation = pilotViewGenerationRef.current;
            const current = () =>
                aliveRef.current &&
                isAuthIdentityScopeCurrent(identity) &&
                runtimeRef.current === privateMessageRuntime &&
                version === partnerVersionRef.current &&
                request === blockRequestRef.current;
            blockMutationRef.current = true;
            setBlockMutationPending(true);
            setBlockStatusLoading(false);
            setBlockStatusError(null);
            if (privateMessageRuntime.kind === 'native-pilot') {
                // The SDK-bound native adapter fences the old view before
                // this control resolves. Close only the intent UI now; the
                // renewed read must still establish actual block authority.
                setShowBlockConfirm(false);
                const result = await privateMessageRuntime
                    .setBlocked(identity, partner.id, blocked)
                    .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
                if (!current() || generation !== pilotViewGenerationRef.current) return;
                if (result.status === 'ok') {
                    fencePilotView('unavailable');
                    pilotViewOpenRef.current = true;
                    setBlockedByMe(result.value.blockedByMe);
                    setIsUserBlocked(result.value.blockedEitherDirection);
                    setPilotFailure(result.value.canSend ? null : result.value.reason || 'unavailable');
                    pilotSendAllowedRef.current = result.value.canSend;
                    setDmThread([]);
                    setShowBlockConfirm(false);
                } else {
                    fencePilotView(result.reason);
                    return;
                }
                blockMutationRef.current = false;
                setBlockMutationPending(false);
                return;
            }
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
                    blocked
                        ? "Block couldn't be confirmed. Please retry."
                        : "Unblock couldn't be confirmed. Please retry.",
                );
            } finally {
                if (current()) {
                    blockMutationRef.current = false;
                    setBlockMutationPending(false);
                }
            }
        },
        [privateMessageRuntime, fencePilotView],
    );

    const handleBlockUser = useCallback(() => updateBlock(true), [updateBlock]);
    const handleUnblockUser = useCallback(() => updateBlock(false), [updateBlock]);

    const loadUnreadCount = useCallback(async () => {
        const identity = getAuthIdentityScope();
        if (privateMessageRuntime.kind === 'native-pilot') {
            await refreshPilotInbox();
            return;
        }
        const convs = await ChatService.getDMConversations();
        if (!isAuthIdentityScopeCurrent(identity)) return;
        const total = convs.reduce((sum, c) => sum + c.unread_count, 0);
        setUnreadDMs(total);
    }, [privateMessageRuntime, refreshPilotInbox]);

    return {
        // State
        currentUserId: identityScope.userId,
        identityGeneration: identityScope.generation,
        pilotActive,
        pilotStatusText: runtimeChanged
            ? privateMessageFailureText('unavailable')
            : pilotFailure
              ? privateMessageFailureText(pilotFailure)
              : null,
        pilotSendDisabled: runtimeChanged || (pilotActive && (!!pilotFailure || pilotSending)),
        isSelfConversation: !!identityScope.userId && dmPartner?.id === identityScope.userId,
        dmConversations: runtimeChanged ? [] : dmConversations,
        dmThread: runtimeChanged ? [] : dmThread,
        setDmThread,
        dmPartner: runtimeChanged ? null : dmPartner,
        setDmPartner,
        dmText: runtimeChanged ? '' : dmText,
        setDmText,
        isUserBlocked,
        blockedByMe,
        blockStatusLoading,
        blockStatusError,
        blockMutationPending,
        showBlockConfirm,
        setShowBlockConfirm,
        unreadDMs: runtimeChanged ? 0 : unreadDMs,

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
