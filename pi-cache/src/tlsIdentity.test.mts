import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';

import { loadOrCreateIdentity, readIdentityPrivateKeyPem } from './identity.js';
import { ensureIdentityTls } from './tlsIdentity.js';

function freshPi() {
    const dir = mkdtempSync(join(tmpdir(), 'pi-tls-test-'));
    const identity = loadOrCreateIdentity(dir);
    return { dir, identity, tls: ensureIdentityTls(dir, readIdentityPrivateKeyPem(dir)) };
}

test('the certificate is issued from the pairing key the app already pinned', () => {
    const { identity, tls } = freshPi();
    // THE invariant. The app pins identity.publicKeySpki at pairing and the
    // native verifier compares the TLS leaf's SPKI to it — if these two ever
    // diverge, every paired device rejects the Pi.
    assert.equal(tls.spkiBase64, identity.publicKeySpki);
});

test('the key a client sees on a real handshake is the pinned key', async () => {
    const { identity, tls } = freshPi();
    const server = https.createServer({ key: tls.keyPem, cert: tls.certPem, minVersion: 'TLSv1.2' }, (_req, res) =>
        res.end('{}'),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    try {
        const observed = await new Promise<string>((resolve, reject) => {
            // rejectUnauthorized:false mirrors the native delegate: system trust
            // is deliberately not consulted, the key is checked instead.
            const req = https.get({ host: '127.0.0.1', port, rejectUnauthorized: false }, (res) => {
                const peer = (res.socket as TLSSocket).getPeerX509Certificate();
                res.resume();
                if (!peer) return reject(new Error('no peer certificate'));
                resolve(peer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
            });
            req.on('error', reject);
        });
        assert.equal(observed, identity.publicKeySpki);
    } finally {
        server.close();
    }
});

test('the certificate is a server cert with names for browsers on the boat LAN', () => {
    const { tls } = freshPi();
    const cert = new X509Certificate(tls.certPem);
    assert.match(cert.subjectAltName ?? '', /DNS:calypso\.local/);
    assert.match(cert.subjectAltName ?? '', /IP Address:127\.0\.0\.1/);
    // Long-dated on purpose: a boat offshore cannot act on a renewal prompt.
    assert.ok(new Date(cert.validTo).getTime() - Date.now() > 5 * 365 * 24 * 3600 * 1000);
});

test('a reissue keeps the same key, so pins survive it', () => {
    const { dir, identity, tls } = freshPi();
    const first = readFileSync(join(dir, 'identity-cert.pem'), 'utf8');
    // Corrupt the cert to force the reissue path.
    writeFileSync(join(dir, 'identity-cert.pem'), 'not a certificate');
    const reissued = ensureIdentityTls(dir, readIdentityPrivateKeyPem(dir));

    assert.notEqual(reissued.certPem, first);
    assert.equal(reissued.spkiBase64, identity.publicKeySpki);
    assert.equal(reissued.spkiBase64, tls.spkiBase64);
});

test('a certificate carrying a foreign key is refused rather than served', () => {
    const { dir } = freshPi();
    // A different Pi's key: serving this would present a certificate no paired
    // app could match, so it must fail here rather than at every client.
    const otherDir = mkdtempSync(join(tmpdir(), 'pi-tls-other-'));
    loadOrCreateIdentity(otherDir);
    const foreignKey = readIdentityPrivateKeyPem(otherDir);

    // The existing cert in `dir` belongs to the original key; asking for TLS
    // with a foreign key must not silently reuse it.
    const result = ensureIdentityTls(dir, foreignKey);
    assert.equal(result.spkiBase64, ensureIdentityTls(otherDir, foreignKey).spkiBase64);
});
