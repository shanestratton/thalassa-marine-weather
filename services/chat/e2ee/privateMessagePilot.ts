/**
 * Disabled-by-default, text-only screen contract. This module does no crypto,
 * network I/O or persistence. Only a deliberately injected native authority can
 * provide pilot history or submit a pilot message. Typed fixtures are not E2EE.
 */
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../../authIdentityScope';
import type { DirectMessage, DMConversation } from '../types';
import { MAX_CHAT_MESSAGE_CHARS } from '../messagePolicy';

export const PRIVATE_MESSAGE_PILOT_LABEL = 'Encryption test—not reviewed';

export type PrivateMessageFailure =
    | 'unavailable'
    | 'signed_out'
    | 'stale_authority'
    | 'peer_changed'
    | 'peer_unverified'
    | 'peer_revoked'
    | 'blocked'
    | 'self_chat_unsupported'
    | 'unsupported_content'
    | 'storage_failure'
    | 'transport_failure'
    | 'capacity_exceeded';

/** Returned by native after server Auth verification, never selected by JS. */
export interface NativePrivateMessageAuthority {
    readonly accountId: string;
    readonly deviceId: string;
    /** Opaque nonsecret revision fencing owner, credential lease and accepted peer trust. */
    readonly lifecycleVersion: string;
    readonly serverVerified: true;
}

export type NativePrivateMessageReadiness =
    | {
          status: 'ready';
          authority: NativePrivateMessageAuthority;
          supportedContent: ['text'];
      }
    | { status: 'unavailable'; reason: PrivateMessageFailure };

export type NativePrivateMessageResult<T> =
    | { status: 'ok'; authority: NativePrivateMessageAuthority; value: T }
    | { status: 'unavailable'; reason: PrivateMessageFailure };

export interface NativePrivateTextMessage {
    id: string;
    senderAccountId: string;
    recipientAccountId: string;
    senderName: string;
    text: string;
    createdAt: string;
    read: boolean;
    /** Acceptance is not recipient delivery or reading. */
    delivery: 'server_accepted' | 'pending';
}

export interface NativePrivateMessageThread {
    peerAccountId: string;
    messages: NativePrivateTextMessage[];
    blockedByMe: boolean;
    blockedEitherDirection: boolean;
    canSend: boolean;
    reason?: PrivateMessageFailure;
}

export interface NativePrivateMessageBlockStatus {
    peerAccountId: string;
    blockedByMe: boolean;
    blockedEitherDirection: boolean;
    canSend: boolean;
    reason?: PrivateMessageFailure;
}

export type NativePrivateMessageEvent =
    | { status: 'ok'; authority: NativePrivateMessageAuthority; value: NativePrivateTextMessage }
    | { status: 'unavailable'; reason: PrivateMessageFailure };

/**
 * Every operation must recheck this exact native authority before dispatch and
 * native state commits. No port implementation may delegate to legacy chat.
 * Requests contain rendering text, never keys/pickles/tokens. Native owns relay,
 * peer trust, ratchet/outbox durability and bilateral block enforcement.
 */
export interface PrivateMessageNativePort {
    /** SDK-bound adapter may notify verification/lease changes; never carries secrets. */
    subscribeReadiness?(listener: () => void): () => void;
    readiness(): Promise<NativePrivateMessageReadiness>;
    getInbox(request: {
        authority: NativePrivateMessageAuthority;
    }): Promise<NativePrivateMessageResult<DMConversation[]>>;
    getThread(request: {
        authority: NativePrivateMessageAuthority;
        peerAccountId: string;
    }): Promise<NativePrivateMessageResult<NativePrivateMessageThread>>;
    sendText(request: {
        authority: NativePrivateMessageAuthority;
        peerAccountId: string;
        clientMessageId: string;
        text: string;
    }): Promise<NativePrivateMessageResult<NativePrivateTextMessage>>;
    getBlockStatus(request: {
        authority: NativePrivateMessageAuthority;
        peerAccountId: string;
    }): Promise<NativePrivateMessageResult<NativePrivateMessageBlockStatus>>;
    /**
     * A peer control may advance lifecycleVersion. Success must echo the exact
     * post-control native readiness for the unchanged owner/device. An SDK-bound
     * adapter must update its cached authority and notify subscribeReadiness.
     */
    setBlocked(request: {
        authority: NativePrivateMessageAuthority;
        peerAccountId: string;
        blocked: boolean;
    }): Promise<NativePrivateMessageResult<NativePrivateMessageBlockStatus>>;
    subscribe(
        request: { authority: NativePrivateMessageAuthority },
        listener: (event: NativePrivateMessageEvent) => void,
    ): Promise<() => void>;
}

export type PrivateMessagePilotResult<T> =
    | { status: 'ok'; value: T }
    | { status: 'unavailable'; reason: PrivateMessageFailure };

export type PrivateMessagePilotEvent = PrivateMessagePilotResult<DirectMessage> | { status: 'ready' };

export interface PrivateMessagePilotRuntime {
    readonly kind: 'native-pilot';
    getInbox(scope: AuthIdentityScope): Promise<PrivateMessagePilotResult<DMConversation[]>>;
    getThread(
        scope: AuthIdentityScope,
        peerAccountId: string,
    ): Promise<
        PrivateMessagePilotResult<{
            messages: DirectMessage[];
            permissions: NativePrivateMessageBlockStatus;
        }>
    >;
    sendText(
        scope: AuthIdentityScope,
        peerAccountId: string,
        clientMessageId: string,
        text: string,
    ): Promise<PrivateMessagePilotResult<DirectMessage>>;
    getBlockStatus(
        scope: AuthIdentityScope,
        peerAccountId: string,
    ): Promise<PrivateMessagePilotResult<NativePrivateMessageBlockStatus>>;
    setBlocked(
        scope: AuthIdentityScope,
        peerAccountId: string,
        blocked: boolean,
    ): Promise<PrivateMessagePilotResult<NativePrivateMessageBlockStatus>>;
    subscribe(scope: AuthIdentityScope, listener: (event: PrivateMessagePilotEvent) => void): () => void;
}

// There is deliberately no environment flag, localStorage toggle or plugin
// auto-detection. The current app always takes its existing legacy path.
export const DISABLED_PRIVATE_MESSAGE_PILOT = Object.freeze({ kind: 'disabled' as const });
export type PrivateMessageRuntime = PrivateMessagePilotRuntime | typeof DISABLED_PRIVATE_MESSAGE_PILOT;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FAILURES = new Set<PrivateMessageFailure>([
    'unavailable',
    'signed_out',
    'stale_authority',
    'peer_changed',
    'peer_unverified',
    'peer_revoked',
    'blocked',
    'self_chat_unsupported',
    'unsupported_content',
    'storage_failure',
    'transport_failure',
    'capacity_exceeded',
]);
const unavailable = (reason: PrivateMessageFailure = 'unavailable') => ({ status: 'unavailable' as const, reason });
const validId = (value: unknown): value is string => typeof value === 'string' && UUID.exec(value)?.[0] === value;
const boundedString = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
function reasonOf(value: unknown): PrivateMessageFailure {
    return typeof value === 'string' && FAILURES.has(value as PrivateMessageFailure)
        ? (value as PrivateMessageFailure)
        : 'unavailable';
}
function validAuthority(value: unknown): value is NativePrivateMessageAuthority {
    return (
        record(value) &&
        value.serverVerified === true &&
        validId(value.accountId) &&
        validId(value.deviceId) &&
        boundedString(value.lifecycleVersion, 128) &&
        /^[A-Za-z0-9._:-]+$/.exec(value.lifecycleVersion)?.[0] === value.lifecycleVersion &&
        Object.keys(value).every((key) => ['accountId', 'deviceId', 'lifecycleVersion', 'serverVerified'].includes(key))
    );
}
function sameAuthority(a: NativePrivateMessageAuthority, b: unknown): boolean {
    return (
        validAuthority(b) &&
        a.accountId === b.accountId &&
        a.deviceId === b.deviceId &&
        a.lifecycleVersion === b.lifecycleVersion
    );
}
/** Structured shares are unsupported even when disguised as legacy text. */
export function isPrivateMessagePilotText(text: unknown): text is string {
    return (
        typeof text === 'string' &&
        text.trim().length > 0 &&
        text.length <= MAX_CHAT_MESSAGE_CHARS &&
        !text.includes('\0') &&
        !text.split(/\r?\n/).some((line) => line.startsWith('📍PIN|') || line.startsWith('🍳RECIPE:'))
    );
}
function validPermissions(value: unknown): value is NativePrivateMessageBlockStatus {
    return (
        record(value) &&
        validId(value.peerAccountId) &&
        typeof value.blockedByMe === 'boolean' &&
        typeof value.blockedEitherDirection === 'boolean' &&
        typeof value.canSend === 'boolean' &&
        (!value.blockedByMe || value.blockedEitherDirection) &&
        !(value.canSend && (value.blockedEitherDirection || value.reason !== undefined)) &&
        (value.canSend || (typeof value.reason === 'string' && FAILURES.has(value.reason as PrivateMessageFailure)))
    );
}
function mapMessage(value: unknown, accountId: string, peerAccountId?: string): DirectMessage | null {
    if (
        !record(value) ||
        !validId(value.id) ||
        !validId(value.senderAccountId) ||
        !validId(value.recipientAccountId) ||
        value.senderAccountId === value.recipientAccountId ||
        !boundedString(value.senderName, 200) ||
        !isPrivateMessagePilotText(value.text) ||
        !boundedString(value.createdAt, 40) ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        typeof value.read !== 'boolean' ||
        !['server_accepted', 'pending'].includes(value.delivery as string) ||
        !(value.senderAccountId === accountId || value.recipientAccountId === accountId) ||
        (value.delivery === 'pending' && value.senderAccountId !== accountId) ||
        (peerAccountId && !(value.senderAccountId === peerAccountId || value.recipientAccountId === peerAccountId))
    )
        return null;
    return {
        id: value.id,
        sender_id: value.senderAccountId,
        recipient_id: value.recipientAccountId,
        sender_name: value.senderName,
        message: value.text,
        read: value.read,
        created_at: value.createdAt,
        ...(value.delivery === 'pending' ? { delivery_status: 'sending' as const } : {}),
    };
}

export function privateMessageFailureText(reason: PrivateMessageFailure): string {
    switch (reason) {
        case 'peer_changed':
            return 'This sailor’s device identity changed. Sending is blocked until it is reviewed.';
        case 'peer_unverified':
            return 'This sailor’s device is not ready for the encryption test.';
        case 'peer_revoked':
            return 'This sailor’s device was revoked. Sending is blocked.';
        case 'blocked':
            return 'Messaging is blocked for this conversation.';
        case 'self_chat_unsupported':
            return 'Self messages are unavailable in this encryption test.';
        case 'unsupported_content':
            return 'The encryption test supports text only. Attachments, locations and recipes are unavailable.';
        case 'capacity_exceeded':
            return 'The encryption test’s native message store is full. Sending is unavailable.';
        case 'signed_out':
        case 'stale_authority':
            return 'The encryption test needs a current, server-verified native sign-in.';
        default:
            return 'The encryption test is unavailable. Sending is blocked.';
    }
}

export function createPrivateMessagePilotRuntime(port: PrivateMessageNativePort): PrivateMessagePilotRuntime {
    async function authorityFor(
        scope: AuthIdentityScope,
    ): Promise<PrivateMessagePilotResult<NativePrivateMessageAuthority>> {
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return unavailable('signed_out');
        try {
            const ready = await port.readiness();
            if (!isAuthIdentityScopeCurrent(scope)) return unavailable('stale_authority');
            if (!record(ready) || ready.status !== 'ready')
                return unavailable(reasonOf(record(ready) ? ready.reason : null));
            if (
                !validAuthority(ready.authority) ||
                ready.authority.accountId !== scope.userId ||
                !Array.isArray(ready.supportedContent) ||
                ready.supportedContent.length !== 1 ||
                ready.supportedContent[0] !== 'text'
            )
                return unavailable();
            return { status: 'ok', value: { ...ready.authority } };
        } catch {
            return unavailable();
        }
    }
    async function invoke<T>(
        scope: AuthIdentityScope,
        operation: (authority: NativePrivateMessageAuthority) => Promise<NativePrivateMessageResult<T>>,
        permitsPeerControlTransition = false,
    ): Promise<PrivateMessagePilotResult<T>> {
        const ready = await authorityFor(scope);
        if (ready.status !== 'ok') return ready;
        if (!isAuthIdentityScopeCurrent(scope)) return unavailable('stale_authority');
        try {
            const result = await operation(ready.value);
            if (!isAuthIdentityScopeCurrent(scope)) return unavailable('stale_authority');
            // A matching echoed revision alone cannot attest current readiness.
            const current = await authorityFor(scope);
            if (current.status !== 'ok') return current;
            if (permitsPeerControlTransition) {
                if (
                    ready.value.accountId !== current.value.accountId ||
                    ready.value.deviceId !== current.value.deviceId
                )
                    return unavailable('stale_authority');
            } else if (!sameAuthority(ready.value, current.value)) return unavailable('stale_authority');
            if (!record(result) || result.status !== 'ok')
                return unavailable(reasonOf(record(result) ? result.reason : null));
            return sameAuthority(current.value, result.authority)
                ? { status: 'ok', value: result.value }
                : unavailable('stale_authority');
        } catch {
            return unavailable();
        }
    }
    const peerFailure = (scope: AuthIdentityScope, peer: string) =>
        peer === scope.userId ? unavailable('self_chat_unsupported') : !validId(peer) ? unavailable() : null;
    return {
        kind: 'native-pilot',
        async getInbox(scope) {
            const result = await invoke(scope, (authority) => port.getInbox({ authority }));
            if (result.status !== 'ok') return result;
            if (
                !Array.isArray(result.value) ||
                result.value.length > 1 ||
                !result.value.every(
                    (item) =>
                        record(item) &&
                        validId(item.user_id) &&
                        item.user_id !== scope.userId &&
                        boundedString(item.display_name, 200) &&
                        (item.last_message === '' || isPrivateMessagePilotText(item.last_message)) &&
                        boundedString(item.last_at, 40) &&
                        Number.isFinite(Date.parse(item.last_at)) &&
                        Number.isSafeInteger(item.unread_count) &&
                        item.unread_count >= 0 &&
                        item.unread_count <= 16,
                )
            )
                return unavailable();
            return {
                status: 'ok',
                value: result.value.map((item) => ({
                    user_id: item.user_id,
                    display_name: item.display_name,
                    last_message: item.last_message,
                    last_at: item.last_at,
                    unread_count: item.unread_count,
                })),
            };
        },
        async getThread(scope, peerAccountId) {
            const failure = peerFailure(scope, peerAccountId);
            if (failure) return failure;
            const result = await invoke(scope, (authority) => port.getThread({ authority, peerAccountId }));
            if (result.status !== 'ok') return result;
            const value = result.value;
            if (
                !record(value) ||
                value.peerAccountId !== peerAccountId ||
                !validPermissions(value) ||
                !Array.isArray(value.messages) ||
                value.messages.length > 32
            )
                return unavailable();
            const messages = value.messages.map((item) => mapMessage(item, scope.userId!, peerAccountId));
            if (messages.some((item) => !item) || new Set(messages.map((item) => item!.id)).size !== messages.length)
                return unavailable();
            return {
                status: 'ok',
                value: {
                    messages: messages as DirectMessage[],
                    permissions: {
                        peerAccountId,
                        blockedByMe: value.blockedByMe,
                        blockedEitherDirection: value.blockedEitherDirection,
                        canSend: value.canSend,
                        ...(value.reason ? { reason: value.reason } : {}),
                    },
                },
            };
        },
        async sendText(scope, peerAccountId, clientMessageId, text) {
            const failure = peerFailure(scope, peerAccountId);
            if (failure) return failure;
            if (!validId(clientMessageId) || !isPrivateMessagePilotText(text))
                return unavailable('unsupported_content');
            const result = await invoke(scope, (authority) =>
                port.sendText({ authority, peerAccountId, clientMessageId, text }),
            );
            if (result.status !== 'ok') return result;
            const message = mapMessage(result.value, scope.userId!, peerAccountId);
            return message &&
                message.id === clientMessageId &&
                message.sender_id === scope.userId &&
                message.message === text
                ? { status: 'ok', value: message }
                : unavailable();
        },
        async getBlockStatus(scope, peerAccountId) {
            const failure = peerFailure(scope, peerAccountId);
            if (failure) return failure;
            const result = await invoke(scope, (authority) => port.getBlockStatus({ authority, peerAccountId }));
            return result.status !== 'ok'
                ? result
                : validPermissions(result.value) && result.value.peerAccountId === peerAccountId
                  ? result
                  : unavailable();
        },
        async setBlocked(scope, peerAccountId, blocked) {
            const failure = peerFailure(scope, peerAccountId);
            if (failure) return failure;
            const result = await invoke(
                scope,
                (authority) => port.setBlocked({ authority, peerAccountId, blocked }),
                true,
            );
            return result.status !== 'ok'
                ? result
                : validPermissions(result.value) &&
                    result.value.peerAccountId === peerAccountId &&
                    result.value.blockedByMe === blocked
                  ? result
                  : unavailable();
        },
        subscribe(scope, listener) {
            let disposed = false;
            let binding = 0;
            let unsubscribe: (() => void) | undefined;
            // This pilot stores at most 32 messages. Never accumulate an
            // unbounded queue (or unbounded suspended readiness checks) when
            // the native bridge is slow. Old bindings share this work cap.
            const maxEventWork = 32;
            let pendingEventChecks = 0;
            let eventSequence = 0;
            let eventBarrier = 0;
            const latestEvents = new Map<string, { sequence: number; message: DirectMessage }>();
            const notify = (event: PrivateMessagePilotEvent) => {
                try {
                    listener(event);
                } catch {
                    /* Consumer errors cannot enter telemetry or reject bridge work. */
                }
            };
            const stopNative = () => {
                try {
                    unsubscribe?.();
                } catch {
                    /* Stay locally fenced if native cleanup fails. */
                }
                unsubscribe = undefined;
            };
            const rebind = async () => {
                const ticket = ++binding;
                stopNative();
                latestEvents.clear();
                eventSequence = 0;
                eventBarrier = 0;
                let eventWorkClosed = false;
                const active = () =>
                    !disposed && !eventWorkClosed && binding === ticket && isAuthIdentityScopeCurrent(scope);
                const failEvents = (reason: PrivateMessageFailure, closeWork = false) => {
                    if (!active()) return;
                    // A later refusal must fence every earlier suspended event,
                    // including those for a different message ID.
                    eventBarrier = eventSequence;
                    if (closeWork) {
                        eventWorkClosed = true;
                        latestEvents.clear();
                    }
                    notify(unavailable(reason));
                    if (closeWork) stopNative();
                };
                const ready = await authorityFor(scope);
                if (!active()) return;
                if (ready.status !== 'ok') {
                    notify(ready);
                    return;
                }
                try {
                    const stop = await port.subscribe({ authority: ready.value }, (event) => {
                        if (!active()) return;
                        const sequence = ++eventSequence;
                        if (!record(event) || event.status !== 'ok') {
                            failEvents(reasonOf(record(event) ? event.reason : null));
                            return;
                        }
                        // Snapshot only bounded rendering data before awaiting
                        // readiness; never retain an arbitrary bridge envelope.
                        const message = sameAuthority(ready.value, event.authority)
                            ? mapMessage(event.value, scope.userId!)
                            : null;
                        if (!message) {
                            failEvents('unavailable');
                            return;
                        }
                        const prior = latestEvents.get(message.id)?.message;
                        if (
                            prior &&
                            (prior.sender_id !== message.sender_id ||
                                prior.recipient_id !== message.recipient_id ||
                                prior.message !== message.message ||
                                prior.created_at !== message.created_at)
                        ) {
                            failEvents('unavailable');
                            return;
                        }
                        if (!prior && latestEvents.size >= maxEventWork) {
                            failEvents('capacity_exceeded', true);
                            return;
                        }
                        if (pendingEventChecks >= maxEventWork) {
                            // Bridge backpressure is not evidence that the
                            // native durable message store itself is full.
                            failEvents('unavailable', true);
                            return;
                        }
                        latestEvents.set(message.id, { sequence, message });
                        pendingEventChecks += 1;
                        void authorityFor(scope)
                            .then((current) => {
                                if (!active()) return;
                                // Even a superseded message check must honour an
                                // actual current-authority refusal. Only successful
                                // rendering results are suppressed by event order.
                                if (current.status !== 'ok') {
                                    failEvents(current.reason);
                                    return;
                                }
                                if (!sameAuthority(ready.value, current.value)) {
                                    failEvents('stale_authority');
                                    return;
                                }
                                if (sequence <= eventBarrier || latestEvents.get(message.id)?.sequence !== sequence)
                                    return;
                                notify({ status: 'ok', value: message });
                            })
                            .catch(() => failEvents('unavailable'))
                            .finally(() => {
                                pendingEventChecks -= 1;
                            });
                    });
                    const current = await authorityFor(scope);
                    if (!active() || current.status !== 'ok' || !sameAuthority(ready.value, current.value)) {
                        stop();
                        if (active()) notify(current.status !== 'ok' ? current : unavailable('stale_authority'));
                    } else {
                        unsubscribe = stop;
                        // An event refusal during subscription setup cannot be
                        // undone by its older successful readiness handshake.
                        if (eventBarrier === 0) notify({ status: 'ready' });
                    }
                } catch {
                    if (active()) notify(unavailable());
                }
            };
            const stopReadiness = port.subscribeReadiness?.(() => {
                void rebind();
            });
            void rebind();
            return () => {
                disposed = true;
                binding += 1;
                latestEvents.clear();
                stopReadiness?.();
                stopNative();
            };
        },
    };
}
