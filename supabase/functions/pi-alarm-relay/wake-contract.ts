/** Fixed wake family. No arbitrary Signal K path, text, position or destination. */
import { WAKE_PRESETS, type WakePreset, type WakeQuietHours } from '../../../utils/wakeRule.ts';
import { type PiRelayIdentity, sha256Hex } from '../_shared/pi-relay-auth.ts';

export const WAKE_KINDS = {
    'wake-depth': 'depth-below-keel',
    'wake-wind': 'wind-above',
    'wake-speed': 'speed-below',
    'wake-pressure': 'pressure-fall',
    'wake-coolant': 'engine-coolant-above',
    'wake-oil': 'engine-oil-below',
    'wake-rpm': 'engine-rpm-above',
    'wake-battery': 'battery-below',
} as const satisfies Record<string, WakePreset>;
export type WakeKind = keyof typeof WAKE_KINDS;
export interface WakeRelayBinding {
    ownerId: string;
    piDeviceId: string;
    pairingId: string;
    deviceId: string;
    enrollmentRevision: string;
    feedId: string;
}
export interface WakeRelayContext {
    binding: WakeRelayBinding;
    rulesDigest: string;
    configurationRevision: string;
    instance: string;
    rules: {
        kind: WakeKind;
        enabled: boolean;
        sourceKey: string | null;
        threshold: number | null;
        quietHours: WakeQuietHours | null;
    }[];
}
export interface WakeRelayAlarm {
    key: string;
    sourceKey: string;
    sourceAt: number;
    raisedAt: number;
    value: number | null;
    threshold: number;
    depthBasis: 'below-keel' | 'transducer-offset' | 'conservative-full-draft' | null;
    ackedAt: number | null;
}
export interface WakeRelayState {
    kind: WakeKind;
    status: 'disabled' | 'unconfigured' | 'unknown' | 'watching' | 'pending' | 'active';
    quiet: boolean;
    alarm: WakeRelayAlarm | null;
}
export type WakeRelayRequest =
    | { family: 'wake'; action: 'probe' }
    | { family: 'wake'; action: 'bind'; context: WakeRelayContext; expectedContextRevision: string | null }
    | { family: 'wake'; action: 'retire'; context: WakeRelayContext; contextRevision: string }
    | {
        family: 'wake';
        action: 'sync';
        context: WakeRelayContext;
        contextRevision: string;
        evaluatedAt: number;
        higherPriority: 'none' | 'anchor' | 'collision' | 'distress';
        states: WakeRelayState[];
    };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export const wakeRelayUuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const stamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const between = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const minute = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && between(v, min, max);
function parseQuiet(raw: unknown): WakeQuietHours | null | false {
    if (raw === null) return null;
    if (
        !record(raw) || !exact(raw, ['startMinute', 'endMinute', 'utcOffsetMinutes']) ||
        !minute(raw.startMinute, 0, 1439) || !minute(raw.endMinute, 0, 1439) ||
        raw.startMinute === raw.endMinute || !minute(raw.utcOffsetMinutes, -840, 840)
    ) return false;
    return { startMinute: raw.startMinute, endMinute: raw.endMinute, utcOffsetMinutes: raw.utcOffsetMinutes };
}
export const WAKE_EVENT_KEY = /^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery):[0-9a-f]{12}:[0-9]{10,13}$/;

async function parseContext(raw: unknown, identity: PiRelayIdentity): Promise<WakeRelayContext | null> {
    if (
        !record(raw) || !exact(raw, ['binding', 'rulesDigest', 'configurationRevision', 'instance', 'rules']) ||
        !hash(raw.rulesDigest) || !wakeRelayUuid(raw.configurationRevision) || !wakeRelayUuid(raw.instance) ||
        !record(raw.binding)
    ) return null;
    const b = raw.binding;
    if (
        !exact(b, ['ownerId', 'piDeviceId', 'pairingId', 'deviceId', 'enrollmentRevision', 'feedId']) ||
        b.ownerId !== identity.ownerId ||
        !wakeRelayUuid(b.ownerId) || !wakeRelayUuid(b.piDeviceId) || !hash(b.pairingId) || !wakeRelayUuid(b.deviceId) ||
        !hash(b.enrollmentRevision) ||
        typeof b.feedId !== 'string' || !new RegExp(`^pi:${b.piDeviceId}:[0-9a-f]{24}$`).test(b.feedId) ||
        b.pairingId !== await sha256Hex(JSON.stringify([b.ownerId, b.piDeviceId, identity.relayId]))
    ) return null;
    if (!Array.isArray(raw.rules) || raw.rules.length !== 8) return null;
    const rules: WakeRelayContext['rules'] = [];
    for (const kind of Object.keys(WAKE_KINDS) as WakeKind[]) {
        const rows = raw.rules.filter((r) => record(r) && r.kind === kind);
        if (rows.length !== 1) return null;
        const r = rows[0] as Record<string, unknown>,
            spec = WAKE_PRESETS[WAKE_KINDS[kind]],
            quietHours = parseQuiet(r.quietHours);
        if (
            !exact(r, ['kind', 'enabled', 'sourceKey', 'threshold', 'quietHours']) || typeof r.enabled !== 'boolean' ||
            quietHours === false ||
            !(r.sourceKey === null || hash(r.sourceKey)) ||
            !(r.threshold === null || between(r.threshold, spec.thresholdMin, spec.thresholdMax)) ||
            (r.enabled && (r.sourceKey === null || r.threshold === null))
        ) return null;
        rules.push({ kind, enabled: r.enabled, sourceKey: r.sourceKey, threshold: r.threshold, quietHours });
    }
    return {
        binding: {
            ownerId: b.ownerId,
            piDeviceId: b.piDeviceId,
            pairingId: b.pairingId,
            deviceId: b.deviceId,
            enrollmentRevision: b.enrollmentRevision,
            feedId: b.feedId,
        },
        rulesDigest: raw.rulesDigest,
        configurationRevision: raw.configurationRevision,
        instance: raw.instance,
        rules,
    };
}
/** The episode binds to one exact configuration/stream/source and original fire time. */
export async function wakeRelayAlarmKey(
    context: WakeRelayContext,
    kind: WakeKind,
    sourceKey: string,
    raisedAt: number,
): Promise<string> {
    const b = context.binding;
    const episode = await sha256Hex(
        JSON.stringify([
            1,
            [b.ownerId, b.piDeviceId, b.pairingId, b.deviceId, b.enrollmentRevision, b.feedId],
            context.rulesDigest,
            context.configurationRevision,
            context.instance,
            kind,
            sourceKey,
            raisedAt,
        ]),
    );
    return `${kind}:${episode.slice(0, 12)}:${raisedAt}`;
}
async function parseState(
    raw: unknown,
    context: WakeRelayContext,
    evaluatedAt: number,
): Promise<WakeRelayState | null> {
    if (
        !record(raw) || !exact(raw, ['kind', 'status', 'quiet', 'alarm']) || typeof raw.kind !== 'string' ||
        !Object.hasOwn(WAKE_KINDS, raw.kind) ||
        !['disabled', 'unconfigured', 'unknown', 'watching', 'pending', 'active'].includes(String(raw.status)) ||
        typeof raw.quiet !== 'boolean'
    ) return null;
    const kind = raw.kind as WakeKind, status = raw.status as WakeRelayState['status'];
    const selected = context.rules.find((r) => r.kind === kind)!;
    if (selected.enabled ? status === 'disabled' : status !== 'disabled') return null;
    if (raw.alarm === null) return status === 'active' ? null : { kind, status, quiet: raw.quiet, alarm: null };
    if (
        !['active', 'unknown'].includes(status) || !record(raw.alarm) ||
        !exact(raw.alarm, ['key', 'sourceKey', 'sourceAt', 'raisedAt', 'value', 'threshold', 'depthBasis', 'ackedAt'])
    ) return null;
    const a = raw.alarm, spec = WAKE_PRESETS[WAKE_KINDS[kind]];
    if (
        typeof a.key !== 'string' || !WAKE_EVENT_KEY.test(a.key) || !hash(a.sourceKey) || !stamp(a.sourceAt) ||
        !stamp(a.raisedAt) ||
        a.raisedAt > a.sourceAt || evaluatedAt - a.raisedAt > 30 * 24 * 3_600_000 || a.sourceAt > evaluatedAt + 1000 ||
        !between(a.threshold, spec.thresholdMin, spec.thresholdMax) ||
        !(a.ackedAt === null ||
            (stamp(a.ackedAt) && a.ackedAt <= evaluatedAt + 1000 && evaluatedAt - a.ackedAt <= 30 * 24 * 3_600_000)) ||
        !(kind === 'wake-depth'
            ? ['below-keel', 'transducer-offset', 'conservative-full-draft'].includes(String(a.depthBasis))
            : a.depthBasis === null) ||
        (status === 'active'
            ? !between(a.value, spec.min, spec.max) || evaluatedAt - a.sourceAt > spec.maxAge
            : a.value !== null) ||
        a.sourceKey !== selected.sourceKey || a.threshold !== selected.threshold ||
        a.key !== await wakeRelayAlarmKey(context, kind, a.sourceKey, a.raisedAt)
    ) return null;
    return {
        kind,
        status,
        quiet: raw.quiet,
        alarm: {
            key: a.key,
            sourceKey: a.sourceKey,
            sourceAt: a.sourceAt,
            raisedAt: a.raisedAt,
            value: a.value as number | null,
            threshold: a.threshold,
            depthBasis: a.depthBasis as WakeRelayAlarm['depthBasis'],
            ackedAt: a.ackedAt as number | null,
        },
    };
}
export async function parseWakeRelayRequest(
    raw: Record<string, unknown>,
    identity: PiRelayIdentity,
    now: number,
): Promise<WakeRelayRequest | null> {
    if (raw.family !== 'wake' || !stamp(now)) return null;
    if (raw.action === 'probe') return exact(raw, ['family', 'action']) ? { family: 'wake', action: 'probe' } : null;
    const context = await parseContext(raw.context, identity);
    if (!context) return null;
    if (raw.action === 'retire') {
        return exact(raw, ['family', 'action', 'context', 'contextRevision']) && wakeRelayUuid(raw.contextRevision)
            ? { family: 'wake', action: 'retire', context, contextRevision: raw.contextRevision }
            : null;
    }
    if (raw.action === 'bind') {
        return exact(raw, ['family', 'action', 'context', 'expectedContextRevision']) &&
                (raw.expectedContextRevision === null || wakeRelayUuid(raw.expectedContextRevision))
            ? { family: 'wake', action: 'bind', context, expectedContextRevision: raw.expectedContextRevision }
            : null;
    }
    if (
        raw.action !== 'sync' ||
        !exact(raw, ['family', 'action', 'context', 'contextRevision', 'evaluatedAt', 'higherPriority', 'states']) ||
        !wakeRelayUuid(raw.contextRevision) || !stamp(raw.evaluatedAt) || raw.evaluatedAt > now + 1000 ||
        now - raw.evaluatedAt > 30_000 ||
        !['none', 'anchor', 'collision', 'distress'].includes(String(raw.higherPriority)) ||
        !Array.isArray(raw.states) || raw.states.length !== 8
    ) return null;
    const states: WakeRelayState[] = [];
    for (const kind of Object.keys(WAKE_KINDS) as WakeKind[]) {
        const rows = raw.states.filter((v) => record(v) && v.kind === kind);
        if (rows.length !== 1) return null;
        const state = await parseState(rows[0], context, raw.evaluatedAt);
        if (!state) return null;
        states.push(state);
    }
    return {
        family: 'wake',
        action: 'sync',
        context,
        contextRevision: raw.contextRevision,
        evaluatedAt: raw.evaluatedAt,
        higherPriority: raw.higherPriority as 'none' | 'anchor' | 'collision' | 'distress',
        states,
    };
}
