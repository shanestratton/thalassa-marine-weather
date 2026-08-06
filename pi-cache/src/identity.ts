import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    sign as cryptoSign,
    type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Pi identity for app pairing.
 *
 * The app pairs with this Pi trust-on-first-use: at pairing time it pins the
 * public key below, and on every later connection it sends a random nonce and
 * requires a signature over it before it will talk to us. A device that
 * answers `calypso.local` on some marina network without holding the private
 * key cannot produce that signature, so the app refuses it — that is the
 * defence against the mDNS-spoofing attack flagged in APP_AUDIT_2026-08-03.
 *
 * Curve is P-256 (not Ed25519) because the verifier is WebCrypto inside an iOS
 * WKWebView, and ECDSA P-256 is the interoperable choice there. Signatures are
 * IEEE P1363 (raw r||s) for the same reason — WebCrypto does not accept DER.
 *
 * The private key never leaves this file's directory and the identity file is
 * written 0600. Losing it is harmless-but-annoying: the Pi gets a fresh
 * identity and every paired device asks to re-pair.
 */

export interface PiIdentity {
    /** Stable UUID minted the first time this Pi boots pi-cache. */
    deviceId: string;
    /** Human-facing name shown in the app's pairing card. */
    boatName: string;
    /** SPKI DER, base64 — what the app pins. */
    publicKeySpki: string;
    /** SHA-256 of the SPKI DER, hex pairs — human-checkable at pairing time. */
    fingerprint: string;
    signChallenge(nonce: string, timestamp: number): string;
    signPayload(bodySha256Hex: string, path: string, timestamp: number): string;
}

interface PersistedIdentity {
    version: 1;
    deviceId: string;
    privateKeyPem: string;
    createdAt: string;
}

/** Bound the nonce we are willing to sign — we sign caller-supplied data, so
 * never sign anything of unbounded size or with our own delimiter in it. */
export const MAX_NONCE_LENGTH = 128;
const FIELD_SEPARATOR = '|';

function fingerprintOf(spkiDer: Buffer): string {
    const hex = createHash('sha256').update(spkiDer).digest('hex').toUpperCase();
    // First 8 bytes as AA:BB:… — enough to compare by eye, short enough to.
    return hex.slice(0, 16).replace(/(..)(?=.)/g, '$1:');
}

/**
 * The identity private key, in PKCS#8 PEM — for `ensureIdentityTls` only.
 *
 * Deliberately NOT a field on PiIdentity. That object is handed to route
 * handlers (createPairRoutes, sendSignedJson), and a private key sitting on it
 * is one careless `res.json(identity)` away from being served to the LAN. The
 * signing closures above are the only other thing that touches this key, and
 * they never expose it. Call this once, at boot, in the server entry point.
 */
export function readIdentityPrivateKeyPem(dataDir: string): string {
    const identityPath = resolve(dataDir, 'identity.json');
    const parsed = JSON.parse(readFileSync(identityPath, 'utf8')) as PersistedIdentity;
    if (!parsed?.privateKeyPem)
        throw new Error(`No Pi identity key at ${identityPath} — call loadOrCreateIdentity first`);
    return parsed.privateKeyPem;
}

export function loadOrCreateIdentity(dataDir: string, boatName?: string): PiIdentity {
    const identityPath = resolve(dataDir, 'identity.json');

    let persisted: PersistedIdentity | null = null;
    if (existsSync(identityPath)) {
        try {
            const parsed = JSON.parse(readFileSync(identityPath, 'utf8')) as PersistedIdentity;
            if (parsed.version === 1 && parsed.deviceId && parsed.privateKeyPem) persisted = parsed;
        } catch {
            /* corrupt — regenerate below; paired devices will re-pair */
        }
    }

    if (!persisted) {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        persisted = {
            version: 1,
            deviceId: randomUUID(),
            privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            createdAt: new Date().toISOString(),
        };
        mkdirSync(dirname(identityPath), { recursive: true });
        writeFileSync(identityPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
        console.log(`[identity] new Pi identity created: ${persisted.deviceId}`);
    }

    const privateKey: KeyObject = createPrivateKey(persisted.privateKeyPem);
    const publicKey = createPublicKey(privateKey);
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

    const deviceId = persisted.deviceId;

    const signFields = (fields: string[]): string => {
        const data = Buffer.from(fields.join(FIELD_SEPARATOR), 'utf8');
        return cryptoSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    };

    return {
        deviceId,
        boatName: boatName || process.env.PI_BOAT_NAME || hostname(),
        publicKeySpki: spkiDer.toString('base64'),
        fingerprint: fingerprintOf(spkiDer),
        signChallenge: (nonce: string, timestamp: number): string => {
            if (nonce.length > MAX_NONCE_LENGTH || nonce.includes(FIELD_SEPARATOR)) {
                throw new Error('invalid nonce');
            }
            return signFields(['challenge', nonce, String(timestamp), deviceId]);
        },
        signPayload: (bodySha256Hex: string, path: string, timestamp: number): string =>
            signFields(['payload', bodySha256Hex, path, String(timestamp)]),
    };
}
