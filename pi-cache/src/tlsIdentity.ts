import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

/**
 * TLS for the boat LAN, anchored to the Pi's EXISTING pairing identity.
 *
 * The problem this solves
 * ──────────────────────
 * Pairing already gave us authentication and integrity: the app pins this Pi's
 * P-256 public key and every navigation payload is signed over
 * (body hash | path | time). Nothing on a marina network can forge Pi data.
 * What it never gave us is confidentiality — the transport was plain HTTP, so
 * anyone on the same Wi-Fi could READ it, and the diary relay hands a token
 * across that wire. That single gap is why Pi integration was held out of the
 * public beta.
 *
 * Why self-signed is the right answer here, not a compromise
 * ─────────────────────────────────────────────────────────
 * A CA-issued certificate needs a public hostname, DNS control, and internet
 * reachability to issue and renew. A boat 200 nm offshore has none of those,
 * and a certificate that expires mid-passage is a chartplotter that stops
 * working in exactly the conditions it exists for. So we issue our own, from
 * the key the app has ALREADY pinned:
 *
 *     cert public key  ==  identity.publicKeySpki  ==  what the app pinned
 *
 * The app therefore validates the TLS channel by comparing the leaf
 * certificate's SubjectPublicKeyInfo against the key it pinned at pairing —
 * see ios/App/App/PiTlsPlugin.swift. It does not consult the system trust
 * store, so no CA, no expiry cliff, no internet. The trust decision stays
 * exactly where it already was (the one human "is this my boat's Pi?" at
 * pairing) and gains encryption for free. There is no new thing to trust.
 *
 * This binds the TLS channel to the pairing identity: an on-path box cannot
 * terminate TLS without the private key, and the private key is the same one
 * it already could not produce a challenge signature with.
 *
 * Hostnames are cosmetic here
 * ───────────────────────────
 * SANs are filled in for the benefit of laptop browsers on the boat LAN, which
 * DO check names. The app deliberately does not: PiPairingService's model is
 * "identity is the key, not the host" (a Pi that moves from calypso.local to a
 * DHCP address is the same Pi), so the native pin checks the key alone.
 *
 * openssl rather than a library: it is present on every Raspberry Pi OS image,
 * it speaks EC natively, and it adds no dependency to a box that may never see
 * a package registry again after install.
 */

/** Ten years. Pinned certificates have no CA lifetime policy to satisfy, and a
 *  renewal prompt is not something a boat offshore can act on. Re-issued
 *  automatically below once inside the last 30 days regardless. */
const CERT_VALIDITY_DAYS = 3650;
const REISSUE_WITHIN_MS = 30 * 24 * 3600 * 1000;

export interface PiTlsMaterial {
    /** PKCS#8 PEM — the SAME key as the pairing identity. */
    keyPem: string;
    /** Self-signed X.509 PEM whose public key is the pinned identity key. */
    certPem: string;
    /** Base64 SPKI DER — identical to PiIdentity.publicKeySpki, by construction. */
    spkiBase64: string;
    /** SHA-256 of the certificate DER, hex pairs. Shown at pairing for eyeball checks. */
    certFingerprint: string;
    notAfter: string;
}

function sanList(): string[] {
    const names = new Set<string>(['localhost', hostname(), `${hostname()}.local`, 'calypso.local']);
    const dns = [...names]
        .filter(Boolean)
        .map((n) => n.replace(/\.$/, ''))
        .map((n) => `DNS:${n}`);

    const ips = new Set<string>(['127.0.0.1', '::1']);
    for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
            // Every address the Pi currently answers on. Re-issued on change
            // below, so a DHCP move does not leave a stale SAN behind.
            if (addr.address) ips.add(addr.address.replace(/%.*$/, ''));
        }
    }
    return [...dns, ...[...ips].map((ip) => `IP:${ip}`)];
}

function fingerprintOf(der: Buffer): string {
    const hex = createHash('sha256').update(der).digest('hex').toUpperCase();
    return hex.slice(0, 16).replace(/(..)(?=.)/g, '$1:');
}

function spkiOf(keyPem: string): string {
    const publicKey = createPublicKey(createPrivateKey(keyPem));
    return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * The names an existing certificate must already cover, in the vocabulary
 * X509Certificate.subjectAltName actually uses.
 *
 * openssl is TOLD `IP:127.0.0.1`; Node reads that back as
 * `IP Address:127.0.0.1`. Comparing the request form against the read-back
 * form never matches, which silently re-issued the certificate on EVERY boot —
 * caught on Calypso 2026-08-06 by two restarts producing two different cert
 * fingerprints from one unchanged key. Harmless to pinning (the key is what is
 * pinned, and that never moves) but it made the reuse path dead code.
 *
 * IPv6 is deliberately excluded from the comparison. Node expands and
 * upper-cases it (`FE80:0:0:0:8AA2:...`) where the interface reports
 * `fe80::8aa2:...`, and link-local addresses churn on their own; requiring
 * them would reintroduce the same always-reissue behaviour by a subtler route.
 * They are still PUT in the certificate — just not used to judge staleness.
 */
function requiredSanEntries(sans: string[]): string[] {
    return sans
        .filter((san) => san.startsWith('DNS:') || (san.startsWith('IP:') && san.includes('.')))
        .map((san) => san.replace(/^IP:/, 'IP Address:'));
}

/**
 * True when the existing certificate still covers this Pi: same key, not near
 * expiry, and every name/IPv4 it currently answers on is still present. The
 * last check is what makes a DHCP move self-healing rather than a silent
 * breakage for laptop browsers.
 */
function certStillFits(certPem: string, expectedSpki: string, wanted: string[]): boolean {
    try {
        const cert = new X509Certificate(certPem);
        if (cert.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') !== expectedSpki) return false;
        if (new Date(cert.validTo).getTime() - Date.now() < REISSUE_WITHIN_MS) return false;
        const present = new Set((cert.subjectAltName ?? '').split(/,\s*/).map((s) => s.trim()));
        return requiredSanEntries(wanted).every((san) => present.has(san));
    } catch {
        return false;
    }
}

/**
 * Issue (or reuse) the TLS material for this Pi, keyed to its pairing identity.
 *
 * `identityPrivateKeyPem` is the key already persisted by loadOrCreateIdentity.
 * Reusing it — rather than minting a second keypair — is the entire point: it
 * means the app's existing pin is the TLS trust anchor, with no new pairing
 * concept and no second thing for the skipper to verify.
 */
export function ensureIdentityTls(dataDir: string, identityPrivateKeyPem: string): PiTlsMaterial {
    mkdirSync(dataDir, { recursive: true });
    const keyPath = resolve(dataDir, 'identity-key.pem');
    const certPath = resolve(dataDir, 'identity-cert.pem');

    // openssl needs the key as a file. Same bytes as identity.json already
    // holds, written 0600 beside it.
    writeFileSync(keyPath, identityPrivateKeyPem, { mode: 0o600 });

    const expectedSpki = spkiOf(identityPrivateKeyPem);
    const wantedSans = sanList();

    let certPem = existsSync(certPath) ? readFileSync(certPath, 'utf8') : '';
    if (!certStillFits(certPem, expectedSpki, wantedSans)) {
        try {
            execFileSync(
                'openssl',
                [
                    'req',
                    '-x509',
                    '-new',
                    '-key',
                    keyPath,
                    '-sha256',
                    '-days',
                    String(CERT_VALIDITY_DAYS),
                    '-subj',
                    `/CN=Thalassa Pi ${hostname()}/O=Thalassa Boat LAN`,
                    '-addext',
                    `subjectAltName=${wantedSans.join(',')}`,
                    '-addext',
                    'basicConstraints=critical,CA:FALSE',
                    '-addext',
                    'keyUsage=critical,digitalSignature,keyEncipherment',
                    '-addext',
                    'extendedKeyUsage=serverAuth',
                    '-out',
                    certPath,
                ],
                { stdio: ['ignore', 'ignore', 'pipe'] },
            );
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Could not issue the boat-LAN TLS certificate with openssl (${detail}). ` +
                    'Install it with `sudo apt install openssl` and restart pi-cache — ' +
                    'the app will not talk to an unencrypted Pi.',
            );
        }
        certPem = readFileSync(certPath, 'utf8');
        console.log(`[tls] issued boat-LAN certificate for ${wantedSans.length} names/addresses`);
    }

    const cert = new X509Certificate(certPem);
    const spkiBase64 = cert.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    // The whole design rests on this equality. If it ever fails, every paired
    // app would reject the channel with a confusing pin mismatch — fail here,
    // loudly, where the cause is obvious.
    if (spkiBase64 !== expectedSpki) {
        throw new Error('TLS certificate public key does not match the Pi pairing identity — refusing to serve');
    }

    return {
        keyPem: identityPrivateKeyPem,
        certPem,
        spkiBase64,
        certFingerprint: fingerprintOf(cert.raw),
        notAfter: cert.validTo,
    };
}
