/** Research-only framing for device-authorized requests. No account or key mutation. */
import { decodeDirectMessageEnvelope } from '../../../services/chat/e2ee/directMessageEnvelope.ts';
import type { EncryptedDmOutboxRecord } from '../../../services/chat/e2ee/encryptedDmDelivery.ts';
import { encodeResearchOutbox, ResearchGatewayError } from './gateway.ts';

export const RESEARCH_REQUEST_VERSION = 1 as const;
export const RESEARCH_REQUEST_PROTOCOL = 'olm-v1' as const;
export const MAX_RESEARCH_REQUEST_BYTES = 100 * 1024;
export const MAX_RESEARCH_REQUEST_AGE_SECONDS = 300;
export type ResearchRequestAction =
    | 'revoke'
    | 'block'
    | 'claim'
    | 'send'
    | 'list'
    | 'policy'
    | 'require-protected'
    | 'account-mode';

export interface UnsignedResearchRequest {
    readonly version: typeof RESEARCH_REQUEST_VERSION;
    readonly protocol: typeof RESEARCH_REQUEST_PROTOCOL;
    readonly userId: string;
    readonly deviceId: string;
    readonly action: ResearchRequestAction;
    readonly requestId: string;
    /** Integer Unix seconds, checked against trusted time when received. */
    readonly expiresAt: number;
    /** Exact canonical action payload bytes, retained as a string. */
    readonly payload: string;
}
export interface ResearchSignedRequest extends UnsignedResearchRequest {
    /** Canonical unpadded standard Base64 of a 64-byte Ed25519 signature. */
    readonly signature: string;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64 = /^[A-Za-z0-9+/]+$/;
const NON_ASCII = /[^\x20-\x7e]/;
const UNSIGNED_FIELDS = ['version', 'protocol', 'userId', 'deviceId', 'action', 'requestId', 'expiresAt', 'payload'];
const SIGNED_FIELDS = [...UNSIGNED_FIELDS, 'signature'];
const ACTIONS: readonly unknown[] = [
    'revoke',
    'block',
    'claim',
    'send',
    'list',
    'policy',
    'require-protected',
    'account-mode',
];
const fail = (): never => {
    throw new ResearchGatewayError();
};

function identifier(value: unknown): value is string {
    // JavaScript's $ also matches before a final newline; require the whole ID.
    return typeof value === 'string' && ID.exec(value)?.[0] === value;
}
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
function wire(value: unknown): value is string {
    // Printable ASCII means the character and UTF-8 byte counts are identical.
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_RESEARCH_REQUEST_BYTES &&
        !NON_ASCII.test(value)
    );
}
function base64Bytes(value: unknown, length: 32 | 64): Uint8Array<ArrayBuffer> {
    const chars = length === 32 ? 43 : 86;
    if (typeof value !== 'string' || value.length !== chars || !BASE64.test(value)) return fail();
    const binary = atob(value + (length === 32 ? '=' : '=='));
    if (binary.length !== length || btoa(binary).replace(/=+$/, '') !== value) return fail();
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Parse the immutable canonical outbox and bind both user and sender device. */
export function parseResearchSendPayload(
    payload: string,
    userId: string,
    deviceId: string,
): Readonly<EncryptedDmOutboxRecord> {
    try {
        if (!wire(payload) || !identifier(userId) || !identifier(deviceId)) return fail();
        const record: EncryptedDmOutboxRecord = JSON.parse(payload);
        if (encodeResearchOutbox(record) !== payload || record.ownerUserId !== userId) return fail();
        const envelope = decodeDirectMessageEnvelope(record.serializedEnvelope);
        if (envelope.senderDeviceId !== deviceId || envelope.recipientDeviceId === deviceId) return fail();
        return Object.freeze(record);
    } catch {
        return fail();
    }
}

function validatePayload(action: ResearchRequestAction, payload: unknown, userId: string, deviceId: string): string {
    if (!wire(payload)) return fail();
    if (action === 'send') {
        parseResearchSendPayload(payload, userId, deviceId);
        return payload;
    }
    const parts: unknown = JSON.parse(payload);
    if (!Array.isArray(parts) || JSON.stringify(parts) !== payload) return fail();
    switch (action) {
        case 'revoke':
        case 'require-protected':
        case 'account-mode':
            if (parts.length !== 0) return fail();
            break;
        case 'block':
            if (parts.length !== 2 || !identifier(parts[0]) || parts[0] === userId || typeof parts[1] !== 'boolean')
                return fail();
            break;
        case 'claim':
        case 'policy':
            if (parts.length !== 3 || !parts.every(identifier) || parts[0] === userId || parts[1] === deviceId)
                return fail();
            break;
        case 'list':
            if (
                parts.length !== 2 ||
                typeof parts[0] !== 'number' ||
                !Number.isSafeInteger(parts[0]) ||
                parts[0] < 0 ||
                typeof parts[1] !== 'number' ||
                !Number.isInteger(parts[1]) ||
                parts[1] < 1 ||
                parts[1] > 16
            )
                return fail();
            break;
    }
    return payload;
}

function unsigned(fields: Record<string, unknown>): UnsignedResearchRequest {
    if (
        fields.version !== RESEARCH_REQUEST_VERSION ||
        fields.protocol !== RESEARCH_REQUEST_PROTOCOL ||
        !identifier(fields.userId) ||
        !identifier(fields.deviceId) ||
        !identifier(fields.requestId) ||
        !ACTIONS.includes(fields.action) ||
        typeof fields.expiresAt !== 'number' ||
        !Number.isSafeInteger(fields.expiresAt) ||
        fields.expiresAt <= 0
    )
        return fail();
    const action = fields.action as ResearchRequestAction;
    return {
        version: RESEARCH_REQUEST_VERSION,
        protocol: RESEARCH_REQUEST_PROTOCOL,
        userId: fields.userId,
        deviceId: fields.deviceId,
        action,
        requestId: fields.requestId,
        expiresAt: fields.expiresAt,
        payload: validatePayload(action, fields.payload, fields.userId, fields.deviceId),
    };
}
function signed(value: unknown): ResearchSignedRequest {
    const fields = readFields(value, SIGNED_FIELDS);
    const request = unsigned(fields);
    base64Bytes(fields.signature, 64);
    return { ...request, signature: fields.signature as string };
}
function boundedEncoded(value: object): string {
    const serialized = JSON.stringify(value);
    if (!wire(serialized)) return fail();
    return serialized;
}
function signingBytes(request: UnsignedResearchRequest): Uint8Array<ArrayBuffer> {
    const serialized = JSON.stringify([
        'thalassa-relay-request',
        RESEARCH_REQUEST_VERSION,
        RESEARCH_REQUEST_PROTOCOL,
        request.userId,
        request.deviceId,
        request.action,
        request.requestId,
        request.expiresAt,
        request.payload,
    ]);
    if (!wire(serialized)) return fail();
    return new TextEncoder().encode(serialized);
}

/** Structural helpers only; encoding does not prove account or device authorization. */
export function encodeUnsignedResearchRequest(request: UnsignedResearchRequest): string {
    try {
        return boundedEncoded(unsigned(readFields(request, UNSIGNED_FIELDS)));
    } catch {
        return fail();
    }
}
export function encodeSignedResearchRequest(request: ResearchSignedRequest): string {
    try {
        return boundedEncoded(signed(request));
    } catch {
        return fail();
    }
}
export const encodeUnsigned = encodeUnsignedResearchRequest;
export const encodeSigned = encodeSignedResearchRequest;

/** Exact bytes shared by the native provider signer and this WebCrypto verifier. */
export function researchRequestSigningBytes(request: UnsignedResearchRequest): Uint8Array<ArrayBuffer> {
    try {
        return signingBytes(unsigned(readFields(request, UNSIGNED_FIELDS)));
    } catch {
        return fail();
    }
}

/** Validate a detached snapshot using an independently authenticated user and clock. */
export function parseResearchSignedRequest(
    serialized: string,
    authenticatedUserId: string,
    nowSeconds: number,
): Readonly<ResearchSignedRequest> {
    try {
        if (
            !wire(serialized) ||
            !identifier(authenticatedUserId) ||
            !Number.isSafeInteger(nowSeconds) ||
            nowSeconds < 0
        )
            return fail();
        const request = signed(JSON.parse(serialized));
        if (
            boundedEncoded(request) !== serialized ||
            request.userId !== authenticatedUserId ||
            request.expiresAt <= nowSeconds ||
            request.expiresAt - nowSeconds > MAX_RESEARCH_REQUEST_AGE_SECONDS
        )
            return fail();
        return Object.freeze(request);
    } catch {
        return fail();
    }
}

/** The signing key must come from the trusted registered-device lookup, never the caller. */
export async function verifyResearchRequestSignature(
    request: ResearchSignedRequest,
    trustedSigningKey: string,
): Promise<void> {
    try {
        const snapshot = signed(request);
        boundedEncoded(snapshot);
        const publicKey = await globalThis.crypto.subtle.importKey(
            'raw',
            base64Bytes(trustedSigningKey, 32),
            { name: 'Ed25519' },
            false,
            ['verify'],
        );
        const verified = await globalThis.crypto.subtle.verify(
            { name: 'Ed25519' },
            publicKey,
            base64Bytes(snapshot.signature, 64),
            signingBytes(snapshot),
        );
        if (!verified) return fail();
    } catch {
        return fail();
    }
}
