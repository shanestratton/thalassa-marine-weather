/** Strict scalar-only presentation of an owned Pi watch. Never reconstruct targets from push data. */
import { radarRecord, validRadarContext, validRadarOwner, type RadarWatchOwner } from '../../utils/radarWatchContract';
import {
    RADAR_RELAY_CONTACT,
    RADAR_RELAY_EPISODE,
    radarRelayKeyCanonical,
    type RadarRelayContext,
} from '../../utils/radarRelayContract';
import { sanitiseCollisionPrefs, type CollisionPrefs } from '../../utils/collisionRule';

export interface PiRadarAlarm {
    key: string;
    contactKey: string;
    episodeId: string;
    targetNumber: number;
    talker: string;
    name: string;
    sourceAt: number;
    reportAt: number;
    raisedAt: number;
    closeQuarters: boolean;
    cpaNm: number | null;
    tcpaMin: number | null;
    rangeNm: number | null;
    bearingDeg: number | null;
    unknown: boolean;
    cleared: 'passed' | 'lost' | null;
    /** False when held after a partial cloud snapshot; it cannot be acknowledged from omission. */
    actionable?: boolean;
}
export interface PiRadarWatchView {
    owner: RadarWatchOwner;
    ownerRevision: string;
    context: RadarRelayContext | null;
    contextRevision: number;
    servedAt: number;
    evaluatedAt: number | null;
    configured: boolean;
    running: boolean;
    state: 'off' | 'armed' | 'blind' | 'no-fix';
    prefs: CollisionPrefs | null;
    alarms: PiRadarAlarm[];
    more: boolean;
    capacity: boolean;
    push: {
        state: 'unavailable' | 'ready' | 'internet-off' | 'not-paired' | 'conflict';
        checkedAt: number | null;
        conflictRevision?: string;
    };
}
const clock = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const finite = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nullable = (v: unknown, min: number, max: number) => v === null || finite(v, min, max);
function prefs(v: unknown): v is CollisionPrefs {
    if (!radarRecord(v) || Object.keys(v).length !== 2) return false;
    const normalized = sanitiseCollisionPrefs(v);
    return (['inshore', 'offshore'] as const).every(
        (k) =>
            radarRecord(v[k]) &&
            Object.keys(v[k]).length === 2 &&
            v[k].cpaNm === normalized[k].cpaNm &&
            v[k].tcpaMin === normalized[k].tcpaMin,
    );
}
export function radarOwnerKey(owner: RadarWatchOwner): string {
    return JSON.stringify([owner.ownerId, owner.piDeviceId, owner.pairingId, owner.feedId]);
}
export async function radarAlarmKeyMatches(
    context: RadarRelayContext,
    identity: Parameters<typeof radarRelayKeyCanonical>[1],
    key: string,
): Promise<boolean> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(radarRelayKeyCanonical(context, identity)),
    );
    const expected = `${identity.kind}:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 12)}:${identity.raisedAt}`;
    return key === expected;
}
export async function decodePiRadarWatch(v: unknown, now: number): Promise<PiRadarWatchView | null> {
    if (
        !radarRecord(v) ||
        !Number.isFinite(now) ||
        v.schema !== 1 ||
        v.update !== 7 ||
        v.capability !== 1 ||
        !validRadarOwner(v.owner) ||
        !hex(v.ownerRevision) ||
        !clock(v.servedAt) ||
        v.servedAt > now + 1000 ||
        now - v.servedAt > 5000 ||
        !Number.isSafeInteger(v.contextRevision) ||
        (v.contextRevision as number) < 0 ||
        ![v.configured, v.running, v.more].every((x) => typeof x === 'boolean') ||
        !['off', 'armed', 'blind', 'no-fix'].includes(v.state as string) ||
        !(v.evaluatedAt === null || (clock(v.evaluatedAt) && v.evaluatedAt <= v.servedAt + 1000)) ||
        !Array.isArray(v.alarms) ||
        v.alarms.length > 20 ||
        !radarRecord(v.push) ||
        !['unavailable', 'ready', 'internet-off', 'not-paired', 'conflict'].includes(v.push.state as string) ||
        !(v.push.checkedAt === null || (clock(v.push.checkedAt) && v.push.checkedAt <= v.servedAt + 1000)) ||
        (v.push.conflictRevision !== undefined &&
            (typeof v.push.conflictRevision !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.push.conflictRevision)))
    )
        return null;
    if (v.push.state === 'ready' && (!clock(v.push.checkedAt) || now - v.push.checkedAt > 30000)) return null;
    const context = v.context;
    if (context === null) {
        if (
            v.state !== 'off' ||
            v.running ||
            v.evaluatedAt !== null ||
            v.prefs !== null ||
            v.alarms.length ||
            v.more ||
            v.capacity !== null
        )
            return null;
    } else if (
        !validRadarContext(context) ||
        radarOwnerKey(context.binding) !== radarOwnerKey(v.owner) ||
        v.state === 'off' ||
        !prefs(v.prefs)
    )
        return null;
    if (v.running && (!clock(v.evaluatedAt) || now - v.evaluatedAt > 5000 || !context)) return null;
    if (v.state === 'armed' && !v.configured) return null;
    if (
        v.capacity !== null &&
        (!radarRecord(v.capacity) ||
            !clock(v.capacity.sourceAt) ||
            v.capacity.sourceAt > v.servedAt + 1000 ||
            typeof v.capacity.acknowledged !== 'boolean')
    )
        return null;
    const alarms: PiRadarAlarm[] = [],
        seen = new Set<string>();
    const servedAt = v.servedAt;
    for (const raw of v.alarms) {
        if (
            !context ||
            !radarRecord(raw) ||
            raw.family !== 'radar' ||
            typeof raw.key !== 'string' ||
            seen.has(raw.key) ||
            typeof raw.contactKey !== 'string' ||
            !RADAR_RELAY_CONTACT.test(raw.contactKey) ||
            typeof raw.episodeId !== 'string' ||
            !RADAR_RELAY_EPISODE.test(raw.episodeId) ||
            !raw.episodeId.startsWith(context.watchEpoch + ':') ||
            !Number.isInteger(raw.targetNumber) ||
            !finite(raw.targetNumber, 0, 999) ||
            typeof raw.talker !== 'string' ||
            !/^[A-Z0-9]{2}$/.test(raw.talker) ||
            !raw.contactKey.endsWith(`:${raw.talker}:${raw.targetNumber}`) ||
            typeof raw.name !== 'string' ||
            raw.name.length > 80 ||
            [...raw.name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
            ![raw.sourceAt, raw.reportAt, raw.raisedAt].every((at) => clock(at) && at <= servedAt + 1000) ||
            (raw.sourceAt as number) > (raw.reportAt as number) ||
            typeof raw.closeQuarters !== 'boolean' ||
            !radarRecord(raw.assessment) ||
            typeof raw.assessment.rangeOnly !== 'boolean' ||
            !finite(raw.assessment.rangeNm, 0, 500) ||
            !finite(raw.assessment.bearingDeg, 0, 360) ||
            !nullable(raw.assessment.cpaNm, 0, 1000) ||
            !nullable(raw.assessment.tcpaMin, -100000, 100000) ||
            (raw.cleared !== undefined && !['passed', 'lost'].includes(raw.cleared as string)) ||
            (raw.lost !== undefined &&
                (!radarRecord(raw.lost) ||
                    !['no-fix', 'own-motion-unknown', 'target-motion-unknown', 'report-too-old', 'gone'].includes(
                        raw.lost.reason as string,
                    ) ||
                    !clock(raw.lost.sinceMs) ||
                    !clock(raw.lost.lastCpaAt) ||
                    raw.lost.sinceMs > v.servedAt + 1000 ||
                    raw.lost.lastCpaAt > v.servedAt + 1000))
        )
            return null;
        const kind = raw.closeQuarters ? 'radar-close-quarters' : 'radar-collision';
        const key = raw.key;
        if (
            !(await radarAlarmKeyMatches(
                context,
                { contactKey: raw.contactKey, episodeId: raw.episodeId, raisedAt: raw.raisedAt as number, kind },
                key,
            ))
        )
            return null;
        seen.add(key);
        const unknown =
            !!raw.lost ||
            now - (raw.sourceAt as number) > 15000 ||
            now < (raw.sourceAt as number) - 1000 ||
            raw.assessment.rangeOnly === true ||
            raw.assessment.cpaNm === null ||
            raw.assessment.tcpaMin === null;
        alarms.push({
            key,
            contactKey: raw.contactKey,
            episodeId: raw.episodeId,
            targetNumber: raw.targetNumber,
            talker: raw.talker,
            name: raw.name,
            sourceAt: raw.sourceAt as number,
            reportAt: raw.reportAt as number,
            raisedAt: raw.raisedAt as number,
            closeQuarters: raw.closeQuarters,
            rangeNm: raw.assessment.rangeNm,
            bearingDeg: raw.assessment.bearingDeg,
            cpaNm: unknown ? null : (raw.assessment.cpaNm as number),
            tcpaMin: unknown ? null : (raw.assessment.tcpaMin as number),
            unknown,
            cleared: raw.cleared === 'passed' && !unknown ? 'passed' : raw.cleared ? 'lost' : null,
        });
    }
    return {
        owner: { ...v.owner },
        ownerRevision: v.ownerRevision,
        context: context ? structuredClone(context) : null,
        contextRevision: v.contextRevision as number,
        servedAt: v.servedAt,
        evaluatedAt: v.evaluatedAt as number | null,
        configured: v.configured as boolean,
        running: v.running as boolean,
        state: v.state as PiRadarWatchView['state'],
        prefs: context ? sanitiseCollisionPrefs(v.prefs) : null,
        alarms,
        more: v.more as boolean,
        capacity: !!v.capacity,
        push: {
            state: v.push.state as PiRadarWatchView['push']['state'],
            checkedAt: v.push.checkedAt as number | null,
            ...(v.push.conflictRevision ? { conflictRevision: v.push.conflictRevision as string } : {}),
        },
    };
}
