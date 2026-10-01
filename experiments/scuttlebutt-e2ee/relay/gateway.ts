/**
 * Unwired research boundary, NOT an HTTP endpoint or Supabase auth integration.
 * The host must verify credentials afresh and keep the gateway SQL role secret.
 * Account authorization is not proof a request came from its registered device.
 * Device-signed requests, rate limits, JWT integration and key transparency remain gates.
 */
import {
    decodeDirectMessageEnvelope,
    encodeDirectMessageEnvelope,
} from '../../../services/chat/e2ee/directMessageEnvelope.ts';
import type { EncryptedDmOutboxRecord } from '../../../services/chat/e2ee/encryptedDmDelivery.ts';
import { parseAndVerifyDeviceBundle } from './deviceBundle.ts';

export type ResearchRpc =
    | 'register_device'
    | 'revoke_device'
    | 'set_block'
    | 'claim_prekey'
    | 'send_message'
    | 'list_messages';
export interface ResearchGatewayDependencies {
    /** Server-only adapter: validate the credential with Auth; never trust a body user ID. */
    authenticate(credential: string): Promise<{ userId: string } | null>;
    /** Must resolve only AFTER transaction commit, never return a receipt on failure. */
    rpc(name: ResearchRpc, args: readonly unknown[]): Promise<unknown>;
    nowSeconds(): number;
}

export class ResearchGatewayError extends Error {
    constructor() {
        super('Research encrypted-message request unavailable');
        this.name = 'ResearchGatewayError';
    }
}
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const fields = [
    'ownerUserId',
    'ownerSessionGeneration',
    'recipientUserId',
    'recipientIdentityKeyId',
    'recipientIdentityGeneration',
    'serializedEnvelope',
];
const fail = (): never => {
    throw new ResearchGatewayError();
};
const identifier = (value: unknown): value is string => typeof value === 'string' && ID.exec(value)?.[0] === value;
const generation = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    return (
        keys.length === names.length &&
        keys.every(
            (k) =>
                typeof k === 'string' &&
                names.includes(k) &&
                Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, 'value'),
        )
    );
}

/** Exact wire order; only the immutable ciphertext record crosses this boundary. */
export function encodeResearchOutbox(record: EncryptedDmOutboxRecord): string {
    if (
        !exact(record, fields) ||
        !identifier(record.ownerUserId) ||
        !identifier(record.recipientUserId) ||
        record.ownerUserId === record.recipientUserId ||
        !identifier(record.recipientIdentityKeyId) ||
        !generation(record.ownerSessionGeneration) ||
        !generation(record.recipientIdentityGeneration) ||
        typeof record.serializedEnvelope !== 'string'
    )
        return fail();
    let envelope;
    try {
        envelope = decodeDirectMessageEnvelope(record.serializedEnvelope);
    } catch {
        return fail();
    }
    if (
        encodeDirectMessageEnvelope(envelope) !== record.serializedEnvelope ||
        ![envelope.clientMessageId, envelope.senderDeviceId, envelope.recipientDeviceId].every(identifier) ||
        envelope.senderDeviceId === envelope.recipientDeviceId
    )
        return fail();
    return JSON.stringify({
        ownerUserId: record.ownerUserId,
        ownerSessionGeneration: record.ownerSessionGeneration,
        recipientUserId: record.recipientUserId,
        recipientIdentityKeyId: record.recipientIdentityKeyId,
        recipientIdentityGeneration: record.recipientIdentityGeneration,
        serializedEnvelope: record.serializedEnvelope,
    });
}
function parseOutbox(serialized: unknown): EncryptedDmOutboxRecord {
    if (typeof serialized !== 'string' || serialized.length > 100_000 || /[^\x20-\x7e]/.test(serialized)) return fail();
    try {
        const value = JSON.parse(serialized);
        if (encodeResearchOutbox(value) !== serialized) return fail();
        return Object.freeze(value);
    } catch {
        return fail();
    }
}

export function createResearchGateway(deps: ResearchGatewayDependencies) {
    async function actor(credential: string): Promise<string> {
        if (typeof credential !== 'string' || !credential.length || credential.length > 8192) return fail();
        const principal = await deps.authenticate(credential);
        if (!exact(principal, ['userId']) || !identifier(principal.userId)) return fail();
        return principal.userId;
    }
    // Deliberately discard SQL/Auth/crypto error details: no credentials, key material
    // or ciphertext should be copied into logs, UI strings or terminal receipts.
    async function guarded<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch {
            return fail();
        }
    }
    return Object.freeze({
        register(credential: string, serialized: string) {
            return guarded(async () => {
                const user = await actor(credential);
                await parseAndVerifyDeviceBundle(serialized, user, deps.nowSeconds());
                return deps.rpc('register_device', [user, serialized]);
            });
        },
        revoke(credential: string, device: string) {
            return guarded(async () => {
                if (!identifier(device)) return fail();
                return deps.rpc('revoke_device', [await actor(credential), device]);
            });
        },
        block(credential: string, other: string, blocked: boolean) {
            return guarded(async () => {
                if (!identifier(other) || typeof blocked !== 'boolean') return fail();
                const user = await actor(credential);
                if (other === user) return fail();
                return deps.rpc('set_block', [user, other, blocked]);
            });
        },
        claim(credential: string, device: string, targetUser: string, targetDevice: string, requestId: string) {
            return guarded(async () => {
                if (![device, targetUser, targetDevice, requestId].every(identifier)) return fail();
                const user = await actor(credential);
                if (targetUser === user || device === targetDevice) return fail();
                return deps.rpc('claim_prekey', [user, device, targetUser, targetDevice, requestId]);
            });
        },
        send(credential: string, serializedRecord: string) {
            return guarded(async () => {
                // Parse/copy BEFORE awaiting authentication, not a caller-mutable object.
                const record = parseOutbox(serializedRecord);
                const user = await actor(credential);
                if (record.ownerUserId !== user) return fail();
                const result = await deps.rpc('send_message', [user, record]);
                if (!result || typeof result !== 'object') return fail();
                const receipt = result as Record<string, unknown>;
                const accepted = Object.getOwnPropertyDescriptor(receipt, 'accepted');
                if (!accepted || !Object.hasOwn(accepted, 'value')) return fail();
                if (accepted.value === true) {
                    if (!exact(receipt, [...fields, 'accepted'])) return fail();
                } else if (accepted.value === false) {
                    if (
                        !exact(receipt, [...fields, 'accepted', 'reason']) ||
                        !['blocked', 'device-revoked', 'record-conflict'].includes(receipt.reason as string)
                    )
                        return fail();
                } else return fail();
                if (!fields.every((key) => receipt[key] === (record as unknown as Record<string, unknown>)[key]))
                    return fail();
                return Object.freeze(receipt);
            });
        },
        list(credential: string, device: string, afterId = 0, batch = 16) {
            return guarded(async () => {
                if (!identifier(device) || !generation(afterId) || !Number.isInteger(batch) || batch < 1 || batch > 16)
                    return fail();
                return deps.rpc('list_messages', [await actor(credential), device, afterId, batch]);
            });
        },
    });
}
