/**
 * Disabled-by-default, text-only screen contract. This module does no crypto,
 * network I/O or persistence. Only a deliberately injected native authority can
 * provide pilot history or submit a pilot message. Typed fixtures are not E2EE.
 */
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../../authIdentityScope';
import { isPrivateMessagePilotText } from './privateMessageTextPolicy';
export { isPrivateMessagePilotText } from './privateMessageTextPolicy';

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
    id: `outgoing:${string}` | `incoming:${string}`;
    clientMessageId: string;
    direction: 'outgoing' | 'incoming';
    senderAccountId: string;
    recipientAccountId: string;
    senderName: 'You' | 'Paired sailor';
    text: string | null;
    localCreatedAtMillis: number | null;
    read: false;
    /** Acceptance is not recipient delivery or reading. */
    delivery: 'server_accepted' | 'pending' | 'rejected' | 'received';
    reason: null | 'blocked' | 'device-revoked' | 'record-conflict';
}

export interface NativePrivateMessageThread {
    peerAccountId: string;
    messages: NativePrivateTextMessage[];
    permissions: NativePrivateMessageBlockStatus;
    unresolvedCount: number;
    pendingAttemptId: string | null;
}

export interface NativePrivateMessageInboxEntry {
    peerAccountId: string;
    displayName: 'Paired sailor';
    lastText: string | null;
    lastLocalCreatedAtMillis: number | null;
    unreadCount: 0;
    historyAvailable: boolean;
}

/** Explicit pilot rendering data; legacy DM types retain their stronger fields. */
export interface PrivateMessagePilotMessage {
    kind: 'native-pilot';
    id: NativePrivateTextMessage['id'];
    clientMessageId: string;
    direction: NativePrivateTextMessage['direction'];
    sender_id: string;
    recipient_id: string;
    sender_name: NativePrivateTextMessage['senderName'];
    message: string | null;
    created_at: string | null;
    localCreatedAtMillis: number | null;
    read: false;
    delivery: NativePrivateTextMessage['delivery'];
    reason: NativePrivateTextMessage['reason'];
}

export interface PrivateMessagePilotConversation {
    kind: 'native-pilot';
    user_id: string;
    display_name: 'Paired sailor';
    last_message: string | null;
    last_at: string | null;
    unread_count: 0;
    historyAvailable: boolean;
}

export interface PrivateMessagePilotThread {
    messages: PrivateMessagePilotMessage[];
    permissions: NativePrivateMessageBlockStatus;
    unresolvedCount: number;
    pendingAttemptId: string | null;
}

export interface NativePrivateMessageBlockStatus {
    peerAccountId: string;
    blockedByMe: boolean;
    blockedEitherDirection: boolean;
    /** Snapshot hint only; native dispatch atomically rechecks durable policy. */
    canSend: boolean;
    reason: null | 'unavailable';
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
    }): Promise<NativePrivateMessageResult<NativePrivateMessageInboxEntry[]>>;
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
    /** Retry only this already prepared native attempt; no caller plaintext. */
    retryPending(request: {
        authority: NativePrivateMessageAuthority;
        peerAccountId: string;
        clientMessageId: string;
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

export type PrivateMessagePilotEvent = PrivateMessagePilotResult<PrivateMessagePilotMessage> | { status: 'ready' };

export interface PrivateMessagePilotRuntime {
    readonly kind: 'native-pilot';
    getInbox(scope: AuthIdentityScope): Promise<PrivateMessagePilotResult<PrivateMessagePilotConversation[]>>;
    getThread(
        scope: AuthIdentityScope,
        peerAccountId: string,
    ): Promise<PrivateMessagePilotResult<PrivateMessagePilotThread>>;
    sendText(
        scope: AuthIdentityScope,
        peerAccountId: string,
        clientMessageId: string,
        text: string,
    ): Promise<PrivateMessagePilotResult<PrivateMessagePilotMessage>>;
    retryPending(
        scope: AuthIdentityScope,
        peerAccountId: string,
        clientMessageId: string,
    ): Promise<PrivateMessagePilotResult<PrivateMessagePilotMessage>>;
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
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const validMillis = (value: unknown): value is number | null =>
    value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const renderTime = (value: number | null): string | null => {
    if (value === null) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const validDelivery = (value: unknown): value is NativePrivateTextMessage['delivery'] =>
    value === 'pending' || value === 'server_accepted' || value === 'rejected' || value === 'received';
const validMessageReason = (value: unknown): value is NativePrivateTextMessage['reason'] =>
    value === null || value === 'blocked' || value === 'device-revoked' || value === 'record-conflict';
const validNativeRowId = (
    value: unknown,
    direction: NativePrivateTextMessage['direction'],
    clientMessageId: string,
): value is NativePrivateTextMessage['id'] => typeof value === 'string' && value === `${direction}:${clientMessageId}`;
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
function validPermissions(value: unknown): value is NativePrivateMessageBlockStatus {
    return (
        record(value) &&
        validId(value.peerAccountId) &&
        typeof value.blockedByMe === 'boolean' &&
        typeof value.blockedEitherDirection === 'boolean' &&
        typeof value.canSend === 'boolean' &&
        (value.reason === null || value.reason === 'unavailable') &&
        (!value.blockedByMe || value.blockedEitherDirection) &&
        !(value.canSend && (value.blockedEitherDirection || value.reason !== null)) &&
        (value.canSend || value.reason === 'unavailable') &&
        hasOnlyKeys(value, ['peerAccountId', 'blockedByMe', 'blockedEitherDirection', 'canSend', 'reason'])
    );
}
function mapMessage(value: unknown, accountId: string, peerAccountId?: string): PrivateMessagePilotMessage | null {
    if (
        !record(value) ||
        !validId(value.clientMessageId) ||
        (value.direction !== 'outgoing' && value.direction !== 'incoming') ||
        !validNativeRowId(value.id, value.direction, value.clientMessageId) ||
        !validId(value.senderAccountId) ||
        !validId(value.recipientAccountId) ||
        value.senderAccountId === value.recipientAccountId ||
        value.senderName !== (value.direction === 'outgoing' ? 'You' : 'Paired sailor') ||
        !(value.text === null || isPrivateMessagePilotText(value.text)) ||
        !validMillis(value.localCreatedAtMillis) ||
        value.read !== false ||
        !validDelivery(value.delivery) ||
        !validMessageReason(value.reason) ||
        (value.delivery === 'rejected' && value.reason === null) ||
        (value.delivery !== 'rejected' && value.reason !== null) ||
        (value.direction === 'outgoing'
            ? value.senderAccountId !== accountId || value.delivery === 'received'
            : value.recipientAccountId !== accountId ||
              value.delivery !== 'received' ||
              value.localCreatedAtMillis !== null) ||
        !(value.senderAccountId === accountId || value.recipientAccountId === accountId) ||
        (peerAccountId && !(value.senderAccountId === peerAccountId || value.recipientAccountId === peerAccountId)) ||
        !hasOnlyKeys(value, [
            'id',
            'clientMessageId',
            'direction',
            'senderAccountId',
            'recipientAccountId',
            'senderName',
            'text',
            'localCreatedAtMillis',
            'read',
            'delivery',
            'reason',
        ])
    )
        return null;
    return {
        kind: 'native-pilot',
        id: value.id,
        clientMessageId: value.clientMessageId,
        direction: value.direction,
        sender_id: value.senderAccountId,
        recipient_id: value.recipientAccountId,
        sender_name: value.direction === 'outgoing' ? 'You' : 'Paired sailor',
        message: value.text,
        read: false,
        created_at: renderTime(value.localCreatedAtMillis),
        localCreatedAtMillis: value.localCreatedAtMillis,
        delivery: value.delivery,
        reason: value.reason,
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
                        validId(item.peerAccountId) &&
                        item.peerAccountId !== scope.userId &&
                        item.displayName === 'Paired sailor' &&
                        (item.lastText === null || isPrivateMessagePilotText(item.lastText)) &&
                        validMillis(item.lastLocalCreatedAtMillis) &&
                        item.unreadCount === 0 &&
                        typeof item.historyAvailable === 'boolean' &&
                        (item.historyAvailable || (item.lastText === null && item.lastLocalCreatedAtMillis === null)) &&
                        hasOnlyKeys(item, [
                            'peerAccountId',
                            'displayName',
                            'lastText',
                            'lastLocalCreatedAtMillis',
                            'unreadCount',
                            'historyAvailable',
                        ]),
                )
            )
                return unavailable();
            return {
                status: 'ok',
                value: result.value.map<PrivateMessagePilotConversation>((item) => ({
                    kind: 'native-pilot',
                    user_id: item.peerAccountId,
                    display_name: item.displayName,
                    last_message: item.lastText,
                    last_at: renderTime(item.lastLocalCreatedAtMillis),
                    unread_count: item.unreadCount,
                    historyAvailable: item.historyAvailable,
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
                !validPermissions(value.permissions) ||
                value.permissions.peerAccountId !== peerAccountId ||
                !Array.isArray(value.messages) ||
                value.messages.length > 32 ||
                !Number.isSafeInteger(value.unresolvedCount) ||
                typeof value.unresolvedCount !== 'number' ||
                value.unresolvedCount < 0 ||
                value.unresolvedCount > 16 ||
                !(value.pendingAttemptId === null || validId(value.pendingAttemptId)) ||
                !hasOnlyKeys(value, ['peerAccountId', 'messages', 'permissions', 'unresolvedCount', 'pendingAttemptId'])
            )
                return unavailable();
            const messages: PrivateMessagePilotMessage[] = [];
            for (const item of value.messages) {
                const mapped = mapMessage(item, scope.userId!, peerAccountId);
                if (!mapped || messages.some((message) => message.id === mapped.id)) return unavailable();
                messages.push(mapped);
            }
            const outgoing = messages.filter((message) => message.direction === 'outgoing');
            const incoming = messages.filter((message) => message.direction === 'incoming');
            const pending = outgoing.filter((message) => message.delivery === 'pending');
            if (
                outgoing.length > 16 ||
                incoming.length > 16 ||
                pending.length > 1 ||
                value.pendingAttemptId !== (pending[0]?.clientMessageId ?? null)
            )
                return unavailable();
            return {
                status: 'ok',
                value: {
                    messages,
                    permissions: { ...value.permissions },
                    unresolvedCount: value.unresolvedCount,
                    pendingAttemptId: value.pendingAttemptId,
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
                message.direction === 'outgoing' &&
                message.clientMessageId === clientMessageId &&
                message.sender_id === scope.userId &&
                message.message === text
                ? { status: 'ok', value: message }
                : unavailable();
        },
        async retryPending(scope, peerAccountId, clientMessageId) {
            const failure = peerFailure(scope, peerAccountId);
            if (failure) return failure;
            if (!validId(clientMessageId)) return unavailable('unsupported_content');
            const result = await invoke(scope, (authority) =>
                port.retryPending({ authority, peerAccountId, clientMessageId }),
            );
            if (result.status !== 'ok') return result;
            const message = mapMessage(result.value, scope.userId!, peerAccountId);
            return message &&
                message.direction === 'outgoing' &&
                message.clientMessageId === clientMessageId &&
                message.sender_id === scope.userId
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
            const latestEvents = new Map<
                string,
                {
                    sequence: number;
                    message: PrivateMessagePilotMessage;
                    knownText: string | null;
                    knownLocalCreatedAtMillis: number | null;
                    knownTerminalDelivery: PrivateMessagePilotMessage['delivery'] | null;
                    knownReason: PrivateMessagePilotMessage['reason'];
                }
            >();
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
                        const previous = latestEvents.get(message.id);
                        const prior = previous?.message;
                        if (
                            previous &&
                            prior &&
                            (prior.sender_id !== message.sender_id ||
                                prior.recipient_id !== message.recipient_id ||
                                prior.clientMessageId !== message.clientMessageId ||
                                prior.direction !== message.direction ||
                                (previous.knownText !== null &&
                                    message.message !== null &&
                                    previous.knownText !== message.message) ||
                                (previous.knownLocalCreatedAtMillis !== null &&
                                    message.localCreatedAtMillis !== null &&
                                    previous.knownLocalCreatedAtMillis !== message.localCreatedAtMillis) ||
                                (previous.knownTerminalDelivery !== null &&
                                    message.delivery !== 'pending' &&
                                    previous.knownTerminalDelivery !== message.delivery) ||
                                (previous.knownReason !== null &&
                                    message.reason !== null &&
                                    previous.knownReason !== message.reason))
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
                        // Nullable rendering cannot erase already observed row
                        // facts. Keep only bounded volatile facts, never fill an
                        // unknown display field from old plaintext or JS input.
                        latestEvents.set(message.id, {
                            sequence,
                            message,
                            knownText: message.message ?? previous?.knownText ?? null,
                            knownLocalCreatedAtMillis:
                                message.localCreatedAtMillis ?? previous?.knownLocalCreatedAtMillis ?? null,
                            knownTerminalDelivery:
                                message.delivery === 'pending'
                                    ? (previous?.knownTerminalDelivery ?? null)
                                    : message.delivery,
                            knownReason: message.reason ?? previous?.knownReason ?? null,
                        });
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
