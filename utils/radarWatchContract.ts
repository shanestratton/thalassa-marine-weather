/** Bounded paired-LAN radar watch wire. Server identity is never accepted from HTTP bodies. */
import type { CollisionPrefs } from './collisionRule.js';
import type { RadarEncounterCard } from './radarEncounters.js';
import type { RadarRelayContext } from './radarRelayContract.js';
export interface RadarController {
    deviceId: string;
    enrollmentRevision: string;
}
export interface RadarWatchAlarm extends RadarEncounterCard {
    key: string;
}
export interface RadarWatchStatus {
    schema: 1;
    update: 7;
    capability: 1;
    servedAt: number;
    evaluatedAt: number | null;
    contextRevision: number;
    context: RadarRelayContext | null;
    configured: boolean;
    running: boolean;
    state: 'off' | 'armed' | 'blind' | 'no-fix';
    prefs: CollisionPrefs | null;
    alarms: RadarWatchAlarm[];
    more: boolean;
    capacity: { sourceAt: number; acknowledged: boolean } | null;
    push: {
        state: 'unavailable' | 'ready' | 'internet-off' | 'not-paired' | 'conflict';
        checkedAt: number | null;
        conflictRevision?: string;
    };
}
export type RadarWatchCommand = {
    armed: boolean;
    expected: RadarRelayContext | null;
    prefs?: CollisionPrefs;
    replaceController?: true;
};
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const radarRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
export function validRadarController(v: unknown): v is RadarController {
    return radarRecord(v) && Object.keys(v).length === 2 && uuid(v.deviceId) && hash(v.enrollmentRevision);
}
export function validRadarContext(v: unknown): v is RadarRelayContext {
    if (
        !radarRecord(v) ||
        Object.keys(v).length !== 4 ||
        !radarRecord(v.binding) ||
        Object.keys(v.binding).length !== 6
    )
        return false;
    const b = v.binding;
    return (
        uuid(b.ownerId) &&
        uuid(b.piDeviceId) &&
        hash(b.pairingId) &&
        uuid(b.deviceId) &&
        hash(b.enrollmentRevision) &&
        typeof b.feedId === 'string' &&
        new RegExp(`^pi:${b.piDeviceId}:[0-9a-f]{24}$`).test(b.feedId) &&
        uuid(v.configurationRevision) &&
        uuid(v.instance) &&
        typeof v.watchEpoch === 'string' &&
        /^[0-9a-f]{32}$/.test(v.watchEpoch)
    );
}
/** Fixed ordering also makes harmless property order differences safe for CAS. */
export function radarContextKey(c: RadarRelayContext | null): string {
    if (!c) return 'null';
    const b = c.binding;
    return JSON.stringify([
        b.ownerId,
        b.piDeviceId,
        b.pairingId,
        b.deviceId,
        b.enrollmentRevision,
        b.feedId,
        c.configurationRevision,
        c.instance,
        c.watchEpoch,
    ]);
}
