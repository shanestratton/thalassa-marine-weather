import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
    fleetConsentReceipt,
    fleetRelayTokenHash,
    verifyFleetConsentReceipt,
    verifyFleetPiPayload,
} from './fleetCrypto.js';
import { AIS_FLEET_FORWARDING, type FleetForwardConsent } from './fleetForwardingWire.js';

const now = 1_800_000_000_000;
it('actual worker HMAC matches the committed shared Pi receipt fixture exactly', () => {
    const fixture = JSON.parse(
        readFileSync(new URL('../../tests/fixtures/ais-fleet140/receipt.json', import.meta.url), 'utf8'),
    );
    expect(fixture.testOnly).toBe(true);
    expect(
        fleetConsentReceipt(
            fixture.receipt.consent,
            fleetRelayTokenHash(fixture.tokenCharacter.repeat(64)),
            fixture.receipt.nonce,
        ),
    ).toEqual(fixture.receipt);
});
const token = 'e'.repeat(64);
const consent: FleetForwardConsent = {
    schema: 1,
    binding: {
        ownerId: '10000000-0000-4000-8000-000000000001',
        boatId: '20000000-0000-4000-8000-000000000001',
        piDeviceId: '30000000-0000-4000-8000-000000000001',
        relayId: 'fictional-relay-14005',
        pairingId: 'a'.repeat(64),
        controllerId: '40000000-0000-4000-8000-000000000001',
        enrollmentRevision: 'b'.repeat(64),
        sourceKey: 'c'.repeat(64),
    },
    revision: '50000000-0000-4000-8000-000000000001',
    enabled: true,
    consentVersion: AIS_FLEET_FORWARDING.consentVersion,
    issuedAt: now - 1000,
    expiresAt: now + 100_000,
};
it('only the actual scoped relay can authenticate the exact current consent receipt', () => {
    const receipt = fleetConsentReceipt(consent, fleetRelayTokenHash(token), '60000000-0000-4000-8000-000000000001');
    expect(verifyFleetConsentReceipt(receipt, token, now)).toEqual(consent);
    expect(verifyFleetConsentReceipt(receipt, 'f'.repeat(64), now)).toBeNull();
    expect(verifyFleetConsentReceipt(receipt, token, consent.expiresAt)).toBeNull();
    expect(verifyFleetConsentReceipt({ ...receipt, consent: { ...consent, enabled: false } }, token, now)).toBeNull();
    for (const field of Object.keys(consent.binding))
        expect(
            verifyFleetConsentReceipt(
                { ...receipt, consent: { ...consent, binding: { ...consent.binding, [field]: null } } },
                token,
                now,
            ),
        ).toBeNull();
    expect(verifyFleetConsentReceipt({ ...receipt, mac: '0'.repeat(64) }, token, now)).toBeNull();
    expect(
        verifyFleetConsentReceipt({ ...receipt, nonce: '60000000-0000-4000-8000-000000000002' }, token, now),
    ).toBeNull();
    expect(verifyFleetConsentReceipt({ ...receipt, extra: 'unreviewed' }, token, now)).toBeNull();
});
it('verifies the existing paired Pi payload domain and refuses another key, body, path or clock', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
    const body = '{"fictional":"exact"}',
        path = AIS_FLEET_FORWARDING.batchPath;
    const bytes = `payload|${createHash('sha256').update(body).digest('hex')}|${path}|${now}`;
    const signature = sign('sha256', Buffer.from(bytes), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString(
        'base64',
    );
    expect(verifyFleetPiPayload(spki, body, path, now, signature)).toBe(true);
    for (const [text, url, at, sig] of [
        [body + ' ', path, now, signature],
        [body, AIS_FLEET_FORWARDING.consentPath, now, signature],
        [body, path, now + 1, signature],
        [body, path, now, '0'.repeat(88)],
    ])
        expect(verifyFleetPiPayload(spki, text as string, url as string, at as number, sig as string)).toBe(false);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(
        verifyFleetPiPayload(
            createPublicKey(other.privateKey).export({ type: 'spki', format: 'der' }).toString('base64'),
            body,
            path,
            now,
            signature,
        ),
    ).toBe(false);
});
