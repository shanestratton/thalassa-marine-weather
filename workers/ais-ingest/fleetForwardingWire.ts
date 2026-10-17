/** Portable140-05 wire limits only. Parsing proves shape/freshness, never consent or rights.
 * Receiver location is reduced aboard to a fixed2° cell. Public coverage requires
 * separate delayed three-receiver admission; provider poll boxes are not evidence. */
export const AIS_FLEET_FORWARDING = Object.freeze({
    schema: 1,
    consentVersion: '2026-10-17-pi-v1',
    batchPath: '/pi-fleet-feed/v1',
    consentPath: '/pi-fleet-consent/v1',
    batchBytes: 128 * 1024,
    maxSentences: 600,
    sentenceBytes: 120,
    observationAgeMs: 30_000,
    fixAgeMs: 13_000,
    requestAgeMs: 10_000,
    grantMaxMs: 30 * 24 * 60 * 60_000,
    publicDelayMs: 5 * 60_000,
    coverageAgeMs: 10 * 60_000,
    minReceivers: 3,
    publicCells: 256,
    cellDegrees: 2,
});
export interface FleetForwardBinding {
    ownerId: string;
    boatId: string;
    piDeviceId: string;
    relayId: string;
    pairingId: string;
    controllerId: string;
    enrollmentRevision: string;
    sourceKey: string;
}
export interface FleetForwardConsent {
    schema: 1;
    binding: FleetForwardBinding;
    revision: string;
    enabled: boolean;
    consentVersion: typeof AIS_FLEET_FORWARDING.consentVersion;
    issuedAt: number;
    expiresAt: number;
}
export interface FleetForwardObservation {
    sentence: string;
    receivedAt: number;
}
export interface FleetForwardBatch {
    schema: 1;
    binding: FleetForwardBinding;
    consentRevision: string;
    bootId: string;
    sequence: number;
    sentAt: number;
    cell: { id: string; measuredAt: number } | null;
    observations: FleetForwardObservation[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
export const fleetUuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const stamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const current = (at: unknown, now: number, age: number): at is number =>
    stamp(at) && stamp(now) && at <= now && now - at <= age;

export function parseFleetForwardBinding(value: unknown): FleetForwardBinding | null {
    if (
        !object(value) ||
        !exact(value, [
            'ownerId',
            'boatId',
            'piDeviceId',
            'relayId',
            'pairingId',
            'controllerId',
            'enrollmentRevision',
            'sourceKey',
        ]) ||
        !fleetUuid(value.ownerId) ||
        !fleetUuid(value.boatId) ||
        !fleetUuid(value.piDeviceId) ||
        !fleetUuid(value.controllerId) ||
        typeof value.relayId !== 'string' ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(value.relayId) ||
        !hash(value.pairingId) ||
        !hash(value.enrollmentRevision) ||
        !hash(value.sourceKey)
    )
        return null;
    return {
        ownerId: value.ownerId,
        boatId: value.boatId,
        piDeviceId: value.piDeviceId,
        relayId: value.relayId,
        pairingId: value.pairingId,
        controllerId: value.controllerId,
        enrollmentRevision: value.enrollmentRevision,
        sourceKey: value.sourceKey,
    };
}
export const fleetForwardBindingKey = (value: FleetForwardBinding): string =>
    JSON.stringify([
        value.ownerId,
        value.boatId,
        value.piDeviceId,
        value.relayId,
        value.pairingId,
        value.controllerId,
        value.enrollmentRevision,
        value.sourceKey,
    ]);

export function parseFleetForwardConsent(value: unknown, now: number): FleetForwardConsent | null {
    if (
        !object(value) ||
        !exact(value, ['schema', 'binding', 'revision', 'enabled', 'consentVersion', 'issuedAt', 'expiresAt']) ||
        value.schema !== 1 ||
        !fleetUuid(value.revision) ||
        typeof value.enabled !== 'boolean' ||
        value.consentVersion !== AIS_FLEET_FORWARDING.consentVersion ||
        !stamp(value.issuedAt) ||
        !stamp(value.expiresAt) ||
        !stamp(now) ||
        value.issuedAt > now ||
        value.expiresAt <= now ||
        value.expiresAt <= value.issuedAt ||
        value.expiresAt - value.issuedAt > AIS_FLEET_FORWARDING.grantMaxMs
    )
        return null;
    const binding = parseFleetForwardBinding(value.binding);
    return binding
        ? {
              schema: 1,
              binding,
              revision: value.revision,
              enabled: value.enabled,
              consentVersion: AIS_FLEET_FORWARDING.consentVersion,
              issuedAt: value.issuedAt,
              expiresAt: value.expiresAt,
          }
        : null;
}

/** Canonical fixed-grid identity, with no receiver coordinate in the wire. */
export function fleetCoverageCell(lat: unknown, lon: unknown): string | null {
    if (
        typeof lat !== 'number' ||
        typeof lon !== 'number' ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
    )
        return null;
    const x = Math.floor(((lon === 180 ? -180 : lon) + 180) / 2),
        y = Math.min(89, Math.floor((lat + 90) / 2));
    return `v1:${y}:${x}`;
}
export function fleetCoverageBounds(id: unknown): [number, number, number, number] | null {
    if (typeof id !== 'string') return null;
    const match = /^v1:(0|[1-9]\d?):(0|[1-9]\d{0,2})$/.exec(id);
    if (!match || Number(match[1]) > 89 || Number(match[2]) > 179) return null;
    const south = Number(match[1]) * 2 - 90,
        west = Number(match[2]) * 2 - 180;
    return [west, south, west + 2, south + 2];
}

/** A real raw sentence only; never constructs AIS from phone/Pi ownship fixes. */
export function validFleetAisSentence(value: unknown): value is string {
    if (
        typeof value !== 'string' ||
        value.length > AIS_FLEET_FORWARDING.sentenceBytes ||
        !/^!AIVD[MO],[1-9],[1-9],[0-9]?,[AB12]?,[0-9:;<=>?@A-W`a-w]+,[0-5]\*[0-9A-Fa-f]{2}$/.test(value)
    )
        return false;
    const fields = value.split(',');
    if (Number(fields[2]) > Number(fields[1])) return false;
    const star = value.length - 3;
    let checksum = 0;
    for (let i = 1; i < star; i++) checksum ^= value.charCodeAt(i);
    return checksum === Number.parseInt(value.slice(-2), 16);
}

export function parseFleetForwardBatch(value: unknown, now: number): FleetForwardBatch | null {
    if (
        !object(value) ||
        !exact(value, [
            'schema',
            'binding',
            'consentRevision',
            'bootId',
            'sequence',
            'sentAt',
            'cell',
            'observations',
        ]) ||
        value.schema !== 1 ||
        !fleetUuid(value.consentRevision) ||
        !fleetUuid(value.bootId) ||
        typeof value.sequence !== 'number' ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        value.sequence > 2_147_483_647 ||
        !current(value.sentAt, now, AIS_FLEET_FORWARDING.requestAgeMs) ||
        !Array.isArray(value.observations) ||
        value.observations.length < 1 ||
        value.observations.length > AIS_FLEET_FORWARDING.maxSentences
    )
        return null;
    const binding = parseFleetForwardBinding(value.binding);
    if (!binding) return null;
    const observations: FleetForwardObservation[] = [];
    for (const row of value.observations) {
        if (
            !object(row) ||
            !exact(row, ['sentence', 'receivedAt']) ||
            !validFleetAisSentence(row.sentence) ||
            !current(row.receivedAt, now, AIS_FLEET_FORWARDING.observationAgeMs) ||
            row.receivedAt > value.sentAt
        )
            return null;
        observations.push({ sentence: row.sentence, receivedAt: row.receivedAt });
    }
    let cell: FleetForwardBatch['cell'] = null;
    if (value.cell !== null) {
        if (
            !object(value.cell) ||
            !exact(value.cell, ['id', 'measuredAt']) ||
            !fleetCoverageBounds(value.cell.id) ||
            !current(value.cell.measuredAt, now, AIS_FLEET_FORWARDING.fixAgeMs) ||
            value.cell.measuredAt > value.sentAt ||
            !observations.some((row) => row.sentence.startsWith('!AIVDM'))
        )
            return null;
        cell = { id: value.cell.id as string, measuredAt: value.cell.measuredAt };
    }
    return {
        schema: 1,
        binding,
        consentRevision: value.consentRevision,
        bootId: value.bootId,
        sequence: value.sequence,
        sentAt: value.sentAt,
        cell,
        observations,
    };
}

/** Signs this exact order; caller must still verify the paired P256 signature,
 * live service consent revision, replay admission and inherited fleet budget. */
export const fleetForwardBatchBytes = (batch: FleetForwardBatch): string =>
    JSON.stringify({
        schema: 1,
        binding: parseFleetForwardBinding(batch.binding),
        consentRevision: batch.consentRevision,
        bootId: batch.bootId,
        sequence: batch.sequence,
        sentAt: batch.sentAt,
        cell: batch.cell,
        observations: batch.observations.map((row) => ({ sentence: row.sentence, receivedAt: row.receivedAt })),
    });
