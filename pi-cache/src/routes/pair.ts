import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { Router, type Request, type Response } from 'express';
import { MAX_NONCE_LENGTH, type PiIdentity } from '../identity.js';

/**
 * Pairing endpoints — the server half of the app's trust-on-first-use flow.
 *
 *   GET  /api/pair/info       what to show on the pairing card, incl. the
 *                             public key the app will pin
 *   POST /api/pair/challenge  {nonce} → signature proving we hold the key
 *
 * Neither endpoint is secret or rate-limited beyond nonce bounds: `info` is
 * public by design (the key is public), and `challenge` signs only
 * caller-random nonces under a fixed 'challenge' domain prefix, so it cannot
 * be abused to forge payload signatures (different prefix) or sign chosen
 * plaintext of consequence.
 */
export function createPairRoutes(identity: PiIdentity): Router {
    const router = Router();

    router.get('/info', (_req: Request, res: Response) => {
        res.json({
            service: 'thalassa-pi-cache',
            deviceId: identity.deviceId,
            boatName: identity.boatName,
            hostname: hostname(),
            publicKeySpki: identity.publicKeySpki,
            fingerprint: identity.fingerprint,
            pairingVersion: 1,
        });
    });

    router.post('/challenge', (req: Request, res: Response) => {
        const nonce = (req.body as { nonce?: unknown })?.nonce;
        if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > MAX_NONCE_LENGTH) {
            return res.status(400).json({ error: `nonce must be a string of 1..${MAX_NONCE_LENGTH} chars` });
        }
        const timestamp = Date.now();
        let signature: string;
        try {
            signature = identity.signChallenge(nonce, timestamp);
        } catch {
            return res.status(400).json({ error: 'nonce rejected' });
        }
        res.json({ deviceId: identity.deviceId, timestamp, signature });
    });

    return router;
}

/**
 * Wrap a JSON payload with a detached signature the app can verify against
 * the pinned key. Used by the safety-critical ENC endpoints: mDNS gets an
 * attacker to the front door and the challenge stops impersonation at
 * connect, but these headers are what stop an on-path attacker tampering
 * with chart data mid-transfer.
 *
 * Contract (mirrored in the app's PiPairingService):
 *   X-Pi-Signature: base64 ECDSA-P256(ieee-p1363) over
 *                   "payload|<sha256hex(body)>|<path>|<timestamp>"
 *   X-Pi-Signature-Time: <timestamp ms>
 *
 * The path is bound so a valid response for one cell cannot be replayed for
 * another; the timestamp is informational (the app logs wild skew but does
 * not hard-fail on it — boat Pis drift, and the body hash + path are what
 * carry the integrity guarantee).
 */
export function sendSignedJson(identity: PiIdentity, req: Request, res: Response, payload: unknown): void {
    // Cell data is stored pre-serialized on disk; signing the exact bytes we
    // send avoids a parse/re-stringify round trip on multi-MB payloads.
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
    // originalUrl minus the query — the app binds the pathname it requested.
    const path = (req.originalUrl || req.url).split('?')[0];
    const timestamp = Date.now();
    res.setHeader('X-Pi-Signature', identity.signPayload(bodyHash, path, timestamp));
    res.setHeader('X-Pi-Signature-Time', String(timestamp));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(body);
}
