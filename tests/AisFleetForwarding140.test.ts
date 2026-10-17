import { expect, it } from 'vitest';
import {
    AIS_FLEET_FORWARDING as LIMIT,
    fleetCoverageBounds,
    fleetCoverageCell,
    fleetForwardBatchBytes,
    fleetForwardBindingKey,
    parseFleetForwardBatch,
    parseFleetForwardBinding,
    parseFleetForwardConsent,
    validFleetAisSentence,
} from '../utils/aisFleetForwarding';

const now = 1_800_000_000_000;
const binding = {
    ownerId: '10000000-0000-4000-8000-000000000001',
    boatId: '20000000-0000-4000-8000-000000000001',
    piDeviceId: '30000000-0000-4000-8000-000000000001',
    relayId: 'fictional-relay-14005',
    pairingId: 'a'.repeat(64),
    controllerId: '40000000-0000-4000-8000-000000000001',
    enrollmentRevision: 'b'.repeat(64),
    sourceKey: 'c'.repeat(64),
};
// Existing independently bit-packed fictional vectors from the AIS decoder suite.
const received = '!AIVDM,1,1,,B,17Ojo>0011btinahKV54lSqp0000,0*6D';
const own = '!AIVDO,1,1,,B,B7Ojo>00=:g<MbL6qQAu1Sv00000,0*1F';
const batch = () => ({
    schema: 1,
    binding: { ...binding },
    consentRevision: '50000000-0000-4000-8000-000000000001',
    bootId: '60000000-0000-4000-8000-000000000001',
    sequence: 1,
    sentAt: now,
    cell: { id: 'v1:31:166', measuredAt: now - 1000 },
    observations: [{ sentence: received, receivedAt: now - 500 }],
});

it('uses one fixed coarse2° grid without disclosing exact receiver coordinates', () => {
    const id = fleetCoverageCell(-27.2, 153.08);
    expect(id).toBe('v1:31:166');
    expect(fleetCoverageBounds(id)).toEqual([152, -28, 154, -26]);
    expect(fleetCoverageCell(-27.9, 153.9)).toBe(id);
    expect(fleetCoverageCell(0, 180)).toBe(fleetCoverageCell(0, -180));
    expect(fleetCoverageBounds(fleetCoverageCell(90, 180))).toEqual([-180, 88, -178, 90]);
    expect(fleetCoverageBounds(fleetCoverageCell(-90, -180))).toEqual([-180, -90, -178, -88]);
    expect(LIMIT.minReceivers).toBe(3);
    expect(LIMIT.publicDelayMs).toBe(5 * 60_000);
    expect(LIMIT.coverageAgeMs).toBe(10 * 60_000);
});
it.each(['v1:090:0', 'v1:90:0', 'v1:0:180', 'v1:-1:1', 'v1:0:00', 'v2:1:2', 'v1:1.5:2'])(
    'refuses noncanonical cell %s',
    (id) => {
        expect(fleetCoverageBounds(id)).toBeNull();
    },
);
it('refuses nonfinite and outside-world coordinates', () => {
    for (const [lat, lon] of [
        [NaN, 0],
        [Infinity, 0],
        [91, 0],
        [0, -181],
        ['-27', 153],
    ])
        expect(fleetCoverageCell(lat, lon)).toBeNull();
});
it('binds each account, vessel, Pi, pairing, enrolled controller and source independently', () => {
    expect(parseFleetForwardBinding(binding)).toEqual(binding);
    const key = fleetForwardBindingKey(binding);
    for (const field of Object.keys(binding)) {
        expect(parseFleetForwardBinding({ ...binding, [field]: null })).toBeNull();
        expect(fleetForwardBindingKey({ ...binding, [field]: 'changed' })).not.toBe(key);
    }
    expect(parseFleetForwardBinding({ ...binding, cloudToken: 'must not be in consent' })).toBeNull();
});
it('consent is explicit versioned bounded authorization data, with no migration from phone sharing', () => {
    const consent = {
        schema: 1,
        binding,
        revision: batch().consentRevision,
        enabled: true,
        consentVersion: LIMIT.consentVersion,
        issuedAt: now - 1000,
        expiresAt: now + 100_000,
    };
    expect(parseFleetForwardConsent(consent, now)).toEqual(consent);
    for (const change of [
        { enabled: undefined },
        { enabled: 'true' },
        { consentVersion: '2026-10-10' },
        { issuedAt: now + 1 },
        { expiresAt: now },
        { expiresAt: now + LIMIT.grantMaxMs + 1 },
        { oldPhoneConsent: true },
    ])
        expect(parseFleetForwardConsent({ ...consent, ...change }, now)).toBeNull();
    expect(parseFleetForwardConsent({ ...consent, enabled: false }, now)?.enabled).toBe(false);
});
it('accepts real checksum-valid observations and refuses framing, checksum, payload and fragment faults', () => {
    expect(validFleetAisSentence(received)).toBe(true);
    expect(validFleetAisSentence(own)).toBe(true);
    for (const line of [
        received + '\r\n',
        received + received,
        received.slice(0, -1) + '0',
        received.replace('17O', '17X'),
        '$GPGLL,153,-27',
        received.replace(',1,1,', ',1,2,'),
        received.repeat(3),
    ])
        expect(validFleetAisSentence(line)).toBe(false);
});
it('parses and canonically serializes a fresh fictional batch without own receiver position fields', () => {
    const value = batch(),
        parsed = parseFleetForwardBatch(value, now);
    expect(parsed).toEqual(value);
    expect(fleetForwardBatchBytes(parsed!)).toBe(JSON.stringify(value));
    expect(fleetForwardBatchBytes(parsed!)).not.toMatch(/latitude|longitude|"lat"|"lon"/);
    value.observations[0].sentence = own;
    expect(parseFleetForwardBatch(value, now)).toBeNull();
    value.cell = null as unknown as typeof value.cell;
    expect(parseFleetForwardBatch(value, now)?.observations[0].sentence).toBe(own);
});
it.each([
    { schema: 2 },
    { sequence: 0 },
    { sequence: 1.5 },
    { sequence: 2_147_483_648 },
    { sentAt: now + 1 },
    { sentAt: now - LIMIT.requestAgeMs - 1 },
    { consentRevision: null },
    { bootId: null },
    { observations: [] },
    { providerPolled: true },
    { observations: [{ sentence: received, receivedAt: now + 1 }] },
    { observations: [{ sentence: received, receivedAt: now - LIMIT.observationAgeMs - 1 }] },
    { observations: [{ sentence: received, receivedAt: now, lat: -27 }] },
    { cell: { id: 'v1:31:166', measuredAt: now - LIMIT.fixAgeMs - 1 } },
    { cell: { id: 'v1:31:166', measuredAt: now, lat: -27 } },
])('refuses stale/unbound/extra batch fields: %j', (change) => {
    expect(parseFleetForwardBatch({ ...batch(), ...change }, now)).toBeNull();
});
it('keeps fixed caps and never fabricates receiver observations from a provider box or ownship fix', () => {
    const value = batch();
    value.observations = Array.from({ length: LIMIT.maxSentences + 1 }, () => value.observations[0]);
    expect(parseFleetForwardBatch(value, now)).toBeNull();
    expect(
        parseFleetForwardBatch({ ...batch(), observations: [{ lat: -27, lon: 153, receivedAt: now }] }, now),
    ).toBeNull();
    expect(
        parseFleetForwardBatch(
            { ...batch(), observations: [{ providerBox: [152, -28, 154, -26], receivedAt: now }] },
            now,
        ),
    ).toBeNull();
});
