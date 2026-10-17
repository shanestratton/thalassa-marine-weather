/** Private instrument evidence protocol. No network, storage, DOM or provider imports. */
export const OWN_BOAT_SKILL = Object.freeze({
    version: 1,
    consentMs: 14 * 86400_000,
    prepareMs: 60_000,
    readMs: 15 * 60_000,
    operationMs: 20_000,
    ownerProofMs: 10_000,
    piReadMs: 12_000,
    requestBytes: 16 * 1024,
    responseBytes: 128 * 1024,
    forecastBytes: 128 * 1024,
    forecastStoreBytes: 32 * 1024 * 1024,
    sampleCount: 337,
    windowMs: 14 * 86400_000,
});
export const OWN_BOAT_MODELS = [
    'ecmwf_ifs025',
    'ecmwf_aifs025_single',
    'dwd_icon',
    'ukmo_global_deterministic_10km',
    'jma_gsm',
    'gfs_seamless',
] as const;
export type OwnBoatModel = (typeof OWN_BOAT_MODELS)[number];
export interface OwnBoatBinding {
    readonly ownerId: string;
    readonly vesselId: string;
    readonly vesselRevision: number;
    readonly piDeviceId: string;
    readonly controllerId: string;
    readonly pairingRevision: string;
    readonly enrollmentRevision: string;
    readonly selfKey: string;
    readonly windSourceKey: string;
    readonly positionSourceKey: string;
}
export interface OwnBoatConsent {
    readonly schema: 1;
    readonly revision: string;
    readonly binding: OwnBoatBinding;
    readonly issuedAt: number;
    readonly expiresAt: number;
}
export interface OwnBoatProposal {
    readonly schema: 1;
    readonly nonce: string;
    readonly expiresAt: number;
    readonly binding: OwnBoatBinding;
    readonly vesselName: string;
    readonly windSource: string;
    readonly positionSource: string;
}
export interface OwnBoatCapability {
    readonly schema: 1;
    readonly capability: string;
    readonly consent: OwnBoatConsent;
}
export const ownBoatRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
export const ownBoatExact = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
export const ownBoatUuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(v);
export const ownBoatHex = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/.test(v);
export const ownBoatClock = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 1577836800000 && v < 4102444800000;
export const ownBoatLabel = (v: unknown): v is string =>
    typeof v === 'string' &&
    v.length >= 1 &&
    v.length <= 120 &&
    ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
export function parseOwnBoatBinding(value: unknown): OwnBoatBinding | null {
    if (
        !ownBoatRecord(value) ||
        !ownBoatExact(value, [
            'ownerId',
            'vesselId',
            'vesselRevision',
            'piDeviceId',
            'controllerId',
            'pairingRevision',
            'enrollmentRevision',
            'selfKey',
            'windSourceKey',
            'positionSourceKey',
        ]) ||
        !['ownerId', 'vesselId', 'piDeviceId', 'controllerId'].every((key) => ownBoatUuid(value[key])) ||
        !Number.isSafeInteger(value.vesselRevision) ||
        Number(value.vesselRevision) < 1 ||
        Number(value.vesselRevision) > 2147483647 ||
        !['pairingRevision', 'enrollmentRevision', 'selfKey', 'windSourceKey', 'positionSourceKey'].every((key) =>
            ownBoatHex(value[key]),
        )
    )
        return null;
    return Object.freeze({ ...value }) as unknown as OwnBoatBinding;
}
export function ownBoatBindingKey(value: OwnBoatBinding): string {
    return JSON.stringify([
        value.ownerId,
        value.vesselId,
        value.vesselRevision,
        value.piDeviceId,
        value.controllerId,
        value.pairingRevision,
        value.enrollmentRevision,
        value.selfKey,
        value.windSourceKey,
        value.positionSourceKey,
    ]);
}
/** Structural only; the keeper independently enforces expiry, wall-clock and monotonic fences. */
export function parseOwnBoatConsent(value: unknown): OwnBoatConsent | null {
    if (!ownBoatRecord(value) || !ownBoatExact(value, ['schema', 'revision', 'binding', 'issuedAt', 'expiresAt']))
        return null;
    const binding = parseOwnBoatBinding(value.binding);
    if (
        value.schema !== 1 ||
        !ownBoatUuid(value.revision) ||
        !binding ||
        !ownBoatClock(value.issuedAt) ||
        !ownBoatClock(value.expiresAt) ||
        value.expiresAt - value.issuedAt !== OWN_BOAT_SKILL.consentMs
    )
        return null;
    return Object.freeze({
        schema: 1,
        revision: value.revision,
        binding,
        issuedAt: value.issuedAt,
        expiresAt: value.expiresAt,
    });
}
export function parseOwnBoatCapability(value: unknown, now: number): OwnBoatCapability | null {
    if (!ownBoatRecord(value) || !ownBoatExact(value, ['schema', 'capability', 'consent'])) return null;
    const consent = parseOwnBoatConsent(value.consent);
    return value.schema === 1 &&
        ownBoatHex(value.capability) &&
        consent &&
        ownBoatClock(now) &&
        now >= consent.issuedAt - 1000 &&
        now < consent.expiresAt
        ? Object.freeze({ schema: 1, capability: value.capability, consent })
        : null;
}
export function parseOwnBoatProposal(value: unknown, now: number): OwnBoatProposal | null {
    if (
        !ownBoatRecord(value) ||
        !ownBoatExact(value, ['schema', 'nonce', 'expiresAt', 'binding', 'vesselName', 'windSource', 'positionSource'])
    )
        return null;
    const binding = parseOwnBoatBinding(value.binding);
    return value.schema === 1 &&
        ownBoatHex(value.nonce) &&
        binding &&
        ownBoatClock(now) &&
        ownBoatClock(value.expiresAt) &&
        value.expiresAt > now &&
        value.expiresAt <= now + OWN_BOAT_SKILL.prepareMs &&
        ownBoatLabel(value.vesselName) &&
        ownBoatLabel(value.windSource) &&
        ownBoatLabel(value.positionSource)
        ? Object.freeze({
              schema: 1,
              nonce: value.nonce,
              expiresAt: value.expiresAt,
              binding,
              vesselName: value.vesselName,
              windSource: value.windSource,
              positionSource: value.positionSource,
          })
        : null;
}
/** The exact source cell is a forecast support, never an announced/public boat position. */
export function ownBoatCell(lat: number, lon: number): string | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat >= 90 || lon < -180 || lon >= 180)
        return null;
    return `${Math.round(Math.floor(lat / 0.25) * 25)}_${Math.round(Math.floor(lon / 0.25) * 25)}`;
}
