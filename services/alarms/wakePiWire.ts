import type {
    WakeBinding,
    WakeConfiguration,
    WakeKeeperStatus,
    WakePressureStatus,
    WakeSensors,
    WakeRelayConflict,
} from '../../utils/wakePiContract';
import {
    defaultWakeRules,
    validWakeSelection,
    WAKE_PRESETS,
    type WakeReading,
    type WakeRule,
    type WakePreset,
} from '../../utils/wakeRule';
import { copyWakeRule, validWakeDraft } from './wakeRulePreferences';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const clock = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const draft = (v: unknown): v is number | null => v === null || (finite(v) && v > 0 && v <= 20);
const fail = (): never => {
    throw Error('Boat wake rules unavailable');
};
function body(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string' || raw.length > 32_768 || new TextEncoder().encode(raw).length > 32_768) return fail();
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return fail();
    }
    if (!record(value) || value.schema !== 1) return fail();
    return value;
}
export function validWakePiBinding(v: unknown): v is WakeBinding {
    return (
        record(v) &&
        Object.keys(v).length === 6 &&
        uuid(v.ownerId) &&
        uuid(v.piDeviceId) &&
        uuid(v.deviceId) &&
        hex(v.pairingId) &&
        hex(v.enrollmentRevision) &&
        typeof v.feedId === 'string' &&
        v.feedId === `pi:${v.piDeviceId}:${v.feedId.slice(-24)}` &&
        /^[a-f0-9]{24}$/.test(v.feedId.slice(-24))
    );
}
export const wakePiBindingKey = (v: WakeBinding): string =>
    JSON.stringify([v.ownerId, v.piDeviceId, v.pairingId, v.deviceId, v.enrollmentRevision, v.feedId]);
const samePair = (a: WakeBinding, b: WakeBinding) =>
    a.ownerId === b.ownerId && a.piDeviceId === b.piDeviceId && a.pairingId === b.pairingId;
function pressure(v: unknown): WakePressureStatus {
    if (
        !record(v) ||
        !['warming', 'ready', 'unavailable'].includes(v.state as string) ||
        !Number.isSafeInteger(v.sampleCount) ||
        (v.sampleCount as number) < 0 ||
        (v.sampleCount as number) > 2048 ||
        !finite(v.spanMs) ||
        v.spanMs < 0 ||
        v.spanMs > 21_600_000
    )
        return fail();
    return { state: v.state as WakePressureStatus['state'], sampleCount: v.sampleCount as number, spanMs: v.spanMs };
}
function rules(v: unknown, feedId: string): WakeRule[] {
    if (!Array.isArray(v) || v.length !== 8) return fail();
    return defaultWakeRules().map(({ preset }) => {
        const matches = v.filter((r) => record(r) && r.preset === preset);
        if (matches.length !== 1 || !validWakeDraft(matches[0] as WakeRule)) return fail();
        const rule = copyWakeRule(matches[0] as WakeRule);
        if (rule.selection && rule.selection.feedId !== feedId) return fail();
        return rule;
    });
}
export function parseWakePiConfiguration(v: unknown): WakeConfiguration {
    if (
        !record(v) ||
        v.schema !== 1 ||
        !uuid(v.revision) ||
        !validWakePiBinding(v.binding) ||
        !draft(v.draftM) ||
        !hex(v.rulesDigest) ||
        !clock(v.configuredAt)
    )
        return fail();
    return {
        schema: 1,
        revision: v.revision,
        binding: { ...v.binding },
        draftM: v.draftM,
        rulesDigest: v.rulesDigest,
        configuredAt: v.configuredAt,
        rules: rules(v.rules, v.binding.feedId),
    };
}
export function parseWakePiConfigurationResponse(raw: unknown): WakeConfiguration {
    return parseWakePiConfiguration(body(raw).configuration);
}
function reading(
    v: unknown,
    preset: WakePreset,
    selection: WakeReading['selection'],
    measuredAt: number,
): WakeReading | null {
    if (v === null) return null;
    const spec = WAKE_PRESETS[preset];
    if (
        !record(v) ||
        v.preset !== preset ||
        !validWakeSelection(preset, v.selection as WakeReading['selection']) ||
        (v.selection as WakeReading['selection']).feedId !== selection.feedId ||
        (v.selection as WakeReading['selection']).sensorId !== selection.sensorId ||
        (v.selection as WakeReading['selection']).instance !== selection.instance ||
        !finite(v.value) ||
        v.value < spec.min ||
        v.value > spec.max ||
        v.at !== measuredAt ||
        (v.depthBasis !== undefined &&
            (preset !== 'depth-below-keel' ||
                !['below-keel', 'transducer-offset', 'conservative-full-draft'].includes(v.depthBasis as string)))
    )
        return fail();
    return {
        preset,
        selection: { ...selection },
        value: v.value,
        at: measuredAt,
        ...(v.depthBasis ? { depthBasis: v.depthBasis as WakeReading['depthBasis'] } : {}),
    };
}
function envelope(raw: unknown, now: number) {
    const v = body(raw);
    if (
        v.update !== 7 ||
        !clock(v.servedAt) ||
        v.servedAt > now + 1000 ||
        now - v.servedAt > 10_000 ||
        !(v.binding === null || validWakePiBinding(v.binding))
    )
        return fail();
    return v;
}
export function parseWakePiSensors(raw: unknown, now: number): WakeSensors {
    const v = envelope(raw, now);
    if (!draft(v.draftM) || !Array.isArray(v.options) || v.options.length > 32 || typeof v.truncated !== 'boolean')
        return fail();
    const binding = v.binding as WakeBinding | null;
    const seen = new Set<string>();
    const options = v.options.map((option) => {
        if (
            !record(option) ||
            !binding ||
            typeof option.preset !== 'string' ||
            !Object.hasOwn(WAKE_PRESETS, option.preset) ||
            !validWakeSelection(option.preset as WakePreset, option.selection as WakeReading['selection']) ||
            (option.selection as WakeReading['selection']).feedId !== binding.feedId ||
            typeof option.label !== 'string' ||
            !option.label.trim() ||
            option.label.length > 80 ||
            [...option.label].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
            !clock(option.measuredAt) ||
            option.measuredAt > now + 1000
        )
            return fail();
        const preset = option.preset as WakePreset,
            selection = { ...(option.selection as WakeReading['selection']) };
        const key = JSON.stringify([
            preset,
            selection.feedId,
            selection.sensorId,
            selection.reference,
            selection.instance,
        ]);
        if (seen.has(key)) return fail();
        seen.add(key);
        return {
            preset,
            selection,
            label: option.label,
            measuredAt: option.measuredAt,
            reading: reading(option.reading, preset, selection, option.measuredAt),
        };
    });
    return {
        schema: 1,
        update: 7,
        binding,
        draftM: v.draftM,
        servedAt: v.servedAt as number,
        options,
        truncated: v.truncated,
        pressure: pressure(v.pressure),
    };
}
export function parseWakePiStatus(raw: unknown, now: number): WakeKeeperStatus {
    const v = envelope(raw, now);
    if (
        !uuid(v.instance) ||
        typeof v.configured !== 'boolean' ||
        typeof v.running !== 'boolean' ||
        !['off', 'awaiting-sensors', 'watching', 'binding-changed', 'storage-unavailable', 'stopped'].includes(
            v.reason as string,
        ) ||
        !Array.isArray(v.rules) ||
        v.rules.length > 8 ||
        !record(v.push) ||
        !['unavailable', 'ready', 'internet-off', 'not-paired', 'conflict'].includes(v.push.state as string) ||
        ![0, 1].includes(v.push.capability as number) ||
        (v.push.capability === 1 && (!clock(v.push.checkedAt) || !uuid(v.push.contextRevision))) ||
        (v.push.state === 'ready' && v.push.capability !== 1)
    )
        return fail();
    let conflict: WakeRelayConflict | undefined;
    if (v.push.conflict !== undefined) {
        const c = v.push.conflict;
        if (
            v.push.state !== 'conflict' ||
            v.push.capability !== 0 ||
            !record(c) ||
            Object.keys(c).length !== 6 ||
            !uuid(c.revision) ||
            !uuid(c.configurationRevision) ||
            !hex(c.rulesDigest) ||
            typeof c.feedMatches !== 'boolean' ||
            typeof c.retired !== 'boolean' ||
            !Array.isArray(c.rules) ||
            c.rules.length !== 8
        )
            return fail();
        const seen = new Set<string>();
        const rules = c.rules.map((r) => {
            if (
                !record(r) ||
                Object.keys(r).length !== 5 ||
                typeof r.preset !== 'string' ||
                !Object.hasOwn(WAKE_PRESETS, r.preset) ||
                seen.has(r.preset) ||
                typeof r.enabled !== 'boolean' ||
                typeof r.sourceMatches !== 'boolean' ||
                !(r.threshold === null || finite(r.threshold)) ||
                (r.enabled && r.threshold === null)
            )
                return fail();
            const base = defaultWakeRules().find((rule) => rule.preset === r.preset)!;
            if (
                !validWakeDraft({
                    ...base,
                    threshold: r.threshold ?? base.threshold,
                    quietHours: r.quietHours as typeof base.quietHours,
                }) ||
                (r.quietHours !== null && (!record(r.quietHours) || Object.keys(r.quietHours).length !== 3))
            )
                return fail();
            seen.add(r.preset);
            return {
                preset: r.preset as WakePreset,
                enabled: r.enabled,
                threshold: r.threshold as number | null,
                sourceMatches: r.sourceMatches,
                quietHours: r.quietHours as typeof base.quietHours,
            };
        });
        conflict = {
            revision: c.revision,
            configurationRevision: c.configurationRevision,
            rulesDigest: c.rulesDigest,
            feedMatches: c.feedMatches,
            retired: c.retired,
            rules,
        };
    }
    const binding = v.binding as WakeBinding | null;
    const configuration = v.configuration === null ? null : parseWakePiConfiguration(v.configuration);
    if (
        v.configured !== !!configuration ||
        (configuration &&
            (!binding ||
                !samePair(binding, configuration.binding) ||
                (binding.feedId !== configuration.binding.feedId &&
                    (v.reason !== 'binding-changed' || v.proof !== null))))
    )
        return fail();
    const seen = new Set<string>();
    const rows = v.rules.map((row) => {
        if (
            !record(row) ||
            typeof row.preset !== 'string' ||
            !Object.hasOwn(WAKE_PRESETS, row.preset) ||
            seen.has(row.preset) ||
            !['disabled', 'unconfigured', 'unknown', 'watching', 'pending', 'active'].includes(row.status as string) ||
            !['active', 'audible', 'quiet'].every((k) => typeof row[k] === 'boolean') ||
            !(row.lastAt === null || clock(row.lastAt)) ||
            !(row.value === null || finite(row.value))
        )
            return fail();
        seen.add(row.preset);
        let episode: WakeKeeperStatus['rules'][number]['episode'];
        if (row.episode !== undefined) {
            const a = row.episode;
            if (
                !record(a) ||
                Object.keys(a).length !== 4 ||
                typeof a.key !== 'string' ||
                !/^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery):[0-9a-f]{12}:[0-9]{10,13}$/.test(a.key) ||
                !clock(a.raisedAt) ||
                !clock(a.sourceAt) ||
                a.sourceAt < a.raisedAt ||
                a.sourceAt > now + 1000 ||
                a.key.split(':')[2] !== String(a.raisedAt) ||
                !(a.ackedAt === null || (clock(a.ackedAt) && a.ackedAt >= a.raisedAt && a.ackedAt <= now + 1000))
            )
                return fail();
            episode = { key: a.key, raisedAt: a.raisedAt, sourceAt: a.sourceAt, ackedAt: a.ackedAt as number | null };
        }
        return {
            preset: row.preset as WakePreset,
            status: row.status as WakeKeeperStatus['rules'][number]['status'],
            active: row.active as boolean,
            audible: row.audible as boolean,
            quiet: row.quiet as boolean,
            lastAt: row.lastAt as number | null,
            value: row.value as number | null,
            ...(episode ? { episode } : {}),
            ...(['below-keel', 'transducer-offset', 'conservative-full-draft'].includes(row.depthBasis as string)
                ? { depthBasis: row.depthBasis as WakeReading['depthBasis'] }
                : {}),
        };
    });
    let proof: WakeKeeperStatus['proof'] = null;
    if (v.proof !== null) {
        const p = v.proof;
        if (
            v.running !== true ||
            v.reason !== 'watching' ||
            !record(p) ||
            !binding ||
            !configuration ||
            !validWakePiBinding(p.binding) ||
            wakePiBindingKey(p.binding) !== wakePiBindingKey(configuration.binding) ||
            binding.feedId !== configuration.binding.feedId ||
            p.revision !== configuration.revision ||
            p.instance !== v.instance ||
            p.update !== 7 ||
            p.ownerId !== binding.ownerId ||
            p.feedId !== binding.feedId ||
            p.rulesDigest !== configuration.rulesDigest ||
            p.running !== true ||
            !clock(p.evaluatedAt) ||
            p.evaluatedAt > now + 1000
        )
            return fail();
        proof = {
            update: 7,
            ownerId: binding.ownerId,
            feedId: binding.feedId,
            rulesDigest: configuration.rulesDigest,
            running: true,
            evaluatedAt: p.evaluatedAt,
            binding: { ...configuration.binding },
            revision: configuration.revision,
            instance: v.instance,
        };
    }
    return {
        schema: 1,
        update: 7,
        instance: v.instance,
        binding,
        configured: v.configured,
        configuration,
        running: v.running,
        reason: v.reason as WakeKeeperStatus['reason'],
        proof,
        rules: rows,
        pressure: pressure(v.pressure),
        push:
            v.push.capability === 1 &&
            clock(v.push.checkedAt) &&
            now >= v.push.checkedAt &&
            now - v.push.checkedAt <= 30_000
                ? {
                      state: v.push.state as WakeKeeperStatus['push']['state'],
                      capability: 1,
                      checkedAt: v.push.checkedAt,
                      contextRevision: v.push.contextRevision as string,
                  }
                : {
                      state: v.push.state === 'conflict' ? 'conflict' : 'unavailable',
                      capability: 0,
                      ...(conflict &&
                      clock(v.push.checkedAt) &&
                      now >= v.push.checkedAt &&
                      now - v.push.checkedAt <= 30_000
                          ? { conflict, checkedAt: v.push.checkedAt }
                          : {}),
                  },
        servedAt: v.servedAt as number,
    };
}
