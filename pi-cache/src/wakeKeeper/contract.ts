import { createHash } from 'node:crypto';
import {
    defaultWakeRules,
    validWakeRule,
    validWakeSelection,
    wakeRulesCanonical,
    WAKE_PRESETS,
    type WakeRule,
    type WakeSelection,
    type WakePreset,
    type WakeReading,
    type WakeEvaluation,
    type WakeKeeperProof,
} from '../wakeRule/wakeRule.js';
import { validSignalKSelf } from '../signalkProtocol.js';

export const WAKE_CONFIG_BYTES = 16_384;
export const WAKE_SENSOR_CAP = 32;
export interface WakePairIdentity {
    ownerId: string;
    piDeviceId: string;
    pairingId: string;
}
export interface WakeBinding extends WakePairIdentity {
    deviceId: string;
    enrollmentRevision: string;
    feedId: string;
}
export interface WakeConfiguration {
    schema: 1;
    revision: string;
    binding: WakeBinding;
    draftM: number | null;
    rulesDigest: string;
    rules: WakeRule[];
    configuredAt: number;
}
export interface WakeConfigurationRequest {
    schema: 1;
    expectedRevision: string | null;
    binding: WakeBinding;
    draftM: number | null;
    rulesDigest: string;
    rules: WakeRule[];
}
export interface WakeSensorOption {
    preset: WakePreset;
    selection: WakeSelection;
    label: string;
    measuredAt: number;
    reading: WakeReading | null;
}
export interface WakePressureStatus {
    state: 'warming' | 'ready' | 'unavailable';
    sampleCount: number;
    spanMs: number;
}
export interface WakeSensors {
    schema: 1;
    update: 7;
    binding: WakeBinding | null;
    draftM: number | null;
    servedAt: number;
    options: WakeSensorOption[];
    truncated: boolean;
    pressure: WakePressureStatus;
}
export interface WakeRuleStatus {
    preset: WakePreset;
    status: WakeEvaluation['status'];
    active: boolean;
    audible: boolean;
    quiet: boolean;
    lastAt: number | null;
    value: number | null;
    depthBasis?: WakeReading['depthBasis'];
}
export interface WakeKeeperStatus {
    schema: 1;
    update: 7;
    instance: string;
    binding: WakeBinding | null;
    configured: boolean;
    configuration: WakeConfiguration | null;
    running: boolean;
    reason: 'off' | 'awaiting-sensors' | 'watching' | 'binding-changed' | 'storage-unavailable' | 'stopped';
    proof: (WakeKeeperProof & { binding: WakeBinding; revision: string; instance: string }) | null;
    rules: WakeRuleStatus[];
    pressure: WakePressureStatus;
    push: { state: 'unavailable'; capability: 0 };
    servedAt: number;
}
export interface WakeClearRequest {
    schema: 1;
    expectedRevision: string | null;
    binding: WakeBinding;
    rulesDigest: string;
}
export class WakeKeeperError extends Error {
    constructor(public readonly code: 'invalid' | 'conflict' | 'binding' | 'unavailable' | 'busy') {
        super(`Wake rule ${code}`);
        this.name = 'WakeKeeperError';
    }
}
export const wakeRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
export const wakeUuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export const wakeHash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (row: Record<string, unknown>, keys: string[]) =>
    Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
export function validWakePair(value: unknown): value is WakePairIdentity {
    return wakeRecord(value) && wakeUuid(value.ownerId) && wakeUuid(value.piDeviceId) && hex(value.pairingId);
}
export function wakePairKey(value: WakePairIdentity | null): string | null {
    return value ? JSON.stringify([value.ownerId, value.piDeviceId, value.pairingId]) : null;
}
/** Opaque pairing/feed identities contain no credential, URL, raw vessel UUID or serial. */
export function wakePairingId(ownerId: string, piDeviceId: string, relayId: string): string {
    if (!wakeUuid(ownerId) || !wakeUuid(piDeviceId) || !/^[A-Za-z0-9_-]{16,128}$/.test(relayId))
        throw new WakeKeeperError('binding');
    return wakeHash(JSON.stringify([ownerId, piDeviceId, relayId]));
}
export function wakeFeedId(piDeviceId: string, selfUuid: unknown): string | null {
    return wakeUuid(piDeviceId) && validSignalKSelf(selfUuid)
        ? `pi:${piDeviceId}:${wakeHash(selfUuid).slice(0, 24)}`
        : null;
}
export function wakeEnrollmentRevision(device: { id: string; enrolledAt: string }): string {
    if (
        !wakeUuid(device.id) ||
        typeof device.enrolledAt !== 'string' ||
        !Number.isFinite(Date.parse(device.enrolledAt))
    )
        throw new WakeKeeperError('binding');
    return wakeHash(JSON.stringify([device.id, device.enrolledAt]));
}
export function validWakeBinding(value: unknown): value is WakeBinding {
    return (
        validWakePair(value) &&
        wakeRecord(value) &&
        exact(value, ['ownerId', 'piDeviceId', 'pairingId', 'deviceId', 'enrollmentRevision', 'feedId']) &&
        wakeUuid(value.deviceId) &&
        hex(value.enrollmentRevision) &&
        typeof value.feedId === 'string' &&
        new RegExp(`^pi:${value.piDeviceId}:[a-f0-9]{24}$`).test(value.feedId)
    );
}
export function wakeBindingKey(value: WakeBinding): string {
    return JSON.stringify([
        value.ownerId,
        value.piDeviceId,
        value.pairingId,
        value.deviceId,
        value.enrollmentRevision,
        value.feedId,
    ]);
}
export function sameWakeSelection(a: WakeSelection, b: WakeSelection): boolean {
    return (
        a.feedId === b.feedId && a.sensorId === b.sensorId && a.reference === b.reference && a.instance === b.instance
    );
}
function selection(raw: unknown, preset: WakePreset, feedId: string): WakeSelection | null {
    if (raw === null) return null;
    if (
        !wakeRecord(raw) ||
        !Object.keys(raw).every((key) => ['feedId', 'sensorId', 'reference', 'instance'].includes(key)) ||
        !validWakeSelection(preset, raw as unknown as WakeSelection) ||
        raw.feedId !== feedId
    )
        throw new WakeKeeperError('invalid');
    return {
        feedId: raw.feedId as string,
        sensorId: raw.sensorId as string,
        reference: raw.reference as string,
        ...(raw.instance !== undefined ? { instance: raw.instance as string } : {}),
    };
}
export function parseWakeRules(raw: unknown, feedId: string): WakeRule[] {
    const defaults = defaultWakeRules();
    if (!Array.isArray(raw) || raw.length !== defaults.length) throw new WakeKeeperError('invalid');
    return defaults.map((base) => {
        const matches = raw.filter((v) => wakeRecord(v) && v.preset === base.preset);
        if (matches.length !== 1) throw new WakeKeeperError('invalid');
        const value = matches[0] as Record<string, unknown>;
        if (
            !exact(value, [
                'preset',
                'enabled',
                'selection',
                'threshold',
                'hysteresis',
                'minimumDurationMs',
                'clearDurationMs',
                'quietHours',
            ]) ||
            typeof value.enabled !== 'boolean'
        )
            throw new WakeKeeperError('invalid');
        const selected = selection(value.selection, base.preset, feedId),
            spec = WAKE_PRESETS[base.preset];
        const quiet = value.quietHours;
        if (quiet !== null && (!wakeRecord(quiet) || !exact(quiet, ['startMinute', 'endMinute', 'utcOffsetMinutes'])))
            throw new WakeKeeperError('invalid');
        const rule: WakeRule = {
            preset: base.preset,
            enabled: value.enabled,
            selection: selected,
            threshold: value.threshold as number | null,
            hysteresis: value.hysteresis as number,
            minimumDurationMs: value.minimumDurationMs as number,
            clearDurationMs: value.clearDurationMs as number,
            quietHours: quiet as WakeRule['quietHours'],
        };
        // Disabled/unselected presets remain genuinely unselected. A temporary
        // validation-only selection checks the common bounds; it is never stored.
        const validation = {
            ...rule,
            selection: selected ?? {
                feedId,
                sensorId: 'unselected',
                reference: spec.reference,
                ...(base.preset.startsWith('engine-') || base.preset === 'battery-below'
                    ? { instance: 'unselected' }
                    : {}),
            },
            threshold: rule.threshold ?? spec.thresholdMin,
        };
        if (
            !validWakeRule(validation) ||
            (rule.threshold !== null &&
                (typeof rule.threshold !== 'number' ||
                    !Number.isFinite(rule.threshold) ||
                    rule.threshold < spec.thresholdMin ||
                    rule.threshold > spec.thresholdMax)) ||
            (rule.enabled && !validWakeRule(rule))
        )
            throw new WakeKeeperError('invalid');
        return structuredClone(rule);
    });
}
export function parseWakeConfigurationRequest(raw: unknown): WakeConfigurationRequest {
    if (
        !wakeRecord(raw) ||
        !exact(raw, ['schema', 'expectedRevision', 'binding', 'draftM', 'rulesDigest', 'rules']) ||
        raw.schema !== 1 ||
        !(raw.expectedRevision === null || wakeUuid(raw.expectedRevision)) ||
        !validWakeBinding(raw.binding) ||
        !hex(raw.rulesDigest)
    )
        throw new WakeKeeperError('invalid');
    const draftM = raw.draftM;
    if (!(draftM === null || (typeof draftM === 'number' && Number.isFinite(draftM) && draftM > 0 && draftM <= 20)))
        throw new WakeKeeperError('invalid');
    const rules = parseWakeRules(raw.rules, raw.binding.feedId);
    if (wakeHash(wakeRulesCanonical(rules, draftM)) !== raw.rulesDigest) throw new WakeKeeperError('invalid');
    return {
        schema: 1,
        expectedRevision: raw.expectedRevision,
        binding: { ...raw.binding },
        draftM,
        rulesDigest: raw.rulesDigest,
        rules,
    };
}
export function parseWakeClearRequest(raw: unknown): WakeClearRequest {
    if (
        !wakeRecord(raw) ||
        !exact(raw, ['schema', 'expectedRevision', 'binding', 'rulesDigest']) ||
        raw.schema !== 1 ||
        !(raw.expectedRevision === null || wakeUuid(raw.expectedRevision)) ||
        !validWakeBinding(raw.binding) ||
        !hex(raw.rulesDigest)
    )
        throw new WakeKeeperError('invalid');
    return {
        schema: 1,
        expectedRevision: raw.expectedRevision,
        binding: { ...raw.binding },
        rulesDigest: raw.rulesDigest,
    };
}
export function parseStoredWakeConfiguration(raw: unknown): WakeConfiguration {
    if (
        !wakeRecord(raw) ||
        !exact(raw, ['schema', 'revision', 'binding', 'draftM', 'rulesDigest', 'rules', 'configuredAt']) ||
        !wakeUuid(raw.revision) ||
        typeof raw.configuredAt !== 'number' ||
        !Number.isSafeInteger(raw.configuredAt) ||
        raw.configuredAt <= 0
    )
        throw new WakeKeeperError('invalid');
    const request = parseWakeConfigurationRequest({
        schema: raw.schema,
        expectedRevision: null,
        binding: raw.binding,
        draftM: raw.draftM,
        rulesDigest: raw.rulesDigest,
        rules: raw.rules,
    });
    const { expectedRevision: _, ...configuration } = request;
    return { ...configuration, revision: raw.revision, configuredAt: raw.configuredAt };
}
