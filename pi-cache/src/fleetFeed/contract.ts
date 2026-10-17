import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
    fleetForwardConsentBytes,
    parseFleetForwardConsent,
    fleetUuid,
    type FleetForwardBinding,
    type FleetForwardConsent,
} from '../fleetFeedWire.js';

export const FLEET_LOCAL_BYTES = 12 * 1024;
export const fleetHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface FleetReceipt {
    consent: FleetForwardConsent;
    nonce: string;
    mac: string;
}
export interface FleetPiContext {
    binding: FleetForwardBinding;
    /** Borrowed only from the Pi's existing private scoped relay store. */
    token: string;
    allowInternet: boolean;
    /** Fresh ordinary boat source fix, reduced to a cell aboard. No exact position is sent. */
    cell: { id: string; measuredAt: number } | null;
}
export function verifyFleetReceipt(raw: unknown, token: string, now: number): FleetReceipt | null {
    if (!/^[a-f0-9]{64}$/.test(token) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const v = raw as Record<string, unknown>,
        consent = parseFleetForwardConsent(v.consent, now);
    if (
        !consent ||
        Object.keys(v).length !== 3 ||
        !fleetUuid(v.nonce) ||
        typeof v.mac !== 'string' ||
        !/^[a-f0-9]{64}$/.test(v.mac)
    )
        return null;
    const expected = createHmac('sha256', Buffer.from(fleetHash(token), 'hex'))
        .update('thalassa-pi-fleet-consent-v1\n' + fleetForwardConsentBytes(consent) + '\n' + v.nonce)
        .digest();
    return timingSafeEqual(expected, Buffer.from(v.mac, 'hex')) ? { consent, nonce: v.nonce, mac: v.mac } : null;
}
