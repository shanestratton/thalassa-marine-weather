/** Scoped relay-HMAC consent receipt plus the Pi's existing P256 payload signature.
 * No new signing key or service-role credential is installed on the Pi. */
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { fleetForwardConsentBytes, parseFleetForwardConsent, type FleetForwardConsent } from './fleetForwardingWire.js';

const hash = /^[a-f0-9]{64}$/;
export function fleetRelayTokenHash(token: string): string {
    if (!hash.test(token)) throw Error('Invalid scoped relay credential');
    return createHash('sha256').update(token).digest('hex');
}
export interface FleetConsentReceipt {
    consent: FleetForwardConsent;
    mac: string;
}
export function fleetConsentReceipt(consent: FleetForwardConsent, tokenHash: string): FleetConsentReceipt {
    if (!hash.test(tokenHash)) throw Error('Invalid scoped relay digest');
    return {
        consent,
        mac: createHmac('sha256', Buffer.from(tokenHash, 'hex'))
            .update('thalassa-pi-fleet-consent-v1\n' + fleetForwardConsentBytes(consent))
            .digest('hex'),
    };
}
export function verifyFleetConsentReceipt(value: unknown, relayToken: string, now: number): FleetForwardConsent | null {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const row = value as Record<string, unknown>;
        if (
            Object.keys(row).length !== 2 ||
            !Object.hasOwn(row, 'consent') ||
            !Object.hasOwn(row, 'mac') ||
            typeof row.mac !== 'string' ||
            !hash.test(row.mac)
        )
            return null;
        const consent = parseFleetForwardConsent(row.consent, now);
        if (!consent) return null;
        const expected = fleetConsentReceipt(consent, fleetRelayTokenHash(relayToken)).mac;
        return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(row.mac, 'hex')) ? consent : null;
    } catch {
        return null;
    }
}

/** Same 'payload|sha256|path|time' domain already signed by PiIdentity.signPayload.
 * The caller supplies its fixed protocol path and parsed original timestamp. */
export function verifyFleetPiPayload(spki: string, body: string, path: string, at: number, signature: string): boolean {
    try {
        if (
            !/^[A-Za-z0-9+/]{80,256}={0,2}$/.test(spki) ||
            !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
            !Number.isSafeInteger(at) ||
            at <= 0 ||
            !['/pi-fleet-feed/v1', '/pi-fleet-consent/v1'].includes(path)
        )
            return false;
        const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
        const bytes = `payload|${createHash('sha256').update(body).digest('hex')}|${path}|${at}`;
        return verify(
            'sha256',
            Buffer.from(bytes),
            { key, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signature, 'base64'),
        );
    } catch {
        return false;
    }
}
