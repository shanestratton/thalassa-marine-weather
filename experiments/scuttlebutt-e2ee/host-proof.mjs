/**
 * Research-only, real libsignal Node host proof. Never imported by the app.
 *
 * Run from this repository (the dependency remains outside the repository):
 *   proof_dir=$(mktemp -d /tmp/thalassa-libsignal-host-proof.XXXXXX)
 *   npm install --prefix "$proof_dir" --ignore-scripts --no-audit --no-fund \
 *     --save-exact @signalapp/libsignal-client@0.103.0
 *   node experiments/scuttlebutt-e2ee/host-proof.mjs \
 *     "$proof_dir/node_modules/@signalapp/libsignal-client/dist/index.js"
 *
 * Exactly 0.103.0 is required. npm did not publish 0.103.1 as of 2026-09-30;
 * the separately reviewed v0.103.1 Swift source is NOT the binary tested here.
 * Use the official npm package's prebuilt native binary; do not build Rust here.
 * Verified run: Node v26.5.0 / Darwin arm64; eight check groups passed.
 * Published package gitHead: ba133bd3457f556fbf56db0a5ab985de0af79da6.
 * Registry tarball (npm checks its integrity during installation):
 * https://registry.npmjs.org/@signalapp/libsignal-client/-/libsignal-client-0.103.0.tgz
 * Package integrity:
 * sha512-eTPT0ebDsoriIjeMjuB882H51UpFXnWDIu43VX0uBSM6iryKmCa0zxabncrS6xG0KJqAc+Modjkhk0nk+w2k+A==
 * Loaded prebuild: prebuilds/darwin-arm64/@signalapp+libsignal-client.node.
 * That prebuild's SHA-256:
 * 8d3e8a9f10e99df631a004154697984c65a16526e589dc367d047855bd934a9d.
 * These observations are provenance, not a binary reproducibility attestation.
 *
 * Fresh synthetic peers and ephemeral stores exercise libsignal itself. Stores
 * below are deliberately unsuitable for production: no persistence, at-rest
 * protection, transactions, concurrent access control, backup or crash recovery.
 * Trust on first use pins an identity; it does not authenticate the first key.
 * This is not a network, native-iOS, interoperability or security-audit result.
 * Passing does not identify a negotiated SPQR/Triple Ratchet version. Shipping
 * approval and the upstream AGPL-3.0-only licensing review remain unresolved.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_VERSION = '0.103.0';
const EXPECTED_NATIVE_SHA256 = '8d3e8a9f10e99df631a004154697984c65a16526e589dc367d047855bd934a9d';
let activeCheck = 'external pinned library';
let passed = 0;

async function check(label, action) {
    activeCheck = label;
    await action();
    passed += 1;
    console.log(`PASS ${label}`);
}

async function run() {
    // No package-name fallback: resolution cannot silently use app dependencies.
    assert.equal(process.argv.length, 3);
    assert.ok(isAbsolute(process.argv[2]));
    const modulePath = await realpath(process.argv[2]);
    const packageRoot = dirname(dirname(modulePath));
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@signalapp/libsignal-client');
    assert.equal(manifest.version, EXPECTED_VERSION);
    assert.equal(modulePath, await realpath(resolve(packageRoot, manifest.main)));
    // This proof deliberately supports only the binary whose provenance was
    // checked. Do not silently substitute a different platform/native build.
    assert.equal(process.platform, 'darwin');
    assert.equal(process.arch, 'arm64');
    const nativeBinary = await readFile(
        resolve(packageRoot, 'prebuilds/darwin-arm64/@signalapp+libsignal-client.node'),
    );
    assert.equal(createHash('sha256').update(nativeBinary).digest('hex'), EXPECTED_NATIVE_SHA256);
    const signal = await import(pathToFileURL(modulePath).href);
    // Library errors and native logs can contain identifiers. Discard them here.
    signal.initLogger(signal.LogLevel.Error, () => {});
    await check('external pinned library', async () => {
        assert.equal(typeof signal.signalEncrypt, 'function');
        assert.equal(typeof signal.signalDecryptPreKey, 'function');
    });

    const addressKey = (address) => JSON.stringify([address.name(), address.deviceId()]);
    const copyBytes = (bytes) => Uint8Array.from(bytes);

    // Store serialized copies so native objects returned by reads cannot mutate
    // committed records. Only documented libsignal store APIs change test state.
    function records(RecordClass) {
        const values = new Map();
        return {
            save(id, value) {
                values.set(id, copyBytes(value.serialize()));
            },
            load(id) {
                const bytes = values.get(id);
                assert.ok(bytes, 'Required test record is absent');
                return RecordClass.deserialize(copyBytes(bytes));
            },
            has(id) {
                return values.has(id);
            },
            remove(id) {
                values.delete(id);
            },
            snapshot() {
                return [...values].map(([id, bytes]) => [id, copyBytes(bytes)]);
            },
        };
    }

    class Sessions extends signal.SessionStore {
        data = records(signal.SessionRecord);
        async saveSession(address, record) {
            this.data.save(addressKey(address), record);
        }
        async getSession(address) {
            const key = addressKey(address);
            return this.data.has(key) ? this.data.load(key) : null;
        }
        async getExistingSessions(addresses) {
            return addresses.map((address) => this.data.load(addressKey(address)));
        }
    }

    class Identities extends signal.IdentityKeyStore {
        local = signal.PrivateKey.generate();
        known = records(signal.PublicKey);
        constructor(registrationId) {
            super();
            this.registrationId = registrationId;
        }
        async getIdentityKey() {
            return this.local;
        }
        async getLocalRegistrationId() {
            return this.registrationId;
        }
        async getIdentity(address) {
            const key = addressKey(address);
            return this.known.has(key) ? this.known.load(key) : null;
        }
        async isTrustedIdentity(address, incoming, _direction) {
            const pinned = await this.getIdentity(address);
            return pinned === null || pinned.equals(incoming);
        }
        async saveIdentity(address, incoming) {
            const previous = await this.getIdentity(address);
            this.known.save(addressKey(address), incoming);
            return previous && !previous.equals(incoming)
                ? signal.IdentityChange.ReplacedExisting
                : signal.IdentityChange.NewOrUnchanged;
        }
    }

    class PreKeys extends signal.PreKeyStore {
        data = records(signal.PreKeyRecord);
        async savePreKey(id, value) {
            this.data.save(id, value);
        }
        async getPreKey(id) {
            return this.data.load(id);
        }
        async removePreKey(id) {
            this.data.remove(id);
        }
    }

    class SignedPreKeys extends signal.SignedPreKeyStore {
        data = records(signal.SignedPreKeyRecord);
        async saveSignedPreKey(id, value) {
            this.data.save(id, value);
        }
        async getSignedPreKey(id) {
            return this.data.load(id);
        }
    }

    class KyberPreKeys extends signal.KyberPreKeyStore {
        data = records(signal.KyberPreKeyRecord);
        used = new Set();
        async saveKyberPreKey(id, value) {
            this.data.save(id, value);
        }
        async getKyberPreKey(id) {
            return this.data.load(id);
        }
        async markKyberPreKeyUsed(id, signedPreKeyId, baseKey) {
            const reference = `${id}:${signedPreKeyId}:${Buffer.from(baseKey.serialize()).toString('base64')}`;
            assert.ok(!this.used.has(reference), 'Repeated test prekey use');
            this.used.add(reference);
        }
    }

    function peer(address, registrationId) {
        return {
            address,
            identity: new Identities(registrationId),
            session: new Sessions(),
            prekeys: new PreKeys(),
            signed: new SignedPreKeys(),
            kyber: new KyberPreKeys(),
            nextPreKeyId: 1,
        };
    }

    function snapshot(owner) {
        return {
            identity: owner.identity.known.snapshot(),
            session: owner.session.data.snapshot(),
            prekeys: owner.prekeys.data.snapshot(),
            signed: owner.signed.data.snapshot(),
            kyber: owner.kyber.data.snapshot(),
            used: [...owner.kyber.used],
        };
    }

    async function bundle(owner) {
        const id = owner.nextPreKeyId++;
        const identity = await owner.identity.getIdentityKey();
        const prekey = signal.PrivateKey.generate();
        const signed = signal.PrivateKey.generate();
        const kyber = signal.KEMKeyPair.generate();
        const signedSignature = identity.sign(signed.getPublicKey().serialize());
        const kyberSignature = identity.sign(kyber.getPublicKey().serialize());
        const timestamp = Date.now();
        await owner.prekeys.savePreKey(id, signal.PreKeyRecord.new(id, prekey.getPublicKey(), prekey));
        await owner.signed.saveSignedPreKey(
            id,
            signal.SignedPreKeyRecord.new(id, timestamp, signed.getPublicKey(), signed, signedSignature),
        );
        await owner.kyber.saveKyberPreKey(id, signal.KyberPreKeyRecord.new(id, timestamp, kyber, kyberSignature));
        return signal.PreKeyBundle.new(
            await owner.identity.getLocalRegistrationId(),
            owner.address.deviceId(),
            id,
            prekey.getPublicKey(),
            id,
            signed.getPublicKey(),
            signedSignature,
            identity.getPublicKey(),
            id,
            kyber.getPublicKey(),
            kyberSignature,
        );
    }

    async function encrypt(from, to, plaintext) {
        const result = await signal.signalEncrypt(plaintext, to.address, from.address, from.session, from.identity);
        return { type: result.type(), bytes: copyBytes(result.serialize()) };
    }

    async function decrypt(to, from, envelope) {
        if (envelope.type === signal.CiphertextMessageType.PreKey) {
            return signal.signalDecryptPreKey(
                signal.PreKeySignalMessage.deserialize(envelope.bytes),
                from.address,
                to.address,
                to.session,
                to.identity,
                to.prekeys,
                to.signed,
                to.kyber,
            );
        }
        assert.equal(envelope.type, signal.CiphertextMessageType.Whisper);
        return signal.signalDecrypt(
            signal.SignalMessage.deserialize(envelope.bytes),
            from.address,
            to.address,
            to.session,
            to.identity,
        );
    }

    const samePlaintext = (actual, expected) => assert.deepEqual(Buffer.from(actual), expected);
    const isSignalError = (code) => (error) => error instanceof signal.LibSignalErrorBase && error.code === code;
    const fixture = (label) => Buffer.from(`synthetic-host-proof:${label}`, 'utf8');
    const a = peer(signal.ProtocolAddress.new('10000000-0000-4000-8000-000000000001', 1), 1);
    const b = peer(signal.ProtocolAddress.new('10000000-0000-4000-8000-000000000002', 1), 2);
    let initial;
    let reply;

    await check('prekey roundtrip and session reply', async () => {
        const recipientBundle = await bundle(b);
        await signal.processPreKeyBundle(recipientBundle, b.address, a.address, a.session, a.identity);
        initial = await encrypt(a, b, fixture('initial'));
        assert.equal(initial.type, signal.CiphertextMessageType.PreKey);
        samePlaintext(await decrypt(b, a, initial), fixture('initial'));
        assert.equal(b.prekeys.data.has(recipientBundle.preKeyId()), false);
        assert.equal(b.kyber.used.size, 1);
        reply = await encrypt(b, a, fixture('reply'));
        assert.equal(reply.type, signal.CiphertextMessageType.Whisper);
        samePlaintext(await decrypt(a, b, reply), fixture('reply'));
    });

    await check('prekey and session replay rejected', async () => {
        const beforeA = snapshot(a);
        const beforeB = snapshot(b);
        await assert.rejects(() => decrypt(b, a, initial), isSignalError(signal.ErrorCode.DuplicatedMessage));
        await assert.rejects(() => decrypt(a, b, reply), isSignalError(signal.ErrorCode.DuplicatedMessage));
        assert.deepEqual(snapshot(a), beforeA);
        assert.deepEqual(snapshot(b), beforeB);
    });

    await check('tamper rejected and original remains decryptable', async () => {
        const plaintext = fixture('tamper-retry');
        const valid = await encrypt(a, b, plaintext);
        assert.equal(valid.type, signal.CiphertextMessageType.Whisper);
        const before = snapshot(b);
        const tampered = { ...valid, bytes: copyBytes(valid.bytes) };
        // The only protocol-byte mutation in this proof: flip the trailing MAC.
        tampered.bytes[tampered.bytes.length - 1] ^= 1;
        signal.SignalMessage.deserialize(tampered.bytes); // Must reach decrypt, not just fail parsing.
        await assert.rejects(
            () => decrypt(b, a, tampered),
            (error) =>
                error instanceof signal.LibSignalErrorBase &&
                error.operation === 'SessionCipher_DecryptSignalMessage' &&
                error.code !== signal.ErrorCode.DuplicatedMessage,
        );
        assert.deepEqual(snapshot(b), before);
        samePlaintext(await decrypt(b, a, valid), plaintext);
    });

    await check('out-of-order delivery in both directions', async () => {
        for (const [sender, receiver] of [
            [a, b],
            [b, a],
        ]) {
            const pending = [];
            for (let index = 0; index < 3; index += 1) {
                const plaintext = fixture(`reorder-${index}`);
                const envelope = await encrypt(sender, receiver, plaintext);
                assert.equal(envelope.type, signal.CiphertextMessageType.Whisper);
                pending.push({ envelope, plaintext });
            }
            for (const index of [2, 0, 1]) {
                const { envelope, plaintext } = pending[index];
                samePlaintext(await decrypt(receiver, sender, envelope), plaintext);
            }
            await assert.rejects(
                () => decrypt(receiver, sender, pending[0].envelope),
                isSignalError(signal.ErrorCode.DuplicatedMessage),
            );
        }
    });

    const replacement = peer(b.address, 3);
    await check('changed bundle identity rejected', async () => {
        const replacementBundle = await bundle(replacement);
        const before = snapshot(a);
        await assert.rejects(
            () => signal.processPreKeyBundle(replacementBundle, b.address, a.address, a.session, a.identity),
            isSignalError(signal.ErrorCode.UntrustedIdentity),
        );
        assert.deepEqual(snapshot(a), before);
    });

    await check('changed incoming identity rejected', async () => {
        const recipientBundle = await bundle(a);
        await signal.processPreKeyBundle(
            recipientBundle,
            a.address,
            replacement.address,
            replacement.session,
            replacement.identity,
        );
        const untrusted = await encrypt(replacement, a, fixture('replacement'));
        assert.equal(untrusted.type, signal.CiphertextMessageType.PreKey);
        const before = snapshot(a);
        await assert.rejects(
            () => decrypt(a, replacement, untrusted),
            isSignalError(signal.ErrorCode.UntrustedIdentity),
        );
        assert.deepEqual(snapshot(a), before);
    });

    await check('sixteen bidirectional session rounds after failures', async () => {
        for (let round = 0; round < 16; round += 1) {
            for (const [sender, receiver] of [
                [a, b],
                [b, a],
            ]) {
                const plaintext = fixture(`round-${round}`);
                const envelope = await encrypt(sender, receiver, plaintext);
                assert.equal(envelope.type, signal.CiphertextMessageType.Whisper);
                samePlaintext(await decrypt(receiver, sender, envelope), plaintext);
            }
        }
        assert.ok((await a.session.getSession(b.address)).hasCurrentState());
        assert.ok((await b.session.getSession(a.address)).hasCurrentState());
    });

    console.log(`PASS all ${passed} host checks`);
}

run().catch(() => {
    // Deliberately omit assertion payloads, native errors, paths and stack traces.
    console.error(`FAIL ${activeCheck}`);
    process.exitCode = 1;
});
