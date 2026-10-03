import { decodeDirectMessageEnvelope, encodeDirectMessageEnvelope } from './directMessageEnvelope.ts';

/**
 * Isolated delivery prototype, NOT live E2EE or a crypto/storage implementation.
 *
 * REQUIRED EXTERNAL CONTRACTS, NOT GUARANTEES PROVIDED HERE:
 * - A reviewed native provider must atomically persist ratchet advancement and
 *   this exact, immutable ciphertext outbox record BEFORE calling deliver.
 * - Native owner/device session generations must persist across process restart
 *   and change on logout, revocation, account or device changes. Persist the
 *   generation when preparing each record and never rewrite it. Pending sends
 *   may survive restart only in that SAME durable session generation; relogin
 *   cannot rebind old ciphertext. Terminal rejection cleanup may use the current
 *   matching owner/device session independently of the record's old generation.
 *   Peer identity acceptance/revocation/blocking must come from authenticated
 *   local state. Persist its monotonic generation in the record at preparation;
 *   increment it on every trust, blocking or device-membership change. Never
 *   rebind an existing queued record to a later generation.
 * - Transport must bind credentials to guard.session and check the guard at
 *   actual dispatch. The server must enforce ownership, blocking, device state
 *   and RLS; client comparisons do not enforce any of those server policies.
 * - Server acceptance must atomically deduplicate (owner, sender device, client
 *   message, recipient device), accepting a retry only when routing AND exact
 *   envelope bytes match the original. A conflicting body must be rejected.
 *   Terminal rejection decisions must also be durable and immutable for that
 *   record: retry after unblock or a client crash must not change rejection to
 *   acceptance. Only authenticated responses may resolve send with a rejection;
 *   exceptions, HTTP failures and aborted requests are not terminal decisions.
 * - Native confirmation must compare the exact durable record and guard context
 *   atomically at commit, leave it pending on failure, and be idempotent. A
 *   callback check before an asynchronous native write is insufficient. Native
 *   rejection confirmation must atomically cancel the exact outbox item under
 *   its owner guard, even if the recipient is now blocked or revoked. Once
 *   cancelled, native storage must never enumerate it as pending again.
 * - The in-memory rejection cache only prevents repeat upload in this instance.
 *   Native persistence and permanent server decisions must bridge crashes and
 *   multiple instances; this module cannot atomically persist network receipt.
 *
 * These interfaces intentionally have no plaintext, encryption or replacement
 * ciphertext callback. A frame passing validation is not proof of encryption.
 */
export interface EncryptedDmOutboxRecord {
    readonly ownerUserId: string;
    /** Durable owner/device session generation captured at preparation. */
    readonly ownerSessionGeneration: number;
    readonly recipientUserId: string;
    /** Public identity reference accepted when this ciphertext was prepared. */
    readonly recipientIdentityKeyId: string;
    /** Durable trust/blocking generation captured at preparation, never at retry. */
    readonly recipientIdentityGeneration: number;
    /** Canonical encodeDirectMessageEnvelope output, retained byte for byte. */
    readonly serializedEnvelope: string;
}

export interface EncryptedDmDeliverySession {
    readonly userId: string;
    readonly senderDeviceId: string;
    readonly generation: number;
}

export interface EncryptedDmPeerIdentity {
    readonly identityKeyId: string;
    readonly generation: number;
    /** `accepted` can represent explicit first-use trust, not fingerprint verification. */
    readonly status: 'accepted' | 'changed' | 'revoked' | 'blocked';
}

/** Owner-scoped guard for persisting a terminal refusal, independent of peer trust. */
export interface EncryptedDmOutboxGuard {
    readonly session: EncryptedDmDeliverySession;
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
}

export interface EncryptedDmDeliveryGuard extends EncryptedDmOutboxGuard {
    readonly recipientIdentityGeneration: number;
    /** Also requires matching live peer trust; check at dispatch/commit, not just entry. */
    readonly isCurrent: () => boolean;
}

/** Echoing the exact record avoids treating an ID-only collision as acceptance. */
export interface EncryptedDmAcceptance extends EncryptedDmOutboxRecord {
    readonly accepted: true;
}

export type EncryptedDmRejectionReason = 'blocked' | 'device-revoked' | 'record-conflict';

export interface EncryptedDmRejection extends EncryptedDmOutboxRecord {
    readonly accepted: false;
    readonly reason: EncryptedDmRejectionReason;
}

export interface EncryptedDmDeliveryDependencies {
    getCurrentSession(): EncryptedDmDeliverySession | null;
    getPeerIdentity(recipientUserId: string, recipientDeviceId: string): EncryptedDmPeerIdentity | null;
    send(record: EncryptedDmOutboxRecord, guard: EncryptedDmDeliveryGuard): Promise<unknown>;
    /** Confirms server acceptance only; this is NOT recipient delivery or reading. */
    confirmServerAcceptance(record: EncryptedDmOutboxRecord, guard: EncryptedDmDeliveryGuard): Promise<boolean>;
    /** Atomically cancels the exact native record; false/throw leaves cancellation unresolved. */
    confirmServerRejection(
        record: EncryptedDmOutboxRecord,
        reason: EncryptedDmRejectionReason,
        guard: EncryptedDmOutboxGuard,
    ): Promise<boolean>;
}

export type EncryptedDmDeliveryResult =
    | 'accepted'
    | 'rejected'
    | 'rejection-pending'
    | 'invalid-record'
    | 'blocked'
    | 'busy'
    | 'invalid-acknowledgement'
    | 'retryable-failure'
    | 'timed-out';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const RECORD_FIELDS = [
    'ownerUserId',
    'ownerSessionGeneration',
    'recipientUserId',
    'recipientIdentityKeyId',
    'recipientIdentityGeneration',
    'serializedEnvelope',
];
const SESSION_FIELDS = ['userId', 'senderDeviceId', 'generation'];

/** Reject hidden/accessor/symbol fields as well as enumerable plaintext extras. */
function hasExactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    return (
        keys.length === fields.length &&
        keys.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return typeof key === 'string' && fields.includes(key) && !!descriptor && 'value' in descriptor;
        })
    );
}

function isIdentifier(value: unknown): value is string {
    // JavaScript's $ can match before a final line terminator; require the whole ID.
    return typeof value === 'string' && IDENTIFIER.exec(value)?.[0] === value;
}

function copySession(value: unknown): EncryptedDmDeliverySession | null {
    if (
        !hasExactDataFields(value, SESSION_FIELDS) ||
        !isIdentifier(value.userId) ||
        !isIdentifier(value.senderDeviceId) ||
        !Number.isSafeInteger(value.generation) ||
        (value.generation as number) < 0
    ) {
        return null;
    }
    return Object.freeze({
        userId: value.userId,
        senderDeviceId: value.senderDeviceId,
        generation: value.generation as number,
    });
}

function copyRecord(value: unknown): EncryptedDmOutboxRecord | null {
    if (
        !hasExactDataFields(value, RECORD_FIELDS) ||
        !isIdentifier(value.ownerUserId) ||
        !Number.isSafeInteger(value.ownerSessionGeneration) ||
        (value.ownerSessionGeneration as number) < 0 ||
        !isIdentifier(value.recipientUserId) ||
        !isIdentifier(value.recipientIdentityKeyId) ||
        !Number.isSafeInteger(value.recipientIdentityGeneration) ||
        (value.recipientIdentityGeneration as number) < 0 ||
        typeof value.serializedEnvelope !== 'string'
    ) {
        return null;
    }
    const envelope = decodeDirectMessageEnvelope(value.serializedEnvelope);
    // Canonical framing rejects duplicate JSON keys hiding plaintext or routing
    // values that different parsers could interpret differently. Never rewrite.
    if (encodeDirectMessageEnvelope(envelope) !== value.serializedEnvelope) return null;
    return Object.freeze({
        ownerUserId: value.ownerUserId,
        ownerSessionGeneration: value.ownerSessionGeneration as number,
        recipientUserId: value.recipientUserId,
        recipientIdentityKeyId: value.recipientIdentityKeyId,
        recipientIdentityGeneration: value.recipientIdentityGeneration as number,
        serializedEnvelope: value.serializedEnvelope,
    });
}

function matchesRecord(value: Record<string, unknown>, record: EncryptedDmOutboxRecord): boolean {
    return RECORD_FIELDS.every((field) => value[field] === record[field as keyof EncryptedDmOutboxRecord]);
}

function matchesAcknowledgement(value: unknown, record: EncryptedDmOutboxRecord): boolean {
    return (
        hasExactDataFields(value, [...RECORD_FIELDS, 'accepted']) &&
        value.accepted === true &&
        matchesRecord(value, record)
    );
}

function rejectionReason(value: unknown, record: EncryptedDmOutboxRecord): EncryptedDmRejectionReason | null {
    if (
        !hasExactDataFields(value, [...RECORD_FIELDS, 'accepted', 'reason']) ||
        value.accepted !== false ||
        !matchesRecord(value, record)
    ) {
        return null;
    }
    return value.reason === 'blocked' || value.reason === 'device-revoked' || value.reason === 'record-conflict'
        ? value.reason
        : null;
}

/**
 * One coordinator serializes in-flight attempts for each server idempotency key.
 * Different coordinator instances/processes require native/server concurrency
 * enforcement. A timeout cannot retract an already accepted network request.
 */
export function createEncryptedDmDeliveryCoordinator(
    dependencies: EncryptedDmDeliveryDependencies,
    timeoutMs = 20_000,
) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
        throw new Error('Invalid encrypted direct-message delivery timeout');
    }
    const inFlight = new Set<string>();
    // Retained for this instance's lifetime: a pending/confirmed terminal refusal
    // must never cause another send. Production retention belongs in native storage.
    const rejections = new Map<string, EncryptedDmRejectionReason>();

    return {
        async deliver(
            recordInput: unknown,
            expectedSessionInput: EncryptedDmDeliverySession,
        ): Promise<EncryptedDmDeliveryResult> {
            let record: EncryptedDmOutboxRecord | null;
            let session: EncryptedDmDeliverySession | null;
            try {
                record = copyRecord(recordInput);
                session = copySession(expectedSessionInput);
            } catch {
                // Neither provider errors nor invalid input may appear in logs/results.
                return 'invalid-record';
            }
            if (!record) return 'invalid-record';
            if (!session) return 'blocked';
            const envelope = decodeDirectMessageEnvelope(record.serializedEnvelope);
            const recipientIdentityGeneration = record.recipientIdentityGeneration;
            const idempotencyKey = JSON.stringify([
                record.ownerUserId,
                envelope.senderDeviceId,
                envelope.clientMessageId,
                envelope.recipientDeviceId,
            ]);
            // copyRecord fixes field order and permits only scalar data. This
            // complete immutable value binds refusal to the precise record;
            // another payload sharing the server key must retain its own outcome.
            const recordKey = JSON.stringify(record);
            const controller = new AbortController();
            const deadline = Date.now() + timeoutMs;
            let active = true;
            const isOwnerCurrent = (): boolean => {
                if (!active || controller.signal.aborted || Date.now() >= deadline) return false;
                try {
                    const current = copySession(dependencies.getCurrentSession());
                    return (
                        !!current &&
                        current.userId === session.userId &&
                        current.senderDeviceId === session.senderDeviceId &&
                        current.generation === session.generation &&
                        current.userId === record.ownerUserId &&
                        current.senderDeviceId === envelope.senderDeviceId
                    );
                } catch {
                    return false;
                }
            };
            const isCurrent = (): boolean => {
                if (!isOwnerCurrent() || session.generation !== record.ownerSessionGeneration) return false;
                try {
                    const peer = dependencies.getPeerIdentity(record.recipientUserId, envelope.recipientDeviceId);
                    return (
                        !!peer &&
                        peer.status === 'accepted' &&
                        peer.identityKeyId === record.recipientIdentityKeyId &&
                        peer.generation === recipientIdentityGeneration
                    );
                } catch {
                    return false;
                }
            };
            const priorRejection = rejections.get(recordKey);
            if (!isOwnerCurrent()) return priorRejection ? 'rejection-pending' : 'blocked';
            if (!priorRejection && !isCurrent()) return 'blocked';
            if (inFlight.has(idempotencyKey)) return 'busy';
            inFlight.add(idempotencyKey);
            const guard: EncryptedDmDeliveryGuard = Object.freeze({
                session,
                recipientIdentityGeneration,
                signal: controller.signal,
                isCurrent,
            });
            const rejectionGuard: EncryptedDmOutboxGuard = Object.freeze({
                session,
                signal: controller.signal,
                isCurrent: isOwnerCurrent,
            });
            const cachedRejectionReason = () => rejections.get(recordKey);
            let observedReason = priorRejection;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<EncryptedDmDeliveryResult>((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve(observedReason || cachedRejectionReason() ? 'rejection-pending' : 'timed-out');
                }, timeoutMs);
            });
            const attempt = async (): Promise<EncryptedDmDeliveryResult> => {
                try {
                    let reason = observedReason;
                    if (!reason) {
                        const acknowledgement = await dependencies.send(record, guard);
                        const serverReason = rejectionReason(acknowledgement, record) ?? cachedRejectionReason();
                        if (serverReason) {
                            // Preserve an authenticated refusal even after timeout/account
                            // change. Its old guard cannot commit, but it cannot be resent.
                            reason = serverReason;
                            observedReason = reason;
                            rejections.set(recordKey, reason);
                        } else {
                            if (!guard.isCurrent()) return 'blocked';
                            if (!matchesAcknowledgement(acknowledgement, record)) return 'invalid-acknowledgement';
                            const confirmed = await dependencies.confirmServerAcceptance(record, guard);
                            if (!guard.isCurrent()) return 'blocked';
                            return confirmed === true ? 'accepted' : 'retryable-failure';
                        }
                    }
                    if (!rejectionGuard.isCurrent()) return 'rejection-pending';
                    const confirmed = await dependencies.confirmServerRejection(record, reason, rejectionGuard);
                    if (!rejectionGuard.isCurrent()) return 'rejection-pending';
                    return confirmed === true ? 'rejected' : 'rejection-pending';
                } catch {
                    if (observedReason || cachedRejectionReason()) return 'rejection-pending';
                    return guard.isCurrent() ? 'retryable-failure' : 'blocked';
                }
            };
            try {
                return await Promise.race([attempt(), timeout]);
            } finally {
                active = false;
                controller.abort();
                if (timer !== undefined) clearTimeout(timer);
                inFlight.delete(idempotencyKey);
            }
        },
    };
}
