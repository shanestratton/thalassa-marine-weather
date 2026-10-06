/**
 * Native-only private-message pilot hook. Importing this module does not load
 * production Auth, chat transport, offline queues, push, recipe or toast services.
 * AuthIdentityScope is a local stale-work fence, never native message authority.
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useSyncExternalStore } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    isPrivateMessagePilotText,
    privateMessageFailureText,
    type PrivateMessagePilotRuntime,
    type PrivateMessageFailure,
    type PrivateMessagePilotMessage,
    type PrivateMessagePilotConversation,
    type PrivateMessagePilotThread,
} from '../../services/chat/e2ee/privateMessagePilot';

export interface UsePrivateMessagePilotDMsOptions {
    setView: (view: string) => void;
    setNavDirection: (dir: 'forward' | 'back') => void;
    setLoading: (loading: boolean) => void;
    privateMessageRuntime: PrivateMessagePilotRuntime;
}

interface RecordedPilotMessage {
    revision: number;
    message: PrivateMessagePilotMessage;
    knownText: string | null;
    knownLocalCreatedAtMillis: number | null;
    knownTerminalDelivery: PrivateMessagePilotMessage['delivery'] | null;
    knownReason: PrivateMessagePilotMessage['reason'];
}

function recordPilotMessage(
    message: PrivateMessagePilotMessage,
    revision: number,
    previous?: RecordedPilotMessage,
): RecordedPilotMessage {
    return {
        revision,
        message: { ...message },
        knownText: message.message ?? previous?.knownText ?? null,
        knownLocalCreatedAtMillis: message.localCreatedAtMillis ?? previous?.knownLocalCreatedAtMillis ?? null,
        knownTerminalDelivery:
            message.delivery === 'pending' ? (previous?.knownTerminalDelivery ?? null) : message.delivery,
        knownReason: message.reason ?? previous?.knownReason ?? null,
    };
}

function samePilotMessageContent(previous: RecordedPilotMessage, b: PrivateMessagePilotMessage): boolean {
    const a = previous.message;
    return (
        a.id === b.id &&
        a.sender_id === b.sender_id &&
        a.recipient_id === b.recipient_id &&
        a.clientMessageId === b.clientMessageId &&
        a.direction === b.direction &&
        (previous.knownText === null || b.message === null || previous.knownText === b.message) &&
        (previous.knownLocalCreatedAtMillis === null ||
            b.localCreatedAtMillis === null ||
            previous.knownLocalCreatedAtMillis === b.localCreatedAtMillis) &&
        (previous.knownTerminalDelivery === null ||
            b.delivery === 'pending' ||
            previous.knownTerminalDelivery === b.delivery) &&
        (previous.knownReason === null || b.reason === null || previous.knownReason === b.reason)
    );
}

/** Only merge matching native rows; relay acceptance is never a read receipt. */
function mergePilotMessage(
    previous: PrivateMessagePilotMessage,
    next: PrivateMessagePilotMessage,
): PrivateMessagePilotMessage {
    return {
        ...next,
        read: false,
        delivery: next.delivery === 'pending' && previous.delivery !== 'pending' ? previous.delivery : next.delivery,
        reason: next.delivery === 'pending' && previous.delivery !== 'pending' ? previous.reason : next.reason,
    };
}

export function usePrivateMessagePilotDMs(options: UsePrivateMessagePilotDMsOptions) {
    const { setView, setNavDirection, setLoading, privateMessageRuntime } = options;

    const runtimeRef = useRef(privateMessageRuntime);
    runtimeRef.current = privateMessageRuntime;
    const stateRuntimeRef = useRef(privateMessageRuntime);
    const runtimeChanged = stateRuntimeRef.current !== privateMessageRuntime;
    const identityScope = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope, getAuthIdentityScope);

    const [pilotConversations, setPilotConversations] = useState<PrivateMessagePilotConversation[]>([]);
    const [pilotThread, setPilotThread] = useState<PrivateMessagePilotMessage[]>([]);
    const [pilotPendingAttemptId, setPilotPendingAttemptId] = useState<string | null>(null);
    const [pilotUnresolvedCount, setPilotUnresolvedCount] = useState(0);
    const [dmPartner, setDmPartnerState] = useState<{ id: string; name: string } | null>(null);
    const [dmText, setDmText] = useState('');
    const [isUserBlocked, setIsUserBlocked] = useState(false);
    const [blockedByMe, setBlockedByMe] = useState(false);
    const [blockStatusLoading, setBlockStatusLoading] = useState(false);
    const [blockStatusError, setBlockStatusError] = useState<string | null>(null);
    const [blockMutationPending, setBlockMutationPending] = useState(false);
    const [showBlockConfirm, setShowBlockConfirm] = useState(false);
    const [unreadDMs, setUnreadDMs] = useState(0);
    const [pilotFailure, setPilotFailure] = useState<PrivateMessageFailure | null>('unavailable');
    const [pilotSending, setPilotSending] = useState(false);
    const [pilotRefreshStatus, setPilotRefreshStatus] = useState<string | null>(null);
    const pilotRefreshBusyRef = useRef(false);
    const privateViewClosedRef = useRef(false);
    const subscriptionEpochRef = useRef(0);
    const subscriptionStopsRef = useRef(new Set<() => void>());
    const pilotSendRef = useRef<{ peerId: string; text: string | null; clientMessageId: string } | null>(null);
    const pilotSendingRef = useRef(false);
    const pilotViewGenerationRef = useRef(0);
    const pilotViewOpenRef = useRef(false);
    const pilotSendAllowedRef = useRef(false);
    const pilotEventRevisionRef = useRef(0);
    const pilotEventMessagesRef = useRef(new Map<string, RecordedPilotMessage>());
    const pilotInboxLoadingRef = useRef(false);
    // Physical scan admission survives local close/scope resets until settlement.
    const pilotInboxScanBusyRef = useRef(false);

    // Ref so the DM subscription callback always has fresh partner data
    const dmPartnerRef = useRef(dmPartner);
    const partnerVersionRef = useRef(0);
    const inboxRequestRef = useRef(0);
    const aliveRef = useRef(true);
    const cancelPrivateSubscriptions = useCallback(() => {
        subscriptionEpochRef.current += 1;
        for (const stop of [...subscriptionStopsRef.current]) stop();
        subscriptionStopsRef.current.clear();
    }, []);
    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            cancelPrivateSubscriptions();
            partnerVersionRef.current += 1;
            inboxRequestRef.current += 1;
            pilotViewGenerationRef.current += 1;
        };
    }, [cancelPrivateSubscriptions]);
    const blockRequestRef = useRef(0);
    const blockMutationRef = useRef(false);

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
            pilotRefreshBusyRef.current = false;
            setPilotRefreshStatus(null);
            setPilotFailure(reason);
            setPilotSending(false);
            setBlockMutationPending(false);
            setBlockStatusLoading(false);
            setPilotThread([]);
            setPilotConversations([]);
            setPilotUnresolvedCount(0);
            setUnreadDMs(0);
            setLoading(false);
        },
        [setLoading],
    );

    const reconcilePilotThread = useCallback(
        (snapshot: PrivateMessagePilotMessage[], afterRevision: number, peerId: string) => {
            const merged = new Map(snapshot.map((message) => [message.id, message]));
            for (const message of snapshot) {
                const existing = pilotEventMessagesRef.current.get(message.id);
                if (existing && !samePilotMessageContent(existing, message)) {
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
                pilotEventMessagesRef.current.set(
                    message.id,
                    recordPilotMessage(
                        message,
                        existing && existing.revision > afterRevision ? existing.revision : afterRevision,
                        existing,
                    ),
                );
            }
            return [...merged.values()];
        },
        [fencePilotView],
    );

    const reconcilePilotAttempt = useCallback(
        (thread: PrivateMessagePilotThread, peerId: string, afterRevision: number) => {
            const previous = pilotSendRef.current;
            const latest =
                thread.pendingAttemptId === null
                    ? undefined
                    : pilotEventMessagesRef.current.get(`outgoing:${thread.pendingAttemptId}`);
            const settledAfterSnapshot =
                latest &&
                latest.revision > afterRevision &&
                (latest.message.delivery === 'server_accepted' || latest.message.delivery === 'rejected');
            const nativeId = settledAfterSnapshot ? null : thread.pendingAttemptId;
            if (nativeId !== null) {
                const committed = thread.messages.find(
                    (message) => message.direction === 'outgoing' && message.clientMessageId === nativeId,
                );
                pilotSendRef.current = {
                    peerId,
                    clientMessageId: nativeId,
                    text:
                        previous?.peerId === peerId && previous.clientMessageId === nativeId
                            ? previous.text
                            : (committed?.message ?? null),
                };
            } else if (previous?.peerId === peerId) {
                // Lost preparation responses retain their original typed ID even
                // when the first refreshed snapshot contains no committed row.
                // Only an actual terminal native row establishes settlement.
                const settled = [...pilotEventMessagesRef.current.values()].some(
                    ({ message }) =>
                        message.direction === 'outgoing' &&
                        message.clientMessageId === previous.clientMessageId &&
                        (message.delivery === 'server_accepted' || message.delivery === 'rejected'),
                );
                if (settled) pilotSendRef.current = null;
            }
            setPilotPendingAttemptId(
                pilotSendRef.current?.peerId === peerId ? pilotSendRef.current.clientMessageId : null,
            );
            setPilotUnresolvedCount(thread.unresolvedCount);
        },
        [],
    );

    const invalidatePilotInboxPreviews = useCallback(() => {
        setPilotConversations((rows) => rows.map((row) => ({ ...row, last_message: null, last_at: null })));
    }, []);

    const refreshPilotInbox = useCallback(async () => {
        if (privateViewClosedRef.current) return;
        if (pilotInboxScanBusyRef.current) return;
        const identity: AuthIdentityScope = getAuthIdentityScope();
        const generation = pilotViewGenerationRef.current;
        const partnerVersion = partnerVersionRef.current;
        const request = ++inboxRequestRef.current;
        const revision = pilotEventRevisionRef.current;
        const current = () =>
            aliveRef.current &&
            !privateViewClosedRef.current &&
            isAuthIdentityScopeCurrent(identity) &&
            runtimeRef.current === privateMessageRuntime &&
            generation === pilotViewGenerationRef.current &&
            partnerVersion === partnerVersionRef.current &&
            request === inboxRequestRef.current;
        // ONE explicit bounded receive scan. An intervening native event makes
        // this preview stale; it never authorizes another hidden receive scan.
        pilotInboxScanBusyRef.current = true;
        const result = await privateMessageRuntime
            .getInbox(identity)
            .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }))
            .finally(() => {
                pilotInboxScanBusyRef.current = false;
            });
        if (!current()) return;
        if (result.status !== 'ok') {
            fencePilotView(result.reason);
            return;
        }
        pilotViewOpenRef.current = true;
        if (revision === pilotEventRevisionRef.current) setPilotConversations(result.value);
        else invalidatePilotInboxPreviews();
        setUnreadDMs(0);
        if (!dmPartnerRef.current) {
            setPilotRefreshStatus(null);
            setPilotFailure(null);
        }
        if (pilotInboxLoadingRef.current) {
            pilotInboxLoadingRef.current = false;
            setLoading(false);
        }
    }, [privateMessageRuntime, fencePilotView, setLoading, invalidatePilotInboxPreviews]);

    const setDmPartner = useCallback((partner: { id: string; name: string } | null) => {
        partnerVersionRef.current += 1;
        blockRequestRef.current += 1;
        dmPartnerRef.current = partner;
        blockMutationRef.current = false;
        pilotRefreshBusyRef.current = false;
        setPilotRefreshStatus(null);
        // Reopening the same peer must recover the native pending attempt,
        // including a typed ID whose preparation response was lost.
        if (partner && pilotSendRef.current?.peerId !== partner.id) pilotSendRef.current = null;
        setPilotPendingAttemptId(
            partner && pilotSendRef.current?.peerId === partner.id ? pilotSendRef.current.clientMessageId : null,
        );
        pilotSendingRef.current = false;
        pilotSendAllowedRef.current = false;
        setPilotSending(false);
        setDmPartnerState(partner);
        setIsUserBlocked(false);
        setBlockedByMe(false);
        setBlockStatusLoading(false);
        setBlockStatusError(null);
        setBlockMutationPending(false);
        setPilotFailure('unavailable');
    }, []);

    const closePrivateMessageView = useCallback(() => {
        // Fence local admission BEFORE native subscription cleanup can invoke a
        // captured callback. No native Auth/store/outbox mutation is performed.
        privateViewClosedRef.current = true;
        cancelPrivateSubscriptions();
        fencePilotView('unavailable');
        partnerVersionRef.current += 1;
        dmPartnerRef.current = null;
        setDmPartnerState(null);
        pilotSendRef.current = null;
        setPilotPendingAttemptId(null);
        setDmText('');
        setIsUserBlocked(false);
        setBlockedByMe(false);
        setBlockStatusError(null);
        setShowBlockConfirm(false);
    }, [cancelPrivateSubscriptions, fencePilotView]);
    const getPrivateMessageViewRevision = useCallback(() => pilotViewGenerationRef.current, []);

    // Runtime replacement is an authority boundary even if the SDK account ID
    // did not change. Mask old rendering immediately, then clear before paint.
    useLayoutEffect(() => {
        if (stateRuntimeRef.current === privateMessageRuntime) return;
        stateRuntimeRef.current = privateMessageRuntime;
        cancelPrivateSubscriptions();
        fencePilotView('unavailable');
        setDmPartner(null);
        pilotSendRef.current = null;
        setPilotPendingAttemptId(null);
        setDmText('');
        setShowBlockConfirm(false);
    }, [privateMessageRuntime, fencePilotView, setDmPartner, cancelPrivateSubscriptions]);

    const retryBlockStatus = useCallback(async () => {
        const partner = dmPartnerRef.current;
        if (!partner || privateViewClosedRef.current || pilotRefreshBusyRef.current || blockMutationRef.current) return;
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
        setPilotRefreshStatus(null);

        pilotSendAllowedRef.current = false;
        const afterRevision = pilotEventRevisionRef.current;
        const result = await privateMessageRuntime
            .getThread(identity, partner.id)
            .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
        if (!current() || generation !== pilotViewGenerationRef.current) return;
        if (result.status === 'ok') {
            const messages = reconcilePilotThread(result.value.messages, afterRevision, partner.id);
            if (!messages) return;
            reconcilePilotAttempt(result.value, partner.id, afterRevision);
            setPilotThread(messages);
            const permissions = result.value.permissions;
            setBlockedByMe(permissions.blockedByMe);
            setIsUserBlocked(permissions.blockedEitherDirection);
            setPilotFailure(
                permissions.canSend ? null : permissions.blockedEitherDirection ? 'blocked' : 'unavailable',
            );
            pilotSendAllowedRef.current = permissions.canSend;
            pilotViewOpenRef.current = true;
        } else {
            fencePilotView(result.reason);
            return;
        }
        setBlockStatusLoading(false);
    }, [privateMessageRuntime, fencePilotView, reconcilePilotThread, reconcilePilotAttempt]);

    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                cancelPrivateSubscriptions();
                pilotRefreshBusyRef.current = false;
                setPilotRefreshStatus(null);
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
                pilotSendRef.current = null;
                setPilotPendingAttemptId(null);
                setPilotThread([]);
                setPilotConversations([]);
                setPilotUnresolvedCount(0);
                setLoading(false);
            }),
        [setLoading, setDmPartner, cancelPrivateSubscriptions],
    );

    // --- DM Subscription (lives for component lifetime) ---
    const subscribe = useCallback(() => {
        if (privateViewClosedRef.current || subscriptionStopsRef.current.size >= 32) return () => undefined;
        const identity = getAuthIdentityScope();
        const epoch = subscriptionEpochRef.current;
        let cancelled = false;
        let nativeStop: (() => void) | undefined;
        const stop = () => {
            if (cancelled) return;
            cancelled = true;
            subscriptionStopsRef.current.delete(stop);
            try {
                nativeStop?.();
            } catch {
                /* Locally fenced despite cleanup failure. */
            }
        };
        subscriptionStopsRef.current.add(stop);
        try {
            nativeStop = privateMessageRuntime.subscribe(identity, (event) => {
                if (
                    cancelled ||
                    epoch !== subscriptionEpochRef.current ||
                    privateViewClosedRef.current ||
                    !aliveRef.current ||
                    !isAuthIdentityScopeCurrent(identity) ||
                    runtimeRef.current !== privateMessageRuntime
                )
                    return;
                if (event.status === 'ready') {
                    // Initial subscription readiness cannot restart/fence the ONE
                    // explicit inbox scan already rechecking its own native lease.
                    if (pilotInboxLoadingRef.current && !dmPartnerRef.current) return;
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
                        !cancelled &&
                        epoch === subscriptionEpochRef.current &&
                        !privateViewClosedRef.current &&
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
                                    setPilotThread(messages);
                                    reconcilePilotAttempt(result.value, partner.id, afterRevision);
                                    const permissions = result.value.permissions;
                                    setBlockedByMe(permissions.blockedByMe);
                                    setIsUserBlocked(permissions.blockedEitherDirection);
                                    setPilotFailure(
                                        permissions.canSend
                                            ? null
                                            : permissions.blockedEitherDirection
                                              ? 'blocked'
                                              : 'unavailable',
                                    );
                                    pilotSendAllowedRef.current = permissions.canSend;
                                    invalidatePilotInboxPreviews();
                                } else {
                                    fencePilotView(result.reason);
                                    return;
                                }
                                setBlockStatusLoading(false);
                            });
                    } else {
                        invalidatePilotInboxPreviews();
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
                const existing = pilotEventMessagesRef.current.get(dm.id);
                if (existing && !samePilotMessageContent(existing, dm)) {
                    fencePilotView('unavailable');
                    return;
                }
                const message = existing ? mergePilotMessage(existing.message, dm) : dm;
                if (
                    existing &&
                    existing.message.message === message.message &&
                    existing.message.created_at === message.created_at &&
                    existing.message.localCreatedAtMillis === message.localCreatedAtMillis &&
                    existing.message.delivery === message.delivery &&
                    existing.message.reason === message.reason
                )
                    return;
                if (!existing && pilotEventMessagesRef.current.size >= 32) {
                    fencePilotView('capacity_exceeded');
                    return;
                }
                pilotEventMessagesRef.current.set(
                    dm.id,
                    recordPilotMessage(message, ++pilotEventRevisionRef.current, existing),
                );
                if (partner && (dm.sender_id === partner.id || dm.recipient_id === partner.id)) {
                    setPilotThread((prev) =>
                        prev.some((message) => message.id === dm.id)
                            ? prev.map((item) => (item.id === dm.id ? message : item))
                            : [...prev, message],
                    );
                    if (
                        message.direction === 'outgoing' &&
                        pilotSendRef.current?.clientMessageId === message.clientMessageId &&
                        (message.delivery === 'server_accepted' || message.delivery === 'rejected')
                    ) {
                        pilotSendRef.current = null;
                        setPilotPendingAttemptId(null);
                    }
                }
                invalidatePilotInboxPreviews();
            });
        } catch {
            stop();
            if (!privateViewClosedRef.current && epoch === subscriptionEpochRef.current) fencePilotView('unavailable');
        }
        if (cancelled) {
            try {
                nativeStop?.();
            } catch {
                /* Captured callbacks remain cancelled. */
            }
        }
        return stop;
    }, [
        privateMessageRuntime,
        fencePilotView,
        reconcilePilotThread,
        reconcilePilotAttempt,
        invalidatePilotInboxPreviews,
    ]);

    const openDMInbox = useCallback(async () => {
        privateViewClosedRef.current = false;
        if (pilotInboxScanBusyRef.current) {
            fencePilotView('unavailable');
            return;
        }
        setPilotRefreshStatus(null);
        setNavDirection('forward');
        setView('dm_inbox');
        setLoading(true);

        pilotInboxLoadingRef.current = true;
        await refreshPilotInbox();
        return;
    }, [setView, setNavDirection, setLoading, refreshPilotInbox, fencePilotView]);

    const openDMThread = useCallback(
        async (userId: string, name: string) => {
            if (privateViewClosedRef.current) return;
            const identity = getAuthIdentityScope();

            setDmPartner({ id: userId, name: userId === identity.userId ? 'Self test' : name });
            const version = partnerVersionRef.current;

            setPilotThread([]);
            setDmText('');
            setNavDirection('forward');
            setView('dm_thread');
            setShowBlockConfirm(false);
            setLoading(true);

            pilotInboxLoadingRef.current = false;
            setPilotRefreshStatus(null);
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
                setPilotThread(messages);
                reconcilePilotAttempt(result.value, userId, afterRevision);
                const permissions = result.value.permissions;
                setBlockedByMe(permissions.blockedByMe);
                setIsUserBlocked(permissions.blockedEitherDirection);
                setPilotFailure(
                    permissions.canSend ? null : permissions.blockedEitherDirection ? 'blocked' : 'unavailable',
                );
                pilotSendAllowedRef.current = permissions.canSend;
                invalidatePilotInboxPreviews();
            } else {
                fencePilotView(result.reason);
                return;
            }
            setBlockStatusLoading(false);
            setLoading(false);
        },
        [
            setView,
            setNavDirection,
            setLoading,
            setDmPartner,
            privateMessageRuntime,
            reconcilePilotThread,
            reconcilePilotAttempt,
            invalidatePilotInboxPreviews,
            fencePilotView,
        ],
    );

    const sendPilotMessage = useCallback(
        async (retry: boolean) => {
            if (
                runtimeRef.current !== privateMessageRuntime ||
                stateRuntimeRef.current !== privateMessageRuntime ||
                pilotSendingRef.current ||
                pilotRefreshBusyRef.current ||
                privateViewClosedRef.current
            )
                return;
            const partner = dmPartnerRef.current;
            if (!partner) return;
            const text = dmText.trim();
            if (!retry && (!pilotSendAllowedRef.current || pilotFailure)) return;
            if (!retry && (!isPrivateMessagePilotText(text) || pilotSendRef.current)) {
                if (!isPrivateMessagePilotText(text)) setPilotFailure('unsupported_content');
                return;
            }
            const identity = getAuthIdentityScope();
            const version = partnerVersionRef.current;
            const generation = pilotViewGenerationRef.current;
            const afterRevision = pilotEventRevisionRef.current;
            const current = () =>
                aliveRef.current &&
                isAuthIdentityScopeCurrent(identity) &&
                generation === pilotViewGenerationRef.current &&
                version === partnerVersionRef.current &&
                runtimeRef.current === privateMessageRuntime;
            pilotSendingRef.current = true;
            setPilotSending(true);
            // Readiness is a lease, and canSend is only a hint. The native operation
            // rechecks durable policy atomically. Reconcile its single pending slot
            // before selecting an ID; a refreshed screen cannot invent a new one.
            const snapshot = await privateMessageRuntime
                .getThread(identity, partner.id)
                .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
            if (!current()) return;
            if (snapshot.status !== 'ok') {
                fencePilotView(snapshot.reason);
                return;
            }
            const messages = reconcilePilotThread(snapshot.value.messages, afterRevision, partner.id);
            if (!messages) return;
            reconcilePilotAttempt(snapshot.value, partner.id, afterRevision);
            setPilotThread(messages);
            pilotViewOpenRef.current = true;
            const permissions = snapshot.value.permissions;
            setBlockedByMe(permissions.blockedByMe);
            setIsUserBlocked(permissions.blockedEitherDirection);
            pilotSendAllowedRef.current = permissions.canSend;
            setPilotFailure(
                permissions.canSend ? null : permissions.blockedEitherDirection ? 'blocked' : 'unavailable',
            );
            const pending = pilotSendRef.current;
            if (!permissions.canSend || (!retry && pending) || (retry && !pending)) {
                pilotSendingRef.current = false;
                setPilotSending(false);
                return;
            }
            let send = pending;
            if (!send) {
                let clientMessageId: string;
                try {
                    clientMessageId = crypto.randomUUID();
                    if (
                        typeof clientMessageId !== 'string' ||
                        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(clientMessageId)?.[0] !==
                            clientMessageId
                    )
                        throw new Error('Message ID unavailable');
                } catch {
                    fencePilotView('unavailable');
                    return;
                }
                send = { peerId: partner.id, text, clientMessageId };
            }
            const expectedClientMessageId = send.clientMessageId;
            const hasCommittedAttempt = snapshot.value.messages.some(
                (message) => message.direction === 'outgoing' && message.clientMessageId === expectedClientMessageId,
            );
            const recoverLostPreparation = retry && snapshot.value.pendingAttemptId === null && !hasCommittedAttempt;
            if (recoverLostPreparation && !isPrivateMessagePilotText(send.text)) {
                pilotSendingRef.current = false;
                setPilotSending(false);
                setPilotFailure('unavailable');
                return;
            }
            if (!current()) return;
            pilotSendRef.current = send;
            setPilotPendingAttemptId(send.clientMessageId);
            const result = await (
                retry && !recoverLostPreparation
                    ? privateMessageRuntime.retryPending(identity, partner.id, send.clientMessageId)
                    : privateMessageRuntime.sendText(
                          identity,
                          partner.id,
                          send.clientMessageId,
                          recoverLostPreparation && send.text !== null ? send.text : text,
                      )
            ).catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
            if (!current()) return;
            pilotSendingRef.current = false;
            setPilotSending(false);
            if (result.status !== 'ok') {
                fencePilotView(result.reason);
                return;
            }
            const existing = pilotEventMessagesRef.current.get(result.value.id);
            if (existing && !samePilotMessageContent(existing, result.value)) {
                fencePilotView('unavailable');
                return;
            }
            if (!existing && pilotEventMessagesRef.current.size >= 32) {
                fencePilotView('capacity_exceeded');
                return;
            }
            const message = existing ? mergePilotMessage(existing.message, result.value) : result.value;
            pilotEventMessagesRef.current.set(
                message.id,
                recordPilotMessage(
                    message,
                    existing && existing.revision > afterRevision ? existing.revision : ++pilotEventRevisionRef.current,
                    existing,
                ),
            );
            setPilotThread((previous) =>
                previous.some((item) => item.id === message.id)
                    ? previous.map((item) => (item.id === message.id ? message : item))
                    : [...previous, message],
            );
            // Only an actual native committed echo may clear a matching draft.
            if (message.message !== null && message.delivery !== 'rejected')
                setDmText((draft) => (draft.trim() === message.message ? '' : draft));
            if (message.delivery === 'server_accepted' || message.delivery === 'rejected') {
                pilotSendRef.current = null;
                setPilotPendingAttemptId(null);
            }
            invalidatePilotInboxPreviews();
        },
        [
            privateMessageRuntime,
            dmText,
            pilotFailure,
            fencePilotView,
            reconcilePilotThread,
            reconcilePilotAttempt,
            invalidatePilotInboxPreviews,
        ],
    );

    const refreshNativeMessages = useCallback(async () => {
        const partner = dmPartnerRef.current;
        if (
            !partner ||
            privateViewClosedRef.current ||
            pilotSendingRef.current ||
            pilotRefreshBusyRef.current ||
            pilotInboxScanBusyRef.current ||
            runtimeRef.current !== privateMessageRuntime ||
            stateRuntimeRef.current !== privateMessageRuntime
        )
            return;
        const identity = getAuthIdentityScope();
        const generation = pilotViewGenerationRef.current;
        const version = partnerVersionRef.current;
        const request = ++blockRequestRef.current;
        const afterRevision = pilotEventRevisionRef.current;
        const current = () =>
            aliveRef.current &&
            !privateViewClosedRef.current &&
            isAuthIdentityScopeCurrent(identity) &&
            runtimeRef.current === privateMessageRuntime &&
            stateRuntimeRef.current === privateMessageRuntime &&
            generation === pilotViewGenerationRef.current &&
            version === partnerVersionRef.current &&
            request === blockRequestRef.current;
        pilotRefreshBusyRef.current = true;
        pilotSendAllowedRef.current = false;
        setBlockStatusLoading(true);
        setBlockStatusError(null);
        setPilotRefreshStatus(null);
        pilotInboxScanBusyRef.current = true;
        const scan = await privateMessageRuntime
            .getInbox(identity)
            .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }))
            .finally(() => {
                pilotInboxScanBusyRef.current = false;
            });
        if (!current()) return;
        // A local native read separately rechecks actual native authority. A
        // scan failure alone cannot authorize retaining the previous JS rows.
        const thread = await privateMessageRuntime
            .getThread(identity, partner.id)
            .catch(() => ({ status: 'unavailable' as const, reason: 'unavailable' as const }));
        if (!current()) return;
        if (thread.status !== 'ok') {
            fencePilotView(thread.reason);
            return;
        }
        const messages = reconcilePilotThread(thread.value.messages, afterRevision, partner.id);
        if (!messages) return;
        reconcilePilotAttempt(thread.value, partner.id, afterRevision);
        pilotViewOpenRef.current = true;
        setPilotThread(messages);
        if (scan.status === 'ok' && afterRevision === pilotEventRevisionRef.current) setPilotConversations(scan.value);
        else invalidatePilotInboxPreviews();
        setUnreadDMs(0);
        const permission = thread.value.permissions;
        setBlockedByMe(permission.blockedByMe);
        setIsUserBlocked(permission.blockedEitherDirection);
        pilotSendAllowedRef.current = scan.status === 'ok' && permission.canSend;
        setPilotFailure(
            scan.status !== 'ok'
                ? 'unavailable'
                : permission.canSend
                  ? null
                  : permission.blockedEitherDirection
                    ? 'blocked'
                    : 'unavailable',
        );
        setPilotRefreshStatus(
            scan.status === 'ok'
                ? null
                : 'Native inbox refresh unavailable. Showing authenticated local history; sending is disabled.',
        );
        pilotRefreshBusyRef.current = false;
        setBlockStatusLoading(false);
    }, [
        privateMessageRuntime,
        fencePilotView,
        reconcilePilotThread,
        reconcilePilotAttempt,
        invalidatePilotInboxPreviews,
    ]);

    const retryPilotPendingMessage = useCallback(() => sendPilotMessage(true), [sendPilotMessage]);

    const sendDMMessage = useCallback(async () => {
        if (runtimeRef.current !== privateMessageRuntime || stateRuntimeRef.current !== privateMessageRuntime) return;
        if (!dmText.trim() || !dmPartner) return;
        if (isUserBlocked || blockStatusLoading || blockStatusError || blockMutationRef.current) return;
        if (!pilotSendAllowedRef.current || pilotFailure || pilotSendingRef.current) return;
        await sendPilotMessage(false);
        return;
    }, [
        privateMessageRuntime,
        dmText,
        dmPartner,
        isUserBlocked,
        blockStatusLoading,
        blockStatusError,
        pilotFailure,
        sendPilotMessage,
    ]);

    // This pilot has no supported native block mutator. Never delegate controls.
    const handleBlockUser = useCallback(() => undefined, []);
    const handleUnblockUser = useCallback(() => undefined, []);
    // The native pilot deliberately has no unread/read-receipt feature. A count
    // consumer must not turn this compatibility action into a hidden receive scan.
    const loadUnreadCount = useCallback(async () => {
        setUnreadDMs(0);
    }, []);
    // Compatibility only: callers cannot insert rows outside native reconciliation.
    // The old pilot's setter affected only its unused legacy message array.
    const setDmThread = useCallback((_messages: unknown) => undefined, []);

    return {
        // State
        currentUserId: identityScope.userId,
        identityGeneration: identityScope.generation,
        pilotActive: true as const,
        pilotStatusText: runtimeChanged
            ? privateMessageFailureText('unavailable')
            : (pilotRefreshStatus ?? (pilotFailure ? privateMessageFailureText(pilotFailure) : null)),
        pilotSendDisabled: runtimeChanged || !!pilotFailure || pilotSending || !!pilotPendingAttemptId,
        pilotPendingAttemptId: runtimeChanged ? null : pilotPendingAttemptId,
        pilotRetryDisabled: runtimeChanged || pilotSending || blockStatusLoading,
        pilotUnresolvedCount: runtimeChanged ? 0 : pilotUnresolvedCount,
        isSelfConversation: !!identityScope.userId && dmPartner?.id === identityScope.userId,
        dmConversations: runtimeChanged ? [] : pilotConversations,
        dmThread: runtimeChanged ? [] : pilotThread,
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
        closePrivateMessageView,
        getPrivateMessageViewRevision,
        refreshNativeMessages,
        openDMInbox,
        openDMThread,
        sendDMMessage,
        handleBlockUser,
        handleUnblockUser,
        retryBlockStatus,
        retryPilotPendingMessage,
        loadUnreadCount,
    };
}
