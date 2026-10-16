import {
    wakeHash,
    wakeBindingKey,
    validWakeBinding,
    wakeRecord,
    wakeUuid,
    type WakeBinding,
    type WakeConfiguration,
    type WakeRuleStatus,
} from './contract.js';
import { WAKE_PRESETS, type WakePreset, type WakeQuietHours } from '../wakeRule/wakeRule.js';

/** Fixed wire vocabulary, behavior-checked against the actual Edge parser. */
export const WAKE_RELAY_KINDS = {
    'wake-depth': 'depth-below-keel',
    'wake-wind': 'wind-above',
    'wake-speed': 'speed-below',
    'wake-pressure': 'pressure-fall',
    'wake-coolant': 'engine-coolant-above',
    'wake-oil': 'engine-oil-below',
    'wake-rpm': 'engine-rpm-above',
    'wake-battery': 'battery-below',
} as const satisfies Record<string, WakePreset>;
export type WakeRelayKind = keyof typeof WAKE_RELAY_KINDS;
export interface WakeCloudContext {
    binding: WakeBinding;
    rulesDigest: string;
    configurationRevision: string;
    instance: string;
    rules: {
        kind: WakeRelayKind;
        enabled: boolean;
        sourceKey: string | null;
        threshold: number | null;
        quietHours: WakeQuietHours | null;
    }[];
}
export interface WakeCloudAlarm {
    key: string;
    sourceKey: string;
    sourceAt: number;
    raisedAt: number;
    value: number | null;
    threshold: number;
    depthBasis: 'below-keel' | 'transducer-offset' | 'conservative-full-draft' | null;
    ackedAt: number | null;
}
export interface WakeCloudState {
    kind: WakeRelayKind;
    status: WakeRuleStatus['status'];
    quiet: boolean;
    alarm: WakeCloudAlarm | null;
}
export interface WakeRelayPass {
    context: WakeCloudContext;
    evaluatedAt: number;
    states: WakeCloudState[];
}
export interface WakePushStatus {
    state: 'unavailable' | 'ready' | 'internet-off' | 'not-paired' | 'conflict';
    capability: 0 | 1;
    checkedAt: number | null;
    contextRevision: string | null;
    conflict?: import('./contract.js').WakeRelayConflict;
}
export function wakeCloudContext(config: WakeConfiguration, instance: string): WakeCloudContext {
    return {
        binding: { ...config.binding },
        rulesDigest: config.rulesDigest,
        configurationRevision: config.revision,
        instance,
        rules: (Object.entries(WAKE_RELAY_KINDS) as [WakeRelayKind, WakePreset][]).map(([kind, preset]) => {
            const rule = config.rules.find((r) => r.preset === preset)!;
            return {
                kind,
                enabled: rule.enabled,
                sourceKey: rule.selection
                    ? wakeHash(
                          JSON.stringify([
                              preset,
                              rule.selection.feedId,
                              rule.selection.sensorId,
                              rule.selection.reference,
                              rule.selection.instance ?? null,
                          ]),
                      )
                    : null,
                threshold: rule.selection ? rule.threshold : null,
                quietHours: rule.quietHours ? { ...rule.quietHours } : null,
            };
        }),
    };
}
export function wakeCloudEpisodeKey(c: WakeCloudContext, kind: WakeRelayKind, source: string, raised: number): string {
    const b = c.binding;
    return `${kind}:${wakeHash(
        JSON.stringify([
            1,
            [b.ownerId, b.piDeviceId, b.pairingId, b.deviceId, b.enrollmentRevision, b.feedId],
            c.rulesDigest,
            c.configurationRevision,
            c.instance,
            kind,
            source,
            raised,
        ]),
    ).slice(0, 12)}:${raised}`;
}
export const wakeCloudContextKey = (c: WakeCloudContext) =>
    JSON.stringify([
        wakeBindingKey(c.binding),
        c.rulesDigest,
        c.configurationRevision,
        c.instance,
        Object.keys(WAKE_RELAY_KINDS).map((kind) => {
            const r = c.rules.find((rule) => rule.kind === kind)!;
            return [
                kind,
                r.enabled,
                r.sourceKey,
                r.threshold,
                r.quietHours ? [r.quietHours.startMinute, r.quietHours.endMinute, r.quietHours.utcOffsetMinutes] : null,
            ];
        }),
    ]);
export function parseWakeCloudContext(raw: unknown): WakeCloudContext | null {
    if (
        !wakeRecord(raw) ||
        Object.keys(raw).length !== 5 ||
        !validWakeBinding(raw.binding) ||
        typeof raw.rulesDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.rulesDigest) ||
        !wakeUuid(raw.configurationRevision) ||
        !wakeUuid(raw.instance) ||
        !Array.isArray(raw.rules) ||
        raw.rules.length !== 8
    )
        return null;
    for (const kind of Object.keys(WAKE_RELAY_KINDS)) {
        const rows = raw.rules.filter((r) => wakeRecord(r) && r.kind === kind);
        if (rows.length !== 1) return null;
        const r = rows[0];
        const spec = WAKE_PRESETS[WAKE_RELAY_KINDS[kind as WakeRelayKind]];
        if (
            Object.keys(r).length !== 5 ||
            typeof r.enabled !== 'boolean' ||
            !(r.sourceKey === null || (typeof r.sourceKey === 'string' && /^[a-f0-9]{64}$/.test(r.sourceKey))) ||
            !(
                r.threshold === null ||
                (typeof r.threshold === 'number' &&
                    Number.isFinite(r.threshold) &&
                    r.threshold >= spec.thresholdMin &&
                    r.threshold <= spec.thresholdMax)
            ) ||
            (r.enabled && (r.sourceKey === null || r.threshold === null))
        )
            return null;
        const q = r.quietHours;
        if (
            !(
                q === null ||
                (wakeRecord(q) &&
                    Object.keys(q).length === 3 &&
                    Number.isInteger(q.startMinute) &&
                    Number.isInteger(q.endMinute) &&
                    Number.isInteger(q.utcOffsetMinutes) &&
                    Number(q.startMinute) >= 0 &&
                    Number(q.startMinute) <= 1439 &&
                    Number(q.endMinute) >= 0 &&
                    Number(q.endMinute) <= 1439 &&
                    q.startMinute !== q.endMinute &&
                    Number(q.utcOffsetMinutes) >= -840 &&
                    Number(q.utcOffsetMinutes) <= 840)
            )
        )
            return null;
    }
    return structuredClone(raw) as unknown as WakeCloudContext;
}
