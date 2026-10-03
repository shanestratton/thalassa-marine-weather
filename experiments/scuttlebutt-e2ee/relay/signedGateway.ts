/**
 * Unwired research device-authorized gateway. Auth and SQL adapters are server-only.
 * The existing account-only gateway is used internally for signed bundle registration.
 * The SQL execution adapter must enforce device state and commit before resolving.
 */
import type {
    EncryptedDmAcceptance,
    EncryptedDmOutboxRecord,
    EncryptedDmRejection,
} from '../../../services/chat/e2ee/encryptedDmDelivery.ts';
import {
    createResearchGateway,
    ResearchGatewayError,
    type ResearchGatewayDependencies,
    type ResearchRpc,
} from './gateway.ts';
import {
    parseResearchSendPayload,
    parseResearchSignedRequest,
    verifyResearchRequestSignature,
    type ResearchSignedRequest,
} from './signedRequest.ts';

export type ResearchSignedRpc = ResearchRpc | 'lookup_request_key' | 'execute_request';
export interface ResearchSignedGatewayDependencies {
    /** Validate every credential afresh with Auth; the body user ID grants no authority. */
    authenticate: ResearchGatewayDependencies['authenticate'];
    /** Resolve only after database commit. Throws leave the operation unresolved. */
    rpc(name: ResearchSignedRpc, args: readonly unknown[]): Promise<unknown>;
    nowSeconds(): number;
}
/** Current registered-device facts, not a cached enrollment receipt or send grant. */
export interface ResearchPolicyStatus {
    readonly requestId: string;
    readonly ownerUserId: string;
    readonly ownerDeviceId: string;
    readonly peerUserId: string;
    readonly peerDeviceId: string;
    readonly peerIdentityKeyId: string;
    readonly ownerRevoked: boolean;
    readonly peerRevoked: boolean;
    readonly blockedByMe: boolean;
    readonly blockedByPeer: boolean;
}
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const POLICY_BINDING_FIELDS = [
    'requestId',
    'ownerUserId',
    'ownerDeviceId',
    'peerUserId',
    'peerDeviceId',
    'peerIdentityKeyId',
];
const POLICY_FLAG_FIELDS = ['ownerRevoked', 'peerRevoked', 'blockedByMe', 'blockedByPeer'];
const RECORD_FIELDS = [
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
function readFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key)))
        return fail();
    const copy: Record<string, unknown> = {};
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail();
        copy[field] = descriptor.value;
    }
    return copy;
}
function sendReceipt(
    value: unknown,
    record: EncryptedDmOutboxRecord,
): Readonly<EncryptedDmAcceptance | EncryptedDmRejection> {
    // Inspect the acceptance descriptor before choosing the exact allowed fields.
    if (!value || typeof value !== 'object') return fail();
    const accepted = Object.getOwnPropertyDescriptor(value, 'accepted');
    if (!accepted || !Object.hasOwn(accepted, 'value') || typeof accepted.value !== 'boolean') return fail();
    const receipt = readFields(value, [...RECORD_FIELDS, 'accepted', ...(accepted.value ? [] : ['reason'])]);
    if (!accepted.value && !['blocked', 'device-revoked', 'record-conflict'].includes(receipt.reason as string))
        return fail();
    if (!RECORD_FIELDS.every((key) => receipt[key] === (record as unknown as Record<string, unknown>)[key]))
        return fail();
    return Object.freeze(receipt) as unknown as Readonly<EncryptedDmAcceptance | EncryptedDmRejection>;
}
function policyStatus(value: unknown, request: ResearchSignedRequest): Readonly<ResearchPolicyStatus> {
    const receipt = readFields(value, [...POLICY_BINDING_FIELDS, ...POLICY_FLAG_FIELDS]);
    const [peerUserId, peerDeviceId, peerIdentityKeyId] = JSON.parse(request.payload) as string[];
    const binding = {
        requestId: request.requestId,
        ownerUserId: request.userId,
        ownerDeviceId: request.deviceId,
        peerUserId,
        peerDeviceId,
        peerIdentityKeyId,
    };
    if (
        !POLICY_BINDING_FIELDS.every((field) => receipt[field] === binding[field as keyof typeof binding]) ||
        !POLICY_FLAG_FIELDS.every((field) => typeof receipt[field] === 'boolean')
    )
        return fail();
    return Object.freeze(receipt) as unknown as Readonly<ResearchPolicyStatus>;
}

export function createResearchSignedGateway(deps: ResearchSignedGatewayDependencies) {
    const registration = createResearchGateway({
        authenticate: (credential) => deps.authenticate(credential),
        rpc: (name, args) => deps.rpc(name, args),
        nowSeconds: () => deps.nowSeconds(),
    });
    async function guarded(operation: () => Promise<unknown>): Promise<unknown> {
        try {
            return await operation();
        } catch {
            return fail();
        }
    }
    return Object.freeze({
        register(credential: string, serializedBundle: string): Promise<unknown> {
            return registration.register(credential, serializedBundle);
        },
        dispatch(credential: string, serializedRequest: string): Promise<unknown> {
            return guarded(async () => {
                if (typeof credential !== 'string' || !credential.length || credential.length > 8192) return fail();
                const principal = readFields(await deps.authenticate(credential), ['userId']);
                if (typeof principal.userId !== 'string' || ID.exec(principal.userId)?.[0] !== principal.userId)
                    return fail();
                const actor = principal.userId;
                const request = parseResearchSignedRequest(serializedRequest, actor, deps.nowSeconds());
                const lookup = readFields(await deps.rpc('lookup_request_key', [actor, request.deviceId]), [
                    'signingKey',
                ]);
                if (typeof lookup.signingKey !== 'string') return fail();
                await verifyResearchRequestSignature(request, lookup.signingKey);
                // A slow key lookup or verifier must not dispatch a now-expired request.
                parseResearchSignedRequest(serializedRequest, actor, deps.nowSeconds());
                const result = await deps.rpc('execute_request', [
                    actor,
                    request.deviceId,
                    request.requestId,
                    request.action,
                    request.payload,
                    request.expiresAt,
                    serializedRequest,
                ]);
                if (request.action === 'send')
                    return sendReceipt(result, parseResearchSendPayload(request.payload, actor, request.deviceId));
                if (request.action === 'policy') return policyStatus(result, request);
                return result;
            });
        },
    });
}
