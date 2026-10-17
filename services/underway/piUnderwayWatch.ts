/** Route handoff over the enrolled, pinned Pi lane. Intent, confirmed ownership
 * and alarm acknowledgements are bound separately to one paired boat/route. */
import { piCache } from '../PiCacheService';
import { getPairing, pinnedPiRequest } from '../PiPairingService';
import { buildRouteIndex } from '../routeProgress';
import { UnderwayAlarmStore } from './underwayAlarmStore';
import type { UnderwayInputs } from './UnderwayAlarmWatch';

type Intent = { signature: string; routeKey: string; data: { armed: true; configuration: unknown } };
type Owned = { identity: string; routeKey: string; signature: string };
let desired: Intent | null = null;
let owned: Owned | null = null;
let confirmed = '',
    suppressed = '',
    identity = '';
let sending = false,
    nextAt = 0,
    lastReadAt = 0;
let alarms: Array<{ kind: string; key: string }> = [];
let alarmSignature = '',
    alarmIdentity = '',
    alarmBase = '',
    alarmAt = 0;
function pairingIdentity(): string {
    const pairing = getPairing();
    return pairing ? JSON.stringify([pairing.deviceId, pairing.publicKeySpki]) : '';
}
function endpoint() {
    const base = piCache.lanBaseUrlNow(),
        paired = pairingIdentity();
    return base && paired ? { base, identity: paired } : null;
}
function clearAlarms(): void {
    alarms = [];
    alarmSignature = '';
    alarmIdentity = '';
    alarmBase = '';
    alarmAt = 0;
}
function observeIdentity(next: string): void {
    if (identity === next) return;
    identity = next;
    owned = null;
    confirmed = '';
    suppressed = '';
    nextAt = 0;
    lastReadAt = 0;
    clearAlarms();
}
function readWatch(
    data: unknown,
): { armed: boolean; routeKey: string | null; alarms: Array<{ kind: string; key: string }> } | null {
    if (typeof data === 'string') {
        if (data.length > 65536) return null;
        try {
            data = JSON.parse(data);
        } catch {
            return null;
        }
    }
    if (!data || typeof data !== 'object') return null;
    const raw = data as { v?: unknown; armed?: unknown; routeKey?: unknown; alarms?: unknown };
    if (
        raw.v !== 1 ||
        typeof raw.armed !== 'boolean' ||
        (raw.armed ? typeof raw.routeKey !== 'string' : raw.routeKey !== null) ||
        !Array.isArray(raw.alarms)
    )
        return null;
    return {
        armed: raw.armed,
        routeKey: raw.routeKey as string | null,
        alarms: raw.alarms
            .slice(0, 2)
            .filter(
                (a): a is { kind: string; key: string } =>
                    !!a &&
                    ['off-route', 'chart-ahead'].includes(a.kind) &&
                    typeof a.key === 'string' &&
                    new RegExp(`^${a.kind}::\\d{10,13}$`).test(a.key) &&
                    a.ackedAt == null,
            ),
    };
}
function intentFor(inputs: UnderwayInputs): Intent | null {
    const follow = inputs.following;
    if (
        !follow ||
        typeof follow.key !== 'string' ||
        follow.key.length < 1 ||
        follow.key.length > 256 ||
        !Array.isArray(follow.route) ||
        follow.route.length < 2 ||
        follow.route.length > 1000 ||
        !follow.route.every(
            (p) =>
                p &&
                Number.isFinite(p.lat) &&
                Math.abs(p.lat) <= 85 &&
                Number.isFinite(p.lon) &&
                Math.abs(p.lon) <= 180,
        ) ||
        !Number.isFinite(inputs.draftM) ||
        inputs.draftM <= 0 ||
        inputs.draftM > 20 ||
        !Number.isFinite(inputs.marginM) ||
        inputs.marginM < 0.5 ||
        inputs.marginM > 3 ||
        !buildRouteIndex(follow.route)
    )
        return null;
    const data = {
        armed: true as const,
        configuration: {
            key: follow.key,
            route: follow.route.map((p) => ({ lat: p.lat, lon: p.lon })),
            draftM: inputs.draftM,
            ukcM: inputs.marginM,
            prefs: inputs.prefs,
        },
    };
    const signature = JSON.stringify(data);
    return new TextEncoder().encode(signature).length <= 64 * 1024 ? { signature, routeKey: follow.key, data } : null;
}
async function flush(): Promise<void> {
    observeIdentity(pairingIdentity());
    const target = endpoint();
    if (!target) return;
    if (sending || Date.now() < nextAt) return;
    const active = desired && desired.signature !== suppressed ? desired : null;
    const request =
        active ??
        (owned
            ? {
                  signature: 'stand-down:' + owned.signature,
                  routeKey: owned.routeKey,
                  data: { armed: false, routeKey: owned.routeKey },
              }
            : null);
    if (!request) return;
    const readOnly = !!active && request.signature === confirmed;
    if (readOnly && Date.now() - lastReadAt < 15000) return;
    sending = true;
    nextAt = Date.now() + 10000;
    lastReadAt = Date.now();
    const intentAtStart = desired?.signature ?? '';
    let resync = false;
    try {
        const response = await pinnedPiRequest({
            url: target.base + '/api/underway-watch',
            method: readOnly ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            ...(readOnly ? {} : { data: request.data }),
            connectTimeout: 2000,
            readTimeout: 4000,
        });
        if (endpoint()?.identity !== target.identity || endpoint()?.base !== target.base) return;
        const watch = response.status === 200 ? readWatch(response.data) : null;
        if (watch && (active ? watch.armed && watch.routeKey === request.routeKey : !watch.armed)) {
            if (active) {
                owned = { identity: target.identity, routeKey: request.routeKey, signature: request.signature };
                if (desired?.signature === request.signature && suppressed !== request.signature) {
                    confirmed = request.signature;
                    alarms = watch.alarms;
                    alarmIdentity = target.identity;
                    alarmBase = target.base;
                    alarmSignature = request.signature;
                    alarmAt = Date.now();
                }
            } else {
                owned = null;
                confirmed = '';
                clearAlarms();
            }
        } else if (watch || (!active && response.status === 409)) {
            // A peer changed the Pi watch. Stand aside until a NEW phone intent;
            // an old phone polling its saved route must not start a route war.
            owned = null;
            confirmed = '';
            clearAlarms();
            if (desired?.signature === request.signature) suppressed = request.signature;
        } else if (active && !readOnly && response.status === 400) {
            // A rejected new route cannot leave this session's old route armed.
            if (desired?.signature === request.signature) suppressed = request.signature;
            clearAlarms();
            resync = owned !== null;
        } else if (response.status === 404) nextAt = Date.now() + 60000;
    } catch {
        /* Phone alarms remain independent of Pi capability. */
    } finally {
        sending = false;
        if ((desired?.signature ?? '') !== intentAtStart || resync) {
            nextAt = 0;
            void flush();
        }
    }
}
export function syncPiUnderway(inputs: UnderwayInputs): void {
    observeIdentity(pairingIdentity());
    const next = intentFor(inputs);
    if (next?.signature !== desired?.signature) {
        desired = next;
        suppressed = '';
        nextAt = 0;
        clearAlarms();
    }
    void flush();
}
UnderwayAlarmStore.subscribeActions(({ kind }) => {
    const target = endpoint();
    const holder = owned;
    if (
        !target ||
        !holder ||
        target.identity !== alarmIdentity ||
        target.base !== alarmBase ||
        target.identity !== holder.identity ||
        !desired ||
        desired.signature !== alarmSignature ||
        desired.signature === suppressed ||
        Date.now() - alarmAt > 45000
    )
        return;
    const alarm = alarms.find((a) => a.kind === kind);
    if (!alarm) return;
    void pinnedPiRequest({
        url: target.base + '/api/underway-watch/ack',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { key: alarm.key, routeKey: holder.routeKey },
        connectTimeout: 2000,
        readTimeout: 4000,
    }).catch(() => undefined);
});
