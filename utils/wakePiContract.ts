/** Pure phone/Pi wire contract. No server implementation or runtime dependencies. */
import type {
    WakeRule,
    WakeSelection,
    WakePreset,
    WakeReading,
    WakeEvaluation,
    WakeKeeperProof,
    WakeQuietHours,
} from './wakeRule';

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
    episode?: { key: string; raisedAt: number; sourceAt: number; ackedAt: number | null };
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
    push: {
        state: 'unavailable' | 'ready' | 'internet-off' | 'not-paired' | 'conflict';
        capability: 0 | 1;
        checkedAt?: number | null;
        contextRevision?: string | null;
        conflict?: WakeRelayConflict;
    };
    servedAt: number;
}
export interface WakeRelayConflict {
    revision: string;
    configurationRevision: string;
    rulesDigest: string;
    feedMatches: boolean;
    retired: boolean;
    rules: {
        preset: WakePreset;
        enabled: boolean;
        threshold: number | null;
        sourceMatches: boolean;
        quietHours: WakeQuietHours | null;
    }[];
}
export interface WakeRelayReviewRequest {
    schema: 1;
    expectedRevision: string;
    rulesDigest: string;
    binding: WakeBinding;
    expectedContextRevision: string;
}
export interface WakeClearRequest {
    schema: 1;
    expectedRevision: string | null;
    binding: WakeBinding;
    rulesDigest: string;
}
