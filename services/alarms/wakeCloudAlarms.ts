import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { getPairing } from '../PiPairingService';
import { satelliteModeActive } from '../networkPolicy';
import { WakeAlarmStore, type WakeAlarmCard } from './wakeAlarmStore';
import { WAKE_PRESETS, type WakePreset } from '../../utils/wakeRule';
import { validWakePiBinding } from './wakePiWire';
const kinds: Record<string, WakePreset> = {
    'wake-depth': 'depth-below-keel',
    'wake-wind': 'wind-above',
    'wake-speed': 'speed-below',
    'wake-pressure': 'pressure-fall',
    'wake-coolant': 'engine-coolant-above',
    'wake-oil': 'engine-oil-below',
    'wake-rpm': 'engine-rpm-above',
    'wake-battery': 'battery-below',
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
interface Context {
    revision: string;
    profile: Record<string, unknown>;
}
function contexts(raw: unknown, owner: string, pi: string): Context[] {
    if (!Array.isArray(raw) || raw.length > 8 || JSON.stringify(raw).length > 48_000)
        throw Error('Wake context unavailable');
    return raw.map((r) => {
        if (
            !record(r) ||
            !uuid(r.revision) ||
            !record(r.profile) ||
            !validWakePiBinding(r.profile.binding) ||
            r.profile.binding.ownerId !== owner ||
            r.profile.binding.piDeviceId !== pi ||
            !hash(r.profile.rulesDigest) ||
            !uuid(r.profile.configurationRevision) ||
            !uuid(r.profile.instance) ||
            !Array.isArray(r.profile.rules) ||
            r.profile.rules.length !== 8
        )
            throw Error('Wake context unavailable');
        return { revision: r.revision, profile: r.profile };
    });
}
/** Exported pure decoder: current context, digest, source and preset must all agree. */
export function wakeCloudCards(
    raw: unknown,
    profileRows: unknown,
    owner: string,
    pi: string,
    now: number,
): WakeAlarmCard[] {
    const current = contexts(profileRows, owner, pi);
    if (!Array.isArray(raw) || raw.length > 16 || JSON.stringify(raw).length > 32_000)
        throw Error('Wake alarms unavailable');
    return raw.map((row) => {
        if (
            !record(row) ||
            row.owner_id !== owner ||
            typeof row.kind !== 'string' ||
            !Object.hasOwn(kinds, row.kind) ||
            !uuid(row.context_revision) ||
            !hash(row.rules_digest) ||
            !hash(row.source_key) ||
            typeof row.alarm_key !== 'string' ||
            !new RegExp(`^${row.kind}:[a-f0-9]{12}:[0-9]{10,13}$`).test(row.alarm_key) ||
            !Number.isSafeInteger(row.raised_at_ms) ||
            !Number.isSafeInteger(row.source_at_ms) ||
            Number(row.source_at_ms) < Number(row.raised_at_ms) ||
            row.alarm_key.split(':')[2] !== String(row.raised_at_ms) ||
            Number(row.source_at_ms) > now + 1000 ||
            typeof row.quiet !== 'boolean' ||
            typeof row.source_qualified !== 'boolean'
        )
            throw Error('Wake alarms unavailable');
        const c = current.find((c) => c.revision === row.context_revision),
            preset = kinds[row.kind],
            spec = WAKE_PRESETS[preset];
        if (
            preset === 'depth-below-keel'
                ? !['below-keel', 'transducer-offset', 'conservative-full-draft'].includes(String(row.depth_basis))
                : row.depth_basis !== null
        )
            throw Error('Wake depth reference unavailable');
        const selected = c && (c.profile.rules as unknown[]).filter((r) => record(r) && r.kind === row.kind);
        if (
            !c ||
            c.profile.rulesDigest !== row.rules_digest ||
            selected?.length !== 1 ||
            !record(selected[0]) ||
            selected[0].enabled !== true ||
            selected[0].sourceKey !== row.source_key ||
            selected[0].threshold !== row.threshold ||
            typeof row.threshold !== 'number' ||
            !Number.isFinite(row.threshold) ||
            row.threshold < spec.thresholdMin ||
            row.threshold > spec.thresholdMax ||
            typeof row.measured_value !== 'number' ||
            !Number.isFinite(row.measured_value) ||
            row.measured_value < spec.min ||
            row.measured_value > spec.max
        )
            throw Error('Wake alarms unavailable');
        const fresh = row.source_qualified && now - Number(row.source_at_ms) <= spec.maxAge;
        return {
            preset,
            status: fresh ? 'active' : 'unknown',
            value: fresh ? row.measured_value : null,
            quiet: row.quiet,
            muted: false,
            sourceAt: Number(row.source_at_ms),
            ...(preset === 'depth-below-keel' ? { depthBasis: row.depth_basis as WakeAlarmCard['depthBasis'] } : {}),
            cloud: {
                ownerId: owner,
                piDeviceId: pi,
                contextRevision: c.revision,
                rulesDigest: row.rules_digest,
                key: row.alarm_key,
            },
        };
    });
}
let flight: Promise<void> | null = null,
    revision = 0,
    poll: ReturnType<typeof setTimeout> | null = null;
subscribeAuthIdentityScope(() => {
    revision++;
    WakeAlarmStore.publishCloud([]);
    if (poll) clearTimeout(poll);
    poll = null;
});
/** Lazy foreground read only. Push data is never trusted as measured state. */
export function refreshWakeCloudAlarms(): Promise<void> {
    if (flight || satelliteModeActive() || document.visibilityState === 'hidden') return flight ?? Promise.resolve();
    const scope = getAuthIdentityScope(),
        pair = getPairing(),
        generation = revision,
        pairKey = JSON.stringify(pair);
    if (!scope.userId || !pair) return Promise.resolve();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let appListener: { remove(): Promise<void> } | null = null,
        foreground = true;
    const current = () =>
        foreground &&
        !controller.signal.aborted &&
        generation === revision &&
        isAuthIdentityScopeCurrent(scope) &&
        JSON.stringify(getPairing()) === pairKey &&
        !satelliteModeActive() &&
        document.visibilityState !== 'hidden';
    const hidden = () => {
        if (document.visibilityState === 'hidden') controller.abort();
    };
    document.addEventListener('visibilitychange', hidden);
    flight = Promise.race([
        (async () => {
            try {
                const { App } = await import('@capacitor/app');
                const state = await App.getState();
                if (!state.isActive || !current()) return;
                appListener = await App.addListener('appStateChange', (s) => {
                    if (!s.isActive) {
                        foreground = false;
                        controller.abort();
                    }
                });
                if (!current()) return;
                const { supabase } = await import('../supabase');
                if (!supabase || !current()) return;
                const session = await supabase.auth.getSession();
                if (!current() || session.data.session?.user.id !== scope.userId) return;
                const read = () =>
                    supabase
                        .from('pi_wake_contexts')
                        .select('revision,profile')
                        .eq('owner_id', scope.userId!)
                        .eq('profile->binding->>piDeviceId', pair.deviceId)
                        .eq('retired', false)
                        .limit(8)
                        .abortSignal(controller.signal);
                const before = await read();
                if (before.error || !current()) return;
                const rows = contexts(before.data, scope.userId!, pair.deviceId);
                if (!rows.length) {
                    WakeAlarmStore.publishCloud([]);
                    return;
                }
                const events = await supabase
                    .from('pi_wake_events')
                    .select(
                        'owner_id,context_revision,rules_digest,kind,alarm_key,source_key,raised_at_ms,source_at_ms,measured_value,threshold,depth_basis,quiet,source_qualified',
                    )
                    .eq('owner_id', scope.userId!)
                    .in(
                        'context_revision',
                        rows.map((r) => r.revision),
                    )
                    .is('resolved_at', null)
                    .is('acked_at', null)
                    .order('raised_at_ms', { ascending: false })
                    .limit(16)
                    .abortSignal(controller.signal);
                if (events.error || !current()) return;
                const after = await read();
                if (after.error || !current()) return;
                if (JSON.stringify(before.data) !== JSON.stringify(after.data)) {
                    WakeAlarmStore.publishCloud([]);
                    return;
                }
                WakeAlarmStore.publishCloud(
                    wakeCloudCards(events.data, after.data, scope.userId!, pair.deviceId, Date.now()),
                    () => isAuthIdentityScopeCurrent(scope) && JSON.stringify(getPairing()) === pairKey,
                );
            } catch {
                /* Keep a retained alarm on failed reads; its displayed value expires separately. */
            }
        })(),
        new Promise<void>((resolve) => {
            timer = setTimeout(() => {
                controller.abort();
                resolve();
            }, 8000);
        }),
    ]).finally(() => {
        clearTimeout(timer);
        void appListener?.remove();
        document.removeEventListener('visibilitychange', hidden);
        flight = null;
        if (poll) clearTimeout(poll);
        poll = null;
        if (current() && WakeAlarmStore.get().some((c) => c.cloud))
            poll = setTimeout(() => {
                poll = null;
                void refreshWakeCloudAlarms();
            }, 15_000);
    });
    return flight;
}
