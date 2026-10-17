/** Strict fixed radar family at the existing authenticated 8KiB Pi door. */
import {
    RADAR_RELAY_BATCH,
    RADAR_RELAY_CONTACT,
    RADAR_RELAY_EPISODE,
    RADAR_RELAY_KEY,
    type RadarRelayAck,
    type RadarRelayContext,
    type RadarRelayIdentity,
    radarRelayKeyCanonical,
    type RadarRelayRequest,
    type RadarRelayResolved,
    type RadarRelayUpsert,
} from '../../../utils/radarRelayContract.ts';
import { RADAR_REPORT_MAX_AGE_MS } from '../../../utils/radarTarget.ts';
import { type PiRelayIdentity, sha256Hex } from '../_shared/pi-relay-auth.ts';
export type { RadarRelayContext, RadarRelayRequest } from '../../../utils/radarRelayContract.ts';
const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const radarRelayUuid = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const stamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const finite = (value: unknown, minimum: number, maximum: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
const maybeFinite = (value: unknown, minimum: number, maximum: number): value is number | null =>
    value === null || finite(value, minimum, maximum);
const MAX_EPISODE_AGE = 30 * 24 * 3600_000;
const identityKeys = ['key', 'contactKey', 'episodeId', 'kind'];
const lostReasons = new Set(['no-fix', 'own-motion-unknown', 'target-motion-unknown', 'report-too-old', 'gone']);

export async function parseRadarRelayContext(
    raw: unknown,
    identity: PiRelayIdentity,
): Promise<RadarRelayContext | null> {
    if (
        !record(raw) || !exact(raw, ['binding', 'configurationRevision', 'instance', 'watchEpoch']) ||
        !record(raw.binding) ||
        !radarRelayUuid(raw.configurationRevision) || !radarRelayUuid(raw.instance) ||
        typeof raw.watchEpoch !== 'string' || !/^[0-9a-f]{32}$/.test(raw.watchEpoch)
    ) return null;
    const b = raw.binding;
    if (
        !exact(b, ['ownerId', 'piDeviceId', 'pairingId', 'deviceId', 'enrollmentRevision', 'feedId']) ||
        b.ownerId !== identity.ownerId ||
        !radarRelayUuid(b.ownerId) || !radarRelayUuid(b.piDeviceId) || !radarRelayUuid(b.deviceId) ||
        !hash(b.pairingId) || !hash(b.enrollmentRevision) ||
        typeof b.feedId !== 'string' || !new RegExp(`^pi:${b.piDeviceId}:[0-9a-f]{24}$`).test(b.feedId) ||
        b.pairingId !== await sha256Hex(JSON.stringify([b.ownerId, b.piDeviceId, identity.relayId]))
    ) return null;
    return {
        binding: {
            ownerId: b.ownerId,
            piDeviceId: b.piDeviceId,
            pairingId: b.pairingId,
            deviceId: b.deviceId,
            enrollmentRevision: b.enrollmentRevision,
            feedId: b.feedId,
        },
        configurationRevision: raw.configurationRevision,
        instance: raw.instance,
        watchEpoch: raw.watchEpoch,
    };
}
export async function radarRelayAlarmKey(
    context: RadarRelayContext,
    alarm: Pick<RadarRelayUpsert, 'episodeId' | 'contactKey' | 'raisedAt' | 'kind'>,
): Promise<string> {
    return `${alarm.kind}:${(await sha256Hex(radarRelayKeyCanonical(context, alarm))).slice(0, 12)}:${alarm.raisedAt}`;
}
async function parseIdentity(
    raw: Record<string, unknown>,
    context: RadarRelayContext,
    now: number,
): Promise<RadarRelayIdentity | null> {
    if (
        typeof raw.key !== 'string' || !RADAR_RELAY_KEY.test(raw.key) || typeof raw.contactKey !== 'string' ||
        !RADAR_RELAY_CONTACT.test(raw.contactKey) ||
        typeof raw.episodeId !== 'string' || !RADAR_RELAY_EPISODE.test(raw.episodeId) ||
        !raw.episodeId.startsWith(context.watchEpoch + ':') ||
        (raw.kind !== 'radar-collision' && raw.kind !== 'radar-close-quarters')
    ) return null;
    const raisedAt = Number(raw.key.split(':')[2]);
    if (
        !stamp(raisedAt) || raisedAt > now + 1000 || now - raisedAt > MAX_EPISODE_AGE ||
        raw.key !==
            await radarRelayAlarmKey(context, {
                episodeId: raw.episodeId,
                contactKey: raw.contactKey,
                kind: raw.kind,
                raisedAt,
            })
    ) return null;
    return { key: raw.key, contactKey: raw.contactKey, episodeId: raw.episodeId, kind: raw.kind };
}
async function parseUpsert(
    raw: unknown,
    context: RadarRelayContext,
    evaluatedAt: number,
    now: number,
): Promise<RadarRelayUpsert | null> {
    if (
        !record(raw) ||
        !exact(raw, [
            ...identityKeys,
            'raisedAt',
            'reportAt',
            'sourceAt',
            'cpaNm',
            'tcpaMin',
            'rangeNm',
            'bearingDeg',
            'lost',
        ])
    ) return null;
    const identity = await parseIdentity(raw, context, now);
    if (
        !identity || !stamp(raw.raisedAt) || String(raw.raisedAt) !== identity.key.split(':')[2] ||
        raw.raisedAt > evaluatedAt + 1000 ||
        !stamp(raw.reportAt) || raw.reportAt > evaluatedAt + 1000 || now - raw.reportAt > MAX_EPISODE_AGE ||
        !stamp(raw.sourceAt) || raw.sourceAt > raw.reportAt || now - raw.sourceAt > MAX_EPISODE_AGE ||
        !maybeFinite(raw.cpaNm, 0, 1000) || !maybeFinite(raw.tcpaMin, -60, 60) || !maybeFinite(raw.rangeNm, 0, 1000) ||
        !maybeFinite(raw.bearingDeg, 0, 360) || raw.bearingDeg === 360 ||
        !(raw.lost === null || (typeof raw.lost === 'string' && lostReasons.has(raw.lost))) ||
        ((raw.cpaNm === null) !== (raw.tcpaMin === null))
    ) return null;
    // Unknown/lost keeps its original evidence and cannot be promoted to a fresh alarm.
    if (
        raw.lost === null &&
        (raw.cpaNm === null || raw.tcpaMin === null || raw.rangeNm === null ||
            evaluatedAt - raw.sourceAt > RADAR_REPORT_MAX_AGE_MS)
    ) return null;
    return {
        ...identity,
        raisedAt: raw.raisedAt,
        reportAt: raw.reportAt,
        sourceAt: raw.sourceAt,
        cpaNm: raw.cpaNm,
        tcpaMin: raw.tcpaMin,
        rangeNm: raw.rangeNm,
        bearingDeg: raw.bearingDeg,
        lost: raw.lost as RadarRelayUpsert['lost'],
    };
}
async function parseAck(
    raw: unknown,
    context: RadarRelayContext,
    evaluatedAt: number,
    now: number,
): Promise<RadarRelayAck | null> {
    if (!record(raw) || !exact(raw, [...identityKeys, 'ackedAt'])) return null;
    const identity = await parseIdentity(raw, context, now);
    return identity && stamp(raw.ackedAt) && raw.ackedAt >= Number(identity.key.split(':')[2]) &&
            raw.ackedAt <= evaluatedAt + 1000 && now - raw.ackedAt <= MAX_EPISODE_AGE
        ? { ...identity, ackedAt: raw.ackedAt }
        : null;
}
async function parseResolved(
    raw: unknown,
    context: RadarRelayContext,
    evaluatedAt: number,
    now: number,
): Promise<RadarRelayResolved | null> {
    if (!record(raw) || !exact(raw, [...identityKeys, 'how', 'endedAt'])) return null;
    const identity = await parseIdentity(raw, context, now);
    return identity && (raw.how === 'passed' || raw.how === 'lost') && stamp(raw.endedAt) &&
            raw.endedAt >= Number(identity.key.split(':')[2]) && raw.endedAt <= evaluatedAt + 1000 &&
            now - raw.endedAt <= MAX_EPISODE_AGE
        ? { ...identity, how: raw.how, endedAt: raw.endedAt }
        : null;
}
export async function parseRadarRelayRequest(
    raw: Record<string, unknown>,
    identity: PiRelayIdentity,
    now: number,
): Promise<RadarRelayRequest | null> {
    if (raw.family !== 'radar' || !stamp(now)) return null;
    if (raw.action === 'probe') return exact(raw, ['family', 'action']) ? { family: 'radar', action: 'probe' } : null;
    const context = await parseRadarRelayContext(raw.context, identity);
    if (!context) return null;
    if (raw.action === 'bind') {
        return exact(raw, ['family', 'action', 'context', 'expectedContextRevision']) &&
                (raw.expectedContextRevision === null || radarRelayUuid(raw.expectedContextRevision))
            ? { family: 'radar', action: 'bind', context, expectedContextRevision: raw.expectedContextRevision }
            : null;
    }
    if (raw.action === 'retire') {
        return exact(raw, ['family', 'action', 'context', 'contextRevision']) && radarRelayUuid(raw.contextRevision)
            ? { family: 'radar', action: 'retire', context, contextRevision: raw.contextRevision }
            : null;
    }
    if (
        raw.action !== 'sync' ||
        !exact(raw, [
            'family',
            'action',
            'context',
            'contextRevision',
            'evaluatedAt',
            'upserts',
            'acks',
            'resolved',
            'more',
        ]) ||
        !radarRelayUuid(raw.contextRevision) || !stamp(raw.evaluatedAt) || raw.evaluatedAt > now + 1000 ||
        now - raw.evaluatedAt > 30_000 || typeof raw.more !== 'boolean' ||
        !Array.isArray(raw.upserts) || !Array.isArray(raw.acks) || !Array.isArray(raw.resolved) ||
        raw.upserts.length + raw.acks.length + raw.resolved.length > RADAR_RELAY_BATCH
    ) return null;
    const upserts: RadarRelayUpsert[] = [], acks: RadarRelayAck[] = [], resolved: RadarRelayResolved[] = [];
    for (
        const [items, parse, output] of [[raw.upserts, parseUpsert, upserts], [raw.acks, parseAck, acks], [
            raw.resolved,
            parseResolved,
            resolved,
        ]] as const
    ) {
        const seen = new Set<string>();
        for (const item of items) {
            const value = await parse(item, context, raw.evaluatedAt, now);
            if (!value || seen.has(value.key)) return null;
            seen.add(value.key);
            (output as Array<RadarRelayUpsert | RadarRelayAck | RadarRelayResolved>).push(value);
        }
    }
    return {
        family: 'radar',
        action: 'sync',
        context,
        contextRevision: raw.contextRevision,
        evaluatedAt: raw.evaluatedAt,
        upserts,
        acks,
        resolved,
        more: raw.more,
    };
}
