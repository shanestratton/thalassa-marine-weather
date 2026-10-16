/** Owner-only fixed alarm facts. Cloud heartbeat never proves a connected radar feed. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { getPairing } from '../PiPairingService';
import { supabase, getCurrentUserId } from '../supabase';
import { satelliteModeActive } from '../networkPolicy';
import { utf8ByteLength } from '../enc/types';
import { radarRecord, validRadarContext, validRadarOwner } from '../../utils/radarWatchContract';
import { RADAR_RELAY_CONTACT, RADAR_RELAY_EPISODE } from '../../utils/radarRelayContract';
import { radarAlarmKeyMatches, radarOwnerKey, type PiRadarAlarm } from './piRadarWatchWire';
import { PiRadarWatchError, type PiRadarWatchProof } from './piRadarWatch';
type Options = { signal?: AbortSignal; isCurrent?: () => boolean; allowCloud?: boolean };
const clock = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const nullable = (v: unknown, min: number, max: number) =>
    v === null || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);
export async function decodeRadarCloudSnapshot(
    v: unknown,
    now: number,
): Promise<Pick<PiRadarWatchProof, 'view' | 'cloudRevision' | 'acknowledgedKeys'> | null> {
    if (
        !radarRecord(v) ||
        !Number.isFinite(now) ||
        v.schema !== 1 ||
        !clock(v.checkedAt) ||
        v.checkedAt > now + 1000 ||
        now - v.checkedAt > 5000 ||
        !validRadarOwner(v.owner) ||
        !validRadarContext(v.context) ||
        radarOwnerKey(v.owner) !== radarOwnerKey(v.context.binding) ||
        !uuid(v.contextRevision) ||
        typeof v.retired !== 'boolean' ||
        typeof v.more !== 'boolean' ||
        !Array.isArray(v.alarms) ||
        v.alarms.length > 20
    )
        return null;
    if (
        v.retired
            ? v.evaluatedAt !== null || v.alarms.length || v.more
            : !clock(v.evaluatedAt) || v.evaluatedAt > v.checkedAt + 1000 || v.checkedAt - v.evaluatedAt > 30000
    )
        return null;
    const alarms: PiRadarAlarm[] = [],
        acknowledgedKeys: string[] = [],
        seen = new Set<string>();
    const checkedAt = v.checkedAt;
    for (const raw of v.alarms) {
        if (
            !radarRecord(raw) ||
            Object.keys(raw).length !== 13 ||
            typeof raw.key !== 'string' ||
            seen.has(raw.key) ||
            typeof raw.contactKey !== 'string' ||
            !RADAR_RELAY_CONTACT.test(raw.contactKey) ||
            typeof raw.episodeId !== 'string' ||
            !RADAR_RELAY_EPISODE.test(raw.episodeId) ||
            !raw.episodeId.startsWith(v.context.watchEpoch + ':') ||
            !['radar-collision', 'radar-close-quarters'].includes(raw.kind as string) ||
            ![raw.sourceAt, raw.reportAt, raw.raisedAt].every((at) => clock(at) && at <= checkedAt + 1000) ||
            (raw.sourceAt as number) > (raw.reportAt as number) ||
            !nullable(raw.cpaNm, 0, 1000) ||
            !nullable(raw.tcpaMin, -100000, 100000) ||
            !nullable(raw.rangeNm, 0, 500) ||
            !nullable(raw.bearingDeg, 0, 360) ||
            !(
                raw.lost === null ||
                ['no-fix', 'own-motion-unknown', 'target-motion-unknown', 'report-too-old', 'gone'].includes(
                    raw.lost as string,
                )
            ) ||
            !(
                raw.ackedAt === null ||
                (clock(raw.ackedAt) && raw.ackedAt >= (raw.raisedAt as number) && raw.ackedAt <= v.checkedAt + 1000)
            )
        )
            return null;
        const kind = raw.kind as 'radar-collision' | 'radar-close-quarters';
        if (
            !(await radarAlarmKeyMatches(
                v.context,
                { contactKey: raw.contactKey, episodeId: raw.episodeId, raisedAt: raw.raisedAt as number, kind },
                raw.key,
            ))
        )
            return null;
        seen.add(raw.key);
        // Original DB ACK clock only: repeated reads cannot renew a 30-minute mute.
        if (raw.ackedAt !== null && (kind === 'radar-close-quarters' || now - (raw.ackedAt as number) < 1800000)) {
            acknowledgedKeys.push(raw.key);
            continue;
        }
        const [, talker, target] = /:([A-Z0-9]{2}):(\d+)$/.exec(raw.contactKey)!;
        alarms.push({
            key: raw.key,
            contactKey: raw.contactKey,
            episodeId: raw.episodeId,
            targetNumber: Number(target),
            talker,
            name: `Radar ${target}`,
            sourceAt: raw.sourceAt as number,
            reportAt: raw.reportAt as number,
            raisedAt: raw.raisedAt as number,
            closeQuarters: kind === 'radar-close-quarters',
            rangeNm: raw.rangeNm as number | null,
            bearingDeg: raw.bearingDeg as number | null,
            cpaNm: null,
            tcpaMin: null,
            unknown: true,
            cleared: null,
        });
    }
    return {
        cloudRevision: v.contextRevision,
        acknowledgedKeys,
        view: {
            owner: { ...v.owner },
            ownerRevision: '',
            context: v.retired ? null : structuredClone(v.context),
            contextRevision: 0,
            servedAt: v.checkedAt,
            evaluatedAt: v.evaluatedAt as number | null,
            configured: false,
            running: false,
            state: v.retired ? 'off' : 'blind',
            prefs: null,
            alarms,
            more: v.more,
            capacity: false,
            push: { state: 'unavailable', checkedAt: null },
        },
    };
}
async function access(
    options: Options,
    action: (
        client: NonNullable<typeof supabase>,
        scope: ReturnType<typeof getAuthIdentityScope>,
        pi: string,
        signal: AbortSignal,
        current: () => boolean,
    ) => Promise<PiRadarWatchProof>,
): Promise<PiRadarWatchProof> {
    const scope = getAuthIdentityScope(),
        record = getPairing(),
        pair = record ? { ...record } : null;
    if (!scope.userId || !pair?.publicKeySpki || !supabase || (satelliteModeActive() && !options.allowCloud))
        throw new PiRadarWatchError('unavailable');
    const client = supabase;
    const identityCurrent = () => {
        const next = getPairing();
        return (
            isAuthIdentityScopeCurrent(scope) &&
            next?.deviceId === pair.deviceId &&
            next?.pairedAt === pair.pairedAt &&
            next?.publicKeySpki === pair.publicKeySpki
        );
    };
    const controller = new AbortController(),
        started = performance.now();
    const current = () =>
        identityCurrent() &&
        !controller.signal.aborted &&
        !options.signal?.aborted &&
        options.isCurrent?.() !== false &&
        performance.now() - started < 6000 &&
        (options.allowCloud || !satelliteModeActive());
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined,
        timedOut = false;
    try {
        return await Promise.race([
            (async () => {
                if (!current()) throw new PiRadarWatchError('cancelled');
                const user = await getCurrentUserId(scope);
                if (!current() || user !== scope.userId) throw new PiRadarWatchError('cancelled');
                const proof = await action(client, scope, pair.deviceId, controller.signal, current);
                if (!current()) throw new PiRadarWatchError('cancelled');
                return { ...proof, isCurrent: identityCurrent, source: 'cloud' as const };
            })(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                    reject(new PiRadarWatchError('unavailable'));
                }, 6000);
                controller.signal.addEventListener(
                    'abort',
                    () => reject(new PiRadarWatchError(timedOut ? 'unavailable' : 'cancelled')),
                    {
                        once: true,
                    },
                );
            }),
        ]);
    } catch (error) {
        throw error instanceof PiRadarWatchError ? error : new PiRadarWatchError('unavailable');
    } finally {
        controller.abort();
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
    }
}
async function snapshot(
    client: NonNullable<typeof supabase>,
    owner: string,
    pi: string,
    signal: AbortSignal,
): Promise<Pick<PiRadarWatchProof, 'view' | 'cloudRevision' | 'acknowledgedKeys'>> {
    const { data, error } = await client.rpc('pi_radar_owner_snapshot', { p_pi_device_id: pi }).abortSignal(signal);
    if (error || utf8ByteLength(JSON.stringify(data), 65536) > 65536) throw new PiRadarWatchError('unavailable');
    const result = await decodeRadarCloudSnapshot(data, Date.now());
    if (!result || result.view.owner.ownerId !== owner || result.view.owner.piDeviceId !== pi)
        throw new PiRadarWatchError('unavailable');
    return result;
}
export const readCloudPiRadarWatch = (options: Options = {}) =>
    access(options, async (client, scope, pi, signal) => ({
        ...(await snapshot(client, scope.userId!, pi, signal)),
        deviceId: '',
        isCurrent: () => true,
    }));
export const acknowledgeCloudPiRadarWatch = (proof: PiRadarWatchProof, key: string, options: Options = {}) =>
    access({ ...options, allowCloud: true }, async (client, scope, pi, signal, current) => {
        if (
            proof.source !== 'cloud' ||
            !proof.isCurrent() ||
            !proof.cloudRevision ||
            !proof.view.context ||
            proof.view.owner.ownerId !== scope.userId ||
            proof.view.owner.piDeviceId !== pi ||
            Date.now() - proof.view.servedAt > 5000 ||
            !proof.view.alarms.some((c) => c.key === key)
        )
            throw new PiRadarWatchError('conflict');
        if (!current()) throw new PiRadarWatchError('cancelled');
        const { data, error } = await client
            .rpc('acknowledge_pi_radar_alarm', { p_alarm_key: key, p_context_revision: proof.cloudRevision })
            .abortSignal(signal);
        if (error || data !== 1) throw new PiRadarWatchError('conflict');
        if (!current()) throw new PiRadarWatchError('cancelled');
        const result = await snapshot(client, scope.userId!, pi, signal);
        if (
            result.cloudRevision !== proof.cloudRevision ||
            radarOwnerKey(result.view.owner) !== radarOwnerKey(proof.view.owner)
        )
            throw new PiRadarWatchError('conflict');
        return { ...result, deviceId: '', isCurrent: () => true };
    });
