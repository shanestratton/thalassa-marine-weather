// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    DEVICE_BUNDLE_PROTOCOL,
    DEVICE_BUNDLE_VERSION,
    InvalidDeviceBundleError,
    MAX_DEVICE_BUNDLE_AGE_SECONDS,
    MAX_DEVICE_BUNDLE_CHARS,
    deviceBundleSigningBytes,
    encodeDeviceBundle,
    parseAndVerifyDeviceBundle,
    type DeviceBundle,
    type UnsignedDeviceBundle,
} from '../experiments/scuttlebutt-e2ee/relay/deviceBundle';

const NOW = 1_800_000_000;
const OWNER = 'alice:account-1';
let signer: webcrypto.CryptoKeyPair;
let anotherSigner: webcrypto.CryptoKeyPair;
let anotherSigningKey: string;
let unsigned: UnsignedDeviceBundle;
let bundle: DeviceBundle;

function base64(bytes: ArrayBuffer): string {
    return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
}

// Independent fixture construction fixes the complete signed protocol contract.
// Signatures and public keys are real WebCrypto output, not a mocked verifier.
function expectedSigningBytes(value: UnsignedDeviceBundle): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
        JSON.stringify([
            'thalassa-device-bundle',
            1,
            'olm-v1',
            value.userId,
            value.deviceId,
            value.identityKeyId,
            value.signingKey,
            value.curveKey,
            value.prekeyId,
            value.prekey,
            value.expiresAt,
        ]),
    );
}

async function signBundle(patch: Partial<UnsignedDeviceBundle> = {}, key = signer.privateKey): Promise<DeviceBundle> {
    const value = { ...unsigned, ...patch };
    const signature = base64(await webcrypto.subtle.sign('Ed25519', key, expectedSigningBytes(value)));
    return { ...value, signature };
}

beforeAll(async () => {
    const pairs = await Promise.all([
        webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
        webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
        webcrypto.subtle.generateKey('X25519', true, ['deriveBits']),
        webcrypto.subtle.generateKey('X25519', true, ['deriveBits']),
    ]);
    const [first, second, curve, prekey] = pairs as webcrypto.CryptoKeyPair[];
    signer = first;
    anotherSigner = second;
    anotherSigningKey = base64(await webcrypto.subtle.exportKey('raw', second.publicKey));
    unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId: OWNER,
        deviceId: 'ios.device-1',
        identityKeyId: 'identity_1',
        signingKey: base64(await webcrypto.subtle.exportKey('raw', first.publicKey)),
        curveKey: base64(await webcrypto.subtle.exportKey('raw', curve.publicKey)),
        prekeyId: 'prekey:1',
        prekey: base64(await webcrypto.subtle.exportKey('raw', prekey.publicKey)),
        expiresAt: NOW + 3600,
    };
    bundle = await signBundle();
});

afterEach(() => vi.unstubAllGlobals());

describe('experiment-only signed device bundles', () => {
    it('verifies a real signature and returns an immutable canonical snapshot', async () => {
        expect(DEVICE_BUNDLE_VERSION).toBe(1);
        expect(DEVICE_BUNDLE_PROTOCOL).toBe('olm-v1');
        expect(deviceBundleSigningBytes(unsigned)).toEqual(expectedSigningBytes(unsigned));
        const wire = encodeDeviceBundle(bundle);
        expect(wire).toBe(JSON.stringify(bundle));
        const parsed = await parseAndVerifyDeviceBundle(wire, OWNER, NOW);
        expect(parsed).toEqual(bundle);
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(encodeDeviceBundle(parsed)).toBe(wire);
        expect(bundle.signingKey).toHaveLength(43);
        expect(bundle.signature).toHaveLength(86);
    });

    it('encodes in fixed order regardless of caller insertion order', () => {
        const reversed = Object.fromEntries(Object.entries(bundle).reverse()) as unknown as DeviceBundle;
        expect(encodeDeviceBundle(reversed)).toBe(JSON.stringify(bundle));
    });

    it.each([
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
        'signature',
    ] as const)('rejects alteration of signed field %s', async (field) => {
        const changes: Record<keyof DeviceBundle, unknown> = {
            version: 2,
            protocol: 'olm-v2',
            userId: 'bob:account-2',
            deviceId: 'ios.device-2',
            identityKeyId: 'identity_2',
            signingKey: anotherSigningKey,
            curveKey: unsigned.prekey,
            prekeyId: 'prekey:2',
            prekey: unsigned.curveKey,
            expiresAt: bundle.expiresAt + 1,
            signature: base64(new Uint8Array(64).buffer),
        };
        const changed = { ...bundle, [field]: changes[field] };
        // Match the changed account to ensure this case exercises its signature.
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(changed), changed.userId, NOW)).rejects.toThrow(
            InvalidDeviceBundleError,
        );
    });

    it('rejects a valid signature substituted from another bundle or another key', async () => {
        const changed = await signBundle({ prekeyId: 'prekey:2' });
        const wrongSigner = await signBundle({}, anotherSigner.privateKey);
        for (const signature of [changed.signature, wrongSigner.signature]) {
            await expect(
                parseAndVerifyDeviceBundle(JSON.stringify({ ...bundle, signature }), OWNER, NOW),
            ).rejects.toThrow(InvalidDeviceBundleError);
        }
    });

    it('rejects a signature over another domain even when the signer is correct', async () => {
        const differentDomain = new TextEncoder().encode(
            new TextDecoder().decode(expectedSigningBytes(unsigned)).replace('thalassa-device-bundle', 'other-bundle'),
        );
        const signature = base64(await webcrypto.subtle.sign('Ed25519', signer.privateKey, differentDomain));
        await expect(parseAndVerifyDeviceBundle(JSON.stringify({ ...bundle, signature }), OWNER, NOW)).rejects.toThrow(
            InvalidDeviceBundleError,
        );
    });

    it('requires the owner from a trusted authenticated request context', async () => {
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(bundle), 'bob:account-2', NOW)).rejects.toThrow(
            InvalidDeviceBundleError,
        );
    });

    it('proves key possession only: another self-signed first key is not authenticated as a known device', async () => {
        const otherFirstKey = await signBundle({ signingKey: anotherSigningKey }, anotherSigner.privateKey);
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(otherFirstKey), OWNER, NOW)).resolves.toEqual(
            otherFirstKey,
        );
    });

    it.each([1, MAX_DEVICE_BUNDLE_AGE_SECONDS])('accepts expiry %i seconds into the future', async (seconds) => {
        const fresh = await signBundle({ expiresAt: NOW + seconds });
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(fresh), OWNER, NOW)).resolves.toEqual(fresh);
    });

    it.each([NOW - 1, NOW, NOW + MAX_DEVICE_BUNDLE_AGE_SECONDS + 1])(
        'rejects signed expiry outside the accepted window: %i',
        async (expiresAt) => {
            const expired = await signBundle({ expiresAt });
            await expect(parseAndVerifyDeviceBundle(JSON.stringify(expired), OWNER, NOW)).rejects.toThrow(
                InvalidDeviceBundleError,
            );
        },
    );

    it('rejects an unchanged retry once the registered bundle has expired', async () => {
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(bundle), OWNER, bundle.expiresAt)).rejects.toThrow(
            InvalidDeviceBundleError,
        );
    });

    it.each([-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1800003600', null])(
        'rejects a structurally invalid expiry: %j',
        async (expiresAt) => {
            const malformed = { ...bundle, expiresAt } as unknown as DeviceBundle;
            expect(() => encodeDeviceBundle(malformed)).toThrow(InvalidDeviceBundleError);
            await expect(parseAndVerifyDeviceBundle(JSON.stringify(malformed), OWNER, NOW)).rejects.toThrow(
                InvalidDeviceBundleError,
            );
        },
    );

    it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid trusted time %j', async (now) => {
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(bundle), OWNER, now)).rejects.toThrow(
            InvalidDeviceBundleError,
        );
    });

    it.each(['userId', 'deviceId', 'identityKeyId', 'prekeyId'] as const)(
        'enforces ASCII ID bounds for %s',
        async (field) => {
            for (const invalid of [
                '',
                'x'.repeat(129),
                'two words',
                'line\nbreak',
                'trailing\n',
                'trailing\r',
                'trailing\u2028',
                'ümlaut',
                'slash/id',
                5,
                null,
            ]) {
                const malformed = { ...bundle, [field]: invalid } as unknown as DeviceBundle;
                expect(() => encodeDeviceBundle(malformed)).toThrow(InvalidDeviceBundleError);
                await expect(parseAndVerifyDeviceBundle(JSON.stringify(malformed), OWNER, NOW)).rejects.toThrow(
                    InvalidDeviceBundleError,
                );
            }
        },
    );

    it('accepts all permitted ID punctuation and the maximum ID length', async () => {
        const id = `${'a'.repeat(122)}._:-09`;
        const bounded = await signBundle({ userId: id, deviceId: id, identityKeyId: id, prekeyId: id });
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(bounded), id, NOW)).resolves.toEqual(bounded);
    });

    it.each(['signingKey', 'curveKey', 'prekey'] as const)(
        'requires canonical 32-byte base64 for %s',
        async (field) => {
            for (const invalid of [
                '',
                'A'.repeat(42),
                'A'.repeat(44),
                `${'A'.repeat(43)}=`,
                `${'A'.repeat(42)}B`, // Nonzero unused padding bits; same decoded bytes as canonical input.
                '_'.repeat(43),
                '-'.repeat(43),
                `${'A'.repeat(42)}\n`,
                5,
                null,
            ]) {
                const malformed = { ...bundle, [field]: invalid } as unknown as DeviceBundle;
                expect(() => encodeDeviceBundle(malformed)).toThrow(InvalidDeviceBundleError);
                await expect(parseAndVerifyDeviceBundle(JSON.stringify(malformed), OWNER, NOW)).rejects.toThrow(
                    InvalidDeviceBundleError,
                );
            }
        },
    );

    it.each(['', 'A'.repeat(85), 'A'.repeat(87), `${'A'.repeat(86)}==`, `${'A'.repeat(85)}B`, '_'.repeat(86)])(
        'rejects malformed signature encoding %j',
        async (signature) => {
            const malformed = { ...bundle, signature };
            expect(() => encodeDeviceBundle(malformed)).toThrow(InvalidDeviceBundleError);
            await expect(parseAndVerifyDeviceBundle(JSON.stringify(malformed), OWNER, NOW)).rejects.toThrow(
                InvalidDeviceBundleError,
            );
        },
    );

    it('rejects duplicate keys, reordered fields, whitespace, escaped aliases, and numeric aliases', async () => {
        const wire = JSON.stringify(bundle);
        const alternatives = [
            ` ${wire}`,
            `${wire}\n`,
            JSON.stringify(bundle, null, 2),
            JSON.stringify(Object.fromEntries(Object.entries(bundle).reverse())),
            wire.replace('"version":1', '"version":1,"version":1'),
            wire.replace('"version":1', '"version":2,"version":1'),
            wire.replace('alice', '\\u0061lice'),
            wire.replace(String(bundle.expiresAt), `${bundle.expiresAt}.0`),
            wire.replace(String(bundle.expiresAt), `${bundle.expiresAt}e0`),
        ];
        for (const alternative of alternatives) {
            await expect(parseAndVerifyDeviceBundle(alternative, OWNER, NOW)).rejects.toThrow(InvalidDeviceBundleError);
        }
    });

    it.each(['', '{', 'null', '[]', '{}', '5', '"TOP SECRET"', 'é'])(
        'rejects malformed wire input %j',
        async (wire) => {
            await expect(parseAndVerifyDeviceBundle(wire, OWNER, NOW)).rejects.toThrow(InvalidDeviceBundleError);
        },
    );

    it('rejects oversize wire input before parsing or signature verification', async () => {
        const parse = vi.spyOn(JSON, 'parse');
        try {
            await expect(
                parseAndVerifyDeviceBundle(' '.repeat(MAX_DEVICE_BUNDLE_CHARS + 1), OWNER, NOW),
            ).rejects.toThrow(InvalidDeviceBundleError);
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
    });

    it('requires every field and rejects additional fields on encode and receive', async () => {
        for (const field of Object.keys(bundle)) {
            const incomplete: Record<string, unknown> = { ...bundle };
            delete incomplete[field];
            expect(() => encodeDeviceBundle(incomplete as unknown as DeviceBundle)).toThrow(InvalidDeviceBundleError);
            await expect(parseAndVerifyDeviceBundle(JSON.stringify(incomplete), OWNER, NOW)).rejects.toThrow(
                InvalidDeviceBundleError,
            );
        }
        for (const field of ['privateKey', 'plaintext', 'debug', 'toJSON', '__proto__']) {
            const extra = { ...bundle, [field]: 'TOP SECRET' };
            expect(() => encodeDeviceBundle(extra)).toThrow(InvalidDeviceBundleError);
            await expect(parseAndVerifyDeviceBundle(JSON.stringify(extra), OWNER, NOW)).rejects.toThrow(
                InvalidDeviceBundleError,
            );
        }
    });

    it('rejects symbols, nonenumerable extras, accessors, and prototypes without executing getters', () => {
        const getter = vi.fn(() => bundle.deviceId);
        const accessor = Object.defineProperty({ ...bundle }, 'deviceId', { get: getter, enumerable: true });
        const hiddenExtra = Object.defineProperty({ ...bundle }, 'secret', { value: 'TOP SECRET' });
        const hiddenField = Object.defineProperty({ ...bundle }, 'deviceId', { enumerable: false });
        const customPrototype = Object.assign(Object.create({ secret: 'TOP SECRET' }), bundle);
        const nullPrototype = Object.assign(Object.create(null), bundle);
        for (const unsafe of [
            accessor,
            hiddenExtra,
            hiddenField,
            customPrototype,
            nullPrototype,
            { ...bundle, [Symbol('secret')]: 'TOP SECRET' },
        ]) {
            expect(() => encodeDeviceBundle(unsafe)).toThrow(InvalidDeviceBundleError);
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it('applies the strict object boundary to the signing helper too', () => {
        const getter = vi.fn(() => unsigned.deviceId);
        const accessor = Object.defineProperty({ ...unsigned }, 'deviceId', { get: getter, enumerable: true });
        for (const unsafe of [
            bundle,
            { ...unsigned, secret: 'TOP SECRET' },
            { ...unsigned, [Symbol('secret')]: 'TOP SECRET' },
            accessor,
            Object.assign(Object.create({ inherited: true }), unsigned),
        ]) {
            expect(() => deviceBundleSigningBytes(unsafe)).toThrow(InvalidDeviceBundleError);
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it('exposes a generic error for parser, object, and cryptographic-provider failures', async () => {
        const proxy = new Proxy(bundle, {
            ownKeys() {
                throw new Error('TOP SECRET object failure');
            },
        });
        expect(() => encodeDeviceBundle(proxy)).toThrow(new InvalidDeviceBundleError());
        await expect(parseAndVerifyDeviceBundle('{TOP SECRET', OWNER, NOW)).rejects.toThrow(
            new InvalidDeviceBundleError(),
        );
        vi.stubGlobal('crypto', {
            subtle: {
                importKey: () => {
                    throw new Error('TOP SECRET provider failure');
                },
            },
        });
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(bundle), OWNER, NOW)).rejects.toThrow(
            new InvalidDeviceBundleError(),
        );
    });

    it('fails closed when WebCrypto is unavailable', async () => {
        vi.stubGlobal('crypto', undefined);
        await expect(parseAndVerifyDeviceBundle(JSON.stringify(bundle), OWNER, NOW)).rejects.toThrow(
            InvalidDeviceBundleError,
        );
    });
});
