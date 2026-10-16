import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { getPairing } from '../PiPairingService';
import { satelliteModeActive } from '../networkPolicy';
export interface WakeCloudAlarmRef {
    ownerId: string;
    piDeviceId: string;
    contextRevision: string;
    rulesDigest: string;
    key: string;
}
const uuid = (s: unknown): s is string =>
    typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
export function validWakeCloudAlarmRef(v: WakeCloudAlarmRef): boolean {
    return (
        !!v &&
        uuid(v.ownerId) &&
        uuid(v.piDeviceId) &&
        uuid(v.contextRevision) &&
        /^[a-f0-9]{64}$/.test(v.rulesDigest) &&
        /^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery):[a-f0-9]{12}:[0-9]{10,13}$/.test(v.key)
    );
}
/** Explicit user action only. No retries, offline outbox, generic RPC or notification-tap acknowledgement. */
export async function acknowledgeWakeAlarm(ref: WakeCloudAlarmRef): Promise<boolean> {
    ref = { ...ref };
    if (!validWakeCloudAlarmRef(ref) || satelliteModeActive()) return false;
    const scope = getAuthIdentityScope(),
        pair = getPairing(),
        pairKey = JSON.stringify(pair);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
        !controller.signal.aborted &&
        isAuthIdentityScopeCurrent(scope) &&
        scope.userId === ref.ownerId &&
        pair?.deviceId === ref.piDeviceId &&
        JSON.stringify(getPairing()) === pairKey &&
        !satelliteModeActive();
    if (!current()) return false;
    try {
        return await Promise.race([
            (async () => {
                const { supabase } = await import('../supabase');
                if (!supabase || !current()) return false;
                const session = await supabase.auth.getSession();
                if (!current() || session.data.session?.user.id !== scope.userId) return false;
                const { data: context, error } = await supabase
                    .from('pi_wake_contexts')
                    .select('revision,profile')
                    .eq('owner_id', scope.userId)
                    .eq('revision', ref.contextRevision)
                    .eq('retired', false)
                    .limit(1)
                    .abortSignal(controller.signal);
                if (
                    !current() ||
                    error ||
                    context?.length !== 1 ||
                    context[0].revision !== ref.contextRevision ||
                    context[0].profile?.binding?.ownerId !== ref.ownerId ||
                    context[0].profile?.binding?.piDeviceId !== ref.piDeviceId ||
                    context[0].profile?.rulesDigest !== ref.rulesDigest
                )
                    return false;
                const result = await supabase
                    .rpc('acknowledge_pi_wake_alarm', { p_alarm_key: ref.key, p_rules_digest: ref.rulesDigest })
                    .abortSignal(controller.signal);
                return current() && !result.error && result.data === 1;
            })(),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve(false);
                }, 8000);
            }),
        ]);
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}
