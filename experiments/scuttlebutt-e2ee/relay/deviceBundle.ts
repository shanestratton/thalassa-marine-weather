/**
 * Experiment only: public device-bundle framing and Ed25519 proof of possession.
 * This is not encryption, first-key authentication, or proof that a request came
 * from a particular device. A trusted relay adapter supplies authenticatedUserId.
 */
export const DEVICE_BUNDLE_VERSION = 1 as const;
export const DEVICE_BUNDLE_PROTOCOL = 'olm-v1' as const;
export const MAX_DEVICE_BUNDLE_CHARS = 4096;
export const MAX_DEVICE_BUNDLE_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface DeviceBundle {
    readonly version: typeof DEVICE_BUNDLE_VERSION;
    readonly protocol: typeof DEVICE_BUNDLE_PROTOCOL;
    readonly userId: string;
    readonly deviceId: string;
    readonly identityKeyId: string;
    /** Raw Ed25519 public key; canonical unpadded standard base64. */
    readonly signingKey: string;
    /** Provider-generated Curve25519 public identity key. */
    readonly curveKey: string;
    readonly prekeyId: string;
    /** Provider-generated Curve25519 public one-time prekey. */
    readonly prekey: string;
    /** Integer Unix seconds. */
    readonly expiresAt: number;
    /** Ed25519 signature over the domain-separated signing bytes below. */
    readonly signature: string;
}

export type UnsignedDeviceBundle = Omit<DeviceBundle, 'signature'>;

export class InvalidDeviceBundleError extends Error {
    constructor() {
        // Never include input, parser details, or provider exceptions in errors.
        super('Invalid device bundle');
        this.name = 'InvalidDeviceBundleError';
    }
}

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
// Canonical bundle JSON contains printable ASCII only, never raw controls.
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/;
const BASE64 = /^[A-Za-z0-9+/]+$/;
const UNSIGNED_FIELDS = [
    'version',
    'protocol',
    'userId',
    'deviceId',
    'identityKeyId',
    'signingKey',
    'curveKey',
    'prekeyId',
    'prekey',
    'expiresAt',
] as const;
const FIELDS = [...UNSIGNED_FIELDS, 'signature'] as const;

function isIdentifier(value: unknown): value is string {
    // JavaScript's $ also matches before a final newline; require the whole ID.
    return typeof value === 'string' && IDENTIFIER.exec(value)?.[0] === value;
}

/** Inspect descriptors before reading values: getters and toJSON must not run. */
function readPlainFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new InvalidDeviceBundleError();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
        throw new InvalidDeviceBundleError();
    }
    const result: Record<string, unknown> = {};
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw new InvalidDeviceBundleError();
        }
        result[field] = descriptor.value;
    }
    return result;
}

function decodeBase64(value: unknown, byteLength: 32 | 64): Uint8Array<ArrayBuffer> {
    const charLength = byteLength === 32 ? 43 : 86;
    if (typeof value !== 'string' || value.length !== charLength || !BASE64.test(value)) {
        throw new InvalidDeviceBundleError();
    }
    const binary = atob(value + (byteLength === 32 ? '=' : '=='));
    if (binary.length !== byteLength || btoa(binary).replace(/=+$/, '') !== value) {
        throw new InvalidDeviceBundleError();
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validateUnsigned(fields: Record<string, unknown>): UnsignedDeviceBundle {
    if (
        fields.version !== DEVICE_BUNDLE_VERSION ||
        fields.protocol !== DEVICE_BUNDLE_PROTOCOL ||
        !isIdentifier(fields.userId) ||
        !isIdentifier(fields.deviceId) ||
        !isIdentifier(fields.identityKeyId) ||
        !isIdentifier(fields.prekeyId) ||
        typeof fields.expiresAt !== 'number' ||
        !Number.isSafeInteger(fields.expiresAt) ||
        fields.expiresAt <= 0
    ) {
        throw new InvalidDeviceBundleError();
    }
    decodeBase64(fields.signingKey, 32);
    decodeBase64(fields.curveKey, 32);
    decodeBase64(fields.prekey, 32);
    // Fixed order and detached primitive values; never serialize the input object.
    return {
        version: DEVICE_BUNDLE_VERSION,
        protocol: DEVICE_BUNDLE_PROTOCOL,
        userId: fields.userId,
        deviceId: fields.deviceId,
        identityKeyId: fields.identityKeyId,
        signingKey: fields.signingKey as string,
        curveKey: fields.curveKey as string,
        prekeyId: fields.prekeyId,
        prekey: fields.prekey as string,
        expiresAt: fields.expiresAt,
    };
}

function validateBundle(value: unknown): DeviceBundle {
    const fields = readPlainFields(value, FIELDS);
    const unsigned = validateUnsigned(fields);
    decodeBase64(fields.signature, 64);
    return { ...unsigned, signature: fields.signature as string };
}

function signingBytes(bundle: UnsignedDeviceBundle): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
        JSON.stringify([
            'thalassa-device-bundle',
            DEVICE_BUNDLE_VERSION,
            DEVICE_BUNDLE_PROTOCOL,
            bundle.userId,
            bundle.deviceId,
            bundle.identityKeyId,
            bundle.signingKey,
            bundle.curveKey,
            bundle.prekeyId,
            bundle.prekey,
            bundle.expiresAt,
        ]),
    );
}

/** Structural encoding only; callers must verify before accepting a bundle. */
export function encodeDeviceBundle(bundle: DeviceBundle): string {
    try {
        return JSON.stringify(validateBundle(bundle));
    } catch {
        throw new InvalidDeviceBundleError();
    }
}

/** Exact experiment contract; not a Matrix event or a custom encryption scheme. */
export function deviceBundleSigningBytes(bundleWithoutSignature: UnsignedDeviceBundle): Uint8Array<ArrayBuffer> {
    try {
        return signingBytes(validateUnsigned(readPlainFields(bundleWithoutSignature, UNSIGNED_FIELDS)));
    } catch {
        throw new InvalidDeviceBundleError();
    }
}

/**
 * Verify ownership binding, freshness, canonical framing, and key possession.
 * The adapter must derive authenticatedUserId and nowSeconds independently of
 * the request body. No stored bundle, device, or account state is modified here.
 * Expired exact registration retries are rejected here even if SQL permits an
 * idempotent retry of an already registered bundle.
 */
export async function parseAndVerifyDeviceBundle(
    serialized: string,
    authenticatedUserId: string,
    nowSeconds: number,
): Promise<Readonly<DeviceBundle>> {
    try {
        if (
            typeof serialized !== 'string' ||
            serialized.length > MAX_DEVICE_BUNDLE_CHARS ||
            NON_PRINTABLE_ASCII.test(serialized) ||
            !isIdentifier(authenticatedUserId) ||
            !Number.isSafeInteger(nowSeconds) ||
            nowSeconds < 0
        ) {
            throw new InvalidDeviceBundleError();
        }
        const bundle = validateBundle(JSON.parse(serialized));
        if (
            JSON.stringify(bundle) !== serialized ||
            bundle.userId !== authenticatedUserId ||
            bundle.expiresAt <= nowSeconds ||
            bundle.expiresAt - nowSeconds > MAX_DEVICE_BUNDLE_AGE_SECONDS
        ) {
            throw new InvalidDeviceBundleError();
        }
        const publicKey = await globalThis.crypto.subtle.importKey(
            'raw',
            decodeBase64(bundle.signingKey, 32),
            { name: 'Ed25519' },
            false,
            ['verify'],
        );
        const verified = await globalThis.crypto.subtle.verify(
            { name: 'Ed25519' },
            publicKey,
            decodeBase64(bundle.signature, 64),
            signingBytes(bundle),
        );
        if (!verified) throw new InvalidDeviceBundleError();
        return Object.freeze(bundle);
    } catch {
        throw new InvalidDeviceBundleError();
    }
}
